# yt-dlp error fixtures

Recorded 2026-10-02 and 2026-10-03 on macOS 26.5.1 (arm64) with Homebrew yt-dlp **2026.08.19**, without cookies or a login, from a Serbian IP. Each `.log` is **stderr verbatim** (WARNING lines included) unless the Stream column says otherwise. stdout was empty unless noted.

Base argv for every recording:
```
yt-dlp --ignore-config --no-update --color never --encoding utf-8 --js-runtimes node:"$(command -v node)" <options> -- <url>
```

## Recorded
| File | URL | Options | Exit | Stream | Notes |
|---|---|---|---|---|---|
| `unsupported.log` | `https://example.com/` | `-J --flat-playlist` | 1 | stderr | `WARNING: [generic] Falling back on generic information extractor`, then `ERROR: Unsupported URL: …` (no `[ie]` prefix). |
| `youtube-unavailable.log` | `https://www.youtube.com/watch?v=aaaaaaaaaa0` | `-J --flat-playlist --no-playlist` | 1 | stderr | Nonexistent id: `This video is unavailable`. It does **not** contain `Video unavailable`. |
| `youtube-removed.log` | `https://youtube.com/watch?v=Cr381pDsSsA` | `-J --flat-playlist --no-playlist` | 1 | stderr | yt-dlp's "non-bypassable age-gated" test video, now `removed for violating YouTube's Terms of Service`. |
| `youtube-private.log` | `https://www.youtube.com/watch?v=bM7SZ5SBzyY` | `-J --flat-playlist --no-playlist` | 1 | stderr | `Private video`. |
| `youtube-age-restricted.log` | `https://www.youtube.com/watch?v=Tq92D6wQ1mg` | `-J --flat-playlist --no-playlist` | 1 | stderr | `Sign in to confirm your age. Use --cookies-from-browser …`: it contains "Sign in" and "cookies" too, so match age first. `HtVdAasjOgU` (age-gated, embeddable) resolved fine without cookies through the web_embedded client. |
| `youtube-playlist-missing.log` | `https://www.youtube.com/playlist?list=PLaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa` | `-J --flat-playlist` | 1 | stderr | `YouTube said: The playlist does not exist.`, once as WARNING, once as ERROR. |
| `youtube-mix-playlist-url.log` | `https://www.youtube.com/playlist?list=RDdQw4w9WgXcQ` | `-J --flat-playlist -I 1:51` | 1 | stderr | A mix opened without `v=`: `YouTube said: This playlist type is unviewable.` Mixes only resolve as `watch?v=X&list=RD…`. |
| `youtube-mix-unrecognized.log` | `https://www.youtube.com/watch?v=jNQXAC9IVRw&list=RDjNQXAC9IVRw` | `-J --flat-playlist --yes-playlist -I 1:51` | **0** | stderr | Warning only. stdout is a single video (`../youtube/mix-unrecognized.json`). |
| `soundcloud-404.log` | `https://soundcloud.com/ethmusic/this-track-does-not-exist-dj-scraper` | `-J --flat-playlist --no-playlist` | 1 | stderr | `Unable to download JSON metadata: HTTP Error 404: Not Found (caused by <HTTPError 404: Not Found>)`. |
| `soundcloud-user-missing.log` | `https://soundcloud.com/dj-scraper-no-such-user-8f3k2` | `-J --flat-playlist -I 1:12` | 1 | stderr | Same 404 text from `[soundcloud:user]`. |
| `soundcloud-geo-blocked.log` | `https://soundcloud.com/caravan-palace-official/mad` | `-J --flat-playlist --no-playlist` | 1 | stderr | Two lines: `ERROR: [soundcloud] This video is not available from your location due to geo restriction` (no id), then `You might want to use a VPN or a proxy server (with --proxy) to workaround.` |
| `soundcloud-401.log` | `https://soundcloud.com/the80m/the-following` | `-J --no-playlist -f download` | 1 | stderr | Original file without a login: the 401 is a WARNING (`Original download format is only available for registered users. …`), then `ERROR: … Requested format is not available. …`. The string `401` never appears. |
| `soundcloud-no-formats.log` | `https://soundcloud.com/the-concept-band/world-on-fire-1` | `-J --no-playlist --extractor-args soundcloud:formats=hls_aac` | 1 | stderr | A Go+ preview track whose only formats (mp3 previews) were excluded: `No video formats found!; please report this issue …`. |
| `soundcloud-metadata-only.log` | `https://api-v2.soundcloud.com/tracks/47127631` | `-J --no-playlist --extractor-args soundcloud:formats=none --ignore-no-formats-error` | **0** | stderr | Two warnings; stdout is `../soundcloud/entry-metadata-only.json`. |
| `preview-filter.log` | `https://soundcloud.com/the-concept-band/world-on-fire-1` | `--no-playlist --simulate --no-quiet --match-filters "format_id!*=preview" --print "after_move:DONE %(id)s"` | **0** | **stdout** | `[download] World On Fire (Re-Mastered) does not pass filter (format_id!*=preview), skipping ..`. This is a screen message on stdout, shown only with `--no-quiet`. With the real argv (`--print` or `-J`, both quiet) the same run prints **nothing** on either stream and exits 0. `-J` still dumps the full JSON. With `--break-match-filters` it prints nothing and exits **101**. |
| `preview-format-unavailable.log` | same | `--no-playlist --simulate -f "ba[format_id!*=preview]" --newline --progress --print "after_move:DONE %(id)s"` | 1 | stderr | Excluding previews in the selector instead: `Requested format is not available. Use --list-formats …` (the same text as any other selector miss). |
| `network-timeout.log` | `http://10.255.255.1/x` | `-J --flat-playlist --socket-timeout 2` | 1 | stderr | `[generic] x: Unable to download webpage: … timed out. (connect timeout=2.0) (caused by TransportError(…))` after about 2.8 s. The `0x…` object address changes per run. |
| `dns.log` | `https://nonexistent.invalid/` | `-J --flat-playlist` | 1 | stderr | `Unable to download webpage: … Failed to resolve 'nonexistent.invalid' ([Errno 8] nodename nor servname provided, or not known) (caused by TransportError(…))`. |

