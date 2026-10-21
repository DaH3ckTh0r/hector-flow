# 6. Seguridad y permisos

hector-flow deja que agentes de IA editen código y ejecuten comandos sin pedir permiso en cada paso. Para que eso sea aceptable, cada agente trabaja con permisos definidos de antemano, y el código revisa lo que pasó después de cada paso. Este documento explica qué está protegido, cómo, y qué **no** lo está.

## El modelo en una tabla

| Capa | Qué controla | Dónde |
|---|---|---|
| **Modo del paso** | `readonly`, `edit` o `tests`: si el agente puede escribir y dónde | `decide()` en `src/runner/claude-runner.ts` |
| **Carpetas legibles** | Un agente solo lee su worktree y los worktrees de integración de los otros repos del ticket | `ReadPolicy` en `src/guards.ts` |
| **Lista de secretos** | Ningún agente lee ni edita rutas de `readDenyPaths` (`.env`, `*.pem`, `~/.ssh`…) | `ReadPolicy` |
| **Aislamiento por componente** | Un implementador solo escribe en la carpeta de su componente | `canUseTool` + `commitExact` |
| **Tests bloqueados** | Nadie salvo el autor de tests escribe en `lockedPaths` | `canUseTool` + `enforceLocks` |
| **Allowlist de comandos** | Qué puede ejecutar un agente con Bash | `isCommandAllowed` en `src/guards.ts` |
| **Herramientas** | Sin web ni subagentes; MCP solo el propio (`ask`, memoria) y los servidores que `mcpAccess` asigna al paso | `disallowedTools` + `decide()` |
| **Commit exacto** | Solo entra en git lo declarado y dentro del componente | `commitExact` |
| **Worktrees** | Tus checkouts nunca se modifican | `src/tools/git.ts` |
| **Topes** | Turnos y gasto por agente; reparaciones y preguntas por ejecución | `policy` |

### Con otros runtimes

