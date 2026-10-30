---
version: 1
slug: "src-routes-root-tsx"
primary_target: "src/routes/__root.tsx"
related_targets: ["src/styles.css"]
---

# Surface: app shell (whole working UI) — theme step

Scope: theme only (tokens, type, status and platform colour roles) on the existing shadcn/Base UI shell. Visitor mode: Operate. Layout and UX pass follows as a separate step.

Audience and job: one DJ at a home desk in the evening, preparing sets for Rekordbox: paste links, audition remixes, watch downloads. Constraints: dark only, offline (bundled fonts), shadcn components never hand-patched (ADR-010), AA contrast kept although no formal bar.

Unresolved: whether "familiar music-app look" is a standing brand commitment (asked, not answered; not recorded).

## Direction contract

THESIS: The category standard played straight: a dark music app at Spotify-desktop and Rekordbox craft, where artwork carries the colour and the chrome only carries state. It refuses today's anonymous neutral-grey shadcn default and any DJ/club costume.

OWN-WORLD: Charcoal ground with a barely cool cast, one lighter surface step, hairline borders, a white-to-grey text ramp; one violet/indigo accent only for primary actions, progress, the active speed preset, switches and focus; status hues (done green, waiting/paused amber, failed red; downloading = accent) always paired with an icon and a word; platforms as brand dot + name, never a field. Geist for UI, Geist Mono with tabular figures for measurements set on their own: durations, playback times, speeds and live progress figures (percent, rate, time left); a bitrate inside a prose output line ("MP3 · 320 kbps · re-encoded from …") stays in Geist for readability. One heading step (track title, Remixes, Downloads) above body text. The playing remix row is one raised surface with its player strip.

STORY: The DJ sees the cover art first, reads every job's state from the downloads rail at a glance, tells YouTube from SoundCloud from Spotify instantly, and works for hours without glare.

FIRST VIEWPORT: Unchanged shell: 48 px header (name, folder picker, engine status), paste bar with the violet Go, the track card, the remixes list with the playing row's player strip and violet active speed, and the 384 px downloads rail whose rows carry their status icon in its colour (a failed or paused row's words in theirs) and violet progress bars; the track card's status word takes its colour. Coloured status words for every rail row wait for the layout pass, since this step changes no copy.

FORM: The category standard (canon), chosen by the user over the roll; reference products Spotify desktop and Rekordbox; the chosen sketch is .impeccable/mocks/decision/canon.html. seed:bc2bf9c211d56ca7

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
