/**
 * Pure: our own ID3v2.3 tag for MP3 and AIFF (design D2). ffmpeg 8 can't write a COMM frame (any
 * comment key becomes TXXX:comment, which DJ apps don't show), so finalize has ffmpeg write no tags
 * at all for these two formats and puts this tag in front of the MP3 / into the AIFF's `ID3 ` chunk.
 *
 * Layout, like ffmpeg's own v2.3 tags: text in ISO-8859-1 (encoding 0) when every character fits,
 * else UTF-16 with a BOM (encoding 1), each string NUL-terminated; plain big-endian frame sizes, a
 * syncsafe tag size, no unsynchronisation, no extended header; 2 KiB of padding so tag editors
 * (rekordbox, Mixed In Key) can add frames without rewriting the audio.
 */

/** The values the tag holds; finalize passes them through `cleanTagValue` first. */
export type Id3Tags = {
  title?: string
  artist?: string
  album?: string
  albumArtist?: string
  /** Four digits (TYER). */
  year?: string
  /** The source URL (COMM, language `eng`, empty description). */
  comment?: string
}

export type Id3Cover = { mime: 'image/jpeg' | 'image/png'; data: Uint8Array }

export const ID3_PADDING = 2048
/** The largest size a syncsafe integer holds (28 bits). */
const MAX_TAG_SIZE = 2 ** 28 - 1
/** APIC picture type "Cover (front)". */
const FRONT_COVER = 3

const TEXT_FRAMES = [
  ['TIT2', 'title'],
  ['TPE1', 'artist'],
  ['TALB', 'album'],
  ['TPE2', 'albumArtist'],
  ['TYER', 'year'],
] as const satisfies readonly (readonly [string, keyof Id3Tags])[]

/** A complete ID3v2.3 tag: header, frames in a fixed order, then the padding. */
export function id3v23Tag(tags: Id3Tags, cover?: Id3Cover): Uint8Array {
  const frames: Uint8Array[] = []
  for (const [id, key] of TEXT_FRAMES) {
    const value = tags[key]
    if (value !== undefined && value !== '') frames.push(textFrame(id, value))
  }
  if (tags.comment !== undefined && tags.comment !== '') frames.push(commentFrame(tags.comment))
  if (cover !== undefined) frames.push(pictureFrame(cover))

  const body = concat([...frames, new Uint8Array(ID3_PADDING)])
  if (body.length > MAX_TAG_SIZE) throw new RangeError('The ID3 tag is too large')
  const header = new Uint8Array(10)
  header.set(ascii('ID3'), 0)
  header[3] = 3 // v2.3.0
  header[4] = 0
  header[5] = 0 // flags: none
  header.set(syncsafe(body.length), 6)
  return concat([header, body])
}

/**
 * The tag as an AIFF chunk: `ID3 `, its big-endian length, the tag, and a pad byte when the length
 * is odd (chunks start on even offsets; the pad isn't counted in the chunk length).
 */
export function aiffId3Chunk(tag: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(8 + tag.length + (tag.length % 2))
  chunk.set(ascii('ID3 '), 0)
  new DataView(chunk.buffer).setUint32(4, tag.length)
  chunk.set(tag, 8)
  return chunk
}

/** The 12-byte header of an AIFF file: `FORM`, the size of what follows, `AIFF` (or `AIFC`). */
export function readAiffHeader(
  head: Uint8Array,
): { formSize: number; formType: 'AIFF' | 'AIFC' } | undefined {
  if (head.length < 12 || text(head, 0, 4) !== 'FORM') return undefined
  const formType = text(head, 8, 12)
  if (formType !== 'AIFF' && formType !== 'AIFC') return undefined
  const formSize = new DataView(head.buffer, head.byteOffset, head.byteLength).getUint32(4)
  return { formSize, formType }
}

/**
 * The FORM size for a file of `fileLength` bytes (everything after the 8-byte `FORM` + size), as the
 * 4 big-endian bytes to write at offset 4. Throws when the file is too large for AIFF (4 GiB).
 */
export function aiffFormSizeBytes(fileLength: number): Uint8Array {
  const size = fileLength - 8
  if (!Number.isSafeInteger(size) || size < 4 || size > 0xffff_ffff) {
    throw new RangeError('The AIFF file is too large')
  }
  const bytes = new Uint8Array(4)
  new DataView(bytes.buffer).setUint32(0, size)
  return bytes
}

function textFrame(id: string, value: string): Uint8Array {
  const encoding = encodingFor([value])
  return frame(id, concat([Uint8Array.of(encoding), encodeString(value, encoding)]))
}

function commentFrame(value: string): Uint8Array {
  const encoding = encodingFor([value])
  return frame(
    'COMM',
    concat([
      Uint8Array.of(encoding),
      ascii('eng'),
      encodeString('', encoding), // the short description: empty
      encodeString(value, encoding),
    ]),
  )
}

function pictureFrame(cover: Id3Cover): Uint8Array {
  return frame(
    'APIC',
    concat([
      Uint8Array.of(0),
      encodeString(cover.mime, 0),
      Uint8Array.of(FRONT_COVER),
      encodeString('', 0), // the description: empty
      cover.data,
    ]),
  )
}

function frame(id: string, data: Uint8Array): Uint8Array {
  const header = new Uint8Array(10)
  header.set(ascii(id), 0)
  new DataView(header.buffer).setUint32(4, data.length) // v2.3: a plain 32-bit size
  return concat([header, data])
}

/** ISO-8859-1 when every UTF-16 unit is below 0x100, else UTF-16 with a BOM. */
function encodingFor(values: readonly string[]): 0 | 1 {
  for (const value of values) {
    for (let i = 0; i < value.length; i++) {
      if (value.charCodeAt(i) > 0xff) return 1
    }
  }
  return 0
}

/** The string in the frame's encoding, NUL-terminated. */
function encodeString(value: string, encoding: 0 | 1): Uint8Array {
  if (encoding === 0) {
    const bytes = new Uint8Array(value.length + 1)
    for (let i = 0; i < value.length; i++) bytes[i] = value.charCodeAt(i)
    return bytes
  }
  // BOM FF FE (little-endian), the UTF-16 units, then 00 00.
  const bytes = new Uint8Array(2 + value.length * 2 + 2)
  bytes[0] = 0xff
  bytes[1] = 0xfe
  const view = new DataView(bytes.buffer)
  for (let i = 0; i < value.length; i++) view.setUint16(2 + i * 2, value.charCodeAt(i), true)
  return bytes
}

function syncsafe(size: number): Uint8Array {
  return Uint8Array.of((size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f)
}

function ascii(value: string): Uint8Array {
  return Uint8Array.from(value, (char) => char.charCodeAt(0))
}

function text(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end))
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}
