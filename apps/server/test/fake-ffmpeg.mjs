#!/usr/bin/env node
// A fake ffmpeg and ffprobe for integration and e2e tests: one script that is ffprobe when the
// link it runs as has `ffprobe` in its name, else ffmpeg. It decodes nothing. Its media are the
// fake files of fake-media.mjs: a FAKEAUDIO header that says what ffprobe reports, then a payload.
//
// Tests symlink it as <dir>/ffmpeg and <dir>/ffprobe and set FFMPEG_PATH to the ffmpeg link (see
// writeFakeFfmpeg and writeFakeEngine in helpers.ts; fake-yt-dlp.mjs says why links). Keep the
// exec bit (git mode 100755).
//
// Both: `-version` prints fixtures/engine/{ffmpeg,ffprobe}-version-8.0-brew.txt, so the engine
// health check passes. A broken call or test setup exits 2 with `fake-ffmpeg: …` (`fake-ffprobe`).
//
// ffmpeg reads argv like ffmpeg: global options anywhere, per-input options before each -i, and
// per-output options before the output file, the last argument. It exits 2 on what the design's
// passes (D3, D14) never build, so argv drift fails loudly instead of passing by luck:
// - an unknown option, an output option before -i (or the reverse), -y, untyped -map specs (only
//   `N:a…`/`N:v…`), more than one output, options after the output
// - no -nostdin, -n or `-loglevel error`; an input without `-protocol_whitelist file`; a relative
//   path; an output without -f or -map; a mapped stream without -c:a / -c:v
// - an encoder option on a copied stream (-b:a -ac -ar -sample_fmt; -q:v -vf -pix_fmt), a pass
//   that encodes (the cover pass too) without -xerror, and one that decodes an MP3 input with it
//   (ADR-015: mid-stream junk in a stitched MP3 must not be fatal)
// - -progress outside the measuring pass, which is exactly `-nostats -progress pipe:1`, one input,
//   only audio maps copied, and `-f null -`
// Otherwise it answers like ffmpeg 8 (texts from the Phase 2 facts):
// - a missing input exits 254; an input that is no fake media, or not what its -f image pipe
//   says, exits 183
// - an existing output with -n: `File '…' already exists. Exiting.`, exit 0, the file untouched
// - a -map that matches nothing exits 234 without an output. A codec the muxer can't hold, a
//   cover in wav/webm/ogg/opus, a non-JPEG/PNG cover, or a cover without the attached_pic
//   disposition in m4a exits 234 and leaves a 0-byte output. FLAC drops such a cover silently,
//   and -vn drops every mapped cover (design §9)
// - reading Opus from WebM prints `[opus @ 0x…] Error parsing Opus packet header.` and still
//   succeeds
// An audio output is a FAKEAUDIO file (`-f aiff`: inside a FORM container) with the mapped input's
// payload. Its header: codec from the input (copy) or the encoder (libmp3lame → mp3, aac, flac,
// pcm_* …); sample rate and channels from the input unless -ar/-ac; bitRate from the input
// (copy), -b:a, or the PCM rate; the input's duration; tags = the first input's (unless
// `-map_metadata -1`) plus -metadata (an empty value removes one; none for mp3 with
// `-id3v2_version 0`); cover = a picture stream made it in. probe = the recorded output of that
// muxer (fixtures/ffprobe/out-*: copy or encode for mp3 and m4a), or 'synthetic:ogg' for ogg/opus.
// An image output (the cover pass, -f image2) is a fake JPEG (or the input's format for -c:v
// copy), as large as the input but at most the -vf `min(N,iw)` cap, probing as the recorded cover.
// The measuring pass (`-f null -`) writes no file: it prints ffmpeg's `-progress` report on stdout
// with the mapped input's real duration (durationSec, never the header's estimatedSec).
//
// ffprobe needs `-v error`, `-of json` and the -show_entries the fixtures were recorded with
// (D15), and prints JSON like ffprobe's: the header's recorded JSON with codec_name, sample_rate,
// channels, bit_rate, duration (estimatedSec when the header has one), the tags (format tags;
// stream tags for Ogg; Matroska keys other than title upper case) and the attached_pic stream
// taken from the header. It reads past a
// leading ID3v2 tag and finds the FAKE chunk in an AIFF; it is stricter than ffprobe about broken
// containers (see fake-media.mjs). It doesn't read ID3 tags: tests check those bytes themselves.
// A missing file or no fake media: `<file>: <reason>` and exit 1.
//
// Knobs, from the environment or from a JSON object of the same names in `.<link name>.fake.json`
// beside the link (which wins), like fake-yt-dlp.mjs. A value may start with `<scopes>@`, a
// comma-separated list of the passes it applies to: audio (ffmpeg writing audio), cover (ffmpeg
// writing an image), measure (the measuring pass), ffmpeg (all three), ffprobe. Unscoped, FAIL
// and HANG apply to ffmpeg, SHORT and DROP_TAGS to audio.
//   FAKE_FFMPEG_FAIL       `<exit>:<stderr text>`: print the text and exit, writing nothing
//   FAKE_FFMPEG_HANG=1     ffmpeg leaves a 0-byte output (none when measuring) and hangs until a
//                          signal; ffprobe hangs
//   FAKE_FFMPEG_SHORT=1    audio: write half the input's duration; measure, ffprobe: report half
//   FAKE_FFMPEG_DROP_TAGS=1  audio: write no tags; ffprobe: report none
//   FAKE_FFMPEG_CALLS      append one JSON line per invocation: { tool, argv, time, pid }
// Knobs never apply to -version. SIGINT exits 255 silently, like ffmpeg at `-loglevel error`.

