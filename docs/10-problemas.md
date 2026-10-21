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

## Skills, lecturas y jueces

| Mensaje | Causa | Solución |
|---|---|---|
| `No SKILL.md found for step "x"` | Falta la skill de un paso en todas las carpetas de búsqueda. | Restaura la carpeta `skills/` de hector-flow o crea `.hector/skills/x/SKILL.md`. Ver [13-skills.md](13-skills.md). |
| `⚠ skill x: …` (en `check`, `skills list` o el log) | Front-matter con claves desconocidas, nombre distinto de la carpeta o esfuerzo inválido. | Corrige el `SKILL.md`; no detiene el flujo. |
| `denied Read — … is outside the folders this step may read` | El agente intentó leer fuera de su worktree y de los repos del ticket. | Normal y esperado. Si necesita ese contenido, agrégalo al repo o al ticket. |
| `denied Read — … matches readDenyPaths (secrets)` | El agente intentó leer un archivo de secretos. | Normal. Si el archivo no es secreto, quítalo de `readDenyPaths` (recuerda que definirla reemplaza la lista por defecto). |
| `denied Skill — No skills are enabled for this step` | El agente intentó usar una skill de Claude que no tiene asignada. | Agrégala en la skill del paso (`skills:`) o en `claudeSkills.<rol>`. |
| `review round N: a approves, b rejects → not approved` | Con varios jueces, basta con que uno rechace. | Mira `review_<juez>-N.json` para ver los motivos. Si un juez es demasiado estricto, ajusta su `focus` o la skill `review`. |

## Memoria, MCP, backlog y bucle

| Mensaje | Causa | Solución |
|---|---|---|
| `mcpAccess.<rol> names unknown MCP servers` (en `check`) | `mcpAccess` nombra un servidor que no está en `mcpServers`. | Defínelo o corrige el nombre. |
| `denied mcp__x__… — MCP server "x" is not available to this step` | El agente intentó usar un servidor no asignado a su paso. | Agrégalo en `mcpAccess.<rol>` si debe tenerlo. |
| `No backlog configured…` | `start` sin sección `backlog`. | Configúrala ([15-backlog-y-bucle.md](15-backlog-y-bucle.md)). |
| `Backlog folder … does not exist.` | La ruta de `backlog.path` no existe. | Créala o corrige la ruta (relativa al repo principal). |
| `Environment variable X is not set…` | Falta el token de GitHub o Azure DevOps. | Exporta la variable de `tokenEnv`. |
| `GitHub 401/403/404 …` / `Azure DevOps 401/403 …` | Token inválido, sin permisos, o repo/proyecto mal escrito. | Revisa permisos del token (issues; Work Items read & write) y los nombres. |
| `· skipped <ref>: … no acceptance criteria` | Un elemento del backlog no tiene criterios. | Agrega la sección de criterios (en ADO, el campo Acceptance Criteria). |
| `Another hector-flow loop is running for this repo (pid N…)` | Ya hay un `start` en marcha. | Detenlo, o espera. Si el proceso murió, el bloqueo se libera solo. |
| `→ failed: … has uncommitted changes` en cada ticket | La carpeta de tickets está dentro de un repo y tiene archivos sin commitear. | Muévela fuera del repo o commitea los tickets. |
| `<repo>: your checkout is on X; switch it to Y to merge.` | `approve`/`auto` necesita tu checkout en la rama base. | `git switch Y` y repite `approve`. |
| `<repo>: your checkout has uncommitted changes.` | No se fusiona sobre cambios sin commitear. | Commitea o `git stash`, y repite. |
| `conflicts merging hector/<ID> into <rama>… Nothing was merged.` | La rama base avanzó y choca con el ticket. | `requeue` para rehacerlo sobre la base actual, o resuelve a mano. |
| `"<comando>" fails after merging. Every repo was rolled back.` | El ticket pasa solo, pero no combinado con lo que ya está en la base. | `requeue` (se rehará sobre la base nueva) o arréglalo a mano en la rama. |
| `N open assumption(s): review before merging` | Modo `auto` con supuestos abiertos. | Revisa los supuestos y `approve`, o desactiva `autoMergeRequiresNoAssumptions`. |
| `⚠ could not report back to …` | No se pudo comentar en GitHub/ADO. | Revisa el permiso de escritura del token; el bucle sigue igualmente. |

## Runtimes (Codex, OpenCode, Copilot, pi)

