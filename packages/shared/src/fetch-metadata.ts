/** A request's method and Fetch Metadata headers (Sec-Fetch-Site/-Mode/-Dest), absent when not sent. */
export type FetchMetadata = {
  method: string
  site?: string | undefined
  mode?: string | undefined
  dest?: string | undefined
}

/**
 * The Fetch Metadata rule of the server's guard, also applied by the Vite dev server
 * (docs/architecture.md, Security model). Sec-Fetch-Site, when sent, must be same-origin or none
 * (a typed URL or bookmark). The one exception is a top-level navigation GET, so a link to the app
 * still works. That refuses cross-site and other-port <img>, <iframe>, fetch and sendBeacon.
 * Browsers send no Fetch Metadata to insecure origins, so this complements the Host and Origin
 * checks and never replaces them.
 */
export function allowedByFetchMetadata({ method, site, mode, dest }: FetchMetadata): boolean {
  if (site === undefined || site === 'same-origin' || site === 'none') return true
  return (method === 'GET' || method === 'HEAD') && mode === 'navigate' && dest === 'document'
}
