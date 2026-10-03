import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import {
  classifyUrl,
  type DownloadFormat,
  DownloadFormatSchema,
  type ValidUrl,
} from '@dj-scraper/shared'
import { describe, expect, it } from 'vitest'
import { type DoneInfo, StepError } from '../jobs/types.ts'
import {
  type AudioPlan,
  audioArgs,
  COVER_SCALE,
  canHoldCover,
  cleanTagValue,
  commentUrl,
  coverArgs,
  describeTrack,
  downloadProblem,
  FFMPEG_HEAD,
  ffmpegDiskFull,
  ffmpegErrorText,
  ffprobeArgs,
  finalFileName,
  isPlaceholderThumbnail,
  MAX_TAG_LENGTH,
  measureArgs,
  needsMeasuredDuration,
  originalMuxer,
  outputInfo,
  outputProblem,
  PROBE_ENTRIES,
  type Probe,
  parseMeasuredDuration,
  parseProbe,
  planAudio,
  releaseYear,
  sameDuration,
  sniffImage,
  type Tags,
} from './finalize-plan.ts'

const FFPROBE_DIR = path.join(import.meta.dirname, '../../test/fixtures/ffprobe')

function probeFixture(name: string): Probe {
  const probe = parseProbe(readFileSync(path.join(FFPROBE_DIR, `${name}.json`), 'utf8'))
  if (probe === undefined) throw new Error(`${name}: not a probe`)
  return probe
}

function valid(url: string): ValidUrl {
  const classified = classifyUrl(url)
  if (!classified.ok) throw new Error(`not a URL: ${url}`)
  return classified
}

/** A probe made by hand: one audio stream. */
function sourceProbe(
  audio: { codec: string; channels?: number; sampleRateHz?: number },
  formatNames: string[],
  durationSec = 200,
): Probe {
  return {
    formatNames,
    durationSec,
    tags: {},
    streams: [{ index: 0, type: 'audio', attachedPic: false, tags: {}, ...audio }],
    audio: { index: 0, type: 'audio', attachedPic: false, tags: {}, ...audio },
  }
}

const YOUTUBE = 'https://www.youtube.com/watch?v=jNQXAC9IVRw'
const SOUNDCLOUD = 'https://soundcloud.com/the-concept-band/knocked-up-mastered'
const SOUNDCLOUD_SECRET = 'https://soundcloud.com/jaimemf/youtube-dl-test-video-a-y-baw/s-8Pjrp'

// The DONE lines of the recordings in test/fixtures/downloads/, as ytdlp-progress.ts parses them.
const youtubeDone: DoneInfo = {
  id: 'jNQXAC9IVRw',
  filepath: '/jobs/x/jNQXAC9IVRw.webm',
  ext: 'webm',
  formatId: '251',
  acodec: 'opus',
  abrKbps: 106.064,
  asrHz: 48000,
  durationSec: 19,
  title: 'Me at the zoo',
  uploader: 'jawed',
  channel: 'jawed',
  webpageUrl: YOUTUBE,
  extractorKey: 'Youtube',
  availability: 'public',
  thumbnailPath: '/jobs/x/jNQXAC9IVRw.webp',
  thumbnailUrl: 'https://i.ytimg.com/vi_webp/jNQXAC9IVRw/hqdefault.webp',
}
const soundcloudSecretDone: DoneInfo = {
  id: '123998367',
  filepath: '/jobs/x/123998367.mp3',
  ext: 'mp3',
  formatId: 'http_mp3_0_0',
  acodec: 'mp3',
  abrKbps: 128,
  durationSec: 9.927,
  title: "Youtube - Dl Test Video '' A\u{308}\u{21ad}",
  track: "Youtube - Dl Test Video '' A\u{308}\u{21ad}",
  uploader: 'jaimeMF',
  webpageUrl: SOUNDCLOUD_SECRET,
  extractorKey: 'Soundcloud',
  thumbnailPath: '/jobs/x/123998367.png',
  thumbnailUrl: 'https://a1.sndcdn.com/images/default_avatar_large.png',
}
const soundcloudDone: DoneInfo = {
  id: '47127631',
  filepath: '/jobs/x/47127631.m4a',
  ext: 'm4a',
  formatId: 'hls_aac_160k',
  acodec: 'mp4a.40.2',
  abrKbps: 160,
  durationSec: 221.872,
  title: 'Knocked Up',
  track: 'Knocked Up',
  uploader: 'The Royal Concept',
  webpageUrl: SOUNDCLOUD,
  extractorKey: 'Soundcloud',
  thumbnailPath: '/jobs/x/47127631.jpg',
  thumbnailUrl: 'https://i1.sndcdn.com/artworks-000043574646-iq6flj-original.jpg',
}

describe('cleanTagValue', () => {
  it.each([
    ['Me at the zoo', 'Me at the zoo'],
    ['  Line1\nLine2\r\nLine3\tTab  ', 'Line1 Line2 Line3 Tab'],
    ['NUL\u{0}inside', 'NUL inside'],
    ['DEL\u{7f}here', 'DEL here'],
    ['Beyoncé & 東京 — Ñandú', 'Beyoncé & 東京 — Ñandú'],
    ['quotes "x" \\ ; # = /', 'quotes "x" \\ ; # = /'],
    ['lone \u{d83c} surrogate', 'lone \u{fffd} surrogate'],
  ])('%j → %j', (value, expected) => {
    expect(cleanTagValue(value)).toBe(expected)
  })

  it.each([undefined, '', '   ', '\n\t\u{0}'])('drops %j', (value) => {
    expect(cleanTagValue(value)).toBeUndefined()
  })

  it('cuts to 1000 units without splitting a surrogate pair', () => {
    expect(cleanTagValue('a'.repeat(1500))).toBe('a'.repeat(MAX_TAG_LENGTH))
    const emoji = cleanTagValue(`${'a'.repeat(MAX_TAG_LENGTH - 1)}🎧🎧`)
    expect(emoji).toBe('a'.repeat(MAX_TAG_LENGTH - 1))
    expect(emoji?.isWellFormed()).toBe(true)
  })
})

describe('releaseYear', () => {
  it.each([
    [2024, undefined, '2024'],
    [2024, '19990101', '2024'],
    [undefined, '20240506', '2024'],
    [99, '20240506', '2024'],
    [99, undefined, undefined],
    [20240, undefined, undefined],
    [undefined, '00000000', undefined],
    [undefined, undefined, undefined],
  ])('release_year %j, release_date %j → %j', (year, date, expected) => {
    expect(releaseYear(year, date)).toBe(expected)
  })
})

