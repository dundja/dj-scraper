import { existsSync, readFileSync, statSync } from 'node:fs'
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { checkFf, checkHealth, locateFfmpeg } from '../src/engine/binaries.ts'
import { killActiveGroups, type RunResult, run } from '../src/engine/run.ts'
import { downloadArgs } from '../src/engine/ytdlp-args.ts'
import {
  engineFixture,
  FAKE_FFMPEG,
  type FakeFfmpeg,
  type FakeFfmpegKnobs,
  fakeAudioBytes,
  fakeImageBytes,
  fakeSourceHeader,
  makeTempDir,
  readFakeMedia,
  readFakeMediaFile,
  writeFakeEngine,
  writeFakeFfmpeg,
} from './helpers.ts'

// The fake ffmpeg and ffprobe are what finalize runs against in integration and e2e tests, so they
// must take the design's argv (and nothing looser), answer like ffmpeg 8, and read back what
// they wrote the way ffprobe would.

const FIXTURES = path.join(import.meta.dirname, 'fixtures')
const ffprobeFixture = (name: string): unknown =>
  JSON.parse(readFileSync(path.join(FIXTURES, 'ffprobe', name), 'utf8'))

const SOURCES = {
  webm: 'ffprobe/src-youtube-251-webm.json',
  m4a: 'ffprobe/src-youtube-140-m4a.json',
  mp3: 'ffprobe/src-soundcloud-mp3.json',
  vbr: 'ffprobe/src-mp3-vbr-noxing.json',
}

/** The argv shapes of fixtures/ffprobe/README.md (design D3, D14 and §9: no -vn). */
const HEAD = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-n']
const input = (file: string, demuxer?: string) => [
  '-protocol_whitelist',
  'file',
  ...(demuxer === undefined ? [] : ['-f', demuxer]),
  '-i',
  file,
]
const PIC = [
  '-c:v',
  'copy',
  '-disposition:v:0',
  'attached_pic',
  '-metadata:s:v:0',
  'title=Album cover',
  '-metadata:s:v:0',
  'comment=Cover (front)',
]
const YT_TAGS = [
  '-map_metadata',
  '-1',
  '-metadata',
  'title=Me at the zoo',
  '-metadata',
  'artist=jawed',
  '-metadata',
  'comment=https://www.youtube.com/watch?v=jNQXAC9IVRw',
]
const SCALE = [
  '-vf',
  "scale=w='min(1000,iw)':h='min(1000,ih)':force_original_aspect_ratio=decrease",
]
const ENTRIES =
  'format=format_name,duration,bit_rate:format_tags:stream=index,codec_type,codec_name,sample_rate,channels,bit_rate:stream_tags:stream_disposition=attached_pic'
const probeArgv = (file: string) => ['-v', 'error', '-show_entries', ENTRIES, '-of', 'json', file]
const OPUS_LINE = '[opus @ 0x600001a2c000] Error parsing Opus packet header.\n'

/** The ffprobe JSON fields these tests look at. */
type Probe = {
  streams: {
    index: number
    codec_name?: string
    codec_type?: string
    sample_rate?: string
    channels?: number
    bit_rate?: string
    disposition?: { attached_pic: number }
    tags?: Record<string, string>
  }[]
  format: { format_name: string; duration?: string; tags?: Record<string, string> }
}

let root = ''
let count = 0
beforeAll(async () => {
  root = await makeTempDir('fake-ffmpeg')
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})
// A hanging fake outlives a failed test (Vitest can't reach its process group), so reap it.
afterEach(() => {
  killActiveGroups()
})

/** A fresh fake per test, so call logs and knobs never leak between tests. */
const fake = (env?: FakeFfmpegKnobs): Promise<FakeFfmpeg> =>
  writeFakeFfmpeg(path.join(root, `bin-${++count}`), env === undefined ? {} : { env })

/** A job dir holding the sources a test names (as yt-dlp would have left them). */
async function jobDir(): Promise<string> {
  const dir = path.join(root, `job-${++count}`)
  await mkdir(dir, { mode: 0o700 })
  return dir
}

async function source(dir: string, name: string, probe: string): Promise<string> {
  const file = path.join(dir, name)
  await writeFile(file, fakeAudioBytes(fakeSourceHeader(probe), `payload of ${name}\n`))
  return file
}

async function image(
  dir: string,
  name: string,
  format: 'jpeg' | 'png' | 'webp',
  size: number[],
): Promise<string> {
  const file = path.join(dir, name)
  const [width = 0, height = 0] = size
  await writeFile(file, fakeImageBytes({ format, width, height }))
  return file
}

/** ffprobe's JSON for `file`, asserting a clean exit. */
async function probe(ff: FakeFfmpeg, file: string): Promise<Probe> {
  const result = await run(ff.ffprobe, probeArgv(file))
  expect(result, result.stderr).toMatchObject({ exitCode: 0, stderr: '' })
  return JSON.parse(result.stdout) as Probe
}

const audioOf = async (file: string) => {
  const media = await readFakeMediaFile(file)
  if (media?.kind !== 'audio') throw new Error(`${file} is no fake audio`)
  return media
}

const lastLine = (result: RunResult) => result.stderr.trimEnd().split('\n').at(-1)

/** An ID3v2.3 tag of `size` body bytes (padding), as our tag writer prepends one. */
function id3Tag(size: number, footer = false): Buffer {
  const header = Buffer.from([0x49, 0x44, 0x33, 3, 0, footer ? 0x10 : 0, 0, 0, 0, 0])
  for (let i = 0; i < 4; i++) header[9 - i] = (size >> (7 * i)) & 0x7f
  const tail = footer ? Buffer.from([0x33, 0x44, 0x49, 3, 0, 0x10, ...header.subarray(6)]) : []
  return Buffer.concat([header, Buffer.alloc(size), Buffer.from(tail)])
}

