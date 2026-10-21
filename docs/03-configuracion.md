# 3. Referencia de configuración

La configuración vive en `hector-flow.config.json`, en la raíz del **repo principal** (el que pasas con `--repo`). Puedes usar otro archivo con `--config <ruta>`.

hector-flow valida el archivo al arrancar. Si algo está mal, muestra cada error con su ruta, por ejemplo:

```
Invalid config at /Users/tu/mi-repo/hector-flow.config.json:
✖ Invalid input: expected string, received undefined
  → at components.web.testCommand
```

## Estructura general

```jsonc
{
  // Opción A: varios componentes
  "components": { "<nombre>": { /* componente */ } },

  // Opción B: un solo componente (atajo)
  "testCommand": "npm test",
  "buildCommand": "npm run build",
  "lintCommand": "npm run lint",

  // Valores por defecto para todos los componentes
  "lockedPaths": ["test/**", "tests/**", "**/*.test.*", "**/*.spec.*"],
  "allowedCommands": [],

  // Agentes
  "models": { "<rol>": "<modelo>" },
  "efforts": { "<rol>": "<esfuerzo>" },
  "skillDirs": [],
  "claudeSkills": { "<rol>": ["<skill>"] },
  "pluginDirs": [],
  "review": { "judges": [{ "name": "reviewer" }] },

  // Seguridad
  "readDenyPaths": ["**/.env", "…"],

  // Límites y comportamiento
  "policy": { /* ver abajo */ },

  // Varios
  "notifyCommand": "…",
  "workspacesDir": ".hector-workspaces",
  "loadProjectSettings": true
}
```

Tienes que definir **o bien** `components` con al menos un componente, **o bien** un `testCommand` de nivel superior. Si no, la validación falla con `Define either 'components' (one or more) or a top-level 'testCommand'.`

---

## Componentes

### `components` — objeto, opcional

Cada clave es el **nombre** del componente y cada valor su configuración. El nombre debe empezar con una letra minúscula y contener solo minúsculas, dígitos y guiones (`backend`, `web-admin`, `func-2`). El planificador usa estos nombres para asignar tareas, así que elígelos claros.

Si omites `components`, se crea un único componente llamado `main` en la raíz del repo principal, con los comandos de nivel superior.

#### Campos de cada componente

| Campo | Tipo | Por defecto | Descripción |
|---|---|---|---|
| `description` | string | — | Qué es el componente. Lo leen `enrich` y `plan` para decidir qué tarea va a dónde. Escribe stack, carpetas clave y responsabilidades. |
| `repo` | string | `"."` | Ruta al repositorio, **relativa al repo principal**. `"."` es el propio repo principal; `"../web"` es un repo hermano. Se resuelve a la raíz del repo git que contiene esa ruta. |
| `path` | string | `"."` | Carpeta del componente dentro del repo, con `/`. No puede salir del repo (`..` al principio no está permitido). Los workers del componente **solo pueden escribir aquí**, y los comandos se ejecutan desde aquí. |
| `testCommand` | string | **obligatorio** | Comando de tests. Debe pasar para que el ticket se dé por terminado. Se ejecuta desde `path`. |
| `buildCommand` | string | — | Compilación o verificación de tipos. Se usa como compuerta de cada tarea y antes de los tests en la estabilización. |
| `lintCommand` | string | — | Linter. Se ejecuta en la compuerta de cada tarea y después de los tests en la estabilización. |
| `lockedPaths` | string[] | los de nivel superior | Globs de los tests de este componente, **relativos a `path`**. Pueden salir de la carpeta con `../` (útil para proyectos de tests .NET aparte). |
| `allowedCommands` | string[] | los de nivel superior | Prefijos de comandos que los agentes de este componente pueden ejecutar. |

**Monorepo** (varios componentes en un repo):

```json
"components": {
  "backend":  { "path": "services/api", "testCommand": "dotnet test", "lockedPaths": ["../../tests/Api.Tests/**"] },
  "frontend": { "path": "apps/web",     "testCommand": "npm test",    "lockedPaths": ["src/**/*.test.tsx"] }
}
```

**Repos separados**:

```json
"components": {
  "backend":    { "repo": ".",               "testCommand": "dotnet test" },
  "middleware": { "repo": "../integrations", "testCommand": "dotnet test" },
  "frontend":   { "repo": "../web",          "testCommand": "npm test" }
}
```

**Mixto:** puedes combinar ambos. Dos componentes con el mismo `repo` comparten rama de integración y se aíslan por `path`.

Restricción: dos repos distintos no pueden tener el mismo nombre de carpeta (por ejemplo `/a/api` y `/b/api`), porque sus worktrees chocarían. Verás `Two different repositories are both named "api"`.