describe('commentUrl', () => {
  // D2: the track's own public page, and nothing that could leak a secret.
  it.each([
    ['a public YouTube video', YOUTUBE, { webpageUrl: YOUTUBE, availability: 'public' }, YOUTUBE],
    [
      'a YouTube video pasted as a short link',
      'https://youtu.be/jNQXAC9IVRw?si=tracking',
      { webpageUrl: YOUTUBE, availability: 'public' },
      YOUTUBE,
    ],
    [
      'a public SoundCloud track (no availability)',
      SOUNDCLOUD,
      { webpageUrl: SOUNDCLOUD },
      SOUNDCLOUD,
    ],
    [
      'a SoundCloud row listed as an api-v2 URL',
      'https://api-v2.soundcloud.com/tracks/47127631',
      { webpageUrl: SOUNDCLOUD },
      SOUNDCLOUD,
    ],
  ])('writes it for %s', (_label, input, done, expected) => {
    const classified = valid(input)
    expect(commentUrl(done, classified, classified.platform)).toBe(expected)
  })

  it.each([
    ['a YouTube video without availability', YOUTUBE, { webpageUrl: YOUTUBE }],
    ['an unlisted YouTube video', YOUTUBE, { webpageUrl: YOUTUBE, availability: 'unlisted' }],
    ['a members-only video', YOUTUBE, { webpageUrl: YOUTUBE, availability: 'subscriber_only' }],
    ['a secret SoundCloud permalink', SOUNDCLOUD_SECRET, { webpageUrl: SOUNDCLOUD_SECRET }],
    [
      'a secret track behind a public-looking input',
      'https://soundcloud.com/jaimemf/youtube-dl-test-video-a-y-baw',
      { webpageUrl: SOUNDCLOUD_SECRET },
    ],
    [
      'a SoundCloud short link (it may hide a secret track)',
      'https://on.soundcloud.com/AbCdEf',
      { webpageUrl: SOUNDCLOUD },
    ],
    [
      'an api-v2 row of a secret set',
      'https://api-v2.soundcloud.com/tracks/47127631?secret_token=s-AbCdE',
      { webpageUrl: SOUNDCLOUD },
    ],
    ['a private SoundCloud track', SOUNDCLOUD, { webpageUrl: SOUNDCLOUD, availability: 'private' }],
    [
      'another platform, with a query',
      'https://example.com/track.mp3?token=abc',
      { webpageUrl: 'https://example.com/track.mp3?token=abc', availability: 'public' },
    ],
    [
      'a page on another platform than the input',
      YOUTUBE,
      { webpageUrl: SOUNDCLOUD, availability: 'public' },
    ],
    ['no webpage_url', YOUTUBE, { availability: 'public' }],
    ['a webpage_url that is no URL', YOUTUBE, { webpageUrl: 'not a url', availability: 'public' }],
  ])('writes none for %s', (_label, input, done) => {
    const classified = valid(input)
    expect(commentUrl(done, classified, classified.platform)).toBeUndefined()
  })

  it('never falls back to the input URL', () => {
    expect(commentUrl({ availability: 'public' }, valid(YOUTUBE), 'youtube')).toBeUndefined()
  })
})

describe('describeTrack', () => {
  const context = (url: string, sourceUrlComment = true) => {
    const input = valid(url)
    return { platform: input.platform, input, sourceUrlComment }
  }

  it('YouTube: the title stays whole, the uploader is the artist, the page is the comment', () => {
    expect(describeTrack(youtubeDone, context(YOUTUBE))).toEqual({
      tags: { title: 'Me at the zoo', artist: 'jawed', comment: YOUTUBE },
      fields: {
        artist: 'jawed',
        title: 'Me at the zoo',
        uploader: 'jawed',
        id: 'jNQXAC9IVRw',
        platform: 'youtube',
      },
      display: { title: 'Me at the zoo' },
    })
  })

  it('SoundCloud: "Artist - Title" is split; a secret link gets no comment', () => {
    const { tags, display } = describeTrack(soundcloudSecretDone, context(SOUNDCLOUD_SECRET))
    expect(tags).toEqual({ title: "Dl Test Video '' A\u{308}\u{21ad}", artist: 'Youtube' })
    expect(display).toEqual({ title: "Dl Test Video '' A\u{308}\u{21ad}", artist: 'Youtube' })
  })

  it('SoundCloud: a public permalink is the comment', () => {
    expect(describeTrack(soundcloudDone, context(SOUNDCLOUD)).tags).toEqual({
      title: 'Knocked Up',
      artist: 'The Royal Concept',
      comment: SOUNDCLOUD,
    })
  })

  it('writes no comment when the user turned it off', () => {
    expect(describeTrack(youtubeDone, context(YOUTUBE, false)).tags.comment).toBeUndefined()
  })

  it('takes platform metadata first, and album and year only from release fields', () => {
    const done: DoneInfo = {
      ...youtubeDone,
      title: 'Bicep - Glue (Official Video)',
      track: 'Glue',
      artist: 'Bicep',
      artists: ['Bicep', 'Someone'],
      uploader: 'Bicep - Topic',
      album: 'Bicep',
      albumArtist: 'Bicep',
      releaseYear: 2017,
      releaseDate: '20170901',
    }
    expect(describeTrack(done, context(YOUTUBE)).tags).toEqual({
      title: 'Glue',
      artist: 'Bicep',
      album: 'Bicep',
      albumArtist: 'Bicep',
      year: '2017',
      comment: YOUTUBE,
    })
    const fromArtists = describeTrack(
      { ...done, artist: undefined, releaseYear: undefined },
      context(YOUTUBE),
    )
    expect(fromArtists.tags.artist).toBe('Bicep')
    expect(fromArtists.tags.year).toBe('2017')
  })

  it('falls back to the uploader without " - Topic", then the channel', () => {
    const topic = describeTrack(
      { ...youtubeDone, title: 'Glue', uploader: 'Bicep - Topic', channel: 'Bicep - Topic' },
      context(YOUTUBE),
    )
    expect(topic.tags.artist).toBe('Bicep')
    expect(topic.fields.uploader).toBe('Bicep - Topic')
    expect(topic.display).toEqual({ title: 'Glue' })
    const channel = describeTrack(
      { ...youtubeDone, uploader: undefined, channel: 'jawed' },
      context(YOUTUBE),
    )
    expect(channel.tags.artist).toBe('jawed')
  })

  it('cleans every value before splitting and tagging', () => {
    const { tags } = describeTrack(
      { ...soundcloudDone, title: ' Artist\n -  Title\u{0} ', track: undefined, uploader: '  ' },
      context(SOUNDCLOUD),
    )
    expect(tags.title).toBe('Title')
    expect(tags.artist).toBe('Artist')
  })

  it('has no artist when nothing names one', () => {
    const { tags, fields } = describeTrack(
      { id: 'abc', filepath: '/jobs/x/abc.mp3', title: 'Untitled Jam' },
      context('https://example.com/abc.mp3'),
    )
    expect(tags).toEqual({ title: 'Untitled Jam' })
    expect(fields).toEqual({ title: 'Untitled Jam', id: 'abc', platform: 'other' })
  })
})

