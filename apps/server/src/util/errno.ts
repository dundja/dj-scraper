/** The `code` of an fs or spawn error (`ENOENT`, `EACCES`, …); undefined for anything else. */
export function errnoCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  return typeof error.code === 'string' ? error.code : undefined
}

/**
 * What a log line (or an error's wording) may say about a failure: its code (an errno code, or a
 * StepError's), else its name (`TypeError`), else its type. Never its message: fs, spawn and engine
 * messages hold paths, URLs and titles (D18).
 */
export function failureName(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    if ('code' in error && typeof error.code === 'string') return error.code
    if ('name' in error && typeof error.name === 'string') return error.name
  }
  return typeof error
}
