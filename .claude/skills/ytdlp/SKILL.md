---
name: ytdlp
description: yt-dlp + ffmpeg know-how for DJ Scraper's engine. Covers the exact flags to resolve YouTube/SoundCloud URLs, download DJ-ready audio (MP3 320, M4A, AIFF, WAV, FLAC) with tags and artwork, parse progress, cancel cleanly, map errors and stay under rate limits. Use when writing or debugging code that builds yt-dlp/ffmpeg arguments or parses their output, or when a URL fails to resolve or download.
---

# yt-dlp engine playbook

Verified 2026-10-01 against yt-dlp **2026.08.19** (README, wiki, source, issues). The Download, Finalize, Output parsing, Cancel and Errors sections were verified with live runs on 2026-10-02 and 2026-10-03 (yt-dlp 2026.08.19, ffmpeg/ffprobe 8.0). Re-verify when behavior differs. Deeper notes, the exact finalize recipes, field lists and sources are in [reference.md](reference.md).

## Install & runtime
- **Dev install:** `brew install yt-dlp ffmpeg`. Brew's yt-dlp bundles the EJS solver, curl-cffi and mutagen, and depends on **deno**, so YouTube works out of the box. Don't pip-install into macOS's system Python (3.9 is too old).
- **JS runtime:** YouTube needs one (EJS), and only deno is enabled by default. Always add our own Node as a fallback with `--js-runtimes node:<process.execPath>` (Node ≥ 22); deno keeps priority when present.
- **Updating:**
  - Brew installs refuse `-U`; use `brew upgrade yt-dlp`.
  - Stable can lag for weeks, while YouTube fixes land in **nightly** within hours to days. When stable is broken, point `YTDLP_PATH` at an unpacked nightly `yt-dlp_macos.zip` build (the onefile `yt-dlp_macos` can take ~12 s per start; see reference.md).
- **ffmpeg:** ffmpeg **and** ffprobe ≥ 8 are required: yt-dlp's own fixups (FixupM4a, FixupM3u8) use them, and so does our finalize (probe, convert, tags, cover). Don't use the `ffmpeg-static` npm package (ffmpeg 6.1, no ffprobe).

## Base argv (every call)
```
--ignore-config --no-update --color never --encoding utf-8
--js-runtimes node:<process.execPath>
<options…>
-- <url>
```
- **Spawning:** only through `apps/server/src/engine/run.ts`: `run(bin, argv, { onStdoutLine, onStderrLine, signal, timeoutMs, killGraceMs, maxOutputBytes })`. It spawns with `shell: false, detached: true` (its own process group, which cancel needs), stops the group with SIGINT and then SIGKILL, SIGKILLs the group whenever a run closes, and splits UTF-8 lines on `\n`, `\r\n` and a lone `\r`.
- **Secrets:** never pass them in argv (it shows up in `ps`). Use `--cookies-from-browser <browser>`, or a 0600 file passed with `--config-locations`, which is still read under `--ignore-config`.

## Resolve
Implemented in `apps/server/src/resolve/` (plan → one call → `engine/ytdlp-parse.ts`); probed live 2026-10-02 (fixtures in `apps/server/test/fixtures/`).
```
yt-dlp <base> -J --flat-playlist -I 1:<cap+1> [--no-playlist | --yes-playlist] --socket-timeout 20 -- <url>
```
- **Caps:** 5000 entries (YouTube's playlist limit), 50 for mixes. Ask for one extra row: getting it means `truncated`. `playlist_count` is the platform's own count only for YouTube playlists/albums and SoundCloud sets (e.g. 11 with 4 rows returned); it is **null** for channel tabs, mixes and SoundCloud user pages, and otherwise equals the row count only when the list ran out. `n_entries` never appears in `-J`; `requested_entries` appears whenever `-I` cut anything.
- **Result types:**
  - `_type: "video"` is one track, with full info including `formats`.
  - `_type: "playlist"` is a collection (no `multi_video` seen). Its entries are `_type: "url"` on YouTube. On SoundCloud, sets give `url_transparent` entries (with album fields) and user pages give `url` entries. Don't infer partial rows from `_type`.
- **YouTube flat entries** carry id, url, title, duration (±1 s from the full extraction) and thumbnails (4 hqdefault sizes). Playlist and mix rows carry channel/uploader; **channel-tab rows don't** (only the collection's top level names the channel); album rows have `uploader = "<artist> - Topic"`.
  - `availability` and `live_status` are null on every flat entry. Private and deleted videos show up only as the exact titles `[Private video]` and `[Deleted video]`, with null duration/channel and the placeholder thumbnail `https://i.ytimg.com/img/no_thumbnail.jpg` (drop it). Match those titles exactly: real titles can start with `[` too (`[ORIGINAL] …`).
