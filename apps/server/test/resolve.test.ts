import { readdirSync, readFileSync } from 'node:fs'
import { rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  type ApiErrorBody,
  ApiErrorBodySchema,
  classifyUrl,
  type ErrorCode,
  MAX_COLLECTION_ENTRIES,
  MAX_MIX_ENTRIES,
  type ResolveMode,
  type ResolveResult,
  ResolveResultSchema,
  urlRejectionMessage,
} from '@dj-scraper/shared'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { run } from '../src/engine/run.ts'
import { JSON_BODY_LIMIT_BYTES } from '../src/http/json.ts'
import { OUT_OF_SCOPE_MESSAGE } from '../src/resolve/input.ts'
import { planResolve } from '../src/resolve/plan.ts'
import { type FakeYtdlpRule, freePort, makeTempDir, SERVER_DIR, writeFakeYtdlp } from './helpers.ts'
import {
  jsonBody,
  type ResolveApp,
  startResolveApp,
  stopResolveApps,
  waitForExit,
  waitForLog,
} from './resolve-app.ts'

// POST /api/resolve end to end: the real app, resolver, parser and error mapper, with the fake
// yt-dlp replaying the recorded fixtures (test/fixtures). Offline; nothing here runs the real yt-dlp.

const FIXTURES = path.join(import.meta.dirname, 'fixtures')
const MANIFEST: { rules: FakeYtdlpRule[] } = JSON.parse(
  readFileSync(path.join(FIXTURES, 'fake-yt-dlp.json'), 'utf8'),
)

const VIDEO = 'https://www.youtube.com/watch?v=jNQXAC9IVRw'
const PLAYLIST = 'https://www.youtube.com/playlist?list=PLt5yu3-wZAlQAaPZ5Z-rJoTdbT-45Q7c0'
const WATCH_LIST =
  'https://www.youtube.com/watch?v=gHKT4uU8Zng&list=PLt5yu3-wZAlQAaPZ5Z-rJoTdbT-45Q7c0'
const MIX = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=RDdQw4w9WgXcQ'
const NO_MIX = 'https://www.youtube.com/watch?v=jNQXAC9IVRw&list=RDjNQXAC9IVRw'
const CHANNEL_ROOT = 'https://www.youtube.com/@NoCopyrightSounds'
const SECRET = 'https://soundcloud.com/jaimemf/youtube-dl-test-video-a-y-baw/s-8Pjrp'

let root = ''
beforeAll(async () => {
  root = await makeTempDir('resolve')
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})
afterEach(stopResolveApps)

const start = (options?: Parameters<typeof startResolveApp>[1]) => startResolveApp(root, options)

/** POST /api/resolve that must succeed; the body must match the contract. */
async function resolveOk(app: ResolveApp, url: string, mode?: ResolveMode) {
  const res = await app.post('/api/resolve', mode === undefined ? { url } : { url, mode })
  const body = await jsonBody(res)
  expect(res.status, JSON.stringify(body)).toBe(200)
  return ResolveResultSchema.parse(body)
}

/** POST /api/resolve (or any body) that must fail with an ApiErrorBody and the code's status. */
async function resolveError(app: ResolveApp, body: unknown, route = '/api/resolve') {
  return errorOf(await app.post(route, body))
}

async function errorOf(res: Response): Promise<ApiErrorBody['error'] & { status: number }> {
  const { error } = ApiErrorBodySchema.parse(await jsonBody(res))
  return { status: res.status, ...error }
}

function asTrack(result: ResolveResult) {
  if (result.kind !== 'track') throw new Error(`expected a track, got ${result.kind}`)
  return result.track
}

function asCollection(result: ResolveResult) {
  if (result.kind !== 'collection') throw new Error(`expected a collection, got ${result.kind}`)
  return result.collection
}

function asAmbiguous(result: ResolveResult) {
  if (result.kind !== 'ambiguous') throw new Error(`expected ambiguous, got ${result.kind}`)
  return result
}

/** The value after `flag` in a fake call's argv. */
const optionValue = (argv: readonly string[], flag: string) => argv[argv.indexOf(flag) + 1]

/**
 * Every success fixture the server can be served, with the URL and mode that make it ask for it.
 * The checks pin values from the fixture, so a case can't pass on the wrong rule.
 */
const SUCCESS: Record<
  string,
  { url: string; mode?: ResolveMode; check: (r: ResolveResult) => void }
