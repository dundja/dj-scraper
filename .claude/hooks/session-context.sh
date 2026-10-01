#!/usr/bin/env bash
# SessionStart hook: orient a new session in a few lines.
# Plain stdout from a SessionStart hook is added to Claude's context, so keep it short.
set -uo pipefail
cd "${CLAUDE_PROJECT_DIR:-$PWD}" || exit 0

if [[ -f docs/roadmap.md ]]; then
  awk '
    /^## / { heading = substr($0, 4) }
    /^[[:space:]]*- \[ \]/ {
      if (!phase) { phase = heading; print "Roadmap: current phase is \"" phase "\" (docs/roadmap.md). Next open items:" }
      if (heading == phase && shown < 5) { sub(/^[[:space:]]*- \[ \] /, "  - "); print; shown++ }
    }
  ' docs/roadmap.md
fi

missing=()
for bin in yt-dlp ffmpeg ffprobe; do
  command -v "$bin" >/dev/null 2>&1 || missing+=("$bin")
done
if ((${#missing[@]})); then
  echo "Engine binaries not on PATH: ${missing[*]} (see README.md > Prerequisites)."
fi

if [[ -f package.json && ! -d node_modules ]]; then
  echo "Dependencies not installed: run pnpm install."
fi
exit 0