- **SoundCloud set entries are bare:** id and url plus album fields (`album`, `album_artist`, `album_type`), with no title, duration, uploader or artwork. The url is the permalink for the first 5 rows and `https://api-v2.soundcloud.com/tracks/<id>` for the rest (secret sets append `?secret_token=…`, a credential: never log it). The set's `playlist_count` is its track count and its top-level `duration` the sum. Its `album_type` is SoundCloud's `set_type` (`'playlist'` when empty); we map album, ep, single and compilation to kind `album`. User pages give id, url and title only, and are titled `<username> (<Resource>)` (All, Tracks, Likes, …) with no uploader, so the owner comes from the title. Both become `partial` rows.
  - User pages also list sets: `/<user>`, `/reposts` and `/likes` mix them in, and `/sets` and `/albums` hold only sets. A set row has **no `ie_key` key at all** and a `/sets/` URL. Keep only `ie_key == "Soundcloud"` rows and count the rest (`skippedEntries`). Skipped rows whose URL classifies as a collection come back as `Collection.lists` (listing order, once per URL, never the page itself, within the cap), so `/sets` and `/albums` aren't dead ends; a YouTube channel's `/playlists` tab gets them too (ADR-023).
  - Fill partial rows with per-row `-J --flat-playlist --no-playlist -- <row url exactly as listed>` lookups (api-v2 URLs work as is): about 1 s each (0.5 s is process start) and 3–5 SoundCloud API requests with default formats. See ADR-014 for the pacing and budget.
- **`watch?v=X&list=Y`:** yt-dlp returns the **playlist** by default. We answer `ambiguous`, then use `--no-playlist` for this track or `--yes-playlist` for the whole list.
- **Mix/Radio (`list=RD…`)** keeps paging, so always cap it. Only `watch?v=X&list=RDX` lists a mix; `playlist?list=RD…` fails with "This playlist type is unviewable" (we rewrite `RD<video id>` to the watch form). When YouTube has no mix for the seed (e.g. `jNQXAC9IVRw`), yt-dlp warns "Unable to recognize playlist. Downloading just video" and returns `_type: video`, exit 0. `RDCLAK5uy_…` lists are finite YouTube Music playlists, not mixes.
- **Channel root URLs** return nested tab playlists (`- Videos`, `- Shorts`, each cut by `-I` too). Resolve `<channel>/videos` instead.
- **YouTube Music:** `music.youtube.com/browse/MPREb_…` warns "YouTube Music is not directly supported. Redirecting to …playlist?list=OLAK5uy_…" and returns that album playlist (title `Album - …`, null top-level uploader). `music.youtube.com/watch` tracks carry `track`, `artist`, `artists`, `album`, `release_year`. Shorts have the same shape as videos.
- **Timing:** single video `-J` 1.7–2.6 s (93–636 KB); small flat lists 1–2 s; 5001 rows 38–56 s and 3.7–6.7 MB.
- **Huge playlists:** for progressive listing, `--flat-playlist --lazy-playlist -j` prints one JSON object per line (not used yet).
- **SoundCloud URL types:**
  - `/<user>` covers tracks, sets and reposts; `/tracks`, `/albums`, `/sets`, `/reposts` and `/likes` are separate pages.
  - Secret `/s-XXXX` links work. `on.soundcloud.com` short links have no extractor pattern: the generic extractor follows the redirect (one extra non-API request) and returns the track with `original_url` = the short link.

