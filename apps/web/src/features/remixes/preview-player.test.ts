// The one app-wide remix player (ADR-029): preparing, playing, one at a time, cancel, errors, and
// the speed and pitch lock that outlive a source. fetch is the fake server; the element is jsdom's
// with the play/pause stand-in from src/test/setup.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeApi, json, jsonBody, noAnswer } from '@/test/fake-api.ts'
import { artyReupload, artySoundcloud, artyYoutube } from '@/test/remixes.ts'
import {
  getPreviewState,
  type NowPlayingDetails,
  previewAudio,
  releasePreview,
  resetPreviewPlayer,
  seekPreview,
  setPreviewPitchLock,
  setPreviewRate,
  stopPreview,
  togglePreview,
} from './preview-player.ts'
import { createRemixJobs } from './remix-jobs.ts'

const PREVIEWS = 'POST /api/previews'
const ready = (n: number) => ({
  id: n.toString(16).padStart(32, '0'),
  src: `/api/previews/${n.toString(16).padStart(32, '0')}`,
  mime: 'audio/mp4',
  sizeBytes: 1000,
})

let server: ReturnType<typeof fakeApi>
let served = 0
/** What a row passes: the credit is optional, its section's jobs store is not. */
const details: NowPlayingDetails = { jobs: createRemixJobs() }

beforeEach(() => {
  server = fakeApi()
  served = 0
  server.on(PREVIEWS, () => json(ready(++served)))
})

afterEach(() => {
  resetPreviewPlayer()
  expect(server.unhandled).toEqual([])
})

