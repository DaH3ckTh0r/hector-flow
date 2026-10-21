# 9. Tutorial: un desarrollo completo de punta a punta

En este tutorial vas a implementar una funcionalidad real que toca **dos repositorios a la vez** (una API y una web), desde el ticket hasta las ramas listas para integrar, pasando por la corrección humana y el aprendizaje del sistema.

**Qué vas a hacer**

| Paso | Qué ocurre | Llama al modelo |
|---|---|---|
| 1. Instalar hector-flow | Dependencias y pruebas internas | No |
| 2. Crear los repos del tutorial | `tienda-api` y `tienda-web`, cada uno con su git | No |
| 3. Conocer el código | Correr tests y probar la API | No |
| 4. Leer la configuración | Qué es cada componente y por qué | No |
| 5. Leer el ticket | Qué hace que un ticket funcione bien | No |
| 6. Verificar con `check` | Config, repos, comandos y ticket | No |
| 7. Ejecutar con `run` | El flujo completo, con trabajo en paralelo | **Sí** |
| 8. Leer el resultado | Estado, ramas, costo | No |
| 9. Revisar el trabajo | Commits, diffs, artefactos, probar la API | No |
| 10. Corregir algo a mano | Como harías en un PR real | No |
| 11. Aprender con `distill` | Tu corrección se convierte en una pauta | **Sí** (una llamada) |
| 12. Integrar las ramas | Merge local (o push + PR en un proyecto real) | No |
| 13. Limpiar con `clean` | Borra worktrees y ramas del ticket | No |

**Tiempo:** unos 30 minutos, de los cuales el paso 7 suele tomar entre 10 y 25 minutos según los modelos.

**Costo:** depende de tu plan y de los modelos. La configuración del tutorial limita **cada** agente a 1 USD (`maxBudgetUsdPerAgent: 1`) y 30 turnos. Una ejecución sin contratiempos usa 9 agentes (investigación, plan, dos autores de tests, tres implementadores, revisión y plan de pruebas); cada reparación, ronda de revisión o pregunta suma uno. Si usas una suscripción de Claude, el consumo sale de tus límites de uso, no de una factura aparte.

> Todo este recorrido está automatizado en `test/tutorial.ts` con un runner simulado que aplica una solución de referencia. Si `npm test` pasa, el tutorial funciona con tu versión de hector-flow. Lo que cambia con el modelo real son los tiempos, el costo y los detalles del código que escriben los agentes.

---

## Paso 1. Instalar hector-flow

Requisitos (detalles en [02-instalacion.md](02-instalacion.md)):

- **Node.js 20 o superior**: `node --version`
- **git 2.30 o superior**: `git --version`
- **Claude Code instalado y con sesión iniciada**, o la variable `ANTHROPIC_API_KEY`. El Agent SDK de Claude, que hector-flow usa por debajo, se autentica igual que Claude Code.

```bash
unzip hector-flow.zip
cd hector-flow
npm install
npm test        # opcional: ~1 minuto, sin llamadas al modelo
```

`npm test` debe terminar con `tutorial checks passed`. Si falla, revisa [10-problemas.md](10-problemas.md) antes de seguir.

En el resto del tutorial, todos los comandos `npm run flow -- …` se ejecutan **desde la carpeta `hector-flow`**.

---

## Paso 2. Crear los repositorios del tutorial

```bash
npm run tutorial:setup -- ~/hector-tutorial
```

Salida:

```
✔ /Users/tu/hector-tutorial/tienda-api
✔ /Users/tu/hector-tutorial/tienda-web
✔ /Users/tu/hector-tutorial/TIENDA-42.md

Listo. Siguiente paso (desde /Users/tu/hector-flow):

  npm run flow -- check --repo /Users/tu/hector-tutorial/tienda-api --ticket /Users/tu/hector-tutorial/TIENDA-42.md
```

Lo que se creó:

