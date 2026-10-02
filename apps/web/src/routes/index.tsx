import { createFileRoute } from '@tanstack/react-router'
import { Link2 } from 'lucide-react'

export const Route = createFileRoute('/')({ component: Home })

function Home() {
  return (
    <section
      aria-labelledby="home-title"
      className="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center gap-3 px-6 pb-24 text-center"
    >
      <div className="mb-1 flex size-10 items-center justify-center rounded-lg border bg-card text-muted-foreground">
        <Link2 aria-hidden className="size-5" />
      </div>
      <h1 id="home-title" className="text-base font-medium text-balance">
        Paste a YouTube or SoundCloud link
      </h1>
      <p className="text-sm text-pretty text-muted-foreground">
        A single track downloads right away; for a playlist you pick the tracks first.
      </p>
    </section>
  )
}