## Download (one track per process)
Implemented in `engine/ytdlp-args.ts` (`downloadArgs`, `downloadSelector`) and `jobs/attempt.ts`; recorded live 2026-10-02 (fixtures in `apps/server/test/fixtures/downloads/`). yt-dlp **only downloads**: no `-x`, no `--embed-*`, no `--convert-thumbnails`. Our finalize converts, tags and adds the cover (ADR-015), because `-x` converts without saying so (MP3 → AAC for M4A, 24-bit FLAC from Opus), copies an MP3 source for "MP3 320", leaks the source's tags and can't make AIFF.
```
yt-dlp <base> --no-playlist -f <selector>
  --socket-timeout 20 --retries 3 --fragment-retries 3 --retry-sleep fragment:exp=1:8
  --abort-on-unavailable-fragments --max-filesize 2G
  [--write-thumbnail]                          embedArtwork and canHoldCover: not WAV, not a YouTube original
  [--ffmpeg-location <FFMPEG_PATH>]            only when FFMPEG_PATH is set
  [SoundCloud:  --extractor-retries 0 --break-match-filters "format_id!*=preview"]
  [other sites: --match-filters "!is_live"]
  -P <jobDir> -o "%(id)s.%(ext)s"
  --newline --progress --progress-delta 0.5
  --progress-template "download:DL %(progress)j"
  --progress-template "postprocess:PP %(progress.postprocessor)s %(progress.status)s"
  --print "before_dl:START %(.{format_id,acodec,abr,asr,protocol,available_at,playlist_id})j"
  --print "after_move:DONE %(.{id,filepath,ext,format_id,acodec,abr,asr,duration,title,track,artist,artists,uploader,channel,album,album_artist,release_year,release_date,webpage_url,extractor_key,availability,thumbnails.-1.filepath,thumbnails.-1.url})j"
  -- <the classified URL>
```
- `<jobDir>` is `<dataDir>/jobs/<attemptId>`, absolute and real (`downloadArgs` throws otherwise). The startup sweep finds leftover processes by that path in their argv.
- The URL is `checkUrl(ref.url)`'s classified URL, classified again by the attempt; never the request's string.
- **Selectors** (`downloadSelector`, by the classified platform):

| Platform | mp3, flac, wav, aiff, original | m4a |
|---|---|---|
| YouTube | `ba` (usually Opus 251) | `ba[ext=m4a]/ba` (AAC 140, then copied) |
| SoundCloud | `ba[acodec!=opus]/ba` | `ba[ext=m4a]/ba[acodec!=opus]/ba` |
| other | `ba/b` | `ba[ext=m4a]/ba/b` |

  SoundCloud's 64k Opus ranks above its AAC and MP3 but no DJ app plays it, so it is taken only when nothing else exists; resolve's `audioSource` skips it the same way, so the source shown is the one downloaded. Default formats, no `--extractor-args soundcloud:formats=…` (a track without those formats fails with "No video formats found!").
- **Why the flags:**
  - `--abort-on-unavailable-fragments`: without it, a fragment that fails every retry is **skipped silently**: exit 0, DONE printed, and a shorter file (`local-hls-missing`: 5.04 s of 6.04 s).
  - `--fragment-retries 3 --retry-sleep fragment:exp=1:8`: the defaults retry 10 times with no sleep and ignore `Retry-After`. `--retries` retries only 5xx and transport errors; a 4xx on a plain download fails at once.
  - `--extractor-retries 0` (SoundCloud): fails on the first 429 so our cooldown takes over; `1` still retries once (from source).
  - `--max-filesize 2G`: enforced only by the plain HTTP downloader; HLS ignores it.
  - `--break-match-filters "format_id!*=preview"`: a Go+ preview stops with exit 101, both streams empty, nothing written (`soundcloud-preview-break`). `--match-filters` would exit 0 with no DONE line instead.
  - `--match-filters "!is_live"` (other sites): no endless live recording.
  - `--write-thumbnail` only when the file can hold a cover (`canHoldCover(format, platform)` in `finalize-plan.ts`). The thumbnail is fetched before START, before the stream is known, and there is no per-format option, so the rule uses the format and platform: a YouTube original is `ba` = Opus 251 in WebM (checked live on three videos, 2026-10-03), so it fetches none; a SoundCloud original (MP3 or AAC) keeps its cover. A YouTube original that came out AAC would get no cover (not seen).
  - No `-o thumbnail:…` template: MoveFiles renames the file but DONE keeps the old path.
  - No `--sleep-*` flags: they are silent in quiet mode, and our queue paces (see Rate limits & pacing).
