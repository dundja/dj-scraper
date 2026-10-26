// Remix answers for tests (`POST /api/remixes`, ADR-027), parsed with the shared schemas so they
// can't drift from the contract. Most played first, as the server sorts them.
import {
  type RemixSearchStatus,
  type RemixSuggestion,
  RemixSuggestionSchema,
  type RemixSuggestions,
  RemixSuggestionsSchema,
  type RemixUpload,
  RemixUploadSchema,
} from '@dj-scraper/shared'

const upload = (fields: RemixUpload): RemixUpload => RemixUploadSchema.parse(fields)

/** The Arty remix on its label's YouTube channel: the most played upload of the answer. */
export const artyYoutube = upload({
  platform: 'youtube',
  id: 'Kp7eSUU9oy8',
  url: 'https://www.youtube.com/watch?v=Kp7eSUU9oy8',
  title: 'Moby - Porcelain (Arty Remix)',
  uploader: 'Anjunabeats',
  durationSec: 214,
  thumbnailUrl: 'https://i.ytimg.com/vi/Kp7eSUU9oy8/hqdefault.jpg',
  plays: 908_123,
})

/** The same remix on SoundCloud. */
export const artySoundcloud = upload({
  platform: 'soundcloud',
  id: '279991262',
  url: 'https://soundcloud.com/anjunabeats/moby-porcelain-arty-remix',
  title: 'Moby - Porcelain (Arty Remix)',
  uploader: 'Anjunabeats',
  durationSec: 215.3,
  thumbnailUrl: 'https://i1.sndcdn.com/artworks-000181234567-abcdef-t500x500.jpg',
  plays: 381_927,
})

/** A re-upload of it on YouTube, less played. */
export const artyReupload = upload({
  platform: 'youtube',
  id: 'Zq3fRm0aB1c',
  url: 'https://www.youtube.com/watch?v=Zq3fRm0aB1c',
  title: 'Porcelain (Arty Remix) [Trance Classics]',
  uploader: 'Trance Archive',
  durationSec: 213,
  plays: 12_400,
})

export const bootlegUpload = upload({
  platform: 'soundcloud',
  id: '1543210987',
  url: 'https://soundcloud.com/nightferry/moby-porcelain-night-ferry-bootleg',
  title: 'Moby - Porcelain (Night Ferry Bootleg) [Afro House]',
  uploader: 'Night Ferry',
  durationSec: 389,
  plays: 152_400,
})

export const extendedUpload = upload({
  platform: 'youtube',
  id: 'aB3dE5fG7hI',
  url: 'https://www.youtube.com/watch?v=aB3dE5fG7hI',
  title: 'Moby - Porcelain (Extended Mix)',
  uploader: 'Moby',
  durationSec: 402,
  thumbnailUrl: 'https://i.ytimg.com/vi/aB3dE5fG7hI/hqdefault.jpg',
  plays: 48_200,
})

/** An upload with nothing but its names: no plays, duration or artwork. */
export const bareUpload = upload({
  platform: 'soundcloud',
  id: '998877665',
  url: 'https://soundcloud.com/someone/porcelain-remix',
  title: 'Porcelain remix',
})

const suggestion = (fields: RemixSuggestion): RemixSuggestion => RemixSuggestionSchema.parse(fields)

export const artyRemix = suggestion({
  kind: 'remix',
  remixer: 'Arty',
  genre: { name: 'Trance', source: 'platform' },
  plays: 908_123,
  uploads: [artyYoutube, artySoundcloud, artyReupload],
})

export const nightFerryBootleg = suggestion({
  kind: 'bootleg',
  remixer: 'Night Ferry',
  genre: { name: 'Afro House', source: 'text' },
  plays: 152_400,
  uploads: [bootlegUpload],
})

export const extendedMix = suggestion({
  kind: 'extended',
  genre: { name: 'Afro House', source: 'platform' },
  plays: 48_200,
  uploads: [extendedUpload],
})

export const bareRemix = suggestion({ kind: 'remix', uploads: [bareUpload] })

const ok = (found: number): RemixSearchStatus => ({ status: 'ok', found })

/** Four versions of Moby's Porcelain on both platforms, in two genres (and one without). */
export const remixes: RemixSuggestions = RemixSuggestionsSchema.parse({
  song: { title: 'Porcelain', artist: 'Moby' },
  suggestions: [artyRemix, nightFerryBootleg, extendedMix, bareRemix],
  searches: { youtube: ok(9), soundcloud: ok(6) },
})

/** `remixes` with `changes` on top, validated against the contract. */
export function remixesWith(changes: Partial<RemixSuggestions>): RemixSuggestions {
  return RemixSuggestionsSchema.parse({ ...remixes, ...changes })
}

/** Both searches went fine and found nothing. */
export const noRemixes: RemixSuggestions = remixesWith({
  suggestions: [],
  searches: { youtube: ok(0), soundcloud: ok(0) },
})

/**
 * The quick answer (`platforms: ['youtube']`) to the same search: `remixes`' YouTube uploads only,
 * SoundCloud skipped.
 */
export const quickRemixes: RemixSuggestions = remixesWith({
  suggestions: [suggestion({ ...artyRemix, uploads: [artyYoutube, artyReupload] }), extendedMix],
  searches: { youtube: ok(9), soundcloud: { status: 'skipped' } },
})