import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  aiffBytes,
  audioBytes,
  FIXTURES,
  fixturePath,
  imageBytes,
  isObject,
  readJson,
  readMedia,
  UsageError,
} from './fake-media.mjs'

process.on('SIGINT', () => process.exit(255))

const ADDR = '0x600001a2c000'
const KNOBS = [
  'FAKE_FFMPEG_FAIL',
  'FAKE_FFMPEG_HANG',
  'FAKE_FFMPEG_SHORT',
  'FAKE_FFMPEG_DROP_TAGS',
  'FAKE_FFMPEG_CALLS',
]
const PASSES = {
  audio: ['audio'],
  cover: ['cover'],
  measure: ['measure'],
  ffmpeg: ['audio', 'cover', 'measure'],
  ffprobe: ['ffprobe'],
}
const KNOB_SCOPES = {
  FAKE_FFMPEG_FAIL: { unscoped: 'ffmpeg', allowed: ['audio', 'cover', 'measure', 'ffprobe'] },
  FAKE_FFMPEG_HANG: { unscoped: 'ffmpeg', allowed: ['audio', 'cover', 'measure', 'ffprobe'] },
  FAKE_FFMPEG_SHORT: { unscoped: 'audio', allowed: ['audio', 'ffprobe', 'measure'] },
  FAKE_FFMPEG_DROP_TAGS: { unscoped: 'audio', allowed: ['audio', 'ffprobe'] },
}

/** The -show_entries of the recorded ffprobe JSON (fixtures/ffprobe/README.md, design D15). */
const RECORDED_ENTRIES =
  'format=format_name,duration,bit_rate:format_tags:stream=index,codec_type,codec_name,sample_rate,channels,bit_rate:stream_tags:stream_disposition=attached_pic'

const GLOBAL_FLAGS = new Set(['-hide_banner', '-nostdin', '-nostats', '-n', '-xerror'])
const GLOBAL_VALUES = new Set(['-loglevel', '-v', '-progress'])
const INPUT_VALUES = new Set(['-protocol_whitelist', '-pattern_type'])
const OUTPUT_FLAGS = new Set(['-vn'])
const OUTPUT_VALUES = new Set([
  '-map',
  '-c:a',
  '-codec:a',
  '-acodec',
  '-c:v',
  '-codec:v',
  '-vcodec',
  '-b:a',
  '-ac',
  '-ar',
  '-sample_fmt',
  '-q:v',
  '-vf',
  '-frames:v',
  '-pix_fmt',
  '-update',
  '-map_metadata',
  '-map_chapters',
  '-metadata',
  '-id3v2_version',
  '-write_id3v1',
  '-write_id3v2',
  '-movflags',
  '-fflags',
])
const OUTPUT_PREFIXES = ['-metadata:', '-disposition:', '-map_metadata:']

/** Demuxers an input's -f may name; image pipes must match the file's magic bytes. */
const DEMUXERS = {
  jpeg_pipe: 'jpeg',
  png_pipe: 'png',
  webp_pipe: 'webp',
  image2: 'image',
  mp3: 'audio',
  mov: 'audio',
  mp4: 'audio',
  matroska: 'audio',
  webm: 'audio',
  ogg: 'audio',
  flac: 'audio',
  wav: 'audio',
  aiff: 'audio',
}

const AUDIO_ENCODERS = {
  libmp3lame: 'mp3',
  aac: 'aac',
  alac: 'alac',
  flac: 'flac',
  libopus: 'opus',
  libvorbis: 'vorbis',
}
const VIDEO_ENCODERS = { mjpeg: 'jpeg', png: 'png' }
const IMAGE_CODECS = { jpeg: 'mjpeg', png: 'png', webp: 'webp' }

const isPcm = (codec) => /^pcm_[a-z0-9]+$/.test(codec)
/**
 * What each muxer holds: its audio codecs, what it does with a picture stream (keep it, keep it only
 * with the attached_pic disposition, drop it without, or the error it fails with), and its recorded
 * probe. mp4 reuses the ipod recordings (a real `-f mp4` file has brand isom, not M4A).
 */
