import { QueryClientProvider } from '@tanstack/react-query'
import { createRouter, RouterProvider } from '@tanstack/react-router'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { startEvents } from '@/lib/events.ts'
import { createQueryClient } from '@/lib/query-client.ts'
import { routeTree } from './routeTree.gen.ts'
import './styles.css'

const queryClient = createQueryClient()
// One event stream per tab for the app's lifetime, started here rather than in an effect, which
// StrictMode runs twice. It feeds ['downloads'] and flips the engine chip when the server drops.
startEvents(queryClient)

const router = createRouter({
  routeTree,
  context: { queryClient },
  defaultPreload: 'intent',
  scrollRestoration: true,
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

const rootElement = document.getElementById('root')
if (rootElement === null) throw new Error('index.html has no #root element')

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
)
