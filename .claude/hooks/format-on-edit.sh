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

biome="${CLAUDE_PROJECT_DIR:-$PWD}/node_modules/.bin/biome"
[[ -x "$biome" ]] || exit 0

"$biome" format --write --no-errors-on-unmatched "$file" >/dev/null 2>&1 || true
exit 0