const MUXERS = {
  mp3: {
    audio: (codec) => codec === 'mp3',
    cover: 'keep',
    probe: { copy: 'ffprobe/out-mp3-copy.json', encode: 'ffprobe/out-mp3-encode.json' },
  },
  ipod: {
    audio: (codec) => codec === 'aac' || codec === 'alac',
    cover: 'attached_pic',
    probe: { copy: 'ffprobe/out-m4a-copy.json', encode: 'ffprobe/out-m4a-encode.json' },
  },
  mp4: {
    audio: (codec) => ['aac', 'alac', 'mp3', 'opus', 'flac'].includes(codec),
    cover: 'attached_pic',
    probe: { copy: 'ffprobe/out-m4a-copy.json', encode: 'ffprobe/out-m4a-encode.json' },
  },
  flac: { audio: (codec) => codec === 'flac', cover: 'drop', probe: 'ffprobe/out-flac.json' },
  wav: {
    audio: (codec) => isPcm(codec) && !codec.endsWith('be'),
    cover: 'wav muxer does not support any stream of type video',
    probe: 'ffprobe/out-wav.json',
  },
  aiff: {
    audio: (codec) => isPcm(codec) && !codec.endsWith('le'),
    cover: 'keep',
    probe: 'ffprobe/out-aiff.json',
  },
  webm: {
    audio: (codec) => codec === 'opus' || codec === 'vorbis',
    cover:
      'Only VP8 or VP9 or AV1 video and Vorbis or Opus audio and WebVTT subtitles are supported for WebM.',
    probe: 'ffprobe/out-original-webm.json',
  },
  matroska: { audio: () => true, cover: 'keep', probe: 'ffprobe/out-original-webm.json' },
  opus: {
    audio: (codec) => codec === 'opus',
    cover: 'Unsupported codec id in stream 1',
    probe: 'synthetic:ogg',
  },
  ogg: {
    audio: (codec) => ['opus', 'vorbis', 'flac'].includes(codec),
    cover: 'Unsupported codec id in stream 1',
    probe: 'synthetic:ogg',
  },
}
const IMAGE_MUXERS = new Set(['image2', 'mjpeg'])
/** Tag keys ffmpeg writes from -metadata; the recorded JSON's other tags come from the muxer. */
const USER_TAGS = new Set([
  'title',
  'artist',
  'album',
  'album_artist',
  'date',
  'comment',
  'description',
  'genre',
  'track',
])

/** ffmpeg's own exit: stderr lines, a code, and the 0-byte output it leaves, if any. */
class FfmpegExit extends Error {
  constructor(code, lines, emptyOutput) {
    super(lines.at(-1))
    this.code = code
    this.lines = lines
    this.emptyOutput = emptyOutput
  }
}

let tool = 'ffmpeg'

function usage(message) {
  throw new UsageError(message)
}

function readKnobs(link) {
  const knobs = {}
  for (const name of KNOBS) {
    const value = process.env[name]
    if (value !== undefined && value !== '') knobs[name] = value
  }
  const file = path.join(path.dirname(link), `.${path.basename(link)}.fake.json`)
  if (existsSync(file)) {
    const extra = readJson(file)
    if (!isObject(extra)) usage(`${file}: expected a JSON object of FAKE_FFMPEG_* strings`)
    for (const [name, value] of Object.entries(extra)) {
      if (!KNOBS.includes(name) || typeof value !== 'string') {
        usage(`${file}: unknown knob or non-string value: ${name}`)
      }
      knobs[name] = value
    }
  }
  return knobs
}

/** Each knob as { value, passes }, checked up front so a typo fails every call. */
function parseKnobs(knobs) {
  const parsed = {}
  for (const [name, { unscoped, allowed }] of Object.entries(KNOB_SCOPES)) {
    const raw = knobs[name]
    if (raw === undefined) continue
    const scoped = /^([a-z]+(?:,[a-z]+)*)@/.exec(raw)
    const scopes = scoped === null ? [unscoped] : scoped[1].split(',')
    const passes = scopes.flatMap((scope) => {
      const expanded = PASSES[scope]
      if (expanded === undefined || expanded.some((pass) => !allowed.includes(pass))) {
        usage(`${name}: scope ${scope} isn't one of ${allowed.join(', ')}`)
      }
      return expanded
    })
    const value = scoped === null ? raw : raw.slice(scoped[0].length)
    if (name === 'FAKE_FFMPEG_FAIL') {
      const fail = /^(\d{1,3}):([\s\S]*)$/.exec(value)
      if (fail === null || Number(fail[1]) > 255) {
        usage(`${name} must be [scopes@]<exit 0-255>:<stderr text>`)
      }
      parsed[name] = { passes, value: { code: Number(fail[1]), text: fail[2] } }
    } else {
      if (value !== '0' && value !== '1') usage(`${name} must be [scopes@]1 or 0`)
      if (value === '1') parsed[name] = { passes, value: true }
    }
  }
  return parsed
}

const knobFor = (knobs, name, pass) =>
  knobs[name]?.passes.includes(pass) ? knobs[name].value : undefined

const hangForever = () =>
  new Promise(() => {
    setInterval(() => {}, 60_000)
  })

/** The FAIL knob for this pass: exits with its code and text. */
function failIfAsked(knobs, pass) {
  const fail = knobFor(knobs, 'FAKE_FFMPEG_FAIL', pass)
  if (fail === undefined) return
  const text = fail.text.endsWith('\n') ? fail.text.slice(0, -1) : fail.text
  throw new FfmpegExit(fail.code, text === '' ? [] : [text])
}

function absolute(file, what) {
  if (!path.isAbsolute(file)) usage(`${what} must be an absolute path: ${file}`)
  return file
}

function parseMap(spec) {
  const match = /^(\d+):([av])(?::(\d+))?$/.exec(spec)
  if (match === null) usage(`-map ${spec}: use typed specs like 0:a:0 or 1:v:0`)
  return {
    spec,
    input: Number(match[1]),
    type: match[2],
    index: match[3] === undefined ? undefined : Number(match[3]),
  }
}

