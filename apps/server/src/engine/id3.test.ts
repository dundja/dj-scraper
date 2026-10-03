import { describe, expect, it } from 'vitest'
import {
  framesOf,
  readAiff,
  readComment,
  readId3,
  readPicture,
  readTextFrame,
  textOf,
} from '../../test/id3-reader.ts'
import {
  aiffFormSizeBytes,
  aiffId3Chunk,
  ID3_PADDING,
  type Id3Tags,
  id3v23Tag,
  readAiffHeader,
} from './id3.ts'

const URL = 'https://www.youtube.com/watch?v=jNQXAC9IVRw'
const JPEG = Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0, 0, 4, 0xff, 0xd9)

const fullTags: Id3Tags = {
  title: 'Me at the zoo',
  artist: 'jawed',
  album: 'Zoo Sessions',
  albumArtist: 'Various Artists',
  year: '2005',
  comment: URL,
}

describe('id3v23Tag', () => {
  it('writes a v2.3.0 header with a syncsafe size, no flags, and 2 KiB of padding', () => {
    const bytes = id3v23Tag(fullTags)
    expect(Array.from(bytes.subarray(0, 6))).toEqual([0x49, 0x44, 0x33, 3, 0, 0])
    const tag = readId3(bytes)
    expect(tag.version).toEqual([3, 0])
    expect(tag.flags).toBe(0)
    expect(tag.length).toBe(bytes.length)
    expect(tag.padding).toBe(ID3_PADDING)
  })

  it('writes the frames in a fixed order, with plain big-endian sizes and no frame flags', () => {
    const tag = readId3(id3v23Tag(fullTags, { mime: 'image/jpeg', data: JPEG }))
    expect(tag.frames.map((frame) => frame.id)).toEqual([
      'TIT2',
      'TPE1',
      'TALB',
      'TPE2',
      'TYER',
      'COMM',
      'APIC',
    ])
    expect(tag.frames.every((frame) => frame.flags === 0)).toBe(true)
    // Bytes of TIT2 "Me at the zoo": size 15 = encoding byte + 13 characters + terminator.
    const bytes = id3v23Tag({ title: 'Me at the zoo' })
    expect(Array.from(bytes.subarray(10, 20))).toEqual([0x54, 0x49, 0x54, 0x32, 0, 0, 0, 15, 0, 0])
    expect(Array.from(bytes.subarray(20, 22))).toEqual([0, 0x4d])
  })

  it('uses ISO-8859-1 (encoding 0) when every character fits, also for accents', () => {
    const tag = readId3(id3v23Tag({ title: 'Café Ñandú', artist: 'jawed' }))
    expect(readTextFrame(framesOf(tag, 'TIT2')[0] ?? fail())).toEqual({
      encoding: 0,
      text: 'Café Ñandú',
    })
    // NUL-terminated, like ffmpeg writes it.
    expect(framesOf(tag, 'TPE1')[0]?.data).toEqual(
      Uint8Array.of(0, 0x6a, 0x61, 0x77, 0x65, 0x64, 0),
    )
  })

  it('uses UTF-16 with a BOM (encoding 1) for anything else', () => {
    const tag = readId3(id3v23Tag({ artist: 'Beyoncé & 東京 — 🎧' }))
    const frame = framesOf(tag, 'TPE1')[0] ?? fail()
    expect(readTextFrame(frame)).toEqual({ encoding: 1, text: 'Beyoncé & 東京 — 🎧' })
    expect(Array.from(frame.data.subarray(0, 3))).toEqual([1, 0xff, 0xfe])
    expect(Array.from(frame.data.subarray(-2))).toEqual([0, 0])
  })

  it('writes the comment as COMM in English with an empty description', () => {
    const tag = readId3(id3v23Tag({ comment: URL }))
    const [frame, ...more] = framesOf(tag, 'COMM')
    expect(more).toEqual([])
    expect(readComment(frame ?? fail())).toEqual({
      encoding: 0,
      language: 'eng',
      description: '',
      text: URL,
    })
    expect(framesOf(tag, 'TXXX')).toEqual([])
  })

  it('writes a UTF-16 comment with a BOM on its empty description too', () => {
    const comment = 'https://soundcloud.com/ärtist/träck'
    const tag = readId3(id3v23Tag({ comment: `${comment} 東京` }))
    const frame = framesOf(tag, 'COMM')[0] ?? fail()
    expect(readComment(frame)).toEqual({
      encoding: 1,
      language: 'eng',
      description: '',
      text: `${comment} 東京`,
    })
    expect(Array.from(frame.data.subarray(4, 8))).toEqual([0xff, 0xfe, 0, 0])
  })

  it('writes the cover as APIC: front cover, its MIME type, the bytes untouched', () => {
    const tag = readId3(id3v23Tag({ title: 'T' }, { mime: 'image/jpeg', data: JPEG }))
    expect(readPicture(framesOf(tag, 'APIC')[0] ?? fail())).toEqual({
      encoding: 0,
      mime: 'image/jpeg',
      type: 3,
      description: '',
      data: JPEG,
    })
  })

  it('round-trips every text field', () => {
    const tag = readId3(id3v23Tag(fullTags))
    expect({
      title: textOf(tag, 'TIT2'),
      artist: textOf(tag, 'TPE1'),
      album: textOf(tag, 'TALB'),
      albumArtist: textOf(tag, 'TPE2'),
      year: textOf(tag, 'TYER'),
      comment: readComment(framesOf(tag, 'COMM')[0] ?? fail()).text,
    }).toEqual(fullTags)
  })

  it('leaves out missing and empty values, but always writes the header and padding', () => {
    const tag = readId3(id3v23Tag({ title: 'Only', artist: '', comment: undefined }))
    expect(tag.frames.map((frame) => frame.id)).toEqual(['TIT2'])
    const empty = readId3(id3v23Tag({}))
    expect(empty.frames).toEqual([])
    expect(empty.length).toBe(10 + ID3_PADDING)
  })

  it('keeps a large cover intact (sizes past 127 bytes per syncsafe digit)', () => {
    const data = new Uint8Array(300_000).map((_, i) => i % 251)
    const tag = readId3(id3v23Tag({ title: 'T' }, { mime: 'image/jpeg', data }))
    expect(readPicture(framesOf(tag, 'APIC')[0] ?? fail()).data).toEqual(data)
  })
})

