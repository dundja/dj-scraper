export type MessagePart = {
  /** Offset in the message: a stable, unique React key. */
  start: number
  text: string
  code: boolean
}

/**
 * Splits a health message into text and code parts: shell commands come wrapped in backticks.
 * An unpaired backtick stays literal text.
 */
export function splitCode(message: string): MessagePart[] {
  const segments = message.split('`')
  // An even count means the last backtick has no partner: glue that tail back on as text.
  if (segments.length % 2 === 0) {
    const tail = segments.splice(-2, 2).join('`')
    segments.push(tail)
  }
  const parts: MessagePart[] = []
  let start = 0
  segments.forEach((text, index) => {
    if (text !== '') parts.push({ start, text, code: index % 2 === 1 })
    start += text.length + 1
  })
  return parts
}
