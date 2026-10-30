/**
 * The remix list's columns, by the width of its section (a container query, so the downloads rail
 * beside it counts): the list's wrapper is the grid, and the column header and every row are its
 * subgrids, so a column lines up down the list whatever its rows hold. Each part of a row is in
 * the DOM once; from `@4xl` the line under the title (`display: contents`) hands its genre,
 * platforms and length to their columns.
 * - Narrow: cover | title, with kind, genre, platforms and length under it | Play | Download
 * - `@4xl`: cover | title, with kind | genre | platform · plays | length | Play | Download
 */
export const REMIX_GRID =
  'grid grid-cols-[2.5rem_minmax(0,1fr)_auto_auto] gap-x-2 @md:gap-x-3 @4xl:grid-cols-[3rem_minmax(0,1fr)_auto_auto_auto_auto_auto] @4xl:gap-x-4'

/** A row, or the column header, on the list's columns; the side padding is every row's. */
export const REMIX_ROW = 'col-span-full grid grid-cols-subgrid items-center px-2'

/** Where each part of a row sits (both of a row's lines, from `@4xl` in its own column). */
export const REMIX_CELL = {
  cover: 'col-start-1 row-span-2 row-start-1',
  title: 'col-start-2 row-start-1 self-end',
  /** Kind, genre, platforms and length under the title; from `@4xl` only the kind stays. */
  line: 'col-start-2 row-start-2 self-start @4xl:contents',
  /** The kind, and the row's download status once it has a job. */
  kind: 'flex min-w-0 items-center gap-x-2 @4xl:col-start-2 @4xl:row-start-2 @4xl:self-start',
  genre: 'contents @4xl:col-start-3 @4xl:row-span-2 @4xl:row-start-1 @4xl:flex @4xl:min-w-0',
  platforms:
    'contents @4xl:col-start-4 @4xl:row-span-2 @4xl:row-start-1 @4xl:flex @4xl:flex-col @4xl:items-start @4xl:gap-0.5',
  length:
    '@4xl:col-start-5 @4xl:row-span-2 @4xl:row-start-1 @4xl:justify-self-end @4xl:text-muted-foreground',
  play: 'col-start-3 row-span-2 row-start-1 @4xl:col-start-6',
  download: 'col-start-4 row-span-2 row-start-1 @4xl:col-start-7',
} as const

/** A column header's cell that exists only from `@4xl`. */
export const WIDE_ONLY = 'hidden @4xl:block'
