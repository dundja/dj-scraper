import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  type ClassifiedUrl,
  classifyUrl,
  isYoutubeChannelId,
  type UrlGuess,
  type UrlKind,
  type UrlRejection,
  urlRejectionMessage,
  type ValidUrl,
  youtubeListKind,
} from './classify.ts'
import type { AmbiguousListKind } from './resolve.ts'
import { MAX_URL_LENGTH } from './url.ts'

/** What `classifyUrl(input)` returns besides `ok`; `url` defaults to the input itself. */
type Expected = Omit<ValidUrl, 'ok' | 'url'> & { url?: string }
type Case = [input: string, expected: Expected]

const VIDEO = 'dQw4w9WgXcQ'
const PLAYLIST = 'PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI'
const MIX = 'RDdQw4w9WgXcQ'
const CURATED = 'RDCLAK5uy_kmPRjHDECIcuVwnKsx2Ng7fyNgFKWNJFs'
const ALBUM = 'OLAK5uy_mGxXyM4DUX4e5Oq6PRaWAbXGiJ0vL0e7o'
const ALBUM_BROWSE = 'MPREb_4pL8gzRtw1p'
const CHANNEL = 'UCuAXFkgsw1L7xaCfnd5JJOw'

const youtubeVideo = (videoId = VIDEO): Expected => ({
  platform: 'youtube',
  kind: 'youtube_video',
  guess: 'track',
  videoId,
})
const youtubeWatchList = (listId: string, collectionKind: AmbiguousListKind): Expected => ({
  platform: 'youtube',
  kind: 'youtube_watch_list',
  guess: 'ambiguous',
  videoId: VIDEO,
  listId,
  collectionKind,
})
const youtubePlaylist = (listId: string, collectionKind: 'playlist' | 'mix'): Expected => ({
  platform: 'youtube',
  kind: 'youtube_playlist',
  guess: 'collection',
  listId,
  collectionKind,
})
const youtubeAlbum = (listId: string): Expected => ({
  platform: 'youtube',
  kind: 'youtube_album',
  guess: 'collection',
  listId,
  collectionKind: 'album',
})
/** An embed player URL for a list, which the server resolves as the list's own page. */
const embedded = (expected: Expected): Expected => ({ ...expected, embeddedList: true })
const youtubeChannelTab: Expected = {
  platform: 'youtube',
  kind: 'youtube_channel',
  guess: 'collection',
  collectionKind: 'channel',
}
const youtubeChannelRoot: Expected = { ...youtubeChannelTab, channelRoot: true }
const youtubeOther: Expected = { platform: 'youtube', kind: 'other', guess: 'unknown' }

const soundcloudTrack: Expected = {
  platform: 'soundcloud',
  kind: 'soundcloud_track',
  guess: 'track',
}
const soundcloudSet: Expected = {
  platform: 'soundcloud',
  kind: 'soundcloud_set',
  guess: 'collection',
  collectionKind: 'set',
}
const soundcloudUser: Expected = {
  platform: 'soundcloud',
  kind: 'soundcloud_user',
  guess: 'collection',
  collectionKind: 'channel',
}
const soundcloudLikes: Expected = {
  platform: 'soundcloud',
  kind: 'soundcloud_likes',
  guess: 'collection',
  collectionKind: 'likes',
}
const soundcloudShort: Expected = {
  platform: 'soundcloud',
  kind: 'soundcloud_short',
  guess: 'unknown',
}
const soundcloudOther: Expected = { platform: 'soundcloud', kind: 'other', guess: 'unknown' }
const secret = (expected: Expected): Expected => ({ ...expected, secret: true })

const outOfScope: Expected = { platform: 'other', kind: 'out_of_scope', guess: 'unknown' }
const other: Expected = { platform: 'other', kind: 'other', guess: 'unknown' }

/** `expected`, normalized to `url`. */
const at = (url: string, expected: Expected): Expected => ({ ...expected, url })

function expectClassified(input: string, expected: Expected): void {
  expect(classifyUrl(input)).toStrictEqual({ ok: true, url: input, ...expected })
}

