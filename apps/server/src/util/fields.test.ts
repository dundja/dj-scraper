import { describe, expect, expectTypeOf, it } from 'vitest'
import * as z from 'zod'
import { lenient, omitUndefined } from './fields.ts'

describe('omitUndefined', () => {
  it('leaves out undefined fields and keeps every other value', () => {
    const value = omitUndefined({ a: 1, b: undefined, c: null, d: 0, e: '', f: false })
    expect(value).toStrictEqual({ a: 1, c: null, d: 0, e: '', f: false })
    expect(Object.keys(value)).toEqual(['a', 'c', 'd', 'e', 'f'])
  })

  it('types every field as optional: it never claims a field it left out', () => {
    const fields = (title?: string) => omitUndefined({ id: 'a', title })
    expectTypeOf(fields).returns.toEqualTypeOf<{ id?: string; title?: string | undefined }>()
  })

  it('copies only own fields, and never changes its input', () => {
    const input = Object.assign(Object.create({ inherited: 1 }), { own: 2, gone: undefined })
    expect(omitUndefined(input)).toStrictEqual({ own: 2 })
    expect(input).toHaveProperty('gone')
  })
})

describe('lenient', () => {
  const Count = lenient(z.number().int())

  it('reads a value the schema accepts', () => {
    expect(Count.parse(3)).toBe(3)
  })

  it.each([
    ['missing', undefined],
    ['null', null],
    ['of another type', '3'],
    ['out of the schema', 1.5],
  ])('turns a value that is %s into undefined', (_name, value) => {
    expect(Count.parse(value)).toBeUndefined()
  })

  it('drops one bad field instead of failing the document', () => {
    const Doc = z.object({ id: z.string(), count: Count })
    expect(Doc.parse({ id: 'a', count: 'many' })).toStrictEqual({ id: 'a', count: undefined })
  })
})
