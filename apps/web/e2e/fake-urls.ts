// The URLs the e2e server's fake engine answers (apps/server/test/e2e-server.ts): recorded yt-dlp
// output from apps/server/test/fixtures (fake-yt-dlp.json maps each URL to its fixture), plus the
// e2e server's own download rules for the playlist rows. Nothing reaches the network. Any other URL
// fails to resolve with 422 unsupported_url ("This link isn't supported. …").
//
// What specs should know:
// - One server serves the whole run, both browsers: downloads, settings and files persist from
//   test to test. A track downloaded again into the same folder ends `skipped` ("Already in the
//   folder"), so a test that expects `done` downloads into a folder of its own: make one beside
//   GET /api/settings' `folder` (the server's temp home, ~/Music/DJ Scraper there) and
//   PUT /api/settings { folder } (the `downloadFolder` fixture does both). The folder must exist
//   first: PUT refuses a new folder it can't use with 422 folder_unavailable.
// - Pacing is real. YouTube starts 10 downloads at once, then one every 12 s, counted over the
//   whole run (GET /api/downloads' queue.platforms says when the next one starts). Row lookups
//   (POST /api/resolve/entries) start one a second on SoundCloud.
// - The single tracks' recorded downloads finish in about 0.3 s, too fast to see progress. The
//   playlist rows (and the watch+list and mix tracks) take about 1.6 s each, 3 at a time: 250 ms
//   between lines, so each one shows starting, downloading and processing.
// - POST /api/downloads/:id/reveal runs `open -R` on the machine: intercept it with page.route.
// - Remix suggestions (ADR-027): every single track a spec shows gets a remix section. The mix's
//   seed track and SPOTIFY_TRACK have recorded searches (20 remixes of "Never Gonna Give You Up";
//   only the Kryptonik remix's SoundCloud upload downloads). YOUTUBE_TRACK, YOUTUBE_WATCH_LIST's
//   track and YOUTUBE_HANGING_TRACK find none ("No remixes found on YouTube or SoundCloud.").
//   SOUNDCLOUD_TRACK finds none on YouTube, and its SoundCloud search fails: the per-platform
//   error state. The server caches a search that went fine for 30 minutes, over the whole run.
// - The error URLs below answer 4xx/5xx, and both browsers log that as a console error ("Failed to
//   load resource: … 422"), which the console guard (fixtures.ts) fails on: expect it explicitly.

/**
 * "Me at the zoo" by jawed (0:19), source Opus 106 kbps (M4A copies AAC 128 kbps). Downloads in
 * every format: "jawed - Me at the zoo.mp3".
 */
export const YOUTUBE_TRACK = 'https://www.youtube.com/watch?v=jNQXAC9IVRw'

/**
 * A secret link: "Dl Test Video '' Ä↭" by Youtube (0:10), MP3 128 kbps, kept as is. Downloads. Its
 * remix search finds nothing on YouTube and fails on SoundCloud ("SoundCloud search failed: …").
 */
export const SOUNDCLOUD_TRACK =
  'https://soundcloud.com/jaimemf/youtube-dl-test-video-a-y-baw/s-8Pjrp'

/**
 * "The Memes Of 2010s....." by I'm Not JiNxEd: 23 rows, a window of its 162 (trackCount 162). Rows
 * 2 and 13 are "[Private video]" and row 22 "[Deleted video]" (unavailable); the other 20 download,
 * each with its own title and uploader (row 1: "Oh God Why! (#NGT2 Asaba Theatre Auditions) |
 * Nigeria's Got Talent", 4:45). The subfolder is "The Memes Of 2010s" (trailing dots dropped).
 */
export const YOUTUBE_PLAYLIST =
  'https://www.youtube.com/playlist?list=PLYwq8WOe86_xGmR7FrcJq8Sb7VW8K3Tt2'

/**
 * Ambiguous, a track in a playlist. "This track" is "dlp test video title primary (en-GB)" by
 * cole-dlp-test-acc (0:05) and downloads. "Whole playlist" is "dlp test playlist" with one row, the
 * same video under its other title, "dlp test video title translated (en)", which downloads too.
 */
export const YOUTUBE_WATCH_LIST =
  'https://www.youtube.com/watch?v=gHKT4uU8Zng&list=PLt5yu3-wZAlQAaPZ5Z-rJoTdbT-45Q7c0'

