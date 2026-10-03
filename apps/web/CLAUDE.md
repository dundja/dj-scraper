# apps/web: React UI

Vite SPA for DJ Scraper. It talks only to the local server through `/api` (Vite proxies it to the server in dev). UX flows are in `docs/product.md`.

## Stack
React 19 · TypeScript (strict) · Vite 8 · TanStack Router (file-based routes in `src/routes/`) · TanStack Query · Tailwind CSS v4 (CSS-first config in `src/styles.css`) · shadcn/ui on Base UI, Nova preset (ADR-010) · lucide-react · TanStack Virtual (`@tanstack/react-virtual`) for long lists

## Layout
```
vite.config.ts      dev server: port 5173, strictPort, cors: false, anti-framing headers, /api proxy
                    keeping the browser's Host (docs/architecture.md, Security model; ADR-011) and
                    destroying a response the server cut off, so EventSource sees the drop (ADR-019)
dev-guard.ts        dev-server plugin: the guard's Host + Fetch Metadata rules for every request Vite answers
dev-exit.ts         dev-server plugin: Ctrl-C/SIGTERM close Vite and exit 0 (clean `pnpm dev` exit)
vite-config.test.ts pins the dev server's security settings (ADR-011) and the proxy fix
playwright.config.ts e2e on port 4849 against apps/server/test/e2e-server.ts (Chromium, WebKit), workers: 1
e2e/                fixtures.ts (import test/expect from here; auto fixtures: console guard with
                    expectConsoleError, network guard, reveal answered 204, settings restored, jobs canceled
                    and cleared before each test; downloadFolder), app.ts (shared locators and actions:
                    linkBox, jobRow, trackCard, pasteAnywhere (a paste event, as Edit > Paste sends;
                    single-track.spec.ts also presses the real ⌘V), nextPost), fake-urls.ts (the URLs the fake
                    engine answers, and what specs must know about the shared server), *.spec.ts
vitest.config.ts    tests: jsdom, src/test/setup.ts; no router/Tailwind plugins
src/
  main.tsx          QueryClient (createQueryClient) + router (context { queryClient }), StrictMode; starts
                    the event stream once (startEvents) at module level, not in an effect
  routes/           __root.tsx (the shell, ADR-020: header with FolderPicker and EngineStatus, EngineBanner,
                    then <main> beside <aside aria-label="Downloads">; one TooltipProvider, 300 ms),
                    index.tsx (ResolvePage); -root.test.tsx (the '-' keeps the router plugin off it).
                    Later settings.tsx (Phase 4)
  features/<name>/  components + hooks per feature:
    resolve/        ResolvePage: the paste box and badge (url-verdict.ts), paste anywhere, the ⌘V fallback
                    and drop (useLinkDrop; paste-text.ts finds the link: findLink, dropLink, carriesFiles,
                    isEditableTarget), useResolve (a useMutation per load with its own AbortController),
                    loading / error / ambiguous views, ResolvedResult (keyed by the load's number; autoStart
                    frozen at mount). testing/ = vi.mock doubles of TrackCard and CollectionView for this
                    folder's tests; resolve-autostart.test.tsx runs the real TrackCard instead
    track/          TrackCard, useTrackDownload (queues once when autoStart), track-source.tsx (the job's
                    source once known), track-download.tsx
    collection/     CollectionView (keyed by the collection object: instance-key.ts), header and lists,
                    selection-toolbar, track-table + track-row (virtualized div table with ARIA roles; roving
                    focus in use-row-focus.ts), selection.ts (pure reducer) + use-selection.ts, download-bar;
                    job-status.tsx (a row's chip, read by job id); use-enrichment.ts over enrich-session.ts
                    and the pure enrich-plan/-merge/-retry.ts (ADR-022); test-utils.ts (stubTableViewport,
                    useFakeEnrichment; tests only); collection-enrichment.test.tsx (the real hook and table)
    downloads/      use-downloads.ts (useDownloads, useJob, useJobIdsByTrack, useQueue: never fetch),
                    use-create-downloads.ts, track-ref.ts (toTrackRef, trackKey, downloadOptionsFrom);
                    job-*: JobRow (JOB_ROW_HEIGHT 56), JobInline, job-text.ts (wording), job-actions.ts (one
                    action per job), job-clock.ts (useNow); the panel: downloads-panel.tsx, panel-* (header,
                    menu, notes, list, batch row, actions, rows, text), summary.ts (counts, progress weights)
    folder/         FolderPicker, folder-menu, folder-problem (refusals in a popover), usePickFolder
    settings/       useSettings, useUpdateSettings (optimistic), FormatSelect + format-options.ts
    engine/         useHealth, useRecheckHealth, the EngineStatus chip and popover, EngineBanner
                    (engine-banner-state.ts; each warning dismissed by tool:severity for the tab's session,
                    in sessionStorage: it comes back only beside a new kind of warning)
  components/       artwork.tsx (Artwork), platform-badge.tsx (PlatformBadge), folder-path.tsx (FolderPath:
                    a path cut at its start when it doesn't fit, full path in the tooltip)
  components/ui/    shadcn/ui (generated by the CLI; formatted, not linted, never hand-patched)
  lib/api.ts        typed client; validates responses with @dj-scraper/shared schemas (health, resolve,
                    downloads incl. bulk and reveal's 204, settings, folder picker; no downloads list call)
  lib/events.ts     startEvents: the one /api/events stream → ['downloads'] (DownloadsState, never
                    fetched); a drop past 2 s rechecks ['health']; hidden tabs close it after 10 s
  lib/format.ts     pure display text: formatBytes, formatSpeed, formatEta, formatTotalDuration, formatClock,
                    shortenPath, folderName, clipText (formatDuration is in @dj-scraper/shared)
  lib/error-text.ts errorHint (a next step per ErrorCode), describeError (nothing for an abort),
                    isAbortError, unavailableLabel. Hints may hold `commands`: render them with ProblemText
  lib/query-client.ts  queryClientDefaults (networkMode 'always'), createQueryClient
  lib/focus.ts      focusNextAfter: where focus goes when a control removes itself
  lib/use-throttled-value.ts  a value that changes at most once per interval (the panel's spoken counts)
  test/             fake fetch (fake-api.ts), FakeEventSource (fake-event-source.ts: the test plays the
                    server's side), Health fixtures (health.ts), download fixtures parsed with the shared
                    schemas (downloads.ts: uuid(n), refs, jobWith, snapshotWith, settings, liveDownloads),
                    resolve fixtures (resolve.ts: track, scTrack, ambiguous, playlist, scSet, bigPlaylist(n),
                    userPageWithLists, entryOk/entryError), render.tsx (renderWithQueryClient,
                    createTestQueryClient), console guard (setup.ts)
  routeTree.gen.ts  generated by the router plugin on dev/build; committed; never edit
```

