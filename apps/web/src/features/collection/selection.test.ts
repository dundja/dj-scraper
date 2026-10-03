import { describe, expect, it } from 'vitest'
import type { TrackKey } from '@/features/downloads/track-ref.ts'
import {
  initialSelection,
  type SelectableRow,
  type SelectionAction,
  type SelectionState,
  selectionReducer,
} from './selection.ts'

/**
 * Rows from a compact spec, one word per row in collection order: the word is the track's id, and
 * a trailing `!` makes the row unavailable. `'a b! c a'` is four rows, the last repeating the first.
 */
function rowsOf(spec: string): SelectableRow[] {
  return spec.split(' ').map((word, index) => ({
    index,
    key: `youtube:${word.replace('!', '')}`,
    selectable: !word.endsWith('!'),
  }))
}

/** The selected ids, sorted, e.g. ['a', 'c']. */
function ids(state: SelectionState): string[] {
  return [...state.selected].map((key) => key.replace('youtube:', '')).sort()
}

function stateWith(selected: string[], anchor?: number): SelectionState {
  return { selected: new Set(selected.map((id): TrackKey => `youtube:${id}`)), anchor }
}

function run(state: SelectionState, ...actions: SelectionAction[]): SelectionState {
  return actions.reduce(selectionReducer, state)
}

const click = (rows: SelectableRow[], position: number, shift = false): SelectionAction => ({
  type: 'click',
  rows,
  position,
  shift,
})

describe('initialSelection', () => {
  it('selects every row that can be selected, with no anchor yet', () => {
    const state = initialSelection(rowsOf('a b! c d'))
    expect(ids(state)).toEqual(['a', 'c', 'd'])
    expect(state.anchor).toBeUndefined()
  })

  it('counts a track listed twice once', () => {
    expect(initialSelection(rowsOf('a b a')).selected.size).toBe(2)
  })

  it('selects nothing in a list without selectable rows', () => {
    expect(ids(initialSelection(rowsOf('a! b!')))).toEqual([])
    expect(ids(initialSelection([]))).toEqual([])
  })
})

describe('click', () => {
  const rows = rowsOf('a b c d e')

  it('toggles the clicked row and makes it the anchor', () => {
    const off = run(stateWith(['a', 'b', 'c']), click(rows, 1))
    expect(ids(off)).toEqual(['a', 'c'])
    expect(off.anchor).toBe(1)

    const on = run(off, click(rows, 1))
    expect(ids(on)).toEqual(['a', 'b', 'c'])
  })

  it('ignores a row that cant be selected, and keeps the anchor', () => {
    const withUnavailable = rowsOf('a b! c')
    const state = stateWith(['a', 'c'], 0)
    expect(run(state, click(withUnavailable, 1))).toBe(state)
    expect(run(state, click(withUnavailable, 1, true))).toBe(state)
  })

  it('ignores a position past the rows', () => {
    const state = stateWith(['a'])
    expect(run(state, click(rows, 9))).toBe(state)
  })

  it('toggles every row of a track listed twice together', () => {
    const twice = rowsOf('a b a')
    const state = run(initialSelection(twice), click(twice, 2))
    expect(ids(state)).toEqual(['b'])
    expect(state.anchor).toBe(2)
  })
})