> = {
  'youtube/video.json': {
    url: VIDEO,
    check: (r) =>
      expect(asTrack(r)).toMatchObject({
        id: 'jNQXAC9IVRw',
        platform: 'youtube',
        url: VIDEO,
        title: 'Me at the zoo',
        uploader: 'jawed',
        durationSec: 19,
        availability: 'available',
        source: { codec: 'opus' },
      }),
  },
  'youtube/music-track.json': {
    url: 'https://music.youtube.com/watch?v=XNEnEBrHws8',
    check: (r) =>
      expect(asTrack(r)).toMatchObject({
        id: 'XNEnEBrHws8',
        url: 'https://www.youtube.com/watch?v=XNEnEBrHws8',
        title: 'The Chill Zone',
        artist: 'Royalty Free Music',
      }),
  },
  'youtube/playlist.json': {
    url: PLAYLIST,
    check: (r) => {
      const c = asCollection(r)
      expect(c).toMatchObject({
        id: 'PLt5yu3-wZAlQAaPZ5Z-rJoTdbT-45Q7c0',
        platform: 'youtube',
        kind: 'playlist',
        title: 'dlp test playlist',
        owner: 'cole-dlp-test-acc',
        trackCount: 1,
        truncated: false,
      })
      expect(c.entries).toHaveLength(1)
      expect(c.entries[0]).toMatchObject({ id: 'gHKT4uU8Zng', partial: false })
    },
  },
  'youtube/playlist-capped.json': {
    url: 'https://www.youtube.com/playlist?list=PLzH6n4zXuckpfMu_4Ff8E7Z1behQks5ba',
    // Recorded with -I 1:4: 4 rows of YouTube's 11. Fewer rows than the cap is not truncated.
    check: (r) => {
      const c = asCollection(r)
      expect(c).toMatchObject({ trackCount: 11, truncated: false })
      expect(c.entries).toHaveLength(4)
    },
  },
  'youtube/playlist-empty.json': {
    url: 'https://www.youtube.com/playlist?list=PL4lCao7KL_QFodcLWhDpGCYnngnHtQ-Xf',
    check: (r) =>
      expect(asCollection(r)).toMatchObject({ trackCount: 0, truncated: false, entries: [] }),
  },
  'youtube/playlist-unavailable-entries.json': {
    url: 'https://www.youtube.com/playlist?list=PLYwq8WOe86_xGmR7FrcJq8Sb7VW8K3Tt2',
    check: (r) => {
      const c = asCollection(r)
      expect(c).toMatchObject({ trackCount: 162, truncated: false })
      expect(c.entries).toHaveLength(23)
      const unavailable = c.entries
        .filter((entry) => entry.availability === 'unavailable')
        .map(({ title, unavailableReason, partial }) => ({ title, unavailableReason, partial }))
      expect(unavailable).toEqual([
        { title: '[Private video]', unavailableReason: 'private', partial: false },
        { title: '[Private video]', unavailableReason: 'private', partial: false },
        { title: '[Deleted video]', unavailableReason: 'unavailable', partial: false },
      ])
      const original = c.entries.find((entry) => entry.title?.startsWith('[ORIGINAL]'))
      expect(original?.availability).toBe('unknown')
    },
  },
  'youtube/album.json': {
    url: 'https://music.youtube.com/browse/MPREb_gTAcphH99wE',
    check: (r) => {
      const c = asCollection(r)
      // yt-dlp gives no uploader; the rows' one Topic channel names the album's artist.
      expect(c).toMatchObject({
        id: 'OLAK5uy_l1m0thk3g31NmIIz_vMIbWtyv7eZixlH0',
        kind: 'album',
        owner: 'Royalty Free Music Crew',
        trackCount: 50,
        truncated: false,
      })
      expect(c.entries).toHaveLength(50)
      expect(c.entries.every((entry) => !entry.partial)).toBe(true)
    },
  },
  'youtube/album-olak.json': {
    url: 'https://www.youtube.com/playlist?list=OLAK5uy_l1m0thk3g31NmIIz_vMIbWtyv7eZixlH0',
    check: (r) => {
      const c = asCollection(r)
      expect(c).toMatchObject({ kind: 'album', owner: 'Royalty Free Music Crew', trackCount: 50 })
      expect(c.entries).toHaveLength(50)
    },
  },
  'youtube/watch-list-track.json': {
    url: WATCH_LIST,
    check: (r) =>
      expect(asAmbiguous(r)).toMatchObject({
        track: { id: 'gHKT4uU8Zng', url: 'https://www.youtube.com/watch?v=gHKT4uU8Zng' },
        collectionUrl: PLAYLIST,
        collectionKind: 'playlist',
      }),
  },
  'youtube/mix.json': {
    url: MIX,
    mode: 'collection',
    check: (r) => {
      const c = asCollection(r)
      expect(c).toMatchObject({ id: 'RDdQw4w9WgXcQ', kind: 'mix', truncated: true })
      expect(c.trackCount).toBeUndefined()
      // Many artists' channels: a mix names no owner.
      expect(c.owner).toBeUndefined()
      expect(c.entries).toHaveLength(MAX_MIX_ENTRIES)
      expect(c.entries[0]?.id).toBe('dQw4w9WgXcQ')
    },
  },
  'youtube/mix-track.json': {
    url: MIX,
    // auto mode looks up only the seed video and offers the mix, v= kept in its URL.
    check: (r) =>
      expect(asAmbiguous(r)).toMatchObject({
        track: {
          id: 'dQw4w9WgXcQ',
          url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
          artist: 'Rick Astley',
        },
        collectionUrl: MIX,
        collectionKind: 'mix',
      }),
  },
  'youtube/mix-unrecognized.json': {
    url: NO_MIX,
    mode: 'collection',
    // YouTube has no mix for this video: yt-dlp warns and returns the video, so do we.
    check: (r) => expect(asTrack(r)).toMatchObject({ id: 'jNQXAC9IVRw', url: VIDEO }),
  },
  'youtube/channel-videos.json': {
    url: `${CHANNEL_ROOT}/videos`,
    check: (r) => {
      const c = asCollection(r)
      expect(c).toMatchObject({
        id: 'UC_aEa8K-EOJ3D6gOs7HcyNg',
        kind: 'channel',
        title: 'NoCopyrightSounds - Videos',
        owner: 'NoCopyrightSounds',
        truncated: false,
      })
      expect(c.trackCount).toBeUndefined()
      expect(c.entries).toHaveLength(6)
      // Flat channel rows don't name the channel; a tab lists only its own uploads.
      expect(new Set(c.entries.map((entry) => entry.uploader))).toEqual(
        new Set(['NoCopyrightSounds']),
      )
    },
  },
  'soundcloud/track.json': {
    url: 'https://soundcloud.com/ethmusic/lostin-powers-she-so-heavy',
    check: (r) =>
      expect(asTrack(r)).toMatchObject({
        id: '62986583',
        platform: 'soundcloud',
        artist: 'Lostin Powers',
        title: 'She so Heavy (SneakPreview) Adrian Ackers Blueprint 1',
        availability: 'available',
        source: { codec: 'mp4a.40.2', bitrateKbps: 96 },
      }),
  },
  'soundcloud/track-secret.json': {
    url: SECRET,
    check: (r) => expect(asTrack(r)).toMatchObject({ id: '123998367', url: SECRET }),
  },
  'soundcloud/track-preview.json': {
    url: 'https://soundcloud.com/the-concept-band/world-on-fire-1',
    // A Go+ preview is never presented as the track: no source, no 30 s duration.
    check: (r) => {
      const track = asTrack(r)
      expect(track).toMatchObject({
        id: '75206121',
        availability: 'unavailable',
        unavailableReason: 'preview_only',
      })
      expect(track.source).toBeUndefined()
      expect(track.durationSec).toBeUndefined()
    },
  },
  'soundcloud/track-short-link.json': {
    url: 'https://on.soundcloud.com/9TqpUbrnArHjKNAq6',
    check: (r) =>
      expect(asTrack(r)).toMatchObject({
        id: '189341496',
        platform: 'soundcloud',
        url: 'https://soundcloud.com/excision/robokitty',
      }),
  },
  'soundcloud/set.json': {
    url: 'https://soundcloud.com/the-concept-band/sets/the-royal-concept-ep',
    check: (r) => {
      const c = asCollection(r)
      // SoundCloud labels the set an EP (album_type "ep").
      expect(c).toMatchObject({
        id: '2284613',
        platform: 'soundcloud',
        kind: 'album',
        owner: 'The Royal Concept',
        trackCount: 6,
        durationSec: 1398.595,
        truncated: false,
      })
      expect(c.entries.map((entry) => entry.partial)).toEqual(Array(6).fill(true))
      expect(c.entries[5]?.url).toBe('https://api-v2.soundcloud.com/tracks/47127631')
    },
  },
  'soundcloud/album-set.json': {
    url: 'https://soundcloud.com/leviryan/sets/out-of-spite',
    check: (r) => {
      const c = asCollection(r)
      expect(c).toMatchObject({
        kind: 'album',
        owner: 'Levi Ryan',
        trackCount: 8,
        durationSec: 1531.376,
      })
      expect(c.entries).toHaveLength(8)
    },
  },
  'soundcloud/user.json': {
    url: 'https://soundcloud.com/the-concept-band',
    check: (r) => {
      const c = asCollection(r)
      // The page has no uploader: the owner is the username in yt-dlp's title, which stays whole.
      expect(c).toMatchObject({
        kind: 'channel',
        title: 'The Royal Concept (All)',
        owner: 'The Royal Concept',
      })
      expect(c.skippedEntries).toBe(1)
      expect(c.entries).toHaveLength(11)
      expect(c.entries.some((entry) => entry.url.includes('/sets/'))).toBe(false)
    },
  },
  'soundcloud/user-tracks.json': {
    url: 'https://soundcloud.com/the-concept-band/tracks',
    check: (r) => {
      const c = asCollection(r)
      expect(c).toMatchObject({
        kind: 'channel',
        title: 'The Royal Concept (Tracks)',
        owner: 'The Royal Concept',
      })
      expect(c.entries).toHaveLength(6)
      expect(c.skippedEntries).toBeUndefined()
    },
  },
  'soundcloud/user-likes.json': {
    url: 'https://soundcloud.com/leviryan/likes',
    check: (r) => {
      const c = asCollection(r)
      expect(c).toMatchObject({ kind: 'likes', title: 'Levi Ryan (Likes)', owner: 'Levi Ryan' })
      expect(c.entries).toHaveLength(6)
    },
  },
  'soundcloud/user-sets.json': {
    url: 'https://soundcloud.com/the-concept-band/sets',
    check: (r) =>
      expect(asCollection(r)).toMatchObject({
        kind: 'channel',
        owner: 'The Royal Concept',
        entries: [],
        skippedEntries: 4,
      }),
  },
  'soundcloud/user-reposts.json': {
    url: 'https://soundcloud.com/the-concept-band/reposts',
    check: (r) => {
      const c = asCollection(r)
      expect(c).toMatchObject({ kind: 'channel', owner: 'The Royal Concept', trackCount: 3 })
      expect(c.entries).toHaveLength(3)
    },
  },
  'soundcloud/entry.json': {
    url: 'https://api-v2.soundcloud.com/tracks/47127631',
    check: (r) =>
      expect(asTrack(r)).toMatchObject({
        id: '47127631',
        url: 'https://soundcloud.com/the-concept-band/knocked-up-mastered',
        source: { codec: 'mp4a.40.2', bitrateKbps: 160 },
      }),
  },
}

