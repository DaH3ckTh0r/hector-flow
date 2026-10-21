# 5. El flujo, paso a paso

Este documento describe exactamente qué hace `hector-flow run`, en orden. Todo lo que aquí se describe como decisión lo toma el **código** (`src/workflow.ts`); los agentes solo producen el JSON de cada paso, siguiendo las instrucciones de la **skill** de su rol ([13-skills.md](13-skills.md)).

```
 0. Preparación         componentes, repos limpios, worktrees de integración
 1. enrich              investigación de todos los componentes              (agente, solo lectura)
 2. plan                tareas con componente y dependencias                (agente, solo lectura)
 3. write-tests:<comp>  tests bloqueados + mapa de aceptación, por componente (agente, solo tests)
 4. Bloqueo de tests    validación del mapa, commit por repo, "red check"   (código)
 5. Implementación      grafo de tareas en paralelo                          (agentes + código)
      por tarea: worktree → implement → gate → integración (→ resolve si hay conflicto)
 6. stabilize:<comp>    build + test + lint de cada componente ⟲            (código + agentes)
 7. review              revisión de todos los repos ⟲                       (agente, solo lectura)
 8. qa:<comp>           ejecución del mapa de aceptación ⟲                  (código + agentes)
 9. final-check:<comp>  build + test + lint otra vez ⟲                      (código + agentes)
10. qa-plan             plan de pruebas manuales                            (agente, solo lectura)
11. Cierre              limpieza, summary.json, notificación                (código)
```

