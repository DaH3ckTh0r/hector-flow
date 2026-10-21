# 6. Seguridad y permisos

hector-flow deja que agentes de IA editen código y ejecuten comandos sin pedir permiso en cada paso. Para que eso sea aceptable, cada agente trabaja con permisos definidos de antemano, y el código revisa lo que pasó después de cada paso. Este documento explica qué está protegido, cómo, y qué **no** lo está.

## El modelo en una tabla

| Capa | Qué controla | Dónde |
|---|---|---|
| **Modo del paso** | `readonly`, `edit` o `tests`: si el agente puede escribir y dónde | `canUseTool` en `src/runner/claude-runner.ts` |
| **Aislamiento por componente** | Un implementador solo escribe en la carpeta de su componente | `canUseTool` + `commitExact` |
| **Tests bloqueados** | Nadie salvo el autor de tests escribe en `lockedPaths` | `canUseTool` + `enforceLocks` |
| **Allowlist de comandos** | Qué puede ejecutar un agente con Bash | `isCommandAllowed` en `src/guards.ts` |
| **Herramientas** | Sin web, sin MCP externo, sin subagentes | `disallowedTools` + `canUseTool` |
| **Commit exacto** | Solo entra en git lo declarado y dentro del componente | `commitExact` |
| **Worktrees** | Tus checkouts nunca se modifican | `src/tools/git.ts` |
| **Topes** | Turnos y gasto por agente; reparaciones y preguntas por ejecución | `policy` |

## Permisos por modo

| Herramienta | `readonly` | `edit` (implementador) | `tests` (autor de tests) |
|---|---|---|---|
| `Read`, `Glob`, `Grep` | ✔ | ✔ | ✔ |
| `Write`, `Edit`, `MultiEdit`, `NotebookEdit` | ✖ | Solo en su componente y fuera de rutas bloqueadas | Solo en los `lockedPaths` de su componente |
| `Bash` | ✖ | Solo `allowedCommands` | Solo `allowedCommands` |
| `ask` (MCP propio) | — | ✔ | — |
| `WebFetch`, `WebSearch`, `Task`/`Agent` | ✖ | ✖ | ✖ |
| Cualquier otra herramienta o MCP | ✖ | ✖ | ✖ |

Las herramientas de lectura están preaprobadas. **Toda** escritura y todo comando pasan por la función `canUseTool`, que aplica estas reglas. Cuando niega algo, el agente recibe el motivo (por ejemplo, *"…belongs to another component. You may only write under backend/"*) y el log registra un evento `guard` con `denied <herramienta>`.

Además, la lectura no está restringida a la carpeta del componente: un agente puede leer todo su worktree y, por `additionalDirectories`, los worktrees de integración de los otros repos del ticket.

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
| **El código de los tests y de la aplicación se ejecuta en tu máquina** | Un test escrito por un agente corre con tus permisos cuando se ejecuta `testCommand`. | Ejecuta hector-flow en un contenedor o una VM, con un usuario sin privilegios. |
| **Secretos en el entorno** | Los comandos heredan las variables de entorno de la terminal donde lanzas hector-flow. | Lanza hector-flow en un entorno sin credenciales de producción. No dejes secretos en `.env` dentro de los repos. |
| **Lectura amplia** | Un agente puede leer cualquier archivo de su worktree y de los repos del ticket. | No guardes secretos en los repos. |
| **Red desde los comandos** | Un comando permitido (o un test) puede abrir conexiones. | Contenedor con red restringida si te preocupa. |
| **`notifyCommand`** | Lo escribes tú y no pasa por la allowlist. | Mantenlo simple. |
| **Las instrucciones de `CLAUDE.md` y `.claude/`** | Con `loadProjectSettings: true` los agentes las siguen. | Revisa esos archivos, o desactiva la opción. |

En resumen: los permisos de hector-flow evitan que un agente haga cosas **fuera de su tarea** (tocar otro componente, debilitar tests, ejecutar comandos arbitrarios), pero no son un sandbox del sistema operativo.

## Tus repositorios

- Nunca se modifica tu checkout. Todo ocurre en worktrees bajo `workspacesDir`.
- hector-flow **no hace push** ni abre PRs. Las ramas quedan en tus repos locales.
- Los commits se hacen con `--no-verify`, así que los hooks de pre-commit no corren dentro del flujo. Si tus hooks hacen comprobaciones importantes, inclúyelas en `buildCommand` o `lintCommand`.
- `clean` borra ramas `hector/<ID>` y `hector-tasks/<ID>/*` sin preguntar. El trabajo no fusionado ni subido se pierde.

## Costos

- `maxBudgetUsdPerAgent` y `maxTurnsPerAgent` limitan **cada** agente.
- `repairAttempts`, `sameWorkerRetries`, `maxQuestions` y `reviewRounds` limitan cuántos agentes se lanzan.
- Una ejecución típica usa `2 + componentes involucrados + tareas + reparaciones + revisiones + preguntas + 1` agentes.
- Si una tarea falla con otras en curso, el flujo no lanza tareas nuevas pero espera a que terminen las que corren (no las cancela).
