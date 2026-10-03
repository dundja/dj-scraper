import { useId } from 'react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select.tsx'
import { describeError } from '@/lib/error-text.ts'
import { FORMAT_OPTIONS } from './format-options.ts'
import { useSettings, useUpdateSettings } from './use-settings.ts'

/** What the trigger shows for each value. */
const ITEMS = FORMAT_OPTIONS.map(({ value, label }) => ({ value, label }))

type Props = {
  /** Goes to the trigger, so a `<label htmlFor>` can name it. */
  id?: string
  /** Classes for the trigger, e.g. a width. */
  className?: string
  disabled?: boolean
}

/**
 * The download format (`settings.format`), saved with useUpdateSettings: the pick shows at once
 * and goes back if the server refuses it, with a short note why. Each option says what the file
 * will be. Disabled until the settings have loaded.
 */
export function FormatSelect({ id, className, disabled = false }: Props) {
  const settings = useSettings()
  const update = useUpdateSettings()
  const descriptionId = useId()
  const format = settings.data?.format ?? null
  const failure = update.isError ? describeError(update.error) : undefined

  return (
    <>
      <Select
        id={id}
        items={ITEMS}
        value={format}
        onValueChange={(next) => {
          if (next !== null && next !== format) update.mutate({ format: next })
        }}
        disabled={disabled || format === null}
      >
        <SelectTrigger size="sm" aria-label="Format" className={className}>
          <SelectValue placeholder="Format" />
        </SelectTrigger>
        <SelectContent
          align="start"
          alignItemWithTrigger={false}
          className="w-80 max-w-(--available-width)"
        >
          {FORMAT_OPTIONS.map((option) => (
            <SelectItem
              key={option.value}
              value={option.value}
              label={option.label}
              aria-label={option.label}
              aria-describedby={`${descriptionId}-${option.value}`}
            >
              <span className="flex min-w-0 flex-col gap-0.5 py-0.5 whitespace-normal">
                <span>{option.label}</span>
                <span
                  id={`${descriptionId}-${option.value}`}
                  className="text-xs text-muted-foreground"
                >
                  {option.description}
                </span>
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {failure !== undefined && (
        <p role="alert" className="text-xs text-destructive">
          Format not saved: {failure.message}
        </p>
      )}
    </>
  )
}
