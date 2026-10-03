// A test-side ID3v2.3 and AIFF reader, written independently of src/engine/id3.ts so the tests
// check the writer against the spec (id3.org v2.3.0), not against itself. Not a test file.
import { readFile } from 'node:fs/promises'

export type Id3Frame = { id: string; flags: number; data: Uint8Array }
export type Id3Comment = { encoding: number; language: string; description: string; text: string }
export type Id3Picture = {
  encoding: number
  mime: string
  type: number
  description: string
  data: Uint8Array
}

export type Id3Tag = {
  /** [major, revision], e.g. [3, 0]. */
  version: [number, number]
  flags: number
  /** The syncsafe size from the header: frames + padding, without the 10-byte header. */
  size: number
  frames: Id3Frame[]
  /** Zero bytes after the last frame. */
  padding: number
  /** The whole tag's length, header included. */
  length: number
}

/** Reads the ID3v2.3 tag at `offset`; throws on anything the v2.3 spec doesn't allow. */
export function readId3(bytes: Uint8Array, offset = 0): Id3Tag {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (latin1(bytes.subarray(offset, offset + 3)) !== 'ID3') throw new Error('no ID3 header')
  const version: [number, number] = [bytes[offset + 3] ?? -1, bytes[offset + 4] ?? -1]
  const flags = bytes[offset + 5] ?? 0
  const sizeBytes = Array.from(bytes.subarray(offset + 6, offset + 10))
  if (sizeBytes.some((byte) => byte > 0x7f)) throw new Error('size is not syncsafe')
  const size = sizeBytes.reduce((sum, byte) => (sum << 7) | byte, 0)
  const end = offset + 10 + size
  if (end > bytes.length) throw new Error('tag runs past the data')

  const frames: Id3Frame[] = []
  let at = offset + 10
  while (at + 10 <= end && bytes[at] !== 0) {
    const id = latin1(bytes.subarray(at, at + 4))
    if (!/^[A-Z0-9]{4}$/.test(id)) throw new Error(`bad frame id ${JSON.stringify(id)}`)
    const frameSize = view.getUint32(at + 4)
    const frameFlags = view.getUint16(at + 8)
    const dataEnd = at + 10 + frameSize
    if (dataEnd > end) throw new Error(`frame ${id} runs past the tag`)
    frames.push({ id, flags: frameFlags, data: bytes.slice(at + 10, dataEnd) })
    at = dataEnd
  }
  const rest = bytes.subarray(at, end)
  if (rest.some((byte) => byte !== 0)) throw new Error('non-zero bytes after the frames')
  return { version, flags, size, frames, padding: rest.length, length: 10 + size }
}

/** The frames with this id. */
export const framesOf = (tag: Id3Tag, id: string): Id3Frame[] =>
  tag.frames.filter((frame) => frame.id === id)

/** A text frame (T***) as [encoding, text]; the terminator, if any, is dropped. */
export function readTextFrame(frame: Id3Frame): { encoding: number; text: string } {
  const encoding = frame.data[0] ?? -1
  const [text] = readStrings(frame.data.subarray(1), encoding, 1, true)
  return { encoding, text: text ?? '' }
}

/** The text of the only frame with this id, or undefined. */
export function textOf(tag: Id3Tag, id: string): string | undefined {
  const [frame, ...more] = framesOf(tag, id)
  if (more.length > 0) throw new Error(`more than one ${id}`)
  return frame === undefined ? undefined : readTextFrame(frame).text
}

export function readComment(frame: Id3Frame): Id3Comment {
  const encoding = frame.data[0] ?? -1
  const language = latin1(frame.data.subarray(1, 4))
  const [description, text] = readStrings(frame.data.subarray(4), encoding, 2, true)
  return { encoding, language, description: description ?? '', text: text ?? '' }
}

export function readPicture(frame: Id3Frame): Id3Picture {
  const encoding = frame.data[0] ?? -1
  const mimeEnd = frame.data.indexOf(0, 1)
  if (mimeEnd < 0) throw new Error('APIC: unterminated MIME type')
  const mime = latin1(frame.data.subarray(1, mimeEnd))
  const type = frame.data[mimeEnd + 1] ?? -1
  const rest = frame.data.subarray(mimeEnd + 2)
  const { value: description, next } = readTerminated(rest, encoding)
  return { encoding, mime, type, description, data: rest.slice(next) }
}

