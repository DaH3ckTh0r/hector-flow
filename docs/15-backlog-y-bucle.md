# 15. Backlog y bucle continuo

Con `run` implementas un ticket cuando tú decides. Con `start`, hector-flow **toma los tickets de un backlog uno tras otro** y, según el modo, te deja las ramas, espera tu aprobación o las fusiona solo. Es el bucle de Noodle aplicado a este flujo.

```
backlog (carpeta, GitHub, Azure DevOps)
   │  siguiente ticket listo que el bucle no haya tocado
   ▼
implementTicket (todo el flujo de siempre)
   │
   ├─ manual      → completed        (las ramas quedan para ti)
   ├─ supervised  → awaiting_review  (esperando approve / reject)
   └─ auto        → fusión verificada → merged, o merge_failed (con reversión)
   │
   └─ comentario en el ticket de origen (GitHub / Azure DevOps)
```

## Backlogs

Se configura en la sección `backlog` de la config. Cada adaptador convierte sus elementos en el mismo ticket markdown de siempre ([04-tickets.md](04-tickets.md)), así que las reglas de criterios de aceptación son las mismas: **un elemento sin criterios de aceptación se omite** (el bucle lo informa una vez y sigue).

### Carpeta

```json
"backlog": { "type": "folder", "path": "../tickets" }
```

- Cada archivo `.md` de la carpeta (sin subcarpetas) es un ticket. Se procesan **por orden de nombre**: usa prefijos (`001-…`, `002-…`) si el orden importa.
- `path` es relativo al repo principal, o absoluto.
- **Recomendación:** pon la carpeta **fuera** de los repos de los componentes. Un ticket nuevo sin commitear deja el repo "sucio", y el flujo exige repos limpios. Si la quieres dentro, commitea cada ticket al agregarlo. `check` te avisa de este caso.
- No publica comentarios: el estado se consulta con `status`.

### GitHub Issues

```json
"backlog": { "type": "github", "repo": "acme/shop", "label": "hector", "tokenEnv": "GITHUB_TOKEN", "comment": true }
```

| Campo | Por defecto | Descripción |
|---|---|---|
| `repo` | — | `owner/nombre` |
| `label` | `hector` | Solo issues **abiertos** con esta etiqueta, del más antiguo al más nuevo (hasta 50). Los pull requests se ignoran. |
| `tokenEnv` | `GITHUB_TOKEN` | Variable de entorno con un token con permiso de lectura de issues (y escritura, si `comment` es `true`). |
| `comment` | `true` | Publica el resultado como comentario en el issue. |

- ID del ticket: `GH-<número>`. Título: el del issue. Cuerpo: el del issue, tal cual (markdown). Los criterios salen de su sección `## Acceptance criteria` o `## Criterios de aceptación`; las casillas `- [ ]` cuentan como viñetas.

### Azure DevOps

```json
"backlog": {
  "type": "azure-devops",
  "organization": "contoso",
  "project": "Integrations",
  "tag": "hector",
  "states": ["New", "Approved", "Committed", "To Do", "Active"],
  "tokenEnv": "AZURE_DEVOPS_PAT",
  "comment": true
}
```

| Campo | Por defecto | Descripción |
|---|---|---|
| `organization`, `project` | — | Los de `dev.azure.com/<organization>/<project>`. |
| `tag` | `hector` | Solo work items con esta etiqueta… |
| `states` | `New`, `Approved`, `Committed`, `To Do`, `Active` | …en uno de estos estados. |
| `wiql` | — | Consulta WIQL completa en lugar de `tag` + `states`. Debe seleccionar `[System.Id]`. |
| `tokenEnv` | `AZURE_DEVOPS_PAT` | Variable con un Personal Access Token con **Work Items: Read & write**. |
| `comment` | `true` | Publica el resultado como comentario en el work item. |