describe('finalFileName', () => {
  const fields = describeTrack(youtubeDone, {
    platform: 'youtube',
    input: valid(YOUTUBE),
    sourceUrlComment: true,
  }).fields

  it.each([
    ['{artist} - {title}', 'mp3', 'jawed - Me at the zoo.mp3'],
    ['{title} [{id}]', 'm4a', 'Me at the zoo [jNQXAC9IVRw].m4a'],
    ['{artist} - {title} ({year})', 'aiff', 'jawed - Me at the zoo.aiff'],
    ['{platform}-{id}', 'flac', 'youtube-jNQXAC9IVRw.flac'],
  ])('%s → %j', (template, ext, expected) => {
    expect(finalFileName(template, fields, ext, { platform: 'youtube', id: 'jNQXAC9IVRw' })).toBe(
      expected,
    )
  })

  it('falls back to <platform>-<id> when the template renders nothing', () => {
    expect(finalFileName('{album}{title}', {}, 'mp3', { platform: 'soundcloud', id: '123' })).toBe(
      'soundcloud-123.mp3',
    )
  })

  it('fits the bytes the folder leaves: a CJK title is cut at 3 bytes a character', () => {
    const cjk = { artist: '東京', title: '夜'.repeat(200) }
    const fallback = { platform: 'youtube', id: 'jNQXAC9IVRw' } as const
    const unlimited = finalFileName('{artist} - {title}', cjk, 'mp3', fallback)
    expect(Buffer.byteLength(unlimited)).toBe(526)
    const name = finalFileName('{artist} - {title}', cjk, 'mp3', fallback, 300)
    expect(Buffer.byteLength(name)).toBeLessThanOrEqual(300)
    expect(name).toBe(`東京 - ${'夜'.repeat(95)}.mp3`)
  })
})

describe('ffprobeArgs', () => {
  it('asks for the D15 entries as JSON, local files only, the file last', () => {
    expect(ffprobeArgs('/data/jobs/a/b.webm')).toEqual([
      '-hide_banner',
      '-v',
      'error',
      '-protocol_whitelist',
      'file',
      '-show_entries',
      'format=format_name,duration,bit_rate:format_tags:stream=index,codec_type,codec_name,sample_rate,channels,bit_rate:stream_tags:stream_disposition=attached_pic',
      '-of',
      'json',
      '-i',
      '/data/jobs/a/b.webm',
    ])
    // The same entries the fixtures were recorded with (test/fixtures/ffprobe/README.md).
    expect(readFileSync(path.join(FFPROBE_DIR, 'README.md'), 'utf8')).toContain(
      `-show_entries ${PROBE_ENTRIES} -of json`,
    )
  })
})

/** What each recorded ffprobe output parses to; every fixture must be listed. */
const PROBES: Record<string, Partial<Probe> & { audio?: Probe['audio'] }> = {
  'cover-soundcloud-jpg': { formatNames: ['image2'], durationSec: 0.04, bitRate: 34244200 },
  'cover-youtube-webp': { formatNames: ['image2'], durationSec: 0.04, bitRate: 8285600 },
  'out-aiff': {
    formatNames: ['aiff'],
    durationSec: 19.005542,
    tags: {},
    audio: {
      index: 0,
      type: 'audio',
      codec: 'pcm_s16be',
      sampleRateHz: 48000,
      channels: 2,
      bitRate: 1536000,
      attachedPic: false,
      tags: {},
    },
  },
  'out-flac': {
    formatNames: ['flac'],
    durationSec: 19.005542,
    tags: { title: 'Me at the zoo', artist: 'jawed', comment: YOUTUBE, encoder: 'Lavf62.3.100' },
  },
  'out-m4a-copy': {
    formatNames: ['mov', 'mp4', 'm4a', '3gp', '3g2', 'mj2'],
    durationSec: 19.063583,
  },
  'out-m4a-copy-soundcloud': { durationSec: 221.872063 },
  'out-m4a-encode': { durationSec: 9.873991 },
  'out-mp3-copy': { formatNames: ['mp3'], durationSec: 9.873991, tags: {} },
  'out-mp3-encode': { formatNames: ['mp3'], durationSec: 19.005542 },
  'out-mp3-encode-truncated': { formatNames: ['mp3'], durationSec: 4.8335 },
  'out-original-webm': {
    formatNames: ['matroska', 'webm'],
    durationSec: 19.028,
    tags: { title: 'Me at the zoo', comment: YOUTUBE, artist: 'jawed', encoder: 'Lavf62.3.100' },
  },
  'out-wav': { formatNames: ['wav'], durationSec: 19.005542 },
  'src-soundcloud-hls-aac-m4a': { durationSec: 221.872063, bitRate: 161422 },
  'src-soundcloud-mp3': { formatNames: ['mp3'], durationSec: 9.873991 },
  'src-youtube-140-m4a': { durationSec: 19.063583 },
  'src-youtube-251-webm': {
    formatNames: ['matroska', 'webm'],
    durationSec: 19.021,
    bitRate: 106064,
    audio: {
      index: 0,
      type: 'audio',
      codec: 'opus',
      sampleRateHz: 48000,
      channels: 2,
      attachedPic: false,
      tags: { language: 'eng' },
    },
  },
  'src-youtube-251-webm-part': { durationSec: 19.021, bitRate: 27132 },
  // 600 s of audio: the duration is ffprobe's estimate from the first frame (no Xing header).
  'src-mp3-vbr-noxing': {
    formatNames: ['mp3'],
    durationSec: 2413.40375,
    bitRate: 32000,
    audio: {
      index: 0,
      type: 'audio',
      codec: 'mp3',
      sampleRateHz: 44100,
      channels: 2,
      bitRate: 32000,
      attachedPic: false,
      tags: {},
    },
  },
}

describe('parseProbe', () => {
  const fixtures = readdirSync(FFPROBE_DIR)
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -'.json'.length))

  it('has an expectation for every recorded ffprobe fixture', () => {
    expect(fixtures.sort()).toEqual(Object.keys(PROBES).sort())
  })

  it.each(fixtures)('parses %s', (name) => {
    expect(probeFixture(name)).toMatchObject(PROBES[name] ?? {})
  })

  it('finds the audio stream and the attached cover', () => {
    const m4a = probeFixture('out-m4a-copy')
    expect(m4a.audio).toMatchObject({ codec: 'aac', bitRate: 127999, sampleRateHz: 44100 })
    expect(m4a.streams.map((stream) => [stream.type, stream.attachedPic])).toEqual([
      ['audio', false],
      ['video', true],
    ])
    const cover = probeFixture('cover-youtube-webp')
    expect(cover.audio).toBeUndefined()
    expect(cover.streams).toEqual([
      { index: 0, type: 'video', codec: 'mjpeg', attachedPic: false, tags: {} },
    ])
  })

  it('lower-cases tag keys (WebM reads back ARTIST and COMMENT)', () => {
    const webm = probeFixture('out-original-webm')
    expect(webm.tags.artist).toBe('jawed')
    expect(webm.audio?.tags).toEqual({ duration: '00:00:19.028000000' })
  })

  it.each([
    ['not JSON', 'Error opening input file'],
    ['an empty string', ''],
    ['an array', '[]'],
    ['a number', '1'],
    ['null', 'null'],
  ])('refuses %s', (_label, stdout) => {
    expect(parseProbe(stdout)).toBeUndefined()
  })

  it('tolerates missing sections and odd values', () => {
    expect(parseProbe('{}')).toEqual({ formatNames: [], tags: {}, streams: [] })
    const odd = parseProbe(
      JSON.stringify({
        streams: [
          null,
          {
            index: 0,
            codec_type: 'audio',
            codec_name: 'mp3',
            sample_rate: 'N/A',
            channels: 0,
            bit_rate: '-5',
            disposition: 'x',
            tags: { TITLE: 'T', title: 'ignored', n: 5 },
          },
        ],
        format: { duration: 'N/A', bit_rate: 12, tags: [] },
      }),
    )
    expect(odd).toEqual({
      formatNames: [],
      bitRate: 12,
      tags: {},
      streams: [
        { index: 0, type: 'audio', codec: 'mp3', attachedPic: false, tags: { title: 'T' } },
      ],
      audio: { index: 0, type: 'audio', codec: 'mp3', attachedPic: false, tags: { title: 'T' } },
    })
  })
})

