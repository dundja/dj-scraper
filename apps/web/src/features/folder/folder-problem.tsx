import { Popover as PopoverPrimitive } from '@base-ui/react/popover'
import { CircleAlert } from 'lucide-react'
import { type RefObject, useId } from 'react'
import { Button } from '@/components/ui/button.tsx'
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from '@/components/ui/popover.tsx'
import { ProblemText } from '@/features/engine/problem-text.tsx'
import type { ErrorDescription } from '@/lib/error-text.ts'

type Props = {
  problem: ErrorDescription
  /** Called once the popover has closed, however it was closed. */
  onDismiss: () => void
  /** Where focus goes on close: this popover's own trigger goes away with it. */
  returnFocus: RefObject<HTMLElement | null>
}

/**
 * Why the folder didn't change, in a small popover next to the folder button: it opens by itself
 * (key it per problem), takes focus so the reason is read out, and closing it dismisses it.
 */
export function FolderProblem({ problem, onDismiss, returnFocus }: Props) {
  const triggerId = useId()
  return (
    <Popover
      defaultOpen
      defaultTriggerId={triggerId}
      onOpenChangeComplete={(open) => {
        if (!open) onDismiss()
      }}
    >
      <PopoverTrigger
        id={triggerId}
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Folder not changed"
            className="text-destructive hover:text-destructive"
          />
        }
      >
        <CircleAlert aria-hidden />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        finalFocus={returnFocus}
        className="w-80 max-w-(--available-width)"
      >
        <PopoverHeader>
          <PopoverTitle>Folder not changed</PopoverTitle>
          <PopoverDescription>{problem.message}</PopoverDescription>
        </PopoverHeader>
        {problem.hint !== undefined && (
          <p className="text-xs text-muted-foreground">
            <ProblemText message={problem.hint} />
          </p>
        )}
        <PopoverPrimitive.Close
          render={<Button variant="outline" size="sm" className="self-end" />}
        >
          OK
        </PopoverPrimitive.Close>
      </PopoverContent>
    </Popover>
  )
}
