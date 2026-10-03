import type { DataDirLock } from './data-dir.ts'
import type { Queue } from './jobs/queue.ts'
import type { EventStreams } from './routes/events.ts'
import type { RunningServer } from './server.ts'
import type { SettingsStore } from './settings/store.ts'

/** What a graceful shutdown stops, once boot has made it. */
export type Services = {
  queue: Pick<Queue, 'close'>
  streams: Pick<EventStreams, 'closeAll'>
  settings: Pick<SettingsStore, 'flush'>
  running: Pick<RunningServer, 'close'>
  lock: Pick<DataDirLock, 'release'>
}

/**
 * The shutdown order (design §3, D9, D11):
 * 1. The queue stops every running job (SIGINT to its group, SIGKILL after 3 s, job dir removed)
 *    while every event stream ends cleanly, so the browser (and Vite's proxy) sees the end and
 *    reconnects to the next server.
 * 2. The settings reach the disk.
 * 3. The server closes, dropping any connection left.
 * 4. The data dir lock goes last, so the next server can't sweep jobs this one still runs.
 */
export async function shutDown({ queue, streams, settings, running, lock }: Services) {
  try {
    await Promise.all([queue.close(), streams.closeAll()])
    await settings.flush()
    await running.close()
  } finally {
    lock.release()
  }
}