const copy = ['-c:a', 'copy']
const lame = ['-c:a', 'libmp3lame', '-b:a', '320k']
const aac = ['-c:a', 'aac', '-b:a', '256k']
const flac = ['-c:a', 'flac', '-sample_fmt', 's16']

describe('planAudio', () => {
  // D14 against the recorded sources: [fixture, format, muxer, ext, codec args, encoded]
  it.each([
    ['src-youtube-251-webm', 'mp3', 'mp3', 'mp3', lame, true],
    ['src-youtube-251-webm', 'm4a', 'ipod', 'm4a', aac, true],
    ['src-youtube-251-webm', 'flac', 'flac', 'flac', flac, true],
    ['src-youtube-251-webm', 'wav', 'wav', 'wav', ['-c:a', 'pcm_s16le'], true],
    ['src-youtube-251-webm', 'aiff', 'aiff', 'aiff', ['-c:a', 'pcm_s16be'], true],
    ['src-youtube-251-webm', 'original', 'webm', 'webm', copy, false],
    ['src-youtube-140-m4a', 'mp3', 'mp3', 'mp3', lame, true],
    ['src-youtube-140-m4a', 'm4a', 'ipod', 'm4a', copy, false],
    ['src-youtube-140-m4a', 'original', 'ipod', 'm4a', copy, false],
    ['src-soundcloud-mp3', 'mp3', 'mp3', 'mp3', copy, false],
    ['src-soundcloud-mp3', 'm4a', 'ipod', 'm4a', aac, true],
    ['src-soundcloud-mp3', 'original', 'mp3', 'mp3', copy, false],
    ['src-soundcloud-hls-aac-m4a', 'm4a', 'ipod', 'm4a', copy, false],
    ['src-soundcloud-hls-aac-m4a', 'aiff', 'aiff', 'aiff', ['-c:a', 'pcm_s16be'], true],
  ] as const)('%s → %s: %s/.%s', (fixture, format, muxer, ext, codecArgs, encoded) => {
    const plan = planAudio(format, probeFixture(fixture))
    expect(plan).toMatchObject({ muxer, ext, codecArgs, encoded, downmix: false })
  })

  it('names the codec ffprobe must read back and where tags and the cover go', () => {
    const webm = probeFixture('src-youtube-251-webm')
    const summary = (format: DownloadFormat) => {
      const { codec, tags, cover } = planAudio(format, webm)
      return { codec, tags, cover }
    }
    expect(summary('mp3')).toEqual({ codec: 'mp3', tags: 'id3', cover: 'id3' })
    expect(summary('m4a')).toEqual({ codec: 'aac', tags: 'ffmpeg', cover: 'ffmpeg' })
    expect(summary('flac')).toEqual({ codec: 'flac', tags: 'ffmpeg', cover: 'ffmpeg' })
    expect(summary('wav')).toEqual({ codec: 'pcm_s16le', tags: 'ffmpeg', cover: 'none' })
    expect(summary('aiff')).toEqual({ codec: 'pcm_s16be', tags: 'id3', cover: 'id3' })
    expect(summary('original')).toEqual({ codec: 'opus', tags: 'ffmpeg', cover: 'none' })
  })

  it('copies a source already in the target codec (PCM and FLAC too)', () => {
    const wav = sourceProbe({ codec: 'pcm_s16le', channels: 2 }, ['wav'])
    expect(planAudio('wav', wav)).toMatchObject({ codecArgs: copy, encoded: false })
    const aiff = sourceProbe({ codec: 'pcm_s16be', channels: 1 }, ['aiff'])
    expect(planAudio('aiff', aiff)).toMatchObject({ codecArgs: copy, encoded: false })
    const lossless = sourceProbe({ codec: 'flac', channels: 2 }, ['flac'])
    expect(planAudio('flac', lossless)).toMatchObject({ codecArgs: copy, encoded: false })
  })

  it('mixes more than two channels down to stereo, which forces an encode', () => {
    const surround = sourceProbe({ codec: 'aac', channels: 6 }, ['mov', 'mp4'])
    expect(planAudio('m4a', surround)).toMatchObject({
      codecArgs: aac,
      encoded: true,
      downmix: true,
    })
    expect(planAudio('mp3', surround)).toMatchObject({ codecArgs: lame, downmix: true })
    const pcm = sourceProbe({ codec: 'pcm_s16le', channels: 6 }, ['wav'])
    expect(planAudio('wav', pcm)).toMatchObject({ encoded: true, downmix: true })
    // "Original" keeps the stream as it is.
    expect(planAudio('original', surround)).toMatchObject({ muxer: 'ipod', downmix: false })
  })

  it.each([
    [['matroska', 'webm'], 'opus', 'webm'],
    [['matroska', 'webm'], 'vorbis', 'webm'],
    [['mov', 'mp4', 'm4a', '3gp', '3g2', 'mj2'], 'aac', 'ipod'],
    [['mp3'], 'mp3', 'mp3'],
    [['ogg'], 'opus', 'opus'],
    [['ogg'], 'vorbis', 'ogg'],
    [['flac'], 'flac', 'flac'],
    [['ogg'], 'flac', 'flac'],
    [['mpegts'], 'aac', 'ipod'],
    [['mpegts'], 'mp3', 'mp3'],
    [['mov', 'mp4'], 'opus', 'webm'],
    [['matroska', 'webm'], 'aac', 'ipod'],
    [['mov', 'mp4'], 'vorbis', 'ogg'],
  ])('keeps the original %j + %s in %s', (formatNames, codec, muxer) => {
    expect(originalMuxer(formatNames, codec)).toBe(muxer)
  })

  it.each([
    ['ALAC', ['mov', 'mp4'], 'alac'],
    ['PCM in WAV', ['wav'], 'pcm_s16le'],
    ['an unknown codec', ['matroska', 'webm'], 'wmav2'],
  ])('refuses to keep %s as the original', (_label, formatNames, codec) => {
    expect(() => planAudio('original', sourceProbe({ codec }, formatNames))).toThrow(
      expect.objectContaining({ code: 'postprocess_failed' }),
    )
  })

  it('refuses a download without audio', () => {
    const video = sourceProbe({ codec: 'h264' }, ['mov', 'mp4'])
    video.streams = [{ index: 0, type: 'video', codec: 'h264', attachedPic: false, tags: {} }]
    delete video.audio
    expect(() => planAudio('mp3', video)).toThrow(StepError)
    expect(() => planAudio('mp3', video)).toThrow('The download has no audio.')
  })

  it.each(['hls', 'concat', 'dash', 'image2'])(
    'refuses an input read by the %s demuxer',
    (demuxer) => {
      expect(() => planAudio('mp3', sourceProbe({ codec: 'aac' }, [demuxer]))).toThrow(
        "The download isn't an audio file.",
      )
    },
  )

  it('decodes with -xerror, except an MP3 source (mid-stream junk is skipped, ADR-015)', () => {
    const webm = probeFixture('src-youtube-251-webm')
    const mp3 = probeFixture('src-soundcloud-mp3')
    for (const format of ['mp3', 'm4a', 'flac', 'wav', 'aiff'] as const) {
      expect(planAudio(format, webm).xerror, format).toBe(true)
    }
    for (const format of ['m4a', 'flac', 'wav', 'aiff'] as const) {
      expect(planAudio(format, mp3), format).toMatchObject({ encoded: true, xerror: false })
    }
    // Copies decode nothing.
    expect(planAudio('mp3', mp3)).toMatchObject({ encoded: false, xerror: false })
    expect(planAudio('original', webm)).toMatchObject({ encoded: false, xerror: false })
    expect(planAudio('m4a', probeFixture('src-youtube-140-m4a')).xerror).toBe(false)
    // A surround MP3 mixed down is still an MP3 source.
    const surround = sourceProbe({ codec: 'mp3', channels: 6 }, ['mp3'])
    expect(planAudio('mp3', surround)).toMatchObject({ encoded: true, xerror: false })
  })

  it('refuses WAV and AIFF that would reach 4 GiB, before converting', () => {
    // 48 kHz stereo 16-bit: 192,000 bytes a second; 2^32 bytes is 22,369.6 s.
    const limit = 2 ** 32 / 192_000
    const long = sourceProbe({ codec: 'opus', channels: 2, sampleRateHz: 48000 }, ['webm'], limit)
    const fits = sourceProbe(
      { codec: 'opus', channels: 2, sampleRateHz: 48000 },
      ['webm'],
      limit - 1,
    )
    for (const format of ['wav', 'aiff'] as const) {
      expect(() => planAudio(format, long)).toThrow(
        expect.objectContaining({ code: 'postprocess_failed' }),
      )
      expect(planAudio(format, fits).muxer).toBe(format)
    }
    expect(planAudio('flac', long).muxer).toBe('flac')
    // Mixed down to stereo first: 6 channels count as 2.
    const surround = sourceProbe(
      { codec: 'aac', channels: 6, sampleRateHz: 48000 },
      ['mp4'],
      limit - 1,
    )
    expect(planAudio('aiff', surround).downmix).toBe(true)
  })
})