/**
 * Ambiguous, a mix. "This track" is "Never Gonna Give You Up (Official Video) (4K Remaster)" by
 * Rick Astley (3:33) and downloads. The mix loads 50 rows (truncated); only that first row
 * downloads, the others fail with unsupported_url. "This track" has 20 remixes from the recorded
 * searches, most played first: "Rick Astley - Never Gonna Give You Up (Krysiek Remix)" (579K views,
 * 3 YouTube uploads), then the Timmo Hendriks remix (SoundCloud, 556K plays); 7 genres, Nu Disco
 * twice. Of their uploads only the Kryptonik remix (SoundCloud, Electro House) downloads (1.6 s,
 * SoundCloud's pacing); the others fail with unsupported_url.
 */
export const YOUTUBE_MIX = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=RDdQw4w9WgXcQ'

/**
 * Made up (e2e-server.ts): the private video bM7SZ5SBzyY inside the "dlp test playlist". In auto
 * mode its track lookup fails with 422 private ("Private video."); with `mode: 'collection'` (the
 * UI's "Open the playlist") the list loads: "dlp test playlist", one row, "dlp test video title
 * translated (en)".
 */
export const YOUTUBE_PRIVATE_IN_PLAYLIST =
  'https://www.youtube.com/watch?v=bM7SZ5SBzyY&list=PLt5yu3-wZAlQAaPZ5Z-rJoTdbT-45Q7c0'

/**
 * Made up (e2e-server.ts): a playlist that loads only after 20 s (then "Data Analysis with Dr
 * Mike Pound", 4 rows), for the big-list loading state, its elapsed seconds and Cancel. Canceling
 * closes the request, and the server stops yt-dlp.
 */
export const YOUTUBE_SLOW_PLAYLIST = 'https://www.youtube.com/playlist?list=PLdjScraperE2eSlowList'

/**
 * Made up (e2e-server.ts): "Endless Download (e2e)" by DJ Scraper e2e (4:05). Its download starts,
 * reports 12 % and then hangs until it is canceled, every attempt, in every format. Each attempt
 * counts against YouTube's pacing.
 */
export const YOUTUBE_HANGING_TRACK = 'https://www.youtube.com/watch?v=e2eHangs001'

/**
 * Out of scope (DRM): classifyUrl refuses it, so the badge says "DRM service: not supported"
 * before anything resolves, and the server answers 422 unsupported_url without running yt-dlp.
 */
export const APPLE_MUSIC_TRACK = 'https://music.apple.com/us/album/x/1440857781?i=1440857786'

/** An empty playlist, "youtube-dl empty playlist": resolves with no rows. */
export const YOUTUBE_EMPTY_PLAYLIST =
  'https://www.youtube.com/playlist?list=PL4lCao7KL_QFodcLWhDpGCYnngnHtQ-Xf'

/**
 * "The Royal Concept EP" by The Royal Concept, kind album: 6 partial rows (id and url only), whose
 * lookups (POST /api/resolve/entries, one a second, about 5 s for all 6) give:
 * - row 1: "World On Fire (Re-Mastered)", unavailable (preview_only: a Go+ preview);
 * - rows 2–5: an unsupported_url error each (there is no recording of their lookups);
 * - row 6: "Knocked Up" (3:42, AAC 160 kbps), which downloads by its page URL and by the API URL
 *   the set lists it with (https://api-v2.soundcloud.com/tracks/47127631).
 */
export const SOUNDCLOUD_SET = 'https://soundcloud.com/the-concept-band/sets/the-royal-concept-ep'

/**
 * A user page, "The Royal Concept (All)": 11 partial track rows with titles (their lookups and
 * downloads fail with unsupported_url) and 1 list, "Goldrushed [2013 Album]", which doesn't resolve.
 */
export const SOUNDCLOUD_USER = 'https://soundcloud.com/the-concept-band'

/**
 * The user's Sets tab, "The Royal Concept (Sets)": no tracks, 4 lists. Only "The Royal Concept EP"
 * (SOUNDCLOUD_SET) resolves.
 */
export const SOUNDCLOUD_USER_SETS = 'https://soundcloud.com/the-concept-band/sets'

/** The user's Albums tab: the same 4 lists as the Sets tab, in another order. */
export const SOUNDCLOUD_USER_ALBUMS = 'https://soundcloud.com/the-concept-band/albums'

