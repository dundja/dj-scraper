const keys = new WeakMap<object, number>()
let lastKey = 0

/**
 * A number for `value`'s identity, for a `key` that resets a component's state whenever it is
 * handed another object, e.g. a newly resolved collection, even one from the same URL.
 */
export function instanceKey(value: object): number {
  let key = keys.get(value)
  if (key === undefined) {
    key = ++lastKey
    keys.set(value, key)
  }
  return key
}
