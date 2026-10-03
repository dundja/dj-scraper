# yt-dlp download fixtures

Recorded 2026-10-02 on macOS 26.5.1 (arm64) with Homebrew yt-dlp **2026.08.19** (`2026.8.19_1`), ffmpeg/ffprobe 8.0, deno 2.9.7 and Node 24.12.0, without cookies or a login. Each case is a pair: `<case>.stdout.log` and `<case>.stderr.log`, captured separately as raw bytes (an empty file means the stream was empty). Every run used a fresh, empty job dir (mode 0700). How they are used:
- `src/engine/ytdlp-progress.test.ts` parses every line of every case: its `DOWNLOAD_FIXTURES` table holds one summary row per case (DL, PP, START and DONE counts, the last status, the DONE fields), and a meta-test fails when a case has no row or isn't a stdout + stderr pair.
- `src/engine/ytdlp-errors.test.ts` maps each run's exit: `DOWNLOAD_FAILURES` lists the expected code of every failed run, `DOWNLOAD_SUCCESSES` the runs that exited 0, and a meta-test checks that the two lists cover the directory.
- `../fake-yt-dlp.json` has a `download: '<case>'` rule for every §4 case, which `../../fake-yt-dlp.mjs` replays (lines, files, `{JOBDIR}` and `{NOW+n}` filled in) for the integration tests (`test/downloads.test.ts`, `test/lifecycle.test.ts`). The older `-x` cases below have none; `test/fake-yt-dlp.test.ts` lists them in `WITHOUT_RULES` with the reason.
- A new case needs all three, or the meta-tests fail.

The ffprobe JSON of the files these runs left behind, and of real finalize outputs made from them, is in `../ffprobe/`.