/** Success fixtures the server never asks for, and why. Each has its own test below or elsewhere. */
const NOT_SERVED: Record<string, string> = {
  'youtube/channel-root.json': 'a channel root is listed as its /videos tab instead',
  'youtube/watch-list-playlist.json': "mode collection lists the list's own playlist URL instead",
  'soundcloud/set-capped.json':
    'recorded with -I 1:3; the server always asks for one row over 5000',
  'soundcloud/entry-metadata-only.json': 'needs --extractor-args soundcloud:formats=none',
}

describe('POST /api/resolve with recorded fixtures', () => {
  it('has a case for every success fixture, or a reason the server never asks for it', () => {
    const fixtures = ['youtube', 'soundcloud'].flatMap((dir) =>
      readdirSync(path.join(FIXTURES, dir))
        .filter((name) => name.endsWith('.json'))
        .map((name) => `${dir}/${name}`),
    )
    expect([...Object.keys(SUCCESS), ...Object.keys(NOT_SERVED)].sort()).toEqual(fixtures.sort())
  })

  it.each(Object.entries(SUCCESS))('%s', async (_fixture, { url, mode, check }) => {
    const app = await start()
    check(await resolveOk(app, url, mode))
    const lookups = await app.lookups()
    expect(lookups).toHaveLength(1)
    expect(lookups[0]?.argv).toEqual(expect.arrayContaining(['--ignore-config', '-J', '--']))
  })
})

