import type { PreviewRequest, RemixUpload } from '@dj-scraper/shared'
import { api } from '@/lib/api.ts'
import { isAbortError } from '@/lib/error-text.ts'
import { clampRate } from './preview-rate.ts'
import type { RemixJobsStore } from './remix-jobs.ts'

/**
 * The one remix player of the app (ADR-029): a single `<audio>` element and its state, outside React
 * so that only one upload plays at a time wherever its row is, and the speed and pitch lock the DJ
 * set stay for the session. Rows read it through `use-preview-player.ts`, the now-playing bar
 * (`now-playing-bar.tsx`) reads all of it.
 *
 * It plays the upload's own stream as the server cached it, not the file a download would make.
 */

export type PreviewStatus = 'idle' | 'preparing' | 'playing' | 'paused' | 'error'

/** What the now-playing bar shows and does for the upload being prepared or played. */
export type NowPlayingDetails = {
  /** What the version is and by whom: "Remix by Arty". */
  credit?: string
  /** The part of the title that tells the version apart ("Arty Remix"), as its row shows it. */
  version?: string
  /**
   * The rows' jobs of the remix section that started it: the bar's Download records its job there,
   * so the row shows it, and the section stops the player when it unmounts (`releasePreview`).
   */
  jobs: RemixJobsStore
}

export type NowPlaying = NowPlayingDetails & { upload: RemixUpload }

export type PreviewState = {
  /** The upload being prepared or played (`platform:id`), or null. */
  key: string | null
  /** That upload and what the bar shows of it; null exactly when `key` is. */
  nowPlaying: NowPlaying | null
  status: PreviewStatus
  /** Why it failed, when `status` is `error`: an ApiError, or an Error for the element's own. */
  error: unknown
  currentTime: number
  /** The element's duration once known; undefined while unknown or endless. */
  duration: number | undefined
  /** 1 = the upload's own speed. Kept across uploads, rows and sources. */
  rate: number
  /** Keep the pitch while the speed changes (a DJ's key lock). */
  preservesPitch: boolean
}

/** What a row with no preview of its own sees: one constant, so it never re-renders for others. */
export const IDLE_PREVIEW: PreviewState = {
  key: null,
  nowPlaying: null,
  status: 'idle',
  error: null,
  currentTime: 0,
  duration: undefined,
  rate: 1,
  preservesPitch: true,
}

export const previewKey = (upload: Pick<RemixUpload, 'platform' | 'id'>) =>
  `${upload.platform}:${upload.id}`

let state: PreviewState = IDLE_PREVIEW
let audio: HTMLAudioElement | null = null
let request: AbortController | null = null
const listeners = new Set<() => void>()

function set(patch: Partial<PreviewState>) {
  state = { ...state, ...patch }
  for (const listener of listeners) listener()
}