## Conventions
- Imports of our own files keep the extension, also through the alias: `@/lib/api.ts`, `./engine-state.ts`. Only shadcn's generated files import without one.
- Add components with the CLI from `apps/web`: `pnpm dlx shadcn@4.21.1 add <name>`, then `pnpm check:fix apps/web`. They are Base UI components, which compose with a `render` prop, not Radix's `asChild`.
- `.tsx` files export only components, so React Fast Refresh keeps working. Put helpers and constants in `.ts` files.
- Server state goes through TanStack Query. Components never call `fetch` directly; they use `lib/api.ts`.
- Job progress comes from SSE (`/api/events`), merged into the query cache by `lib/events.ts`. No polling.
  - `['downloads']` has one writer, the event stream. Read it with `useQuery(downloadsQueryOptions)`; never prefetch, `ensureQueryData` or refetch it (its query function is `skipToken`), and never write mutation answers into it.
  - After `api.createDownloads` succeeds, invalidate `['settings']`: the server adds the folder to `recentFolders`.
  - Don't wait for a 100 % progress event: a short track may send one `job.progress` and go straight to processing.
  - Read `['downloads']` through the hooks in `features/downloads/use-downloads.ts`; they select, so one job's progress re-renders only what shows it.
- Resolve is a `useMutation` per load (`useResolve`), never a query: a paste of the same link resolves again, nothing is cached, and the result view is keyed by the load's number (ADR-020). The track card's `autoStart` is frozen at mount.
- Settings changes go through `useUpdateSettings`: optimistic, rolled back (and refetched) on error, and sent one at a time in the order they were made (mutation scope `settings`), so a slow folder check can't let an older choice be saved last.
- Every QueryClient uses `queryClientDefaults` (`lib/query-client.ts`, `networkMode: 'always'`): the API is local, so the browser's online state must not pause a query or mutation.
- Enrichment of partial rows bypasses TanStack Query: `useEnrichment` reads a session store with `useSyncExternalStore` (ADR-022).
- Page-wide paste and ⌘V ignore events inside other text fields (`isEditableTarget` in `features/resolve/paste-text.ts`). Drops: a file is refused (the browser would open it in place of the app), text without a link dropped on another text field goes into that field, and a link loads wherever it is dropped.
- Show folder paths with `FolderPath` (`components/folder-path.tsx`): `~` for the home folder, cut at the start when they don't fit, so the folders that tell them apart stay visible.
- UI-only state (selection, filters, dialogs) stays local to its feature (`useState`/`useReducer`). Add a store only when distant features really share state.
- Playlist selection is a `Set` of `TrackKey`s (`platform:id`, so a track listed twice is one key) in a pure reducer (`features/collection/selection.ts`), with select all/none/invert over the rows the filter shows and shift-click ranges. Filtering keeps the selection, and unavailable entries can't be selected (ADR-021).
- Long lists use TanStack Virtual with fixed row heights (nothing is measured) and memoized rows. On lg+ a list fills its column (`flex min-h-0 flex-1 flex-col` down to a `min-h-0 flex-1 overflow-auto` scroller); below lg it gets a bounded height such as `h-[60svh]`. A virtualized table is divs with ARIA table roles and roving focus, not `<table>` (ADR-021).
- Honest audio in the UI (`features/downloads/job-text.ts`): show a job's `output` next to its `source`, say copied or re-encoded ("from <source>" for a lossless output: it holds the source's quality, no more), and show a measured bitrate as the nominal one only when it is at most 3 % above it, never rounded up. A job offers at most one action at a time (`job-actions.ts`).
- Use function components with named exports. Split a component once it passes ~150 lines or does two jobs.
- Style with Tailwind utilities and the `cn()` helper. Dark theme first; respect `prefers-reduced-motion`.
- Accessibility: everything keyboard-reachable, labelled inputs and checkboxes, visible focus, `aria-live` for progress and status. A control that removes itself hands focus on (`focusNextAfter`, or back to the link box). Base UI tooltips are visual only (no `role="tooltip"`, no `aria-describedby`), so every icon button has its own `aria-label`.
- Customize shadcn/ui components through variants and props. Re-add a component rather than hand-patching its generated internals.
- Tests: Vitest + Testing Library for non-trivial hooks and components (`*.test.tsx`); user flows in Playwright e2e (`e2e/*.spec.ts`, importing `test`/`expect` from `e2e/fixtures.ts`). In WebKit, Tab skips links, so keyboard specs use Option-Tab (Alt+Tab) there.
  - Fake `fetch` at the network edge (`src/test/fake-api.ts`), not the hooks, and render with a fresh QueryClient from `createTestQueryClient()` (`src/test/render.tsx`: the app's defaults, no retries), never a hand-made one. The two `vi.mock` exceptions stand in for parts tested on their own: the resolve tests' doubles of `TrackCard` and `CollectionView` (`features/resolve/testing/`), and `useFakeEnrichment` for the collection's component tests (`features/collection/test-utils.ts`).
  - Live jobs: `liveDownloads(queryClient)` (`src/test/downloads.ts`) runs the real `startEvents` over `FakeEventSource`, sends a snapshot and each event inside `act()`, and stops at the test's end. The real enrichment under the real table is tested once, in `features/collection/collection-enrichment.test.tsx` (it registers `POST /api/resolve/entries`); other collection tests use `useFakeEnrichment`.
  - Any `console.error` or `console.warn` fails the test (`src/test/setup.ts`), so fix React warnings instead of muting them. Restore only your own spies (`mockRestore`): `vi.restoreAllMocks()` in an `afterEach` would also restore helpers' spies (such as `stubTableViewport`'s) before the tree unmounts. The guard itself wraps the console without spies, so it stays on.
  - With fake timers, RTL's `findBy`/`waitFor` don't see Vitest's clock: advance with `act(() => vi.advanceTimersByTimeAsync(ms))`, then query synchronously. A 0 ms timer set inside a fake-timer callback (TanStack Query's notify after the stream's outage timer) runs 1 ms later, so advance 1 ms more.
  - jsdom lays nothing out: a virtualized list needs a stubbed `offsetHeight`/`offsetWidth` (`stubTableViewport` in `features/collection/test-utils.ts`, which also stubs `scrollTo` and `scrollIntoView` and returns the `scrollIntoView` spy, or as `downloads-panel.test.tsx` does) or it renders no row.
  - Base UI in jsdom: without the shell's provider a tooltip opens after 600 ms, so wrap in `<TooltipProvider delay={0}>` or open it by focus, then find `[data-slot="tooltip-content"]`. Read a Select's value from `[data-slot="select-value"]`: the trigger's text also holds the chevron's hidden "▼".
  - Event stream tests use `FakeEventSource` (`src/test/fake-event-source.ts`), since jsdom has no EventSource, and check that `stop()` leaves no timer (`vi.getTimerCount()`).
  - The e2e console guard also catches the browser's own "Failed to load resource" lines (an error answer, or Vite's 502 while the server is down). A spec expects each one with `expectConsoleError(failedLoad(status, path))`; an expected line that never comes fails the test.
  - One e2e server serves the whole run (`workers: 1`), so state carries over: a spec that expects `done` downloads into its own `downloadFolder`, and reveal is always intercepted (204). Wait for the autofocused link box before `pasteAnywhere`: a paste sent before React mounts is lost.
  - YouTube pacing is real in e2e (10 downloads at once, then one per 12 s, over the whole run) and the playlist and cancel specs spend that burst. A new spec downloads the SoundCloud track, or expects the 12 s waits within the 30 s test timeout. New fake URLs go in `apps/server/test/e2e-server.ts` and `e2e/fake-urls.ts`.