describe('POST /api/resolve: track or list', () => {
  it('looks up only the track of watch?v=…&list=… in auto mode and offers the list', async () => {
    const app = await start()
    asAmbiguous(await resolveOk(app, WATCH_LIST))
    const [lookup] = await app.lookups()
    expect(lookup?.url).toBe(WATCH_LIST)
    expect(lookup?.argv).toContain('--no-playlist')
  })

  it('resolves only the track with mode track', async () => {
    const app = await start()
    expect(asTrack(await resolveOk(app, WATCH_LIST, 'track')).id).toBe('gHKT4uU8Zng')
    expect((await app.lookups())[0]?.argv).toContain('--no-playlist')
  })

  it('lists the list at its own playlist URL with mode collection, capped at 5000 rows', async () => {
    const app = await start()
    const c = asCollection(await resolveOk(app, WATCH_LIST, 'collection'))
    expect(c).toMatchObject({ id: 'PLt5yu3-wZAlQAaPZ5Z-rJoTdbT-45Q7c0', kind: 'playlist' })
    const [lookup] = await app.lookups()
    expect(lookup?.url).toBe(PLAYLIST)
    expect(lookup?.argv).toContain('--yes-playlist')
    expect(optionValue(lookup?.argv ?? [], '-I')).toBe(`1:${MAX_COLLECTION_ENTRIES + 1}`)
  })

  it('offers a mix from its seed video, keeping v= in the mix URL', async () => {
    const app = await start()
    expect(asAmbiguous(await resolveOk(app, MIX))).toMatchObject({
      track: { id: 'dQw4w9WgXcQ' },
      collectionUrl: MIX,
      collectionKind: 'mix',
    })
    const [lookup] = await app.lookups()
    expect(lookup?.url).toBe(MIX)
    expect(lookup?.argv).toContain('--no-playlist')
  })

  it('lists a mix pasted as playlist?list=RD… from its seed video, capped at 50 rows', async () => {
    // YouTube refuses the playlist URL itself (errors/youtube-mix-playlist-url.log).
    const app = await start()
    const c = asCollection(
      await resolveOk(app, 'https://www.youtube.com/playlist?list=RDdQw4w9WgXcQ'),
    )
    expect(c).toMatchObject({ id: 'RDdQw4w9WgXcQ', kind: 'mix', truncated: true })
    expect(c.entries).toHaveLength(MAX_MIX_ENTRIES)
    const [lookup] = await app.lookups()
    expect(lookup?.url).toBe(MIX)
    expect(lookup?.argv).toContain('--yes-playlist')
    expect(optionValue(lookup?.argv ?? [], '-I')).toBe(`1:${MAX_MIX_ENTRIES + 1}`)
  })

  it('lists an embed player list (embed/videoseries) at its playlist page', async () => {
    const app = await start()
    const embed =
      'https://www.youtube-nocookie.com/embed/videoseries?list=PLt5yu3-wZAlQAaPZ5Z-rJoTdbT-45Q7c0'
    const c = asCollection(await resolveOk(app, embed))
    expect(c).toMatchObject({ id: 'PLt5yu3-wZAlQAaPZ5Z-rJoTdbT-45Q7c0', kind: 'playlist' })
    expect((await app.lookups()).map((call) => call.url)).toEqual([PLAYLIST])
  })

  it('asks for one row over the 50-row mix cap, so a longer mix shows as truncated', async () => {
    const app = await start()
    await resolveOk(app, MIX, 'collection')
    const [lookup] = await app.lookups()
    expect(lookup?.url).toBe(MIX)
    expect(optionValue(lookup?.argv ?? [], '-I')).toBe(`1:${MAX_MIX_ENTRIES + 1}`)
  })

  it.each([CHANNEL_ROOT, `${CHANNEL_ROOT}/featured`])(
    'lists the channel root %s as its /videos tab, not as nested tab playlists',
    async (url) => {
      const app = await start()
      const c = asCollection(await resolveOk(app, url))
      expect(c).toMatchObject({ url: `${CHANNEL_ROOT}/videos`, kind: 'channel' })
      expect((await app.lookups()).map((call) => call.url)).toEqual([`${CHANNEL_ROOT}/videos`])
    },
  )

  it('cuts a listing longer than 5000 rows at 5000 and marks it truncated', {
    timeout: 30_000,
  }, async () => {
    const url = 'https://www.youtube.com/playlist?list=PLdjScraperLongPlaylist'
    const rows = Array.from({ length: MAX_COLLECTION_ENTRIES + 1000 }, (_, i) => {
      const id = `v${String(i + 1).padStart(10, '0')}`
      return {
        _type: 'url',
        ie_key: 'Youtube',
        id,
        url: `https://www.youtube.com/watch?v=${id}`,
        title: `Artist ${i + 1} - Track ${i + 1}`,
        duration: 200,
      }
    })
    const listing = path.join(root, 'long-playlist.json')
    await writeFile(
      listing,
      JSON.stringify({
        _type: 'playlist',
        id: 'PLdjScraperLongPlaylist',
        title: 'Long playlist',
        extractor_key: 'YoutubeTab',
        webpage_url: url,
        original_url: url,
        playlist_count: rows.length,
        entries: rows,
      }),
    )
    // Served only for the exact cap the server must ask for; the fake applies -I like yt-dlp.
    const app = await start({
      manifestRules: [{ url, args: [['-I', `1:${MAX_COLLECTION_ENTRIES + 1}`]], stdout: listing }],
    })
    const c = asCollection(await resolveOk(app, url))
    expect(c).toMatchObject({ truncated: true, trackCount: rows.length })
    expect(c.entries).toHaveLength(MAX_COLLECTION_ENTRIES)
    expect(c.entries.at(-1)).toMatchObject({
      id: 'v0000005000',
      artist: 'Artist 5000',
      title: 'Track 5000',
    })
  })

  it('passes yt-dlp the normalized URL, not the pasted text', async () => {
    // The rule matches only the exact normalized URL, as the server must pass it after --.
    const app = await start({
      manifestRules: [
        { url: 'https://youtu.be/jNQXAC9IVRw', playlist: 'no', stdout: 'youtube/video.json' },
      ],
    })
    expect(asTrack(await resolveOk(app, '  youtu.be/jNQXAC9IVRw\n')).id).toBe('jNQXAC9IVRw')
    expect((await app.lookups()).map((call) => call.url)).toEqual(['https://youtu.be/jNQXAC9IVRw'])
  })

  it('never logs the URL of a secret link, only its kind and outcome', async () => {
    const app = await start()
    await resolveOk(app, SECRET)
    await resolveError(app, { url: `${SECRET}x` })
    expect(app.logs).toHaveLength(2)
    for (const line of app.logs) {
      expect(line).toMatch(/^\[resolve\] soundcloud_track → /)
      expect(line).not.toMatch(/soundcloud\.com|s-8Pjrp/)
    }
  })
})

