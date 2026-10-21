# hector-flow sandbox image. Build from the repo root:
#   docker build -f sandbox/Dockerfile -t hector-flow-sandbox .
# or let sandbox/hector-sandbox.sh build it.
#
# Add your components' toolchains with build args (see docs/17-sandbox.md):
#   --build-arg DOTNET_CHANNEL=8.0
#   --build-arg EXTRA_APT_PACKAGES="python3 python3-venv"
#   --build-arg OPENCODE_VERSION=latest

ARG NODE_IMAGE=node:22-bookworm-slim

# ── Build: compile hector-flow, keep production dependencies only ───────────
FROM ${NODE_IMAGE} AS build
WORKDIR /opt/hector-flow
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

# ── Runtime ─────────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE}

ARG APT_PACKAGES="git ca-certificates procps curl"
ARG EXTRA_APT_PACKAGES=""
RUN if [ -n "${APT_PACKAGES}${EXTRA_APT_PACKAGES}" ]; then \
      apt-get update \
      && apt-get install -y --no-install-recommends ${APT_PACKAGES} ${EXTRA_APT_PACKAGES} \
      && rm -rf /var/lib/apt/lists/*; \
    fi

# Optional .NET SDK for .NET components (e.g. DOTNET_CHANNEL=8.0).
ARG DOTNET_CHANNEL=""
ENV DOTNET_ROOT=/usr/share/dotnet DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1
RUN if [ -n "${DOTNET_CHANNEL}" ]; then \
      apt-get update && apt-get install -y --no-install-recommends libicu72 && rm -rf /var/lib/apt/lists/* \
      && curl -fsSL https://dot.net/v1/dotnet-install.sh -o /tmp/dotnet-install.sh \
      && bash /tmp/dotnet-install.sh --channel "${DOTNET_CHANNEL}" --install-dir "${DOTNET_ROOT}" \
      && ln -s "${DOTNET_ROOT}/dotnet" /usr/local/bin/dotnet && rm /tmp/dotnet-install.sh; \
    fi

# Optional OpenCode binary, for steps routed to the opencode runtime.
ARG OPENCODE_VERSION=""
RUN if [ -n "${OPENCODE_VERSION}" ]; then npm install -g --no-audit --no-fund "opencode-ai@${OPENCODE_VERSION}"; fi

WORKDIR /opt/hector-flow
COPY --from=build /opt/hector-flow/package.json ./package.json
COPY --from=build /opt/hector-flow/node_modules ./node_modules
COPY --from=build /opt/hector-flow/dist ./dist
COPY skills ./skills
COPY sandbox/egress-proxy.mjs sandbox/allowed-domains.txt ./sandbox/

# Repos are mounted from the host and owned by the host user: let git use them.
# HOME is writable by whatever uid the container runs as (the host user's).
RUN chmod +x dist/cli.js sandbox/egress-proxy.mjs \
 && ln -s /opt/hector-flow/dist/cli.js /usr/local/bin/hector-flow \
 && git config --system --add safe.directory '*' \
 && git config --system init.defaultBranch main \
 && mkdir -p /home/hector && chmod 1777 /home/hector

ENV HOME=/home/hector \
    HECTOR_SANDBOX=1 \
    NODE_USE_ENV_PROXY=1 \
    NODE_OPTIONS=--disable-warning=UNDICI-EHPA \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false

USER 1000:1000
# Run with an init process (compose sets init: true) so child processes are reaped.
ENTRYPOINT ["hector-flow"]
CMD ["--help"]
