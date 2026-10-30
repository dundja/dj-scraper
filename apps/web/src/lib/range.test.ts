import { describe, expect, it } from 'vitest'
import { rangeFill } from './range.ts'

describe('rangeFill', () => {
  it('is the filled share of the track, clamped', () => {
    expect(rangeFill(30, 0, 120)).toEqual({ '--value': '25%' })
    expect(rangeFill(1.1, 0.5, 1.5)).toEqual({ '--value': '60%' })
    expect(rangeFill(-1, 0, 10)).toEqual({ '--value': '0%' })
    expect(rangeFill(99, 0, 10)).toEqual({ '--value': '100%' })
  })

  it('is empty for a track without length', () => {
    expect(rangeFill(0, 0, 0)).toEqual({ '--value': '0%' })
  })
})
