# 16. Runtimes: Claude, Codex y OpenCode

Cada paso del flujo lo ejecuta un **runtime**, el programa que recibe el prompt, usa herramientas en el worktree y devuelve el JSON del paso. Por defecto es Claude (Claude Agent SDK), pero cualquier paso, y cada juez de revisión, puede ejecutarse en:

| Runtime | Qué es | Paquete |
|---|---|---|
| `claude` | Claude Code como librería (Claude Agent SDK). Es el valor por defecto. | `@anthropic-ai/claude-agent-sdk` |
| `codex` | OpenAI Codex (`codex exec`), con su sandbox del sistema operativo. | `@openai/codex-sdk` (trae el binario `codex`) |
| `opencode` | OpenCode (`opencode serve`), con cualquier proveedor que soporte: Anthropic, OpenAI, OpenRouter, modelos locales… | `@opencode-ai/sdk` + el binario `opencode` en el PATH |

El flujo no cambia: el código sigue decidiendo el orden de los pasos, los commits, las verificaciones y los reintentos. Solo cambia quién razona dentro de un paso. Sirve para:

- **Revisión cruzada**: un juez en Claude y otro en Codex. Un modelo distinto no comparte los mismos puntos ciegos.
- **Costo**: pasos mecánicos (`qaPlan`, `enrich`) en un modelo barato vía OpenCode.
- **Preferencia o disponibilidad**: equipos que ya pagan Codex, o que usan modelos locales.

## Configuración