describe('fake ffmpeg: the binary and -version', () => {
  it('keeps its exec bit, which every symlink to it relies on', () => {
    expect(statSync(FAKE_FFMPEG).mode & 0o111).toBe(0o111)
  })

  it.each([
    ['ffmpeg', 'ffmpeg-version-8.0-brew.txt'],
    ['ffprobe', 'ffprobe-version-8.0-brew.txt'],
  ] as const)('prints the recorded %s -version, even with every knob set', async (tool, file) => {
    const ff = await fake({ FAKE_FFMPEG_FAIL: 'ffmpeg,ffprobe@1:boom', FAKE_FFMPEG_HANG: '1' })
    const result = await run(ff[tool], ['-version'], { timeoutMs: 5_000 })
    expect(result).toMatchObject({ exitCode: 0, stdout: engineFixture(file), stderr: '' })
  })

  it('passes the engine health check as Homebrew ffmpeg 8.0 with MP3', async () => {
    const ff = await fake()
    const located = await locateFfmpeg({ FFMPEG_PATH: ff.ffmpeg })
    expect(located.ffprobe).toMatchObject({ kind: 'found', path: ff.ffprobe })
    expect(await checkFf('ffmpeg', located.ffmpeg)).toMatchObject({
      status: 'ok',
      version: '8.0',
      major: 8,
      meetsMinimum: true,
      mp3: true,
    })
    expect(await checkFf('ffprobe', located.ffprobe)).toMatchObject({
      status: 'ok',
      meetsMinimum: true,
    })
  })

  it('exits 2 when linked under a name that is neither ffmpeg nor ffprobe', async () => {
    const link = path.join(root, `bin-${++count}`, 'avconv')
    await mkdir(path.dirname(link))
    await symlink(FAKE_FFMPEG, link)
    const result = await run(link, ['-version'])
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('link me as ffmpeg or ffprobe')
  })
})

