# 18. Ejecuciones durables: reintentos, checkpoints y `resume`

Un ticket puede tardar decenas de minutos y hacer cientos de llamadas a modelos. Si una de ellas falla por un motivo pasajero (el proveedor está saturado, se corta la red) o si el proceso muere (cierras la terminal, se reinicia la máquina, el contenedor se queda sin memoria), no tiene sentido empezar de cero y volver a pagar todo lo hecho. hector-flow tiene dos defensas:

1. **Reintentos de llamadas**: una llamada a un agente que falla por un motivo transitorio se repite sola, con espera creciente.
2. **Checkpoints y `resume`**: el estado de la ejecución se guarda después de cada paso, y `hector-flow resume` la continúa donde quedó: mismas ramas, mismos worktrees, sin repetir lo terminado.

## Reintentos

| Se reintenta (transitorio) | No se reintenta (permanente) |
|---|---|
| Límite de peticiones (`429`, `rate_limit`) | Límite de turnos o de presupuesto del agente (`max_turns`, `budget`) |
| Proveedor saturado o caído (`529`, `overloaded`, `500`, `502`, `503`, `504`) | Salida que no cumple el contrato del paso |
| Errores de red (`ECONNRESET`, `ETIMEDOUT`, `fetch failed`, `socket hang up`…) | Credenciales inválidas o sin sesión (`401`, `403`, `not signed in`) |
| Tiempo agotado | Modelo desconocido |
| El proceso del agente murió (`exited with code`, `killed`) | |

```json
"policy": { "agentRetries": 3, "agentRetryDelaySeconds": 10 }
```

| Campo | Por defecto | Descripción |
|---|---|---|
| `agentRetries` | `3` | Reintentos de una misma llamada. `0` los desactiva. |
| `agentRetryDelaySeconds` | `10` | Primera espera. Se duplica en cada intento (10 s, 20 s, 40 s…), con ±20 % de variación, hasta 5 minutos. |

Cada intento fallido queda en `events.jsonl` (un `step.end` con `ok: false` y los tokens que alcanzó a gastar) y un aviso:

```
  · enrich: transient failure, retry 1/3 in 10s — 429 rate_limit_error: slow down
```

Los reintentos de llamadas son distintos de las **reparaciones** (`repairAttempts`, cuando fallan los tests) y de los **reintentos del mismo worker** (`sameWorkerRetries`, cuando se le devuelve un defecto): esos dependen del código que se escribió, no de un fallo del proveedor.

## Checkpoints

Cada ejecución escribe `state.json` en su carpeta (`_runs/<ID>-<fecha>/`) después de cada paso: al empezar, al crear cada worktree, después de cada agente, de cada commit, de cada integración, de cada pregunta y al terminar. La escritura es atómica: un corte a mitad de escritura nunca deja un archivo roto.

