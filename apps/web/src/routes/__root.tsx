import type { QueryClient } from '@tanstack/react-query'
import { createRootRouteWithContext, Link, Outlet } from '@tanstack/react-router'
import { Disc3 } from 'lucide-react'
import { EngineStatus } from '@/features/engine/engine-status.tsx'

export type RouterContext = { queryClient: QueryClient }

export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootLayout,
  notFoundComponent: NotFound,
})

function RootLayout() {
  return (
    <div className="flex min-h-svh flex-col">
      <header className="sticky top-0 z-10 flex h-12 shrink-0 items-center justify-between gap-4 border-b bg-background px-4">
        <Link
          to="/"
          className="-mx-1.5 flex items-center gap-2 rounded-md px-1.5 py-1 text-sm font-semibold tracking-tight outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Disc3 aria-hidden className="size-4.5 text-muted-foreground" />
          DJ Scraper
        </Link>
        <EngineStatus />
      </header>
      <main className="flex flex-1 flex-col">
        <Outlet />
      </main>
    </div>
  )
}

function NotFound() {
  return (
    <section className="mx-auto flex max-w-md flex-1 flex-col items-center justify-center gap-2 px-6 pb-24 text-center">
      <h1 className="text-base font-medium">Page not found</h1>
      <p className="text-sm text-muted-foreground">
        There's nothing at this address.{' '}
        <Link
          to="/"
          className="rounded-sm text-foreground underline underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Back to start
        </Link>
      </p>
    </section>
  )
}