/**
 * Every errors/*.log with the code it maps to and the HTTP status docs/architecture.md promises for
 * it (spelled out, not read from ERROR_STATUS). Exit-0 warning logs aren't failures.
 */
const ERRORS: Record<string, [ErrorCode, number]> = {
  'bad-option.log': ['unknown', 500],
  'connection-refused.log': ['network', 502],
  'dns.log': ['network', 502],
  'drm.log': ['unsupported_url', 422],
  'ffmpeg-missing.log': ['engine_missing', 503],
  'interrupted.log': ['canceled', 409],
  'invalid-url.log': ['invalid_url', 400],
  'network-timeout.log': ['network', 502],
  'postprocess-conversion.log': ['postprocess_failed', 500],
  'postprocess-no-codec.log': ['postprocess_failed', 500],
  'preview-format-unavailable.log': ['unknown', 500],
  'soundcloud-401.log': ['login_required', 422],
  'soundcloud-404.log': ['unavailable', 422],
  'soundcloud-429-info.log': ['rate_limited', 429],
  'soundcloud-429.log': ['rate_limited', 429],
  'soundcloud-geo-blocked.log': ['geo_blocked', 422],
  'soundcloud-no-formats.log': ['unknown', 500],
  'soundcloud-user-missing.log': ['unavailable', 422],
  'unknown.log': ['unknown', 500],
  'unsupported.log': ['unsupported_url', 422],
  'youtube-age-restricted.log': ['age_restricted', 422],
  'youtube-bot-check.log': ['bot_check', 422],
  'youtube-content-unavailable.log': ['bot_check', 422],
  'youtube-copyright-geo.log': ['geo_blocked', 422],
  'youtube-geo-blocked.log': ['geo_blocked', 422],
  'youtube-members-only-level.log': ['login_required', 422],
  'youtube-members-only.log': ['login_required', 422],
  'youtube-mix-playlist-url.log': ['unsupported_url', 422],
  'youtube-playlist-missing.log': ['unavailable', 422],
  'youtube-private.log': ['private', 422],
  'youtube-rate-limited.log': ['rate_limited', 429],
  'youtube-removed.log': ['unavailable', 422],
  'youtube-unavailable.log': ['unavailable', 422],
}
const NOT_ERRORS = [
  'preview-filter.log',
  'soundcloud-metadata-only.log',
  'youtube-mix-unrecognized.log',
]

