// The fake media files that the fake engine writes and reads (fake-yt-dlp.mjs, fake-ffmpeg.mjs).
// Not a test file and not executable: both fakes import it. test/helpers.ts has a TS reader and
// writer for the same format, so tests check the fakes against an independent parser.
//
// Audio: `FAKEAUDIO <json>\n` + payload bytes. The JSON header says what ffprobe reports:
//   { probe, codec, durationSec, estimatedSec?, sampleRate, channels, bitRate?, tags, cover }
//   probe   the recorded ffprobe JSON it is based on: relative to test/fixtures
//           ('ffprobe/src-youtube-251-webm.json'), absolute, or 'synthetic:ogg' (no recording)
//   codec   ffprobe's codec_name; bitRate in bit/s, when the stream has one
//   durationSec   the real length, which ffmpeg's measuring pass reports and its outputs keep
//   estimatedSec  what ffprobe reports instead, when it estimates (an MP3 without a Xing header,
//           ffprobe/src-mp3-vbr-noxing.json); outputs never carry one
//   tags    what ffmpeg wrote with -metadata (the recorded JSON's own muxer tags stay)
//   cover   whether an attached picture stream is in the file
// AIFF (`ffmpeg -f aiff`): a real IFF container, `FORM` + BE32 size + `AIFF` + one `FAKE` chunk
//   holding the audio bytes above (+ a pad byte when odd), so appending an `ID3 ` chunk and
//   rewriting the FORM size works like on a real AIFF.
// A leading ID3v2 tag (our tag writer prepends one to MP3s) is skipped by its syncsafe size.
// Images: the format's magic bytes, then `FAKEIMAGE <json>\n` ({ format, width, height, probe? }):
//   jpeg FF D8 FF E0 … FF D9, png 89 50 4E 47 0D 0A 1A 0A …, webp `RIFF` + LE32 size + `WEBP` ….
//
// Readers are stricter than ffprobe where our own byte edits could go wrong: a FORM size that isn't
// the file length - 8, a chunk past the end, or an ID3v2 tag whose size doesn't fit is invalid data.

import { readFileSync } from 'node:fs'
import path from 'node:path'

/** A broken call or test setup: the fakes exit 2 with their name and the message. */
export class UsageError extends Error {}

export const FIXTURES = path.join(import.meta.dirname, 'fixtures')

export const fixturePath = (file) => (path.isAbsolute(file) ? file : path.join(FIXTURES, file))

export const isObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export function readJson(file) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    throw new UsageError(`cannot read ${file}: ${error.code ?? error.message}`)
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new UsageError(`${file} is not JSON: ${error.message}`)
  }
}

const AUDIO_MAGIC = Buffer.from('FAKEAUDIO ')
const IMAGE_MAGIC = Buffer.from('FAKEIMAGE ')
const JPEG_HEAD = Buffer.from([0xff, 0xd8, 0xff, 0xe0])
const JPEG_TAIL = Buffer.from([0xff, 0xd9])
const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** File extension → image format, for yt-dlp's thumbnails. */
export const IMAGE_EXTENSIONS = { jpg: 'jpeg', jpeg: 'jpeg', png: 'png', webp: 'webp' }

/** The header of a downloaded file that ffprobe reports as `probe` says (a recorded source). */
export function sourceHeader(probe) {
  const json = readJson(fixturePath(probe))
  const audio = Array.isArray(json?.streams)
    ? json.streams.find((stream) => stream?.codec_type === 'audio')
    : undefined
  const duration = Number(json?.format?.duration)
  const sampleRate = Number(audio?.sample_rate)
  if (audio === undefined || !(duration >= 0) || !(sampleRate > 0) || !(audio.channels > 0)) {
    throw new UsageError(`${probe}: not an ffprobe JSON with an audio stream and a duration`)
  }
  const header = {
    probe,
    codec: audio.codec_name,
    durationSec: duration,
    sampleRate,
    channels: audio.channels,
    tags: {},
    cover: false,
  }
  if (audio.bit_rate !== undefined) header.bitRate = Number(audio.bit_rate)
  return header
}

function checkHeader(header) {
  return (
    isObject(header) &&
    typeof header.probe === 'string' &&
    typeof header.codec === 'string' &&
    typeof header.durationSec === 'number' &&
    header.durationSec >= 0 &&
    (header.estimatedSec === undefined ||
      (typeof header.estimatedSec === 'number' && header.estimatedSec >= 0)) &&
    Number.isInteger(header.sampleRate) &&
    header.sampleRate > 0 &&
    Number.isInteger(header.channels) &&
    header.channels > 0 &&
    (header.bitRate === undefined || (typeof header.bitRate === 'number' && header.bitRate > 0)) &&
    isObject(header.tags) &&
    Object.values(header.tags).every((value) => typeof value === 'string') &&
    typeof header.cover === 'boolean'
  )
}

export const audioBytes = (header, payload) =>
  Buffer.concat([AUDIO_MAGIC, Buffer.from(`${JSON.stringify(header)}\n`), payload])

