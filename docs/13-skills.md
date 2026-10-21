# 13. Skills de los pasos: personalizar lo que hace cada agente

Cada paso del flujo (`enrich`, `plan`, `testAuthor`, `coder`, `diagnose`, `review`, `qaPlan`, `lead`, `distill`) recibe sus instrucciones de una **skill**: un archivo `SKILL.md`. El código decide *cuándo* corre un paso y *qué puede tocar*; la skill decide *cómo piensa el agente su trabajo*. Para cambiar el comportamiento de un paso editas un markdown, no TypeScript.

Es el modelo de extensión que usan herramientas como gentle-ai y Noodle, adaptado a hector-flow: las skills moldean a los agentes, mientras el flujo, los permisos y el criterio de "terminado" siguen en el código.

## Dónde viven

```
<carpeta>/
├── _shared/
│   └── RULES.md          ← se antepone a todos los pasos (opcional)
├── enrich/SKILL.md
├── plan/SKILL.md
├── testAuthor/SKILL.md
├── coder/SKILL.md
├── diagnose/SKILL.md
├── review/SKILL.md
├── qaPlan/SKILL.md
├── lead/SKILL.md
└── distill/SKILL.md
```

Para **cada archivo**, hector-flow usa el primero que encuentra en este orden:

| Orden | Carpeta | Tipo | Úsala para |
|---|---|---|---|
| 1 | Cada carpeta de `skillDirs` (config), en orden, relativa al repo principal | `config` | Skills compartidas por un equipo, o fuera de la carpeta `.hector/` |
| 2 | `<repo principal>/.hector/skills` | `repo` | Las personalizaciones de este repo, commiteadas con el código |
| 3 | `skills/` dentro de hector-flow | `builtin` | Las de serie |

Solo sobrescribes lo que necesitas: si existe `.hector/skills/coder/SKILL.md`, el implementador la usa y los demás pasos siguen con la de serie. `RULES.md` se resuelve igual.

## Anatomía de un `SKILL.md`

```markdown
---
name: coder
description: Implementa una tarea en un componente.
model: sonnet
effort: medium
skills:
  - xunit-tests
  - acme:style
rules: true
---

Role: implementer of ONE task in ONE component. …
(las instrucciones que recibe el agente)
```

### Front-matter (todo opcional)

| Clave | Tipo | Efecto |
|---|---|---|
| `name` | texto | Informativo. **Decide la carpeta**; si `name` no coincide, se avisa. |
| `description` | texto | Informativo; lo muestra `skills list`. |
| `model` | texto | Modelo por defecto del paso (`opus`, `sonnet`, `haiku` o un ID completo). `models.<rol>` de la config **lo sobrescribe**. |
| `effort` | `low` `medium` `high` `xhigh` `max` | Esfuerzo por defecto. `efforts.<rol>` de la config **lo sobrescribe**. Un valor inválido se ignora con un aviso. |
| `skills` | lista | **Skills de Claude Code** que puede usar el paso (ver abajo). Se combina con `claudeSkills.<rol>` de la config. |
| `rules` | `true` / `false` | `false` omite `_shared/RULES.md` en este paso. Por defecto `true`. |

Las listas pueden escribirse como `skills: [a, b]` o con un `- elemento` por línea. Una clave desconocida produce un aviso, no un error.

### Cuerpo

Todo lo que sigue al front-matter son las instrucciones del paso. El system prompt del agente se arma así:

```
<_shared/RULES.md>          (salvo rules: false)

<cuerpo del SKILL.md>

<guidelines_from_past_corrections>   (solo si distill agregó pautas para este rol)
```

La **tarea concreta** (el ticket, el plan, el diff, la salida del fallo…) no va en la skill: el código la arma en cada llamada y la envía como prompt. Una skill debe describir el criterio y los estándares del rol, no repetir la tarea.

## Qué puede y qué no puede cambiar una skill

| Una skill PUEDE cambiar | Una skill NO PUEDE cambiar |
|---|---|
| Cómo aborda el agente su trabajo, qué prioriza, sus estándares | El orden de los pasos, los reintentos, cuándo parar |
| El modelo y el esfuerzo por defecto | Qué puede leer, escribir o ejecutar el agente (los permisos son código) |
| Qué skills de Claude Code puede usar | El JSON que debe devolver el paso (el contrato es código) |
| Si aplican las reglas compartidas | Si el ticket está terminado (los comandos de aceptación corren en código) |

Por eso una skill nunca le da más poder a un agente: una skill de `coder` que diga *"edita los tests si hace falta"* sigue sin poder escribir un test bloqueado.

## Personalizar: `skills eject`

Parte de la versión de serie en lugar de un archivo vacío:

```bash
npm run flow -- skills --repo ~/code/api eject coder review
# created  /Users/tu/code/api/.hector/skills/coder/SKILL.md
# created  /Users/tu/code/api/.hector/skills/review/SKILL.md
```

`eject all` copia todos los pasos y `_shared/RULES.md`. Nunca sobrescribe un archivo existente (lo indica con `exists`). Edita los archivos y **commitéalos**: el repo debe estar limpio para ejecutar, y así las skills viajan con el código.