/** ffmpeg's option groups: { globals, inputs: [{ path, options }], output: { path, options } }. */
function splitArgv(argv) {
  const globals = new Map()
  const inputs = []
  const outputs = []
  let pending = []
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    const value = () => {
      const next = argv[++i]
      if (next === undefined) usage(`${token} needs a value`)
      return next
    }
    if (token === '-y') usage('-y would overwrite: every pass uses -n')
    if (GLOBAL_FLAGS.has(token)) globals.set(token, true)
    else if (GLOBAL_VALUES.has(token)) globals.set(token, value())
    else if (token === '-i') {
      const input = value()
      for (const [name] of pending) {
        if (!INPUT_VALUES.has(name) && name !== '-f') {
          usage(`${name} is an output option, but it comes before -i ${input}`)
        }
      }
      inputs.push({ path: input, options: new Map(pending) })
      pending = []
    } else if (OUTPUT_FLAGS.has(token)) pending.push([token, true])
    else if (
      token === '-f' ||
      INPUT_VALUES.has(token) ||
      OUTPUT_VALUES.has(token) ||
      OUTPUT_PREFIXES.some((prefix) => token.startsWith(prefix))
    ) {
      pending.push([token, value()])
    } else if (token.startsWith('-') && token !== '-') usage(`unknown option ${token}`)
    else {
      for (const [name] of pending) {
        if (INPUT_VALUES.has(name))
          usage(`${name} is an input option, but it comes before ${token}`)
      }
      outputs.push({ path: token, options: pending })
      pending = []
    }
  }
  if (pending.length > 0)
    usage(`options after the output file: ${pending.map(([n]) => n).join(' ')}`)
  if (outputs.length !== 1) usage(`expected one output file, got ${outputs.length}`)
  const [output] = outputs
  return { globals, inputs, output }
}

/** The pass ffmpeg is asked to run, checked against the design's argv shapes. */
function parseFfmpeg(argv) {
  const { globals, inputs, output } = splitArgv(argv)
  for (const flag of ['-nostdin', '-n']) {
    if (!globals.has(flag)) usage(`${flag} is missing (every pass has -nostdin -n)`)
  }
  if ((globals.get('-loglevel') ?? globals.get('-v')) !== 'error') {
    usage('-loglevel error is missing: stderr would carry more than errors')
  }
  if (inputs.length === 0) usage('no -i input')
  for (const input of inputs) {
    absolute(input.path, 'an input')
    if (input.options.get('-protocol_whitelist') !== 'file') {
      usage(`-protocol_whitelist file is missing before -i ${input.path}`)
    }
    const format = input.options.get('-f')
    if (format !== undefined && DEMUXERS[format] === undefined)
      usage(`unknown demuxer -f ${format}`)
  }

  const nullOutput = output.options.some(([name, value]) => name === '-f' && value === 'null')
  if (nullOutput && output.path !== '-') usage(`-f null writes to -, not ${output.path}`)
  const pass = {
    inputs,
    path: nullOutput ? '-' : absolute(output.path, 'the output'),
    maps: [],
    tags: {},
    dispositions: [],
    noVideo: false,
    id3v2Version: undefined,
  }
  const audioOptions = []
  const videoOptions = []
  for (const [name, value] of output.options) {
    if (name === '-map') pass.maps.push(parseMap(value))
    else if (name === '-f') pass.muxer = value
    else if (['-c:a', '-codec:a', '-acodec'].includes(name)) pass.audioCodec = value
    else if (['-c:v', '-codec:v', '-vcodec'].includes(name)) pass.videoCodec = value
    else if (name === '-vn') pass.noVideo = true
    else if (name === '-metadata') {
      const at = value.indexOf('=')
      if (at < 1) usage(`-metadata ${value}: expected key=value`)
      // An empty value stays: it removes the key, an inherited one too.
      pass.tags[value.slice(0, at)] = value.slice(at + 1)
    } else if (name === '-map_metadata') {
      if (!/^(-1|\d+)$/.test(value)) usage(`-map_metadata ${value}: expected -1 or an input index`)
      pass.mapMetadata = Number(value)
    } else if (name.startsWith('-disposition:')) {
      pass.dispositions.push({ spec: name.slice('-disposition:'.length), value })
    } else if (name === '-id3v2_version') pass.id3v2Version = value
    else if (['-b:a', '-ac', '-ar', '-sample_fmt'].includes(name)) {
      audioOptions.push(name)
      if (name === '-b:a') pass.bitRate = parseRate(value)
      if (name === '-ac') pass.channels = positiveInt(name, value)
      if (name === '-ar') pass.sampleRate = positiveInt(name, value)
    } else if (['-q:v', '-vf', '-pix_fmt'].includes(name)) {
      videoOptions.push(name)
      if (name === '-vf') pass.scaleCap = Number(/min\((\d+),\s*iw\)/.exec(value)?.[1] ?? Infinity)
    }
  }

  if (pass.muxer === undefined) usage('the output has no -f: the extension would pick the muxer')
  if (MUXERS[pass.muxer] === undefined && !IMAGE_MUXERS.has(pass.muxer) && !nullOutput) {
    usage(`unknown muxer -f ${pass.muxer}`)
  }
  if (pass.maps.length === 0) usage('no -map: ffmpeg would pick the streams itself')
  for (const map of pass.maps) {
    if (map.input >= inputs.length) usage(`-map ${map.spec}: there is no input ${map.input}`)
  }
  const mapsAudio = pass.maps.some((map) => map.type === 'a')
  const mapsVideo = !pass.noVideo && pass.maps.some((map) => map.type === 'v')
  if (mapsAudio && pass.audioCodec === undefined) usage('an audio stream is mapped without -c:a')
  if (mapsVideo && pass.videoCodec === undefined) usage('a video stream is mapped without -c:v')
  if (pass.audioCodec !== undefined && pass.audioCodec !== 'copy') {
    if (AUDIO_ENCODERS[pass.audioCodec] === undefined && !isPcm(pass.audioCodec)) {
      usage(`unknown audio encoder ${pass.audioCodec}`)
    }
  }
  if (pass.videoCodec !== undefined && pass.videoCodec !== 'copy') {
    if (VIDEO_ENCODERS[pass.videoCodec] === undefined) {
      usage(`unknown video encoder ${pass.videoCodec}`)
    }
  }
  if (pass.audioCodec === 'copy' && audioOptions.length > 0) {
    usage(`${audioOptions.join(' ')} with -c:a copy: a copied stream isn't encoded`)
  }
  if (pass.videoCodec === 'copy' && videoOptions.length > 0) {
    usage(`${videoOptions.join(' ')} with -c:v copy: a copied stream isn't encoded`)
  }
  const decodesAudio = mapsAudio && pass.audioCodec !== 'copy'
  const decodesVideo = mapsVideo && pass.videoCodec !== 'copy'
  if (decodesAudio && decodedCodec(pass) === 'mp3') {
    if (globals.has('-xerror')) {
      usage('-xerror on a pass that decodes an MP3: mid-stream junk would be fatal (ADR-015)')
    }
  } else if ((decodesAudio || decodesVideo) && !globals.has('-xerror')) {
    usage('-xerror is missing on a pass that decodes')
  }
  if (nullOutput) {
    if (globals.get('-progress') !== 'pipe:1' || !globals.has('-nostats')) {
      usage('the measuring pass reports with -nostats -progress pipe:1')
    }
    if (inputs.length !== 1 || mapsVideo || pass.audioCodec !== 'copy') {
      usage('the measuring pass copies the audio of one input')
    }
  } else if (globals.has('-progress')) {
    usage('-progress is only for the measuring pass (-f null -)')
  }
  pass.kind = nullOutput ? 'measure' : IMAGE_MUXERS.has(pass.muxer) ? 'cover' : 'audio'
  return pass
}

