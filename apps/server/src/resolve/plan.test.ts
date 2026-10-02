import {
  classifyUrl,
  MAX_COLLECTION_ENTRIES,
  MAX_MIX_ENTRIES,
  type ResolveMode,
  type UrlKind,
  type ValidUrl,
} from '@dj-scraper/shared'
import { describe, expect, it } from 'vitest'
import { COLLECTION_TIMEOUT_MS, planResolve, type ResolvePlan, TRACK_TIMEOUT_MS } from './plan.ts'

const MODES: readonly ResolveMode[] = ['auto', 'track', 'collection']

/** One representative classified URL per kind, as classifyUrl would return it. */
const INPUTS = {
  youtube_video: {
    ok: true,
    url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
    platform: 'youtube',
    kind: 'youtube_video',
    guess: 'track',
    videoId: 'jNQXAC9IVRw',
  },
  youtube_watch_list: {
    ok: true,
    url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw&list=PLt5yu3-wZAlQAaPZ5Z-rJoTdbT-45Q7c0&index=2',
    platform: 'youtube',
    kind: 'youtube_watch_list',
    guess: 'ambiguous',
    collectionKind: 'playlist',
    videoId: 'jNQXAC9IVRw',
    listId: 'PLt5yu3-wZAlQAaPZ5Z-rJoTdbT-45Q7c0',
  },
  youtube_playlist: {
    ok: true,
    url: 'https://www.youtube.com/playlist?list=PLt5yu3-wZAlQAaPZ5Z-rJoTdbT-45Q7c0',
    platform: 'youtube',
    kind: 'youtube_playlist',
    guess: 'collection',
    collectionKind: 'playlist',
    listId: 'PLt5yu3-wZAlQAaPZ5Z-rJoTdbT-45Q7c0',
  },
  youtube_album: {
    ok: true,
    url: 'https://music.youtube.com/browse/MPREb_gTAcphH99wE',
    platform: 'youtube',
    kind: 'youtube_album',
    guess: 'collection',
    collectionKind: 'album',
    listId: 'MPREb_gTAcphH99wE',
  },
  youtube_channel: {
    ok: true,
    url: 'https://www.youtube.com/@nasa/videos',
    platform: 'youtube',
    kind: 'youtube_channel',
    guess: 'collection',
    collectionKind: 'channel',
  },
  soundcloud_track: {
    ok: true,
    url: 'https://soundcloud.com/ethmusic/lostin-powers-she-so-heavy',
    platform: 'soundcloud',
    kind: 'soundcloud_track',
    guess: 'track',
  },
  soundcloud_set: {
    ok: true,
    url: 'https://soundcloud.com/the-concept-band/sets/the-royal-concept-ep',
    platform: 'soundcloud',
    kind: 'soundcloud_set',
    guess: 'collection',
    collectionKind: 'set',
  },
  soundcloud_user: {
    ok: true,
    url: 'https://soundcloud.com/ethmusic',
    platform: 'soundcloud',
    kind: 'soundcloud_user',
    guess: 'collection',
    collectionKind: 'channel',
  },
  soundcloud_likes: {
    ok: true,
    url: 'https://soundcloud.com/ethmusic/likes',
    platform: 'soundcloud',
    kind: 'soundcloud_likes',
    guess: 'collection',
    collectionKind: 'likes',
  },
  soundcloud_short: {
    ok: true,
    url: 'https://on.soundcloud.com/abc123',
    platform: 'soundcloud',
    kind: 'soundcloud_short',
    guess: 'unknown',
  },
  out_of_scope: {
    ok: true,
    url: 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC',
    platform: 'other',
    kind: 'out_of_scope',
    guess: 'unknown',
  },
  other: {
    ok: true,
    url: 'https://vimeo.com/76979871',
    platform: 'other',
    kind: 'other',
    guess: 'unknown',
  },
} as const satisfies Record<UrlKind, ValidUrl>

const flag = (mode: ResolveMode) =>
  mode === 'track'
    ? { playlist: 'no' as const }
    : mode === 'collection'
      ? { playlist: 'yes' as const }
      : {}

const track = (url: string, extra: Partial<ResolvePlan> = {}): ResolvePlan => ({
  url,
  playlist: 'no',
  limit: MAX_COLLECTION_ENTRIES,
  expect: 'track',
  timeoutMs: TRACK_TIMEOUT_MS,
  ...extra,
})