describe('fake ffmpeg: audio passes', () => {
  it('copies an MP3 source without tags, and ffprobe reads back the recorded out-mp3-copy', async () => {
    const ff = await fake()
    const dir = await jobDir()
    const src = await source(dir, '123998367.mp3', SOURCES.mp3)
    const out = path.join(dir, 'out.mp3')
    const argv = [
      ...HEAD,
      ...input(src),
      '-map',
      '0:a:0',
      '-c:a',
      'copy',
      '-map_metadata',
      '-1',
      '-id3v2_version',
      '0',
      '-write_id3v1',
      '0',
      '-f',
      'mp3',
      out,
    ]
    expect(await run(ff.ffmpeg, argv)).toMatchObject({ exitCode: 0, stderr: '' })
    const media = await audioOf(out)
    expect(media.header).toEqual({
      ...fakeSourceHeader(SOURCES.mp3),
      probe: 'ffprobe/out-mp3-copy.json',
    })
    expect(media.payload.toString()).toBe('payload of 123998367.mp3\n')
    expect(await probe(ff, out)).toEqual(ffprobeFixture('out-mp3-copy.json'))
  })

  it("encodes Opus to MP3 320k at the native 48 kHz, printing ffmpeg's Opus line", async () => {
    const ff = await fake()
    const dir = await jobDir()
    const src = await source(dir, 'jNQXAC9IVRw.webm', SOURCES.webm)
    const out = path.join(dir, 'out.mp3')
    const argv = [
      ...HEAD,
      '-xerror',
      ...input(src),
      '-map',
      '0:a:0',
      '-c:a',
      'libmp3lame',
      '-b:a',
      '320k',
      '-map_metadata',
      '-1',
      '-id3v2_version',
      '0',
      '-f',
      'mp3',
      out,
    ]
    expect(await run(ff.ffmpeg, argv)).toMatchObject({ exitCode: 0, stderr: OPUS_LINE })
    expect((await audioOf(out)).header).toEqual({
      probe: 'ffprobe/out-mp3-encode.json',
      codec: 'mp3',
      durationSec: 19.021,
      sampleRate: 48000,
      channels: 2,
      bitRate: 320000,
      tags: {},
      cover: false,
    })
    const probed = await probe(ff, out)
    expect(probed.streams).toMatchObject([
      { codec_name: 'mp3', sample_rate: '48000', channels: 2, bit_rate: '320000' },
    ])
    expect(probed.format).toMatchObject({ format_name: 'mp3', duration: '19.021000' })
  })

  it('copies AAC into m4a with a cover and tags, read back as the recorded out-m4a-copy', async () => {
    const ff = await fake()
    const dir = await jobDir()
    const src = await source(dir, 'jNQXAC9IVRw.m4a', SOURCES.m4a)
    const cover = await image(dir, 'cover.jpg', 'jpeg', [480, 360])
    const out = path.join(dir, 'out.m4a')
    const argv = [
      ...HEAD,
      ...input(src),
      ...input(cover, 'jpeg_pipe'),
      '-map',
      '0:a:0',
      '-map',
      '1:v:0',
      '-c:a',
      'copy',
      ...PIC,
      ...YT_TAGS,
      '-movflags',
      '+faststart',
      '-f',
      'ipod',
      out,
    ]
    expect(await run(ff.ffmpeg, argv)).toMatchObject({ exitCode: 0, stderr: '' })
    expect((await audioOf(out)).header).toMatchObject({ codec: 'aac', cover: true })
    expect(await probe(ff, out)).toEqual(ffprobeFixture('out-m4a-copy.json'))
  })

  it('encodes FLAC s16 with a cover: tags, and the picture with its stream tags', async () => {
    const ff = await fake()
    const dir = await jobDir()
    const src = await source(dir, 'jNQXAC9IVRw.webm', SOURCES.webm)
    const cover = await image(dir, 'cover.jpg', 'jpeg', [480, 360])
    const out = path.join(dir, 'out.flac')
    const argv = [
      ...HEAD,
      '-xerror',
      ...input(src),
      ...input(cover, 'jpeg_pipe'),
      '-map',
      '0:a:0',
      '-map',
      '1:v:0',
      '-c:a',
      'flac',
      '-sample_fmt',
      's16',
      ...PIC,
      ...YT_TAGS,
      '-f',
      'flac',
      out,
    ]
    expect(await run(ff.ffmpeg, argv)).toMatchObject({ exitCode: 0, stderr: OPUS_LINE })
    const recorded = ffprobeFixture('out-flac.json') as Probe
    const probed = await probe(ff, out)
    expect(probed.streams).toEqual(recorded.streams)
    expect(probed.format.tags).toEqual(recorded.format.tags)
  })

  it.each([
    ['wav', 'pcm_s16le', 'out-wav.json'],
    ['webm', 'copy', 'out-original-webm.json'],
  ])(
    'writes -f %s with the tags as ffprobe shows them for that container',
    async (muxer, codec, recordedName) => {
      const ff = await fake()
      const dir = await jobDir()
      const src = await source(dir, 'jNQXAC9IVRw.webm', SOURCES.webm)
      const out = path.join(dir, `out.${muxer}`)
      const argv = [
        ...HEAD,
        ...(codec === 'copy' ? [] : ['-xerror']),
        ...input(src),
        '-map',
        '0:a:0',
        '-c:a',
        codec,
        ...YT_TAGS,
        '-f',
        muxer,
        out,
      ]
      expect((await run(ff.ffmpeg, argv)).exitCode).toBe(0)
      const recorded = ffprobeFixture(recordedName) as Probe
      const probed = await probe(ff, out)
      // Matroska reads back `title` but `ARTIST` and `COMMENT`.
      expect(probed.format.tags).toEqual(recorded.format.tags)
      expect(probed.streams).toMatchObject(
        recorded.streams.map(({ codec_name, sample_rate, channels, bit_rate }) => ({
          codec_name,
          sample_rate,
          channels,
          ...(bit_rate === undefined ? {} : { bit_rate }),
        })),
      )
    },
  )

  it('writes Ogg/Opus with its tags in the stream, as ffprobe reports Ogg', async () => {
    const ff = await fake()
    const dir = await jobDir()
    const src = await source(dir, 'jNQXAC9IVRw.webm', SOURCES.webm)
    const out = path.join(dir, 'out.opus')
    const argv = [...HEAD, ...input(src), '-map', '0:a:0', '-c:a', 'copy', ...YT_TAGS]
    expect((await run(ff.ffmpeg, [...argv, '-f', 'opus', out])).exitCode).toBe(0)
    const probed = await probe(ff, out)
    expect(probed.format).toEqual({ format_name: 'ogg', duration: '19.021000' })
    expect(probed.streams).toEqual([
      {
        index: 0,
        codec_type: 'audio',
        codec_name: 'opus',
        sample_rate: '48000',
        channels: 2,
        disposition: { attached_pic: 0 },
        tags: {
          title: 'Me at the zoo',
          artist: 'jawed',
          comment: 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
        },
      },
    ])
  })

  it('removes a tag with an empty -metadata value, an inherited one too', async () => {
    const ff = await fake()
    const dir = await jobDir()
    const src = path.join(dir, 'tagged.m4a')
    const header = { ...fakeSourceHeader(SOURCES.m4a), tags: { title: 'Old', comment: 'junk' } }
    await writeFile(src, fakeAudioBytes(header))
    const out = path.join(dir, 'out.m4a')
    const argv = [
      ...HEAD,
      ...input(src),
      '-map',
      '0:a:0',
      '-c:a',
      'copy',
      '-metadata',
      'comment=',
      '-metadata',
      'artist=jawed',
      '-f',
      'ipod',
      out,
    ]
    expect((await run(ff.ffmpeg, argv)).exitCode).toBe(0)
    expect((await audioOf(out)).header.tags).toEqual({ title: 'Old', artist: 'jawed' })
  })

  it('writes AIFF as a FORM container that still reads after an ID3 chunk is appended', async () => {
    const ff = await fake()
    const dir = await jobDir()
    const src = await source(dir, 'jNQXAC9IVRw.webm', SOURCES.webm)
    const out = path.join(dir, 'out.aiff')
    const argv = [
      ...HEAD,
      '-xerror',
      ...input(src),
      '-map',
      '0:a:0',
      '-c:a',
      'pcm_s16be',
      '-map_metadata',
      '-1',
      '-write_id3v2',
      '0',
      '-f',
      'aiff',
      out,
    ]
    expect((await run(ff.ffmpeg, argv)).exitCode).toBe(0)
    const bytes = await readFile(out)
    expect(bytes.toString('latin1', 0, 4)).toBe('FORM')
    expect(bytes.readUInt32BE(4)).toBe(bytes.length - 8)
    expect(bytes.toString('latin1', 8, 16)).toBe('AIFFFAKE')
    expect(bytes.length % 2).toBe(0)
    expect(readFakeMedia(bytes)).toMatchObject({
      kind: 'audio',
      container: 'aiff',
      header: { codec: 'pcm_s16be', bitRate: 1536000, tags: {} },
    })
    const before = await probe(ff, out)
    expect(before.format).toEqual({
      format_name: 'aiff',
      duration: '19.021000',
      bit_rate: '1536022',
    })
    expect(before.streams).toMatchObject([{ codec_name: 'pcm_s16be', bit_rate: '1536000' }])

    // Our ID3 step: append `ID3 ` + BE32 length + tag (+ pad byte), then fix the FORM size.
    const tag = id3Tag(2047)
    const chunk = Buffer.alloc(8)
    chunk.write('ID3 ', 0, 'latin1')
    chunk.writeUInt32BE(tag.length, 4)
    const tagged = Buffer.concat([bytes, chunk, tag, Buffer.alloc(tag.length % 2)])
    tagged.writeUInt32BE(tagged.length - 8, 4)
    await writeFile(out, tagged)
    expect(await probe(ff, out)).toEqual(before)

    // A FORM size left as it was is a broken file, not something to read past.
    tagged.writeUInt32BE(bytes.length - 8, 4)
    await writeFile(out, tagged)
    const broken = await run(ff.ffprobe, probeArgv(out))
    expect(broken).toMatchObject({
      exitCode: 1,
      stdout: '',
      stderr: `${out}: Invalid data found when processing input\n`,
    })
  })

  it('probes past a prepended ID3v2 tag (with or without a footer), and fails on one too long', async () => {
    const ff = await fake()
    const dir = await jobDir()
    const src = await source(dir, 'final.mp3', SOURCES.mp3)
    const plain = await readFile(src)
    const recorded = await probe(ff, src)
    expect(recorded).toEqual(ffprobeFixture('src-soundcloud-mp3.json'))

    await writeFile(src, Buffer.concat([id3Tag(2048), plain]))
    expect(await probe(ff, src)).toEqual(recorded)
    expect(await audioOf(src)).toMatchObject({ id3Bytes: 2058 })
    await writeFile(src, Buffer.concat([id3Tag(100, true), plain]))
    expect(await probe(ff, src)).toEqual(recorded)

    const tooLong = id3Tag(2048)
    tooLong[9] = 0x7f
    await writeFile(src, Buffer.concat([tooLong.subarray(0, 10), plain.subarray(0, 50)]))
    expect((await run(ff.ffprobe, probeArgv(src))).exitCode).toBe(1)
  })
})