| Contenido | Para qué |
|---|---|
| `ticket` | El ticket tal como era al empezar (si editas el archivo después, `resume` sigue con el original) |
| `status` | `running` mientras corre. Si el proceso muere, se queda en `running`. Al terminar: `completed`, `needs_human` o `failed` |
| `research`, `plan` | No se vuelven a pedir |
| `acceptance` y `repos[].testsRef` | Los tests bloqueados ya commiteados |
| `repos` | Worktree y rama de integración de cada repo |
| `tasks` | Por tarea: worktree, rama, sesión del worker, archivos que commiteó, reintentos usados y si ya se integró |
| `review` | El resultado final de la revisión, si terminó |
| `ledger`, `questions`, `counters` | El historial de commits, las preguntas y respuestas, los contadores de reparaciones y revisiones |
| `costUsd`, `usage` | Costo y tokens acumulados, que `resume` sigue sumando |
| `pendingMemories` | Con Engram: memorias de la ejecución aún no escritas (ver [14-memoria-y-mcp.md](14-memoria-y-mcp.md#engram)) |

El código no está en `state.json`: está en git, en las ramas `hector/<ID>` y `hector-tasks/<ID>/*`, que el flujo commitea después de cada paso.

## `resume`

```bash
npm run flow -- resume --repo ~/code/tienda-api --ticket-id TIENDA-42
npm run flow -- resume --repo ~/code/tienda-api --ticket-id TIENDA-42 --fresh-budgets
```

Busca la ejecución más reciente del ticket que **no** terminó en `completed` (interrumpida, `failed` o `needs_human`) y la continúa:

1. **Mismo registro.** Sigue escribiendo en la misma carpeta, con el mismo `runId`; `events.jsonl` muestra las dos sesiones, y el costo y los tokens se suman.
2. **Limpia lo que el corte dejó a medias.** En cada worktree descarta lo que no estaba commiteado (una fusión sin terminar, archivos editados o nuevos; los ignorados como `node_modules` se quedan) y lo registra:
   `⚠ guard: discarded uncommitted changes of T2 — src/lerp.js, src/scratch.js`
3. **Salta lo terminado:**

| Fase | Al reanudar |
|---|---|
| `enrich` y `plan` | Se reutilizan si ya estaban |
| Tests bloqueados | Se reutilizan si se commitearon en todos los repos; si se cortó a mitad, se rehacen desde el commit base |
| Tareas integradas | Se saltan (`T1 was integrated before the interruption; skipped`) |
| Tarea con su implementación commiteada | Continúa con su compuerta de build y su integración |
| Tarea sin commit | Se rehace en su worktree (ya limpio) |
| Estabilización, QA y comprobaciones finales | Se vuelven a ejecutar (son comandos, idempotentes) |
| Revisión | Se salta si había terminado; si no, sigue desde la ronda en que iba |
| Plan de pruebas | Se genera |

4. **Workers.** Los defectos siguen volviendo al worker dueño del código, retomando su sesión cuando el runtime la guarda en disco (Claude, Codex, Copilot). En OpenCode y pi las sesiones viven en memoria y se pierden con el proceso: esos defectos van a un implementador nuevo, con el ledger como contexto. Un worker cuyo worktree ya no existe tampoco puede recibir defectos.

**`--fresh-budgets`** pone a cero los contadores de reparaciones, rondas de revisión y reintentos del mismo worker. Úsalo cuando una ejecución terminó en `needs_human` por agotarlos y ya corregiste la causa (por ejemplo, arreglaste un test que estaba mal o cambiaste el modelo en la config): sin él, el primer fallo volvería a detenerse.

Al terminar, `resume` muestra el mismo resumen que `run` y devuelve los mismos códigos de salida.

### En el bucle

`hector-flow start` reanuda solo: un ticket que el estado del bucle marca como `running` cuando arranca el bucle quedó interrumpido (solo puede haber un bucle por repo), así que se procesa **primero** y se reanuda:

```
▶ TIENDA-42: Cupones de descuento en el carrito  (TIENDA-42.md)
  · resuming the interrupted run TIENDA-42-2026-10-21T10-02-11-120Z-a1b2c3
```

Si se cortó antes del primer checkpoint (en los primeros segundos), no hay nada que valga la pena conservar: se limpia y empieza de nuevo. Los tickets en `failed` o `needs_human` no se reanudan solos (necesitan a alguien): usa `resume` o `requeue`.

### Lo que `resume` no hace

- **No reanuda ejecuciones `completed`.** Para rehacer un ticket terminado, `clean` y `run`.
- **No recupera trabajo sin commitear.** Lo que un agente estaba escribiendo cuando se cortó se descarta y ese paso se repite: es la única forma de no integrar código a medias.
- **No adivina cambios de configuración.** Si quitaste un componente que el plan usaba, `resume` lo dice y se detiene.
- **No continúa la conversación exacta** en OpenCode y pi (ver arriba).
- **Costo de la primera llamada retomada en Claude tras un reinicio.** El SDK informa los totales de toda la sesión al retomarla; dentro de un mismo proceso el flujo resta lo ya contado, pero tras reiniciar no conoce esa cifra, así que el costo de esa primera llamada puede incluir turnos anteriores. Los tokens por llamada y el resto del informe no se ven afectados.

## Recetas

**Lo cortaste a propósito** (`Ctrl+C` dos veces, cerrar la terminal): `resume`.

**Se agotó el crédito o el proveedor estuvo caído más que los reintentos:** la ejecución termina en `failed`; cuando vuelva, `resume`.

**`needs_human` por un test mal escrito:** corrige el test en la rama `hector/<ID>` (worktree de integración), commitea, y `resume --fresh-budgets`. Como los tests bloqueados se toman de `testsRef`, si cambias un test bloqueado, el flujo lo restaura: para cambiar tests, hazlo y vuelve a empezar (`clean` + `run`), o ajusta el ticket.

**Desatendido de verdad:** `start` dentro del [sandbox](17-sandbox.md) con un supervisor que lo reinicie (systemd, `restart: unless-stopped` de Docker): cada reinicio reanuda el ticket interrumpido.

## Por qué no un motor de flujos (Temporal, Restate, DBOS)

Esos motores dan durabilidad a cualquier programa a cambio de un servidor o una base de datos más. Aquí el estado que importa ya es durable: el código está en git y el resto cabe en un archivo JSON por ejecución. Para una CLI en una máquina, eso cubre los fallos reales (proveedor, red, proceso) sin infraestructura nueva. Si algún día el flujo se reparte entre varias máquinas, `state.json` es exactamente lo que habría que mover a uno de ellos.
