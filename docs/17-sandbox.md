# 17. Sandbox: ejecutar hector-flow aislado

Los permisos de hector-flow ([06-seguridad.md](06-seguridad.md)) evitan que un agente se salga de su tarea, pero **no son un aislamiento del sistema operativo**. Además, hay algo que ningún permiso de los agentes cubre: el propio flujo ejecuta `buildCommand`, `testCommand`, `lintCommand` y los comandos de aceptación **sobre código que escribió un agente**, con tu usuario, tu red y tus archivos. Un test que lea `~/.aws/credentials` y lo envíe a otro sitio pasa todas las guardas, porque `npm test` es un comando permitido.

El sandbox resuelve eso ejecutando **todo** hector-flow (agentes, comandos, git) en un contenedor:

- solo ve la carpeta con tus repos, no tu `$HOME` (ni `~/.ssh`, `~/.azure`, `~/.aws`, `~/.claude`…);
- no tiene ruta a Internet: sale únicamente por un **proxy con lista de dominios permitidos**, que registra cada conexión;
- corre con tu uid, sin capacidades de Linux y con `no-new-privileges`;
- recibe solo las credenciales que le pasas, y el flujo **las quita** del entorno de los comandos de build y test.

## Cuándo usarlo

| Situación | ¿Sandbox? |
|---|---|
| Lo vigilas (`run`, o `start` en modo `manual`/`supervised`), repos y tickets de confianza, sin credenciales de producción en tu terminal | Recomendable, no imprescindible |
| `start --mode auto` o cualquier bucle desatendido | **Sí** |
| Tickets de GitHub Issues públicos o de personas ajenas al equipo (el texto del ticket llega a los agentes: *prompt injection*) | **Sí** |
| Algún paso en Codex (no aplica la lista de secretos ni la de comandos) | **Sí** |
| Tu máquina tiene sesiones de Azure CLI, AWS, kubeconfig o claves SSH con acceso a producción | **Sí** |

`check` avisa (⚠) cuando no estás en el sandbox y se da alguno de los casos en negrita.

## Cómo funciona

```
 tu máquina
 ┌─────────────────────────────────────────────────────────────────────┐
 │  HECTOR_WORK_ROOT (p. ej. ~/code) ─── montado en la MISMA ruta ───┐ │
 │                                                                    │ │
 │  red "internal" (sin salida a Internet)                            ▼ │
 │  ┌──────────────────────────────┐   HTTPS_PROXY  ┌───────────────┐  │
 │  │ hector                        │ ─────────────▶ │ egress        │──┼──▶ api.anthropic.com
 │  │ hector-flow, agentes, git,    │                │ proxy con     │  │    registry.npmjs.org
 │  │ npm test / dotnet test…       │                │ allowlist     │  │    (solo lo permitido)
 │  │ uid = el tuyo, sin caps       │                └───────────────┘  │
 │  └──────────────────────────────┘                  red "outside"    │
 └─────────────────────────────────────────────────────────────────────┘
```

- **`hector`** ejecuta hector-flow. Está solo en una red interna de Docker, sin ruta a Internet ni DNS externo.
- **`egress`** es `sandbox/egress-proxy.mjs`: un proxy HTTP/HTTPS sin dependencias que solo deja pasar los hosts de `sandbox/allowed-domains.txt` en los puertos 443 y 80. Registra cada decisión como una línea JSON.
- La carpeta de trabajo se monta **en la misma ruta** que en tu máquina, así los worktrees de git que se crean dentro siguen funcionando fuera.
- Los datos de los runtimes (sesiones de Copilot/Codex, caché de npm) viven en un volumen propio (`hector-home`), nunca en tu `$HOME`.

## Uso

Requisitos: Docker con Compose v2 (Docker Desktop, OrbStack, Colima o Docker Engine en Linux).

```bash
cd ~/code/tienda-api                      # dentro de uno de tus repos
export ANTHROPIC_API_KEY=sk-ant-…         # una clave dedicada y con límite de gasto

~/code/hector-flow/sandbox/hector-sandbox.sh check --repo . --ticket ../TIENDA-42.md
~/code/hector-flow/sandbox/hector-sandbox.sh run   --repo . --ticket ../TIENDA-42.md
~/code/hector-flow/sandbox/hector-sandbox.sh start --repo . --mode auto
~/code/hector-flow/sandbox/hector-sandbox.sh usage --repo . --by step
```