describe('aiffId3Chunk', () => {
  it('wraps the tag as an `ID3 ` chunk with a big-endian length', () => {
    const tag = id3v23Tag({ title: 'Even' })
    const chunk = aiffId3Chunk(tag)
    expect(new TextDecoder().decode(chunk.subarray(0, 4))).toBe('ID3 ')
    expect(new DataView(chunk.buffer).getUint32(4)).toBe(tag.length)
    expect(chunk.subarray(8, 8 + tag.length)).toEqual(tag)
  })

  it.each([
    ['an even', 'Ab'],
    ['an odd', 'Abc'],
  ])('pads %s-length tag to an even chunk, without counting the pad byte', (_label, title) => {
    const tag = id3v23Tag({ title })
    const chunk = aiffId3Chunk(tag)
    expect(chunk.length).toBe(8 + tag.length + (tag.length % 2))
    expect(chunk.length % 2).toBe(0)
    expect(new DataView(chunk.buffer).getUint32(4)).toBe(tag.length)
  })

  it('makes a file the reader accepts once the FORM size is rewritten', () => {
    // A minimal AIFF: FORM header + a COMM chunk (18 bytes) + an SSND chunk with 4 bytes of audio.
    const comm = Uint8Array.of(
      ...[0x43, 0x4f, 0x4d, 0x4d, 0, 0, 0, 18],
      ...[0, 2, 0, 0, 0, 1, 0, 16, 0x40, 0x0e, 0xbb, 0x80, 0, 0, 0, 0, 0, 0],
    )
    const ssnd = Uint8Array.of(0x53, 0x53, 0x4e, 0x44, 0, 0, 0, 12, ...new Array(12).fill(0))
    const body = Uint8Array.of(...[0x41, 0x49, 0x46, 0x46], ...comm, ...ssnd)
    const header = Uint8Array.of(0x46, 0x4f, 0x52, 0x4d, 0, 0, 0, body.length)
    const before = Uint8Array.of(...header, ...body)
    expect(readAiffHeader(before)).toEqual({ formSize: body.length, formType: 'AIFF' })

    const tag = id3v23Tag({ title: 'Odd', comment: URL })
    const chunk = aiffId3Chunk(tag)
    const after = Uint8Array.of(...before, ...chunk)
    after.set(aiffFormSizeBytes(after.length), 4)

    const { formType, chunks } = readAiff(after)
    expect(formType).toBe('AIFF')
    expect(chunks.map((c) => c.id)).toEqual(['COMM', 'SSND', 'ID3 '])
    const id3 = chunks[2]?.data ?? fail()
    expect(textOf(readId3(id3), 'TIT2')).toBe('Odd')
  })
})

describe('readAiffHeader', () => {
  it.each([
    ['AIFF', 'AIFF'],
    ['AIFC', 'AIFC'],
  ])('reads FORM … %s', (_label, type) => {
    const head = Uint8Array.of(
      0x46,
      0x4f,
      0x52,
      0x4d,
      0,
      1,
      0,
      2,
      ...Array.from(type, (c) => c.charCodeAt(0)),
    )
    expect(readAiffHeader(head)).toEqual({ formSize: 65538, formType: type })
  })

  it.each([
    ['too short', Uint8Array.of(0x46, 0x4f, 0x52, 0x4d)],
    ['RIFF/WAVE', Uint8Array.of(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 4, 0x57, 0x41, 0x56, 0x45)],
    [
      'FORM of another type',
      Uint8Array.of(0x46, 0x4f, 0x52, 0x4d, 0, 0, 0, 4, 0x38, 0x53, 0x56, 0x58),
    ],
  ])('refuses %s', (_label, head) => {
    expect(readAiffHeader(head)).toBeUndefined()
  })
})

describe('aiffFormSizeBytes', () => {
  it('is the file length minus 8, big-endian', () => {
    expect(Array.from(aiffFormSizeBytes(0x0102_0308))).toEqual([1, 2, 3, 0])
    expect(Array.from(aiffFormSizeBytes(2 ** 32 + 7))).toEqual([0xff, 0xff, 0xff, 0xff])
  })

  it('refuses a file over the 4 GiB AIFF limit, and one too short to be AIFF', () => {
    expect(() => aiffFormSizeBytes(2 ** 32 + 8)).toThrow(RangeError)
    expect(() => aiffFormSizeBytes(11)).toThrow(RangeError)
  })
})

function fail(): never {
  throw new Error('missing')
}