| Mensaje | Causa | Solución |
|---|---|---|
| `✖ opencode is installed (on PATH)` (en `check`) | Un paso usa OpenCode y el binario no está. | `npm i -g opencode-ai`, o envía esos pasos a otro runtime. |
| `OpenCode failed: … ProviderAuthError` / `could not create a session` | OpenCode no tiene credenciales del proveedor, o el modelo no existe. | `opencode auth login`; revisa que `runtime.opencode.model` sea `proveedor/modelo` válido. |
| `use "provider/model"` (al cargar la config) | `runtime.opencode.model` sin proveedor. | Escríbelo como `anthropic/claude-sonnet-4-5`, `openai/gpt-5.5`… |
| `Codex failed: …` al empezar el paso | Codex sin sesión iniciada o sin `OPENAI_API_KEY`, o modelo desconocido. | `npx codex login`; revisa `runtime.codex.model`. |
| `Codex did not return JSON` | El modelo terminó sin respuesta estructurada (por ejemplo, se quedó sin turnos). | Reintenta; sube `effort` o usa un modelo más capaz para ese paso. |
| `denied edit — … is a locked test file` (con OpenCode) | Igual que con Claude: el agente intentó tocar un test bloqueado. | Normal y esperado. |
| `✖ copilot is signed in` (en `check`) / `Copilot is not signed in` | Sin sesión de Copilot ni token. | `npm i -g @github/copilot && copilot login`, o un fine-grained PAT con "Copilot Requests" en `COPILOT_GITHUB_TOKEN` o en la variable de `runtime.copilot.tokenEnv`. Los PAT clásicos (`ghp_`) no sirven. |
| `Environment variable X is not set.` (paso en Copilot) | `runtime.copilot.tokenEnv` nombra una variable vacía. | Expórtala, o quita `tokenEnv`. |
| `Copilot failed: … model …` | El id de modelo no existe o tu plan no lo incluye. | `hector-flow models --repo <repo> copilot` y usa uno de esos ids. |
| `denied write — Your organization's Copilot policy requires a person…` | La política gestionada de Copilot exige aprobar esa acción a mano. | Pide que la política permita esa acción en Copilot CLI, o envía ese paso a otro runtime. |
| `Copilot finished without a final message` | El paso agotó `runtime.copilot.timeoutMinutes` o la sesión falló. | Mira el error que sigue al mensaje; sube `timeoutMinutes` si el paso es largo. |
| `✖ pi has credentials for <modelo>` | pi no tiene clave para ese proveedor. | `pi` y `/login`, o exporta la variable del proveedor (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`…). En el sandbox, solo variables. |
| `✖ pi knows the model …` / `pi does not know the model …` | El id no está en el catálogo de pi, o falta el proveedor. | `hector-flow models --repo <repo> pi` y usa `"proveedor/modelo"`. |
| `pi finished without calling submit_result` | El modelo terminó con texto en vez de llamar a la herramienta de resultado. | Reintenta; usa un modelo con buen uso de herramientas, o sube `effort`. |
| `pi session … is not open in this run` | Se intentó retomar una sesión de pi de otra ejecución. | Las sesiones de pi viven en memoria durante la ejecución; no ocurre en el flujo normal. |
| Un paso en pi no ve un servidor MCP | Los pasos en pi no cargan MCP. | Ejecuta ese paso en Claude, OpenCode, Copilot o Codex. |
| `⚠ codex cannot use SSE MCP servers` | Codex solo soporta servidores stdio y HTTP. | Usa la variante HTTP del servidor, o deja ese paso en Claude u OpenCode. |
| Un juez en otro runtime usa un modelo de Claude por error | `models.review` o el front-matter nombran modelos de Claude y no se aplican fuera de Claude. | Define `model` en el juez o en `runtime.<nombre>.model`. |

## Sandbox

| Mensaje | Causa | Solución |
|---|---|---|
| `⚠ not running in a sandbox (…)` (en `check`) | Modo `auto`, pasos en Codex o tickets de GitHub/Azure DevOps fuera del sandbox. | Usa `sandbox/hector-sandbox.sh` ([17-sandbox.md](17-sandbox.md)), o asume el riesgo. |
| `✖ running in the hector-flow sandbox` | Dentro del contenedor, sin `HTTPS_PROXY`. | Lánzalo con `hector-sandbox.sh`, no con `docker run` directo. |
| Un build falla con errores de red (`ENOTFOUND`, `ECONNREFUSED`, `403`) | El host que necesita no está en la lista. | `hector-sandbox.sh logs \| grep '"allowed":false'` y añádelo a `allowed-domains.txt` (se recarga sola). |
| `Component "x": … is not inside a git repository (spawn git ENOENT)` | Ese repo no está dentro de la carpeta montada. | Mira la línea `mounting …` y usa `--root` con la carpeta que contiene todos los repos. |
| `Run this from inside <carpeta>` | Lanzaste el script fuera de la carpeta montada. | Ejecútalo desde uno de tus repos, o usa `--root`. |
| Un test necesita una contraseña que el flujo quita | `commandEnv.scrubSecrets` la considera credencial. | Añádela a `commandEnv.keep`. |
| Los agentes no pueden autenticarse en el sandbox | La sesión de `claude`/`copilot` de tu `$HOME` no entra. | Usa claves en variables (`ANTHROPIC_API_KEY`, `COPILOT_GITHUB_TOKEN`…), o inicia sesión en `hector-sandbox.sh shell`. |

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