```
~/hector-tutorial/
├── TIENDA-42.md                 ← el ticket
├── tienda-api/                  ← repo git, componente "api" (repo principal)
│   ├── hector-flow.config.json  ← la configuración del flujo
│   ├── CLAUDE.md                ← convenciones que leen los agentes
│   ├── package.json             ← scripts: test, build, start
│   ├── scripts/build.js
│   ├── src/cart.js              ← subtotal en centavos
│   ├── src/routes.js            ← POST /cart/quote
│   ├── src/server.js
│   └── test/                    ← tests existentes
└── tienda-web/                  ← repo git, componente "web"
    ├── CLAUDE.md
    ├── package.json
    ├── scripts/build.js
    ├── src/money.js             ← formatCents
    ├── src/cart-view.js         ← renderCart
    └── test/
```

Cada repo tiene un commit inicial en `main` y está limpio. Si no tienes identidad de git configurada, el script pone una local solo en estos dos repos.

Después del paso 7 aparecerá una tercera carpeta, `~/hector-tutorial/.hector-workspaces/`, donde hector-flow trabaja sin tocar tus checkouts.

---

## Paso 3. Conocer el código

```bash
cd ~/hector-tutorial/tienda-api
npm test
npm run build
npm start          # en otra terminal:
curl -s -X POST localhost:3000/cart/quote -H 'content-type: application/json' \
  -d '{"items":[{"sku":"camiseta","unitPrice":1999,"quantity":2}]}'
# {"subtotal":3998,"total":3998}
```

Detén el servidor con Ctrl+C. Haz lo mismo con `tienda-web` (`npm test`, `npm run build`).

Puntos que importan para el flujo:

- Los importes son **centavos enteros**. Está escrito en `CLAUDE.md`, y los agentes lo leen porque la config tiene `loadProjectSettings: true`.
- `src/routes.js` es un enrutador puro: se prueba sin red. Por eso los tests de aceptación pueden llamar a `handle()` directamente.
- Ya existen tests en `test/`. Como `test/**` está en `lockedPaths`, **también quedan bloqueados**: ningún implementador podrá cambiarlos. El diseño del ticket debe ser compatible con ellos (verás que lo es: "sin cupón, la respuesta no cambia").

---

## Paso 4. Leer la configuración

Abre `tienda-api/hector-flow.config.json`. Lo esencial:

```json
{
  "components": {
    "api": {
      "description": "API HTTP del carrito (Node, ESM). Lógica en src/cart.js, enrutador puro en src/routes.js. Importes en centavos.",
      "repo": ".",
      "path": ".",
      "buildCommand": "npm run build",
      "testCommand": "npm test",
      "lockedPaths": ["test/**"],
      "allowedCommands": ["npm test", "npm run build", "node --test"]
    },
    "web": {
      "description": "Vista del carrito (Node, ESM). renderCart en src/cart-view.js convierte la respuesta de la API en líneas de texto.",
      "repo": "../tienda-web",
      "path": ".",
      ...
    }
  },
  "policy": { "maxParallel": 2, "repairAttempts": 4, "sameWorkerRetries": 2, ... }
}
```

Campo por campo, en este caso:

| Campo | Valor | Por qué |
|---|---|---|
| `components.api.repo` | `"."` | La API vive en el mismo repo que la config (el repo principal, el que pasas con `--repo`). |
| `components.web.repo` | `"../tienda-web"` | Ruta **relativa al repo principal**. Así un ticket puede tocar repos hermanos. |
| `path` | `"."` | Cada componente ocupa su repo entero. En un monorepo sería, por ejemplo, `"backend"`. |
| `description` | texto | Lo leen el investigador y el planificador para decidir qué tarea va a qué componente. Escríbela como se la explicarías a alguien nuevo. |
| `buildCommand` | `npm run build` | Se usa como **compuerta** de cada tarea en su worktree, y en la estabilización. |
| `testCommand` | `npm test` | Debe pasar para dar el ticket por terminado. |
| `lockedPaths` | `["test/**"]` | Relativo a `path`. Aquí escribe el autor de tests; los implementadores no pueden tocarlo. |
| `allowedCommands` | `npm test`, `npm run build`, `node --test` | Únicos comandos que los agentes pueden ejecutar. `node --test` permite comandos de aceptación como `node --test --test-name-pattern="ENVIO"`. |
| `policy.maxParallel` | `2` | Como mucho dos implementadores a la vez. |