describe('canHoldCover', () => {
  const formats = DownloadFormatSchema.options
  const platforms = ['youtube', 'soundcloud', 'other'] as const

  it.each(
    formats.flatMap((format) =>
      platforms.map((platform) => ({
        format,
        platform,
        expected: format !== 'wav' && !(format === 'original' && platform === 'youtube'),
      })),
    ),
  )('fetches a cover for $format on $platform: $expected', ({ format, platform, expected }) => {
    expect(canHoldCover(format, platform)).toBe(expected)
  })

  it('agrees with the plan for every converted format, whatever the source', () => {
    for (const fixture of ['src-youtube-251-webm', 'src-soundcloud-mp3']) {
      for (const format of formats.filter((name) => name !== 'original')) {
        const planned = planAudio(format, probeFixture(fixture)).cover !== 'none'
        expect(canHoldCover(format, 'youtube'), `${fixture} → ${format}`).toBe(planned)
      }
    }
  })

  it('matches what "original" makes of the recorded sources', () => {
    // YouTube's best audio is Opus 251, kept in WebM: no cover to fetch.
    expect(planAudio('original', probeFixture('src-youtube-251-webm')).cover).toBe('none')
    expect(canHoldCover('original', 'youtube')).toBe(false)
    // SoundCloud's is MP3 or AAC (its Opus only when nothing else exists): the cover goes in.
    expect(planAudio('original', probeFixture('src-soundcloud-mp3')).cover).toBe('id3')
    expect(planAudio('original', probeFixture('src-soundcloud-hls-aac-m4a')).cover).toBe('ffmpeg')
    expect(canHoldCover('original', 'soundcloud')).toBe(true)
  })
})

describe('coverArgs', () => {
  it('makes a baseline JPEG of at most 1000 px (the recorded cover argv)', () => {
    expect(coverArgs('/j/jNQXAC9IVRw.webp', 'webp_pipe', '/j/finalize/cover.jpg')).toEqual([
      ...FFMPEG_HEAD,
      '-xerror',
      '-protocol_whitelist',
      'file',
      '-f',
      'webp_pipe',
      '-i',
      '/j/jNQXAC9IVRw.webp',
      '-map',
      '0:v:0',
      '-frames:v',
      '1',
      '-vf',
      COVER_SCALE,
      '-c:v',
      'mjpeg',
      '-q:v',
      '2',
      '-pix_fmt',
      'yuvj420p',
      '-f',
      'image2',
      '-update',
      '1',
      '/j/finalize/cover.jpg',
    ])
    expect(FFMPEG_HEAD).toEqual(['-hide_banner', '-nostdin', '-loglevel', 'error', '-n'])
  })
})