/**
 * The URL to resolve for a log: its manifest URL when the server can reach that rule (no argv
 * conditions, a URL classifyUrl lets through and the server passes on as it is); otherwise a
 * made-up URL with a rule of its own.
 */
function errorCase(log: string): { url: string; rules: FakeYtdlpRule[] } {
  const recorded = MANIFEST.rules.find((rule) => {
    if (rule.stderr !== `errors/${log}` || rule.args !== undefined || !rule.exit) return false
    const classified = classifyUrl(rule.url)
    if (!classified.ok || classified.kind === 'out_of_scope') return false
    return planResolve(classified, 'auto').url === rule.url
  })
  if (recorded !== undefined) return { url: recorded.url, rules: [] }
  const url = `https://example.com/fixture/${log}`
  const exit = log === 'bad-option.log' ? 2 : 1
  return { url, rules: [{ url, stderr: `errors/${log}`, exit }] }
}

describe('POST /api/resolve: yt-dlp errors', () => {
  it('has an expected code for every failure log in test/fixtures/errors', () => {
    const logs = readdirSync(path.join(FIXTURES, 'errors')).filter((name) => name.endsWith('.log'))
    expect([...Object.keys(ERRORS), ...NOT_ERRORS].sort()).toEqual(logs.sort())
  })

  it.each(Object.entries(ERRORS))('%s → %j', async (log, [code, status]) => {
    const { url, rules } = errorCase(log)
    const app = await start({ manifestRules: rules })
    const error = await resolveError(app, { url })
    expect(error).toMatchObject({ status, code })
    expect(error.message).not.toContain(url)
    expect((await app.lookups()).map((call) => call.url)).toEqual([url])
  })
})