/** Lets the pending request and `play()` settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('starting', () => {
  it('asks for the upload, shows preparing, then plays the answer’s src', async () => {
    togglePreview(artyYoutube, details)

    expect(getPreviewState()).toMatchObject({ key: 'youtube:Kp7eSUU9oy8', status: 'preparing' })
    await settle()

    expect(jsonBody(server.callsTo(PREVIEWS)[0])).toEqual({
      platform: 'youtube',
      id: artyYoutube.id,
      url: artyYoutube.url,
    })
    expect(getPreviewState().status).toBe('playing')
    expect(previewAudio().getAttribute('src')).toBe(ready(1).src)
  })

  it('plays one upload at a time: starting another stops the first', async () => {
    togglePreview(artyYoutube, details)
    await settle()
    togglePreview(artySoundcloud, details)

    expect(getPreviewState()).toMatchObject({ key: 'soundcloud:279991262', status: 'preparing' })
    await settle()
    expect(getPreviewState()).toMatchObject({ key: 'soundcloud:279991262', status: 'playing' })
    expect(previewAudio().getAttribute('src')).toBe(ready(2).src)
  })

  it('an answer that arrives after another upload was chosen is dropped', async () => {
    let release: (value: Response) => void = () => {}
    server.on(PREVIEWS, (call) => {
      if ((jsonBody(call) as { id: string }).id === artyYoutube.id) {
        return new Promise<Response>((resolve) => (release = resolve))
      }
      return json(ready(2))
    })
    togglePreview(artyYoutube, details)
    togglePreview(artySoundcloud, details)
    await settle()
    release(json(ready(1)))
    await settle()

    expect(getPreviewState()).toMatchObject({ key: 'soundcloud:279991262', status: 'playing' })
    expect(previewAudio().getAttribute('src')).toBe(ready(2).src)
  })
})

describe('what plays', () => {
  it('holds the upload and what the bar shows of it, until the player stops', async () => {
    const jobs = createRemixJobs()
    togglePreview(artyYoutube, { credit: 'Remix by Arty', jobs })

    expect(getPreviewState().nowPlaying).toEqual({
      upload: artyYoutube,
      credit: 'Remix by Arty',
      jobs,
    })
    await settle()
    const other = createRemixJobs()
    togglePreview(artySoundcloud, { credit: 'Remix by Arty', jobs: other })
    expect(getPreviewState().nowPlaying).toEqual({
      upload: artySoundcloud,
      credit: 'Remix by Arty',
      jobs: other,
    })

    stopPreview()
    expect(getPreviewState().nowPlaying).toBeNull()
  })

  it('keeps them through a retry after a failure', async () => {
    server.on(PREVIEWS, () => json({ error: { code: 'unavailable', message: 'Gone.' } }, 404))
    const jobs = createRemixJobs()
    togglePreview(artyYoutube, { credit: 'Remix by Arty', jobs })
    await settle()
    expect(getPreviewState().status).toBe('error')

    server.on(PREVIEWS, () => json(ready(5)))
    // A retry keeps what it started with, whatever the caller passes.
    togglePreview(artyYoutube, details)
    expect(getPreviewState().nowPlaying).toMatchObject({ credit: 'Remix by Arty', jobs })
    await settle()
    expect(getPreviewState().status).toBe('playing')
  })
})

describe('pausing, resuming and cancelling', () => {
  it('pauses and resumes the same upload', async () => {
    togglePreview(artyYoutube, details)
    await settle()

    togglePreview(artyYoutube, details)
    expect(getPreviewState().status).toBe('paused')
    togglePreview(artyYoutube, details)
    expect(getPreviewState().status).toBe('playing')
    expect(server.callsTo(PREVIEWS)).toHaveLength(1)
  })

  it('cancels while preparing: the request is aborted and the player is idle', async () => {
    server.on(PREVIEWS, noAnswer)
    togglePreview(artyYoutube, details)
    const [call] = server.callsTo(PREVIEWS)

    togglePreview(artyYoutube, details)

    expect(call?.signal?.aborted).toBe(true)
    expect(getPreviewState()).toMatchObject({ key: null, status: 'idle' })
    await settle()
    expect(getPreviewState().status).toBe('idle')
  })

  it('stops only when the releasing section started what plays', async () => {
    const section = createRemixJobs()
    togglePreview(artyYoutube, { credit: 'Remix by Arty', jobs: section })
    await settle()

    releasePreview(createRemixJobs())
    expect(getPreviewState().status).toBe('playing')
    releasePreview(section)
    expect(getPreviewState()).toMatchObject({ status: 'idle', nowPlaying: null })
    expect(previewAudio().hasAttribute('src')).toBe(false)
  })

  it('shows a finished upload as paused at the start', async () => {
    togglePreview(artyYoutube, details)
    await settle()

    previewAudio().dispatchEvent(new Event('ended'))

    expect(getPreviewState()).toMatchObject({ status: 'paused', currentTime: 0 })
  })
})

describe('failures', () => {
  it('keeps the server’s error and tries again on the next toggle', async () => {
    server.on(PREVIEWS, () =>
      json({ error: { code: 'unavailable', message: 'This upload was removed.' } }, 404),
    )
    togglePreview(artyYoutube, details)
    await settle()

    expect(getPreviewState()).toMatchObject({
      status: 'error',
      error: { code: 'unavailable', status: 404 },
    })

    server.on(PREVIEWS, () => json(ready(9)))
    togglePreview(artyYoutube, details)
    await settle()
    expect(getPreviewState().status).toBe('playing')
  })

  it('words a rejected play() ours, not the browser’s', async () => {
    vi.spyOn(previewAudio(), 'play').mockRejectedValueOnce(
      new DOMException(
        'Failed to load because no supported source was found.',
        'NotSupportedError',
      ),
    )
    togglePreview(artyYoutube, details)
    await settle()

    expect(getPreviewState().status).toBe('error')
    expect((getPreviewState().error as Error).message).toBe("This audio can't be played.")
  })

  it('says a blocked play() can be pressed again', async () => {
    togglePreview(artyYoutube, details)
    await settle()
    togglePreview(artyYoutube, details)
    vi.spyOn(previewAudio(), 'play').mockRejectedValueOnce(
      new DOMException('play() can only be initiated by a user gesture.', 'NotAllowedError'),
    )

    togglePreview(artyYoutube, details)
    await settle()

    expect((getPreviewState().error as Error).message).toBe(
      'The browser blocked playback. Press Play again.',
    )
  })

  it('turns the element’s own error into a failure', async () => {
    togglePreview(artyYoutube, details)
    await settle()

    previewAudio().dispatchEvent(new Event('error'))

    expect(getPreviewState()).toMatchObject({ status: 'error' })
  })
})

describe('time', () => {
  it('follows the element and seeks within the duration', async () => {
    togglePreview(artyYoutube, details)
    await settle()
    const audio = previewAudio()
    Object.defineProperty(audio, 'duration', { configurable: true, value: 200 })
    audio.dispatchEvent(new Event('durationchange'))

    seekPreview(500)
    expect(audio.currentTime).toBe(200)
    seekPreview(30)
    expect(getPreviewState()).toMatchObject({ currentTime: 30, duration: 200 })
  })
})

describe('speed and pitch lock', () => {
  it('applies the speed and lock to the element, clamped', async () => {
    togglePreview(artyYoutube, details)
    await settle()

    setPreviewRate(1.07)
    expect(previewAudio().playbackRate).toBe(1.07)
    setPreviewRate(9)
    expect(getPreviewState().rate).toBe(1.5)
    setPreviewPitchLock(false)
    expect(previewAudio().preservesPitch).toBe(false)
    expect(
      (previewAudio() as unknown as { webkitPreservesPitch: boolean }).webkitPreservesPitch,
    ).toBe(false)
  })

  it('keeps them for the next upload, and sets them again on its new source', async () => {
    togglePreview(artyYoutube, details)
    await settle()
    setPreviewRate(1.25)
    setPreviewPitchLock(false)

    togglePreview(artyReupload, details)
    // Loading a source resets what the element holds, as a real one does.
    previewAudio().playbackRate = 1
    await settle()

    expect(getPreviewState()).toMatchObject({
      rate: 1.25,
      preservesPitch: false,
      status: 'playing',
    })
    expect(previewAudio().playbackRate).toBe(1.25)
    expect(previewAudio().preservesPitch).toBe(false)
  })

  it('keeps them after the player stops', () => {
    setPreviewRate(0.9)
    stopPreview()
    expect(getPreviewState().rate).toBe(0.9)
  })
})