```json
"runtime": {
  "default": "claude",
  "steps": {
    "coder": { "use": "codex", "model": "gpt-5.5-codex", "effort": "high" },
    "qaPlan": "opencode"
  },
  "codex": { "model": "gpt-5.5-codex", "effort": "medium", "networkAccess": false },
  "opencode": { "model": "openrouter/qwen/qwen3-coder", "hostname": "127.0.0.1", "port": 0 }
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
| `runtime.steps.<rol>` | — | `"codex"`, `"opencode"` o `"claude"`, o un objeto `{ "use", "model"?, "effort"? }`. Roles: `enrich`, `plan`, `testAuthor`, `coder`, `diagnose`, `review`, `qaPlan`, `distill`, `lead`. |
| `runtime.codex.model` | default de Codex | Modelo de los pasos en Codex. |
| `runtime.codex.effort` | — | `low` … `max`; se pasa como `model_reasoning_effort`. |
| `runtime.codex.networkAccess` | `false` | Permite red a los comandos dentro del sandbox. |
| `runtime.codex.path` | binario incluido | Ruta a otro binario `codex`. |
| `runtime.opencode.model` | default de OpenCode | Siempre `"proveedor/modelo"` (`anthropic/claude-sonnet-4-5`, `openai/gpt-5.5`, `ollama/qwen3`…). |
| `runtime.opencode.hostname` | `127.0.0.1` | Donde escucha `opencode serve`. |
| `runtime.opencode.port` | `0` | `0` deja que el sistema elija un puerto libre, y permite varias ejecuciones a la vez. |
| `review.judges[].runtime` | el del paso `review` | Runtime de ese juez. Su `model` es un modelo de ese runtime. |

### Qué modelo y qué esfuerzo se usan

`models`, `efforts` y el front-matter de los skills (`model: opus`) nombran **modelos de Claude**. Por eso solo se aplican cuando el paso corre en Claude:

| Runtime del paso | Modelo (gana el primero que exista) | Esfuerzo |
|---|---|---|
| `claude` | juez → objeto en `runtime.steps` → `models.<rol>` → front-matter del skill | juez → objeto en `steps` → `efforts.<rol>` → front-matter |
| `codex` | juez → objeto en `runtime.steps` → `runtime.codex.model` | juez → objeto en `steps` → `runtime.codex.effort` → `efforts.<rol>` / front-matter |
| `opencode` | juez → objeto en `runtime.steps` → `runtime.opencode.model` | juez → objeto en `steps` (se envía como *variant* de OpenCode) |

En OpenCode el esfuerzo es la *variant* del modelo, y los nombres válidos dependen del modelo (`high`, `max`…). Por eso solo se envía cuando lo pones explícitamente para ese runtime.

El `model` de un objeto en `steps` solo vale para el runtime que nombra: `{ "use": "claude", "model": "opus" }` no afecta a un juez que corre en Codex.

## Qué se mantiene igual en todos los runtimes

- El **mismo skill** (`SKILL.md` + `RULES.md` + pautas) es la instrucción del paso.
- La **misma salida estructurada**: un JSON Schema generado del contrato zod, validado después con zod. Si no cumple, el paso falla igual que con Claude.
- Las herramientas del flujo, **`ask`, `memory_search` y `memory_save`**, llegan a Codex y OpenCode por un **puente MCP local** (ver abajo).
- Los **servidores MCP externos** que `mcpAccess` asigna al paso.
- **Retomar la sesión**: los defectos vuelven al mismo worker, que conserva su contexto (hilo de Codex, sesión de OpenCode).
- Las **verificaciones de git** después de cada paso: archivos de test bloqueados revertidos, archivos fuera del componente revertidos, archivos no declarados revertidos o señalados.
- El registro: `events.jsonl` marca con `"runtime"` los pasos que no corren en Claude, y la consola muestra `▶ implement-T1 [codex]`.

## Aislamiento: qué protege cada runtime

Esta es la diferencia importante. Claude y OpenCode piden permiso **antes** de cada herramienta, y el flujo responde con las mismas reglas (`decide()`, ver [06-seguridad.md](06-seguridad.md)). Codex no ofrece ese gancho: el aislamiento lo da su sandbox del sistema operativo.

| Protección | Claude | OpenCode | Codex |
|---|---|---|---|
| Modo solo lectura | ✔ regla | ✔ regla | ✔ sandbox `read-only` |
| Escribir solo en el componente | ✔ regla | ✔ regla | ✔ sandbox `workspace-write` en la carpeta del componente |
| El test author solo escribe tests | ✔ regla | ✔ regla | ✔ revertido por el flujo después del paso (el sandbox abarca el worktree) |
| Tests bloqueados intactos | ✔ regla + git | ✔ regla + git | ✔ git (revertidos después del paso) |
| Lista de secretos (`readDenyPaths`) | ✔ | ✔ | ✘ **no se aplica** |
| Raíces legibles | ✔ | ✔ | ✘ puede leer cualquier archivo que su usuario pueda leer |
| Lista de comandos (`allowedCommands`) | ✔ | ✔ | ✘ **no se aplica** (se le indica en el prompt) |
| Red | Herramientas web denegadas | `webfetch`/`websearch` rechazados | ✔ sin red en el sandbox, búsqueda web desactivada |
| Subagentes | Denegados | `task` rechazado | No disponible en `codex exec` |
| Costo en USD | ✔ | ✔ (lo informa OpenCode) | ✘ solo tokens (`costUsd` = 0) |

**Consecuencia práctica:** si un paso corre en Codex, no dejes secretos dentro de los repos ni en carpetas que el usuario del proceso pueda leer, y considera que puede ejecutar cualquier comando dentro de su carpeta (sin red). `check` lo advierte.

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
```

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
```

## Diferencias de comportamiento que conviene conocer

- **Prompt de sistema.** Codex no tiene opción de prompt de sistema. El flujo antepone el skill y añade una sección "Limits of this step" con la carpeta escribible, los tests bloqueados y los comandos permitidos.
- **Esquema estricto en Codex.** Las salidas estructuradas de OpenAI exigen que todos los campos sean obligatorios. El flujo convierte los opcionales en "puede ser `null`" y elimina los `null` antes de validar con zod.
- **Skills y plugins de Claude Code** (`claudeSkills`, `pluginDirs`) solo existen en Claude. En otros runtimes se ignoran.
- **`loadProjectSettings`, `maxTurnsPerAgent`, `maxBudgetUsdPerAgent`** solo aplican a Claude. Codex y OpenCode usan sus propios límites.
- **Archivos de proyecto.** Codex lee `AGENTS.md` y OpenCode lee su `opencode.json` y `AGENTS.md` del repo, igual que Claude lee `CLAUDE.md`. Tenlo en cuenta si contienen instrucciones que contradicen el flujo.
- **Sesiones retomadas.** Los hilos de Codex persisten en `~/.codex/sessions`. Las sesiones de OpenCode viven en el servidor de esa ejecución, suficiente para enviar defectos al mismo worker.

## Recetas

Ejemplo completo: `examples/runtimes.config.json`.

**Revisión cruzada Claude + Codex** (lo más útil para empezar):

```json
"review": { "judges": [
  { "name": "claude", "model": "opus" },
  { "name": "codex", "runtime": "codex", "model": "gpt-5.5" }
] }
```

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

Implementa `AgentRunner` ([11-arquitectura.md](11-arquitectura.md#agentrunner)) en `src/runner/`, agrega su nombre a `RuntimeNameSchema` en `config.ts` y su fábrica en `createRunner()` (`src/runtimes.ts`). Reutiliza `decisionContext()` + `decide()` si el runtime permite aprobar cada herramienta, y `ToolBridge` para exponer `ask` y la memoria. Las pruebas de `test/runtimes.ts` muestran cómo probarlo con un SDK simulado.
