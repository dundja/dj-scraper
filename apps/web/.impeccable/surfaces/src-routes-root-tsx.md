---
version: 1
slug: "src-routes-root-tsx"
primary_target: "src/routes/__root.tsx"
related_targets: ["src/styles.css"]
---

# Surface: app shell (whole working UI)

Scope: the layout and UX pass, inside the ADR-030 world recorded in apps/web/DESIGN.md (theme step shipped 2026-10-30). Visitor mode: Operate.

Audience and job: one DJ at a home desk in the evening, preparing sets for Rekordbox. Main jobs (user): digging remixes, picking from playlists, quick single grabs. Pains (user): wasted width, remixes feel buried. Keep (user): downloads always visible, paste box on top. Behaviour change (user): a pasted track no longer downloads by itself; its card leads with Download, so the remixes can be looked at first (ADR-031).

Constraints: dark only, offline, shadcn components never hand-patched (ADR-010), tokens and named rules from DESIGN.md, AA contrast, keyboard-complete.

Unresolved: whether "familiar music-app look" is a standing brand commitment (asked, not answered; not recorded). The downloads rail keeps today's rows (coloured status words for every row remain a roadmap item).

## Direction contract

THESIS: Auditioning gets its own home: a now-playing bar across the bottom of the whole window, as in a music app, while the main column spends its full width on the pasted track and its remixes. It refuses the narrow centred card with a long list buried under it.

OWN-WORLD: The ADR-030 world unchanged (DESIGN.md): charcoal ground, one surface step, hairlines, one violet accent, status hues with icon and word, platform dots, Geist with Geist Mono for measurements, one heading step.

STORY: The DJ pastes a link, sees the track large with its source quality and one Download (⌘D), scans twenty remixes in aligned columns, plays one and keeps it playing in the bar while scrolling, sets its speed there, and downloads the ones they want from the row or the bar.

FIRST VIEWPORT: 48 px header (name, folder picker, engine status); paste bar on top; a full-width track header (160 px cover, title, artist, platform · length · source, a status line, primary Download with its ⌘D hint, format select); Remixes heading with genre chips and a column header (Title, Genre, Platform, Length); remix rows across the full main width: 48 px cover, title and credit, genre chip, platform dot · plays, length in mono, Play, Download; the playing row raised with a violet pause; the downloads rail on the right ending above a 72 px now-playing bar spanning the window: cover, title, credit · platform, round violet play/pause, seek with mono times, speed presets, −/+ and the value, Keep pitch, Download. The bar is absent while nothing plays.

FORM: Surface structure "Now-playing bar", dealt position 2 of 3 (my ranked list's 4th), chosen by the user; the chosen sketch is .impeccable/mocks/decision/now-playing-bar.html. seed:b5b6cde93a4bae71

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