describe('audioArgs', () => {
  const webm = probeFixture('src-youtube-251-webm')
  const m4a = probeFixture('src-youtube-140-m4a')
  const ytTags: Tags = { title: 'Me at the zoo', artist: 'jawed', comment: YOUTUBE }
  const head = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-n']
  const input = (file: string) => ['-protocol_whitelist', 'file', '-i', file]
  const coverInput = [
    '-protocol_whitelist',
    'file',
    '-f',
    'jpeg_pipe',
    '-i',
    '/j/finalize/cover.jpg',
  ]
  const picture = [
    '-c:v',
    'copy',
    '-disposition:v:0',
    'attached_pic',
    '-metadata:s:v:0',
    'title=Album cover',
    '-metadata:s:v:0',
    'comment=Cover (front)',
  ]
  const noSourceTags = ['-map_metadata', '-1', '-map_chapters', '-1']
  const ytMetadata = [
    '-metadata',
    'title=Me at the zoo',
    '-metadata',
    'artist=jawed',
    '-metadata',
    `comment=${YOUTUBE}`,
  ]
  const pass = (plan: AudioPlan, source: string, cover?: string) =>
    audioArgs({ plan, input: source, output: `/j/finalize/out.${plan.ext}`, tags: ytTags, cover })

  it('MP3 encode: no tags from ffmpeg at all (ours follow), -xerror', () => {
    expect(pass(planAudio('mp3', webm), '/j/a.webm', '/j/finalize/cover.jpg')).toEqual([
      ...head,
      '-xerror',
      ...input('/j/a.webm'),
      '-map',
      '0:a:0',
      '-c:a',
      'libmp3lame',
      '-b:a',
      '320k',
      ...noSourceTags,
      '-id3v2_version',
      '0',
      '-write_id3v1',
      '0',
      '-f',
      'mp3',
      '/j/finalize/out.mp3',
    ])
  })

  it('MP3 copy: no -xerror (nothing is decoded)', () => {
    const plan = planAudio('mp3', probeFixture('src-soundcloud-mp3'))
    expect(pass(plan, '/j/a.mp3')).toEqual([
      ...head,
      ...input('/j/a.mp3'),
      '-map',
      '0:a:0',
      '-c:a',
      'copy',
      ...noSourceTags,
      '-id3v2_version',
      '0',
      '-write_id3v1',
      '0',
      '-f',
      'mp3',
      '/j/finalize/out.mp3',
    ])
  })

  it('M4A copy with a cover and tags (the recorded out-m4a-copy argv)', () => {
    expect(pass(planAudio('m4a', m4a), '/j/a.m4a', '/j/finalize/cover.jpg')).toEqual([
      ...head,
      ...input('/j/a.m4a'),
      ...coverInput,
      '-map',
      '0:a:0',
      '-map',
      '1:v:0',
      '-c:a',
      'copy',
      ...picture,
      ...noSourceTags,
      ...ytMetadata,
      '-movflags',
      '+faststart',
      '-f',
      'ipod',
      '/j/finalize/out.m4a',
    ])
  })

  it('FLAC encode with a cover: 16-bit, -xerror', () => {
    expect(pass(planAudio('flac', webm), '/j/a.webm', '/j/finalize/cover.jpg')).toEqual([
      ...head,
      '-xerror',
      ...input('/j/a.webm'),
      ...coverInput,
      '-map',
      '0:a:0',
      '-map',
      '1:v:0',
      '-c:a',
      'flac',
      '-sample_fmt',
      's16',
      ...picture,
      ...noSourceTags,
      ...ytMetadata,
      '-f',
      'flac',
      '/j/finalize/out.flac',
    ])
  })

  it('WAV: tags from ffmpeg, never a cover', () => {
    expect(pass(planAudio('wav', webm), '/j/a.webm', '/j/finalize/cover.jpg')).toEqual([
      ...head,
      '-xerror',
      ...input('/j/a.webm'),
      '-map',
      '0:a:0',
      '-c:a',
      'pcm_s16le',
      ...noSourceTags,
      ...ytMetadata,
      '-f',
      'wav',
      '/j/finalize/out.wav',
    ])
  })

  it('AIFF: no ID3 chunk from ffmpeg (ours follows), the cover goes in our tag', () => {
    expect(pass(planAudio('aiff', webm), '/j/a.webm', '/j/finalize/cover.jpg')).toEqual([
      ...head,
      '-xerror',
      ...input('/j/a.webm'),
      '-map',
      '0:a:0',
      '-c:a',
      'pcm_s16be',
      ...noSourceTags,
      '-write_id3v2',
      '0',
      '-f',
      'aiff',
      '/j/finalize/out.aiff',
    ])
  })

  it('original WebM: copied, tagged by ffmpeg', () => {
    expect(pass(planAudio('original', webm), '/j/a.webm')).toEqual([
      ...head,
      ...input('/j/a.webm'),
      '-map',
      '0:a:0',
      '-c:a',
      'copy',
      ...noSourceTags,
      ...ytMetadata,
      '-f',
      'webm',
      '/j/finalize/out.webm',
    ])
  })

  it('mixes down after the codec, and writes every tag ffmpeg knows', () => {
    const surround = sourceProbe({ codec: 'aac', channels: 6 }, ['mp4'])
    const args = audioArgs({
      plan: planAudio('m4a', surround),
      input: '/j/a.mp4',
      output: '/j/finalize/out.m4a',
      tags: {
        title: 'T = "x"',
        artist: 'Beyoncé & 東京',
        album: 'LP',
        albumArtist: 'Various',
        year: '2024',
        comment: SOUNDCLOUD,
      },
    })
    expect(args).toEqual([
      ...head,
      '-xerror',
      ...input('/j/a.mp4'),
      '-map',
      '0:a:0',
      ...aac,
      '-ac',
      '2',
      ...noSourceTags,
      '-metadata',
      'title=T = "x"',
      '-metadata',
      'artist=Beyoncé & 東京',
      '-metadata',
      'album=LP',
      '-metadata',
      'album_artist=Various',
      '-metadata',
      'date=2024',
      '-metadata',
      `comment=${SOUNDCLOUD}`,
      '-movflags',
      '+faststart',
      '-f',
      'ipod',
      '/j/finalize/out.m4a',
    ])
  })

  it.each(['m4a', 'flac', 'wav', 'aiff'] as const)(
    'passes no -xerror when it decodes an MP3 (%s): a stitched MP3 would fail',
    (format) => {
      const plan = planAudio(format, probeFixture('src-soundcloud-mp3'))
      const args = pass(plan, '/j/a.mp3', '/j/finalize/cover.jpg')
      expect(args).toEqual(expect.arrayContaining(plan.codecArgs))
      expect(args).not.toContain('-xerror')
    },
  )

  it.each(['mp3', 'm4a', 'flac', 'wav', 'aiff', 'original'] as const)(
    'never passes -vn (%s): it drops a mapped cover',
    (format) => {
      const args = pass(planAudio(format, webm), '/j/a.webm', '/j/finalize/cover.jpg')
      expect(args).not.toContain('-vn')
      expect(args.at(-3)).toBe('-f')
    },
  )
})

describe("an MP3's measured duration", () => {
  it('measures MP3s only: their duration can be an estimate', () => {
    expect(needsMeasuredDuration(probeFixture('src-mp3-vbr-noxing'))).toBe(true)
    expect(needsMeasuredDuration(probeFixture('src-soundcloud-mp3'))).toBe(true)
    expect(needsMeasuredDuration(probeFixture('src-youtube-251-webm'))).toBe(false)
    expect(needsMeasuredDuration(probeFixture('src-youtube-140-m4a'))).toBe(false)
  })

  it('copies the first audio stream to the null muxer, reporting progress on stdout', () => {
    expect(measureArgs('/j/a.mp3')).toEqual([
      ...FFMPEG_HEAD,
      '-nostats',
      '-progress',
      'pipe:1',
      '-protocol_whitelist',
      'file',
      '-i',
      '/j/a.mp3',
      '-map',
      '0:a:0',
      '-c:a',
      'copy',
      '-f',
      'null',
      '-',
    ])
    expect(measureArgs('/j/a.mp3')).not.toContain('-xerror')
  })

  // ffmpeg 8.0's stdout for src-mp3-vbr-noxing with measureArgs (recorded 2026-10-03).
  const REPORT =
    'bitrate=N/A\ntotal_size=N/A\nout_time_us=600032653\nout_time_ms=600032653\nout_time=00:10:00.032653\ndup_frames=0\ndrop_frames=0\nspeed=9.42e+03x\nprogress=end\n'

  it('reads the last out_time_us of a finished report', () => {
    expect(parseMeasuredDuration(REPORT)).toBe(600.032653)
    const twoBlocks = REPORT.replace('progress=end', 'progress=continue').replaceAll('\n', '\r\n')
    expect(
      parseMeasuredDuration(`${twoBlocks}${REPORT.replaceAll('600032653', '700000000')}`),
    ).toBe(700)
  })

  it.each([
    ['an unfinished report', REPORT.replace('progress=end', 'progress=continue')],
    ['no out_time_us', 'progress=end\n'],
    ['N/A', REPORT.replace('out_time_us=600032653', 'out_time_us=N/A')],
    ['zero', REPORT.replace('out_time_us=600032653', 'out_time_us=0')],
    ['a negative time', REPORT.replace('out_time_us=600032653', 'out_time_us=-5')],
    ['nothing', ''],
  ])('reads nothing from %s', (_label, stdout) => {
    expect(parseMeasuredDuration(stdout)).toBeUndefined()
  })

  it("is what the checks need: the estimate fails a complete file, the measured length doesn't", () => {
    const estimated = probeFixture('src-mp3-vbr-noxing')
    const measured: Probe = { ...estimated, durationSec: 600.032653 }
    expect(downloadProblem(estimated, 600)).toBe('The download is incomplete. Try again.')
    expect(downloadProblem(measured, 600)).toBeUndefined()
    // ffmpeg writes a Xing header, so the output probes exactly.
    const output: Probe = { ...probeFixture('out-m4a-encode'), durationSec: 600.0464 }
    const plan = planAudio('m4a', measured)
    const check = { output, tags: {}, coverPlanned: false }
    expect(outputProblem(plan, { ...check, source: estimated })).toBe(
      'The converted file is incomplete: the download may be damaged. Try again.',
    )
    expect(outputProblem(plan, { ...check, source: measured })).toBeUndefined()
  })
})

