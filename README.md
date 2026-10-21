# hector-flow

Flujo programático de IA que implementa tickets de software de punta a punta. **TypeScript controla el flujo; los agentes de IA solo razonan dentro de cada paso** y devuelven JSON validado.

Le das un ticket con criterios de aceptación y te devuelve, en cada repositorio afectado, una rama con commits, tests en verde, cada criterio verificado por código, un plan de pruebas manuales y la lista de supuestos que tomó.

- Un ticket puede tocar **varios componentes a la vez** (middleware, backend, frontend), en repos separados o en carpetas de un mismo repo.
- Las tareas independientes se ejecutan **en paralelo**, cada una en su propio worktree de git.
- Los defectos vuelven **al worker que escribió el código**, que los corrige retomando su sesión.
- Tus correcciones manuales se convierten en **pautas permanentes** para el paso que causó el error.
- Las instrucciones de cada paso son **skills** (`SKILL.md`) que cada repo puede personalizar, con skills de Claude Code y plugins por paso.
- La revisión puede hacerse con **varios jueces independientes** (con modelos distintos); todos deben aprobar.
- Los agentes solo leen su espacio de trabajo y **nunca archivos de secretos** (`.env`, claves, `~/.ssh`…).

Basado en el flujo de Alpaca Tech (*"Así programo con IA tras +500 horas"*) y en el ciclo de Orca, con ideas de gentle-ai (skills por fase, revisión doble, lista de secretos) y Noodle (skills como punto de extensión). Usa el [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/structured-outputs).

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

Códigos de salida de `run`: `0` completed · `3` needs_human · `1` failed.

## Requisitos

Node 20+, git 2.30+, y Claude Code con sesión iniciada (o `ANTHROPIC_API_KEY`). macOS o Linux; en Windows, WSL2.

## Estado

Probado con un runner simulado sobre repos y comandos reales (`npm test`: reglas de permisos, 17 escenarios del flujo y el tutorial completo). La integración con el modelo real (sesiones retomadas, herramienta `ask`, salida estructurada) sigue la documentación del Agent SDK, pero conviene validarla en tu primer ticket revisando `events.jsonl`.

Pendiente: push y creación de PRs, atender comentarios de PRs, leer tickets desde Azure DevOps/Jira/Linear, y cancelar workers en curso cuando otro falla. Ver [arquitectura](docs/11-arquitectura.md#extensiones-habituales).