### Atajo de un componente: `testCommand`, `buildCommand`, `lintCommand`

Equivalen a un componente `main` con `repo: "."` y `path: "."`. Si defines `components`, estos campos se ignoran.

### `lockedPaths` — string[], por defecto `["test/**", "tests/**", "**/*.test.*", "**/*.spec.*"]`

Valor por defecto para los componentes que no definen el suyo. En el atajo de un componente, son relativos a la raíz del repo.

**Qué significa "bloqueado":**

- El autor de tests de un componente **solo** puede escribir en los `lockedPaths` de ese componente.
- Ningún implementador puede escribir en los `lockedPaths` de **ningún** componente del mismo repo. Si lo consigue por shell, el cambio se revierte tras su paso.
- Los tests que **ya existen** en esas rutas también quedan bloqueados. El diseño del ticket tiene que ser compatible con ellos, o debe pedir explícitamente que se actualicen (en ese caso los actualiza el autor de tests).

**Sintaxis de los globs:**

| Patrón | Coincide con |
|---|---|
| `*` | Cualquier texto sin `/` (`*.test.js` → `a.test.js`) |
| `**` | Cualquier texto, incluidas carpetas (`test/**` → `test/a/b.js`) |
| `**/` | Cero o más carpetas (`**/*.spec.ts` → `x.spec.ts` y `a/b/x.spec.ts`) |
| `?` | Un carácter sin `/` |
| `{a,b}` | Alternativas (`**/*.{test,spec}.ts`) |

Las rutas usan siempre `/`, también en Windows.

### `allowedCommands` — string[], por defecto `[]`

Prefijos de los comandos que los agentes pueden ejecutar con Bash. Valor por defecto para los componentes que no definen el suyo.

**Reglas de coincidencia** (`src/guards.ts`):