/** The codec of the first mapped audio input, when it is readable fake audio. */
function decodedCodec(pass) {
  const map = pass.maps.find((candidate) => candidate.type === 'a')
  const file = map === undefined ? undefined : pass.inputs[map.input]?.path
  if (file === undefined) return undefined
  let media
  try {
    media = readMedia(readFileSync(file))
  } catch {
    return undefined
  }
  return media?.kind === 'audio' ? media.header.codec : undefined
}

function parseRate(value) {
  const match = /^(\d+)(k?)$/.exec(value)
  if (match === null) usage(`-b:a ${value}: expected a number or Nk`)
  return Number(match[1]) * (match[2] === 'k' ? 1000 : 1)
}

function positiveInt(name, value) {
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1) usage(`${name} ${value}: expected a positive integer`)
  return n
}

/** An input's streams: { type: 'a', header, payload } and { type: 'v', codec, image }. */
function openInput(input, index) {
  const failed = (code, reason) =>
    new FfmpegExit(code, [
      `[in#${index} @ ${ADDR}] Error opening input: ${reason}`,
      `Error opening input file ${input.path}.`,
      `Error opening input files: ${reason}`,
    ])
  let bytes
  try {
    bytes = readFileSync(input.path)
  } catch (error) {
    if (error.code === 'ENOENT') throw failed(254, 'No such file or directory')
    throw failed(254, error.code === 'EISDIR' ? 'Is a directory' : 'Permission denied')
  }
  const media = readMedia(bytes)
  const expected = DEMUXERS[input.options.get('-f')]
  const invalid = failed(183, 'Invalid data found when processing input')
  if (media === undefined) throw invalid
  if (media.kind === 'image') {
    if (
      expected === 'audio' ||
      (expected !== undefined && expected !== 'image' && expected !== media.format)
    ) {
      throw invalid
    }
    return [{ type: 'v', codec: IMAGE_CODECS[media.format], image: media.info }]
  }
  if (expected !== undefined && expected !== 'audio') throw invalid
  const streams = [{ type: 'a', header: media.header, payload: media.payload }]
  if (media.header.cover) {
    streams.push({ type: 'v', codec: 'mjpeg', image: { format: 'jpeg', width: 600, height: 600 } })
  }
  return streams
}

const formatNames = new Map()
/** The recorded format_name of a fake audio's probe, e.g. `matroska,webm`. */
function formatNameOf(probe) {
  if (probe.startsWith('synthetic:')) return probe.slice('synthetic:'.length)
  if (!formatNames.has(probe))
    formatNames.set(probe, readJson(fixturePath(probe))?.format?.format_name)
  return formatNames.get(probe)
}

/** A muxer refusing its streams: ffmpeg leaves a 0-byte output. */
const headerFailure = (pass, line) =>
  new FfmpegExit(
    234,
    [
      `[${pass.muxer} @ ${ADDR}] ${line}`,
      `[out#0/${pass.muxer} @ ${ADDR}] Could not write header (incorrect codec parameters ?): Invalid argument`,
    ],
    pass.path,
  )