const youtubeVideos: Case[] = [
  [`https://www.youtube.com/watch?v=${VIDEO}`, youtubeVideo()],
  [`https://youtube.com/watch?v=${VIDEO}`, youtubeVideo()],
  [`https://m.youtube.com/watch?v=${VIDEO}`, youtubeVideo()],
  [`https://music.youtube.com/watch?v=${VIDEO}`, youtubeVideo()],
  [`http://www.youtube.com/watch?v=${VIDEO}`, youtubeVideo()],
  [`https://youtu.be/${VIDEO}`, youtubeVideo()],
  [`https://youtu.be/${VIDEO}?si=Xq3vB7kLmN9pQr2s`, youtubeVideo()],
  [`https://youtu.be/${VIDEO}?t=42`, youtubeVideo()],
  [`https://www.youtube.com/shorts/${VIDEO}`, youtubeVideo()],
  [`https://youtube.com/shorts/${VIDEO}?feature=share`, youtubeVideo()],
  [`https://www.youtube.com/live/${VIDEO}?si=Xq3vB7kLmN9pQr2s`, youtubeVideo()],
  [`https://www.youtube.com/embed/${VIDEO}`, youtubeVideo()],
  [`https://www.youtube.com/v/${VIDEO}`, youtubeVideo()],
  [`https://www.youtube-nocookie.com/embed/${VIDEO}`, youtubeVideo()],
  [`https://youtube-nocookie.com/embed/${VIDEO}?start=30`, youtubeVideo()],
  [`https://www.youtube.com/watch?v=${VIDEO}&t=42s&pp=ygUEcmljaw%3D%3D`, youtubeVideo()],
  [`https://www.youtube.com/watch?app=desktop&v=${VIDEO}&feature=youtu.be`, youtubeVideo()],
  [`https://www.youtube.com/watch?v=${VIDEO}#t=1m02s`, youtubeVideo()],
  [`https://www.youtube.com/watch?v=${VIDEO}&list=`, youtubeVideo()],
  [`https://www.youtube.com/watch?v=${VIDEO}&list=not%20a%20list`, youtubeVideo()],
  [`https://www.youtube.com/watch/?v=${VIDEO}`, youtubeVideo()],
  [`https://www.youtube.com/shorts/${VIDEO}/`, youtubeVideo()],
  ['https://youtu.be/a-b_C1d2E3f', youtubeVideo('a-b_C1d2E3f')],
]

const youtubeWatchLists: Case[] = [
  [
    `https://www.youtube.com/watch?v=${VIDEO}&list=${PLAYLIST}`,
    youtubeWatchList(PLAYLIST, 'playlist'),
  ],
  [
    `https://www.youtube.com/watch?v=${VIDEO}&list=${PLAYLIST}&index=2&pp=iAQB`,
    youtubeWatchList(PLAYLIST, 'playlist'),
  ],
  [
    `https://www.youtube.com/watch?list=${PLAYLIST}&v=${VIDEO}`,
    youtubeWatchList(PLAYLIST, 'playlist'),
  ],
  [
    `https://youtu.be/${VIDEO}?list=${PLAYLIST}&si=Xq3vB7kLmN9pQr2s`,
    youtubeWatchList(PLAYLIST, 'playlist'),
  ],
  [
    `https://m.youtube.com/watch?v=${VIDEO}&list=${PLAYLIST}`,
    youtubeWatchList(PLAYLIST, 'playlist'),
  ],
  [
    `https://www.youtube.com/embed/${VIDEO}?list=${PLAYLIST}`,
    youtubeWatchList(PLAYLIST, 'playlist'),
  ],
  [
    `https://www.youtube.com/watch?v=${VIDEO}&list=${MIX}&start_radio=1`,
    youtubeWatchList(MIX, 'mix'),
  ],
  [`https://www.youtube.com/watch?v=${VIDEO}&list=RDMM`, youtubeWatchList('RDMM', 'mix')],
  [
    `https://music.youtube.com/watch?v=${VIDEO}&list=RDAMVM${VIDEO}`,
    youtubeWatchList(`RDAMVM${VIDEO}`, 'mix'),
  ],
  [
    `https://music.youtube.com/watch?v=${VIDEO}&list=${CURATED}`,
    youtubeWatchList(CURATED, 'playlist'),
  ],
  [`https://music.youtube.com/watch?v=${VIDEO}&list=${ALBUM}`, youtubeWatchList(ALBUM, 'album')],
]

const youtubeLists: Case[] = [
  [`https://www.youtube.com/playlist?list=${PLAYLIST}`, youtubePlaylist(PLAYLIST, 'playlist')],
  [
    `https://youtube.com/playlist?list=${PLAYLIST}&si=Xq3vB7kLmN9pQr2s`,
    youtubePlaylist(PLAYLIST, 'playlist'),
  ],
  [`https://m.youtube.com/playlist?list=${PLAYLIST}`, youtubePlaylist(PLAYLIST, 'playlist')],
  [`https://music.youtube.com/playlist?list=${PLAYLIST}`, youtubePlaylist(PLAYLIST, 'playlist')],
  [`https://www.youtube.com/playlist/?list=${PLAYLIST}`, youtubePlaylist(PLAYLIST, 'playlist')],
  [`https://www.youtube.com/watch?list=${PLAYLIST}`, youtubePlaylist(PLAYLIST, 'playlist')],
  [
    `https://www.youtube.com/watch?v=dQw4w9&list=${PLAYLIST}`,
    youtubePlaylist(PLAYLIST, 'playlist'),
  ],
  [`https://www.youtube.com/playlist?list=${MIX}`, youtubePlaylist(MIX, 'mix')],
  [`https://music.youtube.com/playlist?list=${CURATED}`, youtubePlaylist(CURATED, 'playlist')],
  [
    `https://www.youtube.com/playlist?list=UUuAXFkgsw1L7xaCfnd5JJOw`,
    youtubePlaylist('UUuAXFkgsw1L7xaCfnd5JJOw', 'playlist'),
  ],
  [`https://www.youtube.com/playlist?list=${ALBUM}`, youtubeAlbum(ALBUM)],
  [`https://music.youtube.com/playlist?list=${ALBUM}`, youtubeAlbum(ALBUM)],
  [`https://music.youtube.com/browse/${ALBUM_BROWSE}`, youtubeAlbum(ALBUM_BROWSE)],
  // `videoseries` has a video id's shape, but yt-dlp's YoutubeIE excludes it: it embeds the list.
  [
    `https://www.youtube.com/embed/videoseries?list=${PLAYLIST}`,
    embedded(youtubePlaylist(PLAYLIST, 'playlist')),
  ],
  [
    `https://www.youtube.com/embed/videoseries/?list=${PLAYLIST}&index=3`,
    embedded(youtubePlaylist(PLAYLIST, 'playlist')),
  ],
  [
    `https://www.youtube-nocookie.com/embed/videoseries?list=${PLAYLIST}`,
    embedded(youtubePlaylist(PLAYLIST, 'playlist')),
  ],
  [`https://www.youtube.com/embed/videoseries?list=${MIX}`, embedded(youtubePlaylist(MIX, 'mix'))],
  [`https://www.youtube.com/embed/videoseries?list=${ALBUM}`, embedded(youtubeAlbum(ALBUM))],
]