describe('isPlaceholderThumbnail', () => {
  it.each([
    'https://i.ytimg.com/img/no_thumbnail.jpg',
    'https://a1.sndcdn.com/images/default_avatar_large.png',
    'https://a1.sndcdn.com/images/default_avatar_t500x500.jpg?1',
    'https://i1.sndcdn.com/avatars-000123456789-abcdef-large.jpg',
  ])('%s is a placeholder', (url) => {
    expect(isPlaceholderThumbnail(url)).toBe(true)
  })

  it.each([
    undefined,
    'https://i.ytimg.com/vi_webp/jNQXAC9IVRw/hqdefault.webp',
    'https://i1.sndcdn.com/artworks-000043574646-iq6flj-original.jpg',
    'https://example.com/avatars-me.jpg',
  ])('%s is not', (url) => {
    expect(isPlaceholderThumbnail(url)).toBe(false)
  })
})

describe('sniffImage', () => {
  const bytes = (...values: number[]) => Uint8Array.from(values)
  const text = (value: string) => Array.from(value, (char) => char.charCodeAt(0))

  it.each([
    ['JPEG', bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1), 'jpeg_pipe'],
    ['PNG', bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d), 'png_pipe'],
    ['WebP', bytes(...text('RIFF'), 0x24, 0x5a, 0, 0, ...text('WEBP')), 'webp_pipe'],
  ])('knows %s', (_label, head, demuxer) => {
    expect(sniffImage(head)).toBe(demuxer)
  })

  it.each([
    ['GIF', bytes(...text('GIF89a'), 1, 0, 1, 0, 0, 0)],
    ['a WAV', bytes(...text('RIFF'), 0x24, 0x5a, 0, 0, ...text('WAVE'))],
    ['HTML', bytes(...text('<!doctype ht'))],
    ['an empty file', bytes()],
    ['a truncated JPEG marker', bytes(0xff, 0xd8)],
  ])('refuses %s', (_label, head) => {
    expect(sniffImage(head)).toBeUndefined()
  })
})

describe('sameDuration', () => {
  it.each([
    [19.021, 19.006, true],
    [19.021, 21.02, true],
    [19.021, 21.03, false],
    [19.021, 4.8335, false],
    [600, 606, true],
    [600, 606.1, false],
    [2000, 2010, true],
    [2000, 2010.1, false],
    [2000, 1990, true],
  ])('%s s and %s s: %s', (reference, other, expected) => {
    expect(sameDuration(reference, other)).toBe(expected)
  })
})

describe('downloadProblem', () => {
  it("accepts a download whose probed duration matches yt-dlp's", () => {
    expect(downloadProblem(probeFixture('src-soundcloud-mp3'), 9.927)).toBeUndefined()
    expect(downloadProblem(probeFixture('src-youtube-251-webm'), 19)).toBeUndefined()
    expect(downloadProblem(probeFixture('src-youtube-251-webm'), undefined)).toBeUndefined()
  })

  it('cannot see a truncated WebM: it probes with its declared duration (§9)', () => {
    expect(downloadProblem(probeFixture('src-youtube-251-webm-part'), 19)).toBeUndefined()
  })

  it('reports a file shorter than yt-dlp said', () => {
    expect(downloadProblem(sourceProbe({ codec: 'mp3' }, ['mp3'], 5.04), 6.04 + 2)).toBe(
      'The download is incomplete. Try again.',
    )
  })
})

describe('outputProblem', () => {
  const webm = probeFixture('src-youtube-251-webm')
  const ytTags: Tags = { title: 'Me at the zoo', artist: 'jawed', comment: YOUTUBE }
  const check = (format: DownloadFormat, source: Probe, output: string, coverPlanned = false) =>
    outputProblem(planAudio(format, source), {
      source,
      output: probeFixture(output),
      tags: ytTags,
      coverPlanned,
    })

  it.each([
    ['mp3', 'src-youtube-251-webm', 'out-mp3-encode', false],
    ['mp3', 'src-soundcloud-mp3', 'out-mp3-copy', true],
    ['m4a', 'src-youtube-140-m4a', 'out-m4a-copy', true],
    ['m4a', 'src-soundcloud-hls-aac-m4a', 'out-m4a-copy-soundcloud', true],
    ['flac', 'src-youtube-251-webm', 'out-flac', true],
    ['wav', 'src-youtube-251-webm', 'out-wav', false],
    ['aiff', 'src-youtube-251-webm', 'out-aiff', true],
    ['original', 'src-youtube-251-webm', 'out-original-webm', false],
  ] as const)('accepts %s from %s as %s', (format, source, output, coverPlanned) => {
    expect(check(format, probeFixture(source), output, coverPlanned)).toBeUndefined()
  })

  it('catches a truncated download through the output duration (exit 0 with -xerror)', () => {
    expect(check('mp3', webm, 'out-mp3-encode-truncated')).toBe(
      'The converted file is incomplete: the download may be damaged. Try again.',
    )
  })

  it('wants the planned codec', () => {
    expect(check('mp3', webm, 'out-aiff')).toBe('The converted file has the wrong format.')
    expect(check('mp3', webm, 'cover-youtube-webp')).toBe('The converted file has no audio.')
  })

  it('wants the cover when one was planned for an ffmpeg-tagged container', () => {
    const source = probeFixture('src-soundcloud-mp3')
    const m4aPlan = planAudio('m4a', source)
    const output = probeFixture('out-m4a-encode')
    const tags: Tags = { title: "Dl Test Video '' Ä↭", artist: 'Youtube' }
    expect(outputProblem(m4aPlan, { source, output, tags, coverPlanned: true })).toBe(
      'The converted file is missing its cover.',
    )
    expect(outputProblem(m4aPlan, { source, output, tags, coverPlanned: false })).toBeUndefined()
  })

  it('wants the title and artist ffmpeg wrote, in format or stream tags, any case', () => {
    const plan = planAudio('original', webm)
    const output = probeFixture('out-original-webm')
    const untagged: Probe = { ...output, tags: {} }
    expect(
      outputProblem(plan, { source: webm, output: untagged, tags: ytTags, coverPlanned: false }),
    ).toBe('The converted file is missing its tags.')
    // Ogg/Opus: the tags live on the audio stream.
    const audio = output.audio ?? fail()
    const ogg: Probe = {
      ...untagged,
      audio: { ...audio, tags: { title: 'Me at the zoo', artist: 'jawed' } },
    }
    expect(
      outputProblem(plan, { source: webm, output: ogg, tags: ytTags, coverPlanned: false }),
    ).toBe(undefined)
    // Nothing to check when there was nothing to write.
    expect(
      outputProblem(plan, { source: webm, output: untagged, tags: {}, coverPlanned: false }),
    ).toBeUndefined()
  })

  it('wants a duration when the source had one', () => {
    const output: Probe = { ...probeFixture('out-mp3-encode') }
    delete output.durationSec
    expect(
      outputProblem(planAudio('mp3', webm), {
        source: webm,
        output,
        tags: {},
        coverPlanned: false,
      }),
    ).toBe('The converted file is incomplete: the download may be damaged. Try again.')
  })
})

