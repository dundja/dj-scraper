# YouTube resolve fixtures

Recorded 2026-10-02 on macOS 26.5.1 (arm64) with Homebrew yt-dlp **2026.08.19** (deno 2.9.7, plus Node 24.12.0 through `--js-runtimes`), from a Serbian IP. Each file is the stdout of one resolve call, passed through `../trim.mjs` and then `biome format`.

Base argv for every file:
```
yt-dlp --ignore-config --no-update --color never --encoding utf-8 --js-runtimes node:"$(command -v node)" <options> -- <url>
```

| File | URL | Options | Exit | Notes |
|---|---|---|---|---|
| `video.json` | `https://www.youtube.com/watch?v=jNQXAC9IVRw` | `-J --flat-playlist --no-playlist` | 0 | `_type: video` with formats (12 audio-only + 2 video kept). `availability: public`, `live_status: not_live`, `media_type: video`. |
| `music-track.json` | `https://music.youtube.com/watch?v=XNEnEBrHws8` | `-J --flat-playlist --no-playlist` | 0 | Track 1 of the album below. Has `track`, `artist`, `artists`, `album`, `creators`, `release_year` (2015), `release_date`. `webpage_url` is www.youtube.com; `original_url` keeps music.youtube.com. |
| `playlist.json` | `https://www.youtube.com/playlist?list=PLt5yu3-wZAlQAaPZ5Z-rJoTdbT-45Q7c0` | `-J --flat-playlist` | 0 | 1 entry, `playlist_count: 1`, no `requested_entries`. |
| `playlist-capped.json` | `https://www.youtube.com/playlist?list=PLzH6n4zXuckpfMu_4Ff8E7Z1behQks5ba` | `-J --flat-playlist -I 1:4` | 0 | 4 of 11 entries. `playlist_count: 11` is YouTube's own total; `requested_entries: [1,2,3,4]`; no `n_entries`. |
| `playlist-empty.json` | `https://www.youtube.com/playlist?list=PL4lCao7KL_QFodcLWhDpGCYnngnHtQ-Xf` | `-J --flat-playlist` | 0 | Not an error: `entries: []`, `playlist_count: 0`, `availability: unlisted`. |
| `playlist-unavailable-entries.json` | `https://www.youtube.com/playlist?list=PLYwq8WOe86_xGmR7FrcJq8Sb7VW8K3Tt2` | `-J --flat-playlist -I 49:71` | 0 | A **window** (rows 49–71) of a 162-row playlist from yt-dlp's tests. Rows 50 and 61 are `[Private video]`, row 70 `[Deleted video]`, row 55 a real title starting with `[ORIGINAL]`. `playlist_count: 162`, `requested_entries: [49…71]`. It's not a cap, so don't use it to test `truncated`. |
| `album.json` | `https://music.youtube.com/browse/MPREb_gTAcphH99wE` | `-J --flat-playlist` | 0 | stderr: `WARNING: [youtube:tab] YouTube Music is not directly supported. Redirecting to https://www.youtube.com/playlist?list=OLAK5uy_l1m0thk3g31NmIIz_vMIbWtyv7eZixlH0`. 50 entries whose `url` is music.youtube.com. Title prefixed `Album - `; `uploader`/`channel` are null at the top level, and entries have `channel: "Royalty Free Music Crew - Topic"`. |
| `album-olak.json` | `https://www.youtube.com/playlist?list=OLAK5uy_l1m0thk3g31NmIIz_vMIbWtyv7eZixlH0` | `-J --flat-playlist` | 0 | The same album. Differs only in `original_url` and the entries' `url` host (www.youtube.com). |
| `watch-list-track.json` | `https://www.youtube.com/watch?v=gHKT4uU8Zng&list=PLt5yu3-wZAlQAaPZ5Z-rJoTdbT-45Q7c0` | `-J --flat-playlist --no-playlist` | 0 | `_type: video`. `playlist`/`playlist_index` are null; `original_url` keeps `&list=`. The title differs from the playlist row (the test video has localized titles). |
| `watch-list-playlist.json` | same | `-J --flat-playlist --yes-playlist` | 0 | Identical to `playlist.json` except `original_url` (the watch URL). |
| `mix.json` | `https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=RDdQw4w9WgXcQ` | `-J --flat-playlist --yes-playlist -I 1:51` | 0 | 51 distinct entries; the first is the seed video. `playlist_count: null`, `requested_entries: [1…51]`. No `uploader`/`channel`/`thumbnails`/`availability` at the top level. Title `Mix - …`; `webpage_url` is the watch URL. The contents change on every request. |
| `mix-track.json` | `https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=RDdQw4w9WgXcQ` | `-J --flat-playlist --no-playlist` | 0 | The seed video of `mix.json` alone, as auto mode looks it up before offering the mix (`ambiguous`). `_type: video`; `playlist`/`playlist_index` are null and `original_url` keeps `&list=RD…`. Formats 233/234 are HLS audio with no `acodec`. Recorded 2026-10-02 (later the same day as the files above, same setup). |
| `mix-unrecognized.json` | `https://www.youtube.com/watch?v=jNQXAC9IVRw&list=RDjNQXAC9IVRw` | `-J --flat-playlist --yes-playlist -I 1:51` | 0 | YouTube has no mix for this video. yt-dlp warns `Unable to recognize playlist. Downloading just video jNQXAC9IVRw` (`../errors/youtube-mix-unrecognized.log`) and returns `_type: video`. |
| `channel-videos.json` | `https://www.youtube.com/@NoCopyrightSounds/videos` | `-J --flat-playlist -I 1:6` | 0 | `id` is the channel id (`UC…`), title `NoCopyrightSounds - Videos`, `playlist_count: null` (no count for channel tabs). The entries have **no** `channel`/`uploader`; only the top level names the channel. |
| `channel-root.json` | `https://www.youtube.com/@NoCopyrightSounds` | `-J --flat-playlist -I 1:3` | 0 | `_type: playlist` (id `@NoCopyrightSounds`, `playlist_count: 2`) whose entries are two `_type: playlist` tabs (`- Videos`, `- Shorts`), each cut to 3 rows: `-I` applies at every level. Shorts rows have only id, url (`/shorts/…`), title and view_count: no duration. |

**Not recorded:**
- `shorts.json`: `https://www.youtube.com/shorts/BGQWPY4IigY` has the same shape as `video.json`. Only `media_type: "short"` and `original_url` (`/shorts/…`) differ; `webpage_url` is the watch URL.
- Large listings, measured only: `-I 1:5001` on `playlist?list=UU8l9frL61Yl5KFOl87nIm2w` (`playlist_count: 20000`) took 38.5 s and printed 6.7 MB of JSON; `@NASA/videos` took 56 s and printed 3.7 MB (`playlist_count: null`).

## Re-recording
From `apps/server`:
```
yt-dlp --ignore-config --no-update --color never --encoding utf-8 --js-runtimes node:"$(command -v node)" \
  -J --flat-playlist --no-playlist -- 'https://www.youtube.com/watch?v=jNQXAC9IVRw' \
  | node test/fixtures/trim.mjs > test/fixtures/youtube/video.json
pnpm exec biome format --write test/fixtures
```
`trim.mjs` drops captions, heatmaps, fragments, request headers and similar bulk. It keeps every audio-only format plus 2 others, at most 5 thumbnails per object, and descriptions up to 200 characters. Stream URLs become `https://example.invalid/<format_id>`, because googlevideo URLs embed the recorder's IP. It exits 1 without writing anything if an IP, a signature or a token survives.
