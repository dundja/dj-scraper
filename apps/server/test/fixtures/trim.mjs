#!/usr/bin/env node
// Trims and scrubs a yt-dlp `-J` dump so it can be checked in as a fixture.
//
//   yt-dlp … -J … -- <url> | node test/fixtures/trim.mjs > youtube/video.json
//
// Reads JSON on stdin and writes 2-space JSON on stdout. Bulk the parsers never read (captions,
// heatmaps, fragments, request headers) is dropped. Format URLs are replaced, because googlevideo
// URLs embed the recorder's public IP and SoundCloud stream URLs carry signed tokens. Every other
// metadata field is kept, and so is every playlist entry. Exits 1 without output if anything that
// looks like an IP, a signature or a token survives, so a leak can't be written silently.

import { exit, stderr, stdin, stdout } from 'node:process'

/** Keys dropped wherever they appear: bulk, or request state that can carry cookies and tokens. */
const DROP_KEYS = new Set([
  'automatic_captions',
  'subtitles',
  'requested_subtitles',
  'heatmap',
  'requested_formats',
  'requested_downloads',
  'fragments',
  'http_headers',
  'cookies',
  'comments',
])

/** Format fields that hold stream URLs, and the placeholder suffix each one gets. */
const URL_KEYS = { url: '', manifest_url: '/manifest', fragment_base_url: '/fragments/' }

const MAX_DESCRIPTION = 200
const MAX_THUMBNAILS = 5
const MAX_NON_AUDIO_FORMATS = 2

/** What must never reach a fixture. Checked on every string after trimming. */
const LEAKS = [
  { name: 'googlevideo URL', test: (s) => /googlevideo\.com/i.test(s) },
  {
    name: 'signed or authenticated URL',
    test: (s) =>
      /[?&](?:client_id|oauth_token|secret_token|access_token|token|Signature|Policy|Key-Pair-Id|sig|lsig|ip)=/i.test(
        s,
      ),
  },
  { name: 'IP in a URL path', test: (s) => /\/ip\/\d/.test(s) },
  {
    name: 'IPv4 address in a URL',
    test: (s) =>
      /^https?:/i.test(s) && /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/.test(s.split('?')[0]),
  },
]

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

/** Cuts by code points, so an emoji is never split in half. */
function cutDescription(text) {
  const chars = Array.from(text)
  return chars.length <= MAX_DESCRIPTION ? text : `${chars.slice(0, MAX_DESCRIPTION - 1).join('')}…`
}

/**
 * Keeps the smallest and the largest thumbnail, then the best of the rest. yt-dlp sorts thumbnails
 * worst to best, so the last one is the best even when it has no size (SoundCloud's `original`).
 */
function trimThumbnails(list) {
  if (list.length <= MAX_THUMBNAILS) return list
  const area = (t) =>
    isObject(t) && typeof t.width === 'number' && typeof t.height === 'number'
      ? t.width * t.height
      : null
  const sized = list.map((t, i) => ({ i, a: area(t) })).filter((x) => x.a !== null)
  const keep = new Set([list.length - 1])
  if (sized.length > 0) {
    keep.add(sized.reduce((min, x) => (x.a < min.a ? x : min)).i)
    keep.add(sized.reduce((max, x) => (x.a >= max.a ? x : max)).i)
  } else {
    keep.add(0)
  }
  for (let i = list.length - 2; i >= 0 && keep.size < MAX_THUMBNAILS; i--) keep.add(i)
  return list.filter((_, i) => keep.has(i))
}

const isAudioOnly = (f) => f.vcodec === 'none' && f.acodec !== 'none'
const hasAudioAndVideo = (f) =>
  typeof f.acodec === 'string' &&
  f.acodec !== 'none' &&
  typeof f.vcodec === 'string' &&
  f.vcodec !== 'none'

/**
 * Keeps every audio-only format (what we download) plus two others for contrast: the best muxed
 * format if there is one, then the best video. Storyboards (mhtml) are dropped first.
 */
function trimFormats(list) {
  const formats = list.filter(isObject)
  const others = formats.filter((f) => !isAudioOnly(f) && f.ext !== 'mhtml')
  const muxed = others.filter(hasAudioAndVideo).at(-1)
  const picked = muxed ? [muxed] : []
  for (let i = others.length - 1; i >= 0 && picked.length < MAX_NON_AUDIO_FORMATS; i--) {
    if (others[i] !== muxed) picked.push(others[i])
  }
  return formats.filter((f) => isAudioOnly(f) || picked.includes(f))
}

/** Replaces stream URLs on a format (or on a video merged with its chosen format). */
function scrubFormatUrls(obj) {
  const id = encodeURIComponent(String(obj.format_id ?? 'unknown'))
  for (const [key, suffix] of Object.entries(URL_KEYS)) {
    if (typeof obj[key] === 'string') obj[key] = `https://example.invalid/${id}${suffix}`
  }
}

function trim(value) {
  if (Array.isArray(value)) return value.map(trim)
  if (!isObject(value)) return value
  const out = {}
  for (const [key, child] of Object.entries(value)) {
    if (DROP_KEYS.has(key)) continue
    out[key] = trim(child)
  }
  if (typeof out.description === 'string') out.description = cutDescription(out.description)
  if (Array.isArray(out.thumbnails)) out.thumbnails = trimThumbnails(out.thumbnails)
  if (Array.isArray(out.formats)) {
    out.formats = trimFormats(out.formats)
    for (const f of out.formats) scrubFormatUrls(f)
  }
  // A resolved video carries its chosen format's fields, stream URL included. Flat entries have
  // no format_id, so their page `url` is kept.
  if (typeof out.format_id === 'string') scrubFormatUrls(out)
  // yt-dlp's geo-bypass address: never keep an IP, even a made-up one.
  if ('__x_forwarded_for_ip' in out && out.__x_forwarded_for_ip !== null) {
    out.__x_forwarded_for_ip = null
  }
  return out
}

function findLeaks(value, path, found) {
  if (typeof value === 'string') {
    for (const leak of LEAKS) if (leak.test(value)) found.push(`${path}: ${leak.name}`)
  } else if (Array.isArray(value)) {
    for (const [i, child] of value.entries()) findLeaks(child, `${path}[${i}]`, found)
  } else if (isObject(value)) {
    for (const [key, child] of Object.entries(value)) findLeaks(child, `${path}.${key}`, found)
  }
  return found
}

let input = ''
stdin.setEncoding('utf8')
for await (const chunk of stdin) input += chunk

let info
try {
  info = JSON.parse(input)
} catch (error) {
  stderr.write(`trim: stdin is not JSON (${error instanceof Error ? error.message : error})\n`)
  exit(1)
}

const trimmed = trim(info)
const leaks = findLeaks(trimmed, '$', [])
if (leaks.length > 0) {
  stderr.write(`trim: refusing to write, possible leaks:\n  ${leaks.join('\n  ')}\n`)
  exit(1)
}
stdout.write(`${JSON.stringify(trimmed, null, 2)}\n`)
