# 11. Arquitectura y cómo extenderlo

## Mapa del código

```
src/
├── cli.ts                 Punto de entrada: check, run, distill, clean
├── config.ts              Esquema zod de la configuración y carga del archivo
├── components.ts          Resuelve componentes: repo, carpeta, globs y comandos efectivos
├── ticket.ts              Lee el ticket markdown (sin modelo)
├── workflow.ts            EL FLUJO: preparación, fases, enrutamiento, reparación, cierre
├── scheduler.ts           Grafo de tareas con dependencias y tope de concurrencia
├── mutex.ts               Serializa operaciones de git por repo
├── schemas.ts             Contratos zod de la salida de cada agente
├── skills.ts              Carga de skills de los pasos: orden de búsqueda, front-matter, eject
├── prompts.ts             systemPrompt (skill + pautas) y el prompt de cada paso
├── guards.ts              Globs, PathPolicy (escritura), ReadPolicy (lectura), allowlist de comandos
├── lessons.ts             Pautas y lecciones de error
├── memory.ts              Memoria persistente: guardar, buscar (tf-idf), validar por ejecución
├── backlog.ts             Adaptadores de backlog: carpeta, GitHub Issues, Azure DevOps
├── loop.ts                Bucle continuo, estado, bloqueo, modos, fusión verificada, approve/reject/requeue
├── distill.ts             Comando distill
├── check.ts               Comando check
├── clean.ts               Comando clean
├── log.ts                 events.jsonl y artefactos
├── runner/
│   ├── agent-runner.ts    Interfaz AgentRunner: la frontera entre el flujo y la IA
│   └── claude-runner.ts   Implementación con el Claude Agent SDK; decide() en hook PreToolUse y canUseTool
└── tools/
    ├── git.ts             Worktrees, commits exactos, merges, reversiones
    └── shell.ts           Ejecución de comandos con timeout y salida acotada

skills/                    Skills de serie: _shared/RULES.md y <rol>/SKILL.md

test/
├── helpers.ts             ScriptedRunner: un AgentRunner falso, determinista
├── runner-policy.ts       Reglas de permisos del runner real
├── e2e.ts                 17 escenarios del flujo
├── loop.ts                Memoria, acceso MCP, adaptadores (HTTP simulado) y el bucle
└── tutorial.ts            El tutorial de punta a punta
```

## Principios de diseño

1. **El código decide; las skills describen; los agentes razonan.** `workflow.ts` contiene todo el control: orden, bucles, topes, enrutamiento y criterio de terminado. Ningún agente decide qué paso viene después. Las instrucciones de cada rol viven en su `SKILL.md`, no en el código, así que se iteran sin tocar TypeScript.
2. **Un agente, una responsabilidad, un contexto limpio.** Cada paso es una sesión nueva (salvo cuando se retoma a propósito la de un worker) que recibe solo lo que necesita.
3. **Todo agente devuelve JSON con contrato.** Se valida dos veces: con JSON Schema en el SDK y con zod en el runner.
4. **Confiar en git, no en lo que afirma el agente.** Los archivos del ledger, las reversiones y los commits se calculan con git.
5. **Defensa en profundidad.** Permisos antes de cada herramienta y revisiones de git después de cada paso.
6. **La IA es intercambiable.** El flujo solo conoce `AgentRunner`.

## La interfaz `AgentRunner`

```ts
interface AgentRunner {
  run<S extends z.ZodType>(req: AgentRequest<S>): Promise<AgentResult<z.infer<S>>>;
}

interface AgentRequest<S> {
  role: Role;                      // enrich | plan | testAuthor | coder | diagnose | review | qaPlan | lead | distill
  mode: "readonly" | "edit" | "tests";
  cwd: string;                     // carpeta del componente dentro del worktree
  systemPrompt: string;            // instrucciones del rol + pautas
  prompt: string;
  schema: S;                       // contrato zod de la salida
  resumeSessionId?: string;        // retomar la sesión de un worker
  ask?: (q: string) => Promise<string>;  // exponer la herramienta ask
  scope?: AgentScope;              // root, writeRoot, lockedPaths, testPaths, allowedCommands
  readDirs?: string[];             // carpetas extra de solo lectura
  model?: string;                  // resuelto: config > front-matter de la skill (o el del juez)
  effort?: Effort;
  claudeSkills?: string[];         // skills de Claude Code del paso ([] = ninguna)
  plugins?: string[];              // plugins locales (solo sus skills)
}

interface AgentResult<T> {
  output: T;                       // ya validado contra schema
  sessionId?: string;              // para retomar después
  costUsd: number;
  turns: number;
  durationMs: number;
  denials: { tool: string; reason: string }[];
}
```

Un runner alternativo (otro proveedor, un agente propio) debe:

- respetar los tres modos dentro de `scope`: en `readonly`, nada de escrituras ni comandos; en `edit`, escribir solo bajo `writeRoot` y fuera de `lockedPaths`; en `tests`, escribir solo en `testPaths`;
- ejecutar solo comandos que pasen `isCommandAllowed(command, scope.allowedCommands)`;
- devolver una salida que cumpla `schema`.

Puede ignorar `resumeSessionId` (los defectos irán a un implementador nuevo), `ask` (el worker decidirá solo) y `readDirs`. Las revisiones de git después de cada paso siguen protegiendo los tests y los componentes aunque el runner sea menos estricto.

`ClaudeAgentRunner` lo implementa así:

