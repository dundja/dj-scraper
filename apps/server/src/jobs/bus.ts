import { type ServerEvent, ServerEventSchema } from '@dj-scraper/shared'
import type { Logger } from '../resolve/ytdlp-call.ts'
import { failureName } from '../util/errno.ts'

/** Gets each event with its JSON, serialized once for every listener (each SSE stream). */
export type BusListener = (event: ServerEvent, json: string) => void

/** The typed event bus between the queue and the SSE streams. */
export type Bus = {
  /**
   * Hands `event` to every listener, in subscription order. A listener that throws is logged and
   * skipped; the others still get the event. With `assertContract`, an event off the contract
   * throws (a ZodError) before any listener sees it.
   */
  emit(event: ServerEvent): void
  /** Returns the unsubscribe; calling it again does nothing. */
  subscribe(listener: BusListener): () => void
  readonly subscribers: number
}

export type BusOptions = {
  /** Checks every event against `ServerEventSchema` first (dev and tests). Default false. */
  assertContract?: boolean
  log?: Logger
}

export function createBus({ assertContract = false, log = console }: BusOptions = {}): Bus {
  const listeners = new Set<{ listener: BusListener }>()
  return {
    emit(event) {
      if (assertContract) ServerEventSchema.parse(event)
      const json = JSON.stringify(event)
      // A snapshot: a listener may unsubscribe itself, or subscribe another, while it runs.
      for (const entry of [...listeners]) {
        if (!listeners.has(entry)) continue
        try {
          entry.listener(event, json)
        } catch (error) {
          log.error(`[bus] A ${event.type} listener failed: ${failureName(error)}`)
        }
      }
    },
    subscribe(listener) {
      // A wrapper per call, so subscribing the same function twice needs two unsubscribes.
      const entry = { listener }
      listeners.add(entry)
      return () => {
        listeners.delete(entry)
      }
    },
    get subscribers() {
      return listeners.size
    },
  }
}