- ID del ticket: `ADO-<id>`. El cuerpo se arma con **Description**, convertida de HTML a markdown (títulos, listas, párrafos, entidades).
- Los criterios salen del campo **Acceptance Criteria** (cada elemento de lista o línea es un criterio). Si está vacío, se buscan en la descripción.
- La consulta por defecto es:

  ```sql
  SELECT [System.Id] FROM WorkItems
  WHERE [System.TeamProject] = @project
    AND [System.Tags] CONTAINS 'hector'
    AND [System.State] IN ('New', 'Approved', 'Committed', 'To Do', 'Active')
  ORDER BY [System.Id] ASC
  ```

## Modos

| Modo | Si el ticket termina en `completed` | Para qué |
|---|---|---|
| `manual` | Queda `completed`: las ramas `hector/<ID>` son tuyas. | Empezar; usar el bucle solo como cola. |
| `supervised` (por defecto) | Queda `awaiting_review` hasta que ejecutes `approve` o `reject`. | El día a día: el sistema trabaja, tú decides qué entra. |
| `auto` | Se fusiona en la rama base de cada repo, se verifica y, si algo falla, se revierte. | Repos con buena cobertura de tests, cuando confías en el resultado. |

Si el ticket termina en `needs_human` o `failed`, queda en ese estado en cualquier modo.

En `auto`, un ticket con **supuestos abiertos** no se fusiona: queda `awaiting_review` con el motivo `N open assumption(s): review before merging`. Se desactiva con `loop.autoMergeRequiresNoAssumptions: false`.

## La fusión (`auto` y `approve`)

1. **Comprobaciones previas en todos los repos, antes de tocar nada:** cada checkout está **en su rama base** (la que estaba activa cuando empezó el ticket) y **limpio**. Si alguno no cumple, no se fusiona nada.
2. **Merge** de `hector/<ID>` en la rama base de cada repo, en tus checkouts, con un commit `merge(<ID>): <título>`. Si hay conflictos, se aborta y **se revierten** los repos ya fusionados.
3. **Verificación del resultado fusionado:** build, tests y lint de cada componente de los repos afectados. Hace falta porque otros tickets pueden haberse fusionado desde que este empezó.
4. Si algo falla, **todos los repos vuelven** al commit exacto en que estaban (`git reset --hard` a ese commit; es seguro porque se exigió que estuvieran limpios). El ticket queda `merge_failed` y su rama se conserva.
5. Si todo pasa: `merged`, y se borran los worktrees y ramas del ticket.

hector-flow **no hace push**. Después de fusionar, sube la rama base cuando quieras (o hazlo desde tu CI).

## Estados de un ticket

