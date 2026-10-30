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
  track-card:
    backgroundColor: "{colors.charcoal-surface}"
    textColor: "{colors.near-white}"
    rounded: "{rounded.lg}"
    padding: "16px"
  remix-row-playing:
    backgroundColor: "{colors.charcoal-surface}"
    rounded: "{rounded.lg}"
    padding: "10px 8px"
  player-strip:
    backgroundColor: "{colors.charcoal-muted}"
    textColor: "{colors.ash-grey}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "10px"
  progress-bar:
    backgroundColor: "{colors.violet-accent}"
    rounded: "{rounded.pill}"
    height: "4px"
---

# Design System: DJ Scraper

<!-- Recorded from the shipped theme step (ADR-030, on the shadcn/Base UI Nova setup of ADR-010). This records the visual world, not a final layout: the layout and UX pass is pending (docs/roadmap.md), so the Layout section describes the current shell only. -->

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
- **Evening Violet** (`violet-accent`): primary buttons (Go, Download), progress bars, the active speed preset, the active genre filter, a playing remix's button, checkboxes, switches, native range inputs (`accent-color`), the caret, and text selection at 35 %. Pressed toggles such as "Hide downloaded" take a violet tint (15–20 %) with a 60 % violet border instead of the solid fill.
- **Violet Ink** (`violet-ink`): text and icons sitting on Evening Violet; dark, not white (6.7:1).
- **Focus Violet** (`violet-ring`): the focus ring, usually at 50 % as a 3 px ring.

### Secondary
- **Done Green** (`status-done`): a finished job's icon and its status word.
- **Waiting Amber** (`status-waiting`): waiting, requeued and paused jobs ("not running yet, and why"), a paused queue note, and the warning engine banner's tint (10 %).
- **Failed Red** (`status-failed`): failed jobs, error messages, the destructive button (as a 10–20 % tint with red text), the danger engine banner's tint (10 %).

### Tertiary
- **YouTube Red** (`platform-youtube`), **SoundCloud Orange** (`platform-soundcloud`), **Spotify Green** (`platform-spotify`): a 6 px dot beside the platform's name, and nowhere else.

### Neutral
- **Charcoal Ground** (`charcoal-ground`): the page, the header and the downloads rail. Not black.
- **Charcoal Surface** (`charcoal-surface`): the one raised step: the track card and the playing remix row. At 40 % it is the quieter well under the paste box, the result skeletons and the ambiguous-link prompt.
- **Charcoal Popover** (`charcoal-popover`): menus, popovers and selects.
- **Charcoal Muted** (`charcoal-muted`): hover fills, the progress track, the player strip (at 60 %), secondary buttons.
- **Charcoal Hover** (`charcoal-hover`): shadcn's `accent`, a hover surface only, never a brand colour.
- **Near-White** (`near-white`): primary text (about 16:1 on the ground). Not pure white.
- **Ash Grey** (`ash-grey`): secondary text, metadata lines, idle status icons, the platform name (6–7:1).
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
- **Headline** (600, 1.125rem, 1.375): the track title on the track card and a collection's title. Up to two lines.
- **Title** (600, 1rem, 1.5, tight tracking): section headings, "Remixes" and "Downloads". Empty-state and prompt headings use the same size at 500.
- **Body** (400, 0.875rem, ~1.43): row titles, messages, buttons (at 500), status words (at 500).
- **Label** (400, 0.75rem, ~1.33): metadata lines, badges, queue notes, the player strip.
- **Measure** (Geist Mono, 400, 0.75–0.875rem, tabular): durations, playback times, speed values and presets, live progress figures (percent, rate, time left).

### Named Rules
**The Measurement Rule.** Geist Mono sets a measurement standing on its own. Counts, sentences and a bitrate inside a prose line ("MP3 · 320 kbps · re-encoded from …") stay in Geist with tabular figures.

**The One Step Rule.** There is one heading step above body text. No display sizes, no uppercase labels, no eyebrows above headings.

## Layout

The current shell, pending the layout and UX pass (docs/roadmap.md): a sticky 48 px header (name, folder picker, engine status) over two columns on large screens, the main work column and a 384 px downloads rail separated by a hairline; each column scrolls on its own. Below the large breakpoint the rail stacks under the main column, the page scrolls, and scroll padding keeps focused rows clear of the header.