La referencia completa de cada campo está en [03-configuracion.md](03-configuracion.md).

---

## Paso 5. Leer el ticket

Abre `~/hector-tutorial/TIENDA-42.md`. Tiene tres partes que hacen que el flujo funcione bien:

1. **Un diseño técnico aprobado.** El flujo no va de una idea suelta a una feature: parte de un diseño que ya se discutió. Aquí se definen los cupones, el redondeo, la normalización a mayúsculas y los textos visibles exactos.
2. **El contrato entre componentes** (`POST /cart/quote`, con ejemplos de request y respuesta). Es lo que permite que la tarea de la web se construya **en paralelo** con la de la API: ninguna necesita adivinar lo que hará la otra.
3. **Criterios de aceptación verificables.** Cada uno se convertirá en un test bloqueado y en un comando que el código ejecuta para decidir si el ticket está terminado.

Las subtareas sugeridas ya traen las dependencias: la 2 depende de la 1, y la 3 es independiente. El planificador las respeta, así que en el paso 7 verás la tarea 1 (api) y la 3 (web) ejecutándose a la vez.

Más sobre cómo escribir tickets en [04-tickets.md](04-tickets.md).

---

## Paso 6. Verificar con `check`

Desde la carpeta `hector-flow`:

```bash
npm run flow -- check --repo ~/hector-tutorial/tienda-api --ticket ~/hector-tutorial/TIENDA-42.md
```

Salida esperada:

```
✔ primary repo /Users/tu/hector-tutorial/tienda-api
✔ 2 component(s): api, web
✔ repo /Users/tu/hector-tutorial/tienda-api is clean
✔ repo /Users/tu/hector-tutorial/tienda-web is clean
✔ api: agents can run its test command
✔ api: build "npm run build" passes on the current code (0.2s)
✔ api: test "npm test" passes on the current code (0.4s)
✔ web: agents can run its test command
✔ web: build "npm run build" passes on the current code (0.2s)
✔ web: test "npm test" passes on the current code (0.4s)
✔ ticket TIENDA-42: "Cupones de descuento en el carrito" with 6 acceptance criteria

Ready to run.
```

`check` no llama al modelo. Comprueba que la config se resuelve, que cada repo está limpio, que los comandos de cada componente **pasan hoy** (si no pasan antes de empezar, el flujo no podrá distinguir sus fallos de los tuyos) y que el ticket se puede leer.

---

## Paso 7. Ejecutar

```bash
npm run flow -- run --repo ~/hector-tutorial/tienda-api --ticket ~/hector-tutorial/TIENDA-42.md
```

Deja la terminal abierta. Mientras corre, en otra terminal puedes seguir el detalle:

```bash
tail -f ~/hector-tutorial/.hector-workspaces/_runs/TIENDA-42-*/events.jsonl
```

Esta es la salida real del recorrido verificado, con comentarios. Con el modelo real, cada paso de agente dura de segundos a varios minutos y el costo por paso es mayor; los nombres de tests y el orden exacto de los mensajes pueden variar.

```
hector-flow · TIENDA-42: Cupones de descuento en el carrito

  · integration worktree …/.hector-workspaces/TIENDA-42/tienda-api on hector/TIENDA-42
  · integration worktree …/.hector-workspaces/TIENDA-42/tienda-web on hector/TIENDA-42
```

**Espacios de trabajo.** Se crea una rama `hector/TIENDA-42` en cada repo, con su worktree. Tus carpetas `tienda-api` y `tienda-web` no se tocan.

```
▶ enrich
✔ enrich …
▶ plan
✔ plan …
```

(Donde ves `…`, una ejecución real muestra la duración y el costo del agente, por ejemplo `✔ plan 61.0s $0.4120`.)