/** 422 private: "Private video." */
export const YOUTUBE_PRIVATE = 'https://www.youtube.com/watch?v=bM7SZ5SBzyY'

/** 422 unavailable: "Unavailable: removed or never existed." */
export const YOUTUBE_UNAVAILABLE = 'https://www.youtube.com/watch?v=aaaaaaaaaa0'

/** 422 age_restricted: "Age-restricted: needs browser cookies." */
export const YOUTUBE_AGE_RESTRICTED = 'https://www.youtube.com/watch?v=Tq92D6wQ1mg'

/** 422 bot_check: "YouTube wants to check that you're not a bot. Try again later." */
export const YOUTUBE_BOT_CHECK = 'https://www.youtube.com/watch?v=BOTCHECK001'

/** 429 rate_limited: "YouTube is limiting requests for up to an hour. Try again later." */
export const YOUTUBE_RATE_LIMITED = 'https://www.youtube.com/watch?v=RATELIMITED'

/** 422 geo_blocked: "Not available in your country." */
export const SOUNDCLOUD_GEO_BLOCKED = 'https://soundcloud.com/caravan-palace-official/mad'

/** 422 unsupported_url from yt-dlp: "This link isn't supported. Paste a YouTube or SoundCloud link." */
export const UNSUPPORTED = 'https://example.com/'

// Spotify (ADR-026): the e2e server reads Spotify from a local fixture server (DJS_SPOTIFY_ORIGIN,
// test/fixtures/spotify), so the names below come from pages recorded 2026-10-21. Covers point at
// that server (http://127.0.0.1:<port>/image/…); in the browser they load as the network guard's
// 1×1 PNG. A Spotify track downloads its YouTube match, paced as YouTube (12 s per download after
// the burst of 10, shared with every other YouTube download of the run).

/**
 * "Never Gonna Give You Up" by Rick Astley (3:34, 213.573 s), a track (the server answers `kind: track`,
 * platform spotify, no source). Its download matches dQw4w9WgXcQ, "Rick Astley - Never Gonna Give
 * You Up (Official Video) (4K Remaster)" (3:34, channel Rick Astley), and downloads that with 250 ms
 * between lines: "Rick Astley - Never Gonna Give You Up.mp3", tagged with Spotify's names and 1987.
 * It is no longer refused as DRM: a spec about DRM refusals needs another service's link. Its
 * remixes are the mix track's: the same search.
 */
export const SPOTIFY_TRACK = 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC'

/**
 * "Whenever You Need Somebody" by Rick Astley, kind album: 10 complete rows (no lookups), each with
 * the album's cover, not truncated. Every row downloads (1.6 s each): row 1 as SPOTIFY_TRACK, rows
 * 2–10 from made-up matches ("Rick Astley - <title> (Official Audio)", e2e-server.ts), into
 * "Rick Astley - <title>.mp3". Ten YouTube downloads: the whole burst.
 */
export const SPOTIFY_ALBUM = 'https://open.spotify.com/album/6N9PS4QXF1D0OWPk0Sxtb4'

/**
 * "Today’s Top Hits" by Spotify, kind playlist: 50 complete rows without covers (row 1
 * "expectations (feat. Chappell Roan)" by "Olivia Rodrigo, Chappell Roan", 3:43), not truncated.
 * Its rows don't download: the fixture server has no track page for them, so each fails with
 * unavailable ("Spotify doesn't show this link: …").
 */
export const SPOTIFY_PLAYLIST = 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M'

/** "All Out 80s" by Spotify: the 100 rows the embed page lists, so `truncated: true`. Rows don't download. */
export const SPOTIFY_PLAYLIST_TRUNCATED = 'https://open.spotify.com/playlist/37i9dQZF1DX4UtSsGT1Sbe'

/**
 * A Spotify artist page: classifyUrl marks it `spotify_other`, so the badge says "Spotify: not a
 * track or list" as it is typed, and the server answers 422 unsupported_url ("Only Spotify track,
 * album and playlist links work here …") without asking Spotify.
 */
export const SPOTIFY_ARTIST = 'https://open.spotify.com/artist/0gxyHStUsqpMadRV0Di1Qt'

/** A Spotify track the fixture server doesn't know: 422 unavailable ("Spotify doesn't show this link: …"). */
export const SPOTIFY_MISSING_TRACK = 'https://open.spotify.com/track/0000000000000000000404'
