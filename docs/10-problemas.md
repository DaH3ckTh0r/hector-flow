# 10. Solución de problemas

Primero, siempre:

1. Lee la línea `reason` del resumen (o `summary.json`).
2. Busca el error en el log: `jq -r 'select(.type=="error") | .message' <runDir>/events.jsonl`.
3. Mira qué hicieron las guardas: `jq -r 'select(.type=="guard")' <runDir>/events.jsonl`.
4. Antes de volver a ejecutar el mismo ticket: `npm run flow -- clean --repo <repo> --ticket-id <ID>`.

## Antes de ejecutar

| Mensaje | Causa | Solución |
|---|---|---|
| `Could not read config at …` | No existe `hector-flow.config.json` en `--repo`, o no es JSON válido. | Créalo o pasa `--config`. Valida el JSON (sin comentarios ni comas finales). |
| `Invalid config at …` + `→ at <ruta>` | Un campo falta o tiene un tipo incorrecto. | Corrige el campo indicado. Referencia: [03-configuracion.md](03-configuracion.md). |
| `Define either 'components' (one or more) or a top-level 'testCommand'.` | La config no define qué probar. | Agrega `components` o `testCommand`. |
| `component names: lowercase, digits, dashes` | Nombre de componente no válido (`Backend`, `api_v2`). | Usa minúsculas, dígitos y guiones. |
| `Component "x": … is not inside a git repository.` | `repo` apunta a una carpeta que no es un repo git. | Corrige la ruta (es relativa al repo principal). |
| `Component path must stay inside its repo` | `path` empieza con `..` o es absoluto. | Usa una carpeta dentro del repo. |
| `Two different repositories are both named "x"` | Dos repos con la misma carpeta final. | Renombra una carpeta o clónala con otro nombre. |
| `Ticket … has no '# title' line` | Falta la línea de título. | Agrega `# ID: título` al principio. |
| `Ticket … has no acceptance criteria` | Falta `## Acceptance criteria` o no tiene viñetas. | Agrega la sección con al menos una viñeta. |
| `check`: `⚠ … agents can run its test command` | `testCommand` no está en `allowedCommands`. | Agrega su prefijo a `allowedCommands`. |
| `check`: `✖ … test "…" passes on the current code` | Los tests fallan **antes** de empezar. | Arréglalos primero: el flujo no puede distinguir sus fallos de los nuevos. |
| `check`: `⚠ … has hector branches from earlier runs` | Quedan ramas de ejecuciones anteriores. | `clean` para el ticket que quieras repetir. |

## Al empezar la ejecución (`failed`)

| Mensaje | Causa | Solución |
|---|---|---|
| `… has uncommitted changes` | Un repo de un componente no está limpio. | Commitea o `git stash`. |
| `Branch hector/<ID> already exists in …` | Hay una ejecución anterior del ticket. | `clean --ticket-id <ID>`, o fusiona primero lo que quieras conservar. |
| `enrich: Agent failed: …` o `enrich: …` en el primer paso | Normalmente autenticación o red. | Comprueba que `claude` funciona en esa terminal, o que `ANTHROPIC_API_KEY` está exportada. |

## Errores de agentes (`failed`)

El mensaje empieza por el nombre del paso, por ejemplo `plan: Agent failed: error_max_turns`.

| Detalle | Causa | Solución |
|---|---|---|
| `Agent failed: error_max_turns` | El agente agotó `maxTurnsPerAgent`. | Sube el límite, o divide el ticket en piezas más pequeñas. |
| `Agent failed: error_max_budget_usd` | El agente agotó `maxBudgetUsdPerAgent`. | Sube el límite o usa un modelo más barato para ese rol. |
| `Agent failed: error_max_structured_output_retries` | El agente no consiguió devolver JSON con el formato esperado. | Suele ser un modelo demasiado pequeño para el rol. Usa uno mayor en `models`. |
| `Agent failed: error_during_execution` | Error durante la sesión (red, API, herramienta). | Reintenta. Si se repite, revisa tu conexión y tu cuenta. |
| `Structured output did not match the contract` | El JSON pasó el esquema del SDK pero no la validación de zod. | Reintenta; si se repite, abre un issue con el artefacto. |
| `Agent ended without a result message` | La sesión terminó sin resultado. | Reintenta. |

## Errores de plan y tests (`failed`)

| Mensaje | Causa | Solución |
|---|---|---|
| `Unknown component "x"` | El planificador usó un componente que no existe. | Mejora las `description` de los componentes, o nombra los componentes en las subtareas del ticket. |
| `Invalid plan: … dependency cycle` / `depends on unknown task` / `duplicate task ids` | El plan no es un grafo válido. | Reintenta; si se repite, sugiere las subtareas en el ticket. |
| `Acceptance map for <comp> has commands outside allowedCommands` | El autor de tests propuso un comando no permitido. | Agrega el prefijo a `allowedCommands` si es seguro, o pide en el ticket o en `CLAUDE.md` cómo se ejecutan tests concretos. |
| `Acceptance map has N checks for M acceptance criteria` | Faltan comandos para algunos criterios. | Revisa que los criterios sean verificables por algún componente. |
| `No test files matching lockedPaths were written for any component.` | El autor de tests escribió fuera de `lockedPaths` (y se revirtió) o no escribió nada. | Revisa que `lockedPaths` coincida con donde viven tus tests. Mira `write-tests_<comp>.json` y los eventos `guard`. |
| Aviso `tests already pass before implementation` | Los tests nuevos no fallan antes de implementar. | No detiene el flujo, pero los tests podrían no comprobar nada nuevo. Revísalos. |