const listing = (url: string, mode: ResolveMode, limit = MAX_COLLECTION_ENTRIES): ResolvePlan => ({
  url,
  ...flag(mode),
  limit,
  expect: 'any',
  timeoutMs: COLLECTION_TIMEOUT_MS,
})

const PLAYLIST_URL = 'https://www.youtube.com/playlist?list=PLt5yu3-wZAlQAaPZ5Z-rJoTdbT-45Q7c0'

/** The expected plan for every kind and mode (the table is exhaustive by type). */
const EXPECTED: Record<Exclude<UrlKind, 'out_of_scope'>, (mode: ResolveMode) => ResolvePlan> = {
  youtube_video: () => track(INPUTS.youtube_video.url),
  youtube_watch_list: (mode) => {
    if (mode === 'collection') return listing(PLAYLIST_URL, 'collection')
    const plan = track(INPUTS.youtube_watch_list.url)
    return mode === 'auto'
      ? { ...plan, ambiguous: { collectionUrl: PLAYLIST_URL, collectionKind: 'playlist' } }
      : plan
  },
  youtube_playlist: (mode) => listing(INPUTS.youtube_playlist.url, mode),
  youtube_album: (mode) => listing(INPUTS.youtube_album.url, mode),
  youtube_channel: (mode) => listing(INPUTS.youtube_channel.url, mode),
  soundcloud_track: (mode) => {
    const { playlist: _none, ...plan } = track(INPUTS.soundcloud_track.url)
    return { ...plan, ...flag(mode) }
  },
  soundcloud_set: (mode) => listing(INPUTS.soundcloud_set.url, mode),
  soundcloud_user: (mode) => listing(INPUTS.soundcloud_user.url, mode),
  soundcloud_likes: (mode) => listing(INPUTS.soundcloud_likes.url, mode),
  soundcloud_short: (mode) => listing(INPUTS.soundcloud_short.url, mode),
  other: (mode) => listing(INPUTS.other.url, mode),
}

const cases = Object.entries(EXPECTED).flatMap(([kind, expected]) =>
  MODES.map((mode) => [kind as Exclude<UrlKind, 'out_of_scope'>, mode, expected] as const),
)

