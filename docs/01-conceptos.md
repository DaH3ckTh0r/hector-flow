# 1. Conceptos

## Qué es hector-flow

hector-flow es un **programa** que implementa tickets de software usando agentes de IA. No es un prompt largo ni un chat: es código TypeScript con pasos, condiciones y bucles, que llama a la IA solo en los puntos donde hace falta razonar.

La idea viene del video de Alpaca Tech *"Así programo con IA tras +500 horas"*: la IA es muy buena haciendo cosas, pero mala decidiendo por sí sola cuándo terminó, qué hacer después y si lo que hizo está bien, sobre todo cuando su contexto se llena. Por eso esas decisiones las toma el código, y la IA queda "con la correa corta".

Le das:

- un **ticket** en markdown con criterios de aceptación,
- una **configuración** que describe tus componentes (repos, carpetas, comandos),

y te devuelve:

- una **rama por repositorio** con commits, tests en verde y criterios verificados,
- un **reporte de QA** criterio por criterio,
- un **plan de pruebas manuales**,
- los **supuestos** que tomó sin respuesta,
- un **log** completo de lo que pasó.

## Los tres pilares

| Pilar | Qué significa | Dónde se ve |
|---|---|---|
| **Autonomía** | Defines el problema y el sistema te devuelve el trabajo terminado y probado, sin que tengas que aprobar cada paso. | Permisos definidos de antemano por paso y por componente; canal `ask` para dudas; aviso al terminar. |
| **Corregir cada error una sola vez** | Cuando algo sale mal, no se parchea el resultado: se corrige la pieza del sistema que lo produjo, para que no vuelva a pasar. | `distill` convierte tus correcciones en pautas para el paso responsable. |
| **Modularidad y granularidad** | Muchas piezas pequeñas, cada una con una sola responsabilidad. Si una falla, iteras solo esa. | Nueve roles; cada tarea limitada a un componente; un worktree por tarea. |

## El ciclo en una imagen

```
ticket.md ─┐
config ────┤
           ▼
  ┌─ INVESTIGACIÓN ──────────────────────────────────────────────────────┐
  │ enrich → plan → write-tests (por componente) → commit de tests       │
  └──────────────────────────────────────────────────────────────────────┘
           ▼
  ┌─ IMPLEMENTACIÓN (en paralelo según dependencias) ────────────────────┐
  │ por tarea: worktree → implement → build gate → merge a integración   │
  │ luego: stabilize por componente (build + test + lint) ⟲              │
  └──────────────────────────────────────────────────────────────────────┘
           ▼
  ┌─ VERIFICACIÓN ───────────────────────────────────────────────────────┐
  │ review ⟲ → QA (comandos de aceptación) ⟲ → qa-plan → limpieza → aviso│
  └──────────────────────────────────────────────────────────────────────┘

⟲ = si falla: diagnose → el defecto vuelve al worker dueño del código
    → si agotó sus intentos, a un implementador nuevo → si se agota el total, a un humano
```

El detalle de cada paso está en [05-flujo.md](05-flujo.md).

## Glosario

| Término | Significado |
|---|---|
| **Ticket** | Archivo markdown con `# ID: título` y una sección `## Acceptance criteria`. Ver [04-tickets.md](04-tickets.md). |
| **Componente** | Una parte desplegable del sistema (backend, middleware, frontend) con sus propios comandos. Vive en un repo y una carpeta. |
| **Repo principal** | El repo que pasas con `--repo`. Contiene `hector-flow.config.json`; las rutas `repo` de los componentes son relativas a él. |
| **Rol** | El tipo de agente de un paso: `enrich`, `plan`, `testAuthor`, `coder`, `diagnose`, `review`, `qaPlan`, `lead`, `distill`. Cada rol tiene sus instrucciones, su modelo y su esfuerzo. |
| **Agente** | Una sesión del Agent SDK de Claude que ejecuta un paso, con un contexto limpio y permisos acotados. Devuelve JSON validado. |
| **Worker** | Un agente `coder` que implementa una tarea del plan, en su propio worktree. Se le recuerda para devolverle sus defectos. |
| **Worktree** | Una carpeta de trabajo de git ligada a tu repo, con su propia rama. Permite trabajar sin tocar tu checkout. |
| **Rama de integración** | `hector/<ID>` en cada repo tocado. Ahí se fusionan las tareas y queda el resultado final. |
| **Rama de tarea** | `hector-tasks/<ID>/<Tn>`. Una por tarea; se elimina al terminar con éxito. |
| **Tests bloqueados** | Los archivos que coinciden con `lockedPaths`. Solo el autor de tests escribe ahí; los implementadores no pueden cambiarlos. |
| **Mapa de aceptación** | Lista criterio → comando que el código ejecuta para decidir que el ticket está terminado. |
| **Compuerta (gate)** | Build + lint de una tarea en su worktree, antes de integrarla. |
| **Ledger** | Registro de cada commit que hizo el flujo: paso, componente, tarea, SHA y archivos según git. |
| **Pauta (guideline)** | Instrucción permanente para un rol, generada por `distill` a partir de tus correcciones. |
| **Lección de error** | Un fix que resolvió una falla con cierta firma (por ejemplo `CS8862`), guardado solo cuando la verificación pasó. |
| **Supuesto abierto** | Una pregunta de un worker que nadie pudo responder con fundamento; el worker decidió solo. |
| **`needs_human`** | Estado final que indica que el flujo se detuvo a propósito para que decidas tú. |

## Qué decide el código y qué decide la IA

| Lo decide el código | Lo decide la IA |
|---|---|
| El orden de los pasos y cuándo se pasa al siguiente | Qué archivos leer para entender el código |
| Cuántos reintentos hay y cuándo parar | Cómo dividir el ticket en tareas |
| Qué agente puede escribir dónde y qué comandos puede ejecutar | Qué tests escribir para cada criterio |
| Si el ticket está terminado (ejecuta los comandos de aceptación) | Cómo implementar una tarea |
| Qué archivos entran en cada commit | Por qué falló un check y de quién es la culpa |
| A quién se devuelve cada defecto | Qué hallazgos tiene una revisión |
| Cuándo escalar a un humano | Cómo resolver un conflicto de merge |

## Cuándo usarlo y cuándo no

**Funciona bien** cuando el ticket parte de un diseño técnico revisado, los criterios de aceptación se pueden verificar con tests y el repo tiene comandos de build y test que pasan hoy.

**Funciona mal** con ideas sueltas sin diseño, trabajo visual al píxel (el propio autor del video lo menciona como su punto débil), cambios que no se pueden probar automáticamente, o repos sin tests.

**Advertencia del propio video:** para proyectos personales, una herramienta existente como Gentle AI puede darte resultados parecidos o mejores sin construir nada. Un flujo propio vale la pena cuando quieres adaptarlo al detalle a tus herramientas y a tu forma de trabajar.
