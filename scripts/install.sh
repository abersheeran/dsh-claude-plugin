#!/usr/bin/env bash
# Install the DSH subagent plugin into Claude Code from this checkout.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v claude >/dev/null 2>&1; then
  echo "claude was not found on PATH. Install Claude Code first." >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "node was not found on PATH. The plugin's MCP server needs Node.js 18+." >&2
  exit 1
fi

if ! command -v dsh >/dev/null 2>&1; then
  dsh_app="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
  if [ ! -x "$dsh_app" ]; then
    echo "warning: no 'dsh' on PATH and no DeepSeek Harness app found." >&2
    echo "         Set DSH_BIN after installing DeepSeek Harness." >&2
  fi
fi

echo "Adding marketplace: $root"
claude plugin marketplace add "$root" || true

echo "Installing dsh@dsh-plugins"
claude plugin install dsh@dsh-plugins

cat <<'EOF'

Installed. Restart Claude Code (or run /reload-plugins), then verify with:

  /dsh:doctor

Or just ask: "use the dsh subagent to reply DSH_OK"
EOF
