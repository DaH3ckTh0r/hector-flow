# 2. Instalación

## Requisitos

| Requisito | Versión | Cómo comprobarlo |
|---|---|---|
| Node.js | 20 o superior (probado con 22) | `node --version` |
| npm | el que trae Node | `npm --version` |
| git | 2.30 o superior (usa `git worktree`) | `git --version` |
| Acceso a Claude | Claude Code con sesión iniciada, o `ANTHROPIC_API_KEY` | `claude --version` y abrir `claude` una vez |
| Codex (opcional) | Sesión de Codex (`npx codex login`) u `OPENAI_API_KEY`; el binario viene con el SDK | Solo si algún paso usa `runtime: codex` |
| GitHub Copilot (opcional) | Suscripción de Copilot con Copilot CLI; `copilot login` (`npm i -g @github/copilot`) o un fine-grained PAT con "Copilot Requests". El runtime viene con el SDK | Solo si algún paso usa `runtime: copilot`; `check` lo verifica |
| OpenCode (opcional) | `opencode` en el PATH (`npm i -g opencode-ai`) con un proveedor configurado | `opencode --version`; solo si algún paso usa `runtime: opencode` |
| Sistema operativo | macOS o Linux. En Windows, usa WSL2 (no está probado en Windows nativo). | |

Además, cada componente necesita sus propias herramientas (por ejemplo, el SDK de .NET para `dotnet test`). `check` lo verifica.

### Autenticación con Claude

hector-flow usa el **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`), que corre Claude Code por debajo y se autentica igual:

- **Con suscripción de Claude:** instala Claude Code, ejecuta `claude` una vez e inicia sesión. El consumo sale de los límites de tu plan.
- **Con API:** exporta `ANTHROPIC_API_KEY` en la terminal donde ejecutes hector-flow. El consumo se factura por uso.

Si la autenticación falla, el primer agente (`enrich`) termina con error y el estado final es `failed` con un mensaje que empieza por `enrich:`.

## Instalar

```bash
unzip hector-flow.zip
cd hector-flow
npm install
```

## Comprobar la instalación

```bash
npm run typecheck   # compila sin errores
npm test            # ~1 minuto, sin llamadas al modelo
```

`npm test` ejecuta seis suites:

1. `test/runner-policy.ts`: las reglas de permisos de los agentes.
2. `test/runtimes.ts`: el puente MCP (con un cliente MCP real) y los runtimes Codex, OpenCode y Copilot con SDK simulados.
3. `test/usage.ts`: el consumo de tokens de cada runtime y los informes de `usage`.
4. `test/e2e.ts`: 18 escenarios del flujo con un runner simulado.
5. `test/loop.ts`: memoria, acceso MCP, adaptadores de backlog (con HTTP simulado) y el bucle.
6. `test/tutorial.ts`: el tutorial completo, de punta a punta.

Debe terminar con `tutorial checks passed`.

## Formas de ejecutarlo

Desde la carpeta de hector-flow, sin compilar:

```bash
npm run flow -- <comando> [opciones]
```

O compilado, como un comando global:

```bash
npm run build      # genera dist/
npm link           # crea el comando hector-flow
hector-flow check --repo ~/mi-repo
```

En esta documentación se usa `npm run flow -- …`. Con `npm link`, sustitúyelo por `hector-flow …`.

## Preparar un repo

1. Crea `hector-flow.config.json` en la raíz del **repo principal**. Parte de:
   - `examples/hector-flow.config.json` para un solo repo, o
   - `examples/multi-component.config.json` para varios componentes.
2. Commitea la config. Los repos tienen que estar limpios para ejecutar.
3. Opcional pero recomendado: un `CLAUDE.md` en cada repo con tus convenciones. Los agentes lo leen si `loadProjectSettings` es `true` (por defecto).
   Para cambiar cómo trabaja un paso concreto, personaliza su skill con `skills eject <paso>` ([13-skills.md](13-skills.md)).
4. Agrega `.hector-workspaces/` al `.gitignore` de la carpeta que contiene tus repos, si esa carpeta también es un repo. Por defecto, hector-flow crea esa carpeta **junto** al repo principal, no dentro.
5. Ejecuta `check` hasta que todo esté en ✔:

   ```bash
   npm run flow -- check --repo ~/mi-repo --ticket ~/tickets/AB-123.md
   ```

## Dónde escribe hector-flow

Todo queda en una carpeta junto al repo principal (por defecto `../.hector-workspaces`, configurable con `workspacesDir`):

```
<carpeta padre del repo principal>/
├── mi-repo/                      ← tu checkout: no se toca
├── otro-repo/                    ← tu checkout: no se toca
└── .hector-workspaces/
    ├── AB-123/
    │   ├── mi-repo/              ← worktree de integración (rama hector/AB-123)
    │   ├── otro-repo/            ← worktree de integración (rama hector/AB-123)
    │   └── _tasks/
    │       ├── T1/               ← worktree de la tarea T1 (rama hector-tasks/AB-123/T1)
    │       └── T2/
    ├── _runs/
    │   └── AB-123-<fecha>-<id>/  ← logs y artefactos de cada ejecución
    └── _lessons/
        └── mi-repo.json          ← pautas y lecciones aprendidas
```

Las ramas `hector/AB-123` y `hector-tasks/AB-123/*` se crean **en tus repos** (un worktree comparte el repo con tu checkout). Por eso puedes hacer push de ellas directamente.

## Desinstalar

1. Para cada ticket pendiente: `npm run flow -- clean --repo <repo> --ticket-id <ID>`.
2. Borra la carpeta `.hector-workspaces` si ya no quieres los logs ni las lecciones.
3. Si usaste `npm link`: `npm unlink -g hector-flow`.
4. Borra la carpeta de hector-flow.
