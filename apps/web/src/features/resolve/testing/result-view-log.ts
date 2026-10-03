// What the result-view doubles (fake-result-views.tsx) were mounted with, for the resolve tests.

export type ViewMount =
  | { view: 'track'; id: string; autoStart: boolean }
  | { view: 'collection'; id: string }

/**
 * One entry per mount (or props change) of a double, in order; StrictMode's simulated remount
 * doesn't count. Tests clear it in beforeEach.
 */
export const viewMounts: ViewMount[] = []
