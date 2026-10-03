# SoundCloud resolve fixtures

Recorded 2026-10-02 on macOS 26.5.1 (arm64) with Homebrew yt-dlp **2026.08.19**, without a login, from a Serbian IP. Some Go+ tracks are geo-blocked there; see `../errors/soundcloud-geo-blocked.log`. Each file is the stdout of one call, passed through `../trim.mjs` and then `biome format`.

Base argv for every file:
```
yt-dlp --ignore-config --no-update --color never --encoding utf-8 --js-runtimes node:"$(command -v node)" <options> -- <url>
```

| File | URL | Options | Exit | Notes |
|---|---|---|---|---|
| `track.json` | `https://soundcloud.com/ethmusic/lostin-powers-she-so-heavy` | `-J --flat-playlist --no-playlist` | 0 | Old upload: formats `hls_mp3_0_0`, `http_mp3_0_0`, `hls_aac_96k`. yt-dlp picks `hls_aac_96k` (AAC 96k ranks above MP3 128k). No `artist`/`genre`. |
| `track-secret.json` | `https://soundcloud.com/jaimemf/youtube-dl-test-video-a-y-baw/s-8Pjrp` | `-J --flat-playlist --no-playlist` | 0 | Secret link from yt-dlp's tests (the `s-…` path is the credential). MP3 only. `thumbnail` is the placeholder `https://a1.sndcdn.com/images/default_avatar_large.png`. Title has combining characters. |
| `track-preview.json` | `https://soundcloud.com/the-concept-band/world-on-fire-1` | `-J --flat-playlist --no-playlist` | 0 | **Go+ track without a subscription:** only `hls_mp3_0_0_preview` and `http_mp3_0_0_preview` (`preference: -10`, URLs under `/playlist/0/30/` and `/preview/0/30/`). `duration: 30.0` is the snippet length, not the track. It has `artist`/`artists` (publisher metadata) and `release_year`. It is row 1 of `set.json`. |
| `track-short-link.json` | `https://on.soundcloud.com/9TqpUbrnArHjKNAq6` | `-J --flat-playlist --no-playlist` | 0 | Short link from yt-dlp issue #12751. yt-dlp's soundcloud extractor has no `on.soundcloud.com` pattern, so the generic extractor follows the redirect (one extra request). `extractor_key: Soundcloud`, `original_url` stays the short link, `webpage_url` is clean (no `si=`/`utm_` tracking). |
| `set.json` | `https://soundcloud.com/the-concept-band/sets/the-royal-concept-ep` | `-J --flat-playlist` | 0 | `_type: playlist`, `extractor_key: SoundcloudSet`. 6 entries of `_type: url_transparent`, `ie_key: Soundcloud`, with only id + url + `album`/`album_artist`/`album_type`. Rows 1–5 have page URLs; row 6 is `https://api-v2.soundcloud.com/tracks/47127631`. `playlist_count: 6`, `duration: 1398.595` (sum, seconds), `album_type: ep`. |
| `set-capped.json` | same | `-J --flat-playlist -I 1:3` | 0 | 3 entries, yet `playlist_count: 6` and `requested_entries: [1,2,3]`: the set API returns the whole track list, so yt-dlp knows the full count even when capped. |
| `album-set.json` | `https://soundcloud.com/leviryan/sets/out-of-spite` | `-J --flat-playlist` | 0 | `album_type: album`, `release_year: 2022`. 8 entries: rows 1–5 page URLs, rows 6–8 api-v2 URLs. `playlist_count: 8`, `duration: 1531.376`. |
| `user.json` | `https://soundcloud.com/the-concept-band` | `-J --flat-playlist -I 1:12` | 0 | `extractor_key: SoundcloudUser`, title `The Royal Concept (All)`, `id` = user id. Entries `_type: url` with id, url, title. Row 3 is a set: **no `ie_key` key at all** and a `/sets/` URL. Includes reposts of other users' tracks. `playlist_count: null` (list not exhausted), `requested_entries: [1…12]`. |
| `user-tracks.json` | `https://soundcloud.com/the-concept-band/tracks` | `-J --flat-playlist -I 1:6` | 0 | Title `(Tracks)`. All rows `ie_key: Soundcloud`. `playlist_count: null`. |
| `user-likes.json` | `https://soundcloud.com/leviryan/likes` | `-J --flat-playlist -I 1:6` | 0 | Title `Levi Ryan (Likes)`; tracks by other users. `playlist_count: null`. |
| `user-sets.json` | `https://soundcloud.com/the-concept-band/sets` | `-J --flat-playlist -I 1:4` | 0 | Title `(Sets)`. Every row is a set (no `ie_key`, `/sets/` URL), with id, url and title. |
| `user-albums.json` | `https://soundcloud.com/the-concept-band/albums` | `-J --flat-playlist -I 1:5001 --socket-timeout 20` (the resolver's argv) | 0 | Recorded 2026-10-03. Title `(Albums)`. The same 4 sets as `user-sets.json` in another order, rows shaped alike (no `ie_key`, `/sets/` URL). The list ran out under the cap: `playlist_count: 4` and no `requested_entries`. |
| `user-reposts.json` | `https://soundcloud.com/the-concept-band/reposts` | `-J --flat-playlist -I 1:4` | 0 | Only 3 reposts, so the list ran out under the cap: `playlist_count: 3` and no `requested_entries`. |
| `entry.json` | `https://api-v2.soundcloud.com/tracks/47127631` | `-J --no-playlist` | 0 | The enrichment lookup on row 6 of `set.json`, URL exactly as listed. Full track: `webpage_url` is the page URL, `original_url` the API URL. Formats `hls_mp3_0_0`, `hls_aac_96k`, `hls_aac_160k`; picks `hls_aac_160k`. No `album` (the set context isn't passed on). |
| `entry-metadata-only.json` | same | `-J --no-playlist --extractor-args soundcloud:formats=none --ignore-no-formats-error` | 0 | 1 API request instead of 4. Exits 0 with stderr `WARNING: No video formats found!` and `WARNING: Requested format is not available` (`../errors/soundcloud-metadata-only.log`). `formats: []`, no `acodec`/`abr`, so a preview can't be detected. |

Not recorded: a Go+ track geo-blocked here (`https://soundcloud.com/caravan-palace-official/mad`, `https://on.soundcloud.com/zm7BCOajdkkgYf1XVZ`) → `../errors/soundcloud-geo-blocked.log`.

## Entry lookup cost (measured 2026-10-02)
`-v -J --no-playlist -- <url>`; requests counted from the `[soundcloud] …: Downloading`/`Checking` lines. Each run also makes one `Checking thumbnail extension` HEAD request to i1.sndcdn.com, which is not an API call. The client id came from yt-dlp's cache; a cold cache adds a homepage fetch plus JS assets. Wall time is about 0.5 s of process start (no network) plus the requests.

| URL | `--extractor-args` | API requests | Wall time | Formats → picked |
|---|---|---|---|---|
| api-v2 `tracks/47127631` | (default) | 4 | 1.17–1.31 s | hls_mp3, hls_aac_96k, hls_aac_160k → hls_aac_160k |
| same | `soundcloud:formats=hls_aac,http_mp3` | 3 | 0.97–0.99 s | hls_aac_96k, hls_aac_160k → hls_aac_160k |
| same | `soundcloud:formats=hls_aac,hls_mp3` | 4 | 1.20 s | same as default |
| same | `soundcloud:formats=hls_aac` | 3 | 0.95 s | hls_aac_96k, hls_aac_160k → hls_aac_160k |
| same | `soundcloud:formats=none` + `--ignore-no-formats-error` | 1 | 0.83–0.92 s | none |
| `excision/robokitty` | (default) | 5 | 1.08–1.16 s | hls_mp3, http_mp3, hls_aac_96k, hls_aac_160k → hls_aac_160k |
| same | `soundcloud:formats=hls_aac,http_mp3` | 4 | 1.02–1.05 s | http_mp3, aac 96k/160k → hls_aac_160k |
| same | `soundcloud:formats=hls_aac,hls_mp3` | 4 | 1.03 s | hls_mp3, aac 96k/160k → hls_aac_160k |
| same | `soundcloud:formats=hls_aac` | 3 | 0.91–0.96 s | aac 96k/160k → hls_aac_160k |
| `the-concept-band/world-on-fire-1` (Go+) | (default) | 3 | 1.00–1.11 s | hls_mp3_0_0_preview, http_mp3_0_0_preview → http_mp3_0_0_preview |
| same | `soundcloud:formats=hls_aac,http_mp3` | 2 | 0.88–0.90 s | http_mp3_0_0_preview |
| same | `soundcloud:formats=hls_aac,hls_mp3` | 2 | 0.94 s | hls_mp3_0_0_preview |
| same | `soundcloud:formats=hls_aac` | 1 | 0.76–0.85 s | **exit 1**, `No video formats found!` (`../errors/soundcloud-no-formats.log`) |
| `ethmusic/lostin-powers-she-so-heavy` | `soundcloud:formats=hls_aac,hls_mp3` | 3 | 0.96 s | hls_mp3, hls_aac_96k → hls_aac_96k |

The `formats` patterns match `<protocol>_<preset base>` (`hls_aac`, `http_mp3`, …), so AAC 96k and 160k can't be told apart: each costs a request. None of the five tracks sampled had an Opus transcoding, and every one had `hls_mp3`; `http_mp3` was missing on `tracks/47127631`.

## Re-recording
From `apps/server`:
```
yt-dlp --ignore-config --no-update --color never --encoding utf-8 --js-runtimes node:"$(command -v node)" \
  -J --flat-playlist -- 'https://soundcloud.com/the-concept-band/sets/the-royal-concept-ep' \
  | node test/fixtures/trim.mjs > test/fixtures/soundcloud/set.json
pnpm exec biome format --write test/fixtures
```
`trim.mjs` replaces stream URLs (signed `Policy`/`Signature`/`Key-Pair-Id` CloudFront URLs) with `https://example.invalid/<format_id>`. It exits 1 if any `client_id`, token, signature or IP survives.
