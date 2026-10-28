# Spotify embed page fixtures

Spotify's embed player pages, which `src/spotify/client.ts` reads for a Spotify track, album or playlist (ADR-026). Recorded **2026-10-21** (18:36 UTC) on macOS 26.5.1 (arm64) with `curl`, from a Serbian IP, without cookies or a login:

```
curl -sS -H 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36' \
  -H 'Accept-Language: en' 'https://open.spotify.com/embed/<type>/<id>' \
  | node test/fixtures/spotify/trim-embed.mjs > test/fixtures/spotify/<file>.html
pnpm exec biome format --write test/fixtures/spotify
```
Every page answered `200 text/html; charset=utf-8`.

| File | URL | Raw page | Notes |
|---|---|---|---|
| `track.html` | `https://open.spotify.com/embed/track/4uLU6hMCjMI75M1A2tKUQC` | 10.5 kB | "Never Gonna Give You Up" by Rick Astley, 213 573 ms, released 1987-11-12. `artists` holds one `{ name, uri }`; three cover sizes (64, 300, 640 px) on `image-cdn-fa.spotifycdn.com`. |
| `track-2.html` | `https://open.spotify.com/embed/track/6aiKIFjPwa3UvDCD5ecoJj` | 10.5 kB | "Whenever You Need Somebody" by Rick Astley, 233 666 ms: row 2 of the album. Recorded **2026-10-27** the same way, for pasted track links (`POST /api/resolve/links`) whose rows fill in one embed page each. |
| `track-3.html` | `https://open.spotify.com/embed/track/76QJgXPE3oc1cnkE4PFHEn` | 10.5 kB | "Together Forever" by Rick Astley, 205 533 ms: row 3 of the album. Recorded 2026-10-27, as `track-2.html`. |
| `album.html` | `https://open.spotify.com/embed/album/6N9PS4QXF1D0OWPk0Sxtb4` | 24.4 kB | "Whenever You Need Somebody" by Rick Astley (`subtitle`): 10 track rows (`uri`, `title`, `subtitle` = the artists as one string, `duration` in ms, `entityType: "track"`); row 1 is the track above. `releaseDate: null`, `duration: 0` at the top. No `coverArt`, only `visualIdentity.image` (`image-cdn-ak.spotifycdn.com`). |
| `playlist.html` | `https://open.spotify.com/embed/playlist/37i9dQZF1DXcBWIGoYBM5M` | 84.9 kB | "Today’s Top Hits" by Spotify: 50 rows (the whole playlist), all tracks. `coverArt.sources` (`i.scdn.co`, no size) beside `visualIdentity.image`. Rows with featured artists (`expectations (feat. Chappell Roan)`), accents (`ADÉLA`), `(with …)` and `(ft. …)`. |
| `playlist-capped.html` | `https://open.spotify.com/embed/playlist/37i9dQZF1DX4UtSsGT1Sbe` | 154.4 kB | "All Out 80s" by Spotify: the page lists **100** rows, the embed player's cap (the playlist has more; the page never says how many). Titles with Spotify's reissue suffixes (`- 2011 Remaster`, `- Remastered 1999`, `- Radio Edit`) and artists with `&`. |

## Scrubbing
The raw pages are never checked in. Each holds an anonymous access token and its expiry (`props.pageProps.state.settings.session`), a client id, a correlation id and a restriction id (`props.pageProps.config`), Sentry trace data and baggage, the player's build id, and in a playlist's `attributes` internal job and correlation ids. `trim-embed.mjs` rewrites each page to a minimal HTML document whose only script is `__NEXT_DATA__`, holding only `props.pageProps.state.data` (`entity` and its siblings `embeded_entity_uri` and `defaultAudioFileObject`), without the 30-second preview stream URLs (`audioPreview`), `videoPreview` and `attributes`. `<` and `>` in strings are escaped (`<`, `>`) as Next.js does. It exits 1 without writing anything if the output still names an access token, any `…token…` field, a client id, a correlation id, Sentry, a session or a preview URL.

Everything kept is public catalogue data: names, Spotify ids, durations, release dates, cover image URLs and colours.

## Tests
- `src/spotify/embed.test.ts` reads every page here (`RECORDED_PAGES`, a meta-test fails on a page without an entry) and checks that each one is scrubbed: one script, nothing but `props.pageProps.state.data`, none of the words above.
- `test/spotify-fixtures.test.ts` runs `trim-embed.mjs` on a synthetic page with every secret in place, and on one that still leaks inside `data`.
- `test/helpers.ts`' `startSpotifyFixtures` serves these pages on 127.0.0.1 (`SPOTIFY_PAGES`) for the integration tests and `test/e2e-server.ts`, with every cover URL rewritten to its own `/image/<hash>`, so no test fetches Spotify's CDN.