1. El comando es **exactamente** un prefijo, o empieza por el prefijo **seguido de un espacio**. `npm test` permite `npm test` y `npm test -- --watch=false`, pero no `npm testx`.
2. Un prefijo que termina en `/` permite archivos dentro de esa carpeta: `node qa/` permite `node qa/check.js`, pero no `node qa/../secreto.js`.
3. **Siempre** se rechazan: `;`, `&` (incluido `&&`), `|`, `` ` ``, `<`, `>`, `$(`, `${` y saltos de línea. Un agente ejecuta un comando a la vez, sin encadenar ni redirigir.

Los comandos del **mapa de aceptación** (los que propone el autor de tests) deben cumplir las mismas reglas con el `allowedCommands` de su componente; si no, el flujo termina en `failed` antes de implementar nada.

Recomendación: incluye exactamente lo que un desarrollador ejecuta para compilar y probar, más una forma de ejecutar tests concretos (por ejemplo `dotnet test`, que permite `dotnet test --filter …`, o `node --test`). No incluyas `git`, gestores de paquetes con `install`, ni herramientas de red.

Si el `testCommand` de un componente no está permitido, `check` muestra un aviso: los workers no podrán ejecutar los tests.

---

## Agentes

### Roles

| Rol | Paso | Qué hace | Puede escribir |
|---|---|---|---|
| `enrich` | Investigación | Lee el ticket y todos los componentes; reporta archivos relevantes, convenciones y contratos. | No |
| `plan` | Investigación | Divide el ticket en tareas, una por componente, con dependencias. | No |
| `testAuthor` | Investigación | Escribe los tests bloqueados y el mapa de aceptación de un componente. | Solo sus tests |
| `coder` | Implementación y reparaciones | Implementa una tarea, corrige defectos, resuelve conflictos. | Solo su componente, nunca tests |
| `diagnose` | Verificación | Explica por qué falló un check y de quién es la culpa. | No |
| `review` | Verificación | Revisa el diff de todos los repos. | No |
| `qaPlan` | Verificación | Escribe el plan de pruebas manuales. | No |
| `lead` | Durante la implementación | Responde las preguntas de los workers (`ask`). | No |
| `distill` | Después, a mano | Convierte tus correcciones en pautas. | No |

Las instrucciones de cada rol viven en su **skill** (`skills/<rol>/SKILL.md`), que puedes personalizar por repo. Ver [13-skills.md](13-skills.md).

### `models` — objeto rol → modelo, por defecto `{}`

Modelo de cada rol. Acepta los alias de Claude Code (`opus`, `sonnet`, `haiku`) o un ID completo (por ejemplo `claude-sonnet-5-5`). Los roles sin valor usan el modelo por defecto de tu Claude Code.

Punto de partida razonable, que conviene ajustar por prueba y error (la implementación es donde se va la mayor parte de los tokens):

```json
"models": {
  "enrich": "sonnet", "plan": "opus", "testAuthor": "sonnet", "coder": "sonnet",
  "diagnose": "opus", "review": "opus", "qaPlan": "haiku", "lead": "sonnet", "distill": "opus"
}
```

### `efforts` — objeto rol → esfuerzo, por defecto `{}`

Esfuerzo de razonamiento por rol: `low`, `medium`, `high`, `xhigh` o `max`. Si el modelo no admite un nivel, Claude Code lo baja sin avisar. Más esfuerzo suele mejorar la planificación y el diagnóstico a cambio de tiempo y costo.

---

**Precedencia del modelo y el esfuerzo de un paso:** `models.<rol>` / `efforts.<rol>` de la config → `model` / `effort` del front-matter de la skill del paso → valor por defecto de Claude Code. En la revisión, el `model` y `effort` de cada juez van por delante de todo.

### `skillDirs` — string[], por defecto `[]`

Carpetas adicionales con skills de pasos (`<carpeta>/<rol>/SKILL.md`), relativas al repo principal. Se buscan en orden, antes de `<repo>/.hector/skills` y de las skills de serie. Guía completa: [13-skills.md](13-skills.md).

### `claudeSkills` — objeto rol → string[], por defecto `{}`

Skills de Claude Code que puede usar cada paso, por nombre (o `plugin:skill`). Se combinan con la lista `skills` del front-matter de la skill del paso. Un paso sin skills recibe una lista vacía: no ve ninguna.

```json
"claudeSkills": { "testAuthor": ["xunit-tests"], "review": ["security-review"] }
```

### `pluginDirs` — string[], por defecto `[]`

Carpetas de plugins locales de Claude Code, relativas al repo principal. Se cargan sus skills; sus servidores MCP no.

### `review` — revisión por varios jueces

```json
"review": {
  "judges": [
    { "name": "security",   "model": "opus",   "effort": "high", "focus": "Focus on security, authentication and data exposure." },
    { "name": "maintainer", "model": "sonnet" }
  ]
}
```

| Campo del juez | Tipo | Descripción |
|---|---|---|
| `name` | texto (minúsculas, dígitos, guiones) | Nombre del juez. Aparece en los hallazgos y en los artefactos. |
| `model` | texto, opcional | Modelo de este juez. Por defecto, el del rol `review`. Usar modelos distintos da opiniones más independientes. |
| `effort` | esfuerzo, opcional | Esfuerzo de este juez. |
| `focus` | texto, opcional | Instrucciones adicionales solo para este juez, enviadas en un bloque `<review_focus>`. |

Por defecto hay un único juez (`reviewer`) y la revisión funciona como siempre. Con dos o más:

- todos revisan **el mismo diff, en paralelo y sin ver a los demás**;
- se aprueba solo si **todos** aprueban y ningún hallazgo es `blocker`;
- los hallazgos iguales (mismo componente, archivo y descripción, sin distinguir mayúsculas ni espacios) se fusionan con la **severidad más alta**, y cada hallazgo indica qué jueces lo levantaron: `[security, maintainer] …`;
- los hallazgos fusionados se enrutan a los implementadores como siempre.

Más en [05-flujo.md](05-flujo.md#7-review--revisión).

### `readDenyPaths` — string[], por defecto una lista de archivos de secretos

Rutas que ningún agente puede leer ni editar, aunque estén dentro de su espacio de trabajo. Se suman a la regla de base: **un agente solo puede leer su worktree y los worktrees de integración de los otros repos del ticket**.

- Los globs que empiezan por `~/` o `/` son absolutos.
- Los demás se comparan con la ruta relativa a la carpeta legible que la contiene (`**/.env` es cualquier `.env` en cualquier repo del ticket).

Valor por defecto:

```json
["**/.env", "**/.env.*", "**/*.pem", "**/*.key", "**/*.pfx", "**/*.p12", "**/id_rsa*", "**/id_ed25519*",
 "**/.npmrc", "**/.pypirc", "**/.netrc", "**/secrets.json", "**/*.secrets.json",
 "**/appsettings.*.local.json", "**/local.settings.json",
 "~/.ssh/**", "~/.aws/**", "~/.azure/**", "~/.config/gcloud/**", "~/.kube/**", "~/.docker/config.json"]
```

Si defines `readDenyPaths`, **reemplaza** la lista completa: copia la de arriba y agrega lo tuyo. `[]` desactiva la lista (la restricción a las carpetas legibles sigue). Detalles y límites en [06-seguridad.md](06-seguridad.md).

## `policy` — límites y comportamiento

| Campo | Tipo | Por defecto | Descripción |
|---|---|---|---|
| `maxParallel` | entero ≥ 1 | `3` | Implementadores trabajando a la vez, cada uno en su worktree. |
| `repairAttempts` | entero ≥ 0 | `3` | Reparaciones automáticas **en total** por ejecución, sumando todas las rutas (estabilización, revisión, QA). Al agotarse: `needs_human`. |
| `sameWorkerRetries` | entero ≥ 0 | `2` | Veces que se devuelve trabajo al **mismo** worker (retomando su sesión) antes de pasar a un implementador nuevo. Cuenta compilación fallida en la compuerta, conflictos, defectos de verificación y hallazgos de revisión. |
| `maxQuestions` | entero ≥ 0 | `10` | Preguntas `ask` por ejecución. Después, los workers deciden solos. |
| `undeclaredFiles` | `"revert"` o `"commit"` | `"revert"` | Qué hacer con archivos que un worker cambió sin declararlos en `changedFiles`. `revert` los descarta; `commit` los incluye y los marca en el ledger. |
| `reviewRounds` | entero ≥ 0 | `1` | Rondas de corrección tras una revisión con hallazgos `blocker` o `major`. Con `0`, se revisa una vez y no se corrige. |
| `maxTurnsPerAgent` | entero ≥ 1 | `40` | Turnos máximos de cada agente. Al agotarse, el paso falla (`error_max_turns`). |
| `maxBudgetUsdPerAgent` | número > 0 | sin límite | Gasto máximo estimado de **cada** agente, en USD. Al agotarse, el paso falla (`error_max_budget_usd`). |

**Cómo se combinan los límites de reparación** (ejemplo con `repairAttempts: 4`, `sameWorkerRetries: 2`):

1. Falla la estabilización del backend → diagnóstico → el defecto vuelve al worker T1 (reintento 1/2 de T1, reparación 1/4).
2. Vuelve a fallar → al worker T1 otra vez (2/2, reparación 2/4).
3. Vuelve a fallar → T1 ya no tiene reintentos: va a un implementador nuevo en la rama de integración (reparación 3/4).
4. Vuelve a fallar → implementador nuevo (reparación 4/4).
5. Vuelve a fallar → `needs_human`: `still failing after 4 repair attempts`.

---

## Varios

### `notifyCommand` — string, opcional

Comando de shell que se ejecuta al terminar, sea cual sea el estado. Recibe estas variables de entorno:

| Variable | Valor |
|---|---|
| `HECTOR_STATUS` | `completed`, `needs_human` o `failed` |
| `HECTOR_TICKET` | ID del ticket |
| `HECTOR_SUMMARY` | Ruta absoluta de `summary.json` |
| `HECTOR_OPEN_ASSUMPTIONS` | Número de supuestos abiertos |

Se ejecuta con un límite de 30 segundos, desde el directorio de trabajo del proceso: la carpeta de hector-flow si usas `npm run flow`, o la carpeta actual si usas el comando `hector-flow` instalado con `npm link`. No dependas de rutas relativas dentro del comando. Su resultado queda en el log como un evento `shell` del paso `notify`. **No** pasa por `allowedCommands`: lo escribes tú.

Ejemplos:

```jsonc
// Microsoft Teams o Slack (webhook entrante)
"notifyCommand": "curl -s -H 'Content-Type: application/json' -d \"{\\\"text\\\":\\\"$HECTOR_TICKET: $HECTOR_STATUS ($HECTOR_OPEN_ASSUMPTIONS supuestos)\\\"}\" \"$TEAMS_WEBHOOK_URL\""

// Notificación de macOS
"notifyCommand": "osascript -e \"display notification \\\"$HECTOR_STATUS\\\" with title \\\"hector-flow $HECTOR_TICKET\\\"\""

// Linux
"notifyCommand": "notify-send \"hector-flow $HECTOR_TICKET\" \"$HECTOR_STATUS\""
```

### `workspacesDir` — string, por defecto `".hector-workspaces"`

Carpeta donde se crean worktrees, logs y lecciones, **relativa a la carpeta padre del repo principal**. Con el valor por defecto y el repo en `~/code/api`, todo queda en `~/code/.hector-workspaces`.

### `loadProjectSettings` — boolean, por defecto `true`

Si es `true`, cada agente carga la configuración de proyecto de Claude Code del repo donde trabaja: el `CLAUDE.md` y la carpeta `.claude/`. Es la forma recomendada de darle a los agentes tus convenciones. Ponlo en `false` si esos archivos contienen instrucciones que no quieres que sigan los agentes del flujo.

---

## Ejemplos completos

- `examples/hector-flow.config.json` — un solo repo .NET.
- `examples/multi-component.config.json` — API .NET en un monorepo con su proyecto de tests aparte, Azure Functions en otro repo y una SPA React en un tercero.
- `examples/tutorial/tienda-api/hector-flow.config.json` — la config del tutorial, dos repos Node.
