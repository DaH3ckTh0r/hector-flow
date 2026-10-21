# 12. Referencia de la CLI

```
npm run flow -- <comando> [opciones]     # sin compilar, desde la carpeta de hector-flow
hector-flow <comando> [opciones]         # tras npm run build && npm link
```

Comandos: `check`, `run`, `distill`, `clean`, `skills`, `start`, `status`, `approve`, `reject`, `requeue`, `memory`.

Las rutas relativas de `--repo`, `--ticket` y `--config` se resuelven desde la carpeta **donde escribiste el comando**, también con `npm run flow` (que internamente cambia a la carpeta de hector-flow; se usa la variable `INIT_CWD` que npm define con la carpeta original). Las rutas con `~` las expande tu shell.

## Opciones comunes

| Opción | Descripción |
|---|---|
| `--repo <ruta>` | **Obligatoria.** Raíz del repo principal, la carpeta donde está `hector-flow.config.json`. Si pasas una subcarpeta, la config se busca en esa subcarpeta; en ese caso usa `--config`. |
| `--config <ruta>` | Archivo de configuración alternativo. Por defecto, `<repo>/hector-flow.config.json`. |
| `-h`, `--help` | Muestra la ayuda. |

## `check`

Verifica que todo está listo para ejecutar. **No llama al modelo.**

```bash
npm run flow -- check --repo <ruta> [--ticket <ticket.md>] [--no-commands]
```

| Opción | Descripción |
|---|---|
| `--ticket <ruta>` | Además, comprueba que el ticket se puede leer. |
| `--no-commands` | No ejecuta build/test/lint (útil si tardan mucho). |

Comprueba, en orden:

1. Que `--repo` está dentro de un repo git.
2. Que los componentes se resuelven (rutas, nombres de repo).
3. Que cada repo está limpio. Avisa (⚠, no falla) si quedan ramas `hector/*` o `hector-tasks/*`.
4. Que el `testCommand` de cada componente está permitido por su `allowedCommands` (⚠ si no).
5. Que `buildCommand`, `testCommand` y `lintCommand` de cada componente **pasan sobre el código actual**.
6. Qué skills de pasos están personalizadas, y sus avisos (⚠).
7. Que existen las carpetas de `pluginDirs`, y cuántos jueces revisan si hay más de uno.
8. Que el ticket se puede leer y tiene criterios.

Símbolos: `✔` correcto, `⚠` aviso, `✖` error. Termina con `Ready to run.` (código 0) o `N check(s) failed.` (código 1).

## `run`

Implementa un ticket.

```bash
npm run flow -- run --repo <ruta> --ticket <ticket.md>
```

| Opción | Descripción |
|---|---|
| `--ticket <ruta>` | **Obligatoria.** El ticket en markdown. Formato: [04-tickets.md](04-tickets.md). |

Muestra el progreso en consola y termina con un resumen:

```
status   completed | needs_human | failed
repo     <nombre>: hector/<ID> → <worktree>       (una línea por repo modificado)
tasks    <n> (max <n> in parallel)
repairs  <n>   review rounds <n>   questions <n>
cost     $<estimado>   time <segundos>s
log      <carpeta de la ejecución>

<motivo, si no es completed>

Assumptions the workers made without an authoritative answer — check these:   (si las hay)
- (worker T2) ¿…?
  → …
```

Códigos de salida: `0` completed, `3` needs_human, `1` failed. Qué hace paso a paso: [05-flujo.md](05-flujo.md).

## `distill`

Convierte tus correcciones manuales en pautas para el paso que causó cada error. **Llama al modelo una vez.**

```bash
npm run flow -- distill --repo <ruta> --ticket-id <ID>
```

| Opción | Descripción |
|---|---|
| `--ticket-id <ID>` | **Obligatoria.** Usa la ejecución más reciente de ese ticket. |

Salidas posibles:

```
1 new guideline(s):
- [coder] …
```

```
No human changes after the flow's last commit: nothing to learn.
```

```
No runs found for AB-123 in <workspaces>/_runs
```

Detalles: [08-aprendizaje.md](08-aprendizaje.md).

## `clean`

Elimina los worktrees y ramas de un ticket en **todos** los repos de los componentes. **No llama al modelo.**

```bash
npm run flow -- clean --repo <ruta> --ticket-id <ID>
```

| Opción | Descripción |
|---|---|
| `--ticket-id <ID>` | **Obligatoria.** |

Borra:

- los worktrees cuya rama es `hector/<ID>` o `hector-tasks/<ID>/*`,
- esas ramas,
- la carpeta `<workspaces>/<ID>` si queda vacía.

Conserva los logs (`_runs/`) y las lecciones (`_lessons/`). Es idempotente: ejecutarlo dos veces no da error.

```
removed worktree /Users/tu/code/.hector-workspaces/AB-123/api
deleted branch   api:hector/AB-123
```

> El trabajo de esas ramas que no hayas fusionado ni subido se pierde.

## `skills`

Muestra o personaliza las skills de los pasos. **No llama al modelo.**

```bash
npm run flow -- skills --repo <ruta>                     # equivale a "skills list"
npm run flow -- skills --repo <ruta> list
npm run flow -- skills --repo <ruta> eject <paso…|all>
```

- `list`: para cada paso, el `SKILL.md` en uso, su origen (`builtin`, `repo` o `config`), el modelo y el esfuerzo efectivos con su origen, las skills de Claude y los avisos; al final, el `RULES.md` compartido.
- `eject`: copia las skills de serie a `<repo>/.hector/skills/` para editarlas. Pasos válidos: `enrich`, `plan`, `testAuthor`, `coder`, `diagnose`, `review`, `qaPlan`, `distill`, `lead`, `_shared`, o `all`. Nunca sobrescribe (`exists`).

Guía completa: [13-skills.md](13-skills.md).

## `start`, `status`, `approve`, `reject`, `requeue`

El bucle continuo y la revisión de sus tickets. Referencia completa en [15-backlog-y-bucle.md](15-backlog-y-bucle.md#comandos).

```bash
npm run flow -- start   --repo <ruta> [--mode manual|supervised|auto] [--once] [--max <n>]
npm run flow -- status  --repo <ruta>
npm run flow -- approve --repo <ruta> <ID>
npm run flow -- reject  --repo <ruta> <ID> [--reason <texto>]
npm run flow -- requeue --repo <ruta> <ID>
```

El ID también se puede pasar con `--ticket-id`.

## `memory`

```bash
npm run flow -- memory --repo <ruta> [list [--all] | search <palabras…> | forget <id…>]
```

- `list` (por defecto): memorias validadas; `--all` incluye las provisionales.
- `search`: las 10 más relevantes para las palabras dadas.
- `forget`: borra entradas por id.

Ver [14-memoria-y-mcp.md](14-memoria-y-mcp.md).

## Scripts de npm

| Script | Qué hace |
|---|---|
| `npm run flow -- …` | Ejecuta la CLI sin compilar |
| `npm run tutorial:setup -- <carpeta>` | Crea los repos del tutorial |
| `npm run typecheck` | Verifica los tipos |
| `npm test` | Todas las pruebas, sin llamadas al modelo |
| `npm run test:e2e` | Solo el e2e |
| `npm run test:tutorial` | Solo el recorrido del tutorial |
| `npm run test:loop` | Solo memoria, MCP, adaptadores y bucle |
| `npm run build` | Compila a `dist/` |
