import type { TrackKey } from '@/features/downloads/track-ref.ts'

// The collection table's selection: a set of track keys plus the row a shift-click range starts
// from. Pure, so every rule is tested without rendering 5,000 rows.

/** A table row as the selection sees it. */
export type SelectableRow = {
  /** Its position in the collection (its number minus one), whatever the filter shows. */
  index: number
  /** A playlist can list one video twice: such rows share a key, so they share one state. */
  key: TrackKey
  /** False for unavailable rows (private, deleted, Go+ preview): they can't be selected. */
  selectable: boolean
}

export type SelectionState = {
  selected: ReadonlySet<TrackKey>
  /** The index of the last clicked row, where a shift-click range starts. */
  anchor: number | undefined
}

/**
 * `rows` are the rows the table shows, in its order (the filter applied): ranges and all / none /
 * invert act on those only, and the selection of hidden rows stays as it is.
 */
export type SelectionAction =
  /** A click on the row at `position` of `rows`; with shift, the range from the anchor follows it. */
  | { type: 'click'; rows: readonly SelectableRow[]; position: number; shift: boolean }
  | { type: 'all' | 'none' | 'invert'; rows: readonly SelectableRow[] }
  /** Drops the rows that can't be selected (any more), e.g. once enrichment finds them private. */
  | { type: 'prune'; rows: readonly SelectableRow[] }

/** Every row that can be selected starts selected, the partial and `unknown` ones included. */
export function initialSelection(rows: readonly SelectableRow[]): SelectionState {
  const selected = new Set<TrackKey>()
  for (const row of rows) if (row.selectable) selected.add(row.key)
  return { selected, anchor: undefined }
}

/** Returns the same state when nothing changes, so React skips the render. */
export function selectionReducer(state: SelectionState, action: SelectionAction): SelectionState {
  switch (action.type) {
    case 'click':
      return click(state, action.rows, action.position, action.shift)
    case 'all':
      return withKeys(state, selectableKeys(action.rows), true)
    case 'none':
      return withKeys(state, selectableKeys(action.rows), false)
    case 'invert': {
      const keys = selectableKeys(action.rows)
      if (keys.length === 0) return state
      const selected = new Set(state.selected)
      for (const key of keys) {
        if (!selected.delete(key)) selected.add(key)
      }
      return { ...state, selected }
    }
    case 'prune':
      return withKeys(
        state,
        action.rows.filter((row) => !row.selectable).map((row) => row.key),
        false,
      )
  }
}

/**
 * A plain click toggles the row. A shift-click gives every row from the anchor to the clicked one
 * (in the shown order) the clicked row's new state; without an anchor among the shown rows it is a
 * plain click. Either way the clicked row becomes the anchor. Rows that can't be selected ignore
 * clicks and stay out of ranges.
 */
function click(
  state: SelectionState,
  rows: readonly SelectableRow[],
  position: number,
  shift: boolean,
): SelectionState {
  const clicked = rows[position]
  if (clicked === undefined || !clicked.selectable) return state
  const select = !state.selected.has(clicked.key)
  const from = shift ? rows.findIndex((row) => row.index === state.anchor) : -1
  const range =
    from === -1 ? [clicked] : rows.slice(Math.min(from, position), Math.max(from, position) + 1)
  const next = withKeys(state, selectableKeys(range), select)
  return { selected: next.selected, anchor: clicked.index }
}

/** The distinct keys of the rows that can be selected, in order. */
function selectableKeys(rows: readonly SelectableRow[]): TrackKey[] {
  const keys = new Set<TrackKey>()
  for (const row of rows) if (row.selectable) keys.add(row.key)
  return [...keys]
}

/** `state` with each of `keys` selected (or not), or `state` itself when that changes nothing. */
function withKeys(
  state: SelectionState,
  keys: readonly TrackKey[],
  select: boolean,
): SelectionState {
  if (keys.every((key) => state.selected.has(key) === select)) return state
  const selected = new Set(state.selected)
  for (const key of keys) {
    if (select) selected.add(key)
    else selected.delete(key)
  }
  return { ...state, selected }
}