Spacing runs on a 4 px base: 4 and 6 px inside clusters, 8 and 12 px between a row's parts, 16 px inside cards and between card sections. List rows are fixed-height (download rows 56 px) and separated by hairlines at half strength rather than gaps.

## Elevation & Depth

Flat by default. Depth is tonal: the ground, one surface step for the track card and the playing remix row, a slightly lighter popover. The only shadow is the one shadcn's generated popovers, menus and selects bring (`shadow-md` with a 1 px foreground ring at 10 %), used for anything that floats above the page.

### Named Rules
**The One Raised Row Rule.** In a list, only the row whose audio is on rises to the surface step, together with its player strip. Every other row lies on the ground.

## Shapes

Gently rounded throughout from one radius (0.5rem): cards, rows and default buttons at 0.5rem, small buttons and the player strip at 0.4rem, inline links' focus outlines at 0.3rem. Pills (fully round) are reserved for badges, genre filter chips, switches, progress bars and platform dots. Borders are always hairlines; the genre chip's border turns dashed when the genre is a guess from the title or tags rather than the uploader's field.

## Components

### Buttons
Compact and quiet; the fill is earned.
- **Shape:** gently rounded (0.5rem; 0.4rem at the xs size).
- **Primary:** Evening Violet with Violet Ink text, 32 px high, 10 px side padding, 500 weight. Fades to 80 % on hover.
- **Hover / Focus:** outline and ghost buttons fill with Charcoal Muted on hover; focus shows the violet ring at 50 % (3 px). Pressing nudges the button down 1 px.
- **Outline:** a translucent input-stroke fill and border on the ground; the default for row actions (Download, Reveal in Finder, play).
- **Ghost:** no fill until hover; for menus and resets.
- **Destructive:** a red tint (10–20 %) with red text, never a solid red block.

### Chips
- **Genre filter:** pill-shaped xs outline buttons with a muted count; the active one fills violet (its count at 70 %).
- **Genre tag:** an outline badge, near-white when the uploader set it, ash and dashed when guessed.
- **Speed presets:** xs buttons in Geist Mono; the active preset fills violet.

### Cards / Containers
- **Corner Style:** 0.5rem.
- **Background:** Charcoal Surface for the track card; Charcoal Surface at 40 % for the paste well, skeletons and prompts.
- **Shadow Strategy:** none (see Elevation & Depth).
- **Border:** hairline.
- **Internal Padding:** 16 px, sections split by a hairline with 12 px above the content.

### Inputs / Fields
- **Style:** the paste box is a 36 px input group on the 40 % surface well with an input-stroke border and a link icon; the platform badge appears inside it as soon as the link is recognised.
- **Focus:** the violet ring; the caret is violet.
- **Switches and checkboxes:** violet when on, input stroke when off.

### Navigation
- **Header:** 48 px, ground colour with a hairline below; the app name in 14 px semibold beside a muted disc icon; the folder picker and engine status as ghost triggers with a status icon in its hue.

### Status Line (signature)
A job's state is an icon in its status hue beside its word: in the rail a 14 px icon with a 12 px line, inline on the track card a 16 px icon with a 14 px medium word that takes the status colour. Live progress figures sit beside it in Geist Mono; spinners stop for reduced motion.

### Remix Row and Player Strip (signature)
A 40 px artwork, a two-line title, and a metadata line (kind, genre chip, platform badges with plays, mono duration), with play and Download at the end. When playing, the row rises to the surface step and opens the player strip: a Charcoal Muted panel with mono times around a violet range input, the speed presets, ±0.01 nudges, Reset to 1x, and Keep pitch.

## Do's and Don'ts

### Do:
- **Do** change the look through tokens in `src/styles.css`; take shadcn components from the CLI as generated.
- **Do** keep violet to primary actions, progress, the active control, checkboxes, switches and focus.
- **Do** pair every status hue with its icon and its word.
- **Do** show a platform as its brand dot (6 px) beside its name.
- **Do** set standalone measurements in Geist Mono with tabular figures.
- **Do** raise only the playing remix row to Charcoal Surface.

### Don't:
- **Don't** use Tailwind palette colours (`bg-red-500`) in features; use the role tokens.
- **Don't** fill, border or colour text with a platform hue.
- **Don't** use pure white text or a black ground.
- **Don't** set counts, sentences or prose bitrates in monospace.
- **Don't** add a light theme by inheriting shadcn's defaults; a light theme would have to be designed.
- **Don't** add neon, glow or club styling, or make the primary blue.
