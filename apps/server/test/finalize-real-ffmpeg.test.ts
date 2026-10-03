// Finalize against the REAL ffmpeg/ffprobe on PATH (Homebrew), on audio and artwork made with
// lavfi. Not part of `pnpm test`: run it by hand after changing an argv or the ID3 writer:
//   DJS_TEST_REAL_FFMPEG=1 pnpm --filter @dj-scraper/server test finalize-real-ffmpeg
// No network, no yt-dlp. Checks that ffmpeg accepts our argv and that ffprobe (ffmpeg's own
// demuxers) reads our ID3v2.3 tag back from MP3 and AIFF.
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { classifyUrl, type DownloadFormat } from '@dj-scraper/shared'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { findOnPath } from '../src/engine/binaries.ts'
import { createFinalize } from '../src/engine/finalize.ts'
import { ffprobeArgs, type Probe, parseProbe } from '../src/engine/finalize-plan.ts'
import { killActiveGroups, run } from '../src/engine/run.ts'
import type { DoneInfo, FinalizeInput } from '../src/jobs/types.ts'
import {
  framesOf,
  readAiffTag,
  readComment,
  readMp3Tag,
  readPicture,
  textOf,
} from './id3-reader.ts'

const enabled = process.env.DJS_TEST_REAL_FFMPEG === '1'
const URL = 'https://www.youtube.com/watch?v=jNQXAC9IVRw'
const TITLE = 'Café Ñandú — 東京 Mix'
const ARTIST = 'Beyoncé & DJ "Q"'