/** Whether an output stream (`typeIndex`-th of its type, `outIndex` overall) is an attached_pic. */
function attachedPic(pass, type, typeIndex, outIndex) {
  return pass.dispositions.some(({ spec, value }) => {
    const match = /^([av])(?::(\d+))?$|^(\d+)$/.exec(spec)
    const applies =
      match !== null &&
      (match[3] !== undefined
        ? Number(match[3]) === outIndex
        : match[1] === type && (match[2] === undefined || Number(match[2]) === typeIndex))
    return applies && value.split('+').includes('attached_pic')
  })
}

/** Opens the inputs and maps the streams; `write` writes the output, unless it already exists. */
function prepareOutput(pass, knobs) {
  const inputs = pass.inputs.map(openInput)
  if (existsSync(pass.path)) {
    return { lines: [`File '${pass.path}' already exists. Exiting.`] }
  }
  const dir = path.dirname(pass.path)
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new FfmpegExit(254, [
      `[out#0/${pass.muxer} @ ${ADDR}] Error opening output ${pass.path}: No such file or directory`,
      `Error opening output file ${pass.path}.`,
      'Error opening output files: No such file or directory',
    ])
  }
  const streams = mapStreams(pass, inputs)
  return { lines: opusLines(streams), write: () => writeOutput(pass, knobs, streams, inputs) }
}

/** The streams the -map options pick; exits 234 like ffmpeg when one matches nothing. */
function mapStreams(pass, inputs) {
  const streams = []
  for (const map of pass.maps) {
    const candidates = inputs[map.input].filter((stream) => stream.type === map.type)
    const picked = map.index === undefined ? candidates : candidates.slice(map.index, map.index + 1)
    if (picked.length === 0) {
      throw new FfmpegExit(234, [
        `[out#0/${pass.muxer} @ ${ADDR}] Stream map '${map.spec}' matches no streams.`,
        "To ignore this, add a trailing '?' to the map.",
        `Error opening output file ${pass.path}.`,
        'Error opening output files: Invalid argument',
      ])
    }
    // -vn drops video streams even when -map names them (design §9).
    if (map.type === 'v' && pass.noVideo) continue
    streams.push(...picked)
  }
  return streams
}

/** ffmpeg 8 prints this for every Opus-in-WebM read, copies too. */
function opusLines(streams) {
  const opusInWebm = streams.some(
    (stream) =>
      stream.type === 'a' &&
      stream.header.codec === 'opus' &&
      /webm|matroska/.test(formatNameOf(stream.header.probe)),
  )
  return opusInWebm ? [`[opus @ ${ADDR}] Error parsing Opus packet header.`] : []
}

/** ffmpeg's `-progress` report at the end of a pass that reached `seconds`. */
function progressReport(seconds) {
  const micros = Math.round(seconds * 1_000_000)
  const clock = new Date(Math.floor(micros / 1000)).toISOString().slice(11, 19)
  return [
    'bitrate=N/A',
    'total_size=N/A',
    `out_time_us=${micros}`,
    `out_time_ms=${micros}`,
    `out_time=${clock}.${String(micros % 1_000_000).padStart(6, '0')}`,
    'dup_frames=0',
    'drop_frames=0',
    'speed=N/A',
    'progress=end',
    '',
  ].join('\n')
}

/** The measuring pass: the mapped audio's real duration as a `-progress` report on stdout. */
async function measure(pass, knobs) {
  const streams = mapStreams(pass, pass.inputs.map(openInput))
  if (knobFor(knobs, 'FAKE_FFMPEG_HANG', 'measure')) await hangForever()
  const [audio] = streams
  const short = knobFor(knobs, 'FAKE_FFMPEG_SHORT', 'measure') ? 0.5 : 1
  process.stdout.write(progressReport(audio.header.durationSec * short))
  return opusLines(streams)
}

function writeCover(pass, streams) {
  const video = streams.filter((stream) => stream.type === 'v')
  if (video.length !== 1 || streams.length !== 1) {
    throw headerFailure(pass, 'the cover pass writes one picture and no audio')
  }
  const [{ image }] = video
  const format = pass.videoCodec === 'copy' ? image.format : VIDEO_ENCODERS[pass.videoCodec]
  const scale = Math.min(1, (pass.scaleCap ?? Infinity) / Math.max(image.width, image.height))
  const probe =
    format !== 'jpeg'
      ? undefined
      : image.format === 'webp'
        ? 'ffprobe/cover-youtube-webp.json'
        : 'ffprobe/cover-soundcloud-jpg.json'
  const info = {
    format,
    width: Math.round(image.width * scale),
    height: Math.round(image.height * scale),
    ...(probe === undefined ? {} : { probe }),
  }
  writeFileSync(pass.path, imageBytes(info), { flag: 'wx' })
}

/** Whether the picture streams make it into the file; throws where the muxer refuses them. */
function keepsCover(pass, muxer, streams) {
  const pictures = streams
    .map((stream, outIndex) => ({ stream, outIndex }))
    .filter(({ stream }) => stream.type === 'v')
  if (pictures.length === 0) return false
  if (!['keep', 'attached_pic', 'drop'].includes(muxer.cover)) {
    throw headerFailure(pass, muxer.cover)
  }
  const codecs = pictures.map(({ stream }) =>
    pass.videoCodec === 'copy' ? stream.codec : IMAGE_CODECS[VIDEO_ENCODERS[pass.videoCodec]],
  )
  const pic = pictures.every(({ outIndex }, i) => attachedPic(pass, 'v', i, outIndex))
  const unsupported = codecs.find((codec) => codec !== 'mjpeg' && codec !== 'png')
  if (unsupported !== undefined || (muxer.cover === 'attached_pic' && !pic)) {
    throw headerFailure(
      pass,
      `Could not find tag for codec ${unsupported ?? codecs[0]} in stream #1, codec not currently supported in container`,
    )
  }
  // FLAC ignores a picture without the disposition ("is not an attached picture"), silently.
  return muxer.cover !== 'drop' || pic
}

