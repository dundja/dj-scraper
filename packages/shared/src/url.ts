import * as z from 'zod'

/**
 * An absolute http(s) URL. Rejects `javascript:`, `file:` and other schemes. Zod also demands `://`
 * only when given its own `httpProtocol` regex, so keep using it.
 */
export const HttpUrlSchema = z.url({ protocol: z.regexes.httpProtocol })
