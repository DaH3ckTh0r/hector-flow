# hector-flow

Flujo programático de IA que implementa tickets de software de punta a punta. **TypeScript controla el flujo; los agentes de IA solo razonan dentro de cada paso** y devuelven JSON validado.

Le das un ticket con criterios de aceptación y te devuelve, en cada repositorio afectado, una rama con commits, tests en verde, cada criterio verificado por código, un plan de pruebas manuales y la lista de supuestos que tomó.

- Un ticket puede tocar **varios componentes a la vez** (middleware, backend, frontend), en repos separados o en carpetas de un mismo repo.
- Las tareas independientes se ejecutan **en paralelo**, cada una en su propio worktree de git.
- Los defectos vuelven **al worker que escribió el código**, que los corrige retomando su sesión.
- Tus correcciones manuales se convierten en **pautas permanentes** para el paso que causó el error.
- Las instrucciones de cada paso son **skills** (`SKILL.md`) que cada repo puede personalizar, con skills de Claude Code y plugins por paso.
- La revisión puede hacerse con **varios jueces independientes** (con modelos distintos); todos deben aprobar.
- Los agentes solo leen su espacio de trabajo y **nunca archivos de secretos** (`.env`, claves, `~/.ssh`…). Los comandos de build y test se ejecutan **sin tus credenciales**.
- **Sandbox** listo para usar: un contenedor que solo ve tus repos y sale a Internet solo por un proxy con lista de dominios (`sandbox/hector-sandbox.sh`).
- **Memoria persistente** por repo: los agentes guardan decisiones y descubrimientos que los siguientes tickets recuperan (validada solo si el ticket termina bien). Servidores **MCP externos** (Engram, Context7…) asignables por paso.
- **Consumo de tokens por llamada**: entrada, caché escrita y leída, salida y razonamiento, por modelo, en el log de cada paso, en el resumen y en `usage`.
- **Varios runtimes**: cada paso, y cada juez, puede correr en **Claude**, **GitHub Copilot**, **pi**, **OpenCode** (cualquier proveedor) o **Codex** (OpenAI), con las mismas skills, contratos y herramientas del flujo.
- **Bucle continuo** (`start`): toma tickets de una carpeta, de **GitHub Issues** o de **Azure DevOps**, y según el modo deja las ramas, espera tu aprobación o las **fusiona con verificación y reversión**. Publica el resultado como comentario en el ticket.

Basado en el flujo de Alpaca Tech (*"Así programo con IA tras +500 horas"*) y en el ciclo de Orca, con ideas de gentle-ai (skills por fase, revisión doble, lista de secretos, memoria) y Noodle (skills como punto de extensión, backlog, bucle con modos). Usa el [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/structured-outputs) y, si los configuras, el Copilot SDK, el SDK de pi, el Codex SDK y el SDK de OpenCode.

## Inicio rápido

```bash
npm install
npm test                                        # ~1 minuto, sin llamadas al modelo

npm run tutorial:setup -- ~/hector-tutorial     # dos repos de ejemplo y un ticket
npm run flow -- check --repo ~/hector-tutorial/tienda-api --ticket ~/hector-tutorial/TIENDA-42.md
npm run flow -- run   --repo ~/hector-tutorial/tienda-api --ticket ~/hector-tutorial/TIENDA-42.md
```

Sigue el **[tutorial completo](docs/09-tutorial.md)**: del ticket a las ramas listas para integrar, pasando por la revisión, la corrección manual, el aprendizaje y la limpieza.

## Documentación

| | Documento | Para qué |
|---|---|---|
| 1 | [Conceptos](docs/01-conceptos.md) | Qué es, los tres pilares, glosario, qué decide el código y qué la IA |
| 2 | [Instalación](docs/02-instalacion.md) | Requisitos, autenticación, preparar un repo, dónde escribe |
| 3 | [Configuración](docs/03-configuracion.md) | Referencia de cada campo: componentes, globs, allowlist, modelos, límites |
| 4 | [Tickets](docs/04-tickets.md) | Formato, qué hace que un ticket funcione, plantilla |
| 5 | [El flujo, paso a paso](docs/05-flujo.md) | Cada fase, qué recibe y devuelve cada agente, reparación, paralelismo, conflictos |
| 6 | [Seguridad y permisos](docs/06-seguridad.md) | Qué puede hacer cada agente, qué se revisa, qué **no** está protegido |
| 7 | [Observabilidad](docs/07-observabilidad.md) | `events.jsonl`, `summary.json`, artefactos, ledger, consultas con `jq` |
| 8 | [Aprendizaje](docs/08-aprendizaje.md) | `distill`, pautas, lecciones de error, el archivo de lecciones |
| 9 | **[Tutorial](docs/09-tutorial.md)** | Un desarrollo completo con dos repos, paso a paso |
| 10 | [Solución de problemas](docs/10-problemas.md) | Cada mensaje de error, su causa y qué hacer |
| 11 | [Arquitectura y extensión](docs/11-arquitectura.md) | Mapa del código, `AgentRunner`, pruebas sin costo, cómo agregar pasos |
| 12 | [CLI](docs/12-cli.md) | `check`, `run`, `distill`, `clean`, `skills` |
| 13 | [Skills de los pasos](docs/13-skills.md) | Personalizar cada agente con `SKILL.md`, skills de Claude Code y plugins |
| 14 | [Memoria y MCP](docs/14-memoria-y-mcp.md) | Memoria persistente, `memory`, servidores MCP externos por paso |
| 15 | [Backlog y bucle](docs/15-backlog-y-bucle.md) | Carpeta, GitHub, Azure DevOps; modos manual/supervised/auto; fusión verificada |
| 16 | [Runtimes](docs/16-runtimes.md) | Claude, Copilot, pi, Codex y OpenCode por paso y por juez; qué aísla cada uno; puente MCP |
| 17 | [Sandbox](docs/17-sandbox.md) | Ejecutar todo aislado: contenedor, proxy con allowlist, credenciales, herramientas de tus componentes |