Recibe los mismos comandos y opciones que `hector-flow`. La primera vez construye la imagen (`--build` la reconstruye). Además:

| Comando | Qué hace |
|---|---|
| `hector-sandbox.sh shell` | Una terminal dentro del sandbox, para depurar |
| `hector-sandbox.sh logs` | Qué permitió y qué rechazó el proxy |
| `hector-sandbox.sh down` | Detiene el proxy |

**Qué carpeta se monta.** Por defecto, la carpeta que contiene el repo donde estás (`~/code` si estás en `~/code/tienda-api`). El script lo dice al empezar: `hector-flow sandbox: mounting /Users/hector/code`. Debe contener **todos los repos del ticket y la carpeta de trabajo** (`workspacesDir`, por defecto `../.hector-workspaces`). Si no, usa `--root <carpeta>` o la variable `HECTOR_WORK_ROOT`. Nunca monta `/` ni tu `$HOME` completo.

`check` dentro del sandbox lo confirma:

```
✔ build/test commands run without 1 credential variable(s): ANTHROPIC_API_KEY
✔ running in the hector-flow sandbox; outbound traffic through http://egress:3128
```

## Credenciales

Solo entran al sandbox las variables que estén definidas en tu terminal **y** listadas en `sandbox/compose.yaml`:

| Variable | Para |
|---|---|
| `ANTHROPIC_API_KEY` o `CLAUDE_CODE_OAUTH_TOKEN` | Pasos en Claude (la sesión de `claude` de tu `$HOME` no entra: usa una clave) |
| `OPENAI_API_KEY` / `CODEX_API_KEY` | Pasos en Codex |
| `COPILOT_GITHUB_TOKEN` | Pasos en Copilot (fine-grained PAT con "Copilot Requests") |
| `HECTOR_BACKLOG_TOKEN` | El backlog de GitHub o Azure DevOps: pon `"tokenEnv": "HECTOR_BACKLOG_TOKEN"` en `backlog` |

Recomendaciones:

