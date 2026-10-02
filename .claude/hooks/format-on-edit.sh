#!/usr/bin/env bash
# PostToolUse hook (Edit|Write): format the file Claude just changed with Biome.
# Silent no-op until dependencies are installed, and for files Biome doesn't handle.
set -uo pipefail

input=$(cat)
if command -v jq >/dev/null 2>&1; then
  file=$(jq -r '.tool_input.file_path // empty' <<<"$input" 2>/dev/null)
else
  file=$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).tool_input?.file_path??"")}catch{}})' <<<"$input")
fi

[[ -n "${file:-}" && -f "$file" ]] || exit 0

case "$file" in
  *.ts | *.tsx | *.mts | *.cts | *.js | *.jsx | *.mjs | *.cjs | *.json | *.jsonc | *.css) ;;
  *) exit 0 ;;
esac

# Biome finds biome.json from the working directory, not from the file's path.
cd "${CLAUDE_PROJECT_DIR:-$PWD}" || exit 0
biome="node_modules/.bin/biome"
[[ -x "$biome" ]] || exit 0

# Format and sort imports; lint fixes stay with `pnpm check:fix` so a half-done edit isn't "fixed".
"$biome" check --write --linter-enabled=false --no-errors-on-unmatched "$file" >/dev/null 2>&1 || true
exit 0