/** An AIFF: FORM + one FAKE chunk with the audio bytes, padded to an even length. */
export function aiffBytes(header, payload) {
  const data = audioBytes(header, payload)
  const pad = data.length % 2
  const chunk = Buffer.alloc(8)
  chunk.write('FAKE', 0, 'latin1')
  chunk.writeUInt32BE(data.length, 4)
  const form = Buffer.alloc(12)
  form.write('FORM', 0, 'latin1')
  form.writeUInt32BE(4 + 8 + data.length + pad, 4)
  form.write('AIFF', 8, 'latin1')
  return Buffer.concat([form, chunk, data, Buffer.alloc(pad)])
}

export function imageBytes(info) {
  const body = Buffer.concat([IMAGE_MAGIC, Buffer.from(`${JSON.stringify(info)}\n`)])
  if (info.format === 'jpeg') return Buffer.concat([JPEG_HEAD, body, JPEG_TAIL])
  if (info.format === 'png') return Buffer.concat([PNG_HEAD, body])
  if (info.format === 'webp') {
    const riff = Buffer.alloc(12)
    riff.write('RIFF', 0, 'latin1')
    riff.writeUInt32LE(4 + body.length, 4)
    riff.write('WEBP', 8, 'latin1')
    return Buffer.concat([riff, body])
  }
  throw new UsageError(`no fake image format ${info.format}`)
}

const startsWith = (bytes, offset, magic) =>
  bytes.length >= offset + magic.length &&
  bytes.subarray(offset, offset + magic.length).equals(magic)
const ascii = (bytes, offset, length) => bytes.subarray(offset, offset + length).toString('latin1')

/** The image format by magic bytes, as finalize sniffs it. */
export function sniffImage(bytes) {
  if (startsWith(bytes, 0, Buffer.from([0xff, 0xd8, 0xff]))) return 'jpeg'
  if (startsWith(bytes, 0, PNG_HEAD)) return 'png'
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return 'webp'
  return undefined
}

/** The size of the ID3v2 tag at `offset` (header and footer included), 0 if none, -1 if broken. */
function id3Size(bytes, offset) {
  if (ascii(bytes, offset, 3) !== 'ID3') return 0
  if (bytes.length < offset + 10) return -1
  const size = bytes.subarray(offset + 6, offset + 10)
  if (size.some((byte) => byte > 0x7f)) return -1
  const body = (size[0] << 21) | (size[1] << 14) | (size[2] << 7) | size[3]
  const footer = (bytes[offset + 5] & 0x10) === 0 ? 0 : 10
  const total = 10 + body + footer
  return offset + total > bytes.length ? -1 : total
}

function parseAudio(bytes, container, id3Bytes) {
  const end = bytes.indexOf(0x0a)
  if (!startsWith(bytes, 0, AUDIO_MAGIC) || end === -1) return undefined
  let header
  try {
    header = JSON.parse(bytes.subarray(AUDIO_MAGIC.length, end).toString('utf8'))
  } catch {
    return undefined
  }
  if (!checkHeader(header)) return undefined
  return { kind: 'audio', header, payload: bytes.subarray(end + 1), container, id3Bytes }
}

function parseForm(bytes, offset) {
  if (bytes.length < offset + 12 || ascii(bytes, offset + 8, 4) !== 'AIFF') return undefined
  if (bytes.readUInt32BE(offset + 4) !== bytes.length - offset - 8) return undefined
  let audio
  for (let at = offset + 12; at < bytes.length; ) {
    if (at + 8 > bytes.length) return undefined
    const id = ascii(bytes, at, 4)
    const length = bytes.readUInt32BE(at + 4)
    const data = bytes.subarray(at + 8, at + 8 + length)
    if (data.length !== length) return undefined
    if (id === 'FAKE') audio = parseAudio(data, 'aiff', 0)
    if (id === 'ID3 ' && id3Size(data, 0) <= 0) return undefined
    at += 8 + length + (length % 2)
    if (at > bytes.length) return undefined
  }
  return audio
}

/**
 * What a fake media file holds: { kind: 'audio', header, payload, container, id3Bytes },
 * { kind: 'image', format, info }, or undefined when it is no fake media (invalid data).
 */
export function readMedia(bytes) {
  let offset = 0
  for (;;) {
    const size = id3Size(bytes, offset)
    if (size === -1) return undefined
    if (size === 0) break
    offset += size
  }
  if (ascii(bytes, offset, 4) === 'FORM') return parseForm(bytes, offset)
  if (startsWith(bytes, offset, AUDIO_MAGIC)) {
    return parseAudio(bytes.subarray(offset), 'plain', offset)
  }
  const format = offset === 0 ? sniffImage(bytes) : undefined
  if (format === undefined) return undefined
  const start = bytes.indexOf(IMAGE_MAGIC)
  const end = bytes.indexOf(0x0a, start)
  if (start === -1 || start > 16 || end === -1) return undefined
  let info
  try {
    info = JSON.parse(bytes.subarray(start + IMAGE_MAGIC.length, end).toString('utf8'))
  } catch {
    return undefined
  }
  if (!isObject(info) || info.format !== format) return undefined
  return { kind: 'image', format, info }
}
