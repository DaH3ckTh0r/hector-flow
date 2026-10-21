#!/usr/bin/env bash
# Runs hector-flow inside the sandbox (sandbox/compose.yaml).
#
#   sandbox/hector-sandbox.sh [--root <folder>] [--build] <hector-flow command and options>
#   sandbox/hector-sandbox.sh shell        # a shell inside the sandbox, for debugging
#   sandbox/hector-sandbox.sh logs         # what the egress proxy allowed and refused
#   sandbox/hector-sandbox.sh down         # stop the proxy
#
# HECTOR_COMPOSE_OVERRIDE=path/to/extra.yaml adds your own compose overrides.
#
# --root is the folder mounted into the sandbox: it must contain every repo of
# the ticket AND the workspaces folder (by default <repo's parent>/.hector-workspaces).
# Default: the parent of the current git repo, or $HECTOR_WORK_ROOT.
#
# Examples:
#   cd ~/code/tienda-api
#   ../hector-flow/sandbox/hector-sandbox.sh check --repo "$PWD" --ticket ../TIENDA-42.md
#   ../hector-flow/sandbox/hector-sandbox.sh run   --repo "$PWD" --ticket ../TIENDA-42.md
#   ../hector-flow/sandbox/hector-sandbox.sh start --repo "$PWD" --mode auto
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
compose=(docker compose -f "$here/compose.yaml")
# Extra compose files of your own (more mounts, limits…), separated by ":".
if [[ -n "${HECTOR_COMPOSE_OVERRIDE:-}" ]]; then
  IFS=: read -r -a extra <<<"$HECTOR_COMPOSE_OVERRIDE"
  for f in "${extra[@]}"; do compose+=(-f "$f"); done
fi

build=0
root="${HECTOR_WORK_ROOT:-}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --root) root="$2"; shift 2 ;;
    --build) build=1; shift ;;
    *) break ;;
  esac
done

if [[ -z "$root" ]]; then
  # safe.directory: the lookup must work even for repos owned by another user.
  if top="$(git -c safe.directory='*' rev-parse --show-toplevel 2>/dev/null)"; then root="$(dirname "$top")"; else root="$PWD"; fi
fi
root="$(cd "$root" && pwd -P)"
case "$root" in
  /|"$HOME") echo "Refusing to mount $root into the sandbox: pick the folder that holds your repos (--root)." >&2; exit 2 ;;
esac

export HECTOR_WORK_ROOT="$root"
echo "hector-flow sandbox: mounting $root" >&2
export HECTOR_UID="${HECTOR_UID:-$(id -u)}"
export HECTOR_GID="${HECTOR_GID:-$(id -g)}"
export GIT_AUTHOR_NAME="${GIT_AUTHOR_NAME:-$(git config --get user.name 2>/dev/null || echo hector-flow)}"
export GIT_AUTHOR_EMAIL="${GIT_AUTHOR_EMAIL:-$(git config --get user.email 2>/dev/null || echo hector-flow@localhost)}"
export GIT_COMMITTER_NAME="${GIT_COMMITTER_NAME:-$GIT_AUTHOR_NAME}"
export GIT_COMMITTER_EMAIL="${GIT_COMMITTER_EMAIL:-$GIT_AUTHOR_EMAIL}"

case "${1:-}" in
  logs) exec "${compose[@]}" logs --no-log-prefix egress ;;
  down) exec "${compose[@]}" down ;;
esac

if [[ $build -eq 1 ]] || ! docker image inspect "${HECTOR_IMAGE:-hector-flow-sandbox:latest}" >/dev/null 2>&1; then
  "${compose[@]}" build hector
fi
"${compose[@]}" up -d --wait egress >/dev/null

# Relative paths in arguments are resolved by hector-flow against this folder.
if [[ "$PWD" != "$root"* ]]; then
  echo "Run this from inside $root (or pass absolute paths under it)." >&2
  exit 2
fi
tty_flag=()
[[ -t 0 && -t 1 ]] || tty_flag=(-T)

if [[ "${1:-}" == "shell" ]]; then
  exec "${compose[@]}" run --rm "${tty_flag[@]}" -w "$PWD" --entrypoint bash hector
fi
exec "${compose[@]}" run --rm "${tty_flag[@]}" -w "$PWD" -e INIT_CWD="$PWD" hector "$@"
