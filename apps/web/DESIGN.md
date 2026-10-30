---
name: DJ Scraper
description: A local dark music-app workbench for pulling DJ-ready audio from YouTube, SoundCloud and Spotify track lists.
colors:
  violet-accent: "oklch(0.7 0.155 285)"
  violet-ink: "oklch(0.19 0.04 285)"
  violet-ring: "oklch(0.66 0.15 285)"
  charcoal-ground: "oklch(0.19 0.006 285)"
  charcoal-surface: "oklch(0.218 0.007 285)"
  charcoal-popover: "oklch(0.24 0.008 285)"
  charcoal-muted: "oklch(0.27 0.009 285)"
  charcoal-hover: "oklch(0.295 0.01 285)"
  near-white: "oklch(0.95 0.004 285)"
  ash-grey: "oklch(0.715 0.012 285)"
  hairline: "oklch(1 0 0 / 9%)"
  input-stroke: "oklch(1 0 0 / 13%)"
  status-done: "oklch(0.76 0.15 160)"
  status-waiting: "oklch(0.81 0.145 78)"
  status-failed: "oklch(0.69 0.18 22)"
  platform-youtube: "oklch(0.6 0.24 25)"
  platform-soundcloud: "oklch(0.76 0.17 58)"
  platform-spotify: "oklch(0.76 0.19 149)"
typography:
  headline:
    fontFamily: "Geist Variable, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 600
    lineHeight: 1.375
    letterSpacing: "-0.025em"
  title:
    fontFamily: "Geist Variable, sans-serif"
    fontSize: "1rem"
    fontWeight: 600
    lineHeight: 1.5
    letterSpacing: "-0.025em"
  body:
    fontFamily: "Geist Variable, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.4286
  label:
    fontFamily: "Geist Variable, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1.3333
  measure:
    fontFamily: "Geist Mono Variable, ui-monospace, monospace"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1.3333
    fontFeature: "tnum"
rounded:
  sm: "0.3rem"
  md: "0.4rem"
  lg: "0.5rem"
  pill: "9999px"
spacing:
  hair: "4px"
  tight: "6px"
  sm: "8px"
  row: "10px"
  md: "12px"
  lg: "16px"
components:
  button-primary:
    backgroundColor: "{colors.violet-accent}"
    textColor: "{colors.violet-ink}"
    typography: "{typography.body}"
    rounded: "{rounded.lg}"
    padding: "0 10px"
    height: "32px"
  button-outline:
    backgroundColor: "{colors.charcoal-ground}"
    textColor: "{colors.near-white}"
    rounded: "{rounded.lg}"
    padding: "0 10px"
    height: "32px"
  button-outline-hover:
    backgroundColor: "{colors.charcoal-muted}"
  button-ghost-hover:
    backgroundColor: "{colors.charcoal-muted}"
    textColor: "{colors.near-white}"
  button-play-round:
    backgroundColor: "{colors.violet-accent}"
    textColor: "{colors.violet-ink}"
    rounded: "{rounded.pill}"
    size: "40px"
  button-preset-active:
    backgroundColor: "{colors.violet-accent}"
    textColor: "{colors.violet-ink}"
    typography: "{typography.measure}"
    rounded: "{rounded.md}"
    padding: "0 8px"
    height: "24px"
  chip-filter:
    backgroundColor: "{colors.charcoal-ground}"
    textColor: "{colors.near-white}"
    rounded: "{rounded.pill}"
    padding: "0 8px"
    height: "24px"
  chip-filter-active:
    backgroundColor: "{colors.violet-accent}"
    textColor: "{colors.violet-ink}"
    rounded: "{rounded.pill}"
  platform-badge:
    textColor: "{colors.ash-grey}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "2px 8px"
    height: "20px"
  platform-badge-plain:
    textColor: "{colors.ash-grey}"
    typography: "{typography.label}"
    padding: "0"
  track-header:
    backgroundColor: "{colors.charcoal-surface}"
    textColor: "{colors.near-white}"
    rounded: "{rounded.lg}"
    padding: "16px"
  remix-column-header:
    textColor: "{colors.ash-grey}"
    typography: "{typography.label}"
    padding: "0 8px"
    height: "28px"
  remix-row:
    textColor: "{colors.near-white}"
    typography: "{typography.body}"
    padding: "4px 8px"
    height: "56px"
  remix-row-playing:
    backgroundColor: "{colors.charcoal-surface}"
    rounded: "{rounded.lg}"
    padding: "4px 8px"
    height: "56px"
  now-playing-bar:
    backgroundColor: "{colors.charcoal-surface}"
    textColor: "{colors.near-white}"
    padding: "0 16px"
    height: "72px"
  range-track:
    backgroundColor: "{colors.charcoal-muted}"
    rounded: "{rounded.pill}"
    height: "4px"
  progress-bar:
    backgroundColor: "{colors.violet-accent}"
    rounded: "{rounded.pill}"
    height: "4px"
