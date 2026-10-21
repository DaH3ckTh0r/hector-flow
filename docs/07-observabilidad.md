# 7. Observabilidad: logs, artefactos y resumen

Cada ejecución deja todo lo que pasó en una carpeta propia:

```
<workspaces>/_runs/<ID>-<fecha ISO>-<6 caracteres>/
├── events.jsonl     ← un evento por línea, en orden
├── summary.json     ← resultado final
└── artifacts/       ← entradas y salidas de cada paso
```

La ruta aparece al final de la ejecución en la línea `log`, y en `summary.json` como `runDir`.

## `events.jsonl`

Un objeto JSON por línea. Todos tienen `ts` (fecha ISO), `runId` y `type`. Los tipos:

| `type` | Campos | Cuándo |
|---|---|---|
| `step.start` | `step`, `attempt?`, `runtime?` | Empieza un agente |
| `step.end` | `step`, `ok`, `durationMs`, `costUsd?`, `attempt?`, `role`, `runtime`, `usage?` | Termina un agente (también si falla). `usage` son los tokens de esa llamada, por modelo: ver [Consumo de tokens](#consumo-de-tokens) |
| `shell` | `step`, `command`, `ok`, `code`, `durationMs` | Termina un comando ejecutado por el código (checks, compuertas, QA, notificación) |
| `guard` | `step`, `action`, `detail` | Una guarda negó una herramienta o revirtió archivos |
| `info` | `message`, `data?` | Hitos: worktrees, integraciones, enrutamiento de defectos, avisos |
| `error` | `step`, `message` | El flujo se detuvo |

Ejemplo real:

```json
{"ts":"2026-10-21T00:45:51.377Z","runId":"TIENDA-42-2026-10-21T00-45-51-292Z-1decc4","type":"step.start","step":"enrich"}
```

La consola muestra los mismos eventos en formato legible:

| Consola | Evento |
|---|---|
| `▶ implement-T1` | `step.start` |
| `✔ implement-T1 61.0s $0.4120 57k tok` / `✖ …` | `step.end` |
| `  $ npm test → exit 1 (0.5s)` | `shell` |
| `  ⚠ guard: reverted undeclared files — scratch.txt` | `guard` |
| `  · integrated T1 into tienda-api:hector/TIENDA-42` | `info` |
| `  ✖ flow: …` | `error` |

### Nombres de pasos

| Paso | Significado |
|---|---|
| `enrich`, `plan`, `review`, `qa-plan` | Agentes globales |
| `review:<juez>` | Un juez, cuando hay varios (`review.judges`) |
| `write-tests:<comp>` | Autor de tests de un componente |
| `tests-red:<comp>` | Ejecución de tests antes de implementar |
| `implement-<Tn>` | Implementación de una tarea |
| `gate:<Tn>` / `gate-<Tn>` | Compuerta de la tarea / corrección de la compuerta por su worker |
| `resolve-<Tn>` | Resolución de conflictos por el worker |
| `check:<comp>` | Build + test + lint de un componente |
| `diagnose:<comp>` | Diagnóstico de un fallo |
| `repair-<Tn>` / `repair:<comp>` | Reparación por el mismo worker / por un implementador nuevo |
| `review-<Tn>` / `review:<comp>` | Corrección de revisión por el mismo worker / por uno nuevo |
| `qa:<comp>` | Comandos del mapa de aceptación |
| `ask-<n>` | Respuesta del lead a la pregunta n |
| `notify` | `notifyCommand` |

### Consultas útiles con `jq`

```bash
RUN=$(ls -dt ~/code/.hector-workspaces/_runs/AB-123-* | head -1)

# Costo y duración por paso
jq -r 'select(.type=="step.end") | "\(.step)\t\(.durationMs/1000|floor)s\t$\(.costUsd // 0)"' $RUN/events.jsonl

# Costo total
jq -s '[.[] | select(.type=="step.end") | .costUsd // 0] | add' $RUN/events.jsonl

# Tokens por paso (entrada, caché escrita, caché leída, salida)
jq -r 'select(.type=="step.end" and .usage) | [.step, ([.usage[].input]|add), ([.usage[].cacheWrite]|add), ([.usage[].cacheRead]|add), ([.usage[].output]|add)] | @tsv' $RUN/events.jsonl

# Qué negaron o revirtieron las guardas
jq -r 'select(.type=="guard") | "\(.step): \(.action) — \(.detail)"' $RUN/events.jsonl

# Comandos que fallaron
jq -r 'select(.type=="shell" and .ok==false) | "\(.step): \(.command) (exit \(.code))"' $RUN/events.jsonl

# Por qué se detuvo
jq -r 'select(.type=="error") | .message' $RUN/events.jsonl

# Seguirlo en vivo
tail -f $RUN/events.jsonl | jq -r '"\(.ts[11:19]) \(.type) \(.step // "") \(.message // .action // .command // "")"'
```

## `summary.json`

| Campo | Tipo | Descripción |
|---|---|---|
| `runId` | string | Identificador de la ejecución (nombre de la carpeta) |
| `ticketId` | string | ID del ticket |
| `status` | string | `completed`, `needs_human` o `failed` |
| `reason` | string? | Por qué no terminó en `completed` |
| `repos[]` | objeto[] | Un elemento por repo que el ticket modificó (ver abajo) |
| `branch`, `worktree`, `flowCommit` | string? | Los del repo principal, por comodidad |
| `tasks` | número | Tareas del plan |
| `maxConcurrentWorkers` | número | Máximo de implementadores trabajando a la vez |
| `repairAttempts` | número | Reparaciones automáticas usadas |
| `reviewRounds` | número | Rondas de corrección por revisión |
| `questionsAsked` | número | Preguntas `ask` |
| `openAssumptions[]` | objeto[] | Preguntas sin respuesta con fundamento: `asker`, `question`, `answer`, `confident`, `basis` |
| `memoriesSaved` | número | Memorias guardadas en la ejecución (validadas solo si terminó en `completed`) |
| `costUsd` | número | Costo estimado total, sumando todos los agentes |
| `usage` | objeto | Tokens de todas las llamadas a agentes (incluidas las fallidas): `total`, `byModel` (clave `"<modelo> (<runtime>)"`) y `byRuntime`, cada uno con los contadores de [Consumo de tokens](#consumo-de-tokens) |
| `durationMs` | número | Duración total |
| `runDir` | string | Carpeta de la ejecución |

Cada elemento de `repos[]`:

| Campo | Descripción |
|---|---|
| `name` | Nombre de la carpeta del repo |
| `root` | Ruta de tu checkout |
| `branch` | `hector/<ID>` |
| `worktree` | Ruta del worktree de integración, donde está el resultado |
| `baseRef` | Commit del que partió la rama |
| `baseBranch` | Rama activa en tu checkout cuando empezó el ticket: el destino de `approve` y del modo `auto` |
| `testsRef` | Commit de los tests bloqueados (igual a `baseRef` si ese repo no tuvo tests nuevos) |
| `flowCommit` | Último commit que hizo el flujo. Lo que cambies después es lo que `distill` analiza |

## Artefactos

Los nombres de archivo reemplazan `:` y otros caracteres no válidos en Windows por `_` (por ejemplo, el paso `write-tests:api` genera `write-tests_api.json`). Si un paso se repite, se agrega el número de intento (`review-1.json`, `diagnose_api-2.json`).

| Archivo | Contenido |
|---|---|
| `ticket.md` | Copia del ticket |
| `enrich.json` | Investigación: resumen, stack, archivos relevantes, convenciones, preguntas |
| `plan.json`, `plan.md` | Plan en JSON y en markdown legible, con componente y dependencias de cada tarea |
| `write-tests_<comp>.json` | Archivos de test y mapa de aceptación de cada componente |
| `acceptance-map.json` | Mapa de aceptación completo: `criterion`, `command`, `component` |
| `implement-<Tn>.json` | `changedFiles` y `notes` del worker |
| `gate-<Tn>-<n>.json`, `resolve-<Tn>.json` | Correcciones de compuerta y resolución de conflictos |
| `diagnose_<comp>-<n>.json` | Diagnóstico: `owner`, `errorSignature`, `rootCause`, `files`, `fixPlan` |
| `repair-<Tn>-<n>.json`, `repair_<comp>-<n>.json` | Reparaciones |
| `review-<n>.json` | Revisión de la ronda n: `approved`, `issues`. Con varios jueces, el veredicto **fusionado** más `judges[{judge, approved}]` |
| `review_<juez>-<n>.json` | Con varios jueces: la revisión de cada uno |
| `qa-report.json` | Una fila por comando de aceptación: `component`, `criterion`, `command`, `ok` |
| `questions.json` | Todas las preguntas `ask` con su respuesta |
| `test-plan.md` | Plan de pruebas manuales |
| `ledger.json` | Ver abajo |

### `ledger.json`

Un elemento por commit que hizo el flujo:

| Campo | Descripción |
|---|---|
| `step` | Paso que lo produjo (`write-tests`, `implement-T1`, `repair-T1`, `resolve-T2`, `repair:api`…) |
| `role` | `testAuthor` o `coder` |
| `component` | Componente (en los commits de tests, los componentes del repo separados por coma) |
| `repo` | Nombre del repo |
| `taskId` | Tarea dueña, si la hay |
| `description` | Descripción del commit |
| `sha` | SHA del commit |
| `files` | Archivos según git, relativos a la raíz del repo |
| `undeclared` | Archivos que el agente cambió sin declararlos (revertidos o incluidos, según `undeclaredFiles`) |
| `notes` | Notas del agente |

Cada implementador recibe el ledger en su prompt para mantener coherencia con lo que ya se construyó, y `distill` lo usa para atribuir tus correcciones.

## Consumo de tokens

Cada llamada a un agente registra en su evento `step.end` los tokens que consumió, **por modelo** (un paso puede usar más de uno, por ejemplo en llamadas internas del runtime):

```json
{"type":"step.end","step":"implement-T1","ok":true,"durationMs":61000,"costUsd":0.412,"role":"coder","runtime":"claude",
 "usage":{"claude-sonnet-5-5":{"input":1840,"cacheWrite":12210,"cacheRead":184300,"output":9120,"reasoning":2100,"costUsd":0.405},
          "claude-haiku-5-5":{"input":610,"cacheWrite":0,"cacheRead":0,"output":45,"reasoning":0,"costUsd":0.007}}}
```

| Campo | Qué cuenta |
|---|---|
| `input` | Tokens de entrada **no** servidos desde la caché de prompts |
| `cacheWrite` | Tokens de entrada escritos en la caché |
| `cacheRead` | Tokens de entrada leídos de la caché (suelen ser la mayoría en sesiones largas, y los más baratos) |
| `output` | Tokens de salida, razonamiento incluido |
| `reasoning` | Tokens de razonamiento ("thinking"), **ya contados** en `output`, cuando el runtime los informa |
| `costUsd` | Costo estimado en USD, cuando el runtime lo informa |
| `extra` | Contadores propios del runtime: `webSearchRequests` (Claude); `nanoAiu` y `billingMultiplier` (Copilot) |

Total de tokens = `input + cacheWrite + cacheRead + output`.

Las llamadas fallidas también se registran, con lo que alcanzaron a gastar. `distill` registra su llamada en el log de la ejecución del ticket, así que entra en los informes de ese ticket.

### Cómo informa cada runtime

| Runtime | De dónde sale | Notas |
|---|---|---|
| Claude | `modelUsage` del resultado del Agent SDK, por modelo | Incluye subagentes y llamadas internas. Al **retomar** una sesión, el SDK devuelve los totales acumulados de toda la sesión; el flujo resta lo ya contado, así que cada llamada (y su `costUsd`) cuenta solo sus turnos nuevos. |
| Codex | `usage` del turno | OpenAI incluye los tokens cacheados dentro de `input_tokens`; el flujo los separa (`input = input_tokens − cached_input_tokens`). No informa el modelo: se usa el configurado, o `codex default`. Sin USD. |
| OpenCode | Partes `step-finish` de todos los mensajes que generó el prompt | Se suman todos los pasos, no solo el último mensaje. `input` ya excluye la caché. USD según OpenCode. |
| pi | El `usage` de cada mensaje del asistente | Ya normalizado por pi (`input` sin caché). USD según los precios de su catálogo. |
| Copilot | Un evento `assistant.usage` por llamada al modelo | Se suman por modelo. Copilot no documenta si su `inputTokens` incluye los tokens leídos de caché: se guarda tal cual, así que el total puede contarlos dos veces. Sin USD; `extra.nanoAiu` y `extra.billingMultiplier` son sus unidades de facturación. |

Son las cifras que informa cada runtime: sirven para comparar pasos, modelos y tickets, pero no sustituyen la factura del proveedor.

### Informes: `hector-flow usage`

Lee los `events.jsonl` de todas las ejecuciones y agrupa:

```bash
npm run flow -- usage --repo <repo>                          # por modelo (por defecto)
npm run flow -- usage --repo <repo> --by step                # qué pasos gastan más
npm run flow -- usage --repo <repo> --ticket-id TIENDA-42    # un ticket
npm run flow -- usage --repo <repo> --by day --since 2026-10-01
npm run flow -- usage --repo <repo> --by runtime --json      # para otra herramienta
```

```
step             calls  input  cache write  cache read  output  reasoning  total   cost $
implement-T*         4  7.4k         49k        737k     36k       8.4k   830k   1.6480
review:security      2  2.1k         18k        122k     4.0k      1.1k   146k   0.3110
…
TOTAL               17   14k         96k        1.2M     52k        12k   1.4M   2.4520
```

`--by` acepta `model`, `runtime`, `step` (las tareas se agrupan como `implement-T*`), `role`, `ticket`, `run` y `day`. Agrupando por `model`, el mismo modelo en dos runtimes aparece por separado (`claude-sonnet-5-5 (claude)` y `claude-sonnet-5-5 (copilot)`).

Al final de `run` y de `distill` la consola también muestra el total:

```
tokens   in 14k · cache w 96k r 1.2M · out 52k (reasoning 12k) · total 1.4M
         claude-sonnet-5-5 (claude): in 12k · cache w 90k r 1.1M · out 48k (reasoning 11k) · total 1.3M
```

## Memoria y estado del bucle

Junto a `_runs/` y `_lessons/`, en la carpeta de trabajo:

| Ruta | Contenido |
|---|---|
| `_memory/<repo>.jsonl` | Memoria persistente: una entrada JSON por línea. Ver [14-memoria-y-mcp.md](14-memoria-y-mcp.md). |
| `_loop/state.json` | Estado del bucle: un objeto por ticket con `id`, `title`, `ref`, `status`, `updatedAt`, `runId`, `runDir`, `reason`, `repos` y `openAssumptions`. |
| `_loop/lock` | Bloqueo del bucle en curso (`pid`, `startedAt`). |

Eventos `info` relacionados: `recalled N memories for enrich`, `memory saved by <paso>: [kind] título (id)`, `N memories from this run validated`.

## Enviar los logs a otro sistema

`events.jsonl` es JSON por líneas, así que lo puede ingerir directamente cualquier agente de logs (Azure Monitor Agent, Fluent Bit, Vector) y consultarse después en Log Analytics o Application Insights. Para métricas, los campos útiles son `step.end.durationMs`, `step.end.costUsd`, `step.end.usage`, `summary.repairAttempts`, `summary.status` y `summary.maxConcurrentWorkers`.
