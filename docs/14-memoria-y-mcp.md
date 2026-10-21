# 14. Memoria persistente y servidores MCP

Las pautas de `distill` ([08-aprendizaje.md](08-aprendizaje.md)) corrigen **cómo trabaja** cada paso. La **memoria** guarda **lo que se sabe del repositorio**: decisiones, descubrimientos, convenciones y trampas que un ticket encontró y que el siguiente debería conocer. Es el equivalente a Engram en gentle-ai o al "Brain" de Noodle, integrado en el flujo y sin instalar nada.

| | Pautas (`distill`) | Memoria |
|---|---|---|
| Qué guarda | Instrucciones para un rol ("documenta las reglas de redondeo") | Conocimiento del código ("los importes son centavos enteros porque…") |
| Quién lo escribe | `distill`, a partir de tus correcciones | Los propios agentes, durante el trabajo |
| Cómo se usa | Siempre, en el system prompt del rol | Bajo demanda (`memory_search`) y automáticamente en `enrich` |
| Archivo | `_lessons/<repo>.json` | `_memory/<repo>.jsonl` |

## Cómo funciona

1. **Durante un ticket**, los agentes de ciertos pasos tienen dos herramientas MCP propias:
   - `memory_search(query, limit?)`: busca en la memoria del repo.
   - `memory_save(title, content, kind, tags?, files?)`: registra algo que los próximos tickets deberían saber. `kind` es `decision`, `discovery`, `convention` o `gotcha`.
2. Lo que se guarda en una ejecución es **provisional**: esa misma ejecución lo ve, las demás no.
3. **Si la ejecución termina en `completed`**, sus memorias pasan a **validadas**. Si termina en `needs_human` o `failed`, quedan provisionales para que las revises, pero **nunca** se le muestran a otro ticket. Así, un intento fallido no le enseña algo equivocado al siguiente.
4. **Al empezar cada ticket**, `enrich` recibe las memorias validadas más relevantes para el título y los criterios del ticket (5 por defecto), con la indicación de verificarlas contra el código.

### Qué pasos tienen qué herramientas

| Paso | `memory_search` | `memory_save` |
|---|---|---|
| `enrich` | ✔ | ✔ (descubrimientos) |
| `plan` | ✔ | |
| `testAuthor` | ✔ | |
| `coder` | ✔ | ✔ (decisiones, trampas) |
| `diagnose` | ✔ | ✔ (causas raíz) |
| `review` | ✔ | |
| `lead` | ✔ | |
| `qaPlan`, `distill` | | |

Se cambia con `memory.search` y `memory.save` en la config.

### La búsqueda

Es una búsqueda **por palabras clave** (tf-idf sobre título, contenido, etiquetas y archivos, con el título valiendo el doble), sin distinguir mayúsculas ni acentos, y sin palabras vacías en español e inglés. No es semántica: un ticket "Add mul" no encontrará una memoria sobre "math.js" si no comparten palabras. Los tickets que nombran componentes, archivos y conceptos concretos recuperan mejor. Si necesitas búsqueda semántica, conecta Engram u otro servidor como se explica abajo.

Una memoria idéntica (mismo título y contenido, sin distinguir mayúsculas ni espacios) a una ya validada no se guarda de nuevo.

## Configuración

```json
"memory": {
  "enabled": true,
  "search": ["enrich", "plan", "testAuthor", "coder", "diagnose", "review", "lead"],
  "save": ["enrich", "coder", "diagnose"],
  "injectIntoEnrich": 5
}
```

| Campo | Por defecto | Descripción |
|---|---|---|
| `enabled` | `true` | `false` desactiva las herramientas y la inyección en `enrich`. |
| `search` | ver arriba | Pasos con `memory_search`. |
| `save` | `enrich`, `coder`, `diagnose` | Pasos con `memory_save`. |
| `injectIntoEnrich` | `5` | Memorias relevantes que recibe `enrich`. `0` lo desactiva. |

## Revisar y editar la memoria

```bash
npm run flow -- memory --repo ~/code/api                     # validadas
npm run flow -- memory --repo ~/code/api list --all          # incluye provisionales
npm run flow -- memory --repo ~/code/api search retry service bus
npm run flow -- memory --repo ~/code/api forget 3f2a9c1d 77b0e4aa
```

```
3f2a9c1d          [convention] Montos en centavos  — TIENDA-42, coder
77b0e4aa  (prov.) [decision] div needs no zero check  — F-1, coder

2 entries · /Users/tu/code/.hector-workspaces/_memory/tienda-api.jsonl
```

El archivo es JSON por líneas: una entrada por línea, con `id`, `title`, `content`, `kind`, `tags`, `files`, `ticketId`, `runId`, `role`, `createdAt` y `status` (`provisional` o `validated`). Puedes editarlo a mano, versionarlo o compartirlo.

Revísala de vez en cuando: la memoria envejece con el código. Borra (`forget`) lo que ya no sea cierto. Lo que se confirme como convención permanente estará mejor en el `CLAUDE.md` del repo o en una skill.

---

## Servidores MCP externos por paso

Además de sus herramientas propias (`ask`, `memory_search`, `memory_save`), los agentes pueden usar **servidores MCP externos**, por ejemplo:

- **Engram**, si prefieres su memoria (búsqueda de texto completo, sincronización con git) o quieres compartirla con tu uso diario de Claude Code.
- **Context7**, para documentación actualizada de librerías y frameworks.
- Un servidor propio de tu empresa (catálogo de APIs, esquemas de APIM, runbooks).

Se definen una vez en `mcpServers`, con el mismo formato que Claude Code, y se asignan a los pasos con `mcpAccess`. **Un paso solo ve los servidores que tiene asignados**; cualquier otra herramienta MCP se niega.

```json
"mcpServers": {
  "context7": { "type": "http", "url": "https://mcp.context7.com/mcp" },
  "engram":   { "command": "engram", "args": ["mcp"] }
},
"mcpAccess": {
  "enrich": ["context7", "engram"],
  "plan":   ["engram"],
  "coder":  ["context7", "engram"],
  "review": ["context7"]
}
```

| Tipo de servidor | Campos |
|---|---|
| Proceso local (stdio) | `command`, `args?`, `env?` (`type: "stdio"` opcional) |
| Remoto | `type: "http"` o `"sse"`, `url`, `headers?` |

- El nombre `hector` está reservado para las herramientas propias.
- `check` falla si `mcpAccess` nombra un servidor que no existe en `mcpServers`.
- Las herramientas de un servidor se llaman `mcp__<servidor>__<herramienta>`; en el log, una negación aparece como `denied mcp__engram__… — MCP server "engram" is not available to this step`.
- Los servidores MCP que traigan los **plugins** (`pluginDirs`) no se cargan: solo cuentan los de `mcpServers`.

Consulta la documentación de cada servidor para el comando exacto: los ejemplos de arriba son orientativos.

### Seguridad

Un servidor MCP es código que corre con tus permisos (stdio) o un servicio externo que recibe lo que el agente le envía (http). Las reglas de lectura de hector-flow (`readDenyPaths`, carpetas legibles) **no se aplican dentro** de un servidor MCP: si un servidor puede leer archivos, lee lo que su propia configuración le permita. Da acceso solo a los pasos que lo necesitan, y prefiere servidores de solo lectura. Ver [06-seguridad.md](06-seguridad.md).