## Recorded offline
Recorded 2026-10-02 with the same yt-dlp 2026.08.19 and base argv, without network access: local `file://` sources (allowed only by `--enable-file-urls`), a closed local port, or a local socket that never answers. The source files were made in a scratch dir: `tone.mp3` is a 1 s sine (`ffmpeg -f lavfi -i sine=frequency=440:duration=1 -c:a libmp3lame -b:a 128k tone.mp3`), and `corrupt.mp3` is 4 KiB of `/dev/urandom`. "Download argv" means the shape from the ytdlp skill:
```
--no-playlist --enable-file-urls -f ba -x --audio-format mp3 --audio-quality 320K --embed-metadata
-P <jobdir> -o "%(id)s.%(ext)s" --newline --progress
--progress-template "download:DL %(progress)j"
--progress-template "postprocess:PP %(progress.postprocessor)s %(progress.status)s"
--print "after_move:DONE %(.{id,filepath})j"
```

| File | URL | Options | Exit | Stream | Notes |
|---|---|---|---|---|---|
| `bad-option.log` | `https://example.invalid/` | `--no-such-option -J` | **2** | stderr | optparse output: an empty line, `Usage: yt-dlp [OPTIONS] URL [URL...]`, an empty line, then `yt-dlp: error: no such option: --no-such-option`. There's no `ERROR:` line. |
| `invalid-url.log` | `notaurl` | `-J` | 1 | stderr | `ERROR: [generic] 'notaurl' is not a valid URL`, before any request. |
| `drm.log` | `https://music.amazon.com/albums/B0000000000` | `-J --flat-playlist` | 1 | stderr | KnownDRMIE matches the URL and fails without a request: `ERROR: [DRM] The requested site is known to use DRM protection. It will NOT be supported.`, then an indented `Please DO NOT open an issue, …` line. `open.spotify.com` gives the same text. Amazon Music is on `classifyUrl`'s DRM list now, so the server refuses this URL before yt-dlp starts; the log stands for a DRM site that list misses. |
| `ffmpeg-missing.log` | `file://…/tone.mp3` | download argv, run as `env PATH=/usr/bin:/bin /opt/homebrew/bin/yt-dlp …` so neither ffmpeg nor ffprobe is found | 1 | stderr | `PP ExtractAudio started`, then `ERROR: Postprocessing: ffprobe and ffmpeg not found. Please install or provide the path using --ffmpeg-location`. |
| `postprocess-no-codec.log` | `file://…/corrupt.mp3` | download argv | 1 | stderr | `ERROR: Postprocessing: WARNING: unable to obtain file audio codec with ffprobe`: an ERROR line that contains `WARNING:`. |
| `postprocess-conversion.log` | `file://…/tone.mp3` | download argv with `--audio-format wav` instead of mp3, no `--audio-quality`/`--embed-metadata`, plus `--postprocessor-args "ExtractAudio:-af nosuchfilter"` to make ffmpeg fail | 1 | stderr | `ERROR: Postprocessing: audio conversion failed: Error opening output files: Filter not found`. The text after `failed: ` is ffmpeg's last stderr line. |
| `interrupted.log` | `http://127.0.0.1:<port>/x` (a local socket that accepts and never answers) | `-J --flat-playlist --socket-timeout 20`, then SIGINT to the process group after 2 s | 1 | stderr | An empty line, then `ERROR: Interrupted by user`: what our cancel path produces. |
| `connection-refused.log` | `http://127.0.0.1:9/x` (closed port) | `-J --flat-playlist --socket-timeout 20` | 1 | stderr | `ERROR: [generic] x: Unable to download webpage: HTTPConnection(…): Failed to establish a new connection: [Errno 61] Connection refused (caused by TransportError(…))`. |

