# 16. Runtimes: Claude, Codex, OpenCode, GitHub Copilot y pi

Cada paso del flujo lo ejecuta un **runtime**, el programa que recibe el prompt, usa herramientas en el worktree y devuelve el JSON del paso. Por defecto es Claude (Claude Agent SDK), pero cualquier paso, y cada juez de revisión, puede ejecutarse en:

| Runtime | Qué es | Paquete |
|---|---|---|
| `claude` | Claude Code como librería (Claude Agent SDK). Es el valor por defecto. | `@anthropic-ai/claude-agent-sdk` |
| `codex` | OpenAI Codex (`codex exec`), con su sandbox del sistema operativo. | `@openai/codex-sdk` (trae el binario `codex`) |
| `opencode` | OpenCode (`opencode serve`), con cualquier proveedor que soporte: Anthropic, OpenAI, OpenRouter, modelos locales… | `@opencode-ai/sdk` + el binario `opencode` en el PATH |
| `copilot` | GitHub Copilot (el runtime de Copilot CLI, controlado por JSON-RPC), con los modelos de tu suscripción de Copilot: GPT, Claude, Gemini… | `@github/copilot-sdk` (trae el runtime) |
| `pi` | El agente de programación [pi](https://github.com/earendil-works/pi) (minimalista, muchos proveedores), dentro del mismo proceso | `@earendil-works/pi-coding-agent` |

El flujo no cambia: el código sigue decidiendo el orden de los pasos, los commits, las verificaciones y los reintentos. Solo cambia quién razona dentro de un paso. Sirve para:

- **Revisión cruzada**: un juez en Claude y otro en Codex. Un modelo distinto no comparte los mismos puntos ciegos.
- **Costo**: pasos mecánicos (`qaPlan`, `enrich`) en un modelo barato vía OpenCode.
- **Preferencia o disponibilidad**: equipos que ya pagan Codex o Copilot, o que usan modelos locales. Con Copilot, una sola suscripción da acceso a modelos de varios proveedores.

## Configuración

```json
"runtime": {
  "default": "claude",
  "steps": {
    "coder": { "use": "codex", "model": "gpt-5.5-codex", "effort": "high" },
    "qaPlan": "opencode",
    "enrich": { "use": "copilot", "model": "<id de un modelo de Copilot>" }
  },
  "codex": { "model": "gpt-5.5-codex", "effort": "medium", "networkAccess": false },
  "opencode": { "model": "openrouter/qwen/qwen3-coder", "hostname": "127.0.0.1", "port": 0 },
  "copilot": { "model": "<id de un modelo de Copilot>", "effort": "high", "timeoutMinutes": 30 }
},
"review": {
  "judges": [
    { "name": "claude", "model": "opus", "focus": "Seguridad y exposición de datos." },
    { "name": "codex", "runtime": "codex", "model": "gpt-5.5", "effort": "xhigh" }
  ]
}
```

| Campo | Por defecto | Descripción |
|---|---|---|
| `runtime.default` | `"claude"` | Runtime de los pasos que no aparecen en `steps`. |
| `runtime.steps.<rol>` | — | `"claude"`, `"codex"`, `"opencode"` o `"copilot"`, o un objeto `{ "use", "model"?, "effort"? }`. Roles: `enrich`, `plan`, `testAuthor`, `coder`, `diagnose`, `review`, `qaPlan`, `distill`, `lead`. |
| `runtime.codex.model` | default de Codex | Modelo de los pasos en Codex. |
| `runtime.codex.effort` | — | `low` … `max`; se pasa como `model_reasoning_effort`. |
| `runtime.codex.networkAccess` | `false` | Permite red a los comandos dentro del sandbox. |
| `runtime.codex.path` | binario incluido | Ruta a otro binario `codex`. |
| `runtime.opencode.model` | default de OpenCode | Siempre `"proveedor/modelo"` (`anthropic/claude-sonnet-4-5`, `openai/gpt-5.5`, `ollama/qwen3`…). |
| `runtime.opencode.hostname` | `127.0.0.1` | Donde escucha `opencode serve`. |
| `runtime.opencode.port` | `0` | `0` deja que el sistema elija un puerto libre, y permite varias ejecuciones a la vez. |
| `runtime.copilot.model` | default de Copilot | Un id de modelo de Copilot, no los alias `opus`/`sonnet` de Claude Code. `hector-flow models --repo <repo> copilot` lista los ids que tu cuenta puede usar. |
| `runtime.copilot.effort` | — | `low` … `max`; solo en modelos que lo admiten. |
| `runtime.copilot.tokenEnv` | — | Variable con un token de GitHub. Sin ella, Copilot usa su orden normal: `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`, la sesión de `copilot login` y `gh auth token`. |
| `runtime.copilot.timeoutMinutes` | `30` | Tiempo máximo de un paso. |
| `runtime.copilot.path` | runtime incluido | Otra instalación de Copilot CLI (`COPILOT_CLI_PATH`). |
| `runtime.pi.model` | el primero con credenciales | `"proveedor/modelo"` del catálogo de pi (`anthropic/claude-sonnet-5-5`, `openai/gpt-5.5`, `openrouter/…`). `hector-flow models --repo <repo> pi` lista los que tienen credenciales. |
| `runtime.pi.effort` | — | Nivel de razonamiento de pi: `low` … `max`. |
| `runtime.pi.agentDir` | `~/.pi/agent` | Carpeta de configuración de pi, de donde lee `auth.json` y `models.json`. |
| `review.judges[].runtime` | el del paso `review` | Runtime de ese juez. Su `model` es un modelo de ese runtime. |

### Qué modelo y qué esfuerzo se usan

`models`, `efforts` y el front-matter de los skills (`model: opus`) nombran **modelos de Claude**. Por eso solo se aplican cuando el paso corre en Claude:

| Runtime del paso | Modelo (gana el primero que exista) | Esfuerzo |
|---|---|---|
| `claude` | juez → objeto en `runtime.steps` → `models.<rol>` → front-matter del skill | juez → objeto en `steps` → `efforts.<rol>` → front-matter |
| `codex` | juez → objeto en `runtime.steps` → `runtime.codex.model` | juez → objeto en `steps` → `runtime.codex.effort` → `efforts.<rol>` / front-matter |
| `opencode` | juez → objeto en `runtime.steps` → `runtime.opencode.model` | juez → objeto en `steps` (se envía como *variant* de OpenCode) |
| `copilot` | juez → objeto en `runtime.steps` → `runtime.copilot.model` | juez → objeto en `steps` → `runtime.copilot.effort` → `efforts.<rol>` / front-matter |
| `pi` | juez → objeto en `runtime.steps` → `runtime.pi.model` | juez → objeto en `steps` → `runtime.pi.effort` → `efforts.<rol>` / front-matter |

En OpenCode el esfuerzo es la *variant* del modelo, y los nombres válidos dependen del modelo (`high`, `max`…). Por eso solo se envía cuando lo pones explícitamente para ese runtime.

El `model` de un objeto en `steps` solo vale para el runtime que nombra: `{ "use": "claude", "model": "opus" }` no afecta a un juez que corre en Codex.

## Qué se mantiene igual en todos los runtimes

- El **mismo skill** (`SKILL.md` + `RULES.md` + pautas) es la instrucción del paso.
- La **misma salida estructurada**: un JSON Schema generado del contrato zod, validado después con zod. Si no cumple, el paso falla igual que con Claude.
- Las herramientas del flujo, **`ask`, `memory_search` y `memory_save`**, llegan a Codex y OpenCode por un **puente MCP local** (ver abajo), y a Copilot y pi como herramientas propias de la sesión, dentro del mismo proceso.
- Los **servidores MCP externos** que `mcpAccess` asigna al paso (salvo en pi: ver abajo).
- **Retomar la sesión**: los defectos vuelven al mismo worker, que conserva su contexto (hilo de Codex, sesión de OpenCode, de Copilot o de pi).
- Las **verificaciones de git** después de cada paso: archivos de test bloqueados revertidos, archivos fuera del componente revertidos, archivos no declarados revertidos o señalados.
- El registro: `events.jsonl` marca con `"runtime"` los pasos que no corren en Claude, y la consola muestra `▶ implement-T1 [codex]`.

## Aislamiento: qué protege cada runtime

Esta es la diferencia importante. Claude, OpenCode, Copilot y pi pasan **cada** herramienta por el flujo antes de ejecutarla, y el flujo responde con las mismas reglas (`decide()`, ver [06-seguridad.md](06-seguridad.md)). Codex no ofrece ese gancho: el aislamiento lo da su sandbox del sistema operativo.

| Protección | Claude | OpenCode | Copilot | pi | Codex |
|---|---|---|---|---|---|
| Modo solo lectura | ✔ regla | ✔ regla | ✔ regla | ✔ sin herramientas de escritura ni shell + regla | ✔ sandbox `read-only` |
| Escribir solo en el componente | ✔ regla | ✔ regla | ✔ regla | ✔ regla | ✔ sandbox `workspace-write` en la carpeta del componente |
| El test author solo escribe tests | ✔ regla | ✔ regla | ✔ regla | ✔ regla | ✔ revertido por el flujo después del paso (el sandbox abarca el worktree) |
| Tests bloqueados intactos | ✔ regla + git | ✔ regla + git | ✔ regla + git | ✔ regla + git | ✔ git (revertidos después del paso) |
| Lista de secretos (`readDenyPaths`) | ✔ | ✔ | ✔ (gancho antes de cada lectura) | ✔ | ✘ **no se aplica** |
| Raíces legibles | ✔ | ✔ | ✔ | ✔ | ✘ puede leer cualquier archivo que su usuario pueda leer |
| Lista de comandos (`allowedCommands`) | ✔ | ✔ | ✔ | ✔ | ✘ **no se aplica** (se le indica en el prompt) |
| Red | Herramientas web denegadas | `webfetch`/`websearch` rechazados | `web_fetch`/`web_search` quitados; permisos `url` rechazados | pi no trae herramientas web; cualquier otra se rechaza | ✔ sin red en el sandbox, búsqueda web desactivada |
| Subagentes | Denegados | `task` rechazado | `task` y agentes quitados | pi no tiene subagentes | No disponible en `codex exec` |
| Extensiones y configuración del usuario o del repo | `CLAUDE.md`, `.claude/` (opcional) | `opencode.json` | instrucciones del repo | **no se cargan** (solo `AGENTS.md`/`CLAUDE.md`, opcional) | `AGENTS.md` |
| Tokens por llamada | ✔ por modelo | ✔ por modelo | ✔ por modelo | ✔ por modelo | ✔ (modelo configurado) |
| Costo en USD | ✔ | ✔ (lo informa OpenCode) | ✘ Copilot cobra *premium requests* (`costUsd` = 0) | ✔ (según el catálogo de pi) | ✘ solo tokens (`costUsd` = 0) |

**Consecuencia práctica:** si un paso corre en Codex, no dejes secretos dentro de los repos ni en carpetas que el usuario del proceso pueda leer, y considera que puede ejecutar cualquier comando dentro de su carpeta (sin red). `check` lo advierte. Lo más simple es ejecutar esos pasos en el [sandbox](17-sandbox.md), que no ve tu `$HOME` ni sale a Internet salvo por la lista de dominios.

### Cómo se responde a OpenCode

1. El flujo inicia **un** `opencode serve` por ejecución (al primer paso que lo necesita) y escucha su flujo de eventos.
2. Cada sesión se crea con la regla `* → ask`: toda herramienta pide permiso.
3. Cada evento `permission.asked` se traduce y se juzga con `decide()`:

| Permiso de OpenCode | Se juzga como |
|---|---|
| `read` | `Read` de cada archivo |
| `edit` | `Write` de cada archivo (modo, componente, tests bloqueados, secretos) |
| `glob`, `grep`, `list` | `Grep` sobre la carpeta |
| `external_directory` | lectura de esa carpeta |
| `bash` | `Bash` de cada subcomando (todos deben estar permitidos) |
| `todowrite`, `lsp` | permitido |
| `question` | rechazado: nadie está mirando; debe usar `ask` o decidir y anotar el supuesto |
| `task`, `webfetch`, `websearch`, `skill`, `doom_loop` | rechazado |
| `<servidor>_<herramienta>` (MCP) | permitido solo para los servidores de esa llamada |

4. La respuesta es `once` o `reject` con el motivo, que el agente lee y el flujo registra como `guard` en `events.jsonl`.

### Cómo se responde a Copilot

1. El flujo inicia **un** runtime de Copilot por ejecución, comprueba que hay sesión iniciada (si no, el paso falla de inmediato en vez de esperar el tiempo máximo) y abre una sesión por paso.
2. La sesión se crea sin las herramientas `web_fetch`, `web_search`, `task` (y demás de subagentes), `ask_user`, `exit_plan_mode` ni `skill`.
3. Cada solicitud de permiso se juzga con `decide()`:

| Solicitud de Copilot | Se juzga como |
|---|---|
| `read` (fuera de la carpeta de trabajo) | `Read` del archivo |
| `write` | `Write` de cada archivo afectado, incluidos todos los de un parche de varios archivos |
| `shell` | `Bash` del comando completo |
| `mcp` | permitido solo para los servidores que `mcpAccess` asigna al paso |
| `custom-tool` | permitido solo para `ask` y `memory_*` de ese paso |
| `url`, `memory` (la memoria propia de Copilot), `hook` y cualquier otro tipo | rechazado |
| cualquiera con `managedApprovalRequired` (política de tu organización) | rechazado: exige una persona y nadie está mirando |

4. Las lecturas dentro de la carpeta de trabajo **no piden permiso** en Copilot. Por eso un gancho `onPreToolUse` revisa `view`, `grep`, `glob` y similares antes de ejecutarlos: rechaza secretos y carpetas no legibles.
5. `ask`, `memory_search` y `memory_save` se registran como herramientas de la sesión, que corren dentro del proceso del flujo, sin puente.

### Cómo se controla pi

pi no pide permisos por sí mismo: ejecuta lo que el modelo pida. Pero toda llamada a una herramienta, propia o de una extensión, pasa antes por los manejadores `tool_call` de sus extensiones, que pueden **bloquearla**. El flujo:

1. Crea cada sesión de pi en memoria, con una única extensión propia (`hector-guard`) y **sin** cargar extensiones, skills, plantillas, temas ni ajustes de `~/.pi` ni del repo (`.pi/`): nada puede registrar herramientas o manejadores que se salten el control. Tampoco carga las extensiones de MCP, codemode ni tool search.
2. Ofrece solo las herramientas del modo: `read`, `grep`, `find`, `ls` en pasos de solo lectura; además `edit`, `write` y `bash` en los demás.
3. Juzga cada llamada con `decide()`:

| Herramienta de pi | Se juzga como |
|---|---|
| `read` | `Read` del archivo |
| `grep`, `find`, `ls` | `Grep` sobre la carpeta |
| `edit`, `write` | `Write` del archivo (modo, componente, tests bloqueados, secretos) |
| `bash`, `powershell` | `Bash` del comando (allowlist) |
| `ask`, `memory_*`, `submit_result` | permitido si el paso lo tiene |
| cualquier otra | rechazada |

4. Una llamada bloqueada le llega al modelo como error, con el motivo, y queda en `events.jsonl` como `guard`.

pi **no tiene salida estructurada**: el esquema del paso se convierte en los parámetros de una herramienta `submit_result`, que termina la ejecución. pi valida los argumentos contra el esquema, y el flujo los valida otra vez con zod.

Al retomar una sesión (defectos al mismo worker) se reutiliza la sesión de pi con su conversación, pero los permisos son los de **esa** llamada.

**Servidores MCP externos:** no se ofrecen en pasos de pi (su extensión de MCP no se carga, para que no pueda añadir herramientas fuera del control). Si un paso necesita uno, ejecútalo en otro runtime.

## El puente MCP

Claude ejecuta `ask` y `memory_*` dentro del mismo proceso. Codex y OpenCode son procesos aparte, así que el flujo levanta un pequeño servidor MCP HTTP en `127.0.0.1` (puerto aleatorio):

- Cada llamada a un agente registra **sus** herramientas bajo un token aleatorio y recibe su propia URL, `http://127.0.0.1:<puerto>/mcp/<token>`.
- Dos workers en paralelo nunca ven las herramientas del otro: sus `ask` responden con el contexto de su propia tarea.
- La URL deja de existir cuando el paso termina (responde 404).
- En Codex el servidor se llama `hector`. En OpenCode se llama `hector-<token>`, porque varias sesiones pueden compartir una carpeta, y el permiso solo se concede a la sesión dueña del token.

Los servidores externos se pasan a cada runtime en su formato: `command/args/env` y `url/http_headers` para Codex (los servidores **SSE no están soportados** por Codex y se omiten), `local/remote` para OpenCode (agregados por carpeta y quitados cuando el último paso que los usa termina).

## Instalación

```bash
# Codex: el SDK ya trae el binario. Inicia sesión una vez:
npx codex login            # o exporta OPENAI_API_KEY

# OpenCode: instala el binario y configura tus proveedores
npm i -g opencode-ai
opencode auth login

# GitHub Copilot: el SDK ya trae el runtime. Inicia sesión con la CLI…
npm i -g @github/copilot
copilot login
# …o usa un token: un fine-grained PAT con el permiso "Copilot Requests"
# (los PAT clásicos ghp_ no sirven), en COPILOT_GITHUB_TOKEN o en runtime.copilot.tokenEnv.
# Si ya usas la CLI de GitHub, `gh auth token` también vale.
```

```bash
# pi: viene como dependencia de hector-flow. Credenciales, una de dos:
npm i -g @earendil-works/pi-coding-agent && pi     # y dentro, /login (se guarda en ~/.pi/agent/auth.json)
export ANTHROPIC_API_KEY=…                          # o la variable de tu proveedor (OPENAI_API_KEY, OPENROUTER_API_KEY…)
npm run flow -- models --repo <repo> pi             # modelos con credenciales, como "proveedor/modelo"
```

Necesitas una suscripción de Copilot con acceso a Copilot CLI. Si tu organización lo gestiona, la política debe permitir Copilot CLI y los modelos que elijas.

Después:

```bash
npm run flow -- check --repo <repo>
```

`check` muestra qué runtime ejecuta cada paso y advierte o falla si algo falta:

```
✓ runtimes: enrich=claude plan=claude testAuthor=claude coder=codex diagnose=claude review=claude qaPlan=opencode distill=claude lead=claude
✓ codex: using the CLI bundled with @openai/codex-sdk
! codex steps: the read deny-list and the command allowlist are not enforced
✗ opencode is installed (on PATH)
✓ copilot: using COPILOT_GITHUB_TOKEN, GH_TOKEN, GITHUB_TOKEN, your `copilot login` session or `gh auth token`
✗ copilot is signed in
    Not authenticated. Run `copilot login` or set runtime.copilot.tokenEnv.
```

Para comprobar la sesión de Copilot, `check` inicia el runtime unos instantes y le pregunta si hay sesión iniciada. No llama a ningún modelo. Para pi, `check` comprueba que cada modelo de pi que nombra la config existe en su catálogo y que hay credenciales para su proveedor:

```
✔ pi has credentials for anthropic/claude-sonnet-5-5
✖ pi knows the model anthropic/no-such-model
    Use "provider/model". `hector-flow models --repo <repo> pi` lists them.
```

## Diferencias de comportamiento que conviene conocer

- **Prompt de sistema.** Codex no tiene opción de prompt de sistema. El flujo antepone el skill y añade una sección "Limits of this step" con la carpeta escribible, los tests bloqueados y los comandos permitidos.
- **Prompt de sistema en Copilot y pi.** El skill se añade al prompt de sistema del runtime, que conserva sus propias instrucciones de herramientas.
- **Esquema estricto en Codex y Copilot.** Las salidas estructuradas de OpenAI (y las de Copilot, en modo estricto) exigen que todos los campos sean obligatorios. El flujo convierte los opcionales en "puede ser `null`" y elimina los `null` antes de validar con zod.
- **Skills y plugins de Claude Code** (`claudeSkills`, `pluginDirs`) solo existen en Claude. En otros runtimes se ignoran.
- **`loadProjectSettings`, `maxTurnsPerAgent`, `maxBudgetUsdPerAgent`** solo aplican a Claude. Codex, OpenCode, Copilot y pi usan sus propios límites (en Copilot, además, `runtime.copilot.timeoutMinutes`).
- **Archivos de proyecto.** Codex lee `AGENTS.md` OpenCode lee su `opencode.json` y `AGENTS.md`, y Copilot lee `.github/copilot-instructions.md`, `AGENTS.md` y sus archivos de instrucciones del repo, y pi lee `AGENTS.md` y `CLAUDE.md` (solo si `loadProjectSettings` es `true`), igual que Claude lee `CLAUDE.md`. Tenlo en cuenta si contienen instrucciones que contradicen el flujo.
- **Sesiones retomadas.** Los hilos de Codex persisten en `~/.codex/sessions`. Las sesiones de Copilot persisten en `~/.copilot`. Las de OpenCode y pi viven en memoria durante esa ejecución, suficiente para enviar defectos al mismo worker.

## Recetas

Ejemplo completo: `examples/runtimes.config.json`.

**Revisión cruzada Claude + Codex** (lo más útil para empezar):

```json
"review": { "judges": [
  { "name": "claude", "model": "opus" },
  { "name": "codex", "runtime": "codex", "model": "gpt-5.5" }
] }
```

**Revisión con tres familias de modelos, todo con Copilot:**

```bash
npm run flow -- models --repo <repo> copilot
```

```
id                 premium×  efforts            name
<id-gpt>           1         low,medium,high    GPT …
<id-claude>        1         -                  Claude Sonnet …
<id-gemini>        0.33      -                  Gemini …
```

```json
"review": { "judges": [
  { "name": "gpt",    "runtime": "copilot", "model": "<id-gpt>" },
  { "name": "claude", "runtime": "copilot", "model": "<id-claude>" },
  { "name": "gemini", "runtime": "copilot", "model": "<id-gemini>" }
] }
```

Los modelos disponibles cambian con el tiempo y dependen de tu plan y de la política de tu organización; `models` muestra los de tu cuenta (los deshabilitados por política aparecen marcados). La columna `premium×` es el multiplicador de *premium requests* de cada modelo.

**Todo en OpenCode con un modelo local, salvo la revisión:**

```json
"runtime": {
  "default": "opencode",
  "steps": { "review": "claude" },
  "opencode": { "model": "ollama/qwen3-coder" }
}
```

**Codex implementa y Claude diagnostica:**

```json
"runtime": { "steps": { "coder": "codex", "testAuthor": "codex" } }
```

`diagnose` sigue en Claude, que ve los mismos worktrees con las reglas de lectura completas.

## Agregar otro runtime

Implementa `AgentRunner` ([11-arquitectura.md](11-arquitectura.md#agentrunner)) en `src/runner/`, agrega su nombre a `RuntimeNameSchema` en `config.ts` y su fábrica en `createRunner()` (`src/runtimes.ts`). Reutiliza `decisionContext()` + `decide()` si el runtime permite aprobar cada herramienta (como hacen `opencode-runner.ts`, `copilot-runner.ts` y `pi-runner.ts`), y `ToolBridge` para exponer `ask` y la memoria por MCP, o `ToolBridge.definitions()` + `call()` si el runtime acepta herramientas dentro del proceso. Las pruebas de `test/runtimes.ts` muestran cómo probarlo con un SDK simulado.