/** `count` encoded strings; the last one may lack its terminator when `lastOptional`. */
function readStrings(
  bytes: Uint8Array,
  encoding: number,
  count: number,
  lastOptional: boolean,
): string[] {
  const out: string[] = []
  let rest = bytes
  for (let i = 0; i < count; i++) {
    const last = i === count - 1
    const { value, next, terminated } = readTerminated(rest, encoding)
    if (!terminated && !(last && lastOptional)) throw new Error('unterminated string')
    out.push(value)
    rest = rest.subarray(next)
  }
  if (rest.length > 0) throw new Error('bytes after the last string')
  return out
}

function readTerminated(
  bytes: Uint8Array,
  encoding: number,
): { value: string; next: number; terminated: boolean } {
  if (encoding === 0) {
    const end = bytes.indexOf(0)
    if (end < 0) return { value: latin1(bytes), next: bytes.length, terminated: false }
    return { value: latin1(bytes.subarray(0, end)), next: end + 1, terminated: true }
  }
  if (encoding !== 1) throw new Error(`v2.3 has no text encoding ${encoding}`)
  let end = 0
  while (end + 1 < bytes.length && !(bytes[end] === 0 && bytes[end + 1] === 0)) end += 2
  const terminated = end + 1 < bytes.length
  return {
    value: utf16WithBom(bytes.subarray(0, end)),
    next: terminated ? end + 2 : bytes.length,
    terminated,
  }
}

/** Every v2.3 UTF-16 string starts with a BOM, empty ones included. */
function utf16WithBom(bytes: Uint8Array): string {
  if (bytes.length < 2) throw new Error('UTF-16 string without a BOM')
  const littleEndian = bytes[0] === 0xff && bytes[1] === 0xfe
  const bigEndian = bytes[0] === 0xfe && bytes[1] === 0xff
  if (!littleEndian && !bigEndian) throw new Error('UTF-16 string without a BOM')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let value = ''
  for (let i = 2; i + 1 < bytes.length; i += 2) {
    value += String.fromCharCode(view.getUint16(i, littleEndian))
  }
  return value
}

const latin1 = (bytes: Uint8Array): string => String.fromCharCode(...bytes)

export type AiffChunk = { id: string; size: number; offset: number; data: Uint8Array }

/** The chunks of an AIFF file; throws unless the FORM size matches the file and chunks tile it. */
export function readAiff(bytes: Uint8Array): { formType: string; chunks: AiffChunk[] } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (latin1(bytes.subarray(0, 4)) !== 'FORM') throw new Error('not a FORM file')
  const formSize = view.getUint32(4)
  if (formSize !== bytes.length - 8) {
    throw new Error(`FORM size ${formSize}, file length − 8 is ${bytes.length - 8}`)
  }
  const formType = latin1(bytes.subarray(8, 12))
  const chunks: AiffChunk[] = []
  let at = 12
  while (at < bytes.length) {
    if (at + 8 > bytes.length) throw new Error('truncated chunk header')
    const id = latin1(bytes.subarray(at, at + 4))
    const size = view.getUint32(at + 4)
    const end = at + 8 + size
    if (end > bytes.length) throw new Error(`chunk ${id} runs past the file`)
    chunks.push({ id, size, offset: at, data: bytes.slice(at + 8, end) })
    at = end + (size % 2) // the pad byte of an odd-sized chunk
  }
  if (at !== bytes.length) throw new Error('chunks do not end at the end of the file')
  return { formType, chunks }
}

/** The ID3 tag at the start of an MP3 file. */
export async function readMp3Tag(file: string): Promise<{ tag: Id3Tag; audio: Uint8Array }> {
  const bytes = new Uint8Array(await readFile(file))
  const tag = readId3(bytes)
  return { tag, audio: bytes.subarray(tag.length) }
}

/** The ID3 tag in an AIFF file's `ID3 ` chunk. */
export async function readAiffTag(file: string): Promise<{ tag: Id3Tag; chunks: AiffChunk[] }> {
  const { chunks } = readAiff(new Uint8Array(await readFile(file)))
  const chunk = chunks.find((candidate) => candidate.id === 'ID3 ')
  if (chunk === undefined) throw new Error('no ID3 chunk')
  const tag = readId3(chunk.data)
  if (tag.length !== chunk.size) throw new Error('the ID3 chunk holds more than the tag')
  return { tag, chunks }
}