## Recorded offline with the download argv
Recorded 2026-10-03 with the same yt-dlp 2026.08.19, spawned with `src/engine/ytdlp-args.ts`'s `downloadArgs` verbatim (platform `other`, format `mp3`, no thumbnail: selector `ba/b`, `--match-filters '!is_live'`) against a Node HTTP server on `127.0.0.1:<port>`. Only stderr is kept; stdout held START and the DL lines. `{JOBDIR}` stands for the absolute job dir (`<scratch>/jobs/<uuid>`); tests put a real-looking one back. The full-disk cases used a job dir on a 2 MB HFS+ disk image (`hdiutil create -size 2m -fs HFS+ -layout NONE`, attached with `-nobrowse`); the source was 4.8 MB (150 s of pink noise, MP3 256k), the HLS one 120 s of AAC 256k in 13 segments of 10 s.

| File | Server | Exit | Notes |
|---|---|---|---|
| `local-enospc-write.log` | `/big.mp3`, 200 with `Content-Length` | 1 | The disk filled up mid-transfer: two empty lines, then `ERROR: unable to write data: [Errno 28] No space left on device` (`downloader/http.py` 277). The `.part` was 1.9 MB. |
| `local-enospc-open.log` | the same, the disk filled by another file after the job dir was made | 1 | `ERROR: unable to open for writing: [Errno 28] No space left on device: '{JOBDIR}/big.mp3.part'` (`http.py` 270): Python's `OSError` text quotes the path. |
| `local-enospc-hls.log` | `/hls/index.m3u8` (fragments) | 1 | `ERROR: Unable to download video: [Errno 28] No space left on device`: the fragment downloader's `OSError` becomes `UnavailableVideoError` (`YoutubeDL.py` 3600), whose text starts like the network row's "Unable to download". |
| `local-cut.log` | `/cut.mp3`: `Content-Length` 97,009, every response cut after 50,000 bytes | 1 | `ERROR: \r[download] Got error: 50000 bytes read, 47009 more expected. Giving up after 3 retries`: `IncompleteRead`'s text without its class name (`networking/exceptions.py` 76–84), through the `\r` transfer form. |
| `local-no-data.log` | `/empty.mp3`: 200 with a body for the extraction request, then 200 with no body and no length | 1 | Two empty lines, then `ERROR: Did not get any data blocks` (`http.py` 329). |

`src/engine/ytdlp-errors.test.ts` maps every `.log` here and fails when a new one has no expected code.

## Synthetic
These are built from upstream logs and source; none were recorded here. Exit codes are what yt-dlp returns for an ERROR line: 1.