## El ciclo

```
INVESTIGACIÓN
  enrich          lee el ticket y todos los componentes                         (solo lectura)
  plan            tareas de un componente cada una, con dependencias             (solo lectura)
  write-tests     por componente: tests bloqueados + un comando por criterio    (solo tests)
IMPLEMENTACIÓN    grafo de dependencias, hasta maxParallel workers a la vez
  implement-Tn    worktree propio, commit de archivos exactos, solo en su componente
  gate            build + lint de la tarea; si falla, lo corrige el mismo worker
  integración     merge a hector/<ID>; si hay conflicto, lo resuelve ese worker
  stabilize ⟲     build + test + lint por componente
VERIFICACIÓN
  review ⟲        revisa todos los repos; no corrige: enruta al worker dueño
  qa ⟲            el CÓDIGO ejecuta los comandos de aceptación
  qa-plan         plan de pruebas manuales
  cierre          limpieza, summary.json, aviso

⟲ diagnose → al worker dueño (retoma su sesión) → a un implementador nuevo → a un humano
```

## Comandos

| Comando | Qué hace | Llama al modelo |
|---|---|---|
| `check --repo <r> [--ticket <t>]` | Valida config, repos, comandos y ticket | No |
| `run --repo <r> --ticket <t>` | Implementa el ticket | Sí |
| `distill --repo <r> --ticket-id <ID>` | Aprende de tus correcciones | Sí (una vez) |
| `clean --repo <r> --ticket-id <ID>` | Borra worktrees y ramas del ticket | No |
| `skills --repo <r> [list \| eject <paso…\|all>]` | Muestra o personaliza las skills de los pasos | No |
| `start --repo <r> [--mode …] [--once]` | Bucle continuo sobre el backlog | Sí |
| `status` / `approve <ID>` / `reject <ID>` / `requeue <ID>` | Estado y revisión de los tickets del bucle | No |
| `memory --repo <r> [list \| search … \| forget …]` | Consulta y edita la memoria del repo | No |
| `models --repo <r> copilot\|pi` | Lista los ids de modelo de Copilot o de pi | No |
| `usage --repo <r> [--by model\|step\|ticket\|day…]` | Tokens consumidos (entrada, caché, salida, razonamiento) y costo | No |

Códigos de salida de `run`: `0` completed · `3` needs_human · `1` failed.

## Requisitos

Node 20+, git 2.30+ (o solo Docker, con el [sandbox](docs/17-sandbox.md)), y Claude Code con sesión iniciada (o `ANTHROPIC_API_KEY`). macOS o Linux; en Windows, WSL2. Opcional: sesión de GitHub Copilot (`copilot login` o un token), de Codex (`npx codex login`) u OpenCode en el PATH si envías pasos a esos runtimes.

## Estado

Probado con un runner simulado sobre repos y comandos reales, y HTTP simulado para GitHub y Azure DevOps (`npm test`: reglas de permisos, runtimes Codex/OpenCode/Copilot con SDK simulados, pi con una sesión real y modelo simulado y el puente MCP con un cliente real, 18 escenarios del flujo, 8 de memoria/backlog/bucle y el tutorial completo). La integración con el modelo real (sesiones retomadas, herramienta `ask`, salida estructurada) sigue la documentación del Agent SDK, pero conviene validarla en tu primer ticket revisando `events.jsonl`.

Pendiente: push y creación de PRs, atender comentarios de PRs, interfaz web con el feed de eventos, y cancelar workers en curso cuando otro falla. Ver [arquitectura](docs/11-arquitectura.md#extensiones-habituales).