describe('fake ffmpeg: an MP3 source', () => {
  /** finalize's measureArgs (engine/finalize-plan.ts). */
  const measureArgv = (src: string) => [
    ...HEAD,
    '-nostats',
    '-progress',
    'pipe:1',
    ...input(src),
    '-map',
    '0:a:0',
    '-c:a',
    'copy',
    '-f',
    'null',
    '-',
  ]
  const encodeArgv = (src: string, out: string, xerror: boolean) => [
    ...HEAD,
    ...(xerror ? ['-xerror'] : []),
    ...input(src),
    '-map',
    '0:a:0',
    '-c:a',
    'aac',
    '-b:a',
    '256k',
    '-map_metadata',
    '-1',
    '-f',
    'ipod',
    out,
  ]
  /** The recorded VBR MP3 without a Xing header: 600.03 s, which ffprobe estimates as 2,413.4 s. */
  async function vbrSource(dir: string): Promise<string> {
    const file = path.join(dir, 'vbr.mp3')
    const header = Object.assign(fakeSourceHeader(SOURCES.vbr), {
      durationSec: 600.032653,
      estimatedSec: 2413.40375,
    })
    await writeFile(file, fakeAudioBytes(header))
    return file
  }

  it("reports ffprobe's estimate, while the measuring pass reports the real length", async () => {
    const ff = await fake()
    const src = await vbrSource(await jobDir())
    expect((await probe(ff, src)).format.duration).toBe('2413.403750')
    const measured = await run(ff.ffmpeg, measureArgv(src))
    expect(measured).toMatchObject({ exitCode: 0, stderr: '' })
    expect(measured.stdout).toBe(
      'bitrate=N/A\ntotal_size=N/A\nout_time_us=600032653\nout_time_ms=600032653\nout_time=00:10:00.032653\ndup_frames=0\ndrop_frames=0\nspeed=N/A\nprogress=end\n',
    )
  })

  it('writes outputs with the real length (ffmpeg writes a Xing header)', async () => {
    const ff = await fake()
    const dir = await jobDir()
    const src = await vbrSource(dir)
    const out = path.join(dir, 'out.m4a')
    expect(await run(ff.ffmpeg, encodeArgv(src, out, false))).toMatchObject({
      exitCode: 0,
      stderr: '',
    })
    expect((await audioOf(out)).header).not.toHaveProperty('estimatedSec')
    expect((await probe(ff, out)).format.duration).toBe('600.032653')
  })

  it('refuses -xerror on a pass that decodes an MP3, and wants it for any other source', async () => {
    const ff = await fake()
    const dir = await jobDir()
    const mp3 = await source(dir, 'in.mp3', SOURCES.mp3)
    const strict = await run(ff.ffmpeg, encodeArgv(mp3, path.join(dir, 'a.m4a'), true))
    expect(strict).toMatchObject({ exitCode: 2, stdout: '' })
    expect(strict.stderr).toContain('-xerror on a pass that decodes an MP3')
    const webm = await source(dir, 'in.webm', SOURCES.webm)
    const lax = await run(ff.ffmpeg, encodeArgv(webm, path.join(dir, 'b.m4a'), false))
    expect(lax.exitCode).toBe(2)
    expect(lax.stderr).toContain('-xerror is missing on a pass that decodes')
    expect((await run(ff.ffmpeg, encodeArgv(webm, path.join(dir, 'c.m4a'), true))).exitCode).toBe(0)
  })

  it.each([
    [
      'without -progress',
      (argv: string[]) => argv.filter((t) => t !== '-progress' && t !== 'pipe:1'),
      'reports with -nostats -progress pipe:1',
    ],
    [
      'without -nostats',
      (argv: string[]) => argv.filter((t) => t !== '-nostats'),
      'reports with -nostats -progress pipe:1',
    ],
    [
      'into a file',
      (argv: string[]) => [...argv.slice(0, -1), '/tmp/x.null'],
      '-f null writes to -',
    ],
    [
      'decoding',
      (argv: string[]) => argv.map((t) => (t === 'copy' ? 'pcm_s16le' : t)),
      'copies the audio of one input',
    ],
  ])('exits 2 on a measuring pass %s', async (_label, edit, message) => {
    const ff = await fake()
    const src = await source(await jobDir(), 'in.mp3', SOURCES.mp3)
    const result = await run(ff.ffmpeg, edit(measureArgv(src)))
    expect(result).toMatchObject({ exitCode: 2, stdout: '' })
    expect(result.stderr).toContain(message)
  })

  it('exits 2 on -progress outside the measuring pass', async () => {
    const ff = await fake()
    const dir = await jobDir()
    const src = await source(dir, 'in.mp3', SOURCES.mp3)
    const argv = ['-progress', 'pipe:1', ...encodeArgv(src, path.join(dir, 'a.m4a'), false)]
    const result = await run(ff.ffmpeg, argv)
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('-progress is only for the measuring pass')
  })

  it('answers a missing input like ffmpeg, and takes the FAIL, HANG and SHORT knobs', async () => {
    const dir = await jobDir()
    const src = await source(dir, 'in.mp3', SOURCES.mp3)
    const plain = await fake()
    const missing = await run(plain.ffmpeg, measureArgv(path.join(dir, 'gone.mp3')))
    expect(missing).toMatchObject({ exitCode: 254, stdout: '' })

    const failing = await fake({ FAKE_FFMPEG_FAIL: 'measure@183:broken' })
    expect(await run(failing.ffmpeg, measureArgv(src))).toMatchObject({
      exitCode: 183,
      stdout: '',
      stderr: 'broken\n',
    })
    // Unscoped, FAIL covers every ffmpeg pass, the measuring one too.
    const all = await fake({ FAKE_FFMPEG_FAIL: '1:all' })
    expect((await run(all.ffmpeg, measureArgv(src))).exitCode).toBe(1)

    const short = await fake({ FAKE_FFMPEG_SHORT: 'measure@1' })
    expect((await run(short.ffmpeg, measureArgv(src))).stdout).toContain('out_time_us=4936996\n')

    const hanging = await fake({ FAKE_FFMPEG_HANG: 'measure@1' })
    const controller = new AbortController()
    const running = run(hanging.ffmpeg, measureArgv(src), { signal: controller.signal })
    await hanging.waitForCalls(1)
    controller.abort()
    expect(await running).toMatchObject({ aborted: true, exitCode: 255, stdout: '' })
  })
})

