import type { Health, HealthProblem } from '@dj-scraper/shared'
import { CircleMinus } from 'lucide-react'
import { type Level, LevelIcon } from './status-icon.tsx'

type ToolRow = {
  key: string
  name: string
  /** Muted text after the name, e.g. "JS runtime". */
  role?: string
  level: Level | 'unused'
  /** The version when found, else what went wrong in two words. */
  value: string
  path?: string
}

const LEVEL_TEXT: Record<ToolRow['level'], string> = {
  ok: 'OK',
  warning: 'warning',
  error: 'problem',
  unused: 'not used',
}

/** The worst problem for a tool decides its row's level. */
function levelOf(problems: HealthProblem[], tool: HealthProblem['tool']): Level {
  const own = problems.filter((problem) => problem.tool === tool)
  if (own.some((problem) => problem.severity === 'error')) return 'error'
  return own.length > 0 ? 'warning' : 'ok'
}

function toolRows(health: Health, problems: HealthProblem[]): ToolRow[] {
  const tools = [
    ['yt-dlp', health.ytdlp],
    ['ffmpeg', health.ffmpeg],
    ['ffprobe', health.ffprobe],
  ] as const
  const rows: ToolRow[] = tools.map(([name, tool]) => {
    const row = { key: name, name, level: levelOf(problems, name) }
    if (tool.status === 'ok') return { ...row, value: tool.version, path: tool.path }
    if (tool.status === 'missing') return { ...row, value: 'Not found' }
    return { ...row, value: 'Not working', path: tool.path }
  })

  if (health.jsRuntimes.length === 0) {
    rows.push({ key: 'js-runtime', name: 'JS runtime', level: 'error', value: 'None found' })
  }
  // yt-dlp skips an unsupported runtime: that's only a problem when no other one is usable.
  const skippedLevel = levelOf(problems, 'js-runtime') === 'ok' ? 'unused' : 'error'
  for (const runtime of health.jsRuntimes) {
    rows.push({
      key: `js-${runtime.name}`,
      name: runtime.name,
      role: 'JS runtime',
      level: runtime.supported ? 'ok' : skippedLevel,
      value: runtime.supported ? runtime.version : `${runtime.version}, too old`,
      path: runtime.path,
    })
  }
  return rows
}

export function ToolList({ health, problems }: { health: Health; problems: HealthProblem[] }) {
  return (
    <ul aria-label="Engine tools" className="flex flex-col gap-2">
      {toolRows(health, problems).map((row) => (
        <li
          key={row.key}
          className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-0.5"
        >
          {row.level === 'unused' ? (
            <CircleMinus aria-hidden className="size-3.5 text-muted-foreground" />
          ) : (
            <LevelIcon level={row.level} />
          )}
          <span className="truncate font-medium">
            {row.name}
            {row.role !== undefined && (
              <>
                {' '}
                <span className="ml-1 text-xs font-normal text-muted-foreground">{row.role}</span>
              </>
            )}
            <span className="sr-only">: {LEVEL_TEXT[row.level]}</span>
          </span>
          <span className="font-mono text-xs tabular-nums">{row.value}</span>
          {row.path !== undefined && (
            <span className="col-span-2 col-start-2 font-mono text-xs break-all text-muted-foreground">
              {row.path}
            </span>
          )}
        </li>
      ))}
    </ul>
  )
}
