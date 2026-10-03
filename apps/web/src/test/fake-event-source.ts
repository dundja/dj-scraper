// The server end of EventSource, driven by tests. jsdom (and Node) have no EventSource at all.
import { vi } from 'vitest'

type ReadyState = 0 | 1 | 2

/**
 * An EventSource whose network side the test plays: `open()`, `send()`, `drop()` and `fail()` do
 * what the server and the browser would. It has the real constants, `readyState`, the `on*`
 * handlers and EventTarget listeners, and fires nothing once closed, like browsers.
 */
export class FakeEventSource extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 2
  readonly CONNECTING = 0
  readonly OPEN = 1
  readonly CLOSED = 2

  /** Every EventSource the app created, oldest first. */
  static instances: FakeEventSource[] = []

  readonly url: string
  readonly withCredentials: boolean
  readyState: ReadyState = 0
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null

  constructor(url: string | URL, init?: EventSourceInit) {
    super()
    this.url = String(url)
    this.withCredentials = init?.withCredentials ?? false
    FakeEventSource.instances.push(this)
  }

  close() {
    this.readyState = 2
  }

  // Test controls: what the server and the browser do.

  /** The server answered 200 text/event-stream (also after the browser's own reconnect). */
  open() {
    this.#expect(0, 'open')
    this.readyState = 1
    const event = new Event('open')
    this.onopen?.(event)
    this.dispatchEvent(event)
  }

  /** One `data:` event; anything but a string is JSON-encoded (send bad data as a string). */
  send(data: unknown) {
    this.#expect(1, 'send')
    const event = new MessageEvent('message', {
      data: typeof data === 'string' ? data : JSON.stringify(data),
      origin: window.location.origin,
    })
    this.onmessage?.(event)
    this.dispatchEvent(event)
  }

  /** The stream ended or the network failed: the browser retries by itself (CONNECTING). */
  drop() {
    this.#expect(1, 'drop')
    this.readyState = 0
    this.#error()
  }

  /** The browser gave up for good: a non-200 (Vite's 502, the guard's 403) or not event-stream. */
  fail() {
    if (this.readyState === 2) throw new Error('fail() on a closed EventSource')
    this.readyState = 2
    this.#error()
  }

  #error() {
    const event = new Event('error')
    this.onerror?.(event)
    this.dispatchEvent(event)
  }

  #expect(state: ReadyState, what: string) {
    if (this.readyState !== state) {
      throw new Error(`${what}() needs readyState ${state}, but it is ${this.readyState}`)
    }
  }
}

/**
 * Replaces the global EventSource (vitest.config.ts restores it after each test), like fakeApi()
 * does for fetch.
 */
export function fakeEventSource() {
  FakeEventSource.instances = []
  vi.stubGlobal('EventSource', FakeEventSource)
  return {
    /** Every EventSource the app created, oldest first. */
    get all(): readonly FakeEventSource[] {
      return FakeEventSource.instances
    },
    /** The newest EventSource; throws when the app made none. */
    get current(): FakeEventSource {
      const last = FakeEventSource.instances.at(-1)
      if (last === undefined) throw new Error('The app created no EventSource')
      return last
    },
  }
}