const youtubeChannels: Case[] = [
  ['https://www.youtube.com/@MixmagTV', youtubeChannelRoot],
  ['https://www.youtube.com/@MixmagTV/', youtubeChannelRoot],
  ['https://m.youtube.com/@MixmagTV', youtubeChannelRoot],
  ['https://www.youtube.com/@MixmagTV/featured', youtubeChannelRoot],
  [`https://www.youtube.com/channel/${CHANNEL}`, youtubeChannelRoot],
  [`https://music.youtube.com/channel/${CHANNEL}`, youtubeChannelRoot],
  ['https://www.youtube.com/c/BoilerRoom', youtubeChannelRoot],
  ['https://www.youtube.com/user/BoilerRoom', youtubeChannelRoot],
  ['https://www.youtube.com/@MixmagTV/videos', youtubeChannelTab],
  ['https://www.youtube.com/@MixmagTV/videos/', youtubeChannelTab],
  ['https://www.youtube.com/@MixmagTV/videos?view=0&sort=p', youtubeChannelTab],
  ['https://www.youtube.com/@MixmagTV/shorts', youtubeChannelTab],
  ['https://www.youtube.com/@MixmagTV/streams', youtubeChannelTab],
  ['https://www.youtube.com/@MixmagTV/playlists', youtubeChannelTab],
  ['https://www.youtube.com/@MixmagTV/releases', youtubeChannelTab],
  ['https://www.youtube.com/@MixmagTV/podcasts', youtubeChannelTab],
  [`https://www.youtube.com/channel/${CHANNEL}/videos`, youtubeChannelTab],
  ['https://www.youtube.com/c/BoilerRoom/videos', youtubeChannelTab],
  ['https://www.youtube.com/user/BoilerRoom/streams', youtubeChannelTab],
]

const otherYoutubePages: Case[] = [
  ['https://www.youtube.com/', youtubeOther],
  ['https://www.youtube.com/results?search_query=deep+house', youtubeOther],
  ['https://www.youtube.com/feed/subscriptions', youtubeOther],
  ['https://www.youtube.com/hashtag/house', youtubeOther],
  ['https://www.youtube.com/watch', youtubeOther],
  ['https://www.youtube.com/watch?v=dQw4w9', youtubeOther],
  [`https://www.youtube.com/watch?v=${VIDEO}x`, youtubeOther],
  ['https://www.youtube.com/watch?v=dQw4w9WgXc!', youtubeOther],
  ['https://www.youtube.com/playlist', youtubeOther],
  ['https://www.youtube.com/playlist?list=', youtubeOther],
  ['https://www.youtube.com/playlist?list=PL%20bad', youtubeOther],
  ['https://www.youtube.com/shorts', youtubeOther],
  [`https://www.youtube.com/shorts/${VIDEO}/extra`, youtubeOther],
  [`https://www.youtube.com/clip/${VIDEO}`, youtubeOther],
  ['https://www.youtube.com/@', youtubeOther],
  ['https://www.youtube.com/@MixmagTV/community', youtubeOther],
  ['https://www.youtube.com/@MixmagTV/about', youtubeOther],
  ['https://www.youtube.com/@MixmagTV/live', youtubeOther],
  ['https://www.youtube.com/@MixmagTV/videos/extra', youtubeOther],
  ['https://www.youtube.com/channel/not-a-channel-id', youtubeOther],
  [`https://www.youtube.com/channel/${CHANNEL.slice(0, -1)}`, youtubeOther],
  ['https://www.youtube.com/channel', youtubeOther],
  ['https://www.youtube.com/c', youtubeOther],
  ['https://www.youtube.com/BoilerRoom', youtubeOther],
  [`https://www.youtube.com/browse/${ALBUM_BROWSE}`, youtubeOther],
  [`https://music.youtube.com/browse/VL${PLAYLIST}`, youtubeOther],
  ['https://youtu.be/', youtubeOther],
  ['https://youtu.be/dQw4w9', youtubeOther],
  [`https://youtu.be/${VIDEO}/extra`, youtubeOther],
  [`https://youtu.be/watch?v=${VIDEO}`, youtubeOther],
  [`https://youtu.be/playlist?list=${PLAYLIST}`, youtubeOther],
  ['https://youtu.be/@MixmagTV', youtubeOther],
  ['https://www.youtube.com/embed/videoseries', youtubeOther],
  ['https://www.youtube.com/embed/videoseries?list=', youtubeOther],
  [`https://www.youtube.com/embed/live_stream?channel=${CHANNEL}`, youtubeOther],
  [`https://www.youtube.com/v/videoseries?list=${PLAYLIST}`, youtubeOther],
  // youtu.be has no embed player: yt-dlp's YoutubeIE takes this as a video id too.
  ['https://youtu.be/videoseries', youtubeVideo('videoseries')],
]

