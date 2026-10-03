import { FolderOpen, FolderX, LoaderCircle, RefreshCw } from 'lucide-react'
import { useRef, useState } from 'react'
import { Button } from '@/components/ui/button.tsx'
import { Skeleton } from '@/components/ui/skeleton.tsx'
import { useSettings, useUpdateSettings } from '@/features/settings/use-settings.ts'
import type { ErrorDescription } from '@/lib/error-text.ts'
import { folderChoices, folderProblem } from './folder-choices.ts'
import { FolderMenu } from './folder-menu.tsx'
import { FolderProblem } from './folder-problem.tsx'
import { usePickFolder } from './use-pick-folder.ts'

/** A reason to show; `seq` keys its popover, so each new one opens again. */
type Problem = ErrorDescription & { seq: number }

/**
 * Header control: the target folder (`settings.folder`). Its menu offers the recent folders and
 * "Choose folder…", which has the server open the macOS folder dialog. While the dialog is open a
 * note says so, with Cancel. A choice is saved at once with useUpdateSettings; a refusal shows in a
 * small popover next to the button. Cancel goes away with the dialog, so it hands the focus back to
 * the folder button.
 */
export function FolderPicker() {
  const settings = useSettings()
  const update = useUpdateSettings()
  const picker = usePickFolder()
  const [problem, setProblem] = useState<Problem>()
  const problems = useRef(0)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)

  if (settings.data === undefined) {
    return (
      <FolderUnknown
        failed={settings.isError}
        retrying={settings.isFetching}
        onRetry={() => void settings.refetch()}
      />
    )
  }
  const { folder, recentFolders } = settings.data

  const report = (error: unknown) => {
    const description = folderProblem(error)
    if (description === undefined) return
    problems.current += 1
    setProblem({ ...description, seq: problems.current })
  }
  const choose = (path: string) => {
    // The latest choice wins: an open dialog closes without one.
    picker.cancel()
    setProblem(undefined)
    if (path !== folder) update.mutate({ folder: path }, { onError: report })
  }
  /** Before Cancel unmounts: focus on a removed button would drop to the page's start. */
  const handFocusBack = () => {
    if (document.activeElement === cancelRef.current) triggerRef.current?.focus()
  }
  const pick = () => {
    setProblem(undefined)
    picker.start(folder, {
      onSuccess: (answer) => {
        if ('path' in answer) choose(answer.path)
      },
      onError: report,
      // Runs before the re-render that removes Cancel.
      onSettled: handFocusBack,
    })
  }
  const cancel = () => {
    handFocusBack()
    picker.cancel()
  }

  return (
    <div className="flex min-w-0 items-center gap-1">
      <FolderMenu
        folder={folder}
        choices={folderChoices(folder, recentFolders)}
        picking={picker.pending}
        onChoose={choose}
        onPick={pick}
        triggerRef={triggerRef}
      />
      <p role="status" className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
        {picker.pending && (
          <>
            <LoaderCircle aria-hidden className="size-3.5 shrink-0 motion-safe:animate-spin" />
            <span className="truncate">Choose a folder in the dialog…</span>
          </>
        )}
      </p>
      {picker.pending && (
        <Button ref={cancelRef} variant="ghost" size="xs" onClick={cancel}>
          Cancel
        </Button>
      )}
      {problem !== undefined && (
        <FolderProblem
          key={problem.seq}
          problem={problem}
          onDismiss={() => setProblem((shown) => (shown?.seq === problem.seq ? undefined : shown))}
          returnFocus={triggerRef}
        />
      )}
    </div>
  )
}

type UnknownProps = { failed: boolean; retrying: boolean; onRetry: () => void }

/** Before the settings arrive: a placeholder, or a retry when loading them failed. */
function FolderUnknown({ failed, retrying, onRetry }: UnknownProps) {
  if (!failed) {
    return (
      <span className="flex items-center gap-1.5 px-2.5">
        <FolderOpen aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <Skeleton className="h-3.5 w-24 motion-reduce:animate-none" />
        <span className="sr-only">Loading the download folder…</span>
      </span>
    )
  }
  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={retrying}
      focusableWhenDisabled
      onClick={onRetry}
      className="text-muted-foreground"
    >
      <FolderX aria-hidden />
      Folder unknown
      {retrying ? (
        <LoaderCircle aria-hidden className="motion-safe:animate-spin" />
      ) : (
        <RefreshCw aria-hidden />
      )}
      <span className="sr-only">: load it again</span>
    </Button>
  )
}