| File | Source | Notes |
|---|---|---|
| `youtube-geo-blocked.log` | Lines 1–2 verbatim from github.com/yt-dlp/yt-dlp/issues/16158 (2026-03). Line 3 comes from `YoutubeDL.py` 2026.08.19, lines 1741–1747 (`GeoRestrictedError` → `\nThis video is available in …` + `\nYou might want to use a VPN …`). | Three lines; only the first starts with `ERROR:`. |
| `youtube-copyright-geo.log` | The reason text is the one yt-dlp users report for a label's regional copyright block (`This video contains content from SME, who has blocked it in your country on copyright grounds.`). It's joined as `extractor/youtube/_video.py` 2026.08.19 lines 4053–4062 build it: the error screen's `reason` (`Video unavailable`) + `. ` + its `subreason`. Only the subreason `The uploader has not made this video available in your country` takes the `raise_geo_restricted` path (`youtube-geo-blocked.log`), so this one reaches us as a plain `ERROR: [youtube] <id>: …` line. The id is a placeholder. | Starts with `Video unavailable.`, so match geo before unavailable. The same block worldwide (`who has blocked it on copyright grounds`) is `unavailable`. |
| `youtube-bot-check.log` | Verbatim from github.com/yt-dlp/yt-dlp/issues/17690 (2026-09); the same line appears in #17406 and #17592. | `you’re` uses U+2019. Contains "Sign in" and "cookies", like the age error. |
| `youtube-rate-limited.log` | Message verbatim from github.com/yt-dlp/yt-dlp/issues/14921. The `ERROR: [youtube] <id>: ` prefix is added as `extractor/youtube/_video.py` lines 4069–4076 raise it; the id is a placeholder. | Starts with `Video unavailable.`, so match rate limits before unavailable. ASCII apostrophe in `isn't`. |
| `youtube-content-unavailable.log` | Verbatim from github.com/yt-dlp/yt-dlp/issues/15767 (also #16307, #13583). | `This content isn’t available.` (U+2019, no "try again later"): per the maintainer in #13583 the account/session is blocked (#10085), which is different from the hourly rate limit. |
| `youtube-members-only.log` | Verbatim from github.com/yt-dlp/yt-dlp/issues/15670. | `Join this channel to get access to members-only content like this video, …` |
| `youtube-members-only-level.log` | Verbatim from github.com/yt-dlp/yt-dlp/issues/15346. | `This video is available to this channel's members on level: … Join this channel to get access to members-only content and other exclusive perks.` |
| `soundcloud-429.log` | Built from `extractor/soundcloud.py` lines 807–817 (format requests retried on 429 with a one-time warning), `utils/_utils.py` lines 5292–5303 (`RetryManager.report_retry`: `<err>. Retrying (n/3)...`, then re-raises), and `YoutubeDL.py` lines 1750–1752 (CLI `ignoreerrors='only_download'` reports a non-extractor exception as `ERROR: <str(e)>`). | The rate limit hit on stream-URL requests: 3 retries (the default `--extractor-retries 3`), then a bare `ERROR: HTTP Error 429: Too Many Requests` without an `[ie]` prefix. Unverified live. |
| `soundcloud-429-info.log` | The real `soundcloud-404.log` line with the 429 text from github.com/yt-dlp/yt-dlp/issues/15093 (`HTTP Error 429: Too Many Requests (caused by <HTTPError 429: Too Many Requests>)`). | The rate limit hit on the first (info JSON) request, which is not retried. |
| `unknown.log` | `extractor/youtube/_video.py` line 3189 (`Failed to extract any player response`), with the `bug_reports_message()` suffix from `utils/_utils.py` lines 956–966. | No ErrorCode pattern should match. It's what a YouTube change looks like before yt-dlp catches up. |

## Re-recording
```
yt-dlp --ignore-config --no-update --color never --encoding utf-8 --js-runtimes node:"$(command -v node)" \
  -J --flat-playlist --no-playlist -- 'https://www.youtube.com/watch?v=bM7SZ5SBzyY' \
  >/dev/null 2> test/fixtures/errors/youtube-private.log; echo "exit $?"
```
Check new logs for tokens before committing. Runs with `-v`, and short-link (`on.soundcloud.com`) runs that fail after the redirect, print the redirect target, which carries `si=`/`utm_` share-tracking parameters. Never record with cookies.
