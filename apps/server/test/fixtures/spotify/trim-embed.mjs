#!/usr/bin/env node
// Scrubs a Spotify embed page (open.spotify.com/embed/<type>/<id>) so it can be checked in as a
// fixture.
//
//   curl -sS -H 'User-Agent: <desktop Chrome>' https://open.spotify.com/embed/track/<id> \
//     | node test/fixtures/spotify/trim-embed.mjs > test/fixtures/spotify/track.html
//
// Reads the page's HTML on stdin and writes a minimal HTML document on stdout whose only script is
// `__NEXT_DATA__`, holding nothing but `props.pageProps.state.data` (what spotify/embed.ts reads,
// `data.entity`, and its siblings). Everything else on the page goes: the anonymous access token
// and its session (`state.settings`), the client and correlation ids (`pageProps.config`), Sentry's
// trace data, the build id, the player's scripts and styles. Within `data`, the 30-second preview
// URLs (`audioPreview`) and a playlist's `attributes` (internal job and correlation ids) go too.
// Exits 1 without output if anything that looks like a token, a client or correlation id, Sentry
// data or a preview URL survives, so a leak can't be written silently.

import { exit, stderr, stdin, stdout } from 'node:process'

const NEXT_DATA = /<script\b[^>]*\bid="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/

/** Keys dropped wherever they appear inside `data`. */
const DROP_KEYS = new Set(['audioPreview', 'videoPreview', 'attributes'])

/** What must never reach a fixture: checked on the whole output, case-insensitively. */
const LEAKS = [
  { name: 'an access token', test: /access_?token/i },
  { name: 'a token field', test: /"[a-z_]*token[a-z_]*"\s*:/i },
  { name: 'a client id', test: /client_?id/i },
  { name: 'a correlation id', test: /correlation[-_]?id/i },
  { name: 'Sentry data', test: /sentry/i },
  { name: 'a session', test: /"session"\s*:/i },
  { name: 'a preview stream URL', test: /p\.scdn\.co\/mp3-preview/i },
]

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

function trim(value) {
  if (Array.isArray(value)) return value.map(trim)
  if (!isObject(value)) return value
  const out = {}
  for (const [key, child] of Object.entries(value)) {
    if (DROP_KEYS.has(key)) continue
    out[key] = trim(child)
  }
  return out
}

function fail(message) {
  stderr.write(`trim-embed: ${message}\n`)
  exit(1)
}

let input = ''
stdin.setEncoding('utf8')
for await (const chunk of stdin) input += chunk

const script = NEXT_DATA.exec(input)?.[1]
if (script === undefined) fail('stdin has no __NEXT_DATA__ script')

let page
try {
  page = JSON.parse(script)
} catch (error) {
  fail(`__NEXT_DATA__ is not JSON (${error instanceof Error ? error.message : error})`)
}
const data = page?.props?.pageProps?.state?.data
if (!isObject(data)) fail('__NEXT_DATA__ has no props.pageProps.state.data object')

// `<` is escaped as Next.js does, so no string can end the script early.
const json = JSON.stringify({ props: { pageProps: { state: { data: trim(data) } } } }, null, 2)
  .replaceAll('<', '\\u003c')
  .replaceAll('>', '\\u003e')
const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Spotify embed fixture (scrubbed)</title></head>
<body>
<script id="__NEXT_DATA__" type="application/json">
${json}
</script>
</body>
</html>
`
const leaks = LEAKS.filter((leak) => leak.test.test(html)).map((leak) => leak.name)
if (leaks.length > 0) fail(`refusing to write, possible leaks: ${leaks.join(', ')}`)
stdout.write(html)
