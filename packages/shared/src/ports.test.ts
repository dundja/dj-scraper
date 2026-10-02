import { describe, expect, it } from 'vitest'
import { loopbackHosts, PortSchema, SERVER_PORT, WEB_DEV_PORT } from './ports.ts'

describe('ports', () => {
  it('are the server default and the Vite dev server', () => {
    expect([SERVER_PORT, WEB_DEV_PORT]).toEqual([4747, 5173])
  })
})

describe('PortSchema', () => {
  it.each([
    ['1024', 1024],
    ['4747', 4747],
    ['65535', 65535],
  ])('accepts %s', (value, port) => {
    expect(PortSchema.parse(value)).toBe(port)
  })

  it.each(['80', '1023', '65536', '99999', '123456', 'abc', '47 47', '-4747', '4747.0', ''])(
    'refuses %j',
    (value) => {
      expect(PortSchema.safeParse(value).success).toBe(false)
    },
  )
})

describe('loopbackHosts', () => {
  it('names the port under both loopback names, lowercase and without [::1]', () => {
    expect(loopbackHosts(5173)).toEqual(['localhost:5173', '127.0.0.1:5173'])
  })
})