describe.skipIf(!enabled)('finalize with the real ffmpeg', () => {
  let root: string
  let ffmpeg: string
  let ffprobe: string

  const tool = async (bin: string, argv: string[]) => {
    const result = await run(bin, argv, { timeoutMs: 60_000 })
    if (result.exitCode !== 0) throw new Error(`${path.basename(bin)} failed: ${result.stderr}`)
    return result
  }
  const probe = async (file: string): Promise<Probe> => {
    const parsed = parseProbe((await tool(ffprobe, ffprobeArgs(file))).stdout)
    if (parsed === undefined) throw new Error('no probe')
    return parsed
  }
  /** The decoded audio's MD5: equal for a stream copied as is. */
  const audioMd5 = async (file: string) =>
    (
      await tool(ffmpeg, [
        '-v',
        'error',
        '-i',
        file,
        '-map',
        '0:a:0',
        '-c',
        'copy',
        '-f',
        'md5',
        '-',
      ])
    ).stdout

  beforeAll(async () => {
    ffmpeg = (await findOnPath('ffmpeg', process.env.PATH)) ?? ''
    ffprobe = (await findOnPath('ffprobe', process.env.PATH)) ?? ''
    expect(ffmpeg).not.toBe('')
    expect(ffprobe).not.toBe('')
    root = await realpath(await mkdtemp(path.join(tmpdir(), 'dj-scraper-real-ffmpeg-')))
  })

  afterEach(() => killActiveGroups())

  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  /** A job dir with a 5 s stereo tone in `container` and a 1280×720 WebP thumbnail. */
  async function job(source: { ext: string; codec: string[]; format: string }) {
    return jobWith(source.ext, 5, (media) =>
      tool(ffmpeg, [
        ...['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5:sample_rate=48000'],
        ...['-ac', '2', ...source.codec, '-f', source.format, media],
      ]),
    )
  }

  /** A job dir with the download `make` writes (`durationSec` long) and a WebP thumbnail. */
  async function jobWith(
    ext: string,
    durationSec: number,
    make: (media: string) => Promise<unknown>,
  ) {
    const jobDir = path.join(root, 'jobs', randomUUID())
    await mkdir(jobDir, { recursive: true })
    const media = path.join(jobDir, `src.${ext}`)
    await make(media)
    const thumbnail = path.join(jobDir, 'src.webp')
    await tool(ffmpeg, [
      ...['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:duration=1'],
      ...['-frames:v', '1', '-c:v', 'libwebp', '-f', 'webp', thumbnail],
    ])
    const done: DoneInfo = {
      id: 'src',
      filepath: media,
      durationSec,
      title: `${ARTIST} - ${TITLE}`,
      uploader: 'Uploader',
      webpageUrl: URL,
      availability: 'public',
      releaseYear: 2024,
      thumbnailPath: thumbnail,
      thumbnailUrl: 'https://i.ytimg.com/vi_webp/jNQXAC9IVRw/maxresdefault.webp',
    }
    return { jobDir, media, done }
  }

  const webm = { ext: 'webm', codec: ['-c:a', 'libopus', '-b:a', '128k'], format: 'webm' }
  const m4a = { ext: 'm4a', codec: ['-c:a', 'aac', '-b:a', '128k'], format: 'mp4' }
  const mp3 = { ext: 'mp3', codec: ['-c:a', 'libmp3lame', '-b:a', '128k'], format: 'mp3' }

  function input(jobDir: string, done: DoneInfo, format: DownloadFormat): FinalizeInput {
    const classified = classifyUrl(URL)
    if (!classified.ok) throw new Error('url')
    return {
      jobDir,
      bins: { ffmpeg, ffprobe },
      done,
      input: classified,
      platform: 'youtube',
      format,
      options: {
        filenameTemplate: '{artist} - {title} ({year})',
        embedArtwork: true,
        sourceUrlComment: true,
      },
      nameMaxBytes: 996,
      signal: new AbortController().signal,
    }
  }

  const finalize = createFinalize({ log: { info: () => {}, warn: () => {}, error: () => {} } })

  it('MP3 from Opus: 320 kbps, our ID3 tag read back by ffprobe, cover as APIC', async () => {
    const { jobDir, done } = await job(webm)
    const result = await finalize(input(jobDir, done, 'mp3'))
    expect(result.name).toBe(`Beyoncé & DJ 'Q' - Café Ñandú — 東京 Mix (2024).mp3`)
    expect(result.output).toMatchObject({
      codec: 'mp3',
      bitrateKbps: 320,
      sampleRateHz: 48000,
      encoded: true,
    })

    const { tag } = await readMp3Tag(result.file)
    expect(tag.version).toEqual([3, 0])
    expect(textOf(tag, 'TIT2')).toBe(TITLE)
    expect(textOf(tag, 'TPE1')).toBe(ARTIST)
    expect(textOf(tag, 'TYER')).toBe('2024')
    expect(readComment(framesOf(tag, 'COMM')[0] ?? fail())).toMatchObject({
      language: 'eng',
      text: URL,
    })
    const picture = readPicture(framesOf(tag, 'APIC')[0] ?? fail())
    expect(Array.from(picture.data.subarray(0, 3))).toEqual([0xff, 0xd8, 0xff])

    const back = await probe(result.file)
    expect(back.tags).toMatchObject({ title: TITLE, artist: ARTIST, comment: URL, date: '2024' })
    expect(back.streams.some((stream) => stream.attachedPic && stream.codec === 'mjpeg')).toBe(true)
    expect(back.durationSec).toBeCloseTo(5, 0)
  })

  it('MP3 from MP3: copied, the audio packets untouched by our tag', async () => {
    const { jobDir, media, done } = await job(mp3)
    const result = await finalize(input(jobDir, done, 'mp3'))
    expect(result.output).toMatchObject({ codec: 'mp3', bitrateKbps: 128, encoded: false })
    expect(await audioMd5(result.file)).toBe(await audioMd5(media))
  })

  it('M4A from AAC: copied, tags and cover written by ffmpeg', async () => {
    const { jobDir, media, done } = await job(m4a)
    const result = await finalize(input(jobDir, done, 'm4a'))
    expect(result.output).toMatchObject({ codec: 'aac', encoded: false })
    expect(await audioMd5(result.file)).toBe(await audioMd5(media))
    const back = await probe(result.file)
    expect(back.tags).toMatchObject({
      title: TITLE,
      artist: ARTIST,
      comment: URL,
      major_brand: 'M4A ',
    })
    expect(back.streams.some((stream) => stream.attachedPic)).toBe(true)
  })

  it('FLAC from Opus: 16-bit at 48 kHz with its cover', async () => {
    const { jobDir, done } = await job(webm)
    const result = await finalize(input(jobDir, done, 'flac'))
    expect(result.output).toMatchObject({ codec: 'flac', sampleRateHz: 48000, encoded: true })
    const back = await probe(result.file)
    expect(back.tags).toMatchObject({ title: TITLE, artist: ARTIST, comment: URL })
    expect(back.streams.some((stream) => stream.attachedPic)).toBe(true)
  })

  it('WAV from AAC: PCM with INFO tags, no cover', async () => {
    const { jobDir, done } = await job(m4a)
    const result = await finalize(input(jobDir, done, 'wav'))
    expect(result.output).toMatchObject({ codec: 'pcm_s16le', encoded: true })
    expect((await probe(result.file)).tags).toMatchObject({ title: TITLE, artist: ARTIST })
  })

  it('AIFF from Opus: our ID3 chunk, read back by ffprobe with its cover', async () => {
    const { jobDir, done } = await job(webm)
    const result = await finalize(input(jobDir, done, 'aiff'))
    expect(result.output).toMatchObject({ codec: 'pcm_s16be', sampleRateHz: 48000, encoded: true })
    const { tag, chunks } = await readAiffTag(result.file)
    expect(chunks.at(-1)?.id).toBe('ID3 ')
    expect(textOf(tag, 'TIT2')).toBe(TITLE)
    const back = await probe(result.file)
    expect(back.tags).toMatchObject({ title: TITLE, artist: ARTIST, comment: URL })
    expect(back.streams.some((stream) => stream.attachedPic)).toBe(true)
    expect(back.durationSec).toBeCloseTo(5, 0)
  })

  it('original from Opus WebM: the stream kept as WebM with tags', async () => {
    const { jobDir, media, done } = await job(webm)
    const result = await finalize(input(jobDir, done, 'original'))
    expect(result.output).toMatchObject({ ext: 'webm', codec: 'opus', encoded: false })
    expect(await audioMd5(result.file)).toBe(await audioMd5(media))
    expect((await probe(result.file)).tags).toMatchObject({
      title: TITLE,
      artist: ARTIST,
      comment: URL,
    })
  })

  // A podcast host's VBR MP3 without a Xing header: 10 s of silence (32 kbps frames), then 50 s
  // of noise. ffprobe estimates its length from the first frame (fixtures/ffprobe/src-mp3-vbr-noxing).
  const vbrNoXing = (media: string) =>
    tool(ffmpeg, [
      ...['-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo:d=10'],
      ...['-f', 'lavfi', '-i', 'anoisesrc=d=50:c=pink:r=44100:a=0.3'],
      ...['-filter_complex', '[0:a][1:a]concat=n=2:v=0:a=1', '-ac', '2'],
      ...['-c:a', 'libmp3lame', '-q:a', '0', '-write_xing', '0', '-f', 'mp3', media],
    ])

  it.each(['mp3', 'm4a', 'flac', 'original'] as const)(
    'a VBR MP3 without a Xing header → %s: checked against its measured length',
    async (format) => {
      const { jobDir, media, done } = await jobWith('mp3', 60, vbrNoXing)
      // The premise: ffprobe's estimate is far off.
      expect((await probe(media)).durationSec).toBeGreaterThan(120)
      const result = await finalize(input(jobDir, done, format))
      expect((await probe(result.file)).durationSec).toBeCloseTo(60, 0)
    },
  )

  it('a VBR MP3 without a Xing header that lost its end still fails as incomplete', async () => {
    const { jobDir, done } = await jobWith('mp3', 90, vbrNoXing)
    await expect(finalize(input(jobDir, done, 'm4a'))).rejects.toMatchObject({ code: 'network' })
  })

  // Dynamic ad insertion: an ad MP3 and the episode concatenated, the episode keeping its ID3v2
  // tag, which then sits mid-stream ("Header missing": fatal with -xerror, skipped without).
  const stitched = async (media: string) => {
    const part = async (name: string, frequency: number, duration: number) => {
      const file = path.join(path.dirname(media), name)
      await tool(ffmpeg, [
        ...['-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=${frequency}:duration=${duration}`],
        ...['-ac', '2', '-c:a', 'libmp3lame', '-b:a', '128k', '-f', 'mp3', file],
      ])
      return readFile(file)
    }
    const { writeFile } = await import('node:fs/promises')
    await writeFile(
      media,
      Buffer.concat([await part('ad.mp3', 880, 3), await part('ep.mp3', 440, 5)]),
    )
  }

  it.each(['m4a', 'flac', 'wav', 'aiff', 'mp3'] as const)(
    'a stitched MP3 with an ID3 tag mid-stream → %s',
    async (format) => {
      const { jobDir, done } = await jobWith('mp3', 8, stitched)
      const result = await finalize(input(jobDir, done, format))
      expect(result.output.ext).toBe(format)
      expect((await probe(result.file)).durationSec).toBeCloseTo(8, 0)
    },
  )

  it('a truncated WebM download fails verification instead of passing as done', async () => {
    const { jobDir, media, done } = await job(webm)
    const bytes = await readFile(media)
    const { writeFile } = await import('node:fs/promises')
    await writeFile(media, bytes.subarray(0, Math.floor(bytes.length / 3)))
    await expect(finalize(input(jobDir, done, 'mp3'))).rejects.toMatchObject({
      code: 'postprocess_failed',
    })
  })
})

function fail(): never {
  throw new Error('missing')
}
