import type { FolderPicker } from './fs/folder-picker.ts'
import type { Queue } from './jobs/queue.ts'
import type { DownloadsDeps } from './routes/downloads.ts'
import type { EventsDeps } from './routes/events.ts'
import type { FolderDeps } from './routes/folders.ts'
import type { ResolveDeps } from './routes/resolve.ts'
import type { SettingsDeps } from './routes/settings.ts'
import type { SettingsStore } from './settings/store.ts'

// For tests of other routes: services that fail loudly if a request reaches them. Spread
// UNUSED_DEPS next to the deps a test does use (createApp needs them all).

const message = (name: string) => `${name} is not stubbed in this test`
const unused = (name: string) => () => Promise.reject(new Error(message(name)))
const fails = (name: string) => (): never => {
  throw new Error(message(name))
}

export const UNUSED_RESOLVE_DEPS: ResolveDeps = {
  resolver: { resolve: unused('resolver.resolve') },
  // A cache that knows nothing is a correct answer, not a request reaching the enricher.
  enricher: { enrich: unused('enricher.enrich'), peek: () => undefined },
}

const UNUSED_QUEUE: Queue = {
  add: fails('queue.add'),
  snapshot: fails('queue.snapshot'),
  get: fails('queue.get'),
  cancel: fails('queue.cancel'),
  retry: fails('queue.retry'),
  cancelMany: fails('queue.cancelMany'),
  retryMany: fails('queue.retryMany'),
  clear: fails('queue.clear'),
  outputPathOf: fails('queue.outputPathOf'),
  setConcurrency: fails('queue.setConcurrency'),
  get closing(): boolean {
    return fails('queue.closing')()
  },
  close: unused('queue.close'),
}

const UNUSED_SETTINGS: SettingsStore = {
  get: fails('settings.get'),
  update: unused('settings.update'),
  rememberFolder: unused('settings.rememberFolder'),
  onChange: fails('settings.onChange'),
  flush: unused('settings.flush'),
}

const UNUSED_PICKER: FolderPicker = { pick: unused('picker.pick') }

/** The download pipeline's services: the queue, the event streams, settings, the folder picker. */
export const UNUSED_DOWNLOAD_DEPS: Omit<DownloadsDeps, 'enricher'> &
  EventsDeps &
  SettingsDeps &
  FolderDeps = {
  queue: UNUSED_QUEUE,
  settings: UNUSED_SETTINGS,
  locateEngine: unused('locateEngine'),
  dataDirReal: '/nonexistent/dj-scraper-data',
  defaultFolder: '/nonexistent/Music/DJ Scraper',
  streams: { respond: fails('streams.respond') },
  picker: UNUSED_PICKER,
}

/** Every service but health. */
export const UNUSED_DEPS = { ...UNUSED_RESOLVE_DEPS, ...UNUSED_DOWNLOAD_DEPS }