const soundcloudTracks: Case[] = [
  ['https://soundcloud.com/some-artist/deep-house-edit', soundcloudTrack],
  ['https://www.soundcloud.com/some-artist/deep-house-edit', soundcloudTrack],
  ['https://m.soundcloud.com/some-artist/deep-house-edit', soundcloudTrack],
  ['https://soundcloud.com/some-artist/deep-house-edit/', soundcloudTrack],
  ['https://soundcloud.com/some_artist/deep-house-edit-2', soundcloudTrack],
  [
    'https://soundcloud.com/some-artist/deep-house-edit?in=some-artist/sets/summer-2026',
    soundcloudTrack,
  ],
  [
    'https://soundcloud.com/some-artist/deep-house-edit?si=0f1e2d3c4b5a&utm_source=clipboard&utm_medium=text',
    soundcloudTrack,
  ],
  ['https://soundcloud.com/some-artist/unreleased-dub/s-AbCdEfGhIjK', secret(soundcloudTrack)],
  ['https://soundcloud.com/some-artist/unreleased-dub/s-AbCdEfGhIjK/', secret(soundcloudTrack)],
  [
    'https://soundcloud.com/some-artist/unreleased-dub/s-AbCdEfGhIjK?si=0f1e2d3c4b5a',
    secret(soundcloudTrack),
  ],
  [
    'https://soundcloud.com/some-artist/unreleased-dub?secret_token=s-AbCdEfGhIjK',
    secret(soundcloudTrack),
  ],
  ['https://api.soundcloud.com/tracks/1234567890', soundcloudTrack],
  ['https://api-v2.soundcloud.com/tracks/1234567890', soundcloudTrack],
  [
    'https://api.soundcloud.com/tracks/1234567890?secret_token=s-AbCdEfGhIjK',
    secret(soundcloudTrack),
  ],
]

const soundcloudSets: Case[] = [
  ['https://soundcloud.com/some-artist/sets/summer-2026', soundcloudSet],
  ['https://m.soundcloud.com/some-artist/sets/summer-2026', soundcloudSet],
  ['https://soundcloud.com/some-artist/sets/summer-2026/', soundcloudSet],
  ['https://soundcloud.com/some-artist/sets/summer-2026?si=0f1e2d3c4b5a', soundcloudSet],
  ['https://soundcloud.com/some-artist/sets/summer-2026/s-AbCdEfGhIjK', secret(soundcloudSet)],
  [
    'https://soundcloud.com/some-artist/sets/summer-2026?secret_token=s-AbCdEfGhIjK',
    secret(soundcloudSet),
  ],
  ['https://api.soundcloud.com/playlists/1876543210', soundcloudSet],
  ['https://api-v2.soundcloud.com/playlists/1876543210', soundcloudSet],
]

const soundcloudUsers: Case[] = [
  ['https://soundcloud.com/some-artist', soundcloudUser],
  ['https://soundcloud.com/some-artist/', soundcloudUser],
  ['https://www.soundcloud.com/some-artist', soundcloudUser],
  ['https://m.soundcloud.com/some-artist', soundcloudUser],
  ['https://soundcloud.com/some-artist/tracks', soundcloudUser],
  ['https://soundcloud.com/some-artist/popular-tracks', soundcloudUser],
  ['https://soundcloud.com/some-artist/toptracks', soundcloudUser],
  ['https://soundcloud.com/some-artist/reposts', soundcloudUser],
  ['https://soundcloud.com/some-artist/albums', soundcloudUser],
  ['https://soundcloud.com/some-artist/sets', soundcloudUser],
  ['https://soundcloud.com/some-artist/sets/', soundcloudUser],
  ['https://soundcloud.com/some-artist/spotlight', soundcloudUser],
  ['https://soundcloud.com/some-artist/Tracks', soundcloudUser],
  ['https://soundcloud.com/you/tracks', soundcloudUser],
  ['https://soundcloud.com/some-artist/likes', soundcloudLikes],
  ['https://soundcloud.com/some-artist/likes/', soundcloudLikes],
  ['https://m.soundcloud.com/some-artist/likes', soundcloudLikes],
  ['https://soundcloud.com/you/likes', soundcloudLikes],
]

