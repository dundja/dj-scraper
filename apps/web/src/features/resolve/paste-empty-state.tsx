import { Link2 } from 'lucide-react'
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty.tsx'
import { Kbd, KbdGroup } from '@/components/ui/kbd.tsx'

/** Under the paste box before anything is loaded: what a paste does, and how to paste. */
export function PasteEmptyState() {
  return (
    <Empty className="px-6 pb-24">
      <EmptyHeader>
        <EmptyMedia variant="icon" className="text-muted-foreground">
          <Link2 aria-hidden />
        </EmptyMedia>
        <EmptyTitle>
          <h2 className="text-base font-semibold tracking-tight">
            Paste a YouTube, SoundCloud or Spotify link
          </h2>
        </EmptyTitle>
        <EmptyDescription className="text-pretty">
          A single track shows its card and remixes, and downloads when you press Download (⌘D); for
          a playlist, set or album you pick the tracks first.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <p className="flex flex-wrap items-center justify-center gap-1.5 text-xs text-muted-foreground">
          <KbdGroup aria-hidden>
            <Kbd>⌘</Kbd>
            <Kbd>V</Kbd>
          </KbdGroup>
          <span className="sr-only">Command V</span>
          <span>anywhere on the page, or drop a link on the window</span>
        </p>
        <p className="text-xs text-pretty text-muted-foreground">
          A Spotify playlist over 100 tracks: in the Spotify desktop app, select every track (⌘A),
          copy (⌘C) and paste here.
        </p>
      </EmptyContent>
    </Empty>
  )
}