## Detenciones intencionadas (`needs_human`)

El flujo se detiene a propósito para que decidas tú. Los worktrees de tarea se conservan en `<workspaces>/<ID>/_tasks/` para inspección.

| Mensaje | Qué significa | Qué hacer |
|---|---|---|
| `the diagnosis says the problem is in the test` | Un test bloqueado contradice los criterios, según el diagnóstico. | Abre el test en el worktree de integración. Si está mal, corrígelo y termina el trabajo a mano. Si está bien, termina la implementación a mano y considera `distill`. |
| `the diagnosis says the problem is in the environment` | Falta una herramienta, dependencia, configuración o servicio. | Arréglalo, ejecuta `check`, luego `clean` y `run`. |
| `still failing after N repair attempts` | Se agotó `repairAttempts`. | Mira los `diagnose_*.json`: si se repite la misma causa, probablemente falta información en el ticket. |
| `Task Tn does not build and its worker has no retries left` | La tarea no compila en su worktree. | Revisa `_tasks/Tn`. Suele indicar una tarea mal delimitada o una dependencia no declarada. |
| `Task Tn conflicts with work integrated in parallel (…)` | Dos tareas paralelas chocaron y el worker no tenía reintentos. | Revisa el plan: dos tareas independientes tocan el mismo archivo. Declara la dependencia en las subtareas del ticket. |
| `Task Tn: conflict markers remain in …` | El worker no eliminó todos los marcadores. | Resuelve a mano en `_tasks/Tn`, o repite con `clean` y `run`. |
| `Could not update Tn's workspace` | No se pudo actualizar el worktree de un worker antes de devolverle un defecto. | Raro; revisa `_tasks/Tn` y el log. |
| `Acceptance criteria pass, but review still reports blockers` | Todo pasa, pero el revisor mantiene bloqueantes tras `reviewRounds`. El trabajo está commiteado. | Lee los bloqueantes y decide si corregirlos a mano o aceptarlos. |

## Otros problemas

| Síntoma | Causa probable | Solución |
|---|---|---|
| Muchas reversiones de `undeclared files` y reparaciones de build | Los workers olvidan declarar archivos. | Prueba `undeclaredFiles: "commit"` y revisa el campo `undeclared` del ledger. |
| Un worker no puede escribir donde necesita (`denied Write … belongs to another component`) | La tarea necesita tocar otro componente, o `path` es demasiado estrecho. | Divide la tarea por componente en el ticket, o amplía `path`. |
| El autor de tests no puede escribir tests (`denied Write … only write this component's test files`) | `lockedPaths` no coincide con donde están los tests. | Ajusta `lockedPaths` del componente (es relativo a `path`; puede usar `../`). |
| Se ejecuta todo en serie aunque haya tareas independientes | El planificador declaró dependencias, o `maxParallel` es 1. | Revisa `plan.md`. Define el contrato entre componentes en el ticket para que puedan ir en paralelo. |
| Muchos supuestos abiertos | El ticket deja decisiones sin tomar. | Complétalo con el diseño técnico. |
| Costos altos | Modelos grandes en roles que no los necesitan, o muchas reparaciones. | Ajusta `models` por rol; usa `jq` para ver el costo por paso ([07-observabilidad.md](07-observabilidad.md)). |
| `clean` no borra una carpeta | Contiene archivos que no son de git. | Bórrala a mano. `clean` solo elimina carpetas vacías. |
| Quiero quitar a mano lo que dejó una ejecución | | En cada repo: `git worktree list`, `git worktree remove --force <ruta>` para los de `hector/<ID>` y `hector-tasks/<ID>/*`, luego `git branch -D <rama>` y `git worktree prune`. Es lo que hace `clean`. |

## Códigos de salida

| Código | Significado |
|---|---|
| `0` | `run`: `completed`. `check`: todo correcto. `distill`, `clean`: terminó. |
| `1` | `run`: `failed`. `check`: algún ✖. Cualquier comando: error inesperado (config inválida, etc.). |
| `2` | Uso incorrecto de la CLI (falta una opción obligatoria). |
| `3` | `run`: `needs_human`. |

Útil en scripts:

```bash
npm run flow -- run --repo ~/code/api --ticket AB-123.md
case $? in
  0) echo "listo para revisar" ;;
  3) echo "necesita que decidas algo" ;;
  *) echo "falló" ;;
esac
```
