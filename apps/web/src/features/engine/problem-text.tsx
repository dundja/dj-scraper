import { splitCode } from './split-code.ts'

/** A health problem message with its `commands` rendered as <code>. */
export function ProblemText({ message }: { message: string }) {
  return splitCode(message).map((part) =>
    part.code ? (
      <code
        key={part.start}
        className="rounded bg-muted px-1 py-px font-mono text-[0.85em] text-foreground"
      >
        {part.text}
      </code>
    ) : (
      <span key={part.start}>{part.text}</span>
    ),
  )
}