const soundcloudShortLinks: Case[] = [
  ['https://on.soundcloud.com/AbCdEfGhIjKlMnOp', soundcloudShort],
  ['https://on.soundcloud.com/AbCdEfGhIjKlMnOp/', soundcloudShort],
  ['https://on.soundcloud.com/', soundcloudOther],
  ['https://on.soundcloud.com/AbCdEfGhIjKlMnOp/extra', soundcloudOther],
]

/** SoundCloud's own pages, which a naive /<user>/<track> rule would read as users, tracks or sets. */
const soundcloudReserved = [
  'discover',
  'stream',
  'upload',
  'search',
  'charts',
  'pages',
  'stations',
  'messages',
  'notifications',
  'settings',
  'mobile',
  'jobs',
  'imprint',
  'people',
  'tags',
  'popular',
  'feed',
  'terms-of-use',
  'signin',
  'logout',
  'connect',
]

const otherSoundcloudPages: Case[] = [
  ['https://soundcloud.com/', soundcloudOther],
  ['https://soundcloud.com/you', soundcloudOther],
  ['https://soundcloud.com/you/library', soundcloudOther],
  ['https://soundcloud.com/you/deep-house-edit', soundcloudOther],
  ['https://soundcloud.com/you/sets/summer-2026', soundcloudOther],
  ['https://soundcloud.com/Discover', soundcloudOther],
  ['https://soundcloud.com/search?q=deep%20house', soundcloudOther],
  ['https://soundcloud.com/charts/top', soundcloudOther],
  ['https://soundcloud.com/discover/sets/charts-top:all-music', soundcloudOther],
  ['https://soundcloud.com/stations/track/some-artist/deep-house-edit', soundcloudOther],
  ['https://soundcloud.com/some-artist/followers', soundcloudOther],
  ['https://soundcloud.com/some-artist/following', soundcloudOther],
  ['https://soundcloud.com/some-artist/comments', soundcloudOther],
  ['https://soundcloud.com/some-artist/likes/extra', soundcloudOther],
  ['https://soundcloud.com/some-artist/tracks/s-AbCdEfGhIjK', soundcloudOther],
  ['https://soundcloud.com/some-artist/deep-house-edit/recommended', soundcloudOther],
  ['https://soundcloud.com/some-artist/deep-house-edit/likes', soundcloudOther],
  ['https://soundcloud.com/some-artist/sets/summer-2026/extra', soundcloudOther],
  ['https://soundcloud.com/some-artist/sets/summer-2026/s-AbCdEfGhIjK/extra', soundcloudOther],
  ['https://soundcloud.com/some%20artist', soundcloudOther],
  ['https://soundcloud.com/some-artist/deep%20house', soundcloudOther],
  ['https://api.soundcloud.com/users/987654321', soundcloudOther],
  ['https://api-v2.soundcloud.com/tracks/soundcloud:tracks:1234567890', soundcloudOther],
  ['https://api-v2.soundcloud.com/tracks/1234567890/comments', soundcloudOther],
  ['https://api-v2.soundcloud.com/tracks', soundcloudOther],
  ['https://soundcloud.com/discover?secret_token=s-AbCdEfGhIjK', secret(soundcloudOther)],
]

const drmServices: Case[] = [
  ['https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC', outOfScope],
  ['https://spotify.com/', outOfScope],
  ['https://spotify.link/AbCdEfGhIj', outOfScope],
  ['https://music.apple.com/us/album/some-album/1234567890?i=1234567891', outOfScope],
  ['https://embed.music.apple.com/us/album/some-album/1234567890', outOfScope],
  ['https://itunes.apple.com/us/album/some-album/id1234567890', outOfScope],
  ['https://tidal.com/browse/track/12345678', outOfScope],
  ['https://listen.tidal.com/track/12345678', outOfScope],
  ['https://www.deezer.com/en/track/123456789', outOfScope],
  ['https://link.deezer.com/s/AbCdEfGhIj', outOfScope],
  ['https://deezer.page.link/AbCdEfGhIj', outOfScope],
  ['https://www.beatport.com/track/deep-house-edit/12345678', outOfScope],
  [
    'https://OPEN.Spotify.com/track/4uLU6hMCjMI75M1A2tKUQC',
    at('https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC', outOfScope),
  ],
  [
    'open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC',
    at('https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC', outOfScope),
  ],
  ['https://open.spotify.com:8443/track/4uLU6hMCjMI75M1A2tKUQC', outOfScope],
  ['https://music.amazon.com/albums/B0000000000', outOfScope],
  ['https://music.amazon.co.uk/albums/B0000000000', outOfScope],
  ['https://music.amazon.de/albums/B0000000000', outOfScope],
  ['https://music.amazon.com.au/albums/B0000000000?trackAsin=B0000000001', outOfScope],
  ['https://music.amazon.co.jp/albums/B0000000000', outOfScope],
  ['https://www.music.amazon.in/albums/B0000000000', outOfScope],
  [
    'https://MUSIC.Amazon.FR/albums/B0000000000',
    at('https://music.amazon.fr/albums/B0000000000', outOfScope),
  ],
  // DNS ignores a trailing dot, so it must not get a DRM service past the refusal.
  ['https://open.spotify.com./track/x', at('https://open.spotify.com/track/x', outOfScope)],
  ['https://open.spotify.com../track/x', at('https://open.spotify.com/track/x', outOfScope)],
  ['https://open.spotify.com\u3002/track/x', at('https://open.spotify.com/track/x', outOfScope)],
  [
    'https://music.apple.com./us/album/x/123',
    at('https://music.apple.com/us/album/x/123', outOfScope),
  ],
  ['https://listen.tidal.com./track/1', at('https://listen.tidal.com/track/1', outOfScope)],
  ['https://www.deezer.com./track/1', at('https://www.deezer.com/track/1', outOfScope)],
  ['https://www.beatport.com./track/a/1', at('https://www.beatport.com/track/a/1', outOfScope)],
  [
    'https://music.amazon.co.uk./albums/B0000000000',
    at('https://music.amazon.co.uk/albums/B0000000000', outOfScope),
  ],
]