describe('shift-click', () => {
  const rows = rowsOf('a b c d e f')

  it('gives the range from the anchor the clicked row new state: deselecting', () => {
    const all = initialSelection(rows)
    const state = run(all, click(rows, 1), click(rows, 4, true))
    expect(ids(state)).toEqual(['a', 'f'])
    expect(state.anchor).toBe(4)
  })

  it('selects a range when the clicked row was unselected, whatever the rows between were', () => {
    const state = run(stateWith(['c'], 1), click(rows, 4, true))
    expect(ids(state)).toEqual(['b', 'c', 'd', 'e'])
  })

  it('works upwards too', () => {
    const state = run(stateWith([], 4), click(rows, 2, true))
    expect(ids(state)).toEqual(['c', 'd', 'e'])
  })

  it('extends from the last clicked row, also after a shift-click', () => {
    const state = run(stateWith([]), click(rows, 0), click(rows, 2, true), click(rows, 5, true))
    expect(ids(state)).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
    expect(state.anchor).toBe(5)
  })

  it('is a plain click without an anchor', () => {
    const state = run(stateWith([]), click(rows, 3, true))
    expect(ids(state)).toEqual(['d'])
    expect(state.anchor).toBe(3)
  })

  it('leaves rows that cant be selected out of the range', () => {
    const withUnavailable = rowsOf('a b! c! d')
    const state = run(stateWith([], 0), click(withUnavailable, 3, true))
    expect(ids(state)).toEqual(['a', 'd'])
  })

  it('spans the shown rows only: rows the filter hides keep their state', () => {
    // The filter shows a, c and e (collection indexes 0, 2, 4); b and d are hidden.
    const shown = [rows[0], rows[2], rows[4]].filter((row) => row !== undefined)
    const start = stateWith(['b'], 0)
    const state = run(start, click(shown, 2, true))
    expect(ids(state)).toEqual(['a', 'b', 'c', 'e'])
  })

  it('is a plain click when the anchor row is hidden by the filter', () => {
    const shown = [rows[3], rows[4]].filter((row) => row !== undefined)
    const state = run(stateWith([], 0), click(shown, 1, true))
    expect(ids(state)).toEqual(['e'])
    expect(state.anchor).toBe(4)
  })

  it('treats a track listed twice as one in a range', () => {
    const twice = rowsOf('a b a c')
    const state = run(stateWith(['a', 'b', 'c'], 0), click(twice, 2, true))
    // The anchor row and the clicked row are the same track: deselecting it covers rows 0–2.
    expect(ids(state)).toEqual(['c'])
  })
})

describe('all, none and invert', () => {
  const rows = rowsOf('a b! c d')

  it('all selects every selectable row shown', () => {
    expect(ids(run(stateWith([]), { type: 'all', rows }))).toEqual(['a', 'c', 'd'])
  })

  it('none deselects every row shown', () => {
    expect(ids(run(stateWith(['a', 'c']), { type: 'none', rows }))).toEqual([])
  })

  it('invert flips every selectable row shown', () => {
    expect(ids(run(stateWith(['a']), { type: 'invert', rows }))).toEqual(['c', 'd'])
  })

  it('act on the shown rows only, keeping the selection of hidden rows', () => {
    const shown = rows.slice(2)
    expect(ids(run(stateWith(['a']), { type: 'all', rows: shown }))).toEqual(['a', 'c', 'd'])
    expect(ids(run(stateWith(['a', 'c']), { type: 'none', rows: shown }))).toEqual(['a'])
    expect(ids(run(stateWith(['a', 'c']), { type: 'invert', rows: shown }))).toEqual(['a', 'd'])
  })

  it('invert flips a track listed twice once', () => {
    const twice = rowsOf('a b a')
    expect(ids(run(stateWith(['a']), { type: 'invert', rows: twice }))).toEqual(['b'])
  })

  it('keep the anchor', () => {
    expect(run(stateWith(['a'], 3), { type: 'invert', rows }).anchor).toBe(3)
  })

  it('return the same state when nothing changes', () => {
    const all = stateWith(['a', 'c', 'd'])
    expect(run(all, { type: 'all', rows })).toBe(all)
    const none = stateWith([])
    expect(run(none, { type: 'none', rows })).toBe(none)
    expect(run(none, { type: 'invert', rows: rowsOf('x!') })).toBe(none)
    expect(run(none, { type: 'invert', rows: [] })).toBe(none)
  })
})

describe('prune', () => {
  it('drops the rows that turned unavailable', () => {
    const state = stateWith(['a', 'b', 'c'], 1)
    const pruned = run(state, { type: 'prune', rows: rowsOf('a b! c!') })
    expect(ids(pruned)).toEqual(['a'])
    expect(pruned.anchor).toBe(1)
  })

  it('returns the same state when no selected row is unavailable', () => {
    const state = stateWith(['a'])
    expect(run(state, { type: 'prune', rows: rowsOf('a b! c') })).toBe(state)
  })
})