describe('fake ffmpeg: the cover pass', () => {
  const coverArgv = (src: string, demuxer: string, out: string) => [
    ...HEAD,
    '-xerror',
    ...input(src, demuxer),
    '-map',
    '0:v:0',
    '-frames:v',
    '1',
    ...SCALE,
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
    out,
  ]

  it.each([
    ['a WebP', 'webp', 'webp_pipe', [480, 360], [480, 360], 'cover-youtube-webp.json'],
    ['a large JPEG', 'jpeg', 'jpeg_pipe', [1500, 1500], [1000, 1000], 'cover-soundcloud-jpg.json'],
    ['a PNG', 'png', 'png_pipe', [100, 100], [100, 100], 'cover-soundcloud-jpg.json'],
  ] as const)(
    'turns %s into a JPEG of at most 1000 px that probes as the recorded cover',
    async (_what, format, demuxer, size, scaled, recorded) => {
      const ff = await fake()
      const dir = await jobDir()
      const src = await image(dir, `thumb.${format}`, format, [...size])
      const out = path.join(dir, 'cover.jpg')
      expect(await run(ff.ffmpeg, coverArgv(src, demuxer, out))).toMatchObject({
        exitCode: 0,
        stderr: '',
      })
      const bytes = await readFile(out)
      expect([...bytes.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff])
      expect(readFakeMedia(bytes)).toEqual({
        kind: 'image',
        info: { format: 'jpeg', width: scaled[0], height: scaled[1], probe: `ffprobe/${recorded}` },
      })
      expect(await probe(ff, out)).toEqual(ffprobeFixture(recorded))
    },
  )

  it('exits 183 when the -f image pipe is not what the file is', async () => {
    const ff = await fake()
    const dir = await jobDir()
    const src = await image(dir, 'thumb.webp', 'webp', [480, 360])
    const out = path.join(dir, 'cover.jpg')
    const result = await run(ff.ffmpeg, coverArgv(src, 'jpeg_pipe', out))
    expect(result.exitCode).toBe(183)
    expect(lastLine(result)).toBe(
      'Error opening input files: Invalid data found when processing input',
    )
    expect(existsSync(out)).toBe(false)
  })
})

describe('fake ffmpeg: answers like ffmpeg 8', () => {
  const copyArgv = (src: string, out: string, muxer = 'mp3') => [
    ...HEAD,
    ...input(src),
    '-map',
    '0:a:0',
    '-c:a',
    'copy',
    '-f',
    muxer,
    out,
  ]

  it("exits 0 without touching an existing output (-n): File '…' already exists", async () => {
    const ff = await fake()
    const dir = await jobDir()
    const src = await source(dir, 'in.mp3', SOURCES.mp3)
    const out = path.join(dir, 'out.mp3')
    await writeFile(out, "the user's file")
    expect(await run(ff.ffmpeg, copyArgv(src, out))).toMatchObject({
      exitCode: 0,
      stderr: `File '${out}' already exists. Exiting.\n`,
    })
    expect(await readFile(out, 'utf8')).toBe("the user's file")
  })

  it('exits 254 for a missing input, and 183 for one that is no media', async () => {
    const ff = await fake()
    const dir = await jobDir()
    const missing = await run(
      ff.ffmpeg,
      copyArgv(path.join(dir, 'gone.mp3'), path.join(dir, 'a.mp3')),
    )
    expect(missing.exitCode).toBe(254)
    expect(lastLine(missing)).toBe('Error opening input files: No such file or directory')
    const junk = path.join(dir, 'junk.mp3')
    await writeFile(junk, '<html>not audio</html>')
    const invalid = await run(ff.ffmpeg, copyArgv(junk, path.join(dir, 'b.mp3')))
    expect(invalid.exitCode).toBe(183)
    expect(lastLine(invalid)).toBe(
      'Error opening input files: Invalid data found when processing input',
    )
  })

  it('exits 254 when the output dir is gone', async () => {
    const ff = await fake()
    const dir = await jobDir()
    const src = await source(dir, 'in.mp3', SOURCES.mp3)
    const result = await run(ff.ffmpeg, copyArgv(src, path.join(dir, 'gone', 'out.mp3')))
    expect(result.exitCode).toBe(254)
    expect(lastLine(result)).toBe('Error opening output files: No such file or directory')
  })

  it('exits 234 without an output when a -map matches no stream', async () => {
    const ff = await fake()
    const dir = await jobDir()
    const src = await source(dir, 'in.mp3', SOURCES.mp3)
    const out = path.join(dir, 'out.m4a')
    const argv = [...HEAD, ...input(src), ...input(src), '-map', '0:a:0', '-map', '1:v:0']
    const result = await run(ff.ffmpeg, [...argv, '-c:a', 'copy', ...PIC, '-f', 'ipod', out])
    expect(result.exitCode).toBe(234)
    expect(result.stderr).toContain("Stream map '1:v:0' matches no streams.")
    expect(lastLine(result)).toBe('Error opening output files: Invalid argument')
    expect(existsSync(out)).toBe(false)
  })

  it('exits 234 with a 0-byte output when the muxer cannot hold the copied codec', async () => {
    const ff = await fake()
    const dir = await jobDir()
    const src = await source(dir, 'jNQXAC9IVRw.webm', SOURCES.webm)
    const out = path.join(dir, 'out.m4a')
    const result = await run(ff.ffmpeg, copyArgv(src, out, 'ipod'))
    expect(result.exitCode).toBe(234)
    expect(result.stderr).toContain('Unsupported codec opus for the ipod muxer')
    expect(lastLine(result)).toMatch(/Could not write header \(incorrect codec parameters \?\)/)
    expect(await readFile(out, 'utf8')).toBe('')
  })

  const coverArgv = (src: string, cover: string, muxer: string, out: string, extra: string[]) => [
    ...HEAD,
    ...input(src),
    ...input(cover, 'jpeg_pipe'),
    '-map',
    '0:a:0',
    '-map',
    '1:v:0',
    '-c:a',
    'copy',
    ...extra,
    '-f',
    muxer,
    out,
  ]

  it('exits 234 for an m4a cover without the attached_pic disposition; FLAC drops it silently', async () => {
    const ff = await fake()
    const dir = await jobDir()
    const m4a = await source(dir, 'in.m4a', SOURCES.m4a)
    const cover = await image(dir, 'cover.jpg', 'jpeg', [480, 360])
    const out = path.join(dir, 'out.m4a')
    const result = await run(ff.ffmpeg, coverArgv(m4a, cover, 'ipod', out, ['-c:v', 'copy']))
    expect(result.exitCode).toBe(234)
    expect(result.stderr).toContain('Could not find tag for codec mjpeg in stream #1')
    expect(await readFile(out, 'utf8')).toBe('')

    const flacSource = path.join(dir, 'in.flac')
    await writeFile(
      flacSource,
      fakeAudioBytes({ ...fakeSourceHeader(SOURCES.webm), codec: 'flac' }),
    )
    const flac = path.join(dir, 'out.flac')
    const dropped = await run(
      ff.ffmpeg,
      coverArgv(flacSource, cover, 'flac', flac, ['-c:v', 'copy']),
    )
    expect(dropped).toMatchObject({ exitCode: 0, stderr: '' })
    expect((await audioOf(flac)).header.cover).toBe(false)
  })

  it('drops a mapped cover with -vn (design §9)', async () => {
    const ff = await fake()
    const dir = await jobDir()
    const m4a = await source(dir, 'in.m4a', SOURCES.m4a)
    const cover = await image(dir, 'cover.jpg', 'jpeg', [480, 360])
    const out = path.join(dir, 'out.m4a')
    const result = await run(ff.ffmpeg, coverArgv(m4a, cover, 'ipod', out, ['-vn', ...PIC]))
    expect(result.exitCode).toBe(0)
    const probed = await probe(ff, out)
    expect(probed.streams.map((stream) => stream.codec_type)).toEqual(['audio'])
  })

  it.each([
    ['wav', 'pcm_s16le', 'wav muxer does not support any stream of type video'],
    ['webm', 'copy', 'Only VP8 or VP9 or AV1 video and Vorbis or Opus audio'],
  ])('exits 234 for a cover in %s', async (muxer, codec, message) => {
    const ff = await fake()
    const dir = await jobDir()
    const src = await source(dir, 'in.webm', SOURCES.webm)
    const cover = await image(dir, 'cover.jpg', 'jpeg', [480, 360])
    const argv = [
      ...HEAD,
      '-xerror',
      ...input(src),
      ...input(cover, 'jpeg_pipe'),
      '-map',
      '0:a:0',
      '-map',
      '1:v:0',
      '-c:a',
      codec,
      ...PIC,
      '-f',
      muxer,
      path.join(dir, `out.${muxer}`),
    ]
    const result = await run(ff.ffmpeg, argv)
    expect(result.exitCode).toBe(234)
    expect(result.stderr).toContain(message)
  })
})

