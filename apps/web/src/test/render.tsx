import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from '@testing-library/react'
import type { ReactElement } from 'react'
import { queryClientDefaults } from '@/lib/query-client.ts'

/**
 * A fresh QueryClient with the app's defaults (src/lib/query-client.ts). Retries are off, and an
 * infinite gcTime leaves no garbage-collection timers behind after the test unmounts.
 */
export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { ...queryClientDefaults.queries, retry: false, gcTime: Number.POSITIVE_INFINITY },
      mutations: { ...queryClientDefaults.mutations, retry: false },
    },
  })
}

/** Renders `ui` under its own QueryClient (createTestQueryClient), as main.tsx provides one. */
export function renderWithQueryClient(ui: ReactElement) {
  const queryClient = createTestQueryClient()
  const result = render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>)
  return { ...result, queryClient }
}