## Argv
Every run was spawned like `src/engine/run.ts` does it: `spawn('yt-dlp', argv, { shell: false, detached: true })`, stdout and stderr read separately. The argv is the Phase 2 design's download argv (§4), verbatim:
```
yt-dlp --ignore-config --no-update --color never --encoding utf-8 --js-runtimes node:<process.execPath>
  --no-playlist -f <SELECTOR>
  --socket-timeout 20 --retries 3 --fragment-retries 3 --retry-sleep fragment:exp=1:8
  --abort-on-unavailable-fragments --max-filesize 2G
  [--write-thumbnail]
  [SoundCloud: --extractor-retries 0 --break-match-filters 'format_id!*=preview']
  [other:      --match-filters '!is_live']
  [EXTRA]
  -P <jobdir> -o '%(id)s.%(ext)s'
  --newline --progress --progress-delta 0.5
  --progress-template 'download:DL %(progress)j'
  --progress-template 'postprocess:PP %(progress.postprocessor)s %(progress.status)s'
  --print 'before_dl:START %(.{format_id,acodec,abr,asr,protocol,available_at,playlist_id})j'
  --print 'after_move:DONE %(.{id,filepath,ext,format_id,acodec,abr,asr,duration,title,track,artist,artists,uploader,channel,album,album_artist,release_year,release_date,webpage_url,extractor_key,availability,thumbnails.-1.filepath,thumbnails.-1.url})j'
  -- <url>
```
- `<jobdir>` was `<scratch>/jobs/<uuid>`, like `<dataDir>/jobs/<attemptId>`. `--ffmpeg-location` was not passed (`FFMPEG_PATH` unset).
- **EXTRA** is empty except where the table says so. Extra options are not part of §4: they make a case observable or keep it small.
- Selectors (design D7): **YT-BA** = `ba` (mp3/flac/wav/aiff/original on YouTube), **YT-M4A** = `ba[ext=m4a]/ba`, **SC-BA** = `ba[acodec!=opus]/ba`, **SC-HLS** = `ba[protocol^=m3u8][acodec!=opus]/ba[protocol^=m3u8]` (**forced**, not a §4 selector: the secret test track's own pick is `http_mp3_0_0`), **OTHER** = `ba/b`.
- **THUMB** = `--write-thumbnail` (what the mp3/m4a/flac/aiff/original targets pass); **no thumb** = as for WAV.
- URLs: **YT** = `https://www.youtube.com/watch?v=jNQXAC9IVRw` (19 s), **SC** = `https://soundcloud.com/jaimemf/youtube-dl-test-video-a-y-baw/s-8Pjrp` (10 s, secret; formats `hls_mp3_0_0` and `http_mp3_0_0` only), **SC-AAC** = `https://soundcloud.com/the-concept-band/knocked-up-mastered` (222 s; row 6 of `../soundcloud/set.json`), **GP** = `https://soundcloud.com/the-concept-band/world-on-fire-1` (Go+, preview formats only), **SET** = `https://soundcloud.com/the-concept-band/sets/the-royal-concept-ep` (set id 2284613; row 1 is GP, row 3 is a Go+ preview too).

## Cases (§4 argv)
All yt-dlp 2026.08.19, recorded 2026-10-02. "DL" lines are stdout, "PP" lines stderr, START/DONE stdout.

| Case | URL | Selector, flags, EXTRA | Exit | Streams | Files left in the job dir | Synthetic |
|---|---|---|---|---|---|---|
| `youtube-ba` | YT | YT-BA, THUMB | 0 | START `{format_id: "251", acodec: "opus", abr: 106.064, asr: 48000, protocol: "https", available_at}` (no `playlist_id`); 2 DL: `downloading` 1024/252182 B (`eta`/`speed` null) then `finished` 252182/252182; PP `MoveFiles started/finished`; DONE | `jNQXAC9IVRw.webm` (252,182 B, Opus 48 kHz), `jNQXAC9IVRw.webp` (23,038 B, 480×360) | no |
| `youtube-ba-wait` | YT | as `youtube-ba` | 0 | `youtube-ba` with START's `available_at` replaced by the token `{NOW+3}`: the fake must sleep until then, silently, before the first DL line | as `youtube-ba` | **yes** |
| `youtube-m4a` | YT | YT-M4A, THUMB | 0 | START `{format_id: "140", acodec: "mp4a.40.2", abr: 129.796, asr: 44100, protocol: "https", available_at}`; 2 DL (309,288 B); PP `FixupM4a`, `MoveFiles`; DONE | `jNQXAC9IVRw.m4a` (309,156 B after FixupM4a, AAC 128k 44.1 kHz), `.webp` | no |
| `youtube-ba-nothumb` | YT | YT-BA, no thumb | 0 | like `youtube-ba`; START `available_at` equals the second it was printed. DONE has **no** `thumbnails.-1.filepath`, and its `thumbnails.-1.url` is `…/maxresdefault.webp`, the top-ranked candidate that was never fetched | `jNQXAC9IVRw.webm` only | no |
| `youtube-cancel-download` | YT | YT-BA, THUMB, EXTRA `--limit-rate 50K` (to make the transfer last ~5 s); SIGINT to the process group 1.2 s after the first DL line (the group held only python) | **1** | START; 2 DL `downloading` (1024 B, `eta` 6; 31,744 B, 12.6 %); stderr: an empty line, `ERROR: Interrupted by user`. Exit 70 ms after the signal, no process left in the group | `jNQXAC9IVRw.webm.part` (64,512 B), `.webp` | no |
| `youtube-cancel-fixup` | YT | YT-M4A, THUMB; SIGINT to the group 20 ms after `PP FixupM4a started` (the group held python + ffmpeg) | **1** | START; 2 DL (`finished`); stderr `PP FixupM4a started`, an empty line, `ERROR: Interrupted by user`. No process left in the group | `jNQXAC9IVRw.m4a` (309,288 B: the download, not fixed up; no `.temp.m4a`), `.webp` | no |
| `soundcloud-ba` | SC | SC-BA, THUMB, SoundCloud flags | 0 | START `{format_id: "http_mp3_0_0", acodec: "mp3", abr: 128, protocol: "http"}` (**no `asr`, no `available_at`**); 2 DL: `downloading` 1024/158823 B (`eta` 0, `speed` set), `finished`; PP `MoveFiles`; DONE | `123998367.mp3` (158,823 B, MP3 128k 44.1 kHz), `123998367.png` (674 B, 100×100 placeholder) | no |
| `soundcloud-hls` | SC | **SC-HLS (forced)**, THUMB, SoundCloud flags | 0 | START `{format_id: "hls_mp3_0_0", …, protocol: "m3u8_native"}`; 3 DL: `downloading` frag 0/3 (1024 B, `total_bytes_estimate` 95289), frag 0/3 (3072 B), `finished` 158823 (`total_bytes` only here); PP `FixupM3u8`, `MoveFiles`; DONE | `123998367.mp3`, **byte-identical** to `soundcloud-ba`'s (md5 `e34a87fe…`), `.png` | no |
| `soundcloud-hls-aac` | SC-AAC | SC-BA, THUMB, SoundCloud flags | 0 | START `{format_id: "hls_aac_160k", acodec: "mp4a.40.2", abr: 160, protocol: "m3u8_native"}`; 7 DL: 6 `downloading` (frag 0/23, 1/23, 7, 13, 17, 21/23) then `finished` 4,481,339 B; `total_bytes_estimate` jumps 17,503 → 2,338,226 → 4.07–4.47 M, so bytes/estimate goes 4.3 % → 0.08 % → 29.8 % (fragments: 0 → 4.3 → 30.4 %); PP `FixupM4a`, `FixupM3u8`, `MoveFiles`; DONE | `47127631.m4a` (4,476,897 B, AAC 160k 44.1 kHz, brand isom), `47127631.jpg` (1,847,769 B, 1500×1500 JPEG). The only full-length download | no |
| `soundcloud-preview-break` | GP | SC-BA, THUMB, SoundCloud flags | **101** | both empty (the filter rejects before START) | none | no |
| `soundcloud-list` | SET | SC-BA, THUMB, SoundCloud flags, EXTRA `-I 2,6 --skip-download` (two full tracks; nothing downloaded) | 0 | 2 START lines, both with `"playlist_id": "2284613"` (a string); stderr `PP MoveFiles` ×2 (the skip-download path), then `PP Concat started/finished` (the playlist postprocessor). No DL, no DONE (a real run would download between the STARTs) | `2284613.jpg` (the set's artwork, written before the first entry), `47127625.jpg`, `47127631.jpg` | no |
| `soundcloud-list-break` | SET | as `soundcloud-list` but EXTRA `-I 2:3 --skip-download` | **101** | START with `playlist_id` + `PP MoveFiles` for row 2; row 3 is a Go+ preview, so the break filter ends the run silently | `2284613.jpg`, `47127625.jpg` | no |

### Offline, §4 argv (local server)
A Node HTTP server on `127.0.0.1:4799` served a 6 s AAC tone segmented by `ffmpeg -f lavfi -i sine=frequency=440:duration=6 -c:a aac -b:a 128k -f hls -hls_time 1 -hls_list_size 0` (7 fragments) behind a master playlist with `CODECS="mp4a.40.2"`. `seg2.ts` (fragment 3) answered 404 (`/missing/`) or 429 with `Retry-After: 30` (`/limited/`); `/flaky/tone.mp3` answered 200 once (extraction) and 429 after. Platform "other": OTHER selector, THUMB, `--match-filters '!is_live'`. Loopback addresses are kept.

| Case | URL | Exit | Streams | Files left | Synthetic |
|---|---|---|---|---|---|
| `local-hls-404` | `http://127.0.0.1:4799/missing/master.m3u8` | 1 | START `{format_id: "130", acodec: "mp4a.40.2", abr: 130.0, protocol: "m3u8_native"}`; 1 DL (frag 0/7); then **7 s of silence**: fragment 3 was requested 4 times (1 + `--fragment-retries 3`, sleeps 1, 2, 4 s). stderr `ERROR: \r[download] Got error: HTTP Error 404: Not Found. Giving up after 3 retries` (a carriage return inside the line) and `ERROR: fragment 3 not found, unable to continue` | `master.mp4.part` (MPEG-TS), `master.mp4.ytdl` | no |
| `local-hls-429` | `http://127.0.0.1:4799/limited/master.m3u8` | 1 | as `local-hls-404` with `HTTP Error 429: Too Many Requests. Giving up after 3 retries`; `Retry-After` ignored | same | no |
| `local-progressive-429` | `http://127.0.0.1:4799/flaky/tone.mp3` | 1 | START `{format_id: "mp2t", acodec: "mp3", protocol: "http"}` (the server's `video/mp2t` content type), then at once `ERROR: unable to download video data: HTTP Error 429: Too Many Requests`. One download request: `--retries` doesn't retry a 4xx | none | no |

## Older offline cases (argv predates §4)
Kept for their stderr: the `ERROR:` lines are what the error mapper needs, and the §4 runs above show the same lines (only the retry count differs: `--fragment-retries 3` says "after 3 retries"). Their argv is the old `-x` one: `--no-playlist -f ba -x --audio-format mp3 --audio-quality 320K` (`-f b` for the direct link), no START print, and an older DONE field set (with `original_url` and the whole `thumbnails` list), so their stdout and PP lines (`ExtractAudio`) don't match §4. Same server as above.

| Case | URL | Extra options | Exit | Notes |
|---|---|---|---|---|
| `local-hls-missing` | `/missing/master.m3u8` | none | **0** | Without `--abort-on-unavailable-fragments`, fragment 3 fails 11 times (1 + the default 10 retries, no sleep) and is **skipped silently**: DONE is printed and the MP3 lasts 5.04 s instead of 6.04 s |
| `local-hls-missing-noquiet` | same | `--no-quiet --fragment-retries 2` | 0 | The only trace is on stdout: `[download] Got error: HTTP Error 404: Not Found. Retrying fragment 3 (1/2)...` and `[download] fragment not found; Skipping fragment 3 ...` |
| `local-hls-missing-abort` | same | `--abort-on-unavailable-fragments` | 1 | `ERROR: \r[download] Got error: HTTP Error 404: Not Found. Giving up after 10 retries`, then `ERROR: fragment 3 not found, unable to continue`. Leaves `master.mp4.part` and `master.mp4.ytdl` |
| `local-hls-429-abort-r1` | `/limited/master.m3u8` | `--abort-on-unavailable-fragments --fragment-retries 1 --retry-sleep fragment:2` | 1 | 2 requests 2 s apart (the sleep is silent), then `ERROR: \r[download] Got error: HTTP Error 429: Too Many Requests. Giving up after 1 retries` and `ERROR: fragment 3 not found, unable to continue` |
| `local-http-429` | `/flaky/tone.mp3` | `-f b` | 1 | One request, no retry: `ERROR: unable to download video data: HTTP Error 429: Too Many Requests` |

The `-x` network recordings that used to live here (`youtube-mp3`, `youtube-flac`, `soundcloud-m4a`, the `-noquiet`/`-sleep`/`-cover-template` variants, …) are superseded by the §4 cases and were deleted.

## What the recordings show (for the parser and the fake)
- **Line order.** START, the DL lines, the PP lines, DONE, exit. With THUMB the thumbnail is written before START (yt-dlp writes it before the `before_dl` stage; a list URL also writes the list's own thumbnail first), so START comes later; no PP line precedes the download any more (no `--convert-thumbnails`). Time to START: YouTube 1.9 s without THUMB, 3.0–4.8 s with it; SoundCloud 1.1–1.6 s per track.
- **START** carries only the keys that exist: YouTube has `available_at` (seconds; up to 3 s before the moment START was printed, or equal to it), SoundCloud has neither `available_at` nor `asr`. `playlist_id` appears only for list entries. `acodec` is `mp4a.40.2` (not `aac`) for YouTube 140 and SoundCloud AAC.
- **DONE** leaves out missing keys. YouTube: `availability: "public"`, `channel`, `asr`, `duration` as an integer (19). SoundCloud: no `availability`, `asr` or `channel`; `track` always equals `title` (yt-dlp sets it from the title); `duration` a float. None of these tracks has `artist`, `artists`, `album`, `album_artist`, `release_year` or `release_date`.
- **Thumbnails.** With THUMB the written file is `<id>.<ext>` as served (no conversion): YouTube `hqdefault.webp` (480×360 WebP; this old video has no maxres), SoundCloud `-original.jpg` (1500×1500) or the placeholder `default_avatar_large.png`. `thumbnails.-1.filepath` names it and the file exists.
- **Percent.** HTTP lines have `total_bytes`; HLS lines have `total_bytes_estimate` (which can jump by 100×) and `fragment_index`/`fragment_count`. `_percent` was a number in every line.
- **Waiting.** In quiet mode a forced wait prints nothing: yt-dlp sleeps `available_at - int(time.time())` seconds between START and the first DL line.

## Placeholders
- `{JOBDIR}`: the absolute job dir, everywhere (raw and JSON-escaped `\/` forms; only the raw form occurred). `{HOME}` would replace the home directory; it did not occur. A fake must substitute its own job dir (the `-P` value) before replaying.
- `{NOW+<n>}`: an integer token in place of a number, unquoted inside START's JSON (`"available_at": {NOW+3}`), so the line is not JSON until the fake replaces it with `floor(now) + n` at replay time. Only in synthetic cases (`youtube-ba-wait`). Recorded `available_at` values stay numeric (they are in the past at replay time, which means "no wait").

## Scrub rules
- Checked for and absent: `googlevideo`, signed `sndcdn.com/…?…` URLs, `Policy=`, `Signature=`, `Key-Pair-Id=`, `expire=`, `sig=`, `secret_token`, `client_id`, `oauth_token`, any path under the home or scratch directory, and IPv4 addresses other than loopback `127.0.0.1`. DL lines carry only job dir paths; START carries no URLs.
- Kept verbatim: public thumbnail URLs (`i.ytimg.com/vi_webp/…`, `i1.sndcdn.com/artworks-…-original.jpg`, `a1.sndcdn.com/images/default_avatar_large.png`) and the public test track's secret path `/s-8Pjrp` in DONE `webpage_url` (as in `../soundcloud/track-secret.json`). A real secret link in DONE is a credential: never log DONE lines.
- No audio or image files are kept.
