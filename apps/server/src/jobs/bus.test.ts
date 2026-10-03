import type { ServerEvent } from '@dj-scraper/shared'
import { jobsByStatus, testBatch, testUuid } from '@dj-scraper/shared/test-helpers'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as z from 'zod'
import { createBus } from './bus.ts'

const log = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })

const queued = jobsByStatus.queued
const added: ServerEvent = { type: 'jobs.added', batch: testBatch, jobs: [queued] }
const progress: ServerEvent = {
  type: 'job.progress',
  jobId: testUuid(2),
  progress: { percent: 12.5 },
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('createBus', () => {
  it('hands every event to every listener in subscription order, with its JSON', () => {
    const bus = createBus()
    const seen: string[] = []
    bus.subscribe((event, json) => seen.push(`a ${event.type} ${json}`))
    bus.subscribe((event, json) => seen.push(`b ${event.type} ${json}`))
    bus.emit(progress)
    const json = JSON.stringify(progress)
    expect(seen).toEqual([`a job.progress ${json}`, `b job.progress ${json}`])
  })

  it('serializes each event once, however many listeners there are', () => {
    const bus = createBus()
    const jsons: string[] = []
    for (let i = 0; i < 3; i++) bus.subscribe((_event, json) => jsons.push(json))
    const stringify = vi.spyOn(JSON, 'stringify')
    bus.emit(added)
    expect(stringify).toHaveBeenCalledTimes(1)
    expect(new Set(jsons).size).toBe(1)
    expect(JSON.parse(jsons[0] ?? '')).toEqual(added)
  })

  it('emits with no listeners', () => {
    const bus = createBus()
    expect(() => bus.emit({ type: 'heartbeat' })).not.toThrow()
  })

  it('logs a failing listener by its code only, and still calls the others', () => {
    const logger = log()
    const bus = createBus({ log: logger })
    const after = vi.fn()
    bus.subscribe(() => {
      throw Object.assign(new Error('write /Users/dj/Music/secret.mp3 failed'), { code: 'EPIPE' })
    })
    bus.subscribe(() => {
      throw new TypeError('Cannot read "Track title"')
    })
    bus.subscribe(after)
    bus.emit(progress)
    expect(after).toHaveBeenCalledTimes(1)
    expect(logger.error.mock.calls).toEqual([
      ['[bus] A job.progress listener failed: EPIPE'],
      ['[bus] A job.progress listener failed: TypeError'],
    ])
  })

  it('counts its subscribers and unsubscribes each subscription once', () => {
    const bus = createBus()
    const listener = vi.fn()
    const first = bus.subscribe(listener)
    const second = bus.subscribe(listener)
    expect(bus.subscribers).toBe(2)
    first()
    first()
    expect(bus.subscribers).toBe(1)
    bus.emit(progress)
    expect(listener).toHaveBeenCalledTimes(1)
    second()
    expect(bus.subscribers).toBe(0)
  })

  it('lets a listener unsubscribe itself or another while an event is handed out', () => {
    const bus = createBus()
    const seen: string[] = []
    let unsubscribeC = () => {}
    const unsubscribeA = bus.subscribe(() => {
      seen.push('a')
      unsubscribeA()
      unsubscribeC()
    })
    bus.subscribe(() => seen.push('b'))
    unsubscribeC = bus.subscribe(() => seen.push('c'))
    bus.emit(progress)
    bus.emit(progress)
    expect(seen).toEqual(['a', 'b', 'b'])
  })

  it('with assertContract, throws on an event off the contract before any listener sees it', () => {
    const bus = createBus({ assertContract: true })
    const listener = vi.fn()
    bus.subscribe(listener)
    expect(() => bus.emit({ type: 'jobs.updated', jobs: [{ ...queued, id: 'job-1' }] })).toThrow(
      z.ZodError,
    )
    expect(() =>
      bus.emit({ type: 'job.progress', jobId: testUuid(1), progress: { percent: 101 } }),
    ).toThrow(z.ZodError)
    expect(listener).not.toHaveBeenCalled()
    bus.emit(added)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('without assertContract, passes events on unchecked', () => {
    const bus = createBus()
    const listener = vi.fn()
    bus.subscribe(listener)
    bus.emit({ type: 'job.progress', jobId: 'not-a-uuid', progress: {} })
    expect(listener).toHaveBeenCalledTimes(1)
  })
})