describe('outputInfo', () => {
  const webm = probeFixture('src-youtube-251-webm')

  it.each([
    ['mp3', webm, 'out-mp3-encode', { ext: 'mp3', codec: 'mp3', bitrateKbps: 320, encoded: true }],
    [
      'mp3',
      probeFixture('src-soundcloud-mp3'),
      'out-mp3-copy',
      { ext: 'mp3', codec: 'mp3', bitrateKbps: 128, sampleRateHz: 44100, encoded: false },
    ],
    [
      'm4a',
      probeFixture('src-soundcloud-mp3'),
      'out-m4a-encode',
      { ext: 'm4a', codec: 'aac', bitrateKbps: 219, encoded: true },
    ],
    ['original', webm, 'out-original-webm', { ext: 'webm', codec: 'opus', bitrateKbps: 106 }],
    ['flac', webm, 'out-flac', { ext: 'flac', codec: 'flac', sampleRateHz: 48000, channels: 2 }],
    ['aiff', webm, 'out-aiff', { ext: 'aiff', codec: 'pcm_s16be', encoded: true }],
    ['wav', webm, 'out-wav', { ext: 'wav', codec: 'pcm_s16le' }],
  ] as const)('%s → %s', (format, source, output, expected) => {
    const info = outputInfo(planAudio(format, source), probeFixture(output))
    expect(info).toMatchObject(expected)
    if (!['mp3', 'aac', 'opus'].includes(info.codec)) expect(info.bitrateKbps).toBeUndefined()
  })
})

/**
 * ffmpeg 8.0's stderr (recorded 2026-10-03), the audio pass with -xerror on a stitched MP3 (two
 * lavfi MP3s concatenated, the second with ffmpeg's default ID3v2 tag) to AAC: exit 183.
 */
const STITCHED_XERROR = [
  '[mp3float @ 0x73cc74e00] Header missing',
  '[aist#0:0/mp3 @ 0x73cc40300] [dec:mp3float @ 0x73d0383c0] Error submitting packet to decoder: Invalid data found when processing input',
  '[aist#0:0/mp3 @ 0x73cc40300] [dec:mp3float @ 0x73d0383c0] Error processing packet in decoder: Invalid data found when processing input',
  '[aist#0:0/mp3 @ 0x73cc40300] [dec:mp3float @ 0x73d0383c0] Task finished with error code: -1094995529 (Invalid data found when processing input)',
  '[aist#0:0/mp3 @ 0x73cc40300] [dec:mp3float @ 0x73d0383c0] Terminating thread with return code -1094995529 (Invalid data found when processing input)',
  '',
].join('\n')

/** ffmpeg 8.0's stderr (recorded 2026-10-03), the WAV pass onto a full 2 MB HFS+ image: exit 228. */
const DISK_FULL_WAV = [
  '[aost#0:0/pcm_s16le @ 0x9a5094000] Error submitting a packet to the muxer: No space left on device',
  '    Last message repeated 1 times',
  '[out#0/wav @ 0x9a508c180] Error muxing a packet',
  '[out#0/wav @ 0x9a508c180] Task finished with error code: -28 (No space left on device)',
  '[out#0/wav @ 0x9a508c180] Terminating thread with return code -28 (No space left on device)',
  '[out#0/wav @ 0x9a508c180] Error writing trailer: No space left on device',
  '[out#0/wav @ 0x9a508c180] Error closing file: No space left on device',
  '',
].join('\n')

describe('ffmpegErrorText', () => {
  const JOB =
    '/Users/dj/Library/Application Support/DJ Scraper/jobs/0b7d5c2e-0000-4000-8000-000000000001'

  it.each([
    [
      'the last line, without its context prefix',
      '[matroska,webm @ 0x12a704080] File ended prematurely\n',
      'File ended prematurely',
    ],
    [
      'skipping the Opus packet noise',
      '[in#0/matroska,webm @ 0x8c1] Error opening input files: Invalid data found when processing input\n[opus @ 0x600001] Error parsing Opus packet header.\n',
      'Error opening input files: Invalid data found when processing input',
    ],
    ['with CR line ends and blank lines', 'Conversion failed!\r\n\r\n   \r', 'Conversion failed!'],
    [
      'with nested brackets in the prefix',
      '[aost#0:0/libmp3lame @ 0xabc] Error while opening encoder\n',
      'Error while opening encoder',
    ],
    [
      "without ffmpeg 8's nested prefixes and thread trailers (recorded: a stitched MP3 with -xerror)",
      STITCHED_XERROR,
      'Error processing packet in decoder: Invalid data found when processing input',
    ],
    [
      'the last line when only trailers are left',
      '[aist#0:0/mp3 @ 0x73cc40300] [dec:mp3float @ 0x73d0383c0] Terminating thread with return code -1094995529 (Invalid data found when processing input)\n',
      'Terminating thread with return code -1094995529 (Invalid data found when processing input)',
    ],
    [
      'the closing error of a full disk (recorded: WAV onto a full 2 MB disk image)',
      DISK_FULL_WAV,
      'Error closing file: No space left on device',
    ],
  ])('takes %s', (_label, stderr, expected) => {
    expect(ffmpegErrorText(stderr)).toBe(expected)
    expect(ffmpegErrorText(stderr)).not.toMatch(/0x[0-9a-f]+/)
  })

  it('tells a full drive (ENOSPC, EDQUOT) from other failures', () => {
    expect(ffmpegDiskFull(DISK_FULL_WAV)).toBe(true)
    expect(ffmpegDiskFull('[out#0/ipod @ 0x1] Error closing file: Disc quota exceeded\n')).toBe(
      true,
    )
    expect(ffmpegDiskFull(STITCHED_XERROR)).toBe(false)
    expect(ffmpegDiskFull('')).toBe(false)
    // The job dir's own path never counts as the reason.
    const job = '/Volumes/No space left on device/DJ Scraper/jobs/x'
    const denied = `[out#0/wav @ 0x1] Error opening output ${job}/finalize/out.wav: Permission denied\n`
    expect(ffmpegDiskFull(denied, job)).toBe(false)
  })

  it('cuts the job dir out of the text', () => {
    expect(ffmpegErrorText(`File '${JOB}/finalize/out.mp3' already exists. Exiting.\n`, JOB)).toBe(
      "File '…/finalize/out.mp3' already exists. Exiting.",
    )
  })

  it('is undefined when stderr says nothing (or only the Opus noise)', () => {
    expect(ffmpegErrorText('')).toBeUndefined()
    expect(ffmpegErrorText('\n \n')).toBeUndefined()
    expect(ffmpegErrorText('[opus @ 0x1] Error parsing Opus packet header.\n')).toBeUndefined()
  })

  it('keeps at most 300 characters', () => {
    expect(ffmpegErrorText('x'.repeat(1000))).toHaveLength(300)
  })
})

function fail(): never {
  throw new Error('missing')
}
