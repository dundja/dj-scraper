// A fake local server behind the global fetch: tests drive the app through the network edge only.
import { vi } from 'vitest'

/** One request the app sent, as the fake server saw it. */
export type ApiCall = {
  method: string
  url: string
  headers: Headers
  body: RequestInit['body']
  signal: AbortSignal | null
}

type Route = `${'GET' | 'POST' | 'PUT' | 'DELETE'} /api/${string}`
type Handler = (call: ApiCall) => Response | Promise<Response>

/**
 * Replaces fetch (vitest.config.ts restores it after each test). Each route answers with its
 * handler; until a handler's answer arrives, an abort rejects with the signal's reason, as fetch
 * does. A route without a handler fails like a network error and lands in `unhandled`, which
 * tests assert stays empty, so a wrong URL can't pass as "server offline".
 */
export function fakeApi() {
  const handlers = new Map<string, Handler>()
  const calls: ApiCall[] = []
  const unhandled: string[] = []

  const fetch = (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const call: ApiCall = {
      method: init.method ?? 'GET',
      url: String(input),
      headers: new Headers(init.headers),
      body: init.body,
      signal: init.signal ?? null,
    }
    calls.push(call)
    const route = `${call.method} ${call.url}`
    const handler = handlers.get(route)
    if (handler === undefined) {
      unhandled.push(route)
      return Promise.reject(new TypeError(`No fake route for ${route}`))
    }
    return abortable(() => handler(call), call.signal)
  }
  vi.stubGlobal('fetch', fetch)

  return {
    unhandled,
    /** Sets (or replaces) how a route answers, e.g. when the server goes down mid-test. */
    on(route: Route, handler: Handler) {
      handlers.set(route, handler)
    },
    /** The requests the app sent to `route`, in order. */
    callsTo(route: Route): ApiCall[] {
      return calls.filter((call) => `${call.method} ${call.url}` === route)
    },
  }
}

function abortable(
  answer: () => Response | Promise<Response>,
  signal: AbortSignal | null,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason)
      return
    }
    const onAbort = () => reject(signal?.reason)
    signal?.addEventListener('abort', onAbort, { once: true })
    Promise.resolve()
      .then(answer)
      .then(resolve, reject)
      .finally(() => signal?.removeEventListener('abort', onAbort))
  })
}

/** A JSON reply, like the server's. */
export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/** A non-JSON reply, e.g. Vite's proxy answering 502 with an empty text/plain body. */
export function text(body: string, status: number, contentType = 'text/plain'): Response {
  return new Response(body, { status, headers: { 'Content-Type': contentType } })
}

/** What fetch does when nothing listens: it rejects with a TypeError. */
export function networkError(): Promise<Response> {
  return Promise.reject(new TypeError('Failed to fetch'))
}

/** An answer that never arrives (until the request is aborted). */
export function noAnswer(): Promise<Response> {
  return new Promise(() => {})
}