export function subscribePreview(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export const getPreviewState = (): PreviewState => state

/** The element, for tests. */
export function previewAudio(): HTMLAudioElement {
  return element()
}

function setPitchLock(el: HTMLAudioElement, on: boolean) {
  el.preservesPitch = on
  // Safari before 17 only has the prefixed property.
  ;(el as HTMLAudioElement & { webkitPreservesPitch?: boolean }).webkitPreservesPitch = on
}

/** Loading a source resets the element's speed, so each new source gets it applied again. */
function applyRate(el: HTMLAudioElement) {
  el.defaultPlaybackRate = state.rate
  el.playbackRate = state.rate
  setPitchLock(el, state.preservesPitch)
}

function finiteOrUndefined(value: number): number | undefined {
  return Number.isFinite(value) && value > 0 ? value : undefined
}

function element(): HTMLAudioElement {
  if (audio !== null) return audio
  const el = new Audio()
  el.preload = 'auto'
  // In the page, hidden, so it can be found (e2e specs read its speed and pitch lock).
  el.hidden = true
  el.dataset.slot = 'preview-audio'
  document.body.append(el)
  el.addEventListener('timeupdate', () => {
    if (state.status !== 'idle') set({ currentTime: el.currentTime })
  })
  const duration = () => {
    if (state.key !== null) set({ duration: finiteOrUndefined(el.duration) })
  }
  el.addEventListener('durationchange', duration)
  el.addEventListener('loadedmetadata', duration)
  el.addEventListener('playing', () => {
    if (state.key !== null && state.status !== 'preparing') set({ status: 'playing' })
  })
  el.addEventListener('pause', () => {
    if (state.status === 'playing') set({ status: 'paused', currentTime: el.currentTime })
  })
  el.addEventListener('ended', () => {
    if (state.key !== null) set({ status: 'paused', currentTime: 0 })
    el.currentTime = 0
  })
  el.addEventListener('error', () => {
    // An emptied element (src removed on stop) also fires one: only a live preview is a failure.
    if (state.key === null || state.status === 'preparing' || state.status === 'idle') return
    set({ status: 'error', error: new Error("This audio can't be played.") })
  })
  audio = el
  return el
}

/** Drops whatever is preparing or playing and leaves the player idle (speed and pitch stay). */
export function stopPreview() {
  request?.abort()
  request = null
  if (audio !== null) {
    audio.pause()
    audio.removeAttribute('src')
    audio.load()
  }
  set({
    key: null,
    nowPlaying: null,
    status: 'idle',
    error: null,
    currentTime: 0,
    duration: undefined,
  })
}

/**
 * Stops the player only if the remix section whose rows' jobs are `jobs` started what it holds: that
 * section leaving the page (a new paste). A row leaving (the genre filter, a new answer) doesn't stop
 * it: the bar keeps playing.
 */
export function releasePreview(jobs: RemixJobsStore) {
  if (state.nowPlaying?.jobs === jobs) stopPreview()
}

async function start(upload: RemixUpload, details: NowPlayingDetails) {
  stopPreview()
  const key = previewKey(upload)
  const controller = new AbortController()
  request = controller
  set({ key, nowPlaying: { ...details, upload }, status: 'preparing', error: null })
  const body: PreviewRequest = { platform: upload.platform, id: upload.id, url: upload.url }
  try {
    const ready = await api.createPreview(body, controller.signal)
    if (controller.signal.aborted) return
    request = null
    const el = element()
    el.src = ready.src
    applyRate(el)
    set({ status: 'paused' })
    await el.play()
    if (controller.signal.aborted || state.key !== key) return
  } catch (error) {
    if (controller.signal.aborted || isAbortError(error) || state.key !== key) return
    request = null
    set({ status: 'error', error: playError(error) })
  }
}

/** `play()` rejects with the browser's own words ("no supported source was found"): say it ours. */
function playError(error: unknown): unknown {
  if (!(error instanceof DOMException)) return error
  return new Error(
    error.name === 'NotAllowedError'
      ? 'The browser blocked playback. Press Play again.'
      : "This audio can't be played.",
  )
}

/**
 * What a row's button and the bar's do: start this upload (stopping any other), cancel its
 * preparation, pause it, resume it, or try again after a failure. `details` are what the bar shows
 * and where its Download goes; a retry keeps the ones it started with.
 */
export function togglePreview(upload: RemixUpload, details: NowPlayingDetails) {
  const key = previewKey(upload)
  if (state.key !== key) {
    void start(upload, details)
    return
  }
  switch (state.status) {
    case 'preparing':
      stopPreview()
      return
    case 'playing':
      audio?.pause()
      return
    case 'paused':
      audio?.play().catch((error: unknown) => {
        if (state.key === key) set({ status: 'error', error: playError(error) })
      })
      return
    case 'error':
      void start(upload, state.nowPlaying ?? details)
      return
    case 'idle':
      return
  }
}

export function seekPreview(seconds: number) {
  if (audio === null || state.key === null) return
  const limit = state.duration ?? seconds
  audio.currentTime = Math.min(Math.max(0, seconds), limit)
  set({ currentTime: audio.currentTime })
}

export function setPreviewRate(rate: number) {
  const next = clampRate(rate)
  set({ rate: next })
  if (audio !== null) applyRate(audio)
}

export function setPreviewPitchLock(on: boolean) {
  set({ preservesPitch: on })
  if (audio !== null) applyRate(audio)
}

/** Tests only: a fresh player (no speed or pitch lock kept, no element). */
export function resetPreviewPlayer() {
  stopPreview()
  audio = null
  state = IDLE_PREVIEW
  listeners.clear()
}
