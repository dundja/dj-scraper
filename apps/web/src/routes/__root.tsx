import type { QueryClient } from '@tanstack/react-query'
import { createRootRouteWithContext, Link, Outlet } from '@tanstack/react-router'
import { Disc3 } from 'lucide-react'
import { TooltipProvider } from '@/components/ui/tooltip.tsx'
import { DownloadsPanel } from '@/features/downloads/downloads-panel.tsx'
import { EngineBanner } from '@/features/engine/engine-banner.tsx'
import { EngineStatus } from '@/features/engine/engine-status.tsx'
import { FolderPicker } from '@/features/folder/folder-picker.tsx'

export type RouterContext = { queryClient: QueryClient }

export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootLayout,
  notFoundComponent: NotFound,
})

/**
 * The shell: header (app name, target folder, engine status), the engine banner, then the page on
 * the left and the downloads on the right. On lg+ the shell is exactly the window's height and each
 * column scrolls on its own, so a long collection and the downloads list stay side by side; below
 * lg the columns stack and the page scrolls (virtualized lists then need a bounded height).
 */
function RootLayout() {
  return (
    // One provider, so moving between tooltips (e.g. down a list's icon buttons) opens them at once.
    <TooltipProvider delay={300}>
      <div className="flex min-h-svh flex-col lg:h-svh">
        <header className="sticky top-0 z-10 flex h-12 shrink-0 items-center gap-3 border-b bg-background px-4">
          <Link
            to="/"
            className="-mx-1.5 flex shrink-0 items-center gap-2 rounded-md px-1.5 py-1 text-sm font-semibold tracking-tight outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Disc3 aria-hidden className="size-4.5 text-muted-foreground" />
            DJ Scraper
          </Link>
          <div className="flex min-w-0 items-center">
            <FolderPicker />
          </div>
          <div className="ml-auto flex shrink-0 items-center">
            <EngineStatus />
          </div>
        </header>
        <EngineBanner />
        <div className="flex flex-1 flex-col lg:min-h-0 lg:flex-row">
          <main className="flex min-w-0 flex-1 flex-col lg:min-h-0 lg:overflow-y-auto">
            <Outlet />
          </main>
          <aside
            aria-label="Downloads"
            className="flex flex-col border-t lg:min-h-0 lg:w-96 lg:shrink-0 lg:overflow-y-auto lg:border-t-0 lg:border-l"
          >
            <DownloadsPanel />
          </aside>
        </div>
      </div>
    </TooltipProvider>
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