- **Claves dedicadas al sandbox, con límite de gasto** (Anthropic y OpenAI permiten límites por clave), y revócalas si algo te parece raro.
- **Tokens de GitHub fine-grained**, limitados a los repos del backlog y a los permisos mínimos (Issues).
- hector-flow **quita del entorno de build/test** toda variable con aspecto de credencial (`*_API_KEY`, `*_TOKEN`, `*_SECRET`, `*PASSWORD*`, `*_PAT`, cadenas de conexión…) y la variable del backlog, sea cual sea su nombre. Si un test necesita una (p. ej. la contraseña de una base de datos local), añádela a `commandEnv.keep` ([03-configuracion.md](03-configuracion.md#commandenv)).

Para iniciar sesión dentro del sandbox en vez de usar un token (por ejemplo `copilot login` o `codex login`), abre `hector-sandbox.sh shell` y hazlo ahí: la sesión queda en el volumen `hector-home`, no en tu máquina. Si lo haces, añade al allowlist los dominios del inicio de sesión mientras dure.

## La lista de dominios

`sandbox/allowed-domains.txt`, uno por línea:

```
api.anthropic.com        # exacto
*.githubcopilot.com      # solo subdominios
.npmjs.org               # el dominio y sus subdominios
```

El proxy la recarga al guardarla. La de serie incluye las APIs de los cuatro runtimes y `registry.npmjs.org`; quita lo que no uses y añade lo que necesiten tus builds (`api.nuget.org`, `pypi.org`, el proveedor de OpenCode…). Para usar otra lista sin tocar el repo: `HECTOR_ALLOWLIST=/ruta/mi-lista.txt`.

Cada host de la lista es también un sitio al que el código de un agente podría enviar datos. Por eso la de serie **no** incluye `github.com`, `gist.github.com` ni los endpoints de administración de tu nube. `api.github.com` sí está, porque Copilot y el backlog de GitHub lo necesitan, y acepta escrituras: esa es otra razón por la que los comandos de build y test nunca reciben un token de GitHub.

Para ver qué se bloqueó:

```bash
sandbox/hector-sandbox.sh logs | grep '"allowed":false'
{"ts":"…","event":"connect","host":"evil.example.com","port":443,"allowed":false,"reason":"evil.example.com is not on the allowlist"}
```

Si un build falla con un error de red, ese log dice qué host necesitaba.

## Herramientas de tus componentes

La imagen trae Node 22 y git. Lo demás se añade al construir, con variables de entorno que lee `compose.yaml`:

```bash
export HECTOR_DOTNET_CHANNEL=8.0                          # SDK de .NET
export HECTOR_EXTRA_APT_PACKAGES="python3 python3-venv"   # paquetes de Debian
export HECTOR_OPENCODE_VERSION=latest                     # binario de OpenCode
sandbox/hector-sandbox.sh --build check --repo .
```

Para algo más complejo, crea tu propia imagen a partir de la de hector-flow y apunta `HECTOR_IMAGE` a ella:

```dockerfile
FROM hector-flow-sandbox:latest
USER root
RUN apt-get update && apt-get install -y --no-install-recommends openjdk-17-jdk-headless && rm -rf /var/lib/apt/lists/*
USER 1000:1000
```

Las descargas que hacen tus builds **durante la ejecución** (restaurar paquetes NuGet o npm, por ejemplo) pasan por el proxy: sus registros deben estar en la lista. `npm`, `dotnet`, `pip`, `git` y `curl` usan `HTTPS_PROXY` automáticamente; Node también (`NODE_USE_ENV_PROXY=1`). Un programa que ignore el proxy simplemente no tendrá red: el sandbox falla cerrado.

## Más opciones

| Variable | Por defecto | Qué hace |
|---|---|---|
| `HECTOR_WORK_ROOT` | carpeta padre del repo actual | Carpeta montada (misma ruta dentro) |
| `HECTOR_ALLOWLIST` | `sandbox/allowed-domains.txt` | Lista de dominios |
| `HECTOR_IMAGE` | `hector-flow-sandbox:latest` | Imagen a usar |
| `HECTOR_MEM_LIMIT` | `8g` | Memoria máxima del contenedor |
| `HECTOR_PIDS_LIMIT` | `4096` | Procesos máximos |
| `HECTOR_UID`, `HECTOR_GID` | los tuyos | Usuario con que corre (dueño de los archivos que crea) |
| `HECTOR_COMPOSE_OVERRIDE` | — | Tus propios archivos de Compose (más montajes, límites), separados por `:` |
| `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL` | tu `git config` | Autor de los commits del flujo |

**VS Code:** `.devcontainer/devcontainer.json` abre una terminal dentro del mismo sandbox ("Reopen in Container"). Define `HECTOR_WORK_ROOT` antes de abrir VS Code.

## Qué sigue sin cubrir

- **Lo que permite la lista.** El código de un agente puede enviar datos a cualquier host permitido; con una lista corta y claves dedicadas, el daño queda acotado.
- **Las credenciales que tú pasas.** Los agentes las usan para llamar a los modelos; los comandos de build/test no las ven, pero el proceso de cada runtime sí. Por eso: claves dedicadas y con límite.
- **Tus repos.** El sandbox puede escribir en la carpeta montada (es su trabajo). El flujo nunca cambia tus checkouts salvo en `approve` y el modo `auto`, y nunca hace push; aun así, que la carpeta montada contenga solo repos que el flujo deba tocar.
- **El kernel.** Un contenedor comparte el kernel con tu máquina. Para código realmente no confiable, usa una VM (o Docker Desktop, que ya ejecuta los contenedores en una VM ligera).

## Cómo se probó

`npm test` incluye `test/sandbox.ts` (sin Docker): reglas del allowlist, el proxy con sockets reales (rechazos, túnel permitido, clientes que cortan la conexión) y la limpieza del entorno de los comandos. Además, la imagen se construyó con `sandbox/Dockerfile` y se comprobó dentro del sandbox:

- sin proxy no hay DNS ni ruta a una IP;
- un host o un puerto fuera de la lista recibe 403 y queda registrado;
- `api.anthropic.com` sí es alcanzable, y `fetch` de Node usa el proxy;
- `$HOME` y `/root` del anfitrión no son visibles;
- `check` sobre los dos repos del tutorial pasa, con builds y tests ejecutados como uid 1000;
- los 18 escenarios de `test/e2e.ts` (worktrees en varios repos, conflictos, reparaciones) pasan dentro del contenedor.
