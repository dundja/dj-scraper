import { ChevronDown, FolderOpen, FolderSearch } from 'lucide-react'
import type { RefObject } from 'react'
import { FolderPath } from '@/components/folder-path.tsx'
import { Button } from '@/components/ui/button.tsx'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.tsx'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx'
import { folderName, shortenPath } from '@/lib/format.ts'

type Props = {
  folder: string
  /** The folders to offer, current one included (folderChoices). */
  choices: readonly string[]
  /** The folder dialog is open: "Choose folder…" waits for it. */
  picking: boolean
  onChoose: (folder: string) => void
  onPick: () => void
  /** The trigger button, for returning focus to it. */
  triggerRef: RefObject<HTMLButtonElement | null>
}

/**
 * The header's folder button (its name; the full path in a tooltip and in its accessible name),
 * opening a menu of recent folders with the current one checked, and "Choose folder…".
 */
export function FolderMenu({ folder, choices, picking, onChoose, onPick, triggerRef }: Props) {
  const path = shortenPath(folder)
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger
          render={
            <DropdownMenuTrigger
              render={
                <Button
                  ref={triggerRef}
                  variant="ghost"
                  size="sm"
                  aria-label={`Download folder: ${path}`}
                  className="max-w-64 min-w-0 shrink"
                />
              }
            />
          }
        >
          <FolderOpen aria-hidden className="text-muted-foreground" />
          <span className="truncate">{folderName(folder)}</span>
          <ChevronDown aria-hidden className="text-muted-foreground" />
        </TooltipTrigger>
        <TooltipContent side="bottom">{path}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="start" className="w-72 max-w-(--available-width)">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Recent folders</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={folder}
            onValueChange={(value: unknown) => {
              if (typeof value === 'string' && value !== folder) onChoose(value)
            }}
          >
            {choices.map((choice) => (
              <DropdownMenuRadioItem
                key={choice}
                value={choice}
                closeOnClick
                // The name and its path are two lines; the path alone says both.
                aria-label={shortenPath(choice)}
              >
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">{folderName(choice)}</span>
                  <FolderPath path={choice} className="text-xs text-muted-foreground" />
                </span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={picking} onClick={onPick}>
          <FolderSearch aria-hidden />
          Choose folder…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