const otherHosts: Case[] = [
  ['https://some-artist.bandcamp.com/track/deep-house-edit', other],
  ['https://www.mixcloud.com/some-artist/summer-mix/', other],
  ['http://localhost:4747/api/health', other],
  ['http://127.0.0.1:4747/', other],
  ['https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg', other],
  ['https://i1.sndcdn.com/artworks-000123456789-abcdef-t500x500.jpg', other],
  ['https://gaming.youtube.com/watch?v=dQw4w9WgXcQ', other],
  // Look-alikes that must not match a platform by substring or suffix.
  [`https://www.youtube.com.evil.example/watch?v=${VIDEO}`, other],
  [`https://youtube.com.evil.example/watch?v=${VIDEO}`, other],
  [`https://notyoutube.com/watch?v=${VIDEO}`, other],
  [`https://youtu.be.evil.example/${VIDEO}`, other],
  ['https://notsoundcloud.com/some-artist/deep-house-edit', other],
  ['https://soundcloud.com.evil.example/some-artist/deep-house-edit', other],
  ['https://evil.example/soundcloud.com/some-artist/deep-house-edit', other],
  [`https://evil.example/?next=https://www.youtube.com/watch?v=${VIDEO}`, other],
  ['https://notspotify.com/track/4uLU6hMCjMI75M1A2tKUQC', other],
  ['https://spotify.com.evil.example/track/4uLU6hMCjMI75M1A2tKUQC', other],
  ['https://apple.com/music/', other],
  ['https://podcasts.apple.com/us/podcast/some-show/id1234567890', other],
  ['https://www.beatsource.com/track/deep-house-edit/12345678', other],
  ['https://notmusic.amazon.com/albums/B0000000000', other],
  ['https://music.amazon.com.evil.example/albums/B0000000000', other],
  ['https://music.amazon.evil.example/albums/B0000000000', other],
  ['https://music-amazon.com/albums/B0000000000', other],
  ['https://music.amazonaws.com/albums/B0000000000', other],
  ['https://www.amazon.com/music/player/albums/B0000000000', other],
  // A non-default port isn't the real site.
  [`https://www.youtube.com:8443/watch?v=${VIDEO}`, other],
  ['https://soundcloud.com:8443/some-artist/deep-house-edit', other],
]

const normalized: Case[] = [
  [`youtu.be/${VIDEO}`, at(`https://youtu.be/${VIDEO}`, youtubeVideo())],
  [
    `www.youtube.com/watch?v=${VIDEO}`,
    at(`https://www.youtube.com/watch?v=${VIDEO}`, youtubeVideo()),
  ],
  [`youtube.com/watch?v=${VIDEO}`, at(`https://youtube.com/watch?v=${VIDEO}`, youtubeVideo())],
  [`m.youtube.com/watch?v=${VIDEO}`, at(`https://m.youtube.com/watch?v=${VIDEO}`, youtubeVideo())],
  ['youtube.com/@MixmagTV', at('https://youtube.com/@MixmagTV', youtubeChannelRoot)],
  [
    `WWW.YOUTUBE.COM/watch?v=${VIDEO}`,
    at(`https://www.youtube.com/watch?v=${VIDEO}`, youtubeVideo()),
  ],
  [
    `//www.youtube.com/watch?v=${VIDEO}`,
    at(`https://www.youtube.com/watch?v=${VIDEO}`, youtubeVideo()),
  ],
  ['www.youtube.com', at('https://www.youtube.com/', youtubeOther)],
  [
    'soundcloud.com/some-artist/deep-house-edit',
    at('https://soundcloud.com/some-artist/deep-house-edit', soundcloudTrack),
  ],
  ['m.soundcloud.com/some-artist', at('https://m.soundcloud.com/some-artist', soundcloudUser)],
  [
    'on.soundcloud.com/AbCdEfGhIjKlMnOp',
    at('https://on.soundcloud.com/AbCdEfGhIjKlMnOp', soundcloudShort),
  ],
  [`  https://youtu.be/${VIDEO}\n`, at(`https://youtu.be/${VIDEO}`, youtubeVideo())],
  [`\t youtu.be/${VIDEO} `, at(`https://youtu.be/${VIDEO}`, youtubeVideo())],
  [`HTTPS://YOUTU.BE/${VIDEO}`, at(`https://youtu.be/${VIDEO}`, youtubeVideo())],
  [
    `https://WWW.YouTube.COM/watch?v=${VIDEO}`,
    at(`https://www.youtube.com/watch?v=${VIDEO}`, youtubeVideo()),
  ],
  [
    'https://SoundCloud.com/Some-Artist/Deep-House-Edit',
    at('https://soundcloud.com/Some-Artist/Deep-House-Edit', soundcloudTrack),
  ],
  [
    `https://www.youtube.com:443/watch?v=${VIDEO}`,
    at(`https://www.youtube.com/watch?v=${VIDEO}`, youtubeVideo()),
  ],
  ['https://example.com', at('https://example.com/', other)],
  ['example.com:8080/path', at('https://example.com:8080/path', other)],
  // A trailing dot on the host is dropped, so the host rules see the real site.
  [
    `https://www.youtube.com./watch?v=${VIDEO}&list=${MIX}`,
    at(`https://www.youtube.com/watch?v=${VIDEO}&list=${MIX}`, youtubeWatchList(MIX, 'mix')),
  ],
  [
    'https://soundcloud.com./some-artist/unreleased-dub/s-AbCdEfGhIjK',
    at('https://soundcloud.com/some-artist/unreleased-dub/s-AbCdEfGhIjK', secret(soundcloudTrack)),
  ],
  [
    'https://api-v2.soundcloud.com./tracks/1234567890?secret_token=s-AbCdEfGhIjK',
    at(
      'https://api-v2.soundcloud.com/tracks/1234567890?secret_token=s-AbCdEfGhIjK',
      secret(soundcloudTrack),
    ),
  ],
  ['http://example.com.:8080/path', at('http://example.com:8080/path', other)],
]

