import { describe, expect, it } from 'vitest'
import { allowedByFetchMetadata, type FetchMetadata } from './fetch-metadata.ts'

const navigate = { mode: 'navigate', dest: 'document' } as const

describe('allowedByFetchMetadata', () => {
  it.each<[string, FetchMetadata]>([
    ['no Fetch Metadata (curl, older browsers, insecure origins)', { method: 'POST' }],
    ['same-origin', { method: 'POST', site: 'same-origin', mode: 'cors', dest: 'empty' }],
    ['none (typed URL, bookmark)', { method: 'GET', site: 'none', ...navigate }],
    [
      'a cross-site link (top-level navigation GET)',
      { method: 'GET', site: 'cross-site', ...navigate },
    ],
    [
      'a same-site link (another localhost port)',
      { method: 'GET', site: 'same-site', ...navigate },
    ],
    ['a top-level navigation HEAD', { method: 'HEAD', site: 'cross-site', ...navigate }],
  ])('allows %s', (_label, request) => {
    expect(allowedByFetchMetadata(request)).toBe(true)
  })

  it.each<[string, FetchMetadata]>([
    ['a cross-site <img>', { method: 'GET', site: 'cross-site', mode: 'no-cors', dest: 'image' }],
    ['a same-site fetch', { method: 'GET', site: 'same-site', mode: 'cors', dest: 'empty' }],
    [
      'a cross-site <iframe>',
      { method: 'GET', site: 'cross-site', mode: 'navigate', dest: 'iframe' },
    ],
    ['a cross-site form POST', { method: 'POST', site: 'cross-site', ...navigate }],
    [
      'a cross-site sendBeacon',
      { method: 'POST', site: 'cross-site', mode: 'no-cors', dest: 'empty' },
    ],
    ['a navigation without a dest', { method: 'GET', site: 'cross-site', mode: 'navigate' }],
    [
      'duplicate headers (joined)',
      { method: 'GET', site: 'same-origin, cross-site', mode: 'cors', dest: 'empty' },
    ],
    ['an empty site value', { method: 'POST', site: '' }],
  ])('refuses %s', (_label, request) => {
    expect(allowedByFetchMetadata(request)).toBe(false)
  })
})