- **What the job dir holds afterwards:** `<id>.<ext>` as downloaded (after yt-dlp's FixupM4a/FixupM3u8) and the thumbnail as served (YouTube WebP, SoundCloud JPEG or a placeholder PNG). Finalize works in `<jobDir>/finalize/`.
- **SoundCloud originals** (Phase 4, with a login): the `download` format is the uploader's original, ranked first, and fails with HTTP 401 without a login instead of falling back. Prepend `download/` to the selector only for logged-in SoundCloud jobs, and keep `audioSource` in step.

## Finalize (ours, after the `DONE` line)
`engine/finalize.ts` runs it; every decision is pure in `engine/finalize-plan.ts`, and the ID3 writer is `engine/id3.ts`. Exact argv and the facts behind each rule are in reference.md > Finalize recipes.
1. **Check DONE.** `filepath` and `thumbnails.-1.filepath` must realpath to regular files inside the job dir; otherwise the run counts as `unknown` (no cover, for the thumbnail).
2. **Probe the download** with ffprobe (`ffprobeArgs`). An MP3 (demuxer `mp3`) is also **measured** (`measureArgs`: `-nostats -progress pipe:1 … -map 0:a:0 -c:a copy -f null -`, the last `out_time_us`): without a Xing header ffprobe estimates its length from the first frame (a 600 s VBR file probes as 2,413 s, `ffprobe/src-mp3-vbr-noxing.json`). That duration must be within max(2 s, min(1 %, 10 s)) of DONE's `duration`, else `network` ("The download is incomplete"); it is also the input's duration for every later check.
3. **Plan** (`planAudio`): copy when the source already has the target codec, else encode: MP3 → libmp3lame 320k CBR, M4A → aac 256k, FLAC → 16-bit, WAV/AIFF → 16-bit PCM. "Original" copies into a container from a closed table. More than two channels → `-ac 2`. Native sample rate. The Job's `output.encoded` says which.
4. **Cover** (embedArtwork; mp3, m4a, flac, aiff): skip placeholders (`i.ytimg.com/img/no_thumbnail.jpg`, `sndcdn.com/images/default_avatar_*`, `…sndcdn.com/avatars-…`), sniff JPEG/PNG/WebP from the first bytes, and make a baseline JPEG of at most 1000 px. A failure only loses the artwork.
5. **Audio pass:** `-map 0:a:0` (+ `-map 1:v:0` for an M4A/FLAC cover), `-map_metadata -1 -map_chapters -1`, ffmpeg's `-metadata` tags except for MP3/AIFF, explicit `-f`, `-xerror` when it decodes anything but an MP3 (a stitched MP3's mid-stream ID3 tag is "Header missing", fatal with `-xerror`). **Never `-vn`**: it silently drops a mapped cover too. "No space left on device" on stderr is `disk_full`; else the error text is the last line without its (nested) `[name @ 0x…] ` prefixes, skipping ffmpeg 8's "Terminating thread …"/"Task finished …" trailers.
6. **Read back** the output with ffprobe: the planned codec, ffmpeg's title/artist, the cover when planned, and a duration matching the input's. ffmpeg's exit 0 proves nothing: it exits 0 on truncated input (a truncated WebM became a 4.8 s MP3 of a 19 s track, even with `-xerror`) and on an existing output with `-n`.
7. **MP3 and AIFF:** our ID3v2.3 tag (TIT2, TPE1, TALB, TPE2, TYER, COMM, APIC), because ffmpeg 8 writes any comment as `TXXX:comment` (ADR-016). MP3: tag + audio into `final.mp3`. AIFF: an `ID3 ` chunk appended and the FORM size rewritten.
8. **Comment URL** (`commentUrl`): DONE's `webpage_url` only, on YouTube or SoundCloud, when neither it nor the input is a secret link, the input isn't a SoundCloud short link, and `availability` is `public` (a missing value counts as public on SoundCloud only). Else no comment.
9. **Artist/title:** platform fields (`track`, `artist`/`artists`), else the title split at the **first** ` - `, ` – ` or ` — ` (`trackNames`, as resolve does), else the uploader without " - Topic". yt-dlp's README recipe `--parse-metadata "title:%(artist)s - %(title)s"` splits at the *last* dash. Album and year only from `album` and `release_year`/`release_date`, never `upload_date`.
10. **Name and publish:** the filename template rendered and sanitized (`filename.ts` in shared: ≤ 180 UTF-16 units and ≤ the UTF-8 bytes the folder's real path leaves of 1,023, macOS/Windows/FAT-safe), the extension from our muxer table, never from DONE. Publish rechecks the folder and claims the name with `link` or an exclusive create, never `rename`: an existing file means `skipped` (ADR-018).

## Output parsing
Implemented in `engine/ytdlp-progress.ts` (`parseDownloadLine`, never throws) and `jobs/attempt.ts`.
- **Streams** (quiet, since `--print` implies `--quiet`):
  - stdout: `DL {json}`, `START {json}` and `DONE {json}`.
  - stderr: `PP <postprocessor> <status>` (the postprocess template goes to the screen stream, which is stderr when quiet) and the `WARNING:` / `ERROR:` lines.
  - `--no-quiet` moves everything to stdout and mixes in URLs and paths: don't use it.
- **No progress without `--progress`:** `--print` implies `--quiet`.
- **Line order:** START, the DL lines, PP lines (FixupM4a, FixupM3u8, MoveFiles), DONE, exit. With `--write-thumbnail` the thumbnail is fetched before START (3–5 s to START on YouTube).
- **START** (`before_dl`, before any wait): only the keys that exist (SoundCloud has no `asr` or `available_at`). It gives the job's `source`; keep `acodec` as reported (`mp4a.40.2` for AAC). A START with a `playlist_id`, a second START or a second DONE means the URL is a list: stop the run (`invalid_request`).
- **Forced waits:** YouTube sets `available_at` on its formats. When it is in the future, yt-dlp sleeps `available_at − int(now)` seconds between START and the first DL line, **silently** in quiet mode ("Sleeping N seconds as required by the site" is suppressed). Show `progress.waitingUntil` (that instant) until the first DL line. Skipping the wait gets HTTP 403. Not yet seen live: the sample video has `available_at` = now, so `youtube-ba-wait` is synthetic.
- **DL** (`%(progress)j`, ~1 KB with two absolute paths: never forward it raw): `status` (`downloading`/`finished`), `downloaded_bytes`, `total_bytes` (HTTP) or `total_bytes_estimate` (HLS), `fragment_index` (fragments done)/`fragment_count`, `speed`, `eta` (null on early lines). `_percent` can be `false` (source), so compute the percent:
  - with `fragment_count`: `fragment_index / fragment_count`. HLS estimates jump (4.3 % → 0.08 % → 29.8 % by bytes in `soundcloud-hls-aac`, against 0 → 4.3 → 30.4 % by fragments);
  - else `downloaded_bytes / (total_bytes ?? total_bytes_estimate)`;
  - clamp to [0, 100], 100 on `finished`, and never let it go back within an attempt. Only `total_bytes` is reported as `totalBytes`.
  - A short YouTube track gives two DL lines (0.4 %, then `finished`) in under 0.2 s: there may be no other progress event.
- **Processing** starts at DL `finished`, or at a PP line after any DL. PP reports no percentage.
- **DONE** (`after_move`): missing keys are left out. `format_id`/`acodec`/`abr`/`asr` describe the source stream, `ext`/`filepath` the file (`filepath` is the `-P` path as passed). YouTube has `availability: public`, `channel` and an integer `duration`; SoundCloud has no `availability`, `asr` or `channel`, and `track` equals `title`. Without `--write-thumbnail` there's no `thumbnails.-1.filepath`, and `thumbnails.-1.url` is a candidate that was never fetched. `%()j` output is ASCII-only (`̈`). DONE can hold a secret `webpage_url`: never log it.
- **Exit codes:**
  - `0` ok; but **0 without DONE** means nothing was downloaded (a live stream filtered out, or over `--max-filesize`)
  - `1` error, also after SIGINT
  - `2` bad options, which means **our bug** (or a yt-dlp too old for a flag)
  - `100` update failed
  - `101` a `--break-*` filter (our preview filter) or `--max-downloads` stopped the run

## Cancel
1. Send SIGINT to the process group: `process.kill(-pid, 'SIGINT')`. yt-dlp exits 30–70 ms later with exit 1 and `ERROR: Interrupted by user`, and its ffmpeg (a fixup) stops too. Don't use SIGTERM: yt-dlp has no handler for it, and it can orphan ffmpeg. Our own ffprobe/ffmpeg passes are stopped the same way.
2. After 3 s (`KILL_GRACE_MS`), send SIGKILL to the group.
3. `run.ts` SIGKILLs the group whenever a run closes, also after a normal exit, so no member (e.g. the ffmpeg of a python that died abnormally) still writes once `run` has settled. Then delete the job dir: `.part`, `.ytdl`, the thumbnail, `finalize/`.

A cancel never stops publish's name claim once it has begun: a file that reached the folder stands. A job still waiting for its turn to claim stops at once. Shutdown cancels every running job. At startup, the sweep SIGKILLs process groups whose argv names `<dataDir>/jobs/<uuid>` and removes stale job dirs and part files (ADR-018).

## Errors → ErrorCode
Implemented in `apps/server/src/engine/ytdlp-errors.ts` (ordered tables; fixtures in `apps/server/test/fixtures/errors/` and `downloads/`, synthetic ones marked). Only `ERROR:` lines decide; the last one with a specific code wins. Wording verified 2026-10-02:

| stderr contains | ErrorCode | Note |
|---|---|---|
| `Unsupported URL`, `playlist type is unviewable`, `DRM`, `website is not supported` | `unsupported_url` | Unsupported URL has no `[ie]` prefix |
| `is not a valid URL` | `invalid_url` | |
| `ffmpeg not found`, `ffprobe not found` | `engine_missing` | e.g. `Postprocessing: ffprobe and ffmpeg not found` |
| `Interrupted by user` | `canceled` | our SIGINT |
| `[Errno 28]`, `No space left on device`, `[Errno 69]`/`Disc quota exceeded` | `disk_full` | the job dir's drive (the data dir): `unable to write data: …`, `unable to open for writing: … '<path>'`, and from fragments `Unable to download video: [Errno 28] …`, which would otherwise read as network |
| `isn't available, try again later`, `HTTP Error 429` | `rate_limited` | YouTube's starts with `Video unavailable.`, so check before `unavailable` |
| `This content isn’t available.` (no "try again later"), `not a bot`, `captcha` | `bot_check` | U+2019 apostrophe; a blocked session, not the hourly limit |
| `confirm your age` | `age_restricted` | also says "Sign in" and "cookies", so check before login |
| `Private video` | `private` | |
| `available in your country`, `geo restrict`, `from your location` | `geo_blocked` | YouTube's text is "has not made this video available in your country" |
| `members-only`, `channel's members`, `registered users`, `HTTP Error 401` | `login_required` | SoundCloud originals never say 401: it's the WARNING "Original download format is only available for registered users" + `Requested format is not available` (that WARNING is the one hint consulted when the ERROR line is generic) |
| `This video is unavailable`, `Video unavailable`, `has been removed`, `does not exist`, SoundCloud `HTTP Error 404` | `unavailable` | a missing YouTube id says "This video is unavailable" |
| `HTTP Error 403`, `Requested format is not available` | `unknown` | with a readable "update yt-dlp" message |
| `Postprocessing: …`, `Conversion failed` | `postprocess_failed` | |
| `HTTP Error 5xx` | `network` | |
| `N bytes read, M more expected`, `Downloaded N bytes, expected M bytes`, `content too short`, `Did not get any data blocks` | `network` | a transfer cut short ("The connection dropped"): IncompleteRead's text has no class name, usually as `ERROR: \r[download] Got error: …` (`errors/local-cut.log`) |
| `Unable to download webpage`/`JSON metadata`, `timed out`, `Failed to resolve`, `Connection refused`/`reset` | `network` | last: 404/429 also say "Unable to download …" |

Downloads add **transfer errors**, read first (`TRANSFER_PATTERNS`). The track was found and its stream picked, so a refused media request is never "removed" or a login:

| stderr | ErrorCode | Fixture |
|---|---|---|
| `ERROR: \r[download] Got error: HTTP Error 429: … Giving up after 3 retries` (a fragment), `ERROR: unable to download video data: HTTP Error 429` (a plain download) | `rate_limited` | `local-hls-429`, `local-progressive-429` |
| the same with any other 4xx or a 5xx | `network` | `local-hls-404` |
| `ERROR: fragment 3 not found, unable to continue` | `network` | only when no ERROR line is specific (`FALLBACK_PATTERNS`): it follows the real reason |

- **No paths in messages:** the job dir (passed as `jobDir`) and any quoted absolute path (Python's `OSError` text, `'…'`) are cut out of stderr before anything is matched or quoted.
- **The `\r` split:** a download that gives up prints `ERROR: \r[download] Got error: …`. `run.ts` splits lines at `\r`, so the mapper glues an empty `ERROR:` line to the `[download] Got error:` line after it.
- **Exit 101** (`mapDownloadExit`): on SoundCloud (the break filter is on) with no `ERROR:` line, it is a Go+ preview → `preview_only`. A list URL whose next row is a preview ends the same way (`soundcloud-list-break`), so the attempt checks START's `playlist_id` first. Any other 101 → `unknown`.
- **Exit 2** (`yt-dlp: error: …`, no `ERROR:` line) means bad options: our bug, or a yt-dlp too old for a flag we pass.
- `PP …` lines are never quoted as a reason, even when they are stderr's last line.
- **Previews never appear in stderr.** With `--print` or `-J`, `--match-filters "format_id!*=preview"` rejects silently (exit 0, no DONE line); the "does not pass filter" line goes to stdout only with `--no-quiet`. `--break-match-filters` exits 101 silently (what downloads use); `-f 'ba[format_id!*=preview]'` gives `Requested format is not available`.

## Rate limits & pacing
Our queue paces downloads (`pacing/gates.ts`, ADR-017); yt-dlp gets no `--sleep-*` flags (they are silent in quiet mode and per process) and bounded retries only.
- **YouTube without login** allows about 300 videos per hour; past that you get "This content isn't available, try again later" (`rate_limited`). The YouTube gate is a token bucket: a burst of 10 downloads, then one per 12 s.
- **SoundCloud** allows about 600 API requests per 10 min. Each track costs one lookup plus one call per stream type (3–5 with default formats), and a download costs about the same.
  - Enrichment (`resolve/limiter.ts`) and downloads take from **one** shared bucket (a burst of 25, one per 5 s; ADR-014, ADR-017). Downloads leave its last 5 tokens to lookups, so rows in view still fill.
  - `--extractor-retries 0`, so a 429 fails at once instead of repeating every format request.
  - Format narrowing (`--extractor-args "soundcloud:formats=…"`) would save 1–2 calls, but a track without those formats fails with "No video formats found!" (`errors/soundcloud-no-formats.log`). We keep the default formats.
- **Cooldown** on `rate_limited` (any platform) or a YouTube `bot_check`: the platform pauses 60 s, doubling to 10 min; the job goes back to the front of the queue; a failure that started inside the pause adds no strike; after a pause one job runs at a time until one succeeds; a job that caused 3 strikes fails; a bot check that reaches 10 min twice in a row fails YouTube's whole queue. The enricher keeps its own cooldown.
- **Go+ previews:** SoundCloud Go+ tracks only have 30-second `<protocol>_<preset>_preview` formats without a subscription (e.g. `hls_mp3_0_0_preview`, `duration: 30.0`); yt-dlp picks one anyway. Resolve marks such tracks `preview_only` from their formats, a ref marked so fails at enqueue without a spawn, and the break filter catches an unmarked one (exit 101). Never deliver a preview as the track. From a region where the track is geo-blocked, SoundCloud reports a geo restriction instead.

## Cookies & logins (opt-in, per platform)
- Use them only for age-restricted or members-only YouTube videos, and for SoundCloud originals or Go+. Pass `--cookies-from-browser <browser>` to that platform's jobs only.
- Logged-in YouTube cookies are currently unreliable ("The page needs to be reloaded", issue #17389) and put the account at risk. Prefer no cookies.
- PO-token plugins (bgutil) aren't needed for public videos with the default clients. Revisit only if bot checks become routine.
