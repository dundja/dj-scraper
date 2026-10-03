import { FolderPath } from '@/components/folder-path.tsx'
import { Progress } from '@/components/ui/progress.tsx'
import type { BulkRequest } from './panel-actions.ts'
import { BulkMenu } from './panel-menu.tsx'
import type { BatchGroup } from './panel-rows.ts'
import { batchProgressLabel, batchProgressText, batchTitle, formatName } from './panel-text.ts'
import { percentDone } from './summary.ts'

type Props = {
  group: BatchGroup
  onAction: (request: BulkRequest) => void
  focusAfterClear: (cleared: number) => HTMLElement | null
}

/**
 * A batch's header in the panel list (BATCH_ROW_HEIGHT tall): its name, folder and format, how many
 * of its jobs have finished, and the bulk actions over its jobs. A thin bar shows its progress
 * while it still has work.
 */
export function BatchRow({ group, onAction, focusAfterClear }: Props) {
  const { batch, summary } = group
  const title = batchTitle(group)
  return (
    <div className="relative flex h-full items-center gap-2 border-t bg-muted/40 pr-2 pl-4">
      <div className="min-w-0 flex-1">
        <h3 className="truncate text-sm font-medium" title={title}>
          {title}
        </h3>
        <p className="flex min-w-0 text-xs text-muted-foreground">
          <FolderPath path={batch.folder} />
          <span className="shrink-0 whitespace-pre"> · {formatName(batch.format)}</span>
        </p>
      </div>
      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
        <span aria-hidden>{batchProgressText(summary)}</span>
        <span className="sr-only">{batchProgressLabel(summary)}</span>
      </span>
      <BulkMenu
        label={`Actions for ${title}`}
        target={{ scope: 'batch', batchId: batch.id }}
        summary={summary}
        onAction={onAction}
        focusAfterClear={focusAfterClear}
      />
      {summary.active > 0 && (
        <Progress
          value={percentDone(summary)}
          aria-label={`Progress of ${title}`}
          className="absolute inset-x-0 bottom-0 gap-0 [&_[data-slot=progress-track]]:h-0.5 [&_[data-slot=progress-track]]:rounded-none"
        />
      )}
    </div>
  )
}