const rejections: [input: string, reason: UrlRejection][] = [
  ['', 'empty'],
  ['   ', 'empty'],
  ['\n\t ', 'empty'],
  ['not a link', 'not_a_url'],
  ['rick astley never gonna give you up', 'not_a_url'],
  ['youtube', 'not_a_url'],
  ['track.mp3', 'not_a_url'],
  ['watch?v=dQw4w9WgXcQ', 'not_a_url'],
  ['/watch?v=dQw4w9WgXcQ', 'not_a_url'],
  ['https://', 'not_a_url'],
  ['http://exa mple.com/', 'not_a_url'],
  ['https://[::1/', 'not_a_url'],
  ['https://./', 'not_a_url'],
  ['https://../track', 'not_a_url'],
  ['javascript:alert(document.cookie)', 'not_http'],
  ['JavaScript:alert(1)', 'not_http'],
  ['  javascript:alert(1)', 'not_http'],
  ['file:///Users/dj/Music/track.mp3', 'not_http'],
  ['ftp://ftp.example.com/track.mp3', 'not_http'],
  ['data:text/html,<script>alert(1)</script>', 'not_http'],
  ['mailto:dj@example.com', 'not_http'],
  ['wss://example.com/socket', 'not_http'],
  ['blob:https://www.youtube.com/0b7e2a4c', 'not_http'],
  [`https://user:hunter2@www.youtube.com/watch?v=${VIDEO}`, 'credentials'],
  ['https://dj@soundcloud.com/some-artist/deep-house-edit', 'credentials'],
  ['https://:hunter2@example.com/', 'credentials'],
  [`//user:hunter2@www.youtube.com/watch?v=${VIDEO}`, 'credentials'],
]

const allCases = [
  ...youtubeVideos,
  ...youtubeWatchLists,
  ...youtubeLists,
  ...youtubeChannels,
  ...otherYoutubePages,
  ...soundcloudTracks,
  ...soundcloudSets,
  ...soundcloudUsers,
  ...soundcloudShortLinks,
  ...otherSoundcloudPages,
  ...drmServices,
  ...otherHosts,
  ...normalized,
]

