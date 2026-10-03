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
import { useSettings } from '@/features/settings/use-settings.ts'

/** Under the paste box before anything is loaded: what a paste does, and how to paste. */
export function PasteEmptyState() {
  const settings = useSettings()
  const single =
    settings.data?.autoDownloadSingles === false
      ? 'A single track shows a Download button'
      : 'A single track downloads right away'

  return (
    <Empty className="px-6 pb-24">
      <EmptyHeader>
        <EmptyMedia variant="icon" className="text-muted-foreground">
          <Link2 aria-hidden />
        </EmptyMedia>
        <EmptyTitle>
          <h2 className="text-base font-medium">Paste a YouTube or SoundCloud link</h2>
        </EmptyTitle>
        <EmptyDescription className="text-pretty">
          {single}; for a playlist, set or album you pick the tracks first.
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
      </EmptyContent>
    </Empty>
  )
}