describe('fake ffmpeg: strict argv', () => {
  const SRC = '/tmp/dj-scraper-fake/in.mp3'
  const OUT = '/tmp/dj-scraper-fake/out.mp3'
  const GOOD = [...HEAD, ...input(SRC), '-map', '0:a:0', '-c:a', 'copy', '-f', 'mp3', OUT]
  const swap = (from: string, to: string[]) =>
    GOOD.flatMap((token) => (token === from ? to : [token]))
  const drop = (...tokens: string[]) => GOOD.filter((token) => !tokens.includes(token))

  it.each([
    ['an unknown option', [...GOOD.slice(0, -1), '-af', 'volume=2', OUT], 'unknown option -af'],
    ['-y', ['-y', ...GOOD], '-y would overwrite'],
    ['no -n', drop('-n'), '-n is missing'],
    ['no -nostdin', drop('-nostdin'), '-nostdin is missing'],
    ['no -loglevel error', drop('-loglevel', 'error'), '-loglevel error is missing'],
    [
      'an input without -protocol_whitelist file',
      drop('-protocol_whitelist', 'file'),
      '-protocol_whitelist file is missing',
    ],
    ['a relative input', swap(SRC, ['in.mp3']), 'an input must be an absolute path'],
    ['a relative output', swap(OUT, ['out.mp3']), 'the output must be an absolute path'],
    ['no -f for the output', drop('-f', 'mp3'), 'the output has no -f'],
    ['no -map', drop('-map', '0:a:0'), 'no -map'],
    ['an untyped -map', swap('0:a:0', ['0']), 'use typed specs'],
    ['a -map of a missing input', swap('0:a:0', ['1:a:0']), 'there is no input 1'],
    ['a mapped audio stream without -c:a', drop('-c:a', 'copy'), 'without -c:a'],
    ['-ac with -c:a copy', swap('copy', ['copy', '-ac', '2']), '-ac with -c:a copy'],
    [
      'an encode without -xerror',
      swap('copy', ['libmp3lame', '-b:a', '320k']),
      '-xerror is missing',
    ],
    ['an unknown encoder', swap('copy', ['libshine']), 'unknown audio encoder libshine'],
    ['an unknown muxer', swap('mp3', ['mp2']), 'unknown muxer -f mp2'],
    ['an output option before -i', ['-map', '0:a:0', ...GOOD], '-map is an output option'],
    ['two outputs', [...GOOD, OUT], 'expected one output file, got 2'],
    ['options after the output', [...GOOD, '-f', 'mp3'], 'options after the output file'],
  ])('exits 2 on %s', async (_why, argv, message) => {
    const ff = await fake()
    const result = await run(ff.ffmpeg, argv)
    expect(result).toMatchObject({ exitCode: 2, stdout: '' })
    expect(result.stderr).toMatch(/^fake-ffmpeg: .+\n$/)
    expect(result.stderr).toContain(message)
  })

  it.each([
    [
      'no -of json',
      probeArgv(SRC).filter((token) => token !== '-of' && token !== 'json'),
      '-of json is missing',
    ],
    [
      'other -show_entries',
      probeArgv(SRC).map((t) => (t === ENTRIES ? 'format=duration' : t)),
      'recorded with -show_entries',
    ],
    ['no -v error', probeArgv(SRC).slice(2), '-v error is missing'],
    ['two files', [...probeArgv(SRC), OUT], 'expected one input file, got 2'],
    ['a relative file', [...probeArgv(SRC).slice(0, -1), 'in.mp3'], 'must be an absolute path'],
    ['an unknown option', ['-show_streams', ...probeArgv(SRC)], 'unknown option -show_streams'],
  ])('ffprobe exits 2 on %s', async (_why, argv, message) => {
    const ff = await fake()
    const result = await run(ff.ffprobe, argv)
    expect(result).toMatchObject({ exitCode: 2, stdout: '' })
    expect(result.stderr).toMatch(/^fake-ffprobe: .+\n$/)
    expect(result.stderr).toContain(message)
  })

  it('answers a missing file like ffprobe: the path and the reason, exit 1', async () => {
    const ff = await fake()
    const missing = path.join(root, 'nothing-here.mp3')
    expect(await run(ff.ffprobe, probeArgv(missing))).toMatchObject({
      exitCode: 1,
      stdout: '',
      stderr: `${missing}: No such file or directory\n`,
    })
  })
})