| Requisito | Cómo |
|---|---|
| Modelo y esfuerzo por rol | `options.model`, `options.effort` desde la config |
| Instrucciones | Preset `claude_code` + `append: systemPrompt` |
| Permisos | `decide()` en un hook `PreToolUse` (todas las llamadas, incluidas las lecturas) y en `canUseTool` (las que piden permiso) |
| Skills y plugins | `options.skills` (lista explícita, vacía si no hay) y `options.plugins` con `skipMcpDiscovery` |
| Herramientas prohibidas | `disallowedTools: WebFetch, WebSearch, Task, Agent` |
| JSON con contrato | `outputFormat: { type: "json_schema", schema }` y luego `schema.safeParse` |
| Retomar sesión | `options.resume` y `result.session_id` |
| `ask`, memoria | Servidor MCP en el proceso (`createSdkMcpServer`) con `ask`, `memory_search` y `memory_save`, cada una solo si el paso la tiene |
| MCP externo | `options.mcpServers` con los servidores de `mcpAccess` del paso; `decide()` niega los demás |
| Lectura de otros repos | `options.additionalDirectories` |
| Convenciones del repo | `settingSources: ["project"]` si `loadProjectSettings` |
| Topes | `maxTurns`, `maxBudgetUsd` |

## Probar sin gastar: `ScriptedRunner`

`test/helpers.ts` define un `AgentRunner` que, en lugar de llamar a un modelo, ejecuta funciones que tú escribes. Cada función recibe la carpeta de trabajo y la petición, puede escribir archivos como lo haría un agente y devuelve el JSON del paso.

```ts
const runner = new ScriptedRunner(
  {
    enrich: [() => ({ summary: "…", stack: [], relevantFiles: [], conventions: [], openQuestions: [] })],
    plan: [() => ({ summary: "…", tasks: [{ id: "T1", component: "main", dependsOn: [], description: "…", files: [], acceptanceCriteria: [] }], risks: [] })],
    testAuthor: [(cwd) => { write(cwd, "test/x.test.js", "…"); return { testFiles: [], acceptanceMap: [/* … */] }; }],
    "coder:T1": [(cwd) => { write(cwd, "src/x.js", "…"); return { changedFiles: ["src/x.js"], notes: "" }; }],
    review: [() => ({ approved: true, issues: [] })],
    qaPlan: [() => ({ markdown: "…" })],
  },
  byTask,                       // elige la cola: coder:T1, coder:resolve, coder:fix…
  (key) => (key === "coder:T1" ? 50 : 0),   // retardo simulado, para probar paralelismo
);
const summary = await implementTicket({ repo, ticket, config, runner });
```

Así se prueba cualquier cambio en el flujo con repos git reales y comandos reales, en segundos y sin costo. Es lo que hacen `e2e.ts` y `tutorial.ts`.

## Extensiones habituales

### Cambiar las instrucciones de un rol

No hace falta tocar código: `skills eject <rol>` copia su `SKILL.md` a `.hector/skills/` del repo, donde lo editas y commiteas. Para cambiar el comportamiento de serie para todos los repos, edita `skills/<rol>/SKILL.md` en hector-flow. Ver [13-skills.md](13-skills.md).

### Agregar un campo a la salida de un agente

1. Agrega el campo al esquema en `src/schemas.ts`, con un `.describe()` claro (el modelo lo lee).
2. Úsalo en `workflow.ts`.
3. Actualiza los `ScriptedRunner` de los tests que devuelven ese esquema.

### Agregar un paso nuevo

Ejemplo: un paso de seguridad después de la revisión.

1. Agrega el rol a `RoleSchema` en `src/config.ts` (así admite `models`, `efforts` y `claudeSkills`).
2. Crea `skills/<rol>/SKILL.md` con sus instrucciones, y agrega su prompt en `prompts`, en `src/prompts.ts`.
3. Define su esquema de salida en `src/schemas.ts`.
4. En `workflow.ts`, llámalo con `agent(...)` (solo lectura) o `editStep(...)` (si edita) en el punto que corresponda, y decide con código qué hacer con su salida. Si encuentra defectos, enrútalos con `routeDefect` en lugar de corregir en el mismo paso: un agente, una responsabilidad.
5. Agrega un escenario en `test/e2e.ts`.

### Release: push y pull requests

Es el siguiente paso natural (pasos 6 y 8 del video). El punto de enganche es el cierre de `implementTicket`, cuando el estado es `completed`: para cada elemento de `repos`, `git push -u origin <branch>` desde `worktree`, y crear el PR con la CLI de tu plataforma (`gh pr create`, `az repos pr create`) usando `test-plan.md` como descripción y enlazando los PR entre sí. Conviene hacerlo opcional con un campo nuevo en la config.

### Otro origen de tickets (Jira, Linear…)

Implementa `BacklogAdapter` (`src/backlog.ts`): `list()` devuelve elementos `{ ticket, ref }` y los omitidos con su motivo; `report()` publica un mensaje en el origen. Para construir el ticket, arma markdown con `# ID-123: título` y una sección de criterios, y pásalo a `parseTicket`. Agrega el tipo a `backlog` en `src/config.ts` y a `createBacklog`. Prueba el adaptador con un `fetch` simulado, como `test/loop.ts`.

## Desarrollo

```bash
npm run typecheck     # tsc --noEmit sobre src/
npm test              # runner-policy + e2e + tutorial
npm run test:e2e      # solo e2e
npm run test:tutorial # solo el tutorial
npm run build         # compila a dist/
```