**Investigación.** `enrich` lee el ticket y el código de ambos componentes. `plan` divide el trabajo en tareas, cada una de un solo componente y con sus dependencias. Ya puedes abrir el plan en `_runs/<runId>/artifacts/plan.md`.

```
▶ write-tests:api
✔ write-tests:api …
▶ write-tests:web
✔ write-tests:web …
  $ npm test → exit 1 (0.5s)
  $ npm test → exit 1 (0.5s)
```

**Tests bloqueados.** Un autor de tests por componente escribe tests para los criterios que le corresponden, más un comando ejecutable por criterio (el "mapa de aceptación"). Después se ejecutan los tests: **deben fallar** (`exit 1`), porque la funcionalidad aún no existe. Si pasaran, verías un aviso de que los tests no restringen el cambio. Los tests se commitean y quedan bloqueados.

```
▶ implement-T1
▶ implement-T3
✔ implement-T1 …
✔ implement-T3 …
  $ npm run build → ok (0.2s)
  $ npm run build → ok (0.2s)
  · integrated T3 into tienda-web:hector/TIENDA-42
  · integrated T1 into tienda-api:hector/TIENDA-42
▶ implement-T2
✔ implement-T2 …
  $ npm run build → ok (0.2s)
  · integrated T2 into tienda-api:hector/TIENDA-42
  · all 3 tasks integrated (max 2 in parallel)
```

**Implementación en paralelo.** T1 (módulo de cupones, api) y T3 (vista, web) empiezan **a la vez**, cada una en su propio worktree (`.hector-workspaces/TIENDA-42/_tasks/T1`, `…/T3`). Al terminar, cada tarea pasa su compuerta de build y se fusiona en la rama de integración de su repo. T2 depende de T1, así que arranca cuando T1 ya está integrada y ve su código.

```
  $ npm run build → ok (0.2s)
  $ npm test → ok (0.4s)
  $ npm run build → ok (0.2s)
  $ npm test → ok (0.5s)
```

**Estabilización.** Build y tests completos de cada componente sobre la rama de integración. Si algo fallara, verías `▶ diagnose:api`, seguido de `· repair: back to worker T2 (resume 1/2)`: el defecto vuelve al worker que escribió ese código.

```
▶ review (attempt 1)
✔ review …
```

**Revisión.** Un revisor ve el diff de **los dos repos juntos**, para detectar contratos que no encajan. No corrige nada: sus hallazgos se enrutan a los implementadores.

```
  $ node --test --test-name-pattern="BIENVENIDA10" → ok (0.3s)
  $ node --test --test-name-pattern="ENVIO" → ok (0.3s)
  $ node --test --test-name-pattern="desconocido" → ok (0.3s)
  $ node --test --test-name-pattern="sin cupón" → ok (0.3s)
  $ node --test --test-name-pattern="descuento" → ok (0.3s)
  $ node --test --test-name-pattern="inválido" → ok (0.4s)
```

**QA.** El **código** (no un agente) ejecuta cada comando del mapa de aceptación. Así se decide, criterio por criterio, que el ticket está terminado.

```
▶ qa-plan
✔ qa-plan …
```

**Plan de pruebas manuales** para que un compañero pruebe la funcionalidad.

---

## Paso 8. Leer el resultado

Al final verás un resumen como este (el costo y el tiempo son valores de ejemplo):

```
────────────────────────────────────────────────────────────
status   completed
repo     tienda-api: hector/TIENDA-42 → /Users/tu/hector-tutorial/.hector-workspaces/TIENDA-42/tienda-api
repo     tienda-web: hector/TIENDA-42 → /Users/tu/hector-tutorial/.hector-workspaces/TIENDA-42/tienda-web
tasks    3 (max 2 in parallel)
repairs  0   review rounds 0   questions 0
cost     $2.8140   time 812s
log      /Users/tu/hector-tutorial/.hector-workspaces/_runs/TIENDA-42-2026-10-21T00-45-51-292Z-1decc4
```