| Estado | Significado | Siguiente acción posible |
|---|---|---|
| `running` | En curso. Si el bucle se detuvo de golpe, el siguiente `start` lo **reanuda primero** ([18-ejecuciones-durables.md](18-ejecuciones-durables.md#en-el-bucle)) | — |
| `completed` | Terminado (modo `manual`) | `approve`, `reject` |
| `awaiting_review` | Terminado, esperando decisión | `approve`, `reject` |
| `merged` | Fusionado | — |
| `merge_failed` | La fusión falló y se revirtió | `approve` (reintenta), `reject`, `requeue` |
| `rejected` | Descartado; ramas borradas | `requeue` |
| `needs_human` | El flujo se detuvo para que decidas | `resume` (CLI), `reject`, `requeue` |
| `failed` | Error | `resume` (CLI), `reject`, `requeue` |

**Un ticket con estado nunca se vuelve a tomar** hasta que ejecutes `requeue`. Así, un fallo no se convierte en un bucle de reintentos que consume presupuesto.

## Comandos

```bash
npm run flow -- start   --repo ~/code/api [--mode manual|supervised|auto] [--once] [--max <n>]
npm run flow -- status  --repo ~/code/api
npm run flow -- approve --repo ~/code/api TIENDA-42
npm run flow -- reject  --repo ~/code/api TIENDA-42 --reason "el diseño cambió"
npm run flow -- requeue --repo ~/code/api TIENDA-42
```

| Comando | Qué hace |
|---|---|
| `start` | Arranca el bucle. Sin `--once`, cuando no hay nada que hacer espera `loop.intervalSeconds` (60 por defecto) y vuelve a mirar. **Ctrl+C** una vez termina el ticket en curso y sale; dos veces sale de inmediato. |
| `start --once` | Procesa todo lo que esté listo y termina. Útil en un cron o un pipeline. |
| `start --max <n>` | Se detiene tras `n` tickets. |
| `status` | Lista los tickets del bucle con su estado, fecha y motivo. |
| `approve <ID>` | Fusiona un ticket `awaiting_review`, `completed` o `merge_failed` (ver "La fusión"). Código de salida 0 si quedó `merged`, 1 si no. |
| `reject <ID>` | Borra sus worktrees y ramas y lo marca `rejected`. `--reason` se publica en el ticket de origen. |
| `requeue <ID>` | Borra sus ramas y olvida su estado: el próximo `start` lo vuelve a ejecutar. |

Solo puede correr **un bucle por repo principal** a la vez: se usa un archivo de bloqueo con el PID. Si el proceso murió, el siguiente `start` toma el bloqueo.

## Lo que se publica en el ticket de origen

Con `comment: true`, después de cada ticket (y de cada `approve`/`reject`) se publica algo así:

```
**hector-flow** · GH-12 → completed — awaiting approval

- shop-api: `hector/GH-12`
- shop-web: `hector/GH-12`

Open assumptions:
- ¿El cupón distingue mayúsculas? → Not specified; treat as case-insensitive.

Cost ≈ $2.81 · 812s · run GH-12-2026-10-21T00-45-51-292Z-1decc4
```

Si publicar falla (token sin permisos, red), el bucle lo registra como aviso y sigue.

## Recorrido con los repos del tutorial

Parte de una instalación nueva del tutorial ([09-tutorial.md](09-tutorial.md), pasos 1 y 2).

1. Crea la carpeta de tickets **fuera** de los repos y copia el ticket:

   ```bash
   mkdir ~/hector-tutorial/tickets
   cp ~/hector-tutorial/TIENDA-42.md ~/hector-tutorial/tickets/
   ```

2. Agrega a `~/hector-tutorial/tienda-api/hector-flow.config.json`:

   ```json
   "backlog": { "type": "folder", "path": "../tickets" },
   "loop": { "mode": "supervised" }
   ```

   y commitea: `git -C ~/hector-tutorial/tienda-api commit -am "hector-flow: backlog"`.

3. Comprueba: `npm run flow -- check --repo ~/hector-tutorial/tienda-api`.

4. Procesa lo que haya:

   ```bash
   npm run flow -- start --repo ~/hector-tutorial/tienda-api --once
   ```

   ```
   hector-flow loop · folder backlog · mode supervised · once

   ▶ TIENDA-42: Cupones de descuento en el carrito  (/Users/tu/hector-tutorial/tickets/TIENDA-42.md)
   … (la salida del flujo)
     → awaiting_review

   Loop finished: 1 ticket(s) processed.
     TIENDA-42      awaiting_review
   ```

5. Revisa el trabajo como en el paso 9 del tutorial, y luego:

   ```bash
   npm run flow -- status  --repo ~/hector-tutorial/tienda-api
   npm run flow -- approve --repo ~/hector-tutorial/tienda-api TIENDA-42
   ```

   ```
     · merged hector/TIENDA-42 into tienda-api:main
     · merged hector/TIENDA-42 into tienda-web:main
     $ npm run build (api, merged) → ok
     $ npm test (api, merged) → ok
     $ npm run build (web, merged) → ok
     $ npm test (web, merged) → ok
   TIENDA-42 → merged
   ```

   `main` de ambos repos tiene ya los cupones, y las ramas del ticket se borraron.

## Ejecutarlo de forma desatendida

`start` (sin `--once`) se puede dejar corriendo en una máquina que no apagues, por ejemplo una VM o un servidor propio (como sugiere el video). Opciones:

- **Servicio** (`systemd`, `launchd`, un contenedor) que ejecute `hector-flow start --repo …`.
- **Programado**: `hector-flow start --repo … --once` cada cierto tiempo desde cron o un pipeline.

En ambos casos, configura `notifyCommand` ([03-configuracion.md](03-configuracion.md#notifycommand--string-opcional)) para enterarte de cada resultado, y usa `supervised` hasta que confíes en el sistema.
