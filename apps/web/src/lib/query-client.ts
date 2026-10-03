import { type DefaultOptions, QueryClient } from '@tanstack/react-query'

/**
 * Defaults for every QueryClient: the app's (main.tsx) and the tests' (src/test/render.tsx).
 *
 * Every request goes to the local server on 127.0.0.1, so the browser's online state says nothing
 * about reaching it. TanStack's default network mode ('online') would pause every query and
 * mutation while the browser says it is offline (Wi-Fi off): a settings change would look saved but
 * never be sent, a folder pick couldn't be canceled and would open its dialog on reconnect, and a
 * resolve would wait instead of showing the server's own error.
 */
export const queryClientDefaults = {
  queries: { networkMode: 'always' },
  mutations: { networkMode: 'always' },
} satisfies DefaultOptions

export function createQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: queryClientDefaults })
}