---

# Design System: DJ Scraper

<!-- Recorded from the shipped theme (ADR-030, on the shadcn/Base UI Nova setup of ADR-010) and updated from the shipped layout and UX pass (ADR-031): the track header, the remix columns and the now-playing bar. -->

## Overview

**Creative North Star: "The Evening Desk"**

A dark music app played straight, at the craft of Spotify's desktop app and Rekordbox. The artwork carries the colour; the chrome carries only state. Everything sits on a charcoal ground with a barely cool cast, one lighter surface step and hairline borders, so a DJ can work through a long evening of pasting links, auditioning remixes and watching downloads without glare.

Colour is rationed by meaning. One violet accent marks what is primary, in progress, active or focused. Three status hues say done, waiting and failed, and always come with an icon and a word. Three platform hues appear only as small brand dots beside a platform's name. Nothing else is coloured. The density is a working tool's: 14 px body, 12 px metadata, one heading step, and measurements set in Geist Mono with tabular figures so they line up and hold still while they change.

The system is tokens only. The generated shadcn components are never hand-patched; they take the world through `src/styles.css`, so a component added later from the CLI arrives already themed. Confirmed rejections (ADR-030): the anonymous neutral-grey shadcn default, any DJ or club costume (neon), a blue-primary dashboard, and too much colour.

**Key Characteristics:**
- Dark only (`color-scheme: dark`); no light tokens.
- Charcoal ground, one surface step, white hairlines at 9 %.
- One violet accent; status and platform hues carry meaning only.
- Geist for the UI, Geist Mono for standalone measurements.
- Flat surfaces; depth by tonal step, shadow only on floating popovers.
- Browser chrome (range inputs, caret, selection, scrollbars) wears the theme.

## Colors

A near-neutral charcoal family tinted at hue 285, one violet voice, and a small set of meaning-only hues.