`⟲` es el bucle de reparación, descrito en [Reparación](#el-bucle-de-reparación).

---

## 0. Preparación

1. Carga las **skills** de los pasos (las del repo o de `skillDirs` sobrescriben a las de serie) y registra en el log los pasos personalizados y cualquier aviso de front-matter.
1. Resuelve la raíz git de `--repo`: es el **repo principal**.
2. Resuelve los componentes de la config: para cada uno, la raíz git de `repo` (relativa al repo principal) y su `path`. Los `lockedPaths` de cada componente se convierten en rutas relativas a la raíz de su repo.
3. Comprueba que **todos** los repos de los componentes están limpios (`git status --porcelain` vacío). Si no: `failed`.
4. Crea un **worktree de integración** por repo, en `<workspaces>/<ID>/<nombre-repo>`, sobre una rama nueva `hector/<ID>` que parte del `HEAD` actual. Si la rama ya existe: `failed` (`Branch hector/<ID> already exists…`).
5. Guarda el ticket como artefacto `ticket.md`.

Se crean worktrees para todos los repos, incluso los que el ticket quizá no toque, para que la investigación pueda leerlos. Al final se eliminan los que quedaron sin cambios.

El **componente principal** es el primero de la config. Los agentes globales (`enrich`, `plan`, `review`, `qa-plan`, `lead`) trabajan desde su carpeta y reciben acceso de lectura a los demás repos.

## 1. `enrich` — investigación

| | |
|---|---|
| Rol | `enrich`, solo lectura |
| Recibe | El ticket completo y la lista de componentes (nombre, descripción, repo, carpeta, ruta de lectura, comando de tests) |
| Devuelve | `summary`, `stack[]`, `relevantFiles[{path, why}]`, `conventions[]`, `openQuestions[]` |
| Artefacto | `enrich.json` |

Si devuelve `openQuestions`, se registran en el log y el flujo **sigue**: la autonomía es la regla. Las dudas que importen las resolverán los workers con `ask`.

## 2. `plan` — tareas

| | |
|---|---|
| Rol | `plan`, solo lectura |
| Recibe | Ticket, componentes y la investigación |
| Devuelve | `summary`, `tasks[]`, `risks[]` |
| Artefactos | `plan.json`, `plan.md` (legible) |

Cada tarea tiene `id`, `component`, `dependsOn[]`, `description`, `files[]` (relativos a la carpeta del componente) y `acceptanceCriteria[]`.

El código valida el plan antes de seguir. Falla (`failed`) si:

- una tarea usa un componente que no existe (`Unknown component "mobile"`),
- hay IDs repetidos, una dependencia inexistente (`depends on unknown task T9`), una tarea que depende de sí misma o un ciclo (`dependency cycle`).

Los **componentes involucrados** son los que tienen al menos una tarea. Solo ellos pasan por los pasos siguientes.

## 3. `write-tests:<componente>` — tests bloqueados

Se ejecuta **una vez por componente involucrado**, en orden, en su worktree de integración.

| | |
|---|---|
| Rol | `testAuthor`, modo `tests` |
| Recibe | Ticket, criterios numerados, las tareas del plan para ese componente, stack y convenciones, comando de tests y prefijos permitidos |
| Devuelve | `testFiles[]`, `acceptanceMap[{criterion, command}]` |
| Puede escribir | **Solo** en los `lockedPaths` de su componente (aunque estén fuera de su carpeta) |
| Artefacto | `write-tests_<componente>.json` |

El autor escribe tests para la parte de los criterios que le corresponde a su componente, en el framework y estilo del proyecto, y un **comando por criterio** que termina con código 0 solo si el criterio se cumple (normalmente, ejecutar únicamente esos tests). Los comandos se ejecutan desde la carpeta del componente.

Después de cada autor, cualquier archivo cambiado que **no** esté en rutas bloqueadas se revierte (evento `guard: reverted non-test files`).

## 4. Bloqueo de tests

El código:

1. Rechaza (`failed`) cualquier comando del mapa que no pase el `allowedCommands` de su componente.
2. Exige que el mapa tenga al menos tantos comandos como criterios tiene el ticket. Si no: `failed`.
3. Hace un commit por repo con cambios: `test(<ID>): acceptance tests for <título>`. Ese commit es el **testsRef** de ese repo: la referencia contra la que se protegen los tests.
4. Exige que al menos un repo tenga tests nuevos. Si no: `failed` (`No test files matching lockedPaths were written for any component.`).
5. Ejecuta el `testCommand` de cada componente involucrado ("red check"). **Lo esperado es que falle**, porque la funcionalidad no existe. Si pasa, se registra un aviso: los tests podrían no restringir el cambio.

Artefacto: `acceptance-map.json`.

## 5. Implementación en paralelo

Las tareas se ejecutan como un **grafo de dependencias** (`src/scheduler.ts`):

- Una tarea arranca cuando todas sus dependencias están **integradas**.
- Como mucho `policy.maxParallel` tareas a la vez.
- Si una tarea falla, no arrancan tareas nuevas; se espera a las que están corriendo y el flujo se detiene con el estado de la tarea fallida.

Cada tarea sigue estos pasos:

### 5.1 Worktree de la tarea

Se crea `<workspaces>/<ID>/_tasks/<Tn>`, con una rama `hector-tasks/<ID>/<Tn>` que parte de la rama de integración **en ese momento**. Por eso una tarea ve el código de las tareas de las que depende.

### 5.2 `implement-<Tn>`

| | |
|---|---|
| Rol | `coder`, modo `edit`, con la herramienta `ask` |
| Trabaja en | La carpeta de su componente dentro del worktree de la tarea |
| Recibe | Ticket, plan completo (con componentes y dependencias), ledger, rutas de lectura de los otros componentes, su tarea |
| Devuelve | `changedFiles[]`, `notes` |
| Puede escribir | Solo dentro de la carpeta de su componente, nunca en rutas bloqueadas |
| Puede ejecutar | Los `allowedCommands` de su componente |

Al terminar, el código:

1. **Protege los tests:** revierte cualquier cambio en rutas bloqueadas respecto al testsRef.
2. **Commitea archivos exactos:** toma los archivos que git ve cambiados y
   - revierte los que están **fuera** de la carpeta del componente,
   - revierte (o marca, con `undeclaredFiles: "commit"`) los que el agente **no declaró**,
   - commitea solo los declarados y realmente cambiados: `feat(<ID>): <Tn> <descripción>`.
3. Registra el commit en el **ledger** con los archivos según git.

Si el agente no cambió nada commiteable, se registra y no se hace commit.

### 5.3 Compuerta (`gate:<Tn>`)

Ejecuta `buildCommand` y `lintCommand` del componente en el worktree de la tarea. No ejecuta los tests: pueden fallar legítimamente porque otras tareas aún no terminaron.

Si falla, el **mismo worker** (retomando su sesión) recibe la salida del error y lo corrige (`gate-<Tn>`). Cada intento consume uno de sus `sameWorkerRetries`. Si se agotan: `needs_human` (`Task Tn does not build and its worker has no retries left`). Si el componente no tiene build ni lint, la compuerta pasa sin ejecutar nada.

### 5.4 Integración

El código fusiona la rama de la tarea en la rama de integración de su repo, con un commit de merge `merge(<ID>): <Tn> into integration`. Las operaciones de git de un mismo repo se serializan, así que dos tareas nunca fusionan a la vez.

**Si hay conflicto** (otra tarea ya integrada tocó lo mismo):

1. Se aborta el merge en la integración.
2. Se fusiona la rama de integración **dentro del worktree de la tarea**, dejando los marcadores de conflicto.
3. El **mismo worker** retoma su sesión (`resolve-<Tn>`) con la lista de archivos en conflicto y la instrucción de conservar ambos cambios y quitar los marcadores, sin usar git.
4. El código comprueba que no queden marcadores (`<<<<<<<`, `=======`, `>>>>>>>`). Si quedan: `needs_human`.
5. Concluye el merge en el worktree de la tarea y vuelve a integrar, que ahora entra limpio.

Resolver un conflicto consume uno de los `sameWorkerRetries` del worker. Sin reintentos disponibles: `needs_human` (`conflicts with work integrated in parallel`).

## 6. `stabilize:<componente>`

Con todas las tareas integradas, para cada componente involucrado se ejecuta, en su worktree de integración: `buildCommand`, `testCommand`, `lintCommand` (los que existan). Si algo falla, entra el [bucle de reparación](#el-bucle-de-reparación).

## 7. `review` — revisión

| | |
|---|---|
| Rol | `review`, solo lectura, uno o varios **jueces** |
| Recibe | Ticket, componentes y el diff de **todos** los repos desde su base, con un encabezado `### repository <nombre>` por repo; si el juez tiene `focus`, un bloque `<review_focus>` |
| Devuelve | `approved`, `issues[{severity, component, file, description}]` con `severity` = `blocker`, `major` o `minor` |
| Artefactos | Un juez: `review-1.json`, `review-2.json`… Varios: `review_<juez>-<ronda>.json` por juez y `review-<ronda>.json` con el veredicto fusionado y el voto de cada uno |

**Varios jueces** (`review.judges`): todos revisan el mismo diff **en paralelo y por separado**, cada uno con su modelo, esfuerzo y foco. El veredicto se fusiona en código:

- aprobado solo si **todos** aprueban y ningún hallazgo es `blocker`;
- los hallazgos iguales (componente, archivo y descripción, sin distinguir mayúsculas ni espacios) se unen con la severidad más alta;
- cada hallazgo indica qué jueces lo levantaron: `[security, maintainer] …`.

El log muestra el voto: `· review round 1: security approves, maintainer rejects → not approved`.

Si hay hallazgos `blocker` o `major` y quedan rondas (`reviewRounds`):

1. Se agrupan por componente y por **worker dueño** del archivo (el worker cuyos commits tocaron más archivos del grupo).
2. Cada grupo se enruta como un defecto (ver [Enrutamiento](#enrutamiento-de-un-defecto)).
3. Se vuelve a estabilizar cada componente.
4. Se revisa otra vez.

Los hallazgos `minor` nunca disparan correcciones. El revisor **no corrige nada**.

## 8. `qa:<componente>` — el código decide si está terminado

Para cada componente con comandos en el mapa de aceptación, el código ejecuta cada comando desde la carpeta del componente en su worktree de integración. Si alguno falla, el conjunto de fallos (criterio + salida) entra en el bucle de reparación.

Artefacto: `qa-report.json`, con una fila por comando: `component`, `criterion`, `command`, `ok`.

## 9. `final-check:<componente>`

Build + test + lint otra vez por componente, para asegurar que las reparaciones de QA no rompieron nada.

## 10. `qa-plan`

| | |
|---|---|
| Rol | `qaPlan`, solo lectura |
| Recibe | Ticket, comandos automáticos que ya pasan y el diff de todos los repos |
| Devuelve | `markdown` |
| Artefacto | `test-plan.md` |

Un plan de pruebas manuales de punta a punta, solo con casos que pueden ocurrir de verdad.

## 11. Cierre

1. Registra el último commit de cada rama de integración (`flowCommit`), que `distill` usará como referencia.
2. **Si todo salió bien:** elimina los worktrees y ramas de tarea.
3. **Si falló:** conserva los worktrees de tarea para inspección.
4. Elimina el worktree y la rama de integración de los repos que quedaron sin cambios y sin tareas.
5. Determina el estado final:
   - `completed`: todo pasó y la última revisión no tiene `blocker`.
   - `needs_human`: todo pasó, pero quedan `blocker` tras las rondas permitidas (el trabajo está commiteado), o el flujo se detuvo a propósito antes.
   - `failed`: error de un agente, de configuración o de git.
6. Escribe `summary.json` y ejecuta `notifyCommand`.

---

## El bucle de reparación

Lo usan `stabilize`, `review-fix`, `qa` y `final-check`. Para un componente y un check:

```
ejecutar el check
mientras falle:
    si ya se usaron repairAttempts reparaciones en total → needs_human
    diagnose:<comp>  (solo lectura)
        recibe: ticket, componente, salida del fallo, diff desde el testsRef,
                fixes validados que coinciden con códigos de error de la salida (p. ej. TS2345, CS8862)
        devuelve: owner, errorSignature, rootCause, files[], fixPlan
    si owner = "test" o "environment" → needs_human (decide un humano)
    enrutar el defecto (ver abajo)
    ejecutar el check otra vez
si hubo reparaciones y ahora pasa → guardar el último diagnóstico como lección validada
```

`owner` significa:

| Valor | Cuándo | Qué hace el flujo |
|---|---|---|
| `implementation` | El código de producción está mal. | Repara automáticamente. |
| `test` | Un test bloqueado contradice los criterios del ticket. | Se detiene: los tests bloqueados no los cambia un implementador. |
| `environment` | Falta una herramienta, dependencia, configuración o servicio. | Se detiene: no es un problema de código. |

### Enrutamiento de un defecto

1. **¿Hay un worker dueño?** Es el worker del componente cuyos commits tocaron más archivos de los que señala el diagnóstico (o el hallazgo de revisión).
2. **Si tiene reintentos** (`sameWorkerRetries`) y ya está integrado:
   - se actualiza su worktree con la rama de integración (fast-forward),
   - se **retoma su sesión** con los defectos (`repair-<Tn>` o `review-<Tn>`); ya tiene en contexto el ticket, su tarea y lo que construyó,
   - se commitean archivos exactos y se vuelve a integrar.
3. **Si no hay dueño o agotó sus reintentos:** un implementador **nuevo** trabaja directamente sobre el worktree de integración (`repair:<comp>` o `review:<comp>`), con el diagnóstico o los hallazgos completos.

Cada reparación cuenta para `repairAttempts`, venga por donde venga.

---

## El canal `ask`

Todos los agentes `coder` tienen una herramienta `ask`. Cuando un worker la usa:

1. Si ya se hicieron `maxQuestions` preguntas, recibe: *"No more questions are available in this run…"* y decide solo.
2. Si no, un agente `lead` (solo lectura) responde a partir del ticket, la investigación, el plan y el código, y devuelve `answer`, `confident` y `basis`.
3. Si `confident` es `true`, el worker recibe la respuesta con su fundamento.
4. Si es `false`, recibe *"No authoritative answer exists. Lead's suggestion: …"* más la instrucción de decidir de forma conservadora y anotar el supuesto. La pregunta queda como **supuesto abierto** en el resumen.

El worker nunca se queda esperando a un humano. Artefacto: `questions.json`.

---

## Commits que verás en las ramas

| Mensaje | Lo crea |
|---|---|
| `test(<ID>): acceptance tests for <título>` | Bloqueo de tests (uno por repo) |
| `feat(<ID>): <Tn> <descripción>` | Implementación de una tarea |
| `fix(<ID>): <Tn> fix build` | Corrección en la compuerta |
| `fix(<ID>): <Tn> fix verification failure` | Reparación por el mismo worker |
| `fix(<ID>): <Tn> fix review findings` | Corrección de revisión por el mismo worker |
| `fix(<ID>): fix verification failure in <comp>` | Reparación por un implementador nuevo |
| `fix(<ID>): address review findings in <comp>` | Corrección de revisión por un implementador nuevo |
| `merge(<ID>): <Tn> into integration` | Integración de una tarea |
| `merge(<ID>): sync <Tn> with integration` | Actualización del worktree de una tarea (incluida la resolución de conflictos) |

---

## Estados finales y sus causas

| Estado | Causas posibles |
|---|---|
| `completed` | Todo pasó y la revisión no tiene bloqueantes. |
| `needs_human` | Diagnóstico de `test` o `environment`; `repairAttempts` agotado; una tarea no compila y su worker agotó reintentos; conflicto sin resolver o con marcadores restantes; no se pudo actualizar el worktree de un worker; bloqueantes de revisión tras las rondas. |
| `failed` | Un agente falló (sesión, turnos, presupuesto, salida que no cumple el contrato); plan inválido; mapa de aceptación inválido o incompleto; ningún test escrito; repo sucio; rama ya existente; cualquier error inesperado. |

Qué hacer en cada caso: [10-problemas.md](10-problemas.md).