describe('fake ffmpeg: knobs', () => {
  const mp3Argv = (src: string, out: string) => [
    ...HEAD,
    ...input(src),
    '-map',
    '0:a:0',
    '-c:a',
    'copy',
    '-f',
    'mp3',
    out,
  ]
  const tagArgv = (src: string, out: string) => [
    ...HEAD,
    ...input(src),
    '-map',
    '0:a:0',
    '-c:a',
    'copy',
    ...YT_TAGS,
    '-f',
    'ipod',
    out,
  ]

  /** Polls until `file` exists: a hanging ffmpeg has written its 0-byte output by then. */
  async function waitForFile(file: string): Promise<void> {
    const deadline = Date.now() + 10_000
    while (!existsSync(file)) {
      if (Date.now() > deadline) throw new Error(`${file} never appeared`)
      await delay(10)
    }
  }

  it('fails every ffmpeg pass with FAKE_FFMPEG_FAIL, writing nothing, while ffprobe works', async () => {
    const ff = await fake({ FAKE_FFMPEG_FAIL: '234:[mp3 @ 0x1] Invalid audio stream.' })
    const dir = await jobDir()
    const src = await source(dir, 'in.mp3', SOURCES.mp3)
    const out = path.join(dir, 'out.mp3')
    expect(await run(ff.ffmpeg, mp3Argv(src, out))).toMatchObject({
      exitCode: 234,
      stderr: '[mp3 @ 0x1] Invalid audio stream.\n',
    })
    expect(existsSync(out)).toBe(false)
    expect((await run(ff.ffprobe, probeArgv(src))).exitCode).toBe(0)
  })

  it('scopes FAKE_FFMPEG_FAIL to the cover pass, or to ffprobe', async () => {
    const dir = await jobDir()
    const src = await source(dir, 'in.mp3', SOURCES.mp3)
    const thumb = await image(dir, 'thumb.png', 'png', [100, 100])
    const cover = [
      ...HEAD,
      '-xerror',
      ...input(thumb, 'png_pipe'),
      '-map',
      '0:v:0',
      '-c:v',
      'mjpeg',
      '-f',
      'image2',
      path.join(dir, 'cover.jpg'),
    ]
    const covers = await fake({ FAKE_FFMPEG_FAIL: 'cover@1:No JPEG data found in image' })
    expect(await run(covers.ffmpeg, cover)).toMatchObject({ exitCode: 1 })
    expect((await run(covers.ffmpeg, mp3Argv(src, path.join(dir, 'a.mp3')))).exitCode).toBe(0)

    const probes = await fake({ FAKE_FFMPEG_FAIL: 'ffprobe@1:broken' })
    expect(await run(probes.ffprobe, probeArgv(src))).toMatchObject({
      exitCode: 1,
      stdout: '',
      stderr: 'broken\n',
    })
    expect((await run(probes.ffmpeg, mp3Argv(src, path.join(dir, 'b.mp3')))).exitCode).toBe(0)
  })

  it('hangs with FAKE_FFMPEG_HANG after opening a 0-byte output, until SIGINT (exit 255)', async () => {
    const ff = await fake({ FAKE_FFMPEG_HANG: '1' })
    const dir = await jobDir()
    const src = await source(dir, 'in.mp3', SOURCES.mp3)
    const out = path.join(dir, 'out.mp3')
    const controller = new AbortController()
    const running = run(ff.ffmpeg, mp3Argv(src, out), { signal: controller.signal })
    await waitForFile(out)
    controller.abort()
    expect(await running).toMatchObject({ aborted: true, exitCode: 255, signal: null, stderr: '' })
    expect(await readFile(out, 'utf8')).toBe('')
  })

  it('hangs ffprobe with FAKE_FFMPEG_HANG=ffprobe@1', async () => {
    const ff = await fake({ FAKE_FFMPEG_HANG: 'ffprobe@1' })
    const dir = await jobDir()
    const src = await source(dir, 'in.mp3', SOURCES.mp3)
    expect((await run(ff.ffmpeg, mp3Argv(src, path.join(dir, 'out.mp3')))).exitCode).toBe(0)
    const controller = new AbortController()
    const running = run(ff.ffprobe, probeArgv(src), { signal: controller.signal })
    // The fake installs its SIGINT handler before it logs the call, so it answers from then on.
    await ff.waitForCalls(2)
    controller.abort()
    expect(await running).toMatchObject({ aborted: true, exitCode: 255, stdout: '' })
  })

  it('writes half the duration with FAKE_FFMPEG_SHORT, or makes ffprobe report half', async () => {
    const dir = await jobDir()
    const src = await source(dir, 'in.mp3', SOURCES.mp3)
    const short = await fake({ FAKE_FFMPEG_SHORT: '1' })
    const out = path.join(dir, 'short.mp3')
    expect((await run(short.ffmpeg, mp3Argv(src, out))).exitCode).toBe(0)
    expect((await audioOf(out)).header.durationSec).toBeCloseTo(9.873991 / 2, 6)
    // Unscoped, it doesn't touch what ffprobe reports for a full file.
    expect((await probe(short, src)).format.duration).toBe('9.873991')

    const probes = await fake({ FAKE_FFMPEG_SHORT: 'ffprobe@1' })
    expect((await probe(probes, src)).format.duration).toBe('4.936996')
  })

  it('writes no tags with FAKE_FFMPEG_DROP_TAGS, or makes ffprobe report none', async () => {
    const dir = await jobDir()
    const src = await source(dir, 'in.m4a', SOURCES.m4a)
    const drops = await fake({ FAKE_FFMPEG_DROP_TAGS: 'audio@1' })
    const out = path.join(dir, 'dropped.m4a')
    expect((await run(drops.ffmpeg, tagArgv(src, out))).exitCode).toBe(0)
    expect((await audioOf(out)).header.tags).toEqual({})

    const tagged = path.join(dir, 'tagged.m4a')
    const plain = await fake()
    expect((await run(plain.ffmpeg, tagArgv(src, tagged))).exitCode).toBe(0)
    expect((await probe(plain, tagged)).format.tags).toHaveProperty('title', 'Me at the zoo')
    const probes = await fake({ FAKE_FFMPEG_DROP_TAGS: 'ffprobe@1' })
    expect((await probe(probes, tagged)).format.tags).toEqual({
      major_brand: 'M4A ',
      minor_version: '512',
      compatible_brands: 'M4A isomiso2',
      encoder: 'Lavf62.3.100',
    })
  })

  it('logs every ffmpeg and ffprobe call, in order, to one file', async () => {
    const ff = await fake()
    const dir = await jobDir()
    const src = await source(dir, 'in.mp3', SOURCES.mp3)
    const argv = mp3Argv(src, path.join(dir, 'out.mp3'))
    const version = await run(ff.ffmpeg, ['-version'])
    const copy = await run(ff.ffmpeg, argv)
    const probed = await run(ff.ffprobe, probeArgv(src))
    const calls = await ff.calls()
    expect(calls).toMatchObject([
      { tool: 'ffmpeg', argv: ['-version'], pid: version.pid },
      { tool: 'ffmpeg', argv, pid: copy.pid },
      { tool: 'ffprobe', argv: probeArgv(src), pid: probed.pid },
    ])
  })

  it('reads knobs from the environment when the file beside the link sets none', async () => {
    const ff = await fake()
    const dir = await jobDir()
    const src = await source(dir, 'in.mp3', SOURCES.mp3)
    const result = await run(ff.ffmpeg, mp3Argv(src, path.join(dir, 'out.mp3')), {
      env: { ...process.env, FAKE_FFMPEG_FAIL: '1:from the env' },
    })
    expect(result).toMatchObject({ exitCode: 1, stderr: 'from the env\n' })
  })

  it.each([
    ['FAKE_FFMPEG_HANG', 'true', 'FAKE_FFMPEG_HANG must be [scopes@]1 or 0'],
    ['FAKE_FFMPEG_FAIL', 'oops', 'FAKE_FFMPEG_FAIL must be [scopes@]<exit 0-255>:<stderr text>'],
    ['FAKE_FFMPEG_FAIL', '300:too big', 'FAKE_FFMPEG_FAIL must be [scopes@]<exit 0-255>'],
    ['FAKE_FFMPEG_SHORT', 'cover@1', "FAKE_FFMPEG_SHORT: scope cover isn't one of audio, ffprobe"],
    ['FAKE_FFMPEG_DROP_TAGS', 'video@1', "FAKE_FFMPEG_DROP_TAGS: scope video isn't one of"],
  ])('exits 2 on %s=%s instead of guessing', async (name, value, message) => {
    const ff = await fake({ [name]: value })
    const result = await run(ff.ffprobe, probeArgv('/tmp/x.mp3'))
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain(`fake-ffprobe: ${message}`)
  })

  it('exits 2 on an unknown knob in the file beside the link', async () => {
    const ff = await fake()
    await writeFile(
      path.join(path.dirname(ff.ffmpeg), '.ffmpeg.fake.json'),
      JSON.stringify({ FAKE_FFMPEG_SLOW: '1' }),
    )
    const result = await run(ff.ffmpeg, ['-version'])
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('unknown knob or non-string value: FAKE_FFMPEG_SLOW')
  })
})

