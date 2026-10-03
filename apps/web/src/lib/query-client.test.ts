import { MutationObserver, onlineManager } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueryClient } from './query-client.ts'

describe('createQueryClient', () => {
  beforeEach(() => onlineManager.setOnline(false))
  afterEach(() => onlineManager.setOnline(true))

  // The API is on 127.0.0.1: Wi-Fi off says nothing about reaching it.
  it('sends mutations while the browser says it is offline', async () => {
    const client = createQueryClient()
    const mutationFn = vi.fn(() => Promise.resolve('saved'))
    const observer = new MutationObserver(client, { mutationFn })

    await expect(observer.mutate()).resolves.toBe('saved')
    expect(mutationFn).toHaveBeenCalledTimes(1)
    expect(observer.getCurrentResult().isPaused).toBe(false)
  })

  it('fetches queries while the browser says it is offline', async () => {
    const client = createQueryClient()
    const queryFn = vi.fn(() => Promise.resolve('fresh'))

    await expect(client.fetchQuery({ queryKey: ['offline'], queryFn })).resolves.toBe('fresh')
    expect(queryFn).toHaveBeenCalledTimes(1)
    client.clear()
  })
})
