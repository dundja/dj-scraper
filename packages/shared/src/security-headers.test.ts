import { describe, expect, it } from 'vitest'
import { SECURITY_HEADERS } from './security-headers.ts'

describe('SECURITY_HEADERS', () => {
  it('refuses framing, sniffing and Referers, and allows no cross-origin access', () => {
    expect(SECURITY_HEADERS).toStrictEqual({
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    })
    for (const name of Object.keys(SECURITY_HEADERS)) {
      expect(name.toLowerCase()).not.toMatch(/^access-control-/)
    }
  })
})
