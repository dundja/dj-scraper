import { describe, expect, it } from 'vitest'
import { type Services, shutDown } from './shutdown.ts'

/** Services that log when each step starts and ends; `hold` keeps a step running until released. */
function services(failing?: keyof Services) {
  const log: string[] = []
  const gates = new Map<string, () => void>()
  const step = (name: string) => async () => {
    log.push(`${name} start`)
    await new Promise<void>((resolve) => gates.set(name, resolve))
    log.push(`${name} end`)
    if (failing !== undefined && name.startsWith(failing)) throw new Error(`${name} failed`)
  }
  const release = (name: string) => gates.get(name)?.()
  const all: Services = {
    queue: { close: step('queue.close') },
    streams: { closeAll: step('streams.closeAll') },
    settings: { flush: step('settings.flush') },
    running: { close: step('running.close') },
    lock: { release: () => log.push('lock.release') },
  }
  return { all, log, release }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('shutDown', () => {
  it('stops the queue and the streams together, then flushes, closes, and releases the lock', async () => {
    const { all, log, release } = services()
    const done = shutDown(all)
    await tick()
    expect(log).toEqual(['queue.close start', 'streams.closeAll start'])
    release('streams.closeAll')
    await tick()
    expect(log).not.toContain('settings.flush start')
    release('queue.close')
    await tick()
    release('settings.flush')
    await tick()
    release('running.close')
    await done
    expect(log).toEqual([
      'queue.close start',
      'streams.closeAll start',
      'streams.closeAll end',
      'queue.close end',
      'settings.flush start',
      'settings.flush end',
      'running.close start',
      'running.close end',
      'lock.release',
    ])
  })

  it('releases the lock even when a step fails', async () => {
    const { all, log, release } = services('running')
    const done = shutDown(all)
    for (const name of ['queue.close', 'streams.closeAll', 'settings.flush', 'running.close']) {
      await tick()
      release(name)
    }
    await expect(done).rejects.toThrow('running.close failed')
    expect(log.at(-1)).toBe('lock.release')
  })
})