describe('fake engine: a download through yt-dlp, ffprobe and ffmpeg', () => {
  it('downloads, probes the source as recorded, converts it, and passes the health check', async () => {
    const engine = await writeFakeEngine(path.join(root, `engine-${++count}`), {
      ffmpegEnv: { FAKE_FFMPEG_FAIL: 'cover@234:not in this test' },
    })
    expect(engine.env).toMatchObject({
      YTDLP_PATH: path.join(engine.binDir, 'yt-dlp'),
      FFMPEG_PATH: path.join(engine.binDir, 'ffmpeg'),
      FAKE_FFMPEG_FAIL: 'cover@234:not in this test',
    })
    const health = await checkHealth(
      { YTDLP_PATH: engine.env.YTDLP_PATH, FFMPEG_PATH: engine.env.FFMPEG_PATH },
      new Date(),
    )
    expect(health.ok).toBe(true)

    const dir = await jobDir()
    const url = 'https://www.youtube.com/watch?v=jNQXAC9IVRw'
    const argv = downloadArgs({
      url,
      platform: 'youtube',
      format: 'm4a',
      jobDir: dir,
      writeThumbnail: false,
      jsRuntime: process.execPath,
      ffmpegLocation: engine.ffmpeg.ffmpeg,
    })
    const download = await run(engine.ytdlp.path, argv)
    expect(download.exitCode, download.stderr).toBe(0)
    const m4a = path.join(dir, 'jNQXAC9IVRw.m4a')
    expect(await probe(engine.ffmpeg, m4a)).toEqual(ffprobeFixture('src-youtube-140-m4a.json'))

    const out = path.join(dir, 'out.m4a')
    const convert = await run(engine.ffmpeg.ffmpeg, [
      ...HEAD,
      ...input(m4a),
      '-map',
      '0:a:0',
      '-c:a',
      'copy',
      ...YT_TAGS,
      '-movflags',
      '+faststart',
      '-f',
      'ipod',
      out,
    ])
    expect(convert).toMatchObject({ exitCode: 0, stderr: '' })
    const probed = await probe(engine.ffmpeg, out)
    expect(probed.streams).toMatchObject([{ codec_name: 'aac', bit_rate: '127999' }])
    expect(probed.format).toMatchObject({ duration: '19.063583', tags: { artist: 'jawed' } })

    expect((await engine.ytdlp.calls()).map((call) => call.url)).toEqual([null, url])
    const tools = (await engine.ffmpeg.calls()).map((call) => call.tool)
    // The health check probes ffmpeg and ffprobe in parallel.
    expect(tools.slice(0, 2).sort()).toEqual(['ffmpeg', 'ffprobe'])
    expect(tools.slice(2)).toEqual(['ffprobe', 'ffmpeg', 'ffprobe'])
  })
})