describe('classifyUrl', () => {
  describe('YouTube', () => {
    it.each(youtubeVideos)('classifies %s as a video', expectClassified)
    it.each(youtubeWatchLists)('classifies %s as a video inside a list', expectClassified)
    it.each(youtubeLists)('classifies %s as a playlist or album', expectClassified)
    it.each(youtubeChannels)('classifies %s as a channel', expectClassified)
    it.each(otherYoutubePages)('classifies %s as some other YouTube page', expectClassified)
  })

  describe('SoundCloud', () => {
    it.each(soundcloudTracks)('classifies %s as a track', expectClassified)
    it.each(soundcloudSets)('classifies %s as a set', expectClassified)
    it.each(soundcloudUsers)('classifies %s as a user page or likes', expectClassified)
    it.each(soundcloudShortLinks)('classifies %s as a short link', expectClassified)
    it.each(otherSoundcloudPages)('classifies %s as some other SoundCloud page', expectClassified)

    it.each(soundcloudReserved.flatMap((page) => [`/${page}`, `/${page}/some-artist`]))(
      'never reads SoundCloud %s as a user or track',
      (path) => {
        expectClassified(`https://soundcloud.com${path}`, soundcloudOther)
      },
    )
  })

  describe('DRM services', () => {
    it.each(drmServices)('refuses %s as out of scope', expectClassified)
  })

  describe('other hosts', () => {
    it.each(otherHosts)('classifies %s as other', expectClassified)
  })

  describe('normalization', () => {
    it.each(normalized)('normalizes %j', expectClassified)
  })

  describe('rejections', () => {
    it.each(rejections)('rejects %j as %s', (input, reason) => {
      expect(classifyUrl(input)).toStrictEqual({ ok: false, reason })
    })

    const base = 'https://example.com/'
    const atLimit = base + 'a'.repeat(MAX_URL_LENGTH - base.length)

    it('accepts a URL of exactly MAX_URL_LENGTH characters', () => {
      expect(atLimit).toHaveLength(MAX_URL_LENGTH)
      expectClassified(atLimit, other)
    })

    it('rejects a URL one character over MAX_URL_LENGTH', () => {
      expect(classifyUrl(`${atLimit}a`)).toStrictEqual({ ok: false, reason: 'too_long' })
    })

    it('measures the length after trimming', () => {
      expectClassified(`  ${atLimit}\n`, at(atLimit, other))
    })

    it('measures the normalized url too, since percent-encoding can triple the length', () => {
      const pasted = base + 'é'.repeat(400)
      expect(pasted.length).toBeLessThan(MAX_URL_LENGTH)
      expect(classifyUrl(pasted)).toStrictEqual({ ok: false, reason: 'too_long' })
    })

    it('counts the https:// it adds to scheme-less input', () => {
      const schemeless = `example.com/${'a'.repeat(MAX_URL_LENGTH - 'example.com/'.length)}`
      expect(schemeless).toHaveLength(MAX_URL_LENGTH)
      expect(classifyUrl(schemeless)).toStrictEqual({ ok: false, reason: 'too_long' })
    })
  })

  it('has a case for every kind', () => {
    const kinds = new Set(allCases.map(([, expected]) => expected.kind))
    const everyKind: Record<UrlKind, true> = {
      youtube_video: true,
      youtube_watch_list: true,
      youtube_playlist: true,
      youtube_album: true,
      youtube_channel: true,
      soundcloud_track: true,
      soundcloud_set: true,
      soundcloud_user: true,
      soundcloud_likes: true,
      soundcloud_short: true,
      out_of_scope: true,
      other: true,
    }
    expect([...kinds].sort()).toEqual(Object.keys(everyKind).sort())
  })

  it('always returns an http(s) url the contract accepts', () => {
    for (const [input] of allCases) {
      const result = classifyUrl(input)
      expect(result.ok && /^https?:\/\//.test(result.url)).toBe(true)
    }
  })

  it('is typed as a union discriminated by ok', () => {
    expectTypeOf(classifyUrl).returns.toEqualTypeOf<ClassifiedUrl>()
    expectTypeOf<Extract<ClassifiedUrl, { ok: false }>>().toEqualTypeOf<{
      ok: false
      reason: UrlRejection
    }>()
    expectTypeOf<ValidUrl['kind']>().toEqualTypeOf<UrlKind>()
    expectTypeOf<ValidUrl['guess']>().toEqualTypeOf<UrlGuess>()
  })
})

describe('youtubeListKind', () => {
  it.each([
    [PLAYLIST, 'playlist'],
    ['UUuAXFkgsw1L7xaCfnd5JJOw', 'playlist'],
    [CURATED, 'playlist'],
    [ALBUM, 'album'],
    [MIX, 'mix'],
    ['RDMM', 'mix'],
    [`RDAMVM${VIDEO}`, 'mix'],
  ] satisfies [string, AmbiguousListKind][])('reads %s as a %s', (listId, kind) => {
    expect(youtubeListKind(listId)).toBe(kind)
  })
})

describe('isYoutubeChannelId', () => {
  it.each([
    [CHANNEL, true],
    ['UC_aEa8K-EOJ3D6gOs7HcyNg', true],
    [CHANNEL.slice(0, -1), false],
    [`${CHANNEL}x`, false],
    ['UUuAXFkgsw1L7xaCfnd5JJOw', false],
    ['@MixmagTV', false],
  ])('%s → %s', (id, expected) => {
    expect(isYoutubeChannelId(id)).toBe(expected)
  })
})

describe('urlRejectionMessage', () => {
  it.each([
    ['empty', 'Paste a YouTube or SoundCloud link.'],
    ['too_long', 'That link is too long.'],
    ['not_a_url', "That doesn't look like a link."],
    ['not_http', 'Only http and https links work here.'],
    ['credentials', "Links with a username or password aren't supported."],
  ] satisfies [UrlRejection, string][])('explains %s as %j', (reason, message) => {
    expect(urlRejectionMessage(reason)).toBe(message)
  })

  it('explains every rejection classifyUrl can return', () => {
    for (const [input] of rejections) {
      const result = classifyUrl(input)
      expect(result.ok ? '' : urlRejectionMessage(result.reason)).not.toBe('')
    }
  })
})
