#!/bin/sh
# A fake engine binary (yt-dlp, ffmpeg, ffprobe, deno) for tests. It never touches the network.
#
# Tests symlink it under the tool's name in a temp dir (see writeFakeTool in helpers.ts) and
# describe its behavior in dotfiles beside the link, named after the link:
#   .NAME.argv    the expected arguments, joined with spaces; any other argv exits 64
#   .NAME.stdout  printed to stdout as is
#   .NAME.stderr  printed to stderr as is
#   .NAME.signal  a signal to kill itself with after printing, e.g. KILL
#   .NAME.hang    if present, sleeps instead of exiting (for timeouts)
#   .NAME.exit    the exit code (default 0)
#
# Why one script behind symlinks instead of a new script per test: endpoint security on macOS
# (Defender, Falcon) scans every newly written executable on its first exec. That took 0.3-5 s per
# script and made the probe tests time out under load; a symlink reuses this file's verdict.
# Keep the exec bit when committing (git mode 100755).

dir=${0%/*}
name=${0##*/}
spec="$dir/.$name"

if [ -f "$spec.argv" ] && [ "$*" != "$(/bin/cat "$spec.argv")" ]; then
  echo "unexpected argv: $*" >&2
  exit 64
fi
if [ -f "$spec.stdout" ]; then /bin/cat "$spec.stdout"; fi
if [ -f "$spec.stderr" ]; then /bin/cat "$spec.stderr" >&2; fi
if [ -f "$spec.signal" ]; then kill -"$(/bin/cat "$spec.signal")" $$; fi
if [ -f "$spec.hang" ]; then exec /bin/sleep 600; fi
if [ -f "$spec.exit" ]; then exit "$(/bin/cat "$spec.exit")"; fi
exit 0
