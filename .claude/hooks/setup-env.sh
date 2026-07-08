#!/usr/bin/env bash
set -euo pipefail

# SessionStart hook: persist the aqua bin dir into CLAUDE_ENV_FILE so every Bash
# tool command in the session sees aqua-managed tools (node / pnpm / gh) without
# rewriting each command. CLAUDE_ENV_FILE is sourced as shell, so the case guard
# keeps PATH duplicate-free when the hook re-runs on resume/compact.
[ -n "${CLAUDE_ENV_FILE:-}" ] || exit 0

# Same resolution order as aqua's official install docs:
# AQUA_ROOT_DIR > XDG_DATA_HOME > ~/.local/share
AQUA_BIN="${AQUA_ROOT_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/aquaproj-aqua}/bin"

cat >>"$CLAUDE_ENV_FILE" <<EOF
case ":\$PATH:" in
  *:"${AQUA_BIN}":*) ;;
  *) export PATH="${AQUA_BIN}:\$PATH" ;;
esac
EOF
