---
name: smoke-test
description: Check DJ Scraper's engine against live YouTube and SoundCloud. Resolves real URLs (and with --download runs the real download pipeline on short tracks, reading each file back) and reports what works. Use after updating yt-dlp, when resolves or downloads start failing, or when asked for a smoke test. Uses the network.
argument-hint: "[url ...] [--download [--format f]… [--keep] [--bare]]"
---

A live check of the engine. It uses the network, so it is never part of `pnpm test`.

Input: `$ARGUMENTS`. These are the URLs to check (default: the sample set below). With `--download`, step 3 replaces step 2: the URLs (default: the two shortest samples) are downloaded instead of only resolved.

1. **Engine.** `pnpm smoke` prints yt-dlp's version and age first, and warns when it is below the minimum or more than ~60 days old. Also run `ffmpeg -version | head -1`, `ffprobe -version | head -1` and `command -v deno`. Deno is YouTube's JS runtime; we also pass Node as a fallback.
2. **Resolve each URL** with `pnpm smoke`, which runs the app's real resolver and prints a summary per URL (✅/❌, kind, title, artist, duration, source codec/bitrate; for lists: entries, partial rows, trackCount, truncated, skippedEntries and the first rows). It exits 1 if any URL fails.
   - `pnpm smoke` with no URL runs the sample set below.
   - `pnpm smoke '<url>' …` for specific URLs. Quote them: `&` in `watch?v=…&list=…` is a shell operator.
   - `--mode track|collection` resolves a `watch?v=…&list=…` URL as its track or its whole list (default `auto` answers `ambiguous`).
   - `--entries N` also enriches the first N partial rows, e.g. of a SoundCloud set (counts against SoundCloud's API budget).
   - `--json` prints the full `ResolveResult` per URL on stdout (logs go to stderr), for `jq`.
3. **Download (only with `--download`).** `pnpm smoke --download [--format mp3|m4a|aiff|wav|flac|original]… [--keep] [--bare] ['<url>' …]` runs the app's real download pipeline (`scripts/smoke-download.ts`).
   - Each URL is resolved, turned into the TrackRef the web sends, and posted to the real `POST /downloads` route in process. The real queue, gates, attempt (yt-dlp), finalize (ffmpeg, our ID3 writer) and publish do the rest.
   - Everything goes into a fresh temp dir with its own data dir and target folder, never the user's data dir or `~/Music`. It is deleted at the end unless `--keep`, which prints the folder.
   - With no URL it downloads the shortest samples: the SoundCloud secret link (10 s) and the YouTube video (19 s), as MP3.
   - `--format` can be repeated: one batch per format, so each URL is downloaded once per format. Keep live runs short: at most about 10 downloads.
   - `--bare` sends only platform, id and url, like an unenriched set row. A Go+ track then reaches yt-dlp's break filter (exit 101 → `preview_only`) instead of being refused at enqueue.
   - Per URL × format it prints:
     - the status and the statuses seen on the bus
     - the source (codec, bitrate) and the output (codec, bitrate, `encoded` or `copied`)
     - the file name, and a readback: the real ffprobe (finalize's probe), the container tags, and our ID3v2.3 frames for MP3/AIFF, read with `test/id3-reader.ts`
     - the cover check: a baseline JPEG ≤ 1000 px (D3)
   - It exits 1 if any URL × format didn't end `done`. A Go+ track ending `preview_only` is the expected result, but it still counts.
   - To check the tags with a second reader, use `--keep` and run Homebrew yt-dlp's mutagen: `$(ls /opt/homebrew/Cellar/yt-dlp/*/libexec/bin/mutagen-inspect | tail -1) <file>`. COMM, TIT2, TPE1 and APIC should all show; a secret SoundCloud link has no COMM. Delete the temp dir afterwards.
   - `test/smoke-download.test.ts` runs the same code offline against the fake engine.
4. **Report** a table: URL → type · title · entries · ✅/❌ · error code or message (with `--download`: format · status · source → output · encoded/copied). For each failure, check yt-dlp's GitHub issues for that extractor, and whether a newer (nightly) yt-dlp fixes it, before changing our code.

## Sample set
Public URLs from yt-dlp's own extractor tests, checked 2026-10-01. Replace any that disappear.

| Case | URL |
|---|---|
| YouTube video (19 s) | https://www.youtube.com/watch?v=jNQXAC9IVRw |
| YouTube playlist (small) | https://www.youtube.com/playlist?list=PLt5yu3-wZAlQAaPZ5Z-rJoTdbT-45Q7c0 |
| YouTube empty playlist | https://www.youtube.com/playlist?list=PL4lCao7KL_QFodcLWhDpGCYnngnHtQ-Xf |
| YouTube Music album (50 tracks, royalty-free) | https://music.youtube.com/browse/MPREb_gTAcphH99wE |
| SoundCloud track | https://soundcloud.com/ethmusic/lostin-powers-she-so-heavy |
| SoundCloud secret link (10 s) | https://soundcloud.com/jaimemf/youtube-dl-test-video-a-y-baw/s-8Pjrp |
| SoundCloud set | https://soundcloud.com/the-concept-band/sets/the-royal-concept-ep |
| SoundCloud album set | https://soundcloud.com/leviryan/sets/out-of-spite |
| SoundCloud downloadable track (the original needs a login) | https://soundcloud.com/the80m/the-following |

Shortest download candidates: the SoundCloud secret link (10 s), then the YouTube video (19 s). For previews: the Go+ track https://soundcloud.com/the-concept-band/world-on-fire-1 (it should end `preview_only`, with and without `--bare`).

Last live download run (2026-10-03, yt-dlp 2026.08.19, ffmpeg 8.0). Every result matched the design:

| Case | Source | Output |
|---|---|---|
| YouTube → mp3 | opus 106 kbps | mp3 320 kbps CBR, encoded, with COMM and APIC |
| YouTube → m4a | AAC (mp4a.40.2) 130 kbps | AAC 128 kbps, copied |
| YouTube → aiff | opus 106 kbps | pcm_s16be 48 kHz, encoded, ID3 chunk with COMM and APIC |
| YouTube → original | opus 106 kbps | Opus in WebM, copied, no cover |
| SoundCloud secret → mp3 | mp3 128 kbps | mp3 128 kbps, copied, no COMM, no cover (default avatar) |
| SoundCloud secret → flac | mp3 128 kbps | FLAC, encoded, no comment |
| Go+ track | | refused at enqueue as `preview_only`; with `--bare`, `preview_only` after yt-dlp's exit 101 |