## Inspeccionar: `skills list`

```bash
npm run flow -- skills --repo ~/code/api
```

```
enrich      builtin  /…/hector-flow/skills/enrich/SKILL.md
                     model sonnet (config)
coder       repo     /Users/tu/code/api/.hector/skills/coder/SKILL.md
                     model haiku (skill) · effort high (config) · skills xunit-tests, node-testing
review      config   /Users/tu/code/api/team-skills/review/SKILL.md
…
_shared     RULES.md /…/hector-flow/skills/_shared/RULES.md
```

Muestra, por paso, el archivo en uso, su tipo (`builtin`, `repo`, `config`), el modelo y el esfuerzo efectivos con su origen, las skills de Claude y los avisos. `check` también informa qué pasos están personalizados y cualquier aviso de skills.

## Skills de Claude Code dentro de un paso

Aparte de las skills de los pasos, un agente puede usar **skills de Claude Code** (carpetas con su propio `SKILL.md` que Claude carga cuando las necesita), por ejemplo "cómo escribimos tests xUnit" o "convenciones de nuestra API".

Se asignan en cualquiera de estos dos lugares, y las listas se combinan:

```markdown
---
skills:
  - xunit-tests
---
```

```json
"claudeSkills": {
  "testAuthor": ["xunit-tests"],
  "coder": ["dotnet-conventions", "acme:api-style"],
  "review": ["security-review"]
}
```

- Los nombres son el nombre de la carpeta de la skill, o `plugin:skill` si está dentro de un plugin.
- Un paso recibe **solo** sus skills. Un paso sin skills recibe una lista vacía explícita, así que las skills instaladas en tu máquina o en `.claude/skills` nunca se cuelan en pasos que no las pidieron.
- La herramienta `Skill` solo se permite en los pasos que tienen skills.

Dónde las busca Claude:

- Skills de proyecto en `.claude/skills/` de cada repo (se cargan si `loadProjectSettings` es `true`).
- **Plugins** listados en `pluginDirs` (relativos al repo principal): cada uno es una carpeta con `.claude-plugin/plugin.json` y una carpeta `skills/`. Solo se usan sus skills: los servidores MCP del plugin no se cargan, y sus agentes no pueden ejecutarse porque los subagentes están desactivados.

```json
"pluginDirs": ["../acme-claude-plugin"]
```

## Skills y `distill`

`distill` agrega **pautas** cortas a un rol (ver [08-aprendizaje.md](08-aprendizaje.md)), que se añaden después del cuerpo de la skill. Con el tiempo, revísalas y pasa las que demostraron ser correctas a la propia skill, borrándolas después del archivo de lecciones. Las pautas son arreglos rápidos; la skill es la versión curada.

## Ejemplos

**Un implementador que sigue tus convenciones .NET**

```markdown
---
model: sonnet
effort: medium
skills: [dotnet-conventions]
---
Role: implementer of ONE task in ONE component (C#, .NET 9).

- Follow the existing layering: Controllers → Services → Repositories. Never call a repository from a controller.
- Use primary constructors and `required` members as the surrounding code does.
- Every public method you add gets XML documentation.
- List in `changedFiles` every file you touched; use the `ask` tool before guessing business rules.
```

**Un planificador más estricto para trabajo de integración**

```markdown
---
model: opus
effort: high
---
Role: planner. …
When a task touches an external API (APIM, Service Bus, Event Grid), the task description must name the exact
endpoint/topic, the payload schema and the expected retry/idempotency behavior.
```

**Un juez de seguridad:** combina una skill `review` personalizada con los jueces de la config (ver [03-configuracion.md](03-configuracion.md#review--revisión-por-varios-jueces)). La skill fija los estándares comunes a todos los jueces; el `focus` de cada juez dirige su atención.

## Problemas frecuentes

| Mensaje | Causa | Solución |
|---|---|---|
| `No SKILL.md found for step "x"` | Ninguna carpeta del orden de búsqueda tiene `x/SKILL.md` (solo pasa si se borró la carpeta `skills/` de hector-flow). | Restaura `skills/` de hector-flow o crea el archivo en `.hector/skills`. |
| `⚠ skill x: unknown front-matter key "…"` | Error tipográfico o clave no admitida. | Usa solo las claves de la tabla. |
| `⚠ skill x: front-matter name "…" does not match its folder` | El archivo se copió a la carpeta de otro paso. | Corrige `name` o ignóralo: decide la carpeta. |
| `⚠ skill x: invalid effort "…"` | Esfuerzo fuera de la lista. | Usa `low`, `medium`, `high`, `xhigh` o `max`. |
| `denied Skill — No skills are enabled for this step` | El agente intentó usar una skill que no se le dio. | Agrégala a `skills` del paso o a `claudeSkills.<rol>`. |
| `✖ plugin folder … exists` (en `check`) | Una entrada de `pluginDirs` apunta a una carpeta inexistente. | Corrige la ruta (relativa al repo principal). |
