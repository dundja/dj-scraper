// The track table's geometry, shared by its header and rows.

/**
 * Every row is this tall (px), so the virtualizer never measures one: room for the title and, in
 * the narrow layout, the artist under it.
 */
export const ROW_HEIGHT = 44

/**
 * Columns: checkbox, #, artwork, title, [artist], duration, status. The view is a size container:
 * below `@2xl` (42rem) the artist moves under the title and the status column narrows.
 */
export const ROW_GRID =
  'grid items-center gap-x-2 px-3 grid-cols-[1rem_2rem_2rem_minmax(0,1fr)_2.75rem_4.75rem] @2xl:gap-x-3 @2xl:grid-cols-[1rem_2.5rem_2rem_minmax(0,3fr)_minmax(0,2fr)_3.5rem_7.5rem]'