describe('POST /api/resolve: refused before yt-dlp starts', () => {
  it.each([
    ['empty', '', 'empty'],
    ['blank', '   ', 'empty'],
    ['not a URL', 'notaurl', 'not_a_url'],
    ['javascript:', 'javascript:alert(1)', 'not_http'],
    ['ftp:', 'ftp://example.com/track.mp3', 'not_http'],
    ['credentials', 'https://dj:secret@www.youtube.com/watch?v=jNQXAC9IVRw', 'credentials'],
    ['too long', `${VIDEO}&t=${'1'.repeat(2048)}`, 'too_long'],
  ] as const)('answers 400 invalid_url for %s input', async (_label, url, reason) => {
    const app = await start()
    expect(await resolveError(app, { url })).toEqual({
      status: 400,
      code: 'invalid_url',
      message: urlRejectionMessage(reason),
    })
    expect(await app.lookups()).toEqual([])
  })

  it.each([
    'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC',
    'https://music.apple.com/us/album/x/123',
    'https://tidal.com/browse/track/1',
    'https://www.deezer.com/track/1',
    'https://www.beatport.com/track/x/1',
    'https://music.amazon.co.uk/albums/B0000000000',
    'https://open.spotify.com./track/4uLU6hMCjMI75M1A2tKUQC',
  ])('answers 422 unsupported_url for the DRM service %s', async (url) => {
    const app = await start()
    expect(await resolveError(app, { url })).toEqual({
      status: 422,
      code: 'unsupported_url',
      message: OUT_OF_SCOPE_MESSAGE,
    })
    expect(await app.lookups()).toEqual([])
  })

  it('answers 503 engine_missing when YTDLP_PATH points at nothing', async () => {
    const app = await start({ engine: { YTDLP_PATH: path.join(root, 'no-such-dir', 'yt-dlp') } })
    expect(await resolveError(app, { url: VIDEO })).toMatchObject({
      status: 503,
      code: 'engine_missing',
    })
  })
})

