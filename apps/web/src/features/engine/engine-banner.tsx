import { CircleAlert, ServerCrash, ServerOff, TriangleAlert } from 'lucide-react'
import { useState } from 'react'
import { ApiError } from '@/lib/api.ts'
import { describeError } from '@/lib/error-text.ts'
import { BannerFrame, CheckAgain, ProblemList, TryNow } from './engine-banner-parts.tsx'
import { bannerState, readDismissedWarnings, saveDismissedWarnings } from './engine-banner-state.ts'
import type { Recheck } from './engine-details.tsx'
import { engineState } from './engine-state.ts'
import { ProblemText } from './problem-text.tsx'
import { startCommand } from './start-command.ts'
import { useHealth, useRecheckHealth } from './use-health.ts'

/**
 * Below the header, when the server or the engine has a problem: what is wrong and the command that
 * fixes it, with a way to check again. Warnings (downloads still work) can be dismissed for the
 * session. Renders nothing when all is fine, and while the first check runs.
 */
export function EngineBanner() {
  const health = useHealth()
  const recheck = useRecheckHealth()
  const [dismissed, setDismissed] = useState(readDismissedWarnings)
  const banner = bannerState(engineState(health), dismissed)
  const recheckControl: Recheck = {
    run: () => recheck.mutate(),
    pending: recheck.isPending,
    // A failed re-check stops mattering once a newer result arrives (as in the header chip).
    error: recheck.isError && recheck.submittedAt > health.dataUpdatedAt ? recheck.error : null,
  }
  const retry = () => health.refetch()

  switch (banner.kind) {
    case 'none':
      return null
    case 'offline':
      return (
        <BannerFrame tone="danger" icon={ServerOff} title="Server offline">
          <p>
            <ProblemText
              message={`The DJ Scraper server isn't running, so links can't be resolved or downloaded. Start it with \`${startCommand()}\` in the project folder.`}
            />
          </p>
          <TryNow note="This reconnects by itself." onRetry={retry} />
        </BannerFrame>
      )
    case 'unexpected': {
      const refused = banner.error instanceof ApiError && banner.error.kind === 'api'
      const words = describeError(banner.error)
      return (
        <BannerFrame
          tone="danger"
          icon={ServerCrash}
          title={
            refused ? 'The server refused the engine check' : 'Unexpected answer from the server'
          }
        >
          {(refused || words?.hint !== undefined) && (
            <p>
              {refused && `${banner.error.message} `}
              {words?.hint !== undefined && <ProblemText message={words.hint} />}
            </p>
          )}
          <TryNow note="This checks again by itself." onRetry={retry} />
        </BannerFrame>
      )
    }
    case 'problems':
      return (
        <BannerFrame
          tone="danger"
          icon={CircleAlert}
          title="Downloads won't work until the engine is fixed"
        >
          <ProblemList problems={banner.problems} />
          {banner.installAll !== undefined && (
            <p>
              <ProblemText message={`Install them all at once: \`${banner.installAll}\`.`} />
            </p>
          )}
          <CheckAgain recheck={recheckControl} checkedAt={banner.health.checkedAt} />
        </BannerFrame>
      )
    case 'warnings': {
      const { keys } = banner
      return (
        <BannerFrame
          tone="warning"
          icon={TriangleAlert}
          title={banner.problems.length === 1 ? 'Engine warning' : 'Engine warnings'}
          onDismiss={() => {
            // Added to the earlier ones, which stay dismissed.
            const next = new Set([...dismissed, ...keys])
            saveDismissedWarnings(next)
            setDismissed(next)
          }}
        >
          <ProblemList problems={banner.problems} />
          <CheckAgain recheck={recheckControl} checkedAt={banner.health.checkedAt} />
        </BannerFrame>
      )
    }
  }
}