describe('planResolve', () => {
  it.each(cases)('plans %s in %s mode', (kind, mode, expected) => {
    expect(planResolve(INPUTS[kind], mode)).toStrictEqual(expected(mode))
  })

  it.each(MODES)('refuses to plan an out_of_scope URL in %s mode', (mode) => {
    expect(() => planResolve(INPUTS.out_of_scope, mode)).toThrow(RangeError)
  })

  describe('youtube_watch_list with a mix', () => {
    const mix: ValidUrl = {
      ...INPUTS.youtube_watch_list,
      url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw&list=RDjNQXAC9IVRw&start_radio=1',
      collectionKind: 'mix',
      listId: 'RDjNQXAC9IVRw',
    }
    const mixUrl = 'https://www.youtube.com/watch?v=jNQXAC9IVRw&list=RDjNQXAC9IVRw'

    it('offers the mix with its seed video in auto mode', () => {
      expect(planResolve(mix, 'auto')).toStrictEqual(
        track(mix.url, { ambiguous: { collectionUrl: mixUrl, collectionKind: 'mix' } }),
      )
    })

    it('lists the mix from its seed video, capped at 50, in collection mode', () => {
      expect(planResolve(mix, 'collection')).toStrictEqual(
        listing(mixUrl, 'collection', MAX_MIX_ENTRIES),
      )
    })

    it('takes only the track in track mode', () => {
      expect(planResolve(mix, 'track')).toStrictEqual(track(mix.url))
    })
  })

  it('offers an album list as an album', () => {
    const album: ValidUrl = {
      ...INPUTS.youtube_watch_list,
      url: 'https://music.youtube.com/watch?v=jNQXAC9IVRw&list=OLAK5uy_abc',
      collectionKind: 'album',
      listId: 'OLAK5uy_abc',
    }
    expect(planResolve(album, 'auto').ambiguous).toStrictEqual({
      collectionUrl: 'https://www.youtube.com/playlist?list=OLAK5uy_abc',
      collectionKind: 'album',
    })
  })

  it('treats a watch_list without a list id as the video', () => {
    const { listId: _none, ...input } = INPUTS.youtube_watch_list
    expect(planResolve(input, 'collection')).toStrictEqual(track(input.url))
  })

  describe('a mix pasted as a playlist', () => {
    const asPlaylist = (url: string) => {
      const classified = classifyUrl(url)
      if (!classified.ok || classified.kind !== 'youtube_playlist') {
        throw new Error(`expected a YouTube playlist: ${url}`)
      }
      expect(classified.collectionKind).toBe('mix')
      return classified
    }

    // YouTube answers playlist?list=RD<id> with "This playlist type is unviewable".
    it.each(MODES)('lists a seeded mix from its seed video, capped at 50, in %s mode', (mode) => {
      const mix = asPlaylist('https://www.youtube.com/playlist?list=RDjNQXAC9IVRw&si=abc')
      expect(planResolve(mix, mode)).toStrictEqual(
        listing(
          'https://www.youtube.com/watch?v=jNQXAC9IVRw&list=RDjNQXAC9IVRw',
          'collection',
          MAX_MIX_ENTRIES,
        ),
      )
    })

    it.each([
      'https://www.youtube.com/playlist?list=RDMM',
      'https://www.youtube.com/playlist?list=RDAMVMjNQXAC9IVRw',
      'https://www.youtube.com/playlist?list=RDjNQXAC9IVRwx',
    ])('keeps %s as pasted, capped at 50 rows', (url) => {
      for (const mode of MODES) {
        expect(planResolve(asPlaylist(url), mode)).toStrictEqual(
          listing(url, mode, MAX_MIX_ENTRIES),
        )
      }
    })
  })

  describe('an embedded list', () => {
    const embedded = (url: string) => {
      const classified = classifyUrl(url)
      if (!classified.ok) throw new Error(`expected a valid URL: ${url}`)
      expect(classified.embeddedList).toBe(true)
      return classified
    }

    it.each(MODES)('resolves embed/videoseries at the playlist page in %s mode', (mode) => {
      const input = embedded(
        'https://www.youtube-nocookie.com/embed/videoseries?list=PLt5yu3-wZAlQAaPZ5Z-rJoTdbT-45Q7c0&index=2',
      )
      expect(planResolve(input, mode)).toStrictEqual(listing(PLAYLIST_URL, mode))
    })

    it('resolves an embedded album at its playlist page', () => {
      const input = embedded('https://www.youtube.com/embed/videoseries?list=OLAK5uy_abc')
      expect(planResolve(input, 'auto')).toStrictEqual(
        listing('https://www.youtube.com/playlist?list=OLAK5uy_abc', 'auto'),
      )
    })

    it('lists an embedded seeded mix from its seed video', () => {
      const input = embedded('https://www.youtube.com/embed/videoseries?list=RDjNQXAC9IVRw')
      expect(planResolve(input, 'auto')).toStrictEqual(
        listing(
          'https://www.youtube.com/watch?v=jNQXAC9IVRw&list=RDjNQXAC9IVRw',
          'collection',
          MAX_MIX_ENTRIES,
        ),
      )
    })
  })

  it.each([
    ['https://www.youtube.com/@nasa', 'https://www.youtube.com/@nasa/videos'],
    ['https://www.youtube.com/@nasa/', 'https://www.youtube.com/@nasa/videos'],
    [
      'https://www.youtube.com/channel/UCLA_DiR1FfKNvjuUpBHmylQ?si=x#top',
      'https://www.youtube.com/channel/UCLA_DiR1FfKNvjuUpBHmylQ/videos',
    ],
    ['https://m.youtube.com/c/NASA', 'https://m.youtube.com/c/NASA/videos'],
    ['https://www.youtube.com/@MixmagTV/featured', 'https://www.youtube.com/@MixmagTV/videos'],
    [
      'https://www.youtube.com/channel/UCLA_DiR1FfKNvjuUpBHmylQ/featured/',
      'https://www.youtube.com/channel/UCLA_DiR1FfKNvjuUpBHmylQ/videos',
    ],
  ])('lists the uploads tab of the channel root %s', (url, videos) => {
    const root: ValidUrl = { ...INPUTS.youtube_channel, url, channelRoot: true }
    expect(planResolve(root, 'auto')).toStrictEqual(listing(videos, 'auto'))
  })

  it('lists the uploads tab of a featured tab as classifyUrl marks it', () => {
    const classified = classifyUrl('youtube.com/@MixmagTV/featured?si=abc')
    if (!classified.ok) throw new Error('expected a valid URL')
    expect(classified.channelRoot).toBe(true)
    expect(planResolve(classified, 'auto').url).toBe('https://youtube.com/@MixmagTV/videos')
  })
})