Todo lo anterior describe a Claude. **OpenCode** y **GitHub Copilot** aplican las mismas reglas: cada herramienta pide permiso y el flujo responde con `decide()` (en Copilot, además, un gancho revisa las lecturas que no piden permiso). **Codex** no permite aprobar cada herramienta; el flujo usa su sandbox del sistema operativo (solo lectura, o escritura limitada a la carpeta del componente, sin red) y las revisiones de git de después de cada paso, pero **no puede aplicar `readDenyPaths`, las carpetas legibles ni `allowedCommands`**. Tabla completa en [16-runtimes.md](16-runtimes.md#aislamiento-qué-protege-cada-runtime).

### Sandbox

Para ejecuciones desatendidas, tickets de terceros o pasos en Codex, ejecuta hector-flow en el **sandbox** ([17-sandbox.md](17-sandbox.md)): un contenedor que solo ve la carpeta de tus repos, sin ruta a Internet salvo un proxy con lista de dominios permitidos, y con tus credenciales fuera de los comandos de build y test. Es lo único que también aísla los comandos que ejecuta el propio flujo.

## Permisos por modo

| Herramienta | `readonly` | `edit` (implementador) | `tests` (autor de tests) |
|---|---|---|---|
| `Read`, `Glob`, `Grep` | Solo en carpetas legibles y fuera de `readDenyPaths` | Igual | Igual |
| `Write`, `Edit`, `MultiEdit`, `NotebookEdit` | ✖ | Solo en su componente y fuera de rutas bloqueadas | Solo en los `lockedPaths` de su componente |
| `Bash` | ✖ | Solo `allowedCommands` | Solo `allowedCommands` |
| `ask` (MCP propio) | — | ✔ | — |
| `memory_search` / `memory_save` (MCP propio) | Según `memory.search` / `memory.save` | Igual | Igual |
| MCP externo (`mcpServers`) | Solo los servidores de `mcpAccess` del paso | Igual | Igual |
| `Skill` (skills de Claude Code) | Solo si el paso tiene skills asignadas | Igual | Igual |
| `WebFetch`, `WebSearch`, `Task`/`Agent` | ✖ | ✖ | ✖ |
| Cualquier otra herramienta o MCP | ✖ | ✖ | ✖ |

**Cada** llamada a una herramienta pasa por la función `decide()` dos veces:

1. En un **hook `PreToolUse`**, que se ejecuta antes de cualquier herramienta, incluidas las de lectura (que en Claude Code no piden permiso y por eso nunca pasarían por `canUseTool`).
2. En **`canUseTool`**, para las llamadas que sí piden permiso (escrituras y comandos).

Cuando niega algo, el agente recibe el motivo (por ejemplo, *"…belongs to another component. You may only write under backend/"* o *"…matches readDenyPaths (secrets)"*) y el log registra un evento `guard` con `denied <herramienta>`.

## Qué puede leer un agente

1. **Solo sus carpetas legibles:** su worktree (todo, no solo la carpeta de su componente) y los worktrees de integración de los otros repos del ticket. Un `Read` de `/etc/hosts`, de `~/.ssh/id_rsa` o de un archivo fuera de esas carpetas se niega. Un `Grep` o un `Glob` sobre una carpeta de fuera también.
2. **Nunca lo que coincida con `readDenyPaths`**, aunque esté dentro: por defecto `.env`, `.env.*`, claves (`*.pem`, `*.key`, `*.pfx`, `id_rsa*`), credenciales de herramientas (`.npmrc`, `.netrc`), `secrets.json`, `appsettings.*.local.json`, `local.settings.json` y las carpetas `~/.ssh`, `~/.aws`, `~/.azure`, `~/.kube`. La lista completa está en [03-configuracion.md](03-configuracion.md#readdenypaths--string-por-defecto-una-lista-de-archivos-de-secretos). Tampoco se pueden **editar**.

Ten en cuenta que los worktrees son checkouts limpios: los archivos ignorados por git (como un `.env` local) **no existen** en ellos. La lista protege sobre todo de secretos commiteados y de rutas absolutas fuera del espacio de trabajo.

## Defensa en profundidad: revisiones después de cada paso

`canUseTool` controla las herramientas de edición, pero un comando permitido podría modificar archivos de forma indirecta (por ejemplo, un script de build que genera código). Por eso, después de **cada** paso que edita, el código revisa git:

1. **Tests bloqueados:** cualquier cambio en `lockedPaths` respecto al testsRef se revierte (`guard: reverted locked files`).
2. **Fuera del componente:** cualquier archivo cambiado fuera de la carpeta del componente se revierte (`guard: reverted files outside the component`).
3. **No declarados:** archivos cambiados que el agente no listó en `changedFiles` se revierten (`guard: reverted undeclared files`) o se marcan (`committing undeclared files`), según `undeclaredFiles`.

Después del autor de tests, todo lo que no sea un test se revierte (`guard: reverted non-test files`).

## Allowlist de comandos

Un comando se acepta solo si empieza por un prefijo permitido y **no contiene** `;`, `&`, `|`, `` ` ``, `<`, `>`, `$(`, `${` ni saltos de línea. Reglas completas en [03-configuracion.md](03-configuracion.md#allowedcommands--string-por-defecto-).

Los comandos del mapa de aceptación los propone un agente pero los ejecuta el código, así que pasan por la **misma** allowlist antes de aceptarse.

Lo que la allowlist **no** puede saber es qué hace por dentro un comando permitido. `npm test` ejecuta lo que diga tu `package.json`; `dotnet test` ejecuta el código de tus tests, incluido el que escribió un agente. Elige los prefijos en consecuencia.

## Lo que hector-flow NO protege

Sé consciente de estos límites antes de usarlo en un repo con acceso a sistemas reales:

| Riesgo | Por qué | Mitigación recomendada |
|---|---|---|
| **El código de los tests y de la aplicación se ejecuta en tu máquina** | Un test escrito por un agente corre con tus permisos cuando se ejecuta `testCommand`. | El sandbox ([17-sandbox.md](17-sandbox.md)): contenedor, sin tu `$HOME`, red solo por allowlist. |
| **Secretos en el entorno** | Los comandos de build/test ya no reciben variables con aspecto de credencial (`commandEnv.scrubSecrets`), pero sí el resto de tu entorno, y los procesos de los agentes reciben las claves de sus modelos. | El sandbox, con claves dedicadas y con límite. No dejes secretos en `.env` dentro de los repos. |
| **`Grep` sobre una carpeta** | Si un archivo de secretos está **commiteado**, un `Grep` sobre la carpeta que lo contiene puede mostrar líneas suyas: la comprobación es sobre la ruta que se busca, no sobre cada resultado. | No commitees secretos. Usa Key Vault, variables de entorno o user-secrets. |
| **Comandos permitidos** | `readDenyPaths` controla las herramientas de lectura del agente, no lo que hace por dentro un comando permitido (un test puede abrir cualquier archivo). | Contenedor, y tests que no lean secretos. |
| **Red desde los comandos** | Un comando permitido (o un test) puede abrir conexiones. | El sandbox: solo los dominios de `sandbox/allowed-domains.txt`. |
| **`notifyCommand`** | Lo escribes tú y no pasa por la allowlist. | Mantenlo simple. |
| **Servidores MCP externos** | Corren con tus permisos (stdio) o reciben lo que el agente les envía (http). `readDenyPaths` no se aplica dentro de ellos. | Asígnalos solo a los pasos que los necesitan (`mcpAccess`); prefiere servidores de solo lectura. |
| **Memoria** | Los agentes escriben en ella texto libre que otros tickets leerán. | Solo se valida lo de ejecuciones `completed`; revísala con `memory list` y borra lo que no sea cierto. |
| **Las instrucciones de `CLAUDE.md` y `.claude/`** | Con `loadProjectSettings: true` los agentes las siguen. | Revisa esos archivos, o desactiva la opción. |
| **Pasos en Codex** | Sin gancho por herramienta: la lista de secretos y la de comandos no se aplican. Codex lee `AGENTS.md`. | Sin secretos legibles por el usuario del proceso; contenedor; o deja en Codex solo pasos que no lo necesiten. |
| **Pasos en Copilot** | Copilot lee `.github/copilot-instructions.md` y `AGENTS.md`; el código va a los modelos de tu suscripción de Copilot, bajo la política de tu organización. Una solicitud que la política marca para aprobación humana se rechaza. | Revisa esos archivos y la política de Copilot de tu organización. |
| **Pasos en OpenCode** | OpenCode lee su `opencode.json` y `AGENTS.md`; el modelo lo da un proveedor externo. | Revisa esos archivos y a qué proveedor envías el código. |

En resumen: los permisos de hector-flow evitan que un agente haga cosas **fuera de su tarea** (tocar otro componente, debilitar tests, ejecutar comandos arbitrarios), pero no son un sandbox del sistema operativo. Para eso está [el sandbox](17-sandbox.md).

## Tus repositorios

- Nunca se modifica tu checkout. Todo ocurre en worktrees bajo `workspacesDir`.
- hector-flow **no hace push** ni abre PRs. Las ramas quedan en tus repos locales.
- **`approve` y el modo `auto` sí modifican tus checkouts:** fusionan `hector/<ID>` en la rama base. Antes exigen que cada checkout esté en esa rama y limpio; si la fusión o la verificación posterior fallan, devuelven cada repo al commit exacto en que estaba (`git reset --hard`, seguro porque no había cambios sin commitear).
- Los commits se hacen con `--no-verify`, así que los hooks de pre-commit no corren dentro del flujo. Si tus hooks hacen comprobaciones importantes, inclúyelas en `buildCommand` o `lintCommand`.
- `clean` borra ramas `hector/<ID>` y `hector-tasks/<ID>/*` sin preguntar. El trabajo no fusionado ni subido se pierde.

## Costos

- `maxBudgetUsdPerAgent` y `maxTurnsPerAgent` limitan **cada** agente.
- `repairAttempts`, `sameWorkerRetries`, `maxQuestions` y `reviewRounds` limitan cuántos agentes se lanzan.
- Una ejecución típica usa `2 + componentes involucrados + tareas + reparaciones + revisiones + preguntas + 1` agentes.
- Si una tarea falla con otras en curso, el flujo no lanza tareas nuevas pero espera a que terminen las que corren (no las cancela).