| Línea | Significado |
|---|---|
| `status` | `completed`, `needs_human` o `failed`. El código de salida del proceso es 0, 3 o 1. |
| `repo` | Una línea por repo que el ticket modificó: rama y worktree donde está el resultado. |
| `tasks` | Tareas del plan y máximo de implementadores simultáneos. |
| `repairs` | Reparaciones automáticas, rondas de corrección por revisión y preguntas de los workers. |
| `cost` | Costo estimado que reporta el SDK, sumado sobre todos los agentes. |
| `log` | Carpeta de la ejecución, con todos los artefactos. |

Si algún worker preguntó algo que nadie pudo responder con fundamento, aparece una sección final **"Assumptions the workers made…"**. Revísala siempre: son decisiones que el sistema tomó solo.

Si el estado no es `completed`, ve a ["Si el resultado es distinto"](#si-el-resultado-es-distinto).

---

## Paso 9. Revisar el trabajo

Define dos atajos para no repetir rutas:

```bash
API=~/hector-tutorial/.hector-workspaces/TIENDA-42/tienda-api
WEB=~/hector-tutorial/.hector-workspaces/TIENDA-42/tienda-web
RUN=$(ls -dt ~/hector-tutorial/.hector-workspaces/_runs/TIENDA-42-* | head -1)
```

**Historia de commits.** Cada paso que edita hace su propio commit, y cada tarea se fusiona con un merge:

```bash
git -C $API log --oneline --graph main..HEAD
```

Algo así (los SHA y las descripciones de las tareas varían):

```
*   1be0ac2 merge(TIENDA-42): T2 into integration
|\
| * 5e1c0f9 feat(TIENDA-42): T2 aceptar coupon en POST /cart/quote
|/
*   0b4d2aa merge(TIENDA-42): T1 into integration
|\
| * 9a7e3c1 feat(TIENDA-42): T1 módulo src/coupons.js
|/
* 82fb411 test(TIENDA-42): acceptance tests for Cupones de descuento en el carrito
```

**El cambio completo**, como lo verías en un PR:

```bash
git -C $API diff main...HEAD
git -C $WEB diff main...HEAD
```

**Los tests**, en cada worktree:

```bash
(cd $API && npm test) && (cd $WEB && npm test)
```

**Probar la API** con el código nuevo:

```bash
(cd $API && npm start)     # en otra terminal:
curl -s -X POST localhost:3000/cart/quote -H 'content-type: application/json' \
  -d '{"items":[{"sku":"camiseta","unitPrice":1999,"quantity":2}],"coupon":"bienvenida10"}'
# {"subtotal":3998,"discount":399,"total":3599,"coupon":"BIENVENIDA10"}
```

**Los artefactos** de la ejecución:

```bash
ls $RUN/artifacts
cat $RUN/artifacts/plan.md              # las tareas, su componente y dependencias
cat $RUN/artifacts/acceptance-map.json  # criterio → comando
cat $RUN/artifacts/qa-report.json       # resultado de cada criterio
cat $RUN/artifacts/test-plan.md         # plan de pruebas manuales
cat $RUN/artifacts/ledger.json          # cada commit: paso, componente, tarea, SHA, archivos
cat $RUN/summary.json                   # resumen completo en JSON
```

Qué contiene cada uno, campo por campo: [07-observabilidad.md](07-observabilidad.md).

---

## Paso 10. Corregir algo a mano

Supón que, al revisar, decides que la regla de redondeo debe quedar documentada en el código, porque es fácil de romper. Haz el cambio **en el worktree de integración** (la rama `hector/TIENDA-42`) y commitéalo:

1. Abre `$API/src/coupons.js` (el nombre puede variar si el agente eligió otro; búscalo con `git -C $API diff --stat main...HEAD`).
2. Encima de la función que calcula el descuento, agrega:

   ```js
   /**
    * Los descuentos porcentuales se redondean hacia ABAJO al centavo (Math.floor):
    * 10 % de 3998 = 399, nunca 400. Lo exige el diseño técnico de TIENDA-42.
    */
   ```

3. Comprueba que todo sigue en verde y commitea:

   ```bash
   cd $API && npm test && git commit -am "docs: documentar la regla de redondeo de cupones"
   ```

Puedes hacer cualquier otra corrección que harías en un PR real. Lo importante es que quede **commiteada o sin commitear en el worktree de integración**: `distill` compara contra el último commit que hizo el flujo.

---

## Paso 11. Aprender de la corrección con `distill`

```bash
npm run flow -- distill --repo ~/hector-tutorial/tienda-api --ticket-id TIENDA-42
```

`distill` compara, en **cada repo**, lo que cambiaste después del último commit del flujo, y le pide a un agente que identifique qué paso causó cada error. Por ejemplo:

```
1 new guideline(s):
- [coder] Documenta con un comentario las reglas de negocio no obvias (redondeos, límites), citando el requisito que las exige.
```

El texto exacto lo redacta el agente, así que variará. La pauta queda en `~/hector-tutorial/.hector-workspaces/_lessons/tienda-api.json`:

```json
{
  "errors": [],
  "guidelines": [
    {
      "role": "coder",
      "guideline": "Documenta con un comentario las reglas de negocio no obvias (redondeos, límites), citando el requisito que las exige.",
      "evidence": "El humano agregó un comentario sobre el redondeo hacia abajo en src/coupons.js",
      "ticketId": "TIENDA-42",
      "addedAt": "2026-10-21T00:45:59.738Z"
    }
  ]
}
```

A partir de ahora, cada vez que se ejecute un implementador (`coder`), recibirá esa pauta en sus instrucciones. Es un JSON legible: puedes editar o borrar pautas a mano. Más en [08-aprendizaje.md](08-aprendizaje.md).

---

## Paso 12. Integrar las ramas

Las ramas `hector/TIENDA-42` están **en tus repos** (un worktree comparte el repo con tu checkout). En un proyecto real harías push y abrirías un PR por repo:

```bash
git -C ~/hector-tutorial/tienda-api push -u origin hector/TIENDA-42
git -C ~/hector-tutorial/tienda-web push -u origin hector/TIENDA-42
```

En el tutorial no hay remoto, así que fusiona en local:

```bash
git -C ~/hector-tutorial/tienda-api merge --no-ff hector/TIENDA-42 -m "TIENDA-42: cupones"
git -C ~/hector-tutorial/tienda-web merge --no-ff hector/TIENDA-42 -m "TIENDA-42: cupones"
```

---

## Paso 13. Limpiar

```bash
npm run flow -- clean --repo ~/hector-tutorial/tienda-api --ticket-id TIENDA-42
```

```
removed worktree /Users/tu/hector-tutorial/.hector-workspaces/TIENDA-42/tienda-api
removed worktree /Users/tu/hector-tutorial/.hector-workspaces/TIENDA-42/tienda-web
deleted branch   tienda-api:hector/TIENDA-42
deleted branch   tienda-web:hector/TIENDA-42
```

`clean` borra los worktrees y las ramas del ticket (`hector/<ID>` y `hector-tasks/<ID>/*`) en todos los repos de los componentes. **Conserva** los logs (`_runs/`) y las lecciones (`_lessons/`). Si no fusionaste ni hiciste push, el trabajo de esas ramas se pierde.

Para repetir el tutorial desde cero, borra `~/hector-tutorial` y vuelve al paso 2.

---

## Si el resultado es distinto

| Estado y mensaje | Qué pasó | Qué hacer |
|---|---|---|
| `needs_human` · `the diagnosis says the problem is in the test` | Un test bloqueado contradice el ticket, según el diagnóstico. | Abre el test en el worktree de integración. Si está mal, corrígelo, commitea y termina tú el trabajo. Si está bien, el diagnóstico se equivocó: termina a mano y considera `distill`. |
| `needs_human` · `…problem is in the environment` | Falta una herramienta, una dependencia o un servicio. | Arregla el entorno, ejecuta `clean` y vuelve a `run`. |
| `needs_human` · `still failing after N repair attempts` | Se agotó `repairAttempts`. | Revisa `events.jsonl` y los artefactos `diagnose_*.json`. Termina a mano o sube el límite. |
| `needs_human` · `does not build and its worker has no retries left` | Una tarea no compila en su worktree. | El worktree de la tarea se conserva en `_tasks/<Tn>`: revísalo ahí. |
| `needs_human` · `conflicts with work integrated in parallel` | Dos tareas paralelas chocaron y el worker no pudo resolverlo. | Revisa el plan: probablemente dos tareas paralelas tocan el mismo archivo. |
| `needs_human` · `review still reports blockers` | Los criterios pasan, pero el revisor mantiene bloqueantes tras las rondas permitidas. El trabajo está commiteado. | Lee los bloqueantes en el resumen y decide. |
| `failed` · `Branch hector/TIENDA-42 already exists` | Quedó una ejecución anterior. | `clean` y vuelve a `run`. |
| `failed` · `has uncommitted changes` | Un repo de un componente no está limpio. | Commitea o guarda tus cambios (`git stash`). |
| `failed` · `Acceptance map … outside allowedCommands` | El autor de tests propuso un comando no permitido. | Agrega el prefijo a `allowedCommands` si es seguro, o deja una pauta con `distill`. |
| `failed` · `<paso>: Agent failed: error_max_turns` o `error_max_budget_usd` | Un agente agotó turnos o presupuesto. | Sube `maxTurnsPerAgent` o `maxBudgetUsdPerAgent`, o divide el ticket. |

Detalle de todos los mensajes en [10-problemas.md](10-problemas.md).

---

## Experimentos para entender el flujo

Cada uno empieza con `clean` y vuelve a `run`.

1. **Sin paralelismo.** Pon `"maxParallel": 1` y compara el tiempo total y la línea `max 1 in parallel`.
2. **Provocar una pregunta.** Borra del ticket la frase "El código no distingue mayúsculas de minúsculas". Es probable que un worker use `ask`; si nadie puede responder con fundamento, aparecerá en "Assumptions…".
3. **Provocar un conflicto.** Quita "(depende de la 1)" de la subtarea 2 y pide en ambas subtareas de la API que editen `src/routes.js`. Verás `conflicts in T2: src/routes.js — back to its worker`.
4. **Ver la guarda de archivos no declarados.** Pon `"undeclaredFiles": "commit"` y busca en `ledger.json` el campo `undeclared`.
5. **Ver el aislamiento.** Pide en la subtarea 3 que "también actualice la API". El worker de `web` no podrá escribir en `tienda-api`; verás `denied Write` en el log.

---

## Siguiente: el bucle continuo

En lugar de ejecutar `run` ticket a ticket, puedes dejar que hector-flow tome los tickets de una carpeta, de GitHub Issues o de Azure DevOps y espere tu aprobación para fusionar. Hay un recorrido con estos mismos repos en [15-backlog-y-bucle.md](15-backlog-y-bucle.md#recorrido-con-los-repos-del-tutorial).

## Llevarlo a tu proyecto real

1. Copia `examples/multi-component.config.json` a tu repo principal como `hector-flow.config.json` (o `examples/hector-flow.config.json` si es un solo repo).
2. Define un componente por capa: `repo`, `path`, comandos y `description`.
3. Ajusta `lockedPaths` a donde viven tus tests. En .NET suelen estar en un proyecto aparte: por ejemplo, `"lockedPaths": ["../../tests/Api.Tests/**"]` para un componente en `src/Api`.
4. Pon en `allowedCommands` exactamente lo que un desarrollador ejecuta para compilar y probar, y nada más.
5. Agrega un `CLAUDE.md` en cada repo con tus convenciones.
6. Ejecuta `check` hasta que todo esté en ✔.
7. Empieza con un ticket pequeño, `maxParallel: 1` y `maxBudgetUsdPerAgent` bajo. Sube los límites cuando confíes en el resultado.
8. Después de cada ticket que corrijas a mano, ejecuta `distill`.