function writeOutput(pass, knobs, streams, inputs) {
  if (pass.kind === 'cover') return writeCover(pass, streams)
  const muxer = MUXERS[pass.muxer]
  const audio = streams.filter((stream) => stream.type === 'a')
  if (audio.length !== 1) {
    throw headerFailure(pass, `expected one audio stream, got ${audio.length}`)
  }
  const [{ header: input, payload }] = audio
  const encoded = pass.audioCodec !== 'copy'
  const codec = encoded ? (AUDIO_ENCODERS[pass.audioCodec] ?? pass.audioCodec) : input.codec
  if (!muxer.audio(codec)) {
    throw headerFailure(pass, `Unsupported codec ${codec} for the ${pass.muxer} muxer`)
  }
  const cover = keepsCover(pass, muxer, streams)
  const channels = encoded ? (pass.channels ?? input.channels) : input.channels
  const sampleRate = encoded ? (pass.sampleRate ?? input.sampleRate) : input.sampleRate
  const pcmBits = Number(/^pcm_[suf](\d+)/.exec(codec)?.[1] ?? Number.NaN)
  const bitRate = !encoded
    ? input.bitRate
    : (pass.bitRate ?? (pcmBits > 0 ? sampleRate * channels * pcmBits : undefined))
  // Like ffmpeg, the global tags of the first input carry over unless -map_metadata says otherwise.
  const from = inputs[pass.mapMetadata ?? 0]?.find((stream) => stream.type === 'a')
  let tags = pass.mapMetadata === -1 ? {} : { ...from?.header.tags }
  for (const [key, value] of Object.entries(pass.tags)) {
    if (value === '') delete tags[key]
    else tags[key] = value
  }
  if (pass.muxer === 'mp3' && pass.id3v2Version === '0') tags = {}
  if (knobFor(knobs, 'FAKE_FFMPEG_DROP_TAGS', 'audio')) tags = {}
  const short = knobFor(knobs, 'FAKE_FFMPEG_SHORT', 'audio') ? 0.5 : 1
  const header = {
    probe: typeof muxer.probe === 'string' ? muxer.probe : muxer.probe[encoded ? 'encode' : 'copy'],
    codec,
    durationSec: input.durationSec * short,
    sampleRate,
    channels,
    ...(bitRate === undefined ? {} : { bitRate }),
    tags,
    cover,
  }
  const bytes = pass.muxer === 'aiff' ? aiffBytes(header, payload) : audioBytes(header, payload)
  writeFileSync(pass.path, bytes, { flag: 'wx' })
}

/** One ffmpeg run; returns its stderr lines, or hangs. */
async function ffmpeg(argv, knobs) {
  const pass = parseFfmpeg(argv)
  failIfAsked(knobs, pass.kind)
  if (pass.kind === 'measure') return measure(pass, knobs)
  const output = prepareOutput(pass, knobs)
  if (output.write === undefined) return output.lines
  if (knobFor(knobs, 'FAKE_FFMPEG_HANG', pass.kind)) {
    // ffmpeg has opened its output by the time it is busy.
    writeFileSync(pass.path, '')
    if (output.lines.length > 0) process.stderr.write(`${output.lines.join('\n')}\n`)
    await hangForever()
  }
  try {
    output.write()
  } catch (error) {
    if (error instanceof FfmpegExit) error.lines.unshift(...output.lines)
    throw error
  }
  return output.lines
}

/** A recorded ffprobe JSON with the header's values (see the comment at the top). */
function probeJson(header) {
  const synthetic = header.probe.startsWith('synthetic:')
  const json = synthetic
    ? {
        programs: [],
        stream_groups: [],
        streams: [{ index: 0, codec_type: 'audio', disposition: { attached_pic: 0 } }],
        format: { format_name: header.probe.slice('synthetic:'.length) },
      }
    : structuredClone(readJson(fixturePath(header.probe)))
  const streams = Array.isArray(json.streams) ? json.streams : []
  const audio = streams.find((stream) => stream?.codec_type === 'audio')
  if (audio === undefined || !isObject(json.format)) {
    usage(`${header.probe}: no audio stream or format to fill in`)
  }
  audio.codec_name = header.codec
  audio.sample_rate = String(header.sampleRate)
  audio.channels = header.channels
  if (header.bitRate === undefined) delete audio.bit_rate
  else audio.bit_rate = String(Math.round(header.bitRate))
  json.format.duration = (header.estimatedSec ?? header.durationSec).toFixed(6)

  const formatName = String(json.format.format_name)
  const owner = formatName === 'ogg' ? audio : json.format
  const keyOf = (key) =>
    formatName.includes('matroska') && key.toLowerCase() !== 'title'
      ? key.toUpperCase()
      : key.toLowerCase()
  const tags = Object.fromEntries(
    Object.entries(owner.tags ?? {}).filter(([key]) => !USER_TAGS.has(key.toLowerCase())),
  )
  for (const [key, value] of Object.entries(header.tags)) tags[keyOf(key)] = value
  if (Object.keys(tags).length > 0) owner.tags = tags
  else delete owner.tags

  const isPic = (stream) => stream?.disposition?.attached_pic === 1
  let kept = streams.filter((stream) => header.cover || !isPic(stream))
  if (header.cover && !kept.some(isPic)) {
    kept = [...kept, { codec_name: 'mjpeg', codec_type: 'video', disposition: { attached_pic: 1 } }]
  }
  json.streams = kept.map((stream, index) => ({ ...stream, index }))
  return json
}

