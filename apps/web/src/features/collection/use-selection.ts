import { useReducer, useState } from 'react'
import type { TableRow } from './rows.ts'
import { initialSelection, selectionReducer } from './selection.ts'

/**
 * The table's selection: every row that can be selected starts selected. When enrichment turns a
 * row unavailable (private, a Go+ preview), the row leaves the selection.
 */
export function useSelection(rows: readonly TableRow[]) {
  const [selection, dispatch] = useReducer(selectionReducer, rows, initialSelection)
  // Pruned while rendering, as React suggests for state that follows a prop: no extra commit
  // with the stale selection. The reducer returns the same state when nothing was selected.
  const [prunedRows, setPrunedRows] = useState(rows)
  if (prunedRows !== rows) {
    setPrunedRows(rows)
    dispatch({ type: 'prune', rows })
  }
  return [selection, dispatch] as const
}