describe('POST /api/resolve: request checks', () => {
  it.each([
    ['malformed JSON', '{"url": ', 'The request body must be JSON'],
    ['an empty body', '', 'The request body must be JSON'],
    ['a JSON array', '["https://youtu.be/jNQXAC9IVRw"]', 'The request body must be a JSON object'],
    ['no url', '{}', /^url: /],
    ['a url that is not a string', '{"url": 42}', /^url: /],
    ['an unknown mode', `{"url": "${VIDEO}", "mode": "both"}`, /^mode: /],
  ])('answers 400 invalid_request for %s', async (_label, body, message) => {
    const app = await start()
    const error = await errorOf(
      await app.send('/api/resolve', { headers: { 'content-type': 'application/json' }, body }),
    )
    expect(error).toMatchObject({ status: 400, code: 'invalid_request' })
    expect(error.message).toMatch(message)
    expect(await app.lookups()).toEqual([])
  })

  it('answers 415 for a body that is not declared as JSON', async () => {
    const app = await start()
    const res = await app.send('/api/resolve', {
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ url: VIDEO }),
    })
    expect(await errorOf(res)).toMatchObject({ status: 415, code: 'invalid_request' })
    expect(await app.lookups()).toEqual([])
  })

  it('answers 413 for a body over 64 KiB', async () => {
    const app = await start()
    const url = `${VIDEO}&pad=${'x'.repeat(JSON_BODY_LIMIT_BYTES)}`
    expect(await resolveError(app, { url })).toMatchObject({
      status: 413,
      code: 'invalid_request',
    })
    expect(await app.lookups()).toEqual([])
  })
})

describe('POST /api/resolve: a client that goes away', () => {
  it('stops the yt-dlp resolving its URL', async () => {
    const app = await start({ env: { FAKE_YTDLP_HANG: '1' } })
    const controller = new AbortController()
    const request = app.post('/api/resolve', { url: VIDEO }, { signal: controller.signal })
    const [call] = await app.fake.waitForCalls(1)
    controller.abort()
    await expect(request).rejects.toThrow()
    await waitForExit(call?.pid ?? 0)
    expect(await waitForLog(app.logs, /^\[resolve\] youtube_video → canceled/)).toBeDefined()
  })
})

describe('the real entry point', () => {
  it('wires resolve and enrichment to YTDLP_PATH', { timeout: 30_000 }, async () => {
    const dir = path.join(root, 'entry')
    const fake = await writeFakeYtdlp(dir)
    // The fake's #! line finds node on PATH; nothing else is there, so no real engine is found.
    await symlink(process.execPath, path.join(dir, 'node'))
    const port = await freePort()
    const controller = new AbortController()
    let listening: () => void = () => {}
    const ready = new Promise<void>((resolve) => {
      listening = resolve
    })
    const done = run(process.execPath, ['src/index.ts'], {
      cwd: SERVER_DIR,
      env: { PATH: dir, PORT: String(port), ...fake.env },
      signal: controller.signal,
      onStdoutLine: (line) => {
        if (line.includes('DJ Scraper on')) listening()
      },
    })
    try {
      await Promise.race([
        ready,
        done.then((result) => {
          throw new Error(`server exited early:\n${result.stdout}${result.stderr}`)
        }),
      ])
      const post = (route: string, body: unknown) =>
        fetch(`http://127.0.0.1:${port}${route}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })

      const resolved = await post('/api/resolve', { url: VIDEO })
      expect(resolved.status).toBe(200)
      expect(asTrack(ResolveResultSchema.parse(await resolved.json())).id).toBe('jNQXAC9IVRw')

      const entry = { platform: 'youtube', id: 'jNQXAC9IVRw', url: VIDEO }
      const enriched = await post('/api/resolve/entries', { entries: [entry] })
      expect(enriched.status).toBe(200)
      expect(await enriched.json()).toMatchObject({
        results: [{ status: 'ok', id: 'jNQXAC9IVRw' }],
      })
      expect((await fake.calls()).filter((call) => call.url === VIDEO)).toHaveLength(2)
    } finally {
      controller.abort()
      await done
    }
  })
})
