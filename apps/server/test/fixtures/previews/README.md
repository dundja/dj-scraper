# Preview recordings (ADR-029)

Recorded 2026-10-28 on macOS 26.5.1 (arm64) with Homebrew yt-dlp **2026.10.26**, ffmpeg 8.0 and Node 24.12.0, without cookies or a login, into an empty temp dir. The argv is `previewArgs` (`src/engine/ytdlp-args.ts`), spawned like `engine/run.ts` does (`shell: false`); `{TEMPDIR}` is the `-P` dir and `{NODE}` `process.execPath`. Each case: `<case>.argv.json`, `<case>.stdout.log`, `<case>.stderr.log` (an empty file means an empty stream).

| Case | URL | Exit | What it shows |
|---|---|---|---|
| `youtube-m4a` | `https://www.youtube.com/watch?v=jNQXAC9IVRw` | 0 | AAC (format 140) as `jNQXAC9IVRw.m4a`, 309,156 bytes; stdout is the one `PREVIEW {"filepath": …}` line, stderr empty. |
| `soundcloud-m4a` | `https://soundcloud.com/the-concept-band/knocked-up-mastered` | 0 | HLS AAC as `<track id>.m4a` (the file is named by the track's numeric id, not the slug), 4,476,897 bytes. |
| `soundcloud-preview-break` | `https://soundcloud.com/the-concept-band/world-on-fire-1` | 101 | A Go+ track without a subscription: the break filter ends the run silently, both streams empty, nothing written. `mapDownloadExit` reads it as `preview_only`. |

The fake engine (`../../fake-yt-dlp.mjs`) writes its own synthetic stream for a `preview` rule of `fake-yt-dlp.json` and prints the same one-line shape; no test replays these logs, they pin the argv and the line `parsePreviewLine` reads. Used by `src/engine/ytdlp-args.test.ts`, `src/engine/ytdlp-progress.test.ts` and `src/engine/ytdlp-errors.test.ts`.
