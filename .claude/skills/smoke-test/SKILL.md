---
name: smoke-test
description: Check DJ Scraper's engine against live YouTube and SoundCloud. Resolves real URLs (and optionally downloads one short track) and reports what works. Use after updating yt-dlp, when resolves or downloads start failing, or when asked for a smoke test. Uses the network.
argument-hint: "[url ...] [--download]"
---

A live check of the engine. It uses the network, so it is never part of `pnpm test`.

Input: `$ARGUMENTS`. These are the URLs to check (default: the sample set below). Add `--download` to also download the shortest track.

1. **Engine.** `pnpm smoke` prints yt-dlp's version and age first, and warns when it is below the minimum or more than ~60 days old. Also run `ffmpeg -version | head -1`, `ffprobe -version | head -1` and `command -v deno`. Deno is YouTube's JS runtime; we also pass Node as a fallback.
2. **Resolve each URL** with `pnpm smoke`, which runs the app's real resolver and prints a summary per URL (✅/❌, kind, title, artist, duration, source codec/bitrate; for lists: entries, partial rows, trackCount, truncated, skippedEntries and the first rows). It exits 1 if any URL fails.
   - `pnpm smoke` with no URL runs the sample set below.
   - `pnpm smoke '<url>' …` for specific URLs. Quote them: `&` in `watch?v=…&list=…` is a shell operator.
   - `--mode track|collection` resolves a `watch?v=…&list=…` URL as its track or its whole list (default `auto` answers `ambiguous`).
   - `--entries N` also enriches the first N partial rows, e.g. of a SoundCloud set (counts against SoundCloud's API budget).
   - `--json` prints the full `ResolveResult` per URL on stdout (logs go to stderr), for `jq`.
3. **Download (only with `--download`).**
   - Download the shortest sample into a scratch temp dir. Use the app's real argv, or the MP3 320 recipe from the `ytdlp` skill.
   - Inspect the result with `ffprobe -hide_banner <file>`: codec, bitrate, duration, tags and attached artwork.
   - Delete the file afterwards.
4. **Report** a table: URL → type · title · entries · ✅/❌ · error code or message. For each failure, check yt-dlp's GitHub issues for that extractor, and whether a newer (nightly) yt-dlp fixes it, before changing our code.

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

Shortest download candidates: the SoundCloud secret link (10 s), then the YouTube video (19 s).