function imageProbe(media) {
  if (typeof media.info.probe === 'string') return readJson(fixturePath(media.info.probe))
  return {
    programs: [],
    stream_groups: [],
    streams: [
      {
        index: 0,
        codec_name: IMAGE_CODECS[media.format],
        codec_type: 'video',
        disposition: { attached_pic: 0 },
      },
    ],
    format: { format_name: `${media.format}_pipe` },
  }
}

function parseFfprobe(argv) {
  const values = new Map()
  const files = []
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (token === '-hide_banner') continue
    if (
      [
        '-v',
        '-loglevel',
        '-show_entries',
        '-of',
        '-print_format',
        '-output_format',
        '-protocol_whitelist',
        '-i',
      ].includes(token)
    ) {
      const value = argv[++i]
      if (value === undefined) usage(`${token} needs a value`)
      if (token === '-i') files.push(value)
      else values.set(token, value)
    } else if (token.startsWith('-')) usage(`unknown option ${token}`)
    else files.push(token)
  }
  if ((values.get('-v') ?? values.get('-loglevel')) !== 'error') usage('-v error is missing')
  const format = values.get('-of') ?? values.get('-print_format') ?? values.get('-output_format')
  if (format !== 'json') usage('-of json is missing: the server parses JSON')
  if (values.get('-show_entries') !== RECORDED_ENTRIES) {
    usage(`the fixtures were recorded with -show_entries ${RECORDED_ENTRIES}`)
  }
  const whitelist = values.get('-protocol_whitelist')
  if (whitelist !== undefined && whitelist !== 'file') usage('-protocol_whitelist must be file')
  if (files.length !== 1) usage(`expected one input file, got ${files.length}`)
  return absolute(files[0], 'the input')
}

async function ffprobe(argv, knobs) {
  const file = parseFfprobe(argv)
  failIfAsked(knobs, 'ffprobe')
  if (knobFor(knobs, 'FAKE_FFMPEG_HANG', 'ffprobe')) await hangForever()
  let bytes
  try {
    bytes = readFileSync(file)
  } catch (error) {
    const reason = error.code === 'ENOENT' ? 'No such file or directory' : 'Permission denied'
    throw new FfmpegExit(1, [`${file}: ${reason}`])
  }
  const media = readMedia(bytes)
  if (media === undefined) {
    throw new FfmpegExit(1, [`${file}: Invalid data found when processing input`])
  }
  let json
  if (media.kind === 'image') json = imageProbe(media)
  else {
    const header = { ...media.header }
    if (knobFor(knobs, 'FAKE_FFMPEG_SHORT', 'ffprobe')) {
      header.durationSec /= 2
      if (header.estimatedSec !== undefined) header.estimatedSec /= 2
    }
    if (knobFor(knobs, 'FAKE_FFMPEG_DROP_TAGS', 'ffprobe')) header.tags = {}
    json = probeJson(header)
  }
  process.stdout.write(`${JSON.stringify(json, null, 4)}\n`)
  return []
}

async function main() {
  const link = process.argv[1] ?? ''
  const name = path.basename(link)
  tool = name.includes('ffprobe') ? 'ffprobe' : 'ffmpeg'
  if (!name.includes('ffmpeg') && !name.includes('ffprobe')) {
    usage(`link me as ffmpeg or ffprobe, not ${name}`)
  }
  const argv = process.argv.slice(2)
  const rawKnobs = readKnobs(link)
  if (rawKnobs.FAKE_FFMPEG_CALLS !== undefined) {
    const record = { tool, argv, time: Date.now(), pid: process.pid }
    appendFileSync(rawKnobs.FAKE_FFMPEG_CALLS, `${JSON.stringify(record)}\n`)
  }
  if (argv.includes('-version')) {
    const version = path.join(FIXTURES, 'engine', `${tool}-version-8.0-brew.txt`)
    process.stdout.write(readFileSync(version))
    return
  }
  const knobs = parseKnobs(rawKnobs)
  let lines
  try {
    lines = tool === 'ffprobe' ? await ffprobe(argv, knobs) : await ffmpeg(argv, knobs)
  } catch (error) {
    if (!(error instanceof FfmpegExit)) throw error
    if (error.emptyOutput !== undefined) writeFileSync(error.emptyOutput, '')
    if (error.lines.length > 0) process.stderr.write(`${error.lines.join('\n')}\n`)
    process.exitCode = error.code
    return
  }
  if (lines.length > 0) process.stderr.write(`${lines.join('\n')}\n`)
}

try {
  await main()
} catch (error) {
  if (!(error instanceof UsageError)) throw error
  process.stderr.write(`fake-${tool}: ${error.message}\n`)
  process.exitCode = 2
}