### Primary
- **Evening Violet** (`violet-accent`): primary buttons (Go, the track's Download), progress bars, the filled share of a range input (seek bar, speed slider), the active speed preset, the active genre filter, a playing remix row's Pause, the now-playing bar's round play/pause, checkboxes, switches, the caret, and text selection at 35 %. Pressed toggles such as "Hide downloaded" take a violet tint (15–20 %) with a 60 % violet border instead of the solid fill.
- **Violet Ink** (`violet-ink`): text and icons sitting on Evening Violet; dark, not white (6.7:1). The ⌘D key hint inside the primary Download is a 15 % Violet Ink tint with Violet Ink text.
- **Focus Violet** (`violet-ring`): the focus ring, usually at 50 % as a 3 px ring; on a range thumb at 60 %.

### Secondary
- **Done Green** (`status-done`): a finished job's icon and its status word.
- **Waiting Amber** (`status-waiting`): waiting, requeued and paused jobs ("not running yet, and why"), a paused queue note, and the warning engine banner's tint (10 %).
- **Failed Red** (`status-failed`): failed jobs and failure lines (always with their alert icon), the destructive button (as a 10–20 % tint with red text), the danger engine banner's tint (10 %).

### Tertiary
- **YouTube Red** (`platform-youtube`), **SoundCloud Orange** (`platform-soundcloud`), **Spotify Green** (`platform-spotify`): a 6 px dot beside the platform's name, and nowhere else.

### Neutral
- **Charcoal Ground** (`charcoal-ground`): the page, the header, the downloads rail and the idle remix rows. Not black.
- **Charcoal Surface** (`charcoal-surface`): the one raised step: the track header, the remix row whose audio is on, and the now-playing bar. At 40 % it is the quieter well under the paste box, the result skeletons and the ambiguous-link prompt.
- **Charcoal Popover** (`charcoal-popover`): menus, popovers (the speed popover) and selects.
- **Charcoal Muted** (`charcoal-muted`): hover fills, the progress and range tracks, secondary buttons (a paused or preparing row's play button).
- **Charcoal Hover** (`charcoal-hover`): shadcn's `accent`, a hover surface only, never a brand colour.
- **Near-White** (`near-white`): primary text (about 16:1 on the ground) and the range thumb. Not pure white.
- **Ash Grey** (`ash-grey`): secondary text, metadata lines, the remix column header, idle status icons, the platform name (6–7:1).
- **Hairline** (`hairline`) and **Input Stroke** (`input-stroke`): every border and divider; inputs and outline buttons use the slightly stronger stroke.

### Named Rules
**The One Voice Rule.** Violet means primary, in progress, active or focused. If an element is none of those, it is not violet.

**The Icon-And-Word Rule.** A status hue never travels alone: every green, amber or red status carries its icon and its word. Colour only speeds up scanning.

**The Dot Not Field Rule.** A platform's brand colour is a 6 px dot beside its name, never a fill, border or text colour, so it can never be mistaken for a status.

## Typography

**Display Font:** none; the app has no display tier.
**Body Font:** Geist Variable (with sans-serif), bundled through Fontsource for offline use.
**Label/Mono Font:** Geist Mono Variable (with ui-monospace, monospace), tabular figures.

**Character:** One quiet grotesque for everything a person reads, and its mono sibling for the numbers a DJ watches: durations, playback times, speeds and live progress.

### Hierarchy
- **Headline** (600, 1.125rem, 1.375): the track title in the track header and a collection's title. Up to two lines.
- **Title** (600, 1rem, 1.5, tight tracking): every heading: "Remixes", "Downloads", the empty state, the ambiguous-link prompt and "Page not found".
- **Body** (400, 0.875rem, ~1.43): messages, buttons (at 500), status words (at 500), the remix version name (at 500), the now-playing name (at 600).
- **Label** (400, 0.75rem, ~1.33): metadata lines, credits, badges, the remix column header, queue notes, "Not downloaded yet.".
- **Measure** (Geist Mono, 400, 0.75–0.875rem, tabular): durations, remix lengths, playback times, speed values and presets, live progress figures (percent, rate, time left).

### Named Rules
**The Measurement Rule.** Geist Mono sets a measurement standing on its own. Counts ("579K views", filter counts), sentences and a bitrate inside a prose line ("Source: Opus 128 kbps", "MP3 · 320 kbps · re-encoded from …") stay in Geist with tabular figures.

**The One Step Rule.** There is one heading step above body text. No display sizes, no uppercase labels, no eyebrows above headings. Column names are sentence-case Label text, not headings.

## Layout

A sticky 48 px header (name, folder picker, engine status) over two columns on large screens (1024 px): the main work column at full width and a 384 px downloads rail separated by a hairline; each column scrolls on its own. While a remix plays, the now-playing bar takes a 72 px row across both columns at the bottom of the window, in flow, so it never covers the page. Below the large breakpoint the rail stacks under the main column, the page scrolls, the bar sticks to the window's bottom as the page's last part (two rows: the seek bar over cover, names and controls, padded for the safe area), and scroll padding keeps focused rows clear of both the header (48 px) and the bar (96 px).

The main column runs full width with 16 px side padding and 20 px between the track header and the remix section. The ambiguous-link prompt and a resolve error keep a 48rem reading measure (`max-w-3xl`).

The remix list lays itself out by the width of its own section (a container query, so the rail counts): below 56rem (`@4xl`) its genre, platform and length fold into a line under the title; from 56rem they stand in their own columns. The speed grid sits inline in the bar from 1400 px and folds into a popover below.

Spacing runs on a 4 px base: 4 and 6 px inside clusters, 8 and 12 px between a row's parts, 16 px inside cards and between card sections. List rows are fixed-height (download rows 56 px, remix rows 56 px plus their hairline) and separated by hairlines at half strength rather than gaps.

## Elevation & Depth

Flat by default. Depth is tonal: the ground, one surface step for the track header, the remix row whose audio is on and the now-playing bar, and a slightly lighter popover. The only shadow is the one shadcn's generated popovers, menus and selects bring (`shadow-md` with a 1 px foreground ring at 10 %), used for anything that floats above the page. The bar is not floating: it sits in flow under a hairline, without a shadow.

### Named Rules
**The One Raised Row Rule.** In a list, only the row whose audio is on (preparing, playing, paused or failed) rises to the surface step; the now-playing bar on the same step is its player. Every other row lies on the ground.

## Shapes

Gently rounded throughout from one radius (0.5rem): cards, rows and default buttons at 0.5rem, small buttons and presets at 0.4rem, inline links' focus outlines at 0.3rem. Fully round shapes are reserved for badges, genre filter chips, switches, progress bars and range tracks and thumbs, platform dots, and the bar's 40 px play/pause. Borders are always hairlines; the genre chip's border turns dashed when the genre is a guess from the title or tags rather than the uploader's field. The now-playing bar is square-edged, a band across the window under a hairline.

## Components

### Buttons
Compact and quiet; the fill is earned.
- **Shape:** gently rounded (0.5rem; 0.4rem at the xs size).
- **Primary:** Evening Violet with Violet Ink text, 32 px high, 10 px side padding, 500 weight. Fades to 80 % on hover. The track's Download carries its ⌘D key hint inside it.
- **Hover / Focus:** outline and ghost buttons fill with Charcoal Muted on hover; focus shows the violet ring at 50 % (3 px). Pressing nudges the button down 1 px.
- **Outline:** a translucent input-stroke fill and border on the ground; the default for row actions (a remix's Download, Reveal in Finder, an idle Play).
- **Ghost:** no fill until hover; for menus, resets and the bar's Close.
- **Play glyphs:** play and pause are filled glyphs, not outlines. A row's Play is a 28 px outline icon button that turns violet while playing and Charcoal Muted while paused or preparing; the bar's play/pause is a 40 px violet circle.
- **Destructive:** a red tint (10–20 %) with red text, never a solid red block.

### Chips
- **Genre filter:** pill-shaped xs outline buttons with a muted count; the active one fills violet (its count at 70 %).
- **Genre tag:** an outline badge, near-white when the uploader set it, ash and dashed when guessed. On the wide remix columns it is the only pill in the row.
- **Speed presets:** xs buttons in Geist Mono; the active preset fills violet.

### Platform Badge
The platform's name with its 6 px brand dot, in Ash Grey. As a pill (hairline border, 20 px) in metadata lines and the paste box; plain (dot and words, no border) where it stands in a column of its own, as in the remix columns from 56rem ("● YouTube · 579K views") and the now-playing credit line.

### Cards / Containers
- **Corner Style:** 0.5rem.
- **Background:** Charcoal Surface for the track header; Charcoal Surface at 40 % for the paste well, skeletons and prompts.
- **Shadow Strategy:** none (see Elevation & Depth).
- **Border:** hairline.
- **Internal Padding:** 16 px.

### Inputs / Fields
- **Style:** the paste box is a 36 px input group on the 40 % surface well with an input-stroke border and a link icon; the platform badge appears inside it as soon as the link is recognised.
- **Focus:** the violet ring; the caret is violet.
- **Switches and checkboxes:** violet when on, input stroke when off.
- **Range inputs:** themed, never native: a 4 px Charcoal Muted track filled with Evening Violet up to the value, a 12 px Near-White thumb that takes the focus ring. Used for the seek bar and the speed slider.

### Navigation
- **Header:** 48 px, ground colour with a hairline below; the app name in 14 px semibold beside a muted disc icon; the folder picker and engine status as ghost triggers with a status icon in its hue.

### Status Line (signature)
A job's state is an icon in its status hue beside its word: in the rail a 14 px icon with a 12 px line, inline on the track header a 16 px icon with a 14 px medium word that takes the status colour. Live progress figures sit beside it in Geist Mono; spinners stop for reduced motion. A failure line always leads with its alert icon (track download, job line, remix download), with the next step under it in Ash Grey and the retry beside it.

### Track Header (signature)
The pasted track as a wide header across the main column, on the surface step. A 160 px cover (96 px below 768 px) beside the Headline title (two lines), the artist in Ash Grey, then a metadata line: platform badge · mono duration · the source's codec and bitrate. Along its bottom, the download: on the left the status ("Not downloaded yet." in Label, or the failure line, or the live job), on the right the primary Download with its ⌘D hint and the format select. Nothing downloads until asked. Below 768 px the download takes the card's full width under a hairline.

### Remix Columns (signature)
The remix list on aligned columns: one CSS grid, with the column header and every row as subgrids so a column lines up down the list. The column header is 28 px, sentence-case Ash Grey Label text (Title, Genre, Platform, Length) over a hairline, hidden from assistive tech, and shown only from 56rem. A row is 56 px: a 48 px cover (40 px narrow), the version name in Body at 500 (the part of the title that tells it apart, the full title in its tooltip) over its credit in Label, then the genre chip, the plain platform with its count, the mono length right-aligned, the Play glyph and Download. Below 56rem the genre, platform pill and length fold under the title. The row whose audio is on rises to Charcoal Surface with 0.5rem corners.

### Now-Playing Bar (signature)
The one player, across the window under the page and the rail while a remix is preparing, playing, paused or failed; absent otherwise. A 72 px Charcoal Surface band under a hairline: the cover (48 px; 40 px narrow), the version name at 600 over "credit · ● platform" in Label, the 40 px violet play/pause, the seek bar between mono elapsed and length, the speed grid (presets, ±0.01 nudges, mono value, Reset, Keep pitch, split by hairlines) inline from 1400 px or as an outline button showing the mono speed that opens it with its slider in a popover, Download for the playing upload, and a ghost Close. On a phone it takes two rows, the seek bar on top. While preparing, the seek bar's place says so in Label; on failure it holds the failure line with Try again. Its status region stays mounted, empty while idle, so what it says is announced.

## Do's and Don'ts

### Do:
- **Do** change the look through tokens in `src/styles.css`; take shadcn components from the CLI as generated.
- **Do** keep violet to primary actions, progress, the active control, checkboxes, switches and focus.
- **Do** pair every status hue with its icon and its word, failure lines included.
- **Do** show a platform as its brand dot (6 px) beside its name.
- **Do** set standalone measurements in Geist Mono with tabular figures.
- **Do** raise only the playing remix row to Charcoal Surface, with the now-playing bar as its player.
- **Do** style range inputs with the `range-input` utility and its `--value` fill, not the browser's default.
- **Do** set every heading at 600 on the one Title step (the track and collection titles at Headline).

### Don't:
- **Don't** use Tailwind palette colours (`bg-red-500`) in features; use the role tokens.
- **Don't** fill, border or colour text with a platform hue.
- **Don't** use pure white text or a black ground.
- **Don't** set counts, sentences or prose bitrates in monospace.
- **Don't** add a light theme by inheriting shadcn's defaults; a light theme would have to be designed.
- **Don't** add neon, glow or club styling, or make the primary blue.
- **Don't** float the player over the page; it takes its own row in the flow.
