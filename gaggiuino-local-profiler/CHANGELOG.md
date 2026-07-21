## [2.6.0] – 2026-07-21

### Added
- **App-shell redesign — "Rail + Panel."** Shell-only redesign (verdict header, recipe/process zones, charts and view-switching logic untouched). Desktop: a collapsible left icon+label nav rail replaces the horizontal `#mode-bar` entirely, collapse state persisted in `localStorage` (`glp_rail_collapsed`); the multi-machine switcher and the shot-sidebar's re-expand button move into a new slim `#content-topbar`. Nav button ids are unchanged from the old mode-bar so `mode.js`'s active-state toggling and `status.js`'s live/orders visibility gating keep working unmodified. Closes #411
- **Rich sidebar shot cards restored, grouped by day.** The shot sidebar goes back to rich 3-line cards (thumbnail, profile name + score pill + machine badge, coffee + dose, star rating + grinder + time-of-day), partially reverting v2.4.0's flattened 2-line row. Per-row timestamps are replaced by day-separator group headers ("Heute"/"Gestern"/date), backed by a new pure `groupShotsByDay()` helper (`public-src/utils.js`) with its own unit tests. Closes #412
- **Mobile: shot list becomes the primary "Shots" screen.** Bottom nav and the "Mehr" sheet get inline stroke-SVG icons instead of emoji (active state uses the accent token). The shot list is no longer a drawer/overlay — tapping "Shots" pushes to a real list screen, and tapping a shot pushes to its detail view with a back-chevron returning to the list (`setMobileShotSubview()` in `sidebar.js`). Closes #410

### Fixed
- **Sidebar text unreadable in light themes.** Hardcoded `color: #fff` on `#sidebar h2` and `.profile-name-sidebar` made shot-list text unreadable in light/Crema themes; swapped to the existing `--gray-200` "brightest text" token used elsewhere. Verified in stock light and light+Crema. Closes #405
- **Verdict header unreadable in light themes.** `.sprofiler-header h1`, `.verdict-headline` and `.verdict-ring-inner`'s score number all hardcoded `color:#fff`, making the shot title and verdict headline invisible against the light/Crema themes' near-white content background. Swapped to the same `--gray-200` token used for the #405 sidebar fix. Verified via `getComputedStyle` in dark, light+amber and light+crema, not just a visual check. Closes #413
- **Decorative emoji replaced with stroke-SVG across the shell chrome.** The remaining decorative ☕ outside the nav chrome (empty-state icon, live-idle icon, favicon) is now the same inline stroke-SVG cup mark used for the rail brand logo; the trailing "☕" dropped from the `preheat_ready` string in all 6 i18n files (#414). The preheat widget's 🔥 warming icon and the orders menu's trending-toggle 🔥 are now the same inline stroke-SVG flame (#415). The orders menu's bean/milk toggle buttons and their inline notes (🫘/🥛) are now stroke-SVG bean and milk-carton icons (#416). User-generated content (the order-item's own emoji picker, the user's milk-emoji fallback) is deliberately left untouched — out of scope. Closes #414, Closes #415, Closes #416

Known follow-up left open deliberately: an app-wide emoji purge in view content (beyond the shell chrome touched here) is tracked as #417, not included in this release.

## [2.5.0] – 2026-07-20

### Added
- **Ghost curve + delta chips for same-profile auto-compare.** A new `ShotRepository.findPreviousByProfile()` looks up the most recent prior shot with the same profile on the same machine; `GET /api/shots/:id` gains an additive `previousShotId`/`previousShot` field. The verdict header now shows a score delta chip (e.g. "+2 vs. Shot 1"), the Process zone's pressure/flow/temp metrics get signed delta chips against that previous shot, and the chart overlays the previous shot's pressure/flow/weight curves as a dashed, lower-opacity ghost — all omitted when there's no previous same-profile shot. The pre-existing explicit A/B compare feature is untouched; this is a same-profile-only auto-compare, not a general diff tool. Closes #402
- **Mobile bottom navigation + above-the-fold shot detail.** On narrow viewports the horizontal mode-bar tab row is replaced by a bottom nav (Shots/Live/Bibliothek/Statistiken + a "Mehr" sheet collapsing Bezugslog/Wartung/Einstellungen/Bestellungen), reusing the #397 pill visual language. Tapping "Shots" opens the shot list as its own reachable view instead of a permanently-docked column; the mode bar survives only to host the multi-machine switcher and auto-collapses when there's nothing to show. The #399 hover-only compare button and the star rating now get a real 44x44px touch target under `@media (hover: none)`, gated on touch capability rather than viewport width. Verified via Playwright at 390x844: bottom nav replaces the tab row, and the verdict header + recipe zone + full chart render above the fold. Badge counts (Wartung/Bestellungen pending) are not yet mirrored into the "Mehr" sheet — only visibility gating is; likewise the live status pulse isn't mirrored onto the bottom-nav Live icon, only show/hide. Closes #403
- **Crema accent theme with serif bean names + refined library cards.** A sixth `[data-accent]` theme — warm espresso-brown neutrals (not just accent tokens) with a warm accent color, dark and light variants, both contrast-checked ≥4.5:1 against the same floor established for the existing scale in #397. A bundled Fraunces (SIL OFL) `@font-face` (`public-src/fonts/`) serves both the browser and the server-side share-card canvas renderer (`lib/card.js`) with no external font CDN, so it works offline/behind HA ingress; applied only to bean names in the Bibliothek view and the share card via `.serif-display` — never on numeric/data displays. Bean library cards gain an origin eyebrow line above the name, flavor tags move from filled badges to outline-style pills, and a proportional stock-remaining bar sits next to the existing gram figure. Closes #404

## [2.4.0] – 2026-07-20

### Added
- **Verdict-first shot detail.** A new verdict header sits at the top of the shot detail — a score ring (conic-gradient, unified scale) plus the dial-in advice rewritten as a plain-language headline with a subline (profile, shot no., bean, duration, avg pressure) — replacing the old green dial-in banner and the separate top-right score badge. Metrics below are regrouped into two zones: **Recipe** (dose→yield, ratio + EY, duration + phases, bean & grinder) as large cards above the chart, and **Process** (pressure avg/max, pump flow avg, temp avg ±σ) as compact cards below it; the chart itself is unchanged. Weight-flow avg/max is dropped from the always-visible view and the mobile-only duplicate phase subtitle is retired since phases now render once, inside the duration card, at any viewport width. No shot-to-shot delta view yet — this round is the header/grouping redesign only, deltas are a follow-up. New i18n strings added to all 6 languages. Closes #398
- **Sidebar shot list rebuilt as fixed data rows.** Each row is now a consistent 2-line layout: profile name + right-aligned score (unified scale) on line 1, "dose g → yield g · duration · date" in tabular-nums on line 2 (falls back to the bean name when dose/yield aren't both known yet). Rows are ≥48px tall with a rounded hover/active surface and an inset accent bar instead of a bottom-border separator; the compare button now only appears on row hover/focus on pointer devices (always visible on touch, where there's no hover to reveal it), while staying keyboard-reachable via `:focus-within`. Closes #399
- **Design tokens foundation.** Border radii consolidated to a single `--radius` token; the shot-score color scale is now one shared 3-tier rule (green ≥90, yellow ≥70, red below) via `scoreClass()`/`scoreColor()` in `utils.js`, replacing five separately-implemented threshold checks across the sidebar, shot detail, analytics and the dial-in wizards; `tabular-nums` applied globally so numeric metrics (scores, durations, dates) stop jittering as digits change; the mode tab bar restyled as segmented pills; muted gray label colors raised to a clear ≥4.5:1 contrast ratio. The sidebar hint box is removed — its content is now surfaced as a tooltip on the compare button, translated in all 6 languages. Closes #397
- **Richer generic Shopify bean import results.** The curated flavor-term vocabulary gained specialty/English terms (lychee, tropical, lactic, guava, passion fruit, papaya). A new heading-agnostic `matchFlavorTerms()` extracts the curated-vocabulary scan out of `extractFlavorKeywords()` so the generic Shopify/JSON-LD/OpenGraph parsers can use it directly — `extractFlavorKeywords()`'s "Sensorik/Geschmack/Aromen" heading requirement is elbgold-specific and previously returned empty for any shop without that heading, regardless of vocabulary matches. The generic Shopify parser also stops trusting a vendor value that doesn't read as a real roaster name (e.g. a shop-tag-style value like "Taste Profile_…"), falling back to the shop's own domain for the roaster field instead. Closes #400

## [2.3.0] – 2026-07-16

### Added
- **Screenshots pipeline seeds a second (GaggiMate) machine.** `scripts/screenshots.mjs` now registers a second machine and attributes two of the four demo shots to it, so regenerated screenshots show the multi-machine switcher and per-machine UI instead of a single-machine install. The GaggiMate shots' datapoints are decoded through the real production `.slog` parser (`lib/machines/gaggimate/history.js`) from a synthetic buffer, not hand-built — same field-layout convention verified against a real device for #388. Added a new `analytics-machines.png` screenshot (machine comparison, bean ranking, weekday×hour heatmap, dial-in progression) alongside the existing set; `maintenance.png`/`analytics.png` regenerated to reflect the #393/#394 redesigns. DOCS.md, DOCS.de.md and the README features table updated for the new maintenance dashboard and new statistics. Closes #395
- **Four new Analytics charts.** Weekday × hour heatmap (a true 7×24 shot-count matrix, same visual language as the existing calendar heatmap); a sortable Bean Ranking table (shots, avg score, last grind setting used, and a last-5-vs-previous-5 scored trend indicator); a Machine Comparison table (avg score, avg duration, temperature stability — mean |T−target| — per machine, shown only once ≥2 machines are registered, deliberately ignoring the active-machine scope since comparing machines only makes sense across all of them); and a per-bean Dial-In Progression chart (grind setting + score across that bean's own shot sequence, with a bean picker), reusing the same bean-name linkage convention (case-insensitive `annotation.coffee` match) used elsewhere. Closes #394
- **Maintenance view redesign: dashboard layout.** Replaced the maintenance view with the "Dashboard" variant (of three mockups) Max picked: summary tiles (due/soon/ok counts + log entries this year), an "Als Nächstes" banner naming the single most overdue task and machine with an inline done-button, a machine filter segment control (independent of the app's global machine switcher, hidden on single-machine installs), compact task tiles (status pill, progress bar, machine tag — "geteilt" for shared equipment like the water filter and grinders, shown once) with the threshold input/shots-or-days toggle/guided-flow now behind a per-tile "Details" expand instead of always visible, and the maintenance log as a filterable table (Date/Maintenance/Machine/Shots/Notes) with machine badges. Builds on #392's read-only per-machine grouping — done/threshold actions now write to the specific machine each tile actually belongs to (never silently to the wrong one or to whichever machine happens to be globally active), verified end-to-end against a real server + browser with two registered machines. `GET /api/maintenance/log` gained an optional `machineId` query param (including `all`), fully backward compatible with the previous no-param (= every machine) behavior. No emoji anywhere in the new UI — task icons are inline SVG, and the done/guide/delete buttons use plain translated text. Closes #393

### Fixed
- **Home Assistant tabs reloaded on their own whenever GLP was open through Ingress.** `public-src/main.js`'s one-time service-worker cleanup called `getRegistrations()` and unregistered every registration for the page's origin unconditionally — but through HA Ingress that origin IS Home Assistant's own origin, so this was also unregistering HA frontend's own service worker. HA re-registers it and `clients.claim()` fires a `controllerchange` event that HA's frontend reacts to by reloading every open tab. The cleanup now only unregisters a registration whose active/waiting/installing script exactly matches GLP's own `sw.js` URL, never touching anything else sharing the origin. Closes #387
- **Maintenance counters were wrong in "all machines" mode.** The frontend sends `machineId=all`, but the backend's `activeMachineId()` did `parseInt('all')` -> `NaN` and silently fell back to machine 1 — every "all machines" maintenance view was actually showing machine 1's counters with nothing indicating that. `GET /api/maintenance?machineId=all` now returns a distinctly-shaped payload: per-machine-scoped tasks (descaling/backflush/grouphead/gaskets) grouped under `machines[]` (one entry per registered machine), and shared-equipment tasks (waterfilter/grinder\_\*, identical across machines) computed once under `global`. The maintenance view renders a section per machine plus one shared-equipment section, each labeled with the machine's name; these "all machines" cards are read-only for now (the done/threshold controls still target a single active machine — full per-machine editing is a follow-up). Closes #392
- **Order/live-shot dates ignored the selected app language.** `views/orders.js`'s customer stats and `views/live.js`'s reference-shot selector both called `toLocaleDateString()` with no locale, so dates always rendered in the browser's own locale instead of GLP's selected language. Both now use the app's existing `toLocaleDateString(LOCALE_MAP[S.currentLang] || 'de-DE', { day:'2-digit', month:'2-digit', year:'numeric' })` idiom (see `views/analytics.js`). Also added the missing `nl: 'nl-NL'` entry to `LOCALE_MAP` — the app supports 6 languages but the map only had 5, so Dutch always silently fell back to `de-DE` formatting. Closes #391
- **Active machine selection wasn't restored on a direct (non-Ingress) browser reload.** `main.js` called `loadMachines()` (which fetches the token-gated `/api/machines`) straight from the `DOMContentLoaded` handler, before `initToken()` had ever run — so its `X-GLP-Token` header was always empty and the request 401ed for any non-Ingress session (Ingress bypasses the token check entirely, which is why this went unnoticed there). `S.machines` never populated, so the machine switcher stayed hidden regardless of the correctly-restored `localStorage` value. `loadMachines()` now runs inside the same `initToken().then()` chain as `loadData()`/`loadLibrary()`, after the token is actually available. Verified end-to-end against a real server + real browser (both `'all'` and a specific machine id now persist correctly across reload). Closes #390
- **"↩ Letzten" grind prefill ignored the bean's actually-last-used grind.** `quickClone()`'s call into `suggestGrindDoseForBean()` prioritized the best-scoring historical grind combo (then a stale `knownGrindSettings[0]`) and only fell back to the bean's most recent annotated shot last — but users expect "Letzten" to mean the grind they last used for this bean. `suggestGrindDoseForBean()` gained an opt-in `{ preferMostRecent: true }` flag (used only by `quickClone()`) that checks the bean's most recent annotated shot first; every other caller (the bean-select change handler, dial-in wizard, Coffee Library) keeps its original best-combo-first priority unchanged. Also: `quickClone()` now prefers the currently-viewed shot's own bean when one is already annotated, instead of always deriving the bean from the chronologically previous shot. Closes #389
- **P-Q curve was empty for GaggiMate pressure-profiled shots.** `lib/machines/gaggimate/history.js`'s `toGlpShot()` mapped `pumpFlow <- tf` (target flow) instead of `fl` (actual pump flow); on a pressure-profiled shot the device never sets a flow target, so `tf` is all zeros and the chart's `f[i] > 0` filter dropped every sample. Verified against a real payload from Max's GaggiMate dev simulator. Fixed to `pumpFlow <- fl`; `weightFlow` (GaggiMate has no scale-derived flow field) is left unset rather than deriving a noisy, redundant copy of `fl` from weight deltas. `lib/card.js`'s share-card stat computation is now null-safe for the resulting all-zero `weightFlow` array (previously would have thrown on `Math.max(...[])`/`avg([])`). Closes #388

## [2.2.6] – 2026-07-15

### Fixed
- **Mobile: machine switcher collapsed to an icon-only control.** On narrow viewports the topbar machine select rendered the full machine name, eating roughly a third of the mode bar and forcing the view tabs into scroll. Since the active machine's name is already shown in the subtitle line, the select now collapses to a centered chevron (~34px tap target) below 768px — native picker behavior unchanged, CSS-only. Closes #385

## [2.2.5] – 2026-07-15

Security-hardening round driven by the CodeQL code-scanning rollout: all 21 alerts from the first full scan are now resolved — 12 fixed in code, 4 scoped out (dev-wrapper directory excluded from analysis), 4 dismissed as false positives / accepted risk after per-alert call-path assessment (#377), 1 (lightbox XSS) already fixed in v2.2.4.

### Fixed
- **Type confusion in image upload validation (CodeQL critical).** `ImageService.saveUploadedImage()`'s buffer/content-type checks were buried in a compound guard chain that couldn't be statically proven to dominate later use; hoisted into standalone early-return type guards at the single choke point serving all three upload call sites (shot photo, bean image, grinder image). A follow-up hardened the remaining request-derived parameter CodeQL traced past the first fix. Closes #373
- **Polynomial ReDoS in custom Shopify-domain parsing (CodeQL high).** `routes/import.js` used a backtracking `.replace(/\/.*$/, '')` on user-provided domain strings; replaced with a linear `indexOf`/`slice` equivalent, verified byte-identical on legitimate inputs, with a pathological-input regression test. Part of #373
- **Prototype-pollution hardening (CodeQL medium ×4).** `routes/maintenance.js`'s `isValidTask()` now explicitly rejects `__proto__`/`constructor`/`prototype` ahead of its whitelist (the whitelist already made the flagged assignments unexploitable in practice — hardened so the guarantee is explicit and statically verifiable), and `profile-dialin-convergence.js`'s path-walking assignment refuses the same dangerous keys. Closes #371
- **SSRF defense-in-depth on machine adapters (CodeQL critical).** Both machine adapters' `baseUrlFor()` now re-validate the target host via `assertMachineHost()` at request time — closing a real gap where the default machine's host (seeded from add-on options at migration, bypassing the save-time check) and pre-v2.1.1 rows could carry never-validated values. The three remaining SSRF alerts were assessed as already-guarded or false positives (hardcoded supervisor URL; import/image allowlists) and dismissed with documented reasoning. Closes #377

### Added
- **Global API rate limiting.** New `express-rate-limit`-based app-level limiter (600 req/min per client, env-overridable, static assets exempt) as an outer backstop to the existing per-route limiter helper; 429 responses use the app's standard JSON error shape. Keyed off the raw socket address, consistent with the app's existing distrust of client-supplied forwarding headers. Closes #374
- **CodeQL scan scoping.** New `.github/codeql/codeql-config.yml` excludes the `gaggiuino-local-profiler-dev/` bootstrap wrapper (not shipped app code) from analysis. Part of #374

## [2.2.4] – 2026-07-14

### Fixed
- **Shot titles showed the raw synthetic multi-machine id** (e.g. "Shot 20000003") instead of a human-friendly number. Shots on non-default machines get a synthetic global id (`machineId * 10,000,000 + nativeId`) so ids never collide across machines — correct internally, but confusing to show when the machine name is already in the subtitle. `ShotRepository._hydrate()` now exposes a `nativeId` field (via the existing `toNativeShotId()` helper), used for display in the shot title, compare title, and sidebar list; the raw `id` is unchanged everywhere else (API calls, exports, dataset attributes). Closes #359
- **`lightbox.js` built its overlay via unescaped `innerHTML` string interpolation** — CodeQL (newly enabled this round) flagged this as a high-severity DOM XSS risk: a URL containing quote/angle-bracket characters could break out of the `src` attribute and inject arbitrary HTML/script. Current callers only ever pass a browser-normalized blob URL, but the function was unsafe by construction. Rebuilt via `createElement`/property assignment instead, which can never be parsed as HTML regardless of content. Closes #369

### Added
- **Sidebar shot thumbnail now opens full-size on click**, using the same reusable lightbox already used by the annotation panel's own photo, instead of just selecting that shot row. Closes #367

## [2.2.3] – 2026-07-14

### Fixed
- **GaggiMate shot duration displayed 100× too high (e.g. a ~28s shot showed as "2817s").** `lib/machines/gaggimate/history.js`'s `toGlpShot()` stored the `.slog` header's raw `durationMs` directly, but GLP's own convention is `shot.duration / 10 = seconds` (deciseconds). Now converts with `Math.round(durationMs / 100)`. Live-verified against a real GaggiMate test shot. Closes #344
- **GaggiMate shot profile name always showed "Unbekanntes Profil"/"Unknown Profile" even though the device correctly reported "Default".** Two compounding bugs: `history.js`'s `toGlpShot()` returned a snake_case `profile_name` field while the frontend only ever reads camelCase `shot.profileName`/`shot.profile?.name`; and separately `lib/repositories/ShotRepository.js`'s `_hydrate()` only ever returned the DB's `profile_name` column, never a `profileName` field, regardless of which name an adapter used when saving. Both fixed — `profileName` now flows correctly end to end. Closes #345
- **Shot detail subtitle always showed the default machine's hostname, regardless of which machine's shot was open.** `public-src/components/status.js`'s periodic status poll sets a single global `machineSubtitle` from `GET /api/status`'s `machineHostname` — correct for the default machine, but never updated for a differently-scoped shot. `public-src/views/shots/index.js`'s `updateView()` now looks up the viewed shot's own machine (via `S.machines`, same pattern as the sidebar's machine badge) and sets the subtitle accordingly, guarded against being clobbered by the next periodic poll tick (same "last call wins" pattern as #333). Closes #346
- **Machine switcher dropdown still visually stood out after v2.2.0's #337 fix.** The previous fix correctly stripped native `<select>` chrome, but kept a filled `--gray-800` background + border box at rest — the only boxed control in an otherwise fully flat topbar (`.mode-btn` tabs, `#btnSettings` gear are all transparent/borderless except on hover). Resting state is now transparent/borderless like its neighbors; background/border only appear on hover/focus. Closes #347
- **Sidebar shot thumbnail shifted text alignment between shots with and without a photo.** `.shot-thumb` was a flex sibling placed before `.shot-text`, so text started ~44px further right for shots with a photo than for shots without one. Thumbnail is now absolute-positioned (top-right) outside the flex flow, with `.shot-text` always reserving the same padding-right regardless of photo presence. Closes #348

### Changed
- Enabled Dependabot security updates (npm + github-actions, weekly) and added a CodeQL code scanning workflow (javascript-typescript) — both free for public repos, previously absent. Existing `test.yaml`/`build.yaml` CI is unchanged. Closes #349

## [2.2.2] – 2026-07-14

### Fixed
- **GaggiMate shot sync still failed after v2.2.1's WS fix — now with `Request failed with status code 404` instead of a timeout.** `lib/machines/gaggimate/adapter.js`'s `getShot()` built the per-shot history URL from the plain numeric shot id (e.g. `/api/history/2.slog`), but the real GaggiMate firmware requires the id zero-padded to 6 digits (`/api/history/000002.slog`) — the unpadded form 404s. `getLatestShotId()`'s `index.bin` URL was already correct and untouched. Live-verified against Max's real GaggiMate device: unpadded ids 404, zero-padded ids return the genuine `.slog` binary (`Content-Type: application/octet-stream`, `SHOT` magic). New regression test uses a mock HTTP server that only answers on the padded path, so a silent regression back to unpadded ids would fail CI, not just live hardware. `lib/machines/gaggimate/adapter.js`, `test/gaggimate-ws-client.test.js`. Closes #343

## [2.2.1] – 2026-07-14

### Fixed
- **GaggiMate profile fetches and profile CRUD always timed out against real hardware, even though the machine responded correctly and fast.** `lib/machines/gaggimate/ws-client.js`'s `request()` correlates responses to requests via a client-generated `rid`, sent as a JS number — but the real GaggiMate firmware echoes it back in the response frame as a string. The strict `!==` comparison between a number and a string never matches in JS, so every correct, near-instant response (`res:profiles:list` and friends) was silently discarded and the call hung for the full 8s timeout before failing with "Timed out waiting for ... from the machine". Live-verified against Max's real GaggiMate device: the raw response arrived and matched correctly within ~44ms once the comparison was made type-tolerant (`String(msg.rid) !== String(rid)`). This is also the likely cause of the v2.2.0-introduced multi-machine shot sync (#341) intermittently timing out for GaggiMate machines — repeated 8-second-long stuck WS connections to the same ESP32-class device plausibly starved concurrent HTTP shot-sync requests of a free connection slot. `lib/machines/gaggimate/ws-client.js`, `test/gaggimate-ws-client.test.js` (new regression test). Closes #342

## [2.2.0] – 2026-07-14

### Fixed
- **Multi-machine shot sync now actually runs for every registered machine, not just the default one.** Adding a second machine (e.g. GaggiMate) via Settings → Machines and passing its connection test never actually synced its shots — the sync/poll pipeline was 100% legacy and only ever talked to the default machine's `opts.machine_host`, even though the adapter/registry system already implemented `getLatestShotId()`/`getShot()` for every machine type. `lib/sync.js` now additionally loops over every other enabled registered machine via `getAdapter(machine)` and ingests their shots under the existing synthetic shot-id scheme, on top of the default machine's own `syncShots()` path (left untouched). Wired into `server.js`'s scheduler and `routes/system.js`'s manual `/api/sync`. Also fixes a scoping bug this change would otherwise have introduced: `shotService.getAll()` with no argument returns every machine's shots mixed together (by design, for the all-machines shots list view), so the default machine's own max-id lookup in `syncShots()`/`syncAfterBrew()` now stays explicitly scoped to machine 1 — otherwise it could pick up another machine's much larger synthetic id and think it's already caught up, silently stopping its own sync. Live status/brew-detection for non-default machines remains deferred (unchanged, already gated behind a visible "not available" banner rather than silently broken) — a documented follow-up, not a regression. `lib/sync.js`, `lib/services/ShotService.js`, `server.js`, `routes/system.js`. Closes #341
- **Bibliothek → Profile tab now shows the active machine's own Gaggiuino profiles**, not always the default machine's. `routes/system.js`'s profile routes (`GET /api/machine/profiles`, `POST /api/machine/profile/set`, CRUD `/api/machine/profile[/:id]`) exclusively used the legacy single-machine config and never consulted the multi-machine registry; they now accept an optional `machineId` (query param on GET, body field on POST/PUT/DELETE), resolve the target machine via the registry (default machine #1 if omitted, for backward compatibility), and call that machine's own adapter instead of the global legacy config. Write operations are gated by `adapter.capabilities().profileEdit` and degrade to a structured 501 for machines that don't support it (currently GaggiMate, intentionally) instead of crashing or silently touching the wrong machine. Switching the topbar machine dropdown now re-triggers the Profile tab's fetch immediately instead of only on page load. `routes/system.js`, `public-src/views/library-profile-editor.js`, `public-src/components/machines-settings.js`. Closes #340
- **Wartung (maintenance) — descaling/backflush/grouphead/gaskets are now scoped per machine.** The maintenance view had zero per-machine concept: switching the topbar machine dropdown to a second machine still showed the first machine's descaling/backflush/grouphead/gasket state and "shots since" counts, even for a machine that had never brewed a shot. The DB schema and `ShotRepository` already supported per-machine scoping (#317/#325); this threads `machineId` through the maintenance repository/service/routes/frontend for these four boiler/group-head-specific tasks, while keeping waterfilter and grinder tasks global since that equipment is genuinely shared across machines (new `isGlobalMaintenanceTask()` in `lib/constants.js`). `lib/constants.js`, `lib/repositories/LibraryRepository.js`, maintenance routes/service/frontend. Closes #338
- **Coffee library (beans/grinders) shown globally again, regardless of active machine.** Beans and grinders are shared consumables/equipment, not scoped to a single machine — the #334 display filter hid any bean/grinder with shot history on another machine, which emptied the library almost entirely as soon as a second (freshly added, 0-shot) machine was selected in the topbar. Removes the `_usedOnActiveMachine()` filter from `renderBeanList()`/`renderGrinderList()`, and drops the now-unused `lib_empty_beans_machine`/`lib_empty_grinders_machine` i18n keys from all 6 language files. Closes #339
- **Machine switcher dropdown restyled to match the dark theme.** Strips native `<select>` chrome (`appearance: none`), adds a custom SVG chevron arrow, and adds hover/focus states consistent with other bordered controls in the stylesheet, so the dropdown no longer renders as a plain unstyled OS-native select on top of the dark UI. `public-src/style.css`. Closes #337

## [2.1.1] – 2026-07-13

### Fixed
- **CRITICAL: could not add any machine with a real LAN host — the entire point of multi-machine mode has been broken since v2.0.0's release.** `POST /api/machines`/`PUT /api/machines/:id` validated the host with `assertPublicHost()` (`lib/ssrf-guard.js`), which blocks private/RFC1918 addresses — the correct threat model for the bean-import route it was originally built for (arbitrary, user-supplied external URLs), but exactly backwards for a machine host, which is the app owner's own trusted local-network configuration and is *expected* to be a private address (`10.x`, `192.168.x`, `gaggia.intern`, ...). Every attempt to add a second machine via Settings → Machines silently failed — `saveMachineForm()` (`public-src/components/machines-settings.js`) did nothing at all when the save request wasn't `ok`, so there was no visible error either. Only the default machine (seeded directly via `registry.createMachine()` at migration time, bypassing this route entirely) ever worked. Added a narrower `assertMachineHost()`/`isLoopbackOrMetadataAddress()` (blocks only loopback, link-local and the cloud-metadata address — not RFC1918 ranges) for machine hosts specifically; `assertPublicHost()`/`isPrivateAddress()` are unchanged for the import route's actual SSRF threat model. `saveMachineForm()` now also surfaces the actual server error to the user instead of failing silently. `lib/ssrf-guard.js`, `routes/machines.js`, `public-src/components/machines-settings.js`, `public-src/i18n/*.js` (all 6, new `settings_machine_save_error`), `test/ssrf-guard.test.js` (new), `test/machines-api.test.js` (existing test previously encoded the bug as "correct" behavior — corrected). Closes #336

## [2.1.0] – 2026-07-13

### Added
- **Per-machine shot count in Settings → Machines**, computed client-side from the already-loaded shot list (each shot carries `machineId`) — no backend change. `public-src/components/machines-settings.js`, `public-src/i18n/*.js` (all 6, new `settings_machine_shot_count`).
- **Coffee library now respects the topbar machine switcher.** With a specific machine selected (not "All machines"), the bean/grinder lists only show items actually used on that machine — a bean/grinder with shot history on *other* machines but none on the active one is hidden, but one with *no* shot history anywhere (e.g. freshly added) always stays visible. Pure client-side filter reusing the existing machine-scoped `S.shots` from #325 — no new data model, no per-bean/grinder machine assignment. `public-src/views/library.js`, `public-src/components/machines-settings.js`, `public-src/components/mode.js`, `public-src/i18n/*.js` (all 6, new `lib_empty_beans_machine`/`lib_empty_grinders_machine`). Closes #334

## [2.0.1] – 2026-07-13

### Fixed
- **Sidebar shot counter (flap digits) stuck at "0000" after upgrading to v2.0.0**, even though the header text next to it (`Shots (N)`) correctly showed the real count. Regression from #325: `loadData()` and `loadMachines()` both fire around startup with no fixed order, and `loadMachines()`'s first-run default-machine bootstrap calls `applyActiveMachineChange()`, which re-filters `S.shots` from a possibly-still-empty `S.allShots` and calls `renderSidebar()`. If that 0-count call happened first, `updateFlapCounter()`'s one-time deferred startup animation (350ms) got scheduled against it — and then fired *after* the real count had already been shown correctly, clobbering it back to zero. `updateFlapCounter()` now cancels a still-pending deferred flip when a later call arrives, so whichever call is genuinely last always wins, matching how the header text already behaved. `public-src/components/sidebar.js`. Closes #333

## [2.0.0] – 2026-07-13

### Added
- **Multi-machine core: GLP can now manage more than one espresso machine from a single add-on instance.** New SQLite `machines` table (name, type, host, switch entity, enabled) with an in-app registry API (`GET/POST /api/machines`, `PUT/DELETE /api/machines/:id`, `POST /api/machines/:id/test` reachability probe — host validated through the existing SSRF guard). On first start after upgrade, the legacy `machine_host`/`switch_entity` add-on options are automatically migrated into machine #1 ("Gaggiuino", marked as the default machine) — **no manual steps required**, and every existing endpoint that doesn't pass a `machine` parameter keeps behaving exactly as before, addressing the default machine. New adapter layer (`lib/machines/`) defines a common interface (`getStatus`, `getLatestShotId`, `getShot`, profile CRUD, `capabilities()`) that the existing Gaggiuino REST/WebSocket/protobuf code now implements as `lib/machines/gaggiuino/adapter.js`. Shots from additional machines get a synthetic id (`machineId × 10,000,000 + native id`) so two machines' shot histories can never collide — the default machine's shot ids are completely untouched. `GET /api/status` gained an additive `machines[]` array; all existing flat fields (`machineUrl`, `machineReachable`, ...) are unchanged. `lib/db.js`, `lib/machines/`, `routes/machines.js`, `lib/repositories/ShotRepository.js`, `lib/validation/schemas.js`, `openapi.yaml`, `test/machine-registry.test.js` (new), `test/machines-api.test.js` (new). Closes #317
- **GaggiMate adapter (experimental) — GLP can now also talk to [GaggiMate](https://github.com/jniebuhr/gaggimate) machines**, a different ESP32 controller with a JSON WebSocket API (`ws://<host>/ws`, `req:*`/`res:*`/`evt:status` framing) and binary shot-history files, instead of Gaggiuino's protobuf/REST protocol. Own client implementation written from GaggiMate's public protocol description — no code or assets vendored from the GaggiMate repository (GaggiMate is CC BY-NC-SA licensed, same project-boundary rule as Gaggiuino: interoperate as a client, never embed). `lib/machines/gaggimate/ws-client.js` implements the JSON request/response correlation plus a reconnecting live-status client; `lib/machines/gaggimate/history.js` is a from-scratch parser for `index.bin` (32-byte header + 128-byte entry records) and `.slog` shot files, covering **both header versions** — v4 (128-byte header) and v5 (512-byte header with up to 12 phase-transition records) — decoding every `fieldsMask` sample field (temperature/pressure/flow/weight/resistance, correctly scaled ×10/×100 per field) into GLP's canonical ×10-scaled datapoints shape; fields with no GLP equivalent (puck flow, volumetric flow, puck resistance) are kept in a documented `gaggimateExtra` side channel rather than silently dropped. Profile CRUD (`req:profiles:list/load/save/delete/select`) is implemented but exposed **read-only** in the UI in v2.0.0 (`capabilities().profileEdit === false`) — full profile editing for GaggiMate's own JSON profile shape is a later-release stretch goal. GaggiMate has no brew start/stop API at all (on any client, not just GLP), so `capabilities().brewStart` is always `false` for this machine type. **No GaggiMate hardware was available to verify against** — built strictly from the machine's own published WebSocket API spec and shot-history format; treat as experimental until confirmed against real hardware or GaggiMate's own official desktop simulator. `lib/machines/gaggimate/` (new), `test/gaggimate-ws-client.test.js` (new, mock JSON-WS server), `test/gaggimate-history.test.js` (new, hand-built v4/v5 `.slog` and `index.bin` fixtures). Closes #318
- **Settings → Machines: manage the multi-machine registry from the app UI.** New "Maschinen" card in Settings lists all configured machines (name, type badge, default badge), with add/edit/delete and a "Test connection" button per machine, backed by the `/api/machines` API from #317. `S.machines`/`S.activeMachineId` added to app state (persisted in `localStorage`) as groundwork for a future machine-scoped Live/Shots/Analytics view — not wired into those views yet in this release, Settings-based management only. `public-src/components/machines-settings.js` (new), `public-src/index.html`, `public-src/main.js`, `public-src/state.js`, `public-src/style.css`, `public-src/i18n/*.js` (all 6). Closes #319
- **Topbar machine switcher + per-view filtering (#325)** — completes the multi-machine frontend groundwork from #319. A new `<select>` in the topbar (`#machineSwitcher`), only shown once **more than one machine is registered**, lets you pick "All machines" or a specific one; the choice persists in `localStorage` (`glp_active_machine`, same pattern as other persisted `S` fields). Shots list, Analytics and the shot count/flap counter now scope to the selected machine: `S.allShots` holds the true unfiltered fetch, `S.shots` (what every existing view already reads) becomes the machine-filtered projection via the new `filterShotsByMachine()` (`state.js`), so no per-view rewrite was needed beyond re-deriving `S.shots` on switch. In "All machines" mode with more than one machine registered, each shot row gets a small machine-name badge; a machine-scoped list omits it (redundant there). Backend: `ShotRepository`'s hydrated shot objects now include `machineId` (previously internal-only via `getMachineId()`) so the frontend has something to filter/badge on. **Live view**: gated to the default machine only — additional machines have no real live-status polling loop yet (that's `lib/poll.js`/`lib/sync.js`'s multi-machine loop, a separate follow-up not built in this round); switching to a non-default, non-"all" machine while on the Live tab shows an explanatory banner instead of a fake/frozen live chart. `lib/repositories/ShotRepository.js`, `public-src/state.js`, `public-src/components/machines-settings.js`, `public-src/views/shots/index.js`, `public-src/components/sidebar.js`, `public-src/views/live.js`, `public-src/index.html`, `public-src/style.css`, `public-src/i18n/*.js` (all 6), `test/machine-registry.test.js`. Closes #325
- **`orders.machine_id` and `POST /api/orders`'s `machine` field are now actually wired through, not just tagged for display (#326)** — completes the order-side follow-up from #29's display-only `machine` field. `POST /api/orders` now resolves `machine` (a name/slug) into a real machine registry id via a new `resolveMachineId()`, stored as `order.machineId` (falls back to the default machine when unset or unmatched — never null). `OrderRepository.save()`/`saveAll()` now also persist `machine_id` on the SQL `orders` row (the column existed since #317's migration but was never written to) — kept on the existing #327 upsert-only path, not the destructive `DELETE FROM orders` pattern #327 removed. **Fulfillment routing**: `POST /api/orders/:id/complete` now links the latest shot on the *order's own target machine* (`ShotRepository.getLatestId(machineId)`, new optional param) instead of the global latest shot across all machines — unchanged behavior for any order with no `machineId` (pre-#326) or on a single-machine install. **Stats**: `GET /api/orders/stats` gained a `byMachine` breakdown (`[{machineId, machineName, count}]`, omitted entirely on a single-machine install — nothing useful to show) and an optional `?machine=<id>` filter; `GET /api/orders` and `GET /api/orders/queue-eta` also accept `?machine=<id>` now, so a queue backed up on one machine no longer distorts another machine's ETA estimate. `routes/orders.js`, `lib/repositories/ShotRepository.js`, `lib/repositories/OrderRepository.js`, `openapi.yaml`, `test/db-routes.test.js` (+9 tests). Closes #326

- **Automatic pre-migration backup for the multi-machine upgrade.** The first start after upgrading to v2.0.0 runs `migrateMachineColumns()` unattended against every existing install's real `/data/glp.db` — before it touches anything, a full snapshot of the DB file is now written to `/data/pre-v2-migration-<timestamp>.db` (idempotent: only fires once, when the migration is genuinely about to run for the first time, never again on later starts, never on a brand-new install with no DB file yet). The migration itself was already additive (`ALTER TABLE ... ADD COLUMN machine_id ... DEFAULT 1`, no `shots`/`orders` primary-key rebuild — only the tiny `maintenance` table gets a real table rebuild, in a transaction) — this backup is an extra safety net on top, not a fix for a known-unsafe migration. `lib/db.js`, `test/machine-registry.test.js` (+3 tests).
- **GaggiMate is now clearly marked experimental in the UI itself**, not just in `DOCS.md`/the README feature table: the machine-type dropdown in Settings → Machines shows "GaggiMate (experimental)", and any configured GaggiMate machine gets a "⚠ Experimental" badge in the machines list. `public-src/index.html`, `public-src/components/machines-settings.js`, `public-src/style.css`, `public-src/i18n/*.js` (all 6, new `settings_machine_type_gaggimate`/`settings_machine_experimental_badge` keys).

### Changed
- **Breaking (data model only, not the API): `MAX_SHOT_ID` raised from 100,000 to 99,999,999** to make room for the multi-machine synthetic shot id scheme above. Existing shot ids (all well under the old ceiling) are unaffected.

## [1.122.0] – 2026-07-13

### Changed
- **Annotation panel now prefills grinder/grind setting/dose from the selected bean's own history, not the literal last shot.** Since beans get varied often, "↩ Clone last" and manual bean selection used to carry over whatever grinder/grind setting the chronologically previous shot happened to use — usually the wrong bean's settings. New `suggestGrindDoseForBean()` reuses the same bean-aware memory the Guided Dial-In wizard already maintains (best-scoring historical grinder+grind combo for the bean, falling back to `bean.knownGrindSettings`, falling back to that bean's own last shot), extended with a dose fallback from the bean's last shot since neither existing memory source tracks dose. Fires both on manual bean selection (`#annCoffee` change) and inside "Clone last"; drink type/recipe still come from the literal last shot since those aren't bean-specific. `public-src/views/shots/grind.js`, `public-src/views/shots/annotation.js`, `public-src/main.js`, `test/suggest-grind-dose.test.js` (new). Closes #332

## [1.121.3] – 2026-07-13

### Fixed
- **Marking a maintenance task done (or resetting grinder burrs) could count shots pulled earlier the same day, before the action, as "since" it.** `POST /api/maintenance/:task/done` and `POST /api/library/grinder/:id/reset-burrs` stored only a day-granularity date (`new Date().toISOString().split('T')[0]`), so `computeMaintenanceStats()`/`computeGrinderWearStats()` compared shots against UTC-midnight of that day instead of the actual moment the action happened — e.g. replacing the water filter at noon after already pulling shots that morning showed those pre-swap shots as "since replacement" instead of 0. Now stores the full timestamp (`new Date().toISOString()`); affects all maintenance tasks (descaling, backflush, grouphead, gaskets, waterfilter, grinder cleaning) plus grinder burr-wear tracking, since they share this calculation. Manual date-picker fields (roast date, purchase date, backdated maintenance log entries) are unaffected — they're intentionally day-only. `routes/maintenance.js`, `routes/library.js`, `test/db-routes.test.js`, `test/grinder-wear.test.js` (new regression tests). Closes #331

## [1.121.2] – 2026-07-13

### Fixed
- **In-app add-on update button returned 403 Forbidden.** `POST /api/update` calls `http://supervisor/addons/self/update` using the add-on's Supervisor token, but `config.yaml` only granted `homeassistant_api: true` (Core API access) — Supervisor management endpoints like `/addons/self/update` need `hassio_api: true`, which was never set. This means the self-update path (triggered from the GLP integration's own `update` entity in Home Assistant) has been non-functional since it was introduced; the direct Supervisor "Update" path in the HA Add-on Store always worked fine since it doesn't route through the add-on's own token. `config.yaml`. Closes #330

## [1.121.1] – 2026-07-13

### Fixed
- **CRITICAL: `saveOrders()` permanently deleted order history older than 7 days on every order action.** `lib/data.js`'s `saveOrders(orders)` used to `DELETE FROM orders` then reinsert only its argument array; every call site (place/accept/complete/decline/history-delete) passed it `loadOrders()` — the 7-day-filtered active view — so any single order mutation wiped the entire `orders` table down to that filtered subset, permanently losing any done/declined order older than 7 days from the database itself, not just from a view. This is why #321's fix (adding `findAll()` for the stats endpoint) didn't actually raise the customer-statistics totals after release — the older rows were already gone by the time it ran. Now delegates to `OrderRepository.saveAll()` (upsert-only, never deletes rows absent from its argument); the two routes that intentionally delete orders (`DELETE /api/orders/:id`, `DELETE /api/orders/history`) now call `OrderRepository.delete()` directly instead of relying on `saveOrders`' old destructive side effect. **There is no known way to recover order data already lost before this fix** — check any earlier `/api/backup` export for an unaffected snapshot. `lib/data.js`, `routes/orders.js`, `test/db-routes.test.js` (new regression test). Closes #327
- **Guided Dial-In wizard's grinder select had no dark-theme styling** (rendered as a plain white native dropdown) — `.lib-form-field input` was dark-themed but there was no matching `.lib-form-field select` rule. `public-src/style.css`. Closes #328
- **Bean → profile suggestion: #323's "fix" to the Decline Flow phase was itself a regression.** #323 assumed a "declining finish" needed a numerically-declining flow target and changed `target.start` from 0 to the Ramp phase's flow ceiling. Comparing against Max's actual exported profiles ("Sertão Decaf", hardware-verified score-98 shots, and "Adaptive") showed both real profiles have `target.start: 0` on this phase — the "Decline" in the name refers to the shot's pressure trend (a PRESSURE-controlled Ramp phase hands off to this FLOW-controlled phase, letting pressure fall naturally), not this phase's own flow-target curve. Reverted `target.start` to 0. The same real-profile comparison also reverted two other speculative additions that don't match either real profile — the Bloom phase's `pressureBelow: 1.5` adaptive stop (both real profiles use a plain fixed-time bloom) and the Ramp phase's flow-ceiling `restriction` (neither real profile has one) — and surfaced two genuine, real-data-grounded refinements: Ramp phase duration now branches 4s (gentle, matches Sertão Decaf) / 5s (else, matches Adaptive), and Decline Flow's `target.end` now branches 1.6 (gentle) / 2.5 (else), the same way `rampPressure`/`waterTemperature` already did. `public-src/profile-suggestion.js`, `test/profile-suggestion.test.js`. Closes #329 (root-caused by #323)

## [1.121.0] – 2026-07-13

### Added
- **Guided Dial-In wizard: grinder field is now a select of your library grinders** instead of free text — preselects the prefilled/known grinder (`prefill.grinderName` or the bean's known-grind-setting grinder), with an "Other…" option that reveals a free-text fallback for a grinder not yet in the library. Falls back to the previous plain text input when the library has no grinders at all. `public-src/views/dialin-wizard.js`, `public-src/main.js`, `public-src/i18n/*.js` (all 6). Closes #322

### Added
- **`POST /api/orders` accepts an optional `machine` field** (display-only name/slug), so the [GLP Order Card](https://github.com/mxkissnr/glp-order-card) can tag an order with which machine it's for in multi-machine setups. Stored on the order and returned as-is; not yet scoped against the machine registry's numeric ids (that wiring is a follow-up once `orders.machine_id`, added by the #317 migration, is actually read by this route). Omitting `machine` behaves exactly as before (`null`). `routes/orders.js`, `test/db-routes.test.js`. Supports glp-order-card #29

### Documentation
- **Marked the bean → profile suggestion and the Guided Dial-In wizard as experimental / work in progress** — both are usable but not finished (suggestions are a starting point, not a guarantee). Added a visible callout to their sections in `DOCS.md` and `DOCS.de.md` (kept in sync) and marked both rows in the `README.md` feature table. Closes #324

### Fixed
- **Bean → profile suggestion generated a broken final phase.** The "Decline Flow" phase had `target: { end: 1.6, curve: 'LINEAR', time: 25000 }` with no `target.start`, so the linear curve started from 0 and the phase rendered/ran as an ASCENDING flow ramp (0 → 1.6 ml/s) — the opposite of a declining finish (a declining finish counteracts falling puck resistance in the shot's second half). `target.start` now starts at the Ramp phase's own flow ceiling (its `restriction`: 2.0 gentle / 3.0 otherwise), avoiding a flow step between phases. Also fixed `globalStopConditions.weight` hard-coding a 2.2× dose multiplier whenever `brewRatio` was set at all instead of using its actually-parsed value (`recipe.coffeeOut` right above it already did) — now `coffeeIn * (ratio || 2)` consistently. `public-src/profile-suggestion.js`, `test/profile-suggestion.test.js`. Closes #323
- **Order queue age showed raw minutes forever** (e.g. "Vor 3904 Min" for an order almost three days old). `_orderTimeAgo()` (`public-src/views/orders.js`) now tiers the display: minutes under an hour, hours under a day, days beyond that. New `orders_ago_hours`/`orders_ago_days` i18n keys in all 6 languages. `public-src/views/orders.js`, `public-src/i18n/*.js`. Closes #320
- **Customer statistics ("Kunden-Statistik") silently capped at the last 7 days** despite being labelled lifetime totals. `GET /api/orders/stats` read from `loadOrders()` → `OrderRepository.findActive()`, which filters *done* orders older than `ORDERS_HISTORY_TTL_MS` (7 days) — correct for the live order queue, wrong for stats. Added `OrderRepository.findAll()` (no age filter) and a `loadAllOrders()` shim, used only by the stats endpoint; the live queue (`findActive()`) is unchanged. `lib/repositories/OrderRepository.js`, `lib/data.js`, `routes/orders.js`, `test/db-routes.test.js` (new case: a 30-day-old done order is now counted). Closes #321

## [1.120.0] – 2026-07-12

### Added
- **`origins[]` (multi-origin blend data) exposed on `GET /api/orders/active-beans`.** Since v1.99.0, beans support blend origins via `bean.origins[]` (`{code, percent?}`), but `LibraryService.getActiveBeans()` only ever returned the derived single-string `origin`, so the Order Card had no way to render a blend's multiple countries. The mapped bean object now also carries `origins` — the bean's own `origins[]` when set, otherwise a single-entry array built from the legacy `origin` string, or `[]` if neither is set. The existing `origin` field is unchanged, so older Order Card versions keep working exactly as before. `lib/services/LibraryService.js`, `test/db-routes.test.js`. Closes #316

## [1.119.2] – 2026-07-12

### Security
- **Three low-risk fixes from the Round 5 security+architecture audit.** (1) The `/api/restore` route's 50MB JSON body parser was registered before the auth middleware, so an unauthenticated caller could force a full parse of a large payload before being rejected with 401 — the two `express.json()` registrations in `server.js` now run after auth (the auth middleware only reads headers/path, never the body, so this is behavior-neutral for authenticated requests). (2) `lib/middleware/error.js` returned `err.message` verbatim to the client on every error including 5xx, which could leak internal details (paths, DB errors); 5xx responses now return a generic "Internal server error" while the real message still goes to the server log — 4xx messages (validation errors) are unchanged. (3) `CLAUDE.md`'s repo-structure section still described the frontend as single-file inline HTML, stale since the Vite (`public-src/`) migration — corrected to reflect `public-src/`/`public/`/`lib/`/`routes/`. `test/error-handler.test.js` (new) and `test/server-middleware-order.test.js` (new) cover both fixes directly. Closes #315

## [1.119.1] – 2026-07-12

### Added
- **Profile editor: two missing protocol fields made editable — `target.volume` and phase-level `waterTemperature`.** Both were already fully supported by the protocol/backend (`transitionSchema`'s `volume`, `phaseSchema`'s `waterTemperature`) but had no UI. `target.volume` (ml) now sits alongside the existing target duration field; phase `waterTemperature` (°C) sits alongside `restriction` as a phase-top-level override, separate from the profile-wide water temperature. Both are optional numeric fields — a blank input round-trips to the field being absent (`undefined`), not `0`, matching their `z.number().optional()` schema. Intentionally not plotted on the preview chart: a volume-based stop can't be meaningfully drawn on the time axis without a known flow rate. `public-src/views/library-profile-editor.js`, `public-src/i18n/*.js` (all 6), `test/library-profile-editor.test.js`. Closes #314

## [1.119.0] – 2026-07-12

### Added
- **Profile Dial-In wizard — iteratively improve a machine profile using real trial shots.** Sibling to the existing Guided Dial-In (grind) wizard, same session/candidate-confirm architecture, but tunes a machine profile's phases instead of a grind setting. Opened via a new 🎯 button on any profile in the Profiles tab's list. Each round: confirm the trial shot (never silently auto-matched — same reasoning as the grind wizard, a shot can be pulled for a guest mid-session), see its score, and pick how it tasted (balanced/sour/bitter/watery/channeling). The pick maps to a single concrete phase adjustment via `public-src/profile-dialin-convergence.js`'s symptom table (sour → lengthen Preinfusion or raise Ramp pressure; bitter → lower temperature/Ramp pressure/Decline duration; watery → lower ratio or raise Decline flow restriction; channeling → lengthen/raise the Preinfusion threshold), grounded in the new `coffee-expert` skill. Exactly one adjustment per round, step size halves on direction reversal for the same field (binary-search philosophy, mirroring `dialin-convergence.js`). Accepting a round PUTs the updated profile straight back to the machine before the next round starts waiting — the machine is always in sync with the session, no separate save step. Converges on two consecutive "balanced" picks, two consecutive scores ≥80, or a 6-round safety valve. **v1 deliberately does not parse `shot.profile.phases`** as the tuning signal — that field's shape is unverified against real hardware (raw REST history payload, never read by any existing code) — the objective `calcShotScore` plus the manual taste pick are the only signals used. `public-src/profile-dialin-convergence.js` (new), `public-src/views/profile-dialin-wizard.js` (new), `test/profile-dialin-convergence.test.js` (new), `public-src/views/library-profile-editor.js`, `public-src/state.js`, `public-src/main.js`, `public-src/index.html`, `public-src/style.css`, `public-src/i18n/*.js` (all 6). Closes #313

## [1.118.2] – 2026-07-12

### Changed
- **Flavor wheel: reverted to highlighting only a bean's own matched flavors, muting the rest — the full-poster-always-colored redesign from v1.118.0 wasn't actually what was wanted once seen live.** Only a bean's tasting notes (plus their ancestor categories) now render at full SCA/WCR color with a label and a glowing border; everything else is muted 35% toward the modal background, same behavior as before v1.118.0. Kept the two genuine improvements from the full-poster attempt: depth 2/3 labels still use ECharts' native `rotate:'radial'` placement (reads better than the old off-wedge leader-line overlay) and stay white-on-dark-outline for contrast — both now only apply to the handful of lit nodes instead of ~100 nodes, so there's no label-density problem to manage. `public-src/components/flavor-wheel.js`.

## [1.118.1] – 2026-07-12

### Fixed
- **Profile editor preview chart: pressure→flow phase transitions no longer look like a value crash, plus a phase carry-over bug.** Two stacked issues in the live preview chart added with #307. (1) `renderProfilePreviewChart` plotted PRESSURE phases (bar) and FLOW phases (ml/s) as a single line on one Y-axis with no unit distinction — a transition like 7 bar → ~1.6 ml/s read as the value crashing to near-zero, when it's actually just a different physical unit. Now rendered as two separate datasets ("Druck (bar)" / "Fluss (ml/s)", with a legend), each null outside its own phase's time range so no false connecting line is drawn across the other unit's segment. (2) `_synthesizeSeries` defaulted a blank `target.start` to `0` unconditionally; it now carries over the previous phase's resolved `target.end` when both phases share the same type (PRESSURE/PRESSURE or FLOW/FLOW) — a phase-type change or the first phase still falls back to `0`, since there's no sensible carry-over across a unit change. `_synthesizeSeries` is now exported for testing. `public-src/views/library-profile-editor.js`, `public-src/i18n/*.js` (all 6), `test/library-profile-editor.test.js` (new). Closes #312

### Changed
- **`profile-suggestion.js`: two data-quality gaps closed against real official Gaggiuino community profiles**, found while auditing the official community profile set (Adaptive Dark/Light Roast, Blooming Espresso, and others). Max's fixed 4-phase skeleton (Preinfusion → Bloom → Ramp → Decline Flow) is unchanged — only two parameters real community profiles consistently set were added: the Bloom phase now stops on `pressureBelow: 1.5` (residual puck pressure relaxed) in addition to the existing `time: 5000` safety-net timeout, making it genuinely adaptive as its name already implied; the Ramp phase now sets `restriction: gentle ? 2 : 3` — the flow safety ceiling (channeling protection) on a PRESSURE phase, staged the same way official Dark/Light Roast community profiles stage it (tighter ceiling for gentler/darker-roast profiles), reusing the existing `gentle` (decaf/natural) branch. `public-src/profile-suggestion.js`, `test/profile-suggestion.test.js`. Closes #312

## [1.118.0] – 2026-07-12

### Changed
- **Flavor wheel redesigned to match the real SCA/WCR poster: every segment always full-color and labeled, bean's own flavors highlighted via glow instead of dimming the rest.** Previously only a bean's matched ("lit") flavors were shown at full saturation with a label — everything else was darkened toward the modal background with no label at all, the opposite of the printed poster's look. `toSunburstData()` now always fills every segment with its real SCA/WCR hex color (`public-src/sca-flavor-colors.js`, unchanged); lit segments are called out instead via a thicker white border plus a matching glow (`itemStyle.shadowBlur/shadowColor`). Depth-1 (top category) labels are always shown; depth 2/3 switched from a custom SVG leader-label overlay with angular collision-avoidance (`public-src/flavor-wheel-labels.js`, removed — deleted along with its test) back to ECharts' native `rotate:'radial'` per-wedge labels, always shown, matching the poster's spoke-following outer-ring text. The overlay approach couldn't fit ~100 simultaneous horizontal labels around the wheel's circumference regardless of tuning (74 leaf labels alone need far more linear space than the ring provides); radial per-wedge placement sidesteps the problem entirely since each label only competes for space within its own wedge's angle, and the series' `minAngle`/`hideOverlap` gracefully drop only the labels on wedges genuinely too thin to hold legible text. A few real SCA/WCR colors are themselves near-white (jasmine, papery — the color evokes the ingredient); those wedges now get a darker divider instead of the usual white one, since white-on-near-white made them look like they bled into their neighbors. All labels are now uniformly white with a dark text outline (`textBorderColor`/`textBorderWidth`) rather than switching between black/white per wedge, which read as visually inconsistent — the outline keeps text legible even on the near-white fills. `public-src/components/flavor-wheel.js`, `public-src/style.css`. Closes #311

## [1.117.0] – 2026-07-11

### Added
- **Guided Dial-In wizard — a step-by-step "set grind → pull shot → evaluate → next grind" loop.** The existing dial-in view only ever offered passive advice on shots already pulled; this adds an active wizard modal that walks through the whole dial-in cycle until the shot converges. New pure `calcNextGrindSuggestion(rounds)` / `isConverged(rounds)` (`public-src/dialin-convergence.js`, unit-tested) implement a 25–32s extraction-time target band (mid 28.5s) with a ±1s dead zone, and a binary-search step size that starts proportional to how far off the first shot is and halves whenever the direction flips (overshoot), floored at 0.3 (below most grinders' resolution); convergence is declared on two consecutive in-band shots, two consecutive scores ≥80 within 0.5 grind units of each other, or a 6-round safety valve when nothing converges. Reuses the existing passive-advice building blocks (`calcBestGrindCombosForBean`, `_parseGrindNum`, `_miniShotChart` from `public-src/views/shots/grind.js`) for the starting-grind suggestion and shot preview rather than duplicating them. New wizard opens from a button in the Dial-In view header and from a new 🎯 button on bean cards in the Coffee Library (`start-dialin-from-bean`); the session (`S.dialinSession`, mirrored to `localStorage.glp_dialin_session` so a reload doesn't lose progress) tracks rounds by real shot id only — annotation data (grinder/dose/grind setting) is written through the existing `POST api/shots/:id/annotate` flow, no parallel write path. New shots are never auto-matched to a round: when a shot newer than the round's start time appears, the wizard shows it as a candidate with explicit "This is my dial-in shot" / "Not this one, still waiting" buttons, since normal (non-dial-in) shots can be pulled mid-session for guests. Each round shows the score, a mini shot chart, and the next suggested grind with an accept / override / end-session choice; a converged or manually-ended session can save the winning grind as `bean.knownGrindSettings` via new `POST /api/library/bean/:id/known-grind` (`upsertKnownGrindSetting` in `LibraryService.js`, matched by grinder name case-insensitive, capped at 10 entries), which then feeds back into the starting-grind suggestion for the bean's next dial-in. `public-src/dialin-convergence.js` (new), `public-src/views/dialin-wizard.js` (new), `test/dialin-convergence.test.js` (new), `lib/services/LibraryService.js`, `routes/library.js`, `public-src/state.js`, `public-src/views/dialin.js`, `public-src/views/library.js`, `public-src/main.js`, `public-src/index.html`, `public-src/style.css`, `public-src/i18n/*.js` (all 6). Closes #310
- **Grinder burr wear tracking — shots and grams ground since the last burr swap.** Independent of the existing calendar/shot-count-based cleaning maintenance system (`computeMaintenanceStats`): burrs dull with cumulative throughput, not calendar time, so this tracks it separately. New `burrsResetAt` field on the grinder object (defaults to `purchaseDate` on creation, or unset for "since always"). New `computeGrinderWearStats(grinder)` in `LibraryService.js` filters shots by annotated grinder name (case-insensitive) and, when set, by timestamp after `burrsResetAt`, summing `annotation.dose`. `GET /api/library` now embeds `wear: {shotsSinceBurrs, gramsSinceBurrs}` on each grinder. New `POST /api/library/grinder/:id/reset-burrs` marks a burr swap as done today. The grinder card in the Coffee Library now shows "🔩 N shots · X g/kg since last burr swap" with a "Burrs replaced" reset button (confirm-gated). `lib/services/LibraryService.js`, `routes/library.js`, `public-src/views/library.js`, `public-src/main.js`, `public-src/style.css`, `public-src/i18n/*.js` (all 6), `test/grinder-wear.test.js` (new). Closes #308
- **Machine profile editor — full visual phase editor in the Coffee Library, built on #306's backend API.** New "Profiles" tab lists machine profiles (`GET /api/machine/profiles`) with edit/delete; a new profile-editor modal (`.profile-editor-modal`) lets you build a profile's name, water temperature, recipe (dose/yield/ratio) and phases (name, type FLOW/PRESSURE/MANUAL, target start/end/curve/time, restriction, stop conditions, skip) using the same DOM-as-state row editor as the existing recipe-step editor, with a live preview chart (Chart.js) synthesizing a time series from the phase curves. A new "🎛 Create profile" button on bean cards opens the editor pre-filled with a profile suggestion derived from the bean: Max's own "Sertao Decaf" 4-phase structure (adaptive preinfusion → bloom → linear pressure ramp → declining-flow finish) is reused as a fixed skeleton (`public-src/profile-suggestion.js`, pure + unit-tested), with only temperature/target pressure/preinfusion duration/ratio varying by bean (decaf/natural process get a gentler, longer preinfusion, lower ramp pressure and lower brew temperature — porous pucks channel easily under a fast high-pressure hit). "Send to machine" confirms before POST/PUT-ing the profile and surfaces failures via a toast instead of failing silently. New `profileSchema` (Zod) validates the profile shape server-side before it reaches the machine's WebSocket write path. Also fixes a dead bug: `#recipeFormProfile`'s `list="profileList"` datalist never existed, so its autocomplete silently did nothing — it's now populated from the loaded machine profiles. `public-src/profile-suggestion.js` (new), `public-src/views/library-profile-editor.js` (new), `public-src/views/library.js`, `public-src/index.html`, `public-src/style.css`, `public-src/main.js`, `public-src/state.js`, `lib/validation/schemas.js`, `routes/system.js`, `public-src/i18n/*.js` (all 6), `test/profile-suggestion.test.js` (new). Closes #307
- **Machine profile create/update/delete — backend API only, no GLP UI yet.** The machine has no REST endpoint for writing profiles, only reading/selecting; create/update/delete only work over the machine's own WebSocket (`ws://<host>/ws`) with binary Protobuf messages, reverse-engineered from the machine's own web UI bundle and verified live against a real machine (all four operations round-tripped correctly). New `lib/gaggiuino-proto.js` (message schema, verbatim field numbers), `lib/gaggiuino-ws-client.js` (WS client), routes `GET/POST/PUT/DELETE /api/machine/profile[/:id]`. This is the backend layer only — no way yet to create/edit profiles from the GLP UI itself, that's a follow-up round. `lib/gaggiuino-proto.js` (new), `lib/gaggiuino-ws-client.js` (new), `routes/system.js`, `test/gaggiuino-ws-client.test.js` (new), `openapi.yaml`. Closes #306

### Fixed
- **Milk stock never deducted when assigning a drink to a shot annotation.** Two stacked bugs in the annotation-panel deduction path (added in #142): (1) `annotationSchema`'s `milkType` field required a `string`, but the frontend always sent it as `parseInt(...)` (milk ids are numeric) — every annotate call with a milk selected was rejected with a 400, silently breaking both the save and the deduction nested inside its success handler, even via the explicit "Speichern" button. (2) The debounced auto-save fired by every pill click never included `milkType` in its payload and never ran the deduction logic at all — since auto-save overwrites the full annotation row, relying on it (the primary interaction path) silently dropped the picked milk type and skipped the deduction entirely. Extracted a shared `_maybeDeductMilk()` gated on `drinkType` **or** `milkType` changing (not just `milkType`, which never re-fired on a new drink with the same milk) used by both save paths; `scheduleAutoSave()`'s payload now also carries `milkType` and `recipeId`. Verified end-to-end with a throwaway server + Playwright-driven annotation panel. `lib/validation/schemas.js`, `public-src/views/shots/annotation.js`, `test/milk-deduct-gate.test.js` (new). Closes #309

## [1.113.5] – 2026-07-10

### Fixed
- **Mobile: shot score now pinned top-right, export buttons left-aligned with the title.** Follow-up to #301's mobile header overlap fix. The score badge sat inline before the export buttons, pushing the button row's start position around depending on wrap; it's now absolutely positioned top-right of `.sprofiler-header`, and the button row starts its own line, flush-left with the title/subtitle above it. `public-src/style.css`. Closes #305

## [1.113.4] – 2026-07-10

### Added
- **Flavor wheel: leader-line-style labels for depth 2/3, fixing label collisions on multi-flavor beans.** Depth 2/3 (mid/outer ring) labels used to render radially rotated inside their own wedge (`label.rotate: 'radial'`, `show: !!lit`); when a bean had several simultaneously matched neighboring flavors (parent+child, siblings under the same subcategory, or 3+ at once) their in-wedge text collided, and which flavors collided was unpredictable per bean since only lit nodes get labels at all. Native depth 2/3 labels are now suppressed (`show:false`; depth 1's 9 top categories are untouched — wide wedges that practically never collide) in favor of a transparent SVG overlay drawn directly over the ECharts canvas. New `layoutLeaderLabels()` (`public-src/flavor-wheel-labels.js`, pure and unit-tested) does generic collision avoidance so it works for any combination of active flavors, not just specific known-colliding pairs. Wedge geometry for the overlay is read straight from ECharts' actual computed sunburst layout, so label positions always match the real rendered wedges, including after zooming into a branch. `public-src/flavor-wheel-labels.js` (new), `public-src/components/flavor-wheel.js`, `public-src/style.css`, `test/flavor-wheel-labels.test.js` (new). Closes #299
- **Flavor wheel: angular label distribution + horizontal depth-1 labels.** (1) The collision-avoidance layout no longer splits labels into a fixed left/right hemisphere and stacks them into a column — when a bean's active flavors clustered in one quadrant, every label piled into a single column while the rest of the circle stayed empty. It's now a circular relaxation: each label claims an angular half-width and, on collision, is nudged sideways along the arc away from its neighbor (with wraparound at ±π), so labels spread around whatever arc they actually cluster in. (2) Depth-1 category labels ("Süß", "Nussig / Kakao", etc.) turned out to still be tangentially rotated by ECharts' sunburst default — unreadable for longer names on wedges away from 12/6 o'clock. `levels[1]` now sets `label:{rotate:0, overflow:'break', width:64}` — labels are always horizontal and long names wrap onto a second line. `public-src/flavor-wheel-labels.js`, `public-src/components/flavor-wheel.js`, `test/flavor-wheel-labels.test.js`. Closes #302

### Changed
- **Flavor wheel: replaced leader-line connectors with color-swatch labels, matching the real SCA/WCR poster.** The real poster has no connector lines at all — label-to-segment association there is purely by color: a small colored square sits directly before each label's text. `renderLeaderOverlay()` no longer draws a leader line or anchor dot; instead a small colored swatch (filled with the segment's own color) sits directly before each label's text, moving together with it to the position computed by the (unchanged) angle-based collision layout. `public-src/components/flavor-wheel.js`. Closes #303

## [1.112.0] – 2026-07-10

### Added
- **Installable PWA, rebuilt with server-side Ingress gating.** PWA support (manifest + service worker for "Add to Home Screen" / standalone install) was removed entirely in v1.102.1 after the v1.102.0 service worker broke the live shot graph in the HA Companion App, which loads GLP through HA Ingress inside an embedded WebView. This version adds it back with a structural fix instead of relying on client-side detection: `server.js` already reliably tells genuine Ingress requests apart from direct/LAN requests (Supervisor-internal IP + `X-Ingress-Path` header, the same check the API-token auth bypass uses); a new `isIngressRequest()` helper and an `index.html`-serving route (ahead of `express.static`) now use it to inject `<link rel="manifest">` only for non-Ingress requests. `main.js` only calls `navigator.serviceWorker.register()` when that manifest link is actually present in the page, so the Companion App's WebView — which never receives the link — never registers the service worker at all; the bug class that broke production last time cannot recur through this path. The service worker itself (`public-src/public/sw.js`) is deliberately minimal: it caches only the app shell (the document + built `/assets/` bundles), network-first with cache fallback so updates always win when online, and returns immediately without touching the cache for anything under `/api/` — the exact request pattern (`/api/system/status` polling for the live view) the old SW's interception is suspected to have broken. New `test/pwa-gating.test.js` boots the real server against a throwaway data dir and issues genuine HTTP requests (not mocked req/res) to prove the gating end-to-end. `server.js`, `public-src/main.js`, `public-src/public/manifest.json` (new), `public-src/public/sw.js` (new), `test/pwa-gating.test.js` (new). Verified via automated integration tests and a real headless-browser (Playwright) session against the live server, confirming the gating logic end-to-end — but **not yet manually confirmed against a real Home Assistant Companion App session**, since no real Supervisor/Ingress proxy is available outside production. If the live shot graph misbehaves in the Companion App after updating, please open an issue immediately. Closes #297

### Fixed
- **Flavor wheel: overlapping depth-1 labels when two adjacent top categories were both lit.** When two neighboring categories were lit at once — e.g. a bean with flavors from both "Süß" and "Nussig / Kakao" — the wrapped two-line text of one could visibly overlap the other's, since ECharts' global `hideOverlap` doesn't reliably catch collisions introduced by `overflow:'break'` line-wrapping. Reduced depth-1 label font size from 13 to 11 — verified via Playwright against the real rendered canvas (measuring each label's actual on-screen bounding box) across 2, 4, and all 9 simultaneously-lit top categories: no overlap in any case. `public-src/components/flavor-wheel.js`. Closes #304
- **Mobile: large empty-looking area between the tab bar and the shot header.** The shot header's title block used `flex:1;min-width:0`, which let it shrink almost to nothing instead of ever wrapping onto its own row — on narrow (~390px) viewports the title/subtitle text got squeezed into a ~60px-wide sliver and visually overlapped the score badge and export buttons, reading as a big empty dark gap directly under the tab bar. The mobile media query now forces both header children to `flex: 1 1 100% !important`, so the title always gets the full row width and the score/buttons row wraps cleanly onto its own line below it. `public-src/style.css`. Closes #301
- **README incorrectly described Gaggiuino as open-source.** Removed the incorrect claim; Gaggiuino is not open source as of 2026-07-10. `README.md`. Closes #300

## [1.111.2] – 2026-07-10

### Fixed
- **Newest shot didn't appear without a manual reload if you weren't on the Shots tab.** `loadData()` (`public-src/views/shots/index.js`) was only triggered on initial page load, a manual sync click, shot deletion, and — only when the Live view had been open — 4s after brew end (`views/live.js`). The global 30s status poller (`updateStatus`, `public-src/components/status.js`) only refreshed the status dot/banner/power button, never the shot list, so a shot finished while on the Library or Analytics tab stayed invisible until a manual page reload. `updateStatus()` now tracks the server-reported shot count (`/api/status` → `shotCount`) across polls and calls `window.loadData()` whenever it increases, regardless of the active tab. `public-src/components/status.js`. Closes #296
- **"Imported from X" bean-library text wasn't a clickable link to the source.** Each imported bean's `lib_imported_from` line (`public-src/views/library.js`) rendered the domain as plain text even though the bean already carries a `sourceUrl` field captured during URL import. The domain now links to `bean.sourceUrl` (new tab, `rel="noopener"`) when present, falling back to plain text otherwise. `public-src/views/library.js`. Closes #296

## [1.111.0] – 2026-07-10

### Added
- **Flavor wheel: real SCA/WCR poster colors + colored outer-ring labels.** The flavor wheel sunburst (`public-src/components/flavor-wheel.js`) previously computed segment fills procedurally (`hslFor`: evenly-spaced pastel hues per top-level category), which didn't resemble the real SCA/WCR Coffee Taster's Flavor Wheel (2016) artwork the taxonomy is already modeled after. New `public-src/sca-flavor-colors.js` maps all 111 `FLAVOR_WHEEL` node ids to their real hand-picked hex colors (105 matched directly by English label against the MIT-licensed `hc-oss/coffee-flavor-wheel` color dataset; the 6 nodes that are our own extensions beyond the strict official wheel — apricot, stone_fruit, mandarin, lemonade, hay_straw, meaty_brothy — fall back to their resolved parent color). Matched segments now render their true color; unmatched segments are blended toward the modal background (new `muteHex()` in `flavor-match.js`) instead of the old flat-desaturated gray, so the full wheel still hints at its real hues. The outermost (depth-3) ring's labels now sit outside their wedge in text colored to match it — mirroring the real paper poster — lightened via a new `labelHexFor()` helper when the real color is too dark to read against the dark modal background (e.g. blackberry, molasses); depth 1-2 labels keep their existing white/near-black on-wedge styling. `hslFor` and the now-unused per-category `hue` field (`flavor-data.js`) were removed as dead code. `public-src/sca-flavor-colors.js` (new), `public-src/flavor-match.js`, `public-src/flavor-data.js`, `public-src/components/flavor-wheel.js`, `test/flavor-match.test.js`. Closes #293

## [1.110.0] – 2026-07-09

### Added
- **Manual enable/disable toggle for beans in the Coffee Library, independent of stock.** Previously a bean's "active" status for the order card's bean picker was purely stock-derived (`getActiveBeans()`, `lib/services/LibraryService.js`, filtered by remaining stock only) — there was no way to keep a bean in stock but temporarily exclude it from ordering without deleting it. A new `bean.enabled` boolean field defaults to enabled when absent (backward compatible with every pre-existing bean — checked via `!== false`, never `=== true`); a new `POST /api/library/bean/:id/toggle-active` route flips it. In the Coffee Library, each bean card gets a new eye/eye-off toggle button (next to edit/delete) — disabling a bean dims the card and adds a "Deaktiviert"/"Disabled" badge, while the bean stays fully visible and editable; only its presence in `/api/orders/active-beans` changes. `getBeansInfo()` (used by the Lovelace Shot Card to describe beans referenced by past shots) is deliberately **not** gated by `enabled` — it's a lookup, not an "offer for selection" list. `lib/sanitize-bean.js`, `lib/services/LibraryService.js`, `routes/library.js`, `public-src/views/library.js`, `public-src/main.js`, `public-src/style.css`, `public-src/i18n/{de,en,it,fr,es,nl}.js`. Closes #292
- **Coffee species field, separated from Varietät/cultivar.** The Coffee Library's "Varietät" field previously mixed botanical species (Arabica, Robusta, Blend) into the same free-text list as actual cultivars (Bourbon, Geisha, Typica, Caturra, SL28, ...) — but e.g. Red Bourbon is also an Arabica, so the two concepts aren't equivalent. A new "Spezies" field is a constrained `<select>` (unset / Arabica / Robusta / Liberica / Blend), placed next to Varietät in the bean form and shown on the bean card, following the same pattern as the existing Röstung (`roastType`) dropdown. `VARIETY_SUGGESTIONS` (`public-src/constants.js`) is now a pure cultivar list — Arabica/Robusta/Blend removed. Manual-entry only, like roast type — no import parser extracts species separately. A one-shot idempotent boot migration (`migrateVarietyToSpecies()`, `lib/services/LibraryService.js`) moves existing beans whose `variety` exactly matches (case-insensitively) "arabica", "robusta", or "blend" into the new `species` field and clears `variety`; anything else (e.g. "Red Bourbon", "Heirloom") is left untouched. `public-src/constants.js`, `public-src/index.html`, `public-src/views/library.js`, `lib/sanitize-bean.js`, `lib/services/LibraryService.js`, `routes/library.js`, `lib/validation/schemas.js`, `server.js`, `public-src/i18n/{de,en,it,fr,es,nl}.js`. Closes #291

### Fixed
- **Coffee World Map: horizontal lines cutting across the whole map, from countries whose 110m outline crosses the antimeridian.** Russia's Arctic archipelago ring and Fiji's ring each wrap from ~180°E to ~180°W; `topojson.feature()`'s conversion doesn't cut rings at the date line, so the two far-apart points ended up connected by a straight line spanning the full map width. `buildWorldMap()` (`public-src/views/analytics.js`) now runs every feature's geometry through `splitAntimeridianRing()` before registering the map: rings with an interior seam crossing (Russia, Fiji) are split into separate polygons, each closed independently; a ring whose *own* closing edge crosses the seam (a circumpolar coastline like Antarctica's, which sweeps through every longitude) is closed by routing along the map border via the nearest pole instead of cutting straight across. New `test/world-map-antimeridian.test.js`. Known minor residual: a ring with more than two seam crossings (e.g. Russia's Far East near Chukotka) can still show a faint diagonal artifact confined to that corner — full general-purpose antimeridian polygon clipping wasn't in scope for this rendering-quality fix. Closes #290

## [1.109.0] – 2026-07-08

### Added
- **Generic bean-import fallback improvements: roaster/price from OpenGraph, body-text scan, duplicate-import warning.** `parseOpenGraph()` (`lib/import-generic.js`), the last-resort tier of the 3-tier generic import fallback for shops not in the built-in provider registry, now reads `og:site_name` as a roaster fallback and `og:price:amount`/`product:price:amount` into `price_eur` (mirroring `parseJsonLd()`'s `offers.price` handling). When the `og:description` text is thin (under 80 characters, or yields neither an origin nor a flavor hit on its own), it now also scans the visible page body — preferring a `<main>`/`<article>` container when present, capped at 5000 characters — for origin/flavor keywords, merging any newly-found hits with (never discarding) what the meta-only pass already found. Separately, importing a URL now checks the parsed bean against the existing library (`findDuplicateBean()`) for an exact source-URL match or a case-insensitive name+roaster match, surfacing a non-blocking "⚠ May already be in your library: …" warning next to the existing "please double-check" import-method hint — the user can still proceed (e.g. a new bag of the same bean). Beans now optionally carry a `sourceUrl` field (set on import, editable nowhere else) to make the URL-based check possible. `lib/import-generic.js`, `lib/sanitize-bean.js`, `routes/import.js`, `routes/library.js`, `public-src/views/library.js`, `public-src/state.js`, `public-src/index.html`, `public-src/style.css`, `public-src/i18n/{de,en,it,fr,es,nl}.js`. Closes #289
- **Click-to-enlarge shot photo; shot photo on the share card.** The round shot-photo thumbnail in the annotation panel now opens a fullscreen lightbox on click (new reusable `public-src/components/lightbox.js`: dark overlay, image scaled to fit via `object-fit: contain`, closeable via backdrop click, close button, or Escape) — wired to `#annPhotoThumb`, reusing the already-cached blob URL so the image isn't fetched twice. Separately, `generateShareCard()` (`lib/card.js`) now renders the shot photo — when present — as a small circular avatar in the hero section, positioned left of the origin stamp chip and bean headline (photo → origin chip → bean name), loaded the same defensive way as the GLP logo so a missing/corrupt file never breaks card generation; omitting a photo renders identically to before, with no reserved dead space. `public-src/components/lightbox.js`, `public-src/views/shots/annotation.js`, `public-src/main.js`, `public-src/style.css`, `public-src/i18n/{de,en,it,fr,es,nl}.js`, `lib/card.js`. Closes #287

### Fixed
- **Machine-unreachable banner could stay stuck visible even with a full shot history.** The v1.107.0 fix required `S.shots.length === 0` for the banner to show, but two issues let it get stuck showing anyway: (1) in `public-src/main.js`'s init sequence, `loadData()` (which populates `S.shots`) wasn't awaited before the first `updateStatus()` call, so on page load the banner could be shown before shots finished loading, with correction only happening on the next 30s poll; (2) `updateStatus()` (`public-src/components/status.js`) wrapped its whole body in one `try { ... } catch (e) {}`, with `updateMachineBanner()`/`updateOnboardingPanel()` called near the end — an exception anywhere earlier in the function (a missing DOM element, a malformed response) silently skipped those calls on every single poll, so a recurring error left the banner stuck indefinitely even though `S.shots` was correctly populated. Fixed by awaiting `loadData()` before the first `updateStatus()` call, moving `updateMachineBanner()`/`updateOnboardingPanel()` to run immediately after the status response is parsed (before the more fragile DOM code that follows), and having `loadData()` (`public-src/views/shots/index.js`) re-evaluate the banner itself (`updateMachineBanner()` now accepts no argument and reuses the last known `S.machineReachable`) as soon as shots finish loading, instead of waiting up to 30s for the next poll. Closes #288

## [1.108.0] – 2026-07-08

### Fixed
- **Photo upload UX: zoom/pan crop editor, custom file-picker button, oval thumbnail on mobile.** The shot/bean/grinder photo upload flow had three issues reported after the previous round: (1) the round thumbnail auto-cropped via `object-fit: cover` with no user control over which part of the photo shows — a new reusable crop editor (`public-src/components/image-crop.js`, vanilla JS + `<canvas>`, no new dependency) opens on file selection with zoom (range slider, mouse wheel, pinch) and drag-to-pan (Pointer Events, mouse + touch), a live circular or rounded-square guide matching the destination thumbnail shape, and Apply/Cancel; Apply exports a 480×480 JPEG blob that feeds into the existing upload endpoints unchanged. (2) The native `<input type="file">` rendered the browser's default button in all three upload spots — replaced with a hidden input triggered by an app-styled `.lib-open-btn` button (`#annPhotoPickBtn`, `#beanFormImagePickBtn`, `#grinderFormImagePickBtn`). (3) `.shot-photo-thumb` was missing `flex-shrink: 0`, so on narrow flex rows it rendered as an oval instead of a circle — fixed to match `.shot-thumb`/`.lib-bean-thumb`/`.lib-grinder-thumb`, which already had it. `public-src/index.html`, `public-src/main.js`, `public-src/views/shots/annotation.js`, `public-src/views/library.js`, `public-src/style.css`. Closes #286

## [1.107.0] – 2026-07-08

### Added
- **Batch/lot number per coffee bag.** Roasters assign a batch/lot number ("Chargennummer") per production run, which can differ between bags of the same bean bought at different times — so it's tracked on the bag object (`bean.bags[].batchNumber`), not on the bean itself. Editable in the bean form (synced to the currently active bag, same as roast date/stock) and in the "+ New bag" form when logging a new delivery; shown in the bag history list and, for the active bag, alongside the bean's other extra details. Manual-entry only — the Hoplo import parser doesn't expose a batch/lot number, so there's no import wiring. `routes/library.js`, `public-src/views/library.js`, `public-src/index.html`. Closes #285

### Fixed
- **Machine-unreachable banner no longer shows for established users when the machine is simply powered off.** The persistent top banner in `updateMachineBanner()` (`public-src/components/onboarding.js`) triggered on `status.machineReachable === false` alone, so it fired on every failed live-poll — including the normal case of turning the espresso machine off between brews — showing a "first-run setup" banner to users with months of shot history. Now requires `S.shots.length === 0` as well, matching the condition the first-run onboarding panel already used, so the banner only appears for a genuine first-run/misconfigured state (shot history is persisted in SQLite and survives restarts, so an empty count reliably means "never successfully set up"). Closes #284
- **Coffee World Map: shot-count gradient replaced with flat presence fill; overlapping point labels now auto-hide.** Country fill previously used a `visualMap`-driven gradient keyed on shot count (`value: Math.max(d.shots, maxShots * 0.15)`), which read as an intensity scale rather than a simple "coffee comes from here" indicator. Countries with any origin data now get a flat `--accent-to` fill (`value: 1`, `itemStyle.areaColor` on the `map` series); the `visualMap` legend is removed. The tooltip (shot count, bean list) is unchanged. Also added `labelLayout: { hideOverlap: true }` to the `effectScatter` series so bean labels for closely clustered origins (e.g. multiple Brazilian beans near São Paulo) no longer stack into garbled overlapping text. `public-src/views/analytics.js`. Closes #283

## [1.106.0] – 2026-07-08

### Added
- **Best grinder+grind-setting combo per bean in the Coffee Library.** Each bean card now shows, when there's enough data, which grinder + grind setting produced its best-scoring shots (e.g. "Best combo: Niche Zero @ 18 · Ø score 92"). `calcBestGrindCombosForBean(beanName, allShots)` in `public-src/views/shots/grind.js` generalizes the existing single-shot `calcComparativeGrindAdvice` comparison logic to aggregate a bean's entire shot history, grouping by (grinder, grind setting rounded to the nearest 0.5) and averaging `calcShotScore` per group; a group needs at least 3 shots to be shown (fewer makes the average too noisy to trust), and only the single best combo is surfaced per bean to keep the card uncluttered. Rendered in `public-src/views/library.js`. Closes #281
- **Attach a photo to a shot.** Each shot can now have a photo (e.g. the cup/crema) uploaded from the shot detail view — shown as a small circular thumbnail in the sidebar shot list and a larger one above the upload control in the annotation panel, plus a remove button. Backend mirrors the existing bean/grinder photo upload pattern: `POST`/`GET`/`DELETE /api/shots/:id/image`, storing the file via `ImageService.saveUploadedImage('shot-', ...)` under the shared `BEAN_IMAGE_DIR` (the `'shot-'` prefix keeps it from colliding with bean/grinder images of the same numeric id) and the extension inside the shot's existing JSON `data` blob — no schema migration needed. `routes/shots.js`, `lib/repositories/ShotRepository.js` (`setImage`/`clearImage`), `public-src/components/sidebar.js`, `public-src/views/shots/annotation.js`, `public-src/bean-image.js`. Closes #279

### Changed
- **Share card redesign.** The Instagram share card (`lib/card.js`) used a generic black/white theme unrelated to the app's own look, forced weight (~20-50g) and temperature (~90-96°C) onto one shared 0-100 axis so the weight line barely used a third of the chart height, and stretched the shot graph to fill the full 9:16 Story format, distorting it. Now: bean name is the headline (not the near-identical profile name), with a small origin-country stamp when resolvable, a score-tier contextual phrase ("Herausragender Shot" / "Solider Shot" / …), and a star rating row; weight and temperature each get their own axis scale; the shot graph stays roughly square even in Story format, with the freed-up space centered as breathing room instead of stretching or leaving a single dead gap; palette, chip styling (origin stamp, legend, "Made with GLP" footer pill) and the score badge's progress ring now match the app's own dark/amber theme (`public-src/style.css` tokens) instead of a separate brand, with no drop-shadow/glow anywhere. Closes #282
- **Coffee World Map visual redesign.** The Analytics world map used a generic green instead of the app's amber/orange accent, always framed the entire globe even when bean data was clustered in a couple of regions, hid the shot-count color legend, and only showed bean info on hover. Now reads `--accent-from`/`--accent-to` live via `getComputedStyle` for scatter points and the choropleth gradient (so it follows whichever theme/accent color is active), shows the `visualMap` legend styled for the dark UI, auto-frames the initial camera on a bounding box computed from the countries/points that actually have data (`computeMapBoundingView()`, capped so a single country doesn't zoom in absurdly far; `roam: true` still lets you pan/zoom manually afterward), always-visible labels on scatter points that have at least one shot logged, and a darker map background so land reads more clearly against ocean. `public-src/views/analytics.js`. Closes #278

## [1.105.0] – 2026-07-07

### Added
- **First-run onboarding and demo mode.** New users whose Gaggiuino controller isn't reachable at `machine_host` now see a dismissible banner naming the configured host, plus (when the database has no shots yet) a first-run onboarding panel in the Shots view with setup steps and a **"Load demo data"** button. Demo mode seeds a static sample dataset (~12 shots with plausible curves and ratings, 3 sample beans including a blend using `origins[]`, 1 recipe) via `POST /api/demo/seed` (refused unless the database is empty), so Shots/Analytics/flavor-wheel views can be evaluated before connecting real hardware. A "Demo mode" badge with an "End demo" button (`POST /api/demo/end`) removes exactly the seeded rows, tracked via the existing `kv` table (no schema migration needed). Backend: `lib/demo-seed.js` (pure dataset module), `lib/services/DemoService.js`. `lib/state.js` gained `machineReachable`/`lastMachineError`/`lastMachineSuccess`, set on every real HTTP call to the machine (`lib/sync.js`, `lib/poll.js`); `machineReachable` and timestamps are exposed unauthenticated on `/api/status`, `lastMachineError` stays in the existing authenticated-only `sensitive` block alongside `machineHostname`. The add-on's default `machine_host` changed from `gaggia.intern` to the more neutral `gaggiuino.local`. Closes #274
- **Bean import now works with any shop, not just 3 hardcoded German roasters.** The old `routes/import.js` if/else host chain (kaffeebraun.com, hoppenworth-ploch.de, elbgold.com) is now a provider registry (`lib/import-providers.js`); a new settings panel in the Library view (gear icon next to "🔗 URL") lets you disable individual built-ins and add your own Shopify shop domains, persisted via the `kv` table (`lib/repositories/ImportSettingsRepository.js`). For any shop not in the registry, a generic fallback chain now runs automatically: (1) guess the Shopify product-JSON endpoint (`<url>/products/<handle>.js`) that every Shopify storefront exposes, reusing the existing variant/price extraction; (2) parse `<script type="application/ld+json">` `Product` markup; (3) fall back to `og:title`/`og:image`/`og:description` meta tags, running the existing flavor-keyword and origin-country extraction on the combined text. `lib/import-generic.js` holds the 3 fallback parsers. The import result now shows which method produced the data, with a hint to double-check fields for anything other than a built-in parser. SSRF hardening (`lib/ssrf-guard.js`) got stricter to match: the route is now https-only, and every fetch — including each redirect hop, since arbitrary hostnames are now fetched instead of 3 known ones — resolves the hostname and rejects private/loopback/link-local/CGNAT address ranges before connecting. Closes #275
- **API Token setting in Settings view.** Already-authenticated sessions now see the app's API token under Settings → API Token, with a copy-to-clipboard button — needed to configure `glp_token` for the Order Card in direct-URL mode now that `/api/token` no longer hands the token to unauthenticated LAN callers (see Fixed below). Closes #276

### Fixed
- **`/api/token` trusted any RFC1918 address, handing the full API token (including `/api/restore` access) to any device on the LAN or Docker bridge with zero authentication.** `isPrivateIp()` matched all of `10.0.0.0/8`, `192.168.0.0/16` and `172.16.0.0/12` — far broader than intended, since only the HA Supervisor's own internal network actually needs this trust level. Narrowed to loopback + `172.30.0.0/16` (the same boundary `server.js`'s ingress bypass already used), now shared via `isSupervisorIp()` in `lib/helpers.js`. The HA integration is unaffected — it already authenticates via its Supervisor Bearer token, not the private-IP path. Other direct-URL integrations (e.g. the Order Card) now get the token from the new Settings → API Token panel instead. Closes #276
- **CI didn't run tests or a build check.** `.github/workflows/build.yaml` only builds Docker images on release. Added `.github/workflows/test.yaml`, running `npm test` and `npm run build` on every push to `dev`/`main` and on pull requests. Also fixed `package.json`'s `version` field, which had been stuck at `1.2.4` while `config.yaml`/`lib/constants.js` moved on; a new `test/version-sync.test.js` now fails CI if the three drift apart again. Closes #277

## [1.104.3] – 2026-07-07

### Fixed
- **Container no longer runs as root.** The runtime stage had no `USER` directive; the process ran as UID 0 by default. Fixed via the standard HA add-on pattern instead of a plain `USER` line: the container still starts as root (needed to `chown` the `/data` bind mount, since HA installs don't guarantee it's owned by a specific UID), then immediately drops to the unprivileged `node` user (built into the `node:20-slim` base image) via `gosu` before the actual Node process ever runs. Added `docker-entrypoint.sh`. Closes #271

### Fixed
- **Auth middleware failed open if the API token couldn't be loaded.** `server.js`'s auth gate had `if (!state.apiToken) return next();` — a disk error preventing the token from loading/generating at startup would have let every request through unauthenticated instead of being denied. Only an edge case (`loadOrCreateApiToken()` always runs before `app.listen()` in the normal path), but fail-open is the wrong default for an auth check. Now returns 503 instead. Closes #272

## [1.104.1] – 2026-07-06

### Fixed
- **Security audit round: 3 findings closed.** (1) `/api/restore` only structurally validated `shots[]` — `coffee_library` and `annotations` were persisted without the same sanitizers the regular POST/PUT bean/grinder/recipe/annotate routes apply, so a crafted backup could inject unsanitized strings that later render in the frontend. Extracted the bean/grinder/recipe field sanitizers from `routes/library.js` into a shared `lib/sanitize-bean.js` (used by both the regular routes and restore now, instead of drifting duplicates), and restore annotations now go through `annotationSchema.safeParse()` like the regular annotate route. Closes #268. (2) The import product-page fetch (`routes/import.js`) checked the host allowlist only against the initial URL — axios followed redirects by default, so a 30x from an allowed shop domain (or MITM over the plain `http:` this route also allows) could point the fetch at an internal address without re-validation. Added `maxRedirects: 0` and a `maxContentLength` cap, matching the hardening `ImageService.fetchBeanImage` already had. Closes #269. (3) `npm audit` flagged 3 production-dependency vulnerabilities (`form-data` high/CRLF-injection, `undici` high/TLS-bypass, `js-yaml` moderate/DoS) plus 2 dev-dependency ones (`vite`, `vitest`) — all fixed via `npm audit fix` / non-major version bumps within the same major line. `npm audit` now reports 0 vulnerabilities. Closes #270.

## [1.104.0] – 2026-07-06

### Changed
- **Flavor wheel: only the matched path gets a label now, not every segment.** The v1.103.0 redesign made every category/subcategory/descriptor fully colored and labeled at all times to match the real SCA/WCR wheel's look — in practice that buried the handful of segments that actually mattered for a given bean under dozens of overlapping labels, distinguishable only by bold text and a slightly brighter border. Now only a bean's matched flavors and their ancestor categories (`markLit`'s existing lit-chain) get a label and full color saturation; everything else stays a narrow, desaturated, unlabeled sliver — the wheel's full shape is still there for reference, but stops competing with the matches for attention. `hslFor()` in `flavor-match.js` gained an optional third `lit` parameter (default `true`, so existing 2-arg callers are unaffected). Closes #265

## [1.103.1] – 2026-07-06

### Fixed
- **Flavor wheel modal could scroll on mobile/PWA, and still had a redundant close button.** The modal inherited `.guided-maint-modal`'s `overflow-y:auto`, so on short viewports the whole modal — including the interactive chart — scrolled as one block, which is broken UX for a drag/click chart. The wheel canvas now flexes to fill exactly the remaining space instead of forcing an outer scrollbar, and the unmatched-flavors chip list gets its own small scrollable area instead of pushing the modal past the viewport. Also removed the bottom "Schließen" button added in #263 — the ✕ in the header and tap-outside-to-close already cover it, and reaching a button below a non-scrolling chart wasn't reliable either. Closes #264

## [1.103.0] – 2026-07-06

### Added
- **Flavor wheel: redesigned to match the real SCA/WCR wheel's look** — after several rounds of readability feedback, every category, subcategory and descriptor now stays fully colored and labeled all the time (previously only top categories and actual matches were labeled, everything else dimmed to near-invisible) — the wheel is a legible reference chart again, not a sparse highlight diagram. Matches now stand out via bold text and a brighter border instead of graying out everything around them. Outer-ring labels switched from tangential (curved, lying along the ring) to radial (spoke-pointing, tilt-your-head-to-read) — the original wheel's signature look. `hslFor()`/`labelColorFor()` in `flavor-match.js` simplified accordingly (no more `dimmed`/`lit` branching on color, just depth-based contrast). Closes #257 (finally) — for real this time, confirmed against the actual SCA/WCR reference.

### Fixed
- **Self-healing cleanup for the v1.102.0 zombie service worker** — the v1.102.1 revert removed the service worker server-side, but a client that had already registered it (e.g. the HA mobile companion app) kept running the old, broken one regardless — unregistering the server's own registration call does nothing for a worker a browser already has active. `main.js` now unconditionally calls `getRegistrations()` + `unregister()` on every load, so any still-affected client self-heals the next time it opens the app, no manual cache-clearing needed. Closes #261
- **Comparative grind-advice toggle ("▸ N Vergleichsshots") did nothing** — the button has carried `data-action="toggle-comp-grind"` since it was introduced, but that action was never added to the delegated click handler in `main.js`, so tapping it was a no-op; reported as "can't open the comparison shots anymore". Closes #262
- **Flavor wheel modal had no reachable way to close it on mobile** — the only close control was a button below the (possibly tall, touch-interactive) chart, requiring a scroll past it; reported as getting stuck in the wheel. Added a visible "✕" in the modal header and tap/click-outside-the-modal-to-close. Closes #263

## [1.102.2] – 2026-07-06

### Fixed
- **Version housekeeping for the v1.102.1 rollback.** The manual revert + version bump only updated `config.yaml`, leaving `lib/constants.js`'s `GLP_VERSION` at the old `1.101.0` — the running app would have reported the wrong version. Synced both, and backfilled the changelog entry and a GitHub issue (#260) for the regression, since the emergency rollback understandably skipped that paperwork.

## [1.102.1] – 2026-07-06

### Fixed
- **Reverted the v1.102.0 installable-PWA service worker — it broke the live shot graph in the Home Assistant mobile companion app.** v1.102.0 added `manifest.json` + a service worker so "Add to Home Screen" would give a standalone app instead of a bookmarked tab. In production this broke the live shot graph inside the HA companion app, which loads GLP through HA ingress — most likely the service worker's fetch interception misbehaving inside that embedded ingress WebView (the live view just polls `/api/system/status` every second via plain `fetch()`, not a persistent stream, so this isn't a streaming-response issue). Separately, the PWA goal wasn't even fully met on a real device either: Android Edge over the LAN's plain `http://` address only offered "Add to shortcut," never the full "Install app" — expected, since service workers (and Chromium's full install criteria) require a secure context, which a plain-HTTP LAN address never is. Reverted entirely (`manifest.json`, `sw.js`, the registration in `main.js`, and the "Install as an app" docs section) back to v1.101.0 behavior. See #260.

## [1.101.0] – 2026-07-06

### Added
- **dev-stats: real per-model pricing + rendered charts** — `scripts/dev-stats.mjs` shipped every model price as `null` (by design — "fill in your own rates"), so `DEVELOPMENT.md`'s cost section had shown "unknown" since it was introduced in v1.98.0. `scripts/dev-stats.pricing.json` now ships filled in with blended (3:1 input:output) USD/1M-token rates for the models that actually show up in this repo's history (Sonnet 4.6, Opus 4.8, Fable 5, Sonnet 5 — the last at its introductory rate through 2026-08-31), so the estimate renders a real illustrative figure by default; still fully overridable with your own plan/API rates. The script also renders two small dark-theme PNG charts via `@napi-rs/canvas` (commits-per-repo, Claude-model-breakdown-by-commits) into `docs/dev-stats/`, embedded in the generated `DEVELOPMENT.md` and linked from the root README. Closes #258

## [1.100.0] – 2026-07-06

### Added
- **Flavor wheel: click/tap-to-zoom with breadcrumb navigation** — the wheel was still hard to read even after v1.99.0's contrast/anti-overlap fix, because the matched wedges were simply too small at the default zoomed-out scale (reported: a two-ring flavor label overlapping into the neighboring wedge). Tapping or clicking any wedge with sub-flavors now zooms into it (fills the whole circle, giving matched labels real room), and a breadcrumb bar above the chart ("Overview › Category › Subcategory") jumps back to any ancestor — identical behavior on touch and with a mouse, no gesture discovery needed. If a bean's matched flavors all fall under a single branch (the common case), the wheel opens already zoomed there instead of the full 9-category overview. Outer-ring labels (depth 2/3) now rotate tangentially instead of radially, which reads better on thin wedges; a hover/tap tooltip covers any label still hidden by anti-overlap. New pure helpers (`parentIdOf`, `pathToNode`, `nodeById`, `findAutoZoomTarget`) live in `flavor-match.js` alongside the existing color helpers so the zoom-target logic stays unit-testable. Modal and canvas are also bigger (560→680px / 420→560px caps). Closes #257
- **Cosmetic**: the flavor wheel's "Cancel" button now reads "Close" — it's a read-only view, canceling never made sense there. Closes #257

## [1.99.0] – 2026-07-06

### Added
- **Flavor wheel translated into all 6 UI languages, plus a readability fix** — the wheel's category/flavor labels only ever had DE/EN text; users on IT/FR/ES/NL saw everything forced to English. All ~60 nodes in `flavor-data.js` now have translations in all 6 languages, and matching works regardless of which language a bean's flavor tags were entered in. Also fixed low-contrast label text (was hardcoded white regardless of the segment's actual background lightness — light pastel segments at the outer rings could be hard to read) and added anti-overlap label options for crowded rings. `FLAVOR_ALIASES` (German colloquial terms) stays German-only for now; equivalent alias tables for the 4 new languages are backlog. Closes #256
- **Import price picker for shops with multiple sizes** — `priceFromProduct()` only ever read Shopify's arbitrary "default" variant price, so an import could silently record the wrong price for whatever bag size you actually track as stock. `GET /api/import/url` now returns distinct size variants (deduped by price+weight, since a size and e.g. grind type are usually separate Shopify option dimensions) when a product genuinely has more than one; the import flow shows a "which size did you buy?" picker before filling the form, and the chosen variant's price and weight populate price_eur and stock_g together so they can't mismatch. Single-variant products (and kaffeebraun, which has no Shopify variants at all) are unaffected. Closes #253
- **Blend (multi-country) bean origins with optional per-country weighting** — beans now support an `origins[]` chip array (mirrors the flavor tags UI) instead of a single country, so a Brazil/India blend can be represented properly. Single-origin vs. blend is derived from the array length, not a separate field. Each origin chip has an optional %-weight field; the Analytics world map now attributes a blend's shots proportionally across all its origin countries (weighted by percent when set, split equally when not). elbgold's origin-detection heuristic now recognizes up to 3 distinct countries as a genuine blend instead of discarding anything with more than one country mention. The legacy singular `origin` field is kept (derived as `origins[0]`) for backward compatibility with the order/shot card APIs; existing beans are migrated automatically on startup. Closes #252

### Fixed
- **Roast freshness badge no longer lingers after a bean's stock is depleted** — the badge was computed purely from the roast date, with no reference to whether the bean actually still had stock. A fully (or over-)consumed stock-tracked bean kept showing "this bean is N days old" as if it were still in the hopper. Beans without stock tracking at all keep showing the badge unconditionally, as before. Closes #255
- **Bean QR code generation no longer fails silently** — `toggleBeanQR()` called `QRCode.toCanvas()` with no callback/`.catch()`, so any encoding failure (most likely QR data-capacity exceeded — `bean.notes` can be up to 1000 characters, and umlaut-heavy German text roughly triples in length once percent-encoded) became an unhandled promise rejection: the canvas stayed blank with no error ever shown. Added `.catch()` handling, a conservative notes truncation before encoding, and `errorCorrectionLevel: 'L'` for more capacity headroom. The encode/decode logic moved to `public-src/glp-qr.js` so it's unit-tested directly. Closes #254
- **Beans can now have a photo uploaded manually** — auto-import (via the shop's product image URL) is fire-and-forget and its failure is invisible: a redirect bounce, unexpected content-type or timeout leaves the bean with no photo and no indication anything went wrong (reported as "hoplo bean image not showing"). `POST /api/library/bean/:id/image` (mirrors the v1.98.0 grinder photo upload route) lets you upload a photo directly from your device as a fallback — same content-type whitelist and size cap, no URL fetch involved. Closes #251
- **Elbgold import now finds tasting notes even without a "Noten von ..." sentence** — some product descriptions describe taste in free prose under a "Sensorik" heading instead of the one sentence pattern the parser looked for, silently returning no flavors. Added a fallback keyword scan (`lib/flavor-terms.js`, a small curated German cupping-term list) over the prose following a Sensorik/Geschmack/Aromen heading, used only when the primary pattern finds nothing. Best-effort, same as the rest of elbgold's free-text extraction. Closes #250

## [1.98.0] – 2026-07-06

### Added
- **README screenshots + `scripts/screenshots.mjs`** — regenerates `docs/screenshots/*.png` (Shots, Library, Flavor Wheel, Analytics world map, Maintenance, Dial-in) by booting a throwaway instance (its own tmp data dir and port, never touching `/data` or 8099), seeding demo beans/grinder/shots, and driving a headless Chromium (Playwright) through each view. README now embeds a preview; the GitHub wiki (Coffee-Library, Analytics, Usage, EN+DE) links the same images. Also fixes two stale `gaggiuino-profiler-integration` wiki links (now `glp-integration`) that an earlier docs pass missed. Closes #242
- **`scripts/dev-stats.mjs` generates `DEVELOPMENT.md`** — an honest activity snapshot across all 4 GLP repos (this app + glp-integration + glp-lovelace-card + glp-order-card): commit counts, timeline, Claude co-author breakdown by model, and a clearly-labeled rough cost estimate. There's no real per-session token usage available anywhere, so the cost figure is derived from changed-line counts and an editable `scripts/dev-stats.pricing.json` price table that ships with every price set to `null` — it reports "unknown" rather than presenting a fabricated number as fact. Run on demand, not wired into CI. Closes #249
- **Manual brew recommendation fields on beans** — `brewTempC` (80-100°C), `brewRatio` (free text, e.g. "1:2.2"), `brewTimeS` (5-300s) and `brewNotes`, shown on the bean card only when at least one is set. Manual-only: checked kaffeebraun.com, hoppenworth-ploch.de and elbgold.com and none expose structured brew parameters per product (elbgold only links to a generic, non-per-bean brew guide page). Closes #248
- **Grinders get burr type, purchase date and a photo** — the grinder form and card gain `burrType` (free text with suggestions) and `purchaseDate` fields, plus a directly-uploaded photo (there's no URL import for grinders like beans have): `POST /api/library/grinder/:id/image` accepts the raw image bytes via `express.raw()`, validated against the same content-type whitelist and size cap as bean images, stored as `grinder-<id>.<ext>` so it can never collide with a bean image filename in the same directory. Closes #247
- **Shots sidebar groups older months, collapsibly** — shots older than the current calendar month now collapse into a "Month YYYY" section (same collapse pattern as the bean bag history), while the current month stays a flat list. Only applies when sorted by "Newest" — score/rating/duration sorting keeps the flat list since month-grouping wouldn't make sense there. Closes #245

### Fixed
- **Milk stock now actually deducts on order completion and hides when empty** — order completion never touched `lib.milks[]`; the only deduction path was a disconnected shot-annotation flow a barista completing orders through the queue never hit. Order completion now deducts a menu item's configured milk amount from the matching milk (by name, case-insensitive) when it's completed. A new 🥛 "use milks" toggle on menu items (mirroring the existing 🫘 bean toggle) sources variants from the active milk library instead of manual chips, and `GET /api/orders/active-milks` (mirrors `/api/orders/active-beans`) excludes milks that are out of stock. Closes #246
- **CSV/.shot/backup exports work on mobile now** — `downloadCSV()`, the `.shot` export and `downloadBackup()` used a bare `Blob` + `<a download>` + `click()` pattern with no fallback, which mobile Safari and in-app/PWA browsers are known to silently swallow. All four export call sites (including the already-working share-card PNG button) now go through a shared `shareOrDownloadBlob()` helper: prefer the native Web Share sheet when the platform supports sharing files, respect a user-cancelled share, and fall back to the anchor-click download (still the right choice on desktop) when sharing isn't available or fails for another reason. Closes #244
- **Orders customer stats no longer split the same customer into multiple cards** — `GET /api/orders/stats` grouped completed orders by the raw, only lightly-sanitized `customer` string, so "Max", "max" and "Max " (case/whitespace variants of the same person) each got their own stats card. Grouping now uses a normalized key (trimmed + lowercased); the displayed name is whichever spelling appeared most recently. Closes #243

## [1.97.0] – 2026-07-06

### Added
- **Structured tasting notes (flavors)** — beans get a `flavors[]` tag list with a chips input in the form (Enter/comma adds, ✕ removes, Backspace on empty input removes the last chip; max 20 tags, deduped). Imports fill it automatically: kaffeebraun aroma properties and Hoppenworth & Ploch Geschmack lists become tags (qualifiers like "(Filter)" stripped) instead of a notes blob — the notes field stays free for personal notes. A startup migration moves the aroma segment of previously imported beans into flavors (shape heuristics protect personal notes; manual beans are never touched). Flavor chips render on the bean card and `beans-info` exposes `flavors` for the cards. Closes #233
- **Roast profile field** — beans carry `roastType` (espresso / filter / omni) as a select in the form and a blue badge next to the bean name. Imports derive it from the shop tags (Hoppenworth & Ploch and elbgold): espresso tag → espresso, filter tag → filter, both → omni. `beans-info` exposes it for the cards. Closes #234
- **Growing region + automatic geocoding** — beans get a `region` field (form input; the Hoppenworth & Ploch import stores its Herkunft district there instead of the notes). After saving, the backend resolves "region, country" to coordinates via Nominatim (fire-and-forget, custom user agent, ≥1.1 s request spacing, kv-cached including misses) and stores them as `bean.location` — the interactive world map places bean points there. Changing the region re-geocodes; hosts without internet simply keep the country-level fallback. Closes #235
- **Import provider: elbgold.com** — the URL import now also accepts Hamburg roaster elbgold's Shopify product pages. Since elbgold ships no structured spec table (just German prose), extraction is best-effort: tasting notes from a "Noten von …" sentence, growing region from a "Herkunft – …" heading, origin country by scanning the whole description for exactly one coffee-growing country name (`findCountryInText` in `lib/coffee-countries.js` — ambiguous/multi-country text stays unmapped), roast profile from the Espresso/Filter shop tags, decaf from the title. The Shopify product-JSON rewrite (`shopifyJsonUrl`) is now shared between Hoppenworth & Ploch and elbgold. Closes #236
- **Coffee flavor wheel** — a 🎡 button on beans with tasting notes opens a sunburst chart of the coffee flavor hierarchy (structure after the SCA/WCR Coffee Taster's Flavor Wheel, 2016 — our own derived data with German + English labels, no original artwork used) with the bean's matched flavors and their ancestor categories highlighted, everything else dimmed. Matching goes exact label → German alias table (`Zartbitterschokolade` → dark chocolate, `Nougat` → hazelnut, …) → word-boundary containment (`getrocknete Aprikose` → apricot), diacritics-insensitive; unmatched flavors are listed as plain chips below the wheel. Rendered with ECharts (already loaded for the world map); the matching logic lives in `flavor-match.js`, framework-free and unit-tested independently of the DOM. Closes #238
- **Bean image from shop imports** — when a bean is imported with a product image (kaffeebraun `og:image`, Hoppenworth & Ploch / elbgold `featured_image`), the app downloads it once server-side and shows it as a thumbnail on the bean card and large in the flavor-wheel modal. Hardened against SSRF: the image host must exactly match an import host or `cdn.shopify.com`, redirects are not followed, the body is capped at 1.5 MB, and only image content types are accepted; the filename is derived from the bean id, never the URL. Served through an authenticated endpoint and rendered via blob URLs (CSP `img-src` gains `blob:`). The image file is removed when the bean is deleted. Closes #239
- **Bean rating on the library card** — a star row (average of that bean's shot ratings, joined by name case-insensitively, same precedent as the stock math) plus the shot count shows on beans with at least one rated shot. Purely computed, no manual rating field. Closes #240
- **Six more bean fields**: altitude (m, clamped 0-3000), importer, harvest, price (€), producer and certification — form inputs, card display (only rendered when set), and import mapping where the shop provides it: Hoppenworth & Ploch's "Auf einen Blick" block supplies importer and harvest exactly, altitude and price come from best-effort prose/Shopify-price extraction on both hoplo and elbgold. Producer and certification are manual-only (no reliable source in any import). Closes #241

### Changed
- **Interactive world map** — the Statistics origin map now runs on Apache ECharts instead of chartjs-chart-geo: scroll/pinch to zoom, drag to pan, and each bean shows as a pulsing point at its geocoded region (or a jittered country centroid as fallback) alongside the shot-count choropleth. The vendored topojson is unchanged, converted client-side via topojson-client; both libraries come from the CDN with the same offline guard and empty state as before. Closes #237

## [1.96.1] – 2026-07-05

### Fixed
- **Legacy imported beans get their structured fields filled automatically** — beans imported before 1.96.0 carried "Herkunft: X" and "Aufbereitung: Y" as free text in the notes (the structured fields did not exist yet). An idempotent startup migration extracts mappable origins into the origin field and processing into the process field, removing the fragments from notes, so existing beans appear on the world map without re-entering data. The ", ," artifacts the old import join produced from empty aroma spans are cleaned along the way, and the kaffeebraun parser now filters empty spans before joining. Closes #232

## [1.96.0] – 2026-07-05

### Added
- **`GET /api/library/beans-info`** — read-only bean metadata endpoint (id, name, roaster, origin, variety, process, active-bag roast date, decaf; no stock math, not behind the orders guard) for external consumers. The Lovelace shot card v2.13.0 uses it to enrich the shot's bean line with origin flag, variety and roast age. Documented in `openapi.yaml`. Closes #231
- **Guided maintenance walkthroughs** — the backflush and descaling cards gain a "Guide" button that opens a step-by-step checklist (blind basket, 5×10 s pressure cycles, rinse …; mix, pump, soak 20 min, flush …). The done button unlocks once every step is ticked and logs the task through the existing mark-done flow. All step texts localized in the 6 UI languages. Closes #230
- **Brew-ratio hint in the grind advice** — when the shot duration is fine but the brew ratio (final weight / annotated dose) falls outside the classic espresso window (1:1.8–1:2.2), the advice line now shows the actual ratio as an informational hint instead of a plain "grind ok". Since yield is machine-stopped this is dose/yield guidance, deliberately not a grind direction. Along the way the ok-branch's hardcoded German text now uses the `grind_ok` i18n key. Closes #229
- **Low-stock push notification** — when a shot annotation brings a bean's remaining below 100 g, the barista device (the same `baristaNotifyService` used for order and preheat notifications) gets a one-time localized push ("Lucky Punch: nur noch ca. 84 g übrig — nachbestellen?"). The notified flag is stored per bag, so opening a new bag re-arms the notification automatically. Threshold hoisted to `LOW_STOCK_THRESHOLD_G` in `lib/constants.js`. Closes #228
- **Roast freshness badge in the library** — every bean card now shows a compact age badge ("12d") next to the name, colored by the same freshness windows as the annotation panel's degassing tracker (degassing < 4 d, almost 4–6 d, peak 7–21 d, fading 22–35 d, old > 35 d), based on the active bag's roast date. The date parser accepts both DD.MM.YYYY (form) and YYYY-MM-DD (bags/imports). Closes #227
- **Coffee world map in Statistics** — a new Analytics section renders a choropleth world map of your coffee origins: countries are colored by shot count (joined shots → bean → origin country by bean name, same precedent as the stock math), and beans with an origin but no shots yet still light up. Tooltips show flag, localized country name, shot count and the bean names. Rendered with chartjs-chart-geo (CDN, CSP-allowed); the world topojson ships with the app (`countries-110m.json`, world-atlas) so no external data request is needed. Offline hosts or an empty library show a hint instead of a broken chart. Closes #226
- **URL import from hoppenworth-ploch.de** — the 🔗 URL import now also accepts Hoppenworth & Ploch product URLs. It reads the shop's structured Shopify product JSON (no HTML scraping) and fills name, roaster, tasting notes, origin country (mapped from the "Name - Land" title), growing region (kept in notes), variety, processing and the decaf flag for DECAF products. Import parsing moved to `lib/import-parsers.js` with fixture-based tests; the kaffeebraun import now also fills the variety field. Closes #225
- **URL import fills the structured origin and processing fields** — single-country `Herkunft` values from kaffeebraun.com product pages are mapped to the ISO origin code (reverse lookup over German + English country names via `Intl.DisplayNames`, plus aliases like Hawaii); blends ("Brasilien, Indien") keep the previous notes behavior. `Aufbereitungsart` now lands in the processing field instead of the notes. Closes #224
- **Structured bean origin, variety and processing** — the coffee library bean form gains three new fields: **origin** as a country picker over ~46 coffee-growing countries (stored as ISO 3166-1 alpha-2 code, displayed with flag emoji and country name localized via `Intl.DisplayNames` — no translation maintenance), **variety** (free text with suggestions: Arabica, Robusta, Geisha, Bourbon, …) and **processing** (Washed, Natural, Honey, Anaerobic — previously a ghost field only fillable via API). All three render in the bean list line and flow into `/api/orders/active-beans` (`variety` is new there) for the order card. Non-ISO origin values are rejected server-side; the structured code is the join key for the upcoming origin world map. Closes #223

### Fixed
- **Maintenance log showed the raw grinder ID instead of the grinder's name** (e.g. "Grinder 1779521986327" instead of "Kingrinder K6") — log entries only store the internal task key `grinder_<id>` and the frontend label merely stripped the prefix. `getMaintenanceLog()` now enriches grinder entries with `grinderName` from the coffee library (the same enrichment the maintenance cards already use), and the log renderer prefers it; deleted grinders keep the previous fallback label. Closes #222

## [1.95.0] – 2026-07-03

### Added
- **Bean descriptions for the order card** — `/api/orders/active-beans` now includes each bean's customer-facing description data from the coffee library (`notes` = taste notes, `origin`, `process`), so the order card can show customers what characterizes a coffee. The endpoint is now also documented in `openapi.yaml`. Closes #220

## [1.94.5] – 2026-07-03

### Fixed
- **Empty beans were still offered in the order card** — `/api/orders/active-beans` only checked `stock_g > 0`, i.e. the initial bag weight, while the library view computes the real remainder (stock minus the summed annotated doses of matching shots since the active bag was opened). A fully consumed bag (0 g left, "Reorder" badge showing) therefore stayed orderable. The remainder is now computed server-side with the same semantics (`LibraryService.computeBeanRemaining`), sold-out beans are filtered out, and each active bean reports its `remaining` grams. Closes #219

## [1.94.4] – 2026-07-03

### Fixed
- **Restoring a backup from file did nothing** — the "Restore from backup" label carried `data-i18n` while containing the hidden `<input type="file">` as a child; the first `applyTranslations()` run replaces the node's `textContent` and thereby deleted the file input from the DOM, so clicking the button had no effect. The translated text now lives in its own `<span>`, and a regression test asserts that no `[data-i18n]` element in `index.html` contains child elements (the `<b>` inside `empty_desc` was cleaned up along the way). Closes #218

## [1.94.3] – 2026-07-03

### Fixed
- **Four routes still read/wrote the frozen legacy JSON files instead of SQLite**, causing real data loss since the migration: `/api/status` counted shots from the stale `shots.json` (the HA `shot_count` sensor was stuck at the migration snapshot), order completion looked up the latest shot id in the stale file (order→shot links pointed at old shots or `null`), the `orderedBy` customer attribution was written to `annotations.json` while all reads come from the DB (silently lost), and grinder deletion removed its maintenance entry from `maintenance.json` instead of the DB (orphaned rows). All four call sites now go through `ShotRepository`/`LibraryService`; the dead legacy `*_FILE` constants were removed. Closes #217
- **With `enable_orders: false` (the default) the whole app 404'd**: the orders guard was an unscoped `router.use()`, which runs for every request passing through the router — `/api/status`, backup, import and even the static frontend (all mounted after the orders router) were swallowed. The guard is now scoped to `/api/orders`. Closes #221

## [1.94.2] – 2026-07-02

### Fixed
- **Shot detail view stayed in the previous language after switching UI language** — the Chart.js legend (pressure/flow/weight/temperature + target lines) and the grind-advice message are built once via `t()` when a shot is rendered; they're drawn to canvas/computed text, not scanned by `applyTranslations()`, so a language switch while a shot was already open left them frozen. `setLang()` now also rebuilds the open shot view (`window.updateView()`) when the shots tab is active. Closes #216
- **Phase-tag chips, compare-shots title and "Unknown Profile" fallback were hardcoded German**, bypassing the i18n system entirely (unlike the chart's own phase overlay bands, which already used `phase_preinfusion`/`phase_extraction` correctly). Wired to existing/new translation keys (`compare_title`, `profile_unknown`) across all 6 languages. Closes #216
- **Sync button's rate-limit message** fell back to hardcoded `'Warten …'` when the server didn't return an error string — now uses the new `please_wait` key. Closes #216

## [1.94.1] – 2026-07-02

### Fixed
- **Critical: a single malformed shot in a restore could wipe existing data** — `POST /api/restore` explicitly allowed shots with a missing `timestamp` to pass validation, then wiped `shots`/`annotations`/`trash`/`blocklist` in a transaction that committed *before* the reinsert loop ran outside any transaction. Since `timestamp` is `NOT NULL`, a reinsert failure left the library empty with no way back. Wipe and reinsert are now one atomic transaction (any failure rolls back everything), validation rejects missing/non-numeric timestamps outright, and the error response now names the specific offending shot instead of a generic message. Added defensive `?? null` fallbacks in `ShotRepository` and the legacy JSON migration path as well. Closes #215
- **Backup download 401'd for any client not proxied through HA ingress** — the download button was a plain `<a href="api/backup">`; a native anchor navigation can't attach the `X-GLP-Token` header, so any access outside HA Supervisor ingress (e.g. a direct LAN URL) got a raw `{"error":"Unauthorized"}` instead of a file. Now fetches through the same token-aware `apiFetch()` used elsewhere and triggers the download from the resulting blob. Closes #215
- **Several UI strings never translated regardless of selected language** — the "Live Shot" heading, the Live view's idle-state heading, the CSV/.shot export button tooltips, and the share-card button tooltip were never wired into the i18n system (`live_title` existed but was unused; the others had no key at all). Added the missing `data-i18n`/`data-i18n-title` attributes and the new `machine_ready`, `export_csv_title`, `export_shot_title` and `share_card_tooltip` keys to all 6 language files. Closes #215

## [1.94.0] – 2026-06-30

### Added
- **Order card: hide sold-out bean items** — menu items with `useBeans: true` no longer appear in the customer order card when all active beans have stock = 0. They reappear automatically once stock is replenished. Closes #213
- **Library: inline bean stock editor** — an "Adjust stock" button next to the remaining-stock display lets you correct or override the current bag's weight (g) without opening a new bag. Calls `PUT /api/library/bean/:id` and syncs the active bag. Closes #214
- **Orders: presence-aware broadcast** — open/closed shop notifications are only sent to recipients whose HA person entity is currently `home`. Recipients with no person mapping are always notified. Closes #215

---

## [1.93.0] – 2026-06-28

### Changed
- **Always open newest shot on startup** — the app now always selects the most recently recorded shot when loaded, instead of restoring the last viewed shot. Closes #212

## [1.92.1] – 2026-06-27

### Fixed
- **Share card: GLP logo missing** — `icon.png` was not copied into the Docker runtime image. Added `COPY icon.png ./` to the Dockerfile runtime stage.
- **Format picker dropdown always visible** — `.card-fmt-menu` was missing `display: none`, so the dropdown appeared expanded on page load. Fixed in CSS.
- **DOSIS row duplicated in stats** — DOSIS → YIELD · RATIO appeared in both the card header and the stats grid. Removed from the stats grid (header is sufficient). Closes #211

## [1.92.0] – 2026-06-27

### Added
- **Share card format picker** — the Teilen button now opens a dropdown with two format options: "Quadrat (1:1)" (1080×1080, same as before) and "Story (9:16)" (1080×1920, optimised for Instagram Stories with a taller chart area). The API endpoint accepts `?format=story` or `?format=square`. Closes #208
- **Share card redesign** — black/white theme matching the GLP UI: GLP logo in header, DOSIS line (dose → yield · ratio · duration) below profile name, phase chips (Preinfusion / Extraktion in blue / orange) at the top of the chart area, two-column stats section (DRUCK, PUMPENFLUSS, TEMPERATUR left; GEWICHT, GEWICHTSFLUSS, DAUER, DOSIS → YIELD · RATIO right) with row separators. Closes #210

### Fixed
- **Phase labels overlapping** — "Preinfusion" / "Extraktion" labels now only render when their respective chart zone is wide enough (> 90 px), preventing overlap on shots with very short preinfusion phases.

## [1.91.1] – 2026-06-26

### Fixed
- **Share card: text invisible** — `GlobalFonts.loadSystemFonts()` returned 0 on headless Linux (no fontconfig paths registered). Switched to explicit `GlobalFonts.registerFromPath()` for Liberation Sans / DejaVu Sans with multi-path fallback. All text (GLP header, score, profile, metadata, footer) now renders correctly. Closes #205
- **arm64/armv7 Docker builds failed with EBADPLATFORM** — `npm install @napi-rs/canvas-linux-arm64-gnu` was rejected on the x64 builder because npm validates `cpu` field against the host. Fixed by adding `--force` to bypass the platform check during cross-compilation. Closes #205
- **Share card redesign** — Cleaner layout matching GLP UI style: score badge with ring glow, Liberation Sans font (bundled via `fonts-liberation` in runtime image), header with shot ID + date, larger chart area, metadata in pill cards. Closes #205

## [1.91.0] – 2026-06-26

### Added
- **Shot share card** — new `GET /api/shots/:id/card` endpoint renders a 1080×1080 PNG image of the shot: score badge, pressure curve with glow, profile name, bean, dose/yield/ratio/duration and GLP branding. A **Teilen** button in the shot detail toolbar triggers a native share sheet on mobile (Web Share API) or downloads the PNG on desktop. Powered by `@napi-rs/canvas` (pre-built N-API binaries, no system Cairo needed). Closes #204

## [1.90.4] – 2026-06-26

### Fixed
- **aarch64 Docker build** — QEMU crashed with `SIGILL` (Illegal Instruction) when Alpine's `g++` used SVE2 instructions the emulator doesn't support. Switched base image from `node:20-alpine` to `node:20-slim` (Debian) and restructured the Dockerfile to use `--platform=$BUILDPLATFORM` for all build/install stages. A dedicated `prod-deps` stage cross-compiles `better-sqlite3` natively on amd64 using `aarch64-linux-gnu-gcc` / `arm-linux-gnueabihf-gcc` for each target arch — no QEMU emulation involved. The runtime stage only copies pre-built artifacts. Closes #200

## [1.90.3] – 2026-06-26

### Fixed
- **Critical: JSON→SQLite migration failed on first start** — the `orders` table was declared with `id INTEGER PRIMARY KEY`, but order IDs are strings (`ord_…`). SQLite threw `datatype mismatch`, rolled back the entire migration, and left the database empty. Added `fixSchema()` to detect and repair the wrong column type at startup (safe: the table is always empty when this runs since migration never completed). Also hardened the `trash` migration to coerce legacy non-integer `deleted_at` values. Closes #198

## [1.90.2] – 2026-06-26

### Fixed
- **Critical: all data appeared missing** — after the Clean Architecture refactor (v1.89.0), `lib/data.js` was stripped to machine-config helpers only, but `routes/orders.js`, `routes/library.js`, `routes/system.js` and `lib/preheat.js` still imported `loadOrders`, `loadLibrary`, `loadMenu`, `loadOrdersSettings` etc. from it. Every one of those calls threw `TypeError: X is not a function`, making orders, library and menu endpoints return errors. Data was always safe in SQLite — only the function exports were missing. Closes #196

## [1.90.1] – 2026-06-26

### Fixed
- **Mobile UX** — larger touch targets on annotation panel: stars padded to ~44px tap area, drink/milk pills min-height 40px, Save button full-width and stacked on mobile (≤768px). Chart height reduced to 240px on small phones (≤480px) to give annotation panel more visible room. Closes #194

## [1.90.0] – 2026-06-26

### Added
- **Coffee bean dropdown** — the coffee field in the annotation panel is now a `<select>` populated from the bean library instead of a free-text input. Custom names not in the library are preserved as a trailing option. Closes #192

### Changed (Architecture)
- **Frontend module split** — `public-src/views/shots.js` split into `utils.js`, `grind.js`, `annotation.js`, `charts.js`, `index.js` with a barrel re-export for tree-shaking and cleaner ownership boundaries. Closes #191

## [1.89.1] – 2026-06-26

### Fixed
- Docker build failure on Alpine: `better-sqlite3` native addon now compiles correctly (added `python3 make g++` as virtual build packages, removed after install to keep image lean)

## [1.89.0] – 2026-06-26

### Changed (Architecture)
- **SQLite persistence** — 15 flat JSON files replaced by `better-sqlite3` (WAL mode, indexed queries, atomic writes). Existing data migrates automatically on first start.
- **Repository layer** — `lib/repositories/` abstracts all storage: `ShotRepository`, `LibraryRepository`, `OrderRepository`
- **Service layer** — `lib/services/` holds all business logic with no direct I/O: `ShotService`, `LibraryService`, `OrderService`
- **Zod validation** — schemas at all API boundaries (`lib/validation/schemas.js`), generic middleware in `lib/middleware/validate.js`
- **Centralized error handling** — `lib/middleware/error.js`, consistent `{ error }` JSON responses
- **Vitest** — 11 unit tests for score calculation and Zod schemas (`npm test`)

## [1.88.1] – 2026-06-26

### Fixed
- Recipe dropdown in annotation panel now matches the visual style of all other input fields (dark background, themed border, Figtree font)

## [1.88.0] – 2026-06-26

### Added
- **Recipe → Shot linking:** shots can now be linked to a library recipe via a new "Rezept" dropdown in the annotation panel. The selector is hidden when no recipes exist. Each recipe card in the Library now shows a shot count badge and average score across all linked shots (Closes #183)

## [1.87.3] – 2026-06-26

### Security
- **L1:** Pinned all npm dependencies to exact versions — removes implicit auto-upgrade risk from `^`-ranges (Closes #180)
- **L2:** `getOpenApiSpec()` now catches `readFileSync` errors and returns `{}` instead of crashing the process when `openapi.yaml` is missing (Closes #181)

## [1.87.2] – 2026-06-26

### Security
- **M1:** Removed all `onclick`/`oninput`/`onchange` inline event handlers from the frontend — replaced with `addEventListener` wiring and `data-action` event delegation; `'unsafe-inline'` removed from `script-src` in the Content-Security-Policy header (Closes #171)

## [1.87.1] – 2026-06-25

### Security
- **H1:** `/api/status` no longer exposes `machineUrl`, `machineHostname`, `lastSyncError`, or `switchEntity` to unauthenticated callers — sensitive fields are only included when a valid `x-glp-token` is present (Closes #177)
- **H2:** `/api/debug/machine` is now gated behind `NODE_ENV !== 'production'` — the endpoint is unavailable in production builds (Closes #178)
- **H3:** Import URL validation now rejects non-HTTP(S) protocols (`ftp://`, `javascript://`, etc.) in addition to the existing hostname allowlist check (Closes #172)
- **M2:** `/api/token` endpoint now enforces a rate limit of 10 requests/minute per IP (Closes #173)
- **M3:** API token comparison in the auth middleware now uses `crypto.timingSafeEqual()` instead of `===`, preventing timing side-channel attacks (Closes #174)
- **M4:** `/api/restore` now validates each shot object before writing — requires `id` (positive integer) and `timestamp` (number, if present) (Closes #175)
- **M5:** Added `Permissions-Policy: camera=(), microphone=(), geolocation=()` response header (Closes #176)

## [1.87.0] – 2026-06-24

### Changed
- **Refactor:** `live-sync.js` split into `lib/preheat.js`, `lib/sync.js` and `lib/poll.js` — each module has a single responsibility, clean dependency direction (Closes #168)
- **Refactor:** `data.js` — generic `loadJson()` helper eliminates repeated try/catch/read/parse boilerplate for 7 simple load functions (Closes #169)
- **Fix:** Server startup no longer silently skips shot sync when machine power check fails — async IIFE with individual try/catch ensures `scheduleNextSync()` always starts (Closes #170)

## 1.86.0
- fix: roast date is no longer an editable field in the shot annotation tab — it is now always derived automatically from the coffee library (respecting the active bag at shot time); this fixes stale dates when using quickClone and ensures the value stays in sync when the coffee is changed; closes #167

## 1.85.0
- feat: in-app update check — GLP now polls `GET /api/version` on startup, compares the running version against the latest GitHub release (1 h cache), and shows a dismissible banner when an update is available; closes #166
- feat: one-click update via HA Supervisor — the banner's "Install now" button calls `POST /api/update` which triggers `POST http://supervisor/addons/self/update`; the add-on restarts automatically; not available when running outside HA

## 1.84.4
- fix: add `io.hass.version`, `io.hass.type` and `io.hass.arch` labels to all ghcr.io images — Supervisor 2026.06 changed update detection to use these labels; without them the store could not reliably detect available updates; closes #165

## 1.84.3
- fix: preheat no longer restarts after a Home Assistant restart — on app start `currentTemp` is null (not yet polled); `startLivePolling()` now trusts the file-restored `switchOnAt` when the machine has not been off long enough to cool; treats `switchOffAt === null` (never turned off) as "still warm"; closes #164

## 1.84.2
- fix: changing the coffee name in the annotation panel now always updates the roast date from the coffee library — previously the auto-fill was skipped if a roast date was already present (e.g. after \"Copy from last\"); closes #163

## 1.84.1
- fix: the „machine ready / warm-up complete“ HA notification was hardcoded English — it is now localized to the Home Assistant instance language (de/en/it/fr/es/nl, fallback German), so a German user no longer gets it in English; closes #162

## 1.84.0
- feat: shot score now closer to coffee best practice — added an **Extraction Yield** factor (SCA "Golden Cup" 18–22 %, active only when TDS + dose are annotated) and the **temperature** factor now combines stability with accuracy vs the shot's target temperature (fallback band 90–96 °C), so a stable but wrong-temperature shot (e.g. boiler-off) no longer scores full on temperature; closes #161

## 1.83.1
- fix: the Docker builder stage now copies `lib/` before `npm run build` — the frontend build imports the shared `lib/score.js`, so the v1.83.0 image build would otherwise fail.

## 1.83.0
- feat: the shot **score** (0–100) is now computed once in the backend (`lib/score.js`) and served on each shot via `/shots.json`, `/api/shots/last` and `/api/shots/:id`. The frontend and the HA integration now read this single value instead of each re-implementing the scoring — one source of truth. Scoring unchanged (weighted pressure, temperature stability, duration, brew ratio, channeling).

## 1.82.7
- fix: `/api/token` now accepts HA Supervisor token verification as a third auth path — integration sends `Authorization: Bearer {SUPERVISOR_TOKEN}`, add-on verifies against `http://supervisor/info`; this fixes 401 errors on `/shots.json` when Docker NAT exposes the HA core connection from a non-private source IP; closes #158

## 1.82.6
- fix #155 (corrected): restore same-profile filter for comparative grind advice; profile names are now `.trim()`-normalized before comparison to avoid whitespace mismatches; minimum comparable-shot threshold lowered from 2 → 1 so profiles with fewer annotated shots also show comparisons

## 1.82.5
- fix: grinder maintenance threshold mode no longer resets to shots after restart — saved `null` was overwritten by the default `200` on reload due to `??` instead of `in`-check; closes #154
- fix: "This week" KPI now counts shots in the current calendar week (Mon–Sun) instead of a rolling 7-day window; closes #156
- fix: comparative grind advice now shown for all annotated profiles, not just Adaptive — profile-name filter removed; coffee + grinder + dose match is sufficient; closes #155
- fix: customer statistics panel now uses a dedicated `/api/orders/stats` endpoint that reads all completed orders without the 100-entry queue cap, so stats are always accurate; closes #153
- fix: XSS — grinder name in maintenance card title now correctly HTML-escaped

## 1.82.4
- feat: publish pre-built Docker images to ghcr.io — GitHub Actions now builds and pushes amd64/armv7/aarch64 images on every release; HA pulls the pre-built image instead of building locally; eliminates build-cache issues and slow/broken update detection introduced in HA Supervisor 2026.06; closes #150

## 1.82.3
- feat: mini chart thumbnails in comparison shots panel — the expandable grind advice panel now shows shot curves (pressure blue, flow orange) as SVG thumbnails in a grid instead of plain text rows; each thumbnail is clickable and navigates to that shot; closes #149

## 1.82.2
- feat: expandable comparison shots in grind advice — the comparative grind advice bar now has a ▸ toggle; clicking it reveals all comparison shots as compact rows (date · grind setting · score · duration), sorted best-first; clicking a row navigates to that shot; closes #148

## 1.82.1
- feat: extend accent gradient to tabs, nav, sidebar, score badge — active mode-btn and lib-tab underlines are now gradient (::after pseudo-element); active sidebar shot gets a gradient left border (border-image); score-ok badge uses gradient text (background-clip: text); ss-ok pill uses --accent-glow; closes #147

## 1.82.0
- feat: accent color themes — 5 selectable color schemes in Settings: Amber (default), Ocean (blue→cyan), Aurora (indigo→purple), Ember (red→orange), Forest (green→teal); accents applied via CSS custom properties (`--accent`, `--accent-from`, `--accent-to`, `--accent-glow`); gradient on save buttons and glow on active pills/tabs; persisted in `localStorage` as `glp_accent_theme`; closes #146

## 1.81.0
- feat: score trend warning — if the last 5 scored shots show a declining trend (slope < −1.5 pts/shot via linear regression), a warning banner appears in the Analytics summary; closes #144
- feat: dial-in summary per bean — bean cards now show how many shots it took to first reach score ≥ 80 (🎯 Dial-in: X Shots); closes #144
- feat: barista push notification when machine is preheated — once the configured preheat time elapses, the barista device receives "☕ Machine ready"; one notification per machine-on cycle; requires `baristaNotifyService` in orders settings; closes #145

## 1.80.0
- feat: comparative grind recommendation — below the duration-based grind advice a second line appears when ≥2 comparable shots exist (same coffee + grinder + profile, dose ±1 g, annotated grind setting + score); shows which grind setting historically produced the best score and whether to go finer/coarser; grind setting is parsed as a number from free text ("23 Clicks" → 23); closes #143

## 1.79.0
- feat: milk stock deduction from shot annotation — new **Milchsorte** selector in the annotation panel (appears when a drink type is selected and milk types exist in the library); when milk type is set for the first time on a shot and the drink has `milkMl` configured, the milk stock is automatically reduced; new endpoints: `GET /api/library/milks`, `POST /api/library/milk/:id/deduct`; closes #142

## 1.78.1
- fix: milk form open/close now uses `classList.add/remove('open')` instead of `style.display` — form was always staying hidden because the CSS default `.lib-add-form { display: none }` overrode the inline style removal

## 1.78.0 (+ refactor)
- refactor: split `constants.js` translations into per-language files — `public-src/i18n/{de,en,it,fr,es,nl}.js`; `constants.js` reduced from 1474 to 99 lines; no behaviour change

## 1.78.0
- feat: milk tab in library — add milk types (name, emoji, stock in ml), track stock with progress bar and low/empty indicators, restock via inline input; each order menu item gets an optional "ml per order" field; orders view shows a live milk stock panel with demand from pending/accepted queue and remaining stock per milk type; new endpoints: `POST/PUT/DELETE /api/library/milk`, `GET /api/orders/milk-stock`; closes #140

## 1.77.1
- feat: delete individual bag from bean bag history — each bag row in the Packungsverlauf now has a ✕ button; deleting the active (most recent) bag automatically rolls back to the previous one; last remaining bag cannot be deleted; closes #141

## 1.77.0
- feat: bean-sourced variants — each menu item can be toggled (🫘) to pull variants from the active bean library instead of manually entered strings; active beans (stock_g > 0) are returned by new `GET /api/orders/active-beans`; pairs with glp-order-card v1.9.0; closes #139
- feat: ordered-by block in shot detail — when a shot is linked to an order, customer + drink + variant + note are now shown in a block above the chart (and in the annotation badge); the info is already stored since v1.76.1; closes #138 (display follow-up)

## 1.76.1
- fix: order context (drink, variant, note) now stored in shot annotation on order complete — `orderedBy` object in the annotation now includes `item`, `variant`, and `note` in addition to `customer`/`haUserId`/`orderId`; closes #138

## 1.76.0
- feat: menu item variants — each drink in the order menu can have optional variants (e.g. Regular / Decaf, Oat / Whole Milk); admin adds/removes variants per item via chip editor in the Orders menu admin; order stores `variant` field; barista view shows variant next to item name; push notification title includes variant; new `variants` field on menu items (`PUT /api/orders/menu/:id`), new `variant` field on orders (`POST /api/orders`); pairs with glp-order-card v1.8.0; closes #137

## 1.75.0
- feat: barista push notification on new order — configure a barista notify device in the Push Notifications section of the Orders tab; the barista receives a push notification (title: item name, body: customer + note) whenever a new order is placed; stored as `baristaNotifyService` in `/data/orders_settings.json`; closes #136

## 1.74.1
- perf: `writeFileSafe` now uses `JSON.stringify(data)` instead of `JSON.stringify(data, null, 2)` — removes whitespace/newlines from all persisted JSON files (~25% storage reduction); existing pretty-printed files are unaffected on read and minified on next write; closes #135

## 1.74.0
- feat: maintenance log — persistent history of all service events per machine; every "Mark as done" click creates a log entry (date, task, shot count, machine hostname); manual entries can be added via form (task selector, date picker, notes); entries can be deleted; stored in `/data/maintenance_log.json` (max 500 entries); new endpoints: `GET/POST /api/maintenance/log`, `DELETE /api/maintenance/log/:id`; closes #134

## 1.73.1
- fix: analytics crash — `t('analytics_days')` was called without args, the i18n helper immediately invokes function-values, returning `"undefined Tage"` instead of the function; then calling that string as a function threw a TypeError that crashed all of `initAnalytics()`; fixed to `t('analytics_days', n)` in both KPI and personal-bests sections

## 1.73.0
- feat: analytics — 5 new sections: Summary KPIs (total shots, avg score, total coffee, this week, longest streak), Personal Bests (best shot with link, longest streak, favourite bean/profile, busiest day), Grinder Stats (cards identical to bean stats), Dose & Ratio Distribution histograms, Time of Day bar chart (shots by hour, coloured by avg score); closes #132

## 1.72.4
- fix: auth middleware now bypasses `/api/token` so the endpoint can apply its own IP-based check — previously the middleware blocked all unauthenticated `/api/*` requests including `/api/token` itself, making it impossible for the integration coordinator to ever obtain a token; closes #133

## 1.72.3
- fix: `/api/token` now accepts requests from any private/loopback IP (10.x, 172.16–31.x, 192.168.x, 127.0.0.1) — HA Core may reach the add-on from a Docker bridge IP (172.17.x.x) or host-routed IP that is not in the Supervisor subnet (172.30.x.x); closes #133. The Ingress-Path bypass in the auth middleware remains strictly 172.30.x.x.

## 1.72.2
- docs: DOCS.md + DOCS.de.md comprehensive update — NL language added to language table, API token section updated (v1.72.0 /api/token change + direct-URL glp_token), Library tab updated (recipes, bag tracking, decaf), tab names corrected (Einwählen→Dial-in, Bestellungen→Orders in EN), preheat section updated (thermal stability detection), Orders tab updated (queue ETA), UI language section added (DE/EN/IT/FR/ES/NL)

## 1.72.1
- fix: Vite reverted to 6.x — Vite 8 uses Rolldown (Rust native binaries) which has no musl/Alpine build, causing the Docker image build to fail on all HA-supported architectures; Vite 6 (pure JS bundler) works correctly on Alpine
- fix: Dockerfile updated from `node:18-alpine` (EOL April 2025) to `node:20-alpine` (LTS)

## 1.72.0
- security: **apiToken no longer returned by unauthenticated `/api/status`** — new `/api/token` endpoint returns the token only to requests from the HA Supervisor network (172.30.x.x) or already-authenticated callers; closes #131 (Finding 1)
- security: **ingress header bypass restricted to Supervisor source IP** — `X-Ingress-Path` is now only trusted when the request originates from `172.30.x.x`; external LAN clients can no longer spoof the header to bypass authentication; closes #131 (Finding 2)

## 1.71.1
- fix: firmware version detection — `fetchMachineVersion()` tried only `/api/system/info` (doesn't exist on Gaggiuino); now also tries `/api/firmware` and `/api/about`; additionally extracts firmware from `/api/system/status` response fields every live-poll cycle; as last fallback reads `softwareVersion`/`buildNumber`/`buildDate` directly from the shot JSON at sync time

## 1.71.0
- feat: Nederlands (NL) added as sixth UI language — complete translation of all keys incl. Library, Recipes, Orders, Maintenance, Charts

## 1.70.1
- fix: i18n — chart labels, tooltip titles and y-axis descriptions were hardcoded in German; now use `t()` with keys `chart_pressure`, `chart_flow`, `chart_weightflow`, `chart_weight`, `chart_temp`, `chart_target_*`, `chart_time`, `chart_*_unit`; `'gerade eben'` in orders view replaced with `t('orders_just_now')`; all 5 languages covered

## 1.70.0
- feat: orders — **queue ETA** (#130): new endpoint `GET /api/orders/queue-eta` calculates estimated wait time per order (sum of remaining accepted-order time + position × avg preparation time from last 10 orders); barista view shows queue banner when ≥2 orders are active and pre-fills ETA picker; customer card (glp-order-card v1.7.0) shows queue position and wait time when order is pending

## 1.69.0
- feat: shots — **bean age at shot time** (#129): `beanAgeDays` is now calculated automatically on annotation (shot timestamp − roast date of the active bag) and stored in the annotation; freshness badge now shows "X days at shot time" instead of current age; selecting a bean shows a hint with the calculated age; roast date auto-fill uses the bag that was active at shot time

## 1.68.0
- feat: preheat thermal stability detection improved (#124): `isTempStable()` now uses **range (max−min ≤ 1.5 °C)** over the last 30 seconds instead of statistical variance over the full history — reacts to recent stability even if the machine oscillated earlier; `state.stabilityReady` flag tracks whether preheat was completed by stability or timer; `/api/preheat` response includes `stabilityReady: bool`

## 1.67.1
- feat: library recipes — **water amount (g)**, **ice amount (g)** and **source URL** as new fields; recipe card shows 💧/🧊 in the parameter row and a clickable 🔗 link

## 1.67.0
- feat: library recipes — **brew method** (Espresso / AeroPress / V60 / French Press / Moka / Cold Brew), **water temperature**, **grind size** and **workflow steps** (ordered list with optional duration per step); recipe card shows all steps numbered; steps can be added/removed live in the form

## 1.66.0
- feat: library — **decaf flag** (#127): beans can be marked as decaffeinated (checkbox in the form, green DECAF badge on the card)
- feat: library — **bag tracking** (#128): "New Bag" button per bean; current bag + total consumption across all bags; collapsible bag history
- feat: library — **recipes** (#126): new "Recipes" tab with name, drink type, dose/yield/time, profile, bean, notes; full CRUD

## 1.65.2
- docs: DOCS.md + DOCS.de.md updated — orders push-notification section now documents both broadcast recipients (open/close with preheat-awareness) and per-customer mapping

## 1.65.1
- feat: orders — broadcast notification when orders are **disabled**: "🚫 Kaffeebar geschlossen — Die Bestellannahme wurde beendet."

## 1.65.0
- feat: orders notify-mapping shows all HA `person.*` entities (not just past customers) — barista can assign devices before the first order; merged with order-history customers; closes #125 (partial)
- fix: orders open-notification text includes "Bestellungen über das Menü Kaffeebar aufgeben"

## 1.64.0
- feat: orders — broadcast-recipients config in barista UI; barista selects which HA devices get notified when orders open; preheat-aware message: "opens in ~X min" while warming up, "open now" when ready; `broadcastRecipients` array stored in orders settings; closes #125

## 1.63.0
- feat: orders — customer-chosen notify service: `notifyService` field stored on order (validated to `notify.*`); accept/complete/decline prefer `order.notifyService` over per-user barista mapping; glp-order-card v1.6.0 sends the selection; closes #12 (glp-order-card)

## 1.62.7
- fix: hamburger icon (☰) still clipped on left edge on mobile — `#mobileMenuBtn` had `padding: 0 12px 0 0` (no left padding) and `#mode-bar` has `padding: 0` on mobile; added 12 px left padding; closes #123

## 1.62.6
- fix: hamburger menu icon (☰) was clipped on mobile — `#mode-bar` had `overflow: hidden` which cut off the icon; removed (scroll is handled by `#mode-bar-scroll`); closes #122
- fix: chart tooltip and corsair crosshair remained visible after lifting finger on mobile — added `touchend` listener to shot chart, P·Q chart and fullscreen chart that clears active elements and resets the crosshair; closes #122
- fix: sidebar action buttons (compare ⇄, delete 🗑) and collapse button had too little space from the right sidebar edge on mobile — increased `padding-right` on shot rows (12→18 px) and adjusted sidebar header padding in mobile breakpoint; closes #122

## 1.62.5
- fix: CSP header from v1.62.4 blocked all `onclick` event handlers — entire UI was non-interactive; added `'unsafe-inline'` to `script-src` (required: HTML contains ~57 inline handlers) and added `fonts.bunny.net` to `style-src` + `font-src` for Figtree font

## 1.62.4
- fix: `initProfilesCache` IIFE ran before `const state` / `const log` were declared (TDZ bug) — profile cache from v1.62.1 never actually loaded on startup; fix: moved `require` calls above the IIFE; closes #119
- fix: sync no longer crashes when machine `/latest` returns no `lastShotId` — added null-guard with early-return
- fix: `/api/restore` now rejects payloads with more than `MAX_SHOT_ID` shots to prevent DoS via oversized arrays
- fix: removed redundant `require('fs')` inside `/api/status` handler (was shadowing top-level import)
- fix: removed unused `getHaState` import in `routes/system.js`
- feat: `Content-Security-Policy` header added — allows `'self'` + `cdn.jsdelivr.net` (Chart.js + QRCode)

## 1.62.3
- fix: fullscreen chart now shows the vertical crosshair cursor line — `corsairPlugin` was registered on the main chart but missing from the fullscreen chart config; closes #118

## 1.62.2
- fix: drink type (Getränk) now actually saved — `drinkType` was missing from the annotation write in `POST /api/shots/:id/annotate`; closes #117
- fix: quickClone (← Letzten) now correctly restores drink type pill selection

## 1.62.1
- fix: profile list now persisted to `/data/profiles_cache.json`; loaded from cache on startup so `select.gaggiuino_profiler_profile` is immediately available even when the machine is off; live fetch updates cache, failed fetch falls back to cache; closes #116

## 1.62.0
- feat: profile proxy endpoints (`GET /api/machine/profiles`, `POST /api/machine/profile/set`) now call the Gaggiuino machine directly — no longer depend on ALERTua/hass-gaggiuino or `select.gaggiuino_profile`; profile list cached in `state.machineProfiles`; closes #115
- feat: new `GET /api/machine/status` endpoint — returns cached machine status (temp, pressure, waterLevel, weight, upTime, profileId/Name, brewSwitchState, steamSwitchState) from the 1 s live poll; `available: false` when machine has not been polled yet
- chore: `backgroundHaCheck()` no longer polls `sensor.gaggiuino_latest_shot_id` from HA — auto-sync continues to work via scheduled sync + `syncAfterBrew()`; removes a residual ALERTua dependency

## 1.61.1
- chore: remove PWA — delete Service Worker (sw.js) and Web App Manifest (manifest.json); remove manifest link from HTML; remove SW registration from JS; remove PWA section from docs and README; closes #114

## 1.61.0
- feat: light/dark theme toggle — CSS refactored to use 11 custom properties (--gray-200…950, --accent, --ok, --err); 303 hardcoded colour values replaced with var(); [data-theme="light"] override inverts the scale; theme stored in localStorage (glp_theme); toggle added as first card in Settings; closes #113
- feat: drink type annotation now uses pill/chip buttons instead of a native <select>; pills render from the menu, active pill highlighted in amber, click again to deselect; closes #112
- feat: new glp-ha-theme.yaml in repo root — installable HA themes "GLP Dark" and "GLP Light" covering sidebar, header, cards, inputs, switches, status colours; closes #113
- fix: P-Q chart no longer shows misleading filled triangle — switched from type:line/fill:true to type:scatter with showLine:true and fill:false; small point dots (r=1.5) give density indication; x-axis now auto-scales to actual max flow + 10 % headroom instead of fixed max:5; applied to both normal and fullscreen view; closes #111

## 1.60.0
- feat: shots — new "Drink" field in the annotation panel; populated from the same menu used by the orders feature (GET /api/menu, always accessible regardless of enable_orders); drink emoji + name shown as a subtle badge in the sidebar; closes #110

## 1.59.0
- feat: shots — annotation fields (all text inputs, numbers, roast date, textarea, star rating) auto-save 1 s after the last keystroke; a green "✓" indicator appears briefly next to the Save button; manual Save still works; closes #98
- feat: shots — primary shot selection and compare shot selection are persisted in `localStorage`; page reload restores the last viewed shot and active comparison; closes #100

## 1.58.0
- feat: orders — notify all mapped customers via HA push when shop opens (orders enabled → true); no-op when SUPERVISOR_TOKEN absent or mapping empty; closes #108
- feat: orders — menu items get `createdAt` timestamp on creation (for "New" badge in order card); closes #109
- feat: orders — menu items get `trending` boolean (default false); PUT `/api/orders/menu/:id` accepts `trending`; barista can toggle trending via 🔥 button in menu admin; closes #107
- feat: orders — browser notification + chime when new pending orders arrive on barista side; permission requested on first visit to orders view; closes #99
- feat: shots — `orderedBy` badge shown in annotation panel when a shot was linked to an order (customer name in amber badge); closes #106

## 1.57.1
- fix: clicking a shot in the left sidebar from any non-shots view now switches to shots mode — previously `updateView()` ran but the shots view stayed hidden (`display:none`); also fixes `goToShot()` scroll timing (requestAnimationFrame → setTimeout 50 ms so layout is computed after display change); closes #104

## 1.57.0
- feat: sync retry with exponential backoff — on machine connection failure the scheduler retries 3 times before returning to the regular interval (30 s → 60 s → 120 s); `syncShots()` now returns a boolean; `state.syncRetryCount` and `GET /api/status` expose the current retry attempt; closes #102

## 1.56.0
- feat: global `goToShot(id)` — clicking any shot reference from any view instantly switches to Shots mode, selects the shot, and scrolls the sidebar to it; closes #104
  - Analytics calendar: day cells are now clickable — navigates to the most recent shot of that day
  - Analytics trend chart: clicking a data point navigates to that shot; tooltip shows "↗ Shot anzeigen"
  - Orders history: completed orders with a linked shot show a "Shot #N" badge that navigates on click
  - Dial-in cards: simplified to use `goToShot()` (was `selectShot + switchMode`)

## 1.55.0
- fix: Dockerfile runtime stage now copies `lib/` and `routes/` directories — v1.54.0 crashed on startup with `Cannot find module './lib/constants'` because the multi-stage build only copied `server.js`; closes #103
- feat: OpenAPI 3.0.3 spec — all 42 API endpoints documented with request/response schemas; served as JSON at `GET /api/openapi.json` (no auth required); spec committed as `openapi.yaml`; closes #101

## 1.54.0
- refactor: split monolithic `server.js` (~1340 lines) into `lib/` modules (`constants`, `helpers`, `state`, `data`, `ha`, `live-sync`) and `routes/` modules (`shots`, `library`, `maintenance`, `orders`, `system`, `backup`, `import`); `server.js` reduced to ~85-line entry point; closes #97
- security: `writeFileSafe()` — all JSON writes now use atomic rename-swap (write to `.tmp`, then `fs.renameSync`) to prevent half-written files on crash; closes #97
- security: `withFileLock()` async mutex per file — prevents interleaved load→modify→save races under concurrent requests; closes #97
- security: `haUserId` in order placement now prefers the `X-GLP-HA-User-ID` header (set by glp-integration from the authenticated HA session) over the client-supplied body field — prevents user impersonation; closes #97
- fix: `/api/restore` body limit raised to 50 MB before the global 16 kB limit is applied — previously large restores were silently rejected; closes #97

## 1.53.0
- feat: HA push notifications for orders — barista configures a per-customer `haUserId → notify.<device>` mapping in the backend UI (Orders → Push-Benachrichtigungen); the add-on calls the configured `notify.*` service via Supervisor API on accept, complete, and decline; mapping stored in `/data/notify_mapping.json`; new endpoints: `GET /api/orders/notify-services`, `GET /api/orders/notify-mapping`, `POST /api/orders/notify-mapping`; no-op when `SUPERVISOR_TOKEN` is absent; closes #96

## 1.52.0
- fix: ETA preset buttons ("2 min" etc.) now sync their value into the custom input field — previously `acceptOrder()` always read the input's stale default (5); also: typing in the custom input now deselects all preset buttons; closes #94
- feat: orders history management — per-entry delete button (trash icon) on each done/declined order card; "Verlauf löschen" button clears all history at once; backend: `DELETE /api/orders/:id` and `DELETE /api/orders/history`; closes #94

## 1.51.4
- fix: sidebar delete icon barely visible — color raised from `#3f3f46` to `#71717a`

## 1.51.3
- fix: sidebar delete button — replace `🗑` emoji (uncontrolled size, clipped by overflow:hidden) with MDI trash SVG; 28×28 px hit target, red hover tint matching library buttons; closes #93
- fix: sidebar collapse/expand buttons — replace `‹`/`›` characters with MDI chevron SVGs; `margin-left: auto` pushes the button to the far right of the header so it no longer sits cramped against the flap-board digits

## 1.51.2
- fix: library edit/delete buttons now use Material Design SVG icons (pencil + trash-can-outline) instead of text labels — no more clipping on mobile, consistent with MDI design language; permanent-delete button in trash view also replaced (`✕` → trash icon); icon buttons have a 28×28 px minimum hit target; closes #92

## 1.51.1
- fix: Library view mobile layout — form grid breakpoint raised to 640px so fields stack on actual phones; lone last field spans full width; bean card actions move to a separate row below the info text on narrow screens; action buttons use flat ghost style (no border box); closes #91

## 1.51.0
- feat: `/api/preheat` now includes `targetTemp` (current target temperature in °C from the machine); `currentTargetTemp` is persisted across polling cycles so the value survives temporary zero readings; closes #85

## 1.50.1
- Fix: Vite default `base: '/'` generated absolute asset paths (`/assets/…`) that break under HA ingress; set `base: './'` so paths are relative and work at any ingress sub-path

## 1.50.0
- Refactor: split `public/index.html` monolith (~5500 lines) into Vite + vanilla JS modules under `public-src/`; 19 ESM modules across `views/`, `components/`, and shared helpers; mutable state consolidated in `state.js`; Vite bundles CSS + JS into `public/assets/` at build time; closes #87

## 1.49.3
- Fix: `setOrdersEnabled()` silently swallowed save errors and showed optimistic "aktiv" toggle state even when the server write failed; on error the UI now re-fetches the actual server state and reverts the toggle accordingly; closes #86

## 1.49.2
- Security: validate `x-ingress-path` header value against expected slug path instead of mere presence check — prevents auth bypass via header spoofing
- Security: add `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy` response headers
- Security: in-memory rate limiting on write endpoints — library mutations (30/min), order placement (10/min), restore (3/min)
- Security: maintenance threshold values validated to sane ranges (shots: 1–10000, days: 1–365); closes #84

## 1.49.1
- Docs: update architecture diagram and component descriptions to reflect all four GLP components (add-on, integration, Shot Card, Order Card); add GLP Order Card section; update "three components" references

## 1.49.0
- Feature: order system is now opt-in — new config option `enable_orders` (default `false`); Bestellungen tab is hidden when disabled; all `/api/orders/*` endpoints return 404 when disabled; `GET /api/status` exposes `ordersFeature` flag; closes #83

## 1.48.0
- Feature: shot tagging — `POST /api/orders/:id/complete` merges `orderedBy: { customer, haUserId, orderId }` into the shot annotation (non-destructive, existing annotation fields preserved); closes #81
- Feature: customer statistics section in Bestellungen tab — collapsible panel showing global totals (total completed orders, most popular drink) and per-customer cards (total, favourite drink, last order date); computed client-side from existing order history; closes #82

## 1.47.0
- Feature: shot summary for order card — `POST /api/orders/:id/complete` now stores `shotId` (ID of the last non-trashed shot at completion time); new public endpoints `GET /api/shots/last` and `GET /api/shots/:id` for customer card shot retrieval; closes #80

## 1.46.0
- Feature: order acceptance toggle — barista can pause/resume order acceptance from a toggle switch at the top of the Bestellungen tab; when paused, `POST /api/orders` returns 503; customer card shows "Bestellungen momentan pausiert"; state persisted in `/data/orders_settings.json`; closes #79

**New server endpoints:**
- `GET /api/orders/settings` — public; returns `{ enabled: bool }`
- `POST /api/orders/settings` — auth; sets `{ enabled: bool }`

## 1.45.0
- Feature: order management system — new "Bestellungen" tab in the GLP web UI for barista order management; order flow: pending → accepted (with ETA picker: 2/5/10/15/20 min or custom) → done; barista can also decline with a free-text reason; order queue auto-refreshes every 10 s; order tab badge shows number of pending orders; machine-off banner when switch entity is configured and off; menu management (add/delete drinks with emoji) stored in `/data/menu.json`; default menu: Espresso, Ristretto, Lungo, Cappuccino, Latte Macchiato, Flat White; customer orders via new REST endpoints (see below); completed orders auto-pruned after 7 days; all 5 languages translated (DE/EN/IT/FR/ES); closes #77

**New server endpoints:**
- `GET /api/orders/menu` — public, returns menu items
- `POST/PUT/DELETE /api/orders/menu/:id` — menu CRUD (auth required)
- `GET /api/orders` — all orders barista view (auth required)
- `GET /api/orders/mine?haUserId=` — customer's own orders (auth required)
- `POST /api/orders` — place order (auth required)
- `POST /api/orders/:id/accept` — accept with ETA (auth required)
- `POST /api/orders/:id/complete` — mark done (auth required)
- `POST /api/orders/:id/decline` — decline with reason (auth required)

## 1.44.0
- Feature: expose `/api/machine/profiles` (GET) and `/api/machine/profile/set` (POST) endpoints — proxy to HA `select.gaggiuino_profile` entity via Supervisor API; used by the GLP Lovelace card; gracefully returns `{ available: false }` when the Gaggiuino HA integration is not installed; closes #76

## 1.43.1
- Fix: add-on failed to start on Node.js 18 — cheerio pulls in undici which references the `File` global added only in Node.js 20; added polyfill using `buffer.File` (available since Node.js 18.13.0) at the top of server.js; closes #75

## 1.43.0
- Feature: import coffee from kaffeebraun.com URL — paste any product URL from kaffeebraun.com into the new 🔗 URL field in the Library tab; the server fetches and parses the page (cheerio) and pre-fills name, roaster, origin, aromas, roast level and processing method; imported beans show "Imported from kaffeebraun.com · date" in the bean card; closes #74

## 1.42.2
- Fix: barcode scan showed no feedback when product not found — status message was set on the already-hidden modal; modal now stays open for 1.8 s to show the result before auto-closing and opening the form; same fix for network errors; closes #73

## 1.42.1
- Fix: Dial-In cards showed '–' for pressure — `getShotData()` returns `{x,y}` objects from `mapToXY()` but the pressure filter treated them as raw numbers; fixed to read `pt.y` correctly; closes #72

## 1.42.0
- Feature: PWA support — GLP can now be installed as a standalone app via "Add to Home Screen" on Android and iOS; app shell (index.html, fonts, Chart.js, qrcode.js) is cached by a service worker for instant load; API calls and shot data always go to the network; closes #27

## 1.41.0
- Feature: barcode and QR scanner in coffee library — tap the Scan button next to "Add Bean" to scan any EAN/UPC barcode or QR code; EAN/UPC codes are looked up via the Open Food Facts API (no key required); the GLP QR schema (`glp://coffee?name=...`) enables instant full import; each bean card now has a QR button that generates a shareable QR code; closes #70

## 1.40.0
- Feature: grinder cleaning schedule in Maintenance tab — each grinder from the library gets its own maintenance card with a configurable shot or day threshold; marking done and adjusting thresholds work identically to built-in machine tasks; deleting a grinder from the library also removes its maintenance entry; closes #65

## 1.39.0
- Fix: maintenance threshold UI now shows a Shots/Days toggle — only one mode is active at a time; switching mode saves immediately and resets the value to a sensible default (shots: 200, days: 30); tasks that previously had both thresholds set default to shots mode; closes #69

## 1.38.0
- Fix: removed redundant `port` option from add-on options — the port is always fixed at 8099 internally; users who need a different external port use the HA Netzwerk port-mapping panel; closes #66
- Fix: `machine_url` option renamed to `machine_host` — enter only the hostname or IP (e.g. `gaggia.intern` or `192.168.1.100:8080`); the `/api/shots` path is appended automatically; full URLs (with `http://`) continue to work for backwards compatibility; closes #67

## 1.37.0
- Fix: all user-visible error and status strings now go through the `t()` translation system — delete errors, load errors, restore errors and live-status labels (`ready`/`brewing`/`error`) are now shown in the selected UI language (DE/EN/IT/FR/ES); closes #68

## 1.36.0
- Fix: active tab not scrolled into view on mobile — switching tabs no longer leaves the tab bar scrolled to a position where earlier tabs (e.g. "Shots") are partially hidden; `switchMode()` now calls `scrollIntoView` on the active button after each switch; closes #64
- Fix: library bean/grinder edit form stayed 2-column on narrow screens — `.lib-form-grid` now collapses to single column at ≤ 480 px
- Fix: added `-webkit-overflow-scrolling: touch` to `#mode-bar-scroll` for smooth momentum scroll on iOS
- Fix: tab padding reduced to `12px 10px` and font to `.75rem` at ≤ 480 px so more tabs fit without scrolling; all content views use `12px` padding on narrow screens

## 1.35.0
- Feature: preheat timer survives add-on restarts — `switchOnAt`/`switchOffAt` persisted in `/data/preheat_state.json`; state is restored on startup if younger than 24 h; if temperature is already stable at target (rolling variance of last 60 readings < 1.5 °C²) the preheat is auto-completed immediately; closes #63
- Fix: shot calendar (`Shot-Kalender`) was clipped on the right side — container width was sampled once at render time via `offsetWidth`; switched to `getBoundingClientRect().width` and added a `ResizeObserver` so the calendar redraws when the container resizes (e.g. sidebar toggle)
- Chore: removed all emoji characters from server.js log output and translated remaining German log strings to English

## 1.34.1
- Security: API token is now auto-generated at first start (64-char cryptographically random hex via `crypto.randomBytes(32)`) and persisted in `/data/api_token.txt` — no user configuration required; token is distributed transparently via `/api/status` (public endpoint); browser UI and HA integration fetch and use it automatically; closes #60

## 1.34.0
- Security: optional API token for direct port 8099 access — set `api_token` in add-on options; if set, all `/api/*` and `/shots.json` requests must include the `X-GLP-Token` header (HA Ingress requests bypass this check as they are already authenticated by HA); browser UI reads token from localStorage and shows a token-entry modal on 401; closes #59

## 1.33.1
- Fix: firmware version not displayed in GLP header — `fetchMachineVersion()` was called only once at startup; if the machine was off or slow to respond, the version was never retried; now retried every 30 s until successfully fetched; closes #58

## 1.33.0
- Feature: export Gaggiuino-compatible profile JSON from any shot — if the shot contains the original profile (phases array), it is exported directly with annotation data merged into the recipe; if not, a profile is generated from the shot's target pressure/flow datapoints with auto-detected preinfusion and extraction phases; button "↓ Profil" added to the shot toolbar; closes #36

## 1.32.6
- Fix: sidebar hint text was hardcoded German ("Klicke auf den Namen für Shot A …") — wired to new `sidebar_hint` translation key via `data-i18n-html`; added `data-i18n-html` support in `applyTranslations()` for HTML-containing strings; added `sidebar_collapse` / `sidebar_expand` tooltip keys for collapse/expand buttons; closes #57

## 1.32.5
- Fix: live chart x-axis was 10× too stretched — `timeInShot` was pushed as `elapsed × 10` but `elapsed` is already in 100ms units (the correct Gaggiuino format); removed the extra ×10
- Fix: live meta line showed "Shot undefined" — `shotId` doesn't exist during a live brew; replaced with profile name only

## 1.32.4
- Fix: live polling never started when machine was already on at add-on startup — `machineOn` defaulted to `true`, so `checkAndApplyMachinePower()` saw no state change and returned early without calling `startLivePolling()`; changed default to `false` so the first check always triggers the transition and starts polling

## 1.32.3
- Fix: `/api/system/status` returns an array — brew detection was always false because `statusRes.data.brewSwitchState` is `undefined` on an array; fixed with `Array.isArray(raw) ? raw[0] : raw`; also removed dead fallback field names (`brewActive`, `isBrewing`) — firmware only uses `brewSwitchState`; closes #38

## 1.32.2
- Fix: live chart was destroyed immediately on tab open — `initLiveChart()` was called before `connectLiveStream()`, which calls `disconnectLiveStream()` internally and sets `liveChart = null`; moved `initLiveChart()` inside `connectLiveStream()` so the chart is always created after cleanup; closes #38

## 1.32.1
- Security: prototype pollution fixed — maintenance task routes now validate against an explicit allowlist instead of bare property lookup (`VALID_MAINTENANCE_TASKS`)
- Security: `lastSyncError` no longer exposes raw internal URLs in `/api/status` — URLs are stripped before storing the error message
- Security: restore endpoint now requires `coffee_library` to be an object before writing to disk

## 1.32.0
- Feature: live reference shot is now auto-selected — when a brew starts the most recent shot with the same profile name is automatically applied as the dashed overlay; user can still override via the dropdown or clear it; closes #51

## 1.31.1
- Fix: preheat status label now shows configured warmup duration (e.g. "Aufheizen … · 20 min") alongside the countdown

## 1.31.0
- Feature: preheat / ready-to-brew timer — after the machine switches on, the Live tab shows a progress bar and countdown until the configured warmup time elapses; configurable via `preheat_time` option (default 20 min); timer does not reset on brief off/on cycles if the machine is still warm (temp > 80 °C and off for < 5 min); exposed via `/api/preheat` and as HA sensors (`preheat_ready`, `preheat_elapsed`, `preheat_remaining`) through the companion integration; closes #50

## 1.30.5
- Fix: maintenance `ok` status label was hardcoded as `'✓ OK'` and bypassed the translation system — now uses `t('maint_ok')` with proper translations in all 5 languages (DE/EN/IT/FR/ES)

## 1.30.4
- Fix: Maintenance tab cards now use a responsive 2-column grid on wider screens (≥ ~870 px) instead of a fixed 520 px single column; closes #49

## 1.30.3
- Fix: empty space to the left of the first tab removed — sidebar expand button now uses `display:none` instead of `opacity:0` so it takes no space when invisible; mode-bar padding reduced from 36px to 4px

## 1.30.2
- Fix: Live tab no longer shows as empty space before first status poll — button starts hidden in HTML and is only revealed once the switch state is known; fallback to visible if switch API is unreachable; closes #48

## 1.30.1
- Fix: Live tab is now always the leftmost tab and hidden entirely when the switch entity reports the machine as off (previously shown disabled); auto-redirects to Shots when machine turns off mid-session; no switch configured → tab always visible; closes #48

## 1.30.0
- Feature: reference curve in live mode — select any previous shot as a dashed overlay on the live chart; pressure, flow, weight and temperature shown semi-transparent in matching colors; selector persists across live mode re-entries; closes #24

## 1.29.1
- Fix: added `ports: 8099/tcp: 8099` to config.yaml — port is now exposed on the host network so the companion HA integration can connect; closes #47

## 1.29.0
- Feature: Maintenance tab — new "Wartung" tab with 5 maintenance cards: Entkalken, Backflush, Gruppenköpf Service, Dichtungen & Siebe, Wasserfilter; each card shows days/shots since last done, a color-coded progress bar, configurable thresholds, and a "Jetzt erledigt" button; red dot badge on the tab when any task is overdue; data persisted in `/data/maintenance.json`; all strings translated DE/EN/IT/FR/ES; closes #46

## 1.28.2
- Fix: mode bar no longer cuts off on mobile — nav tabs scroll horizontally (hidden scrollbar); ⚙ settings button is always visible, pinned right with a separator; closes #45
- Fix: settings view now scrollable on mobile — `min-height: 0` on `#settings-view` and `#main` allows flex children to scroll correctly; closes #45

## 1.28.1
- Polish: flap counter moved inline into the sidebar header — right-aligned next to the ‹ collapse button; smaller cells (20×30px) that fit without adding a separate block

## 1.28.0
- Feature: split-flap shot counter — Fallblattanzeige-style display at the top of the sidebar shows total shot count; digits flip individually with a staggered animation on load and whenever the count changes; closes #44

## 1.27.0
- Feature: configurable server port — new `port` option (default 8099, range 1024–65535) lets you change the listen port if 8099 is already in use; closes #42

## 1.26.1
- Polish: `nav_analytics` tab label now translated in all 5 languages (DE: Statistiken, IT: Statistiche, FR: Statistiques, ES: Estadísticas); closes #41
- Polish: sidebar expand button (›) is now transparent/borderless — matches the flat mode-bar style instead of showing a dark box; closes #41
- Polish: removed duplicate "☕ Bibliothek" button from annotation panel — Library tab in mode bar already provides this; closes #43

## 1.26.0
- Feature: Quick-Clone — "↩ Letzten" button in annotation panel copies bean, grinder, grind setting, dose and roast date from the previous shot; closes #21
- Feature: Keyboard shortcuts — ← / → arrow keys navigate between shots when no input is focused; closes #23
- Feature: Firmware version per shot — new shots are tagged with the controller firmware version at sync time and shown in the shot header; closes #35
- Feature: Bohnen-Inventar — optional "Vorrat (g)" field per bean in the library; shows consumed grams (from dose annotations), remaining stock, and a reorder badge when < 100 g left; closes #29

## 1.25.3
- Polish: "Einwählen" tab renamed to "Bezugslog" (DE) — better German

## 1.25.2
- Fix: live polling and sync pause when smart plug is off — `checkAndApplyMachinePower()` checks switch state on startup and every 30 s; polling resumes automatically when machine turns on; closes #39
- Polish: sidebar footer merged into one row — sync status, version badge, and sync button on a single line; version badge color lightened to be readable; closes #40

## 1.25.1
- Polish: Settings tab (⚙) in mode bar replaces sidebar footer controls — language switcher and Backup & Restore moved into a dedicated settings view with card layout; footer simplified to version badge only

## 1.25.0
- Feature: Backup & Restore — download all data (shots, annotations, coffee library, blocklist, trash) as a JSON file; restore via file upload; closes #26
- Feature: Degassing Tracker — roast date input in annotation panel now shows a colored progress bar with days since roast and a status label (too fresh / almost / optimal / aging / old); closes #28
- Feature: Dial-In Mode — new "Einwählen" tab shows the last N shots as metric cards (pressure, duration, dose, ratio, EY %) for quick grind adjustment; closes #22
- i18n: all new strings translated in DE / EN / IT / FR / ES

## 1.24.2
- Polish: sidebar footer split into two rows — sync status top, version + language bottom; cleaner layout
- Docs: README documentation links now point to GitHub Wiki (EN + DE)

## 1.24.1
- Fix: shot calendar no longer hides recent shots — minimum cell size lowered from 7px to 4px so all 52 weeks always fit within the container without cutting off the right side
- Docs: DOCS.md and DOCS.de.md replaced with short stubs; full documentation moved to GitHub Wiki

## 1.24.0
- Feature: Live mode shot timer ticks smoothly every 100ms (client-side wall clock, re-synced with machine data each poll) — no more 1-second jumps in the time display; closes #25
- Feature: Language switcher is now a compact dropdown instead of 5 inline buttons — saves space in the sidebar footer, same localStorage persistence

## 1.23.2
- Fix: shot calendar no longer requires horizontal scrolling — cell size is calculated dynamically from the available container width (min 7px), fits all 52 weeks on any screen size

## 1.23.1
- Fix: analytics layout no longer overflows horizontally — added `min-width: 0` to `#main`, `#analytics-view`, and `.analytics-card`; grid columns use `minmax(0, 1fr)` instead of `1fr`

## 1.23.0
- Feature: Multi-language UI — DE / EN / IT / FR / ES selectable via language switcher in sidebar footer
- Language auto-detected from browser (`navigator.language`), persisted in `localStorage`
- All UI strings translated; dynamic strings (grind advice, confirm dialogs, freshness badge) use `t()` helper
- Date formatting follows selected locale (`Intl` / `toLocaleString`)
- Fix: Analytics container no longer has a fixed max-width — uses full screen width on desktop and scales correctly on mobile

## 1.22.0
- Feature: Coffee Library is now a dedicated top-level tab ("Bibliothek") in the mode-bar — no longer a modal overlay
- The "☕ Bibliothek" button in the annotation panel switches to the new tab

## 1.21.1
- Fix: roastDate and tds now correctly persisted in annotation endpoint (were silently dropped, causing data loss after page reload)
- Fix: removed undefined broadcastLive() call in syncAfterBrew() — silent ReferenceError swallowed by catch block
- Fix: removed dead liveClients Set (leftover from SSE removal in v1.19.3)
- Hardening: server-side field length limits added to all library endpoints (name 200, roastDate 10, notes 1000)

## 1.21.0
- Feature: Analytics tab — new dedicated view with 4 sections
- Analytics: Score-Trend chart with 5-shot moving average (filter: last 30 / 90 / all shots)
- Analytics: Shot calendar — GitHub-style heatmap showing shot activity over the last 52 weeks
- Analytics: Bohnen-Auswertung — stats per bean (shot count, avg score, best score, avg duration)
- Analytics: Profil-Performance — horizontal bar chart with avg score per profile

## 1.20.1
- Fix: expand button (›) and mode tabs stay visible when scrolling with sidebar collapsed — mode-bar uses `position: sticky`

## 1.20.0
- Feature: Coffee Library — save beans (name, roaster, roast date, notes) and grinders in a persistent library (`/data/coffee_library.json`)
- Annotation panel: coffee and grinder fields now have browser autocomplete from library entries
- Annotation panel: roast date auto-fills when a library bean is selected and the field is empty
- Annotation panel: "☕ Bibliothek" button opens library management modal (add, edit, delete)
- Sidebar footer: current GLP version shown as subtle badge next to sync button

## 1.19.4
- Fix: server crash on start — removed leftover `broadcastLive()` call after SSE removal

## 1.19.3
- Fix: live mode replaced SSE/EventSource with fetch-polling — HA's ServiceWorker was blocking EventSource connections through ingress (#7)
- Server polls machine every second continuously (not only when client is connected)
- Frontend polls `api/live/data` every second; auto-reloads shot list when brew ends

## 1.19.2
- Fix: live mode brew detection now accepts `brewSwitchState`, `brewActive`, or `isBrewing` fields — handles multiple Gaggiuino firmware versions (#7)
- Debug: `GET api/debug/machine` shows raw `/api/system/status` response from controller
- Polish: sidebar collapse transition uses `cubic-bezier` + `will-change` for smooth GPU animation
- Polish: sidebar children get `min-width: 320px` so content doesn't reflow during transition

## 1.19.1
- Mobile: meta-items now horizontal (label left, value right) — halves the height of each row
- Mobile: phases (Preinfusion / Extraktion) moved from meta-grid into header subtitle area, saving a full row (#5)

## 1.19.0
- Machine firmware version shown next to hostname in shot header (fetched from controller `/api/system/info` on startup, silently ignored if endpoint not available)

## 1.18.9
- Fix: permanently deleted shots added to blocklist — sync never re-fetches them from machine (#1)
- Fix: machine subtitle shows hostname from server (`machineHostname` in `/api/status`), no client-side URL parsing (#9)

## 1.18.8
- Polish: sidebar slides in/out smoothly (0.3s ease transition on width)
- Expand button › fades in/out instead of hard show/hide

## 1.18.7
- Fix: sidebar collapse button ‹ now inline with "Shots" heading (missing `display:flex` on h2)

## 1.18.6
- Polish: sidebar collapse button ‹ styled as proper pill button (dark bg, border, rounded) with hover state

## 1.18.5
- Fix: sidebar collapse button ‹ now visible — color changed from near-black to visible gray, slightly larger

## 1.18.4
- Fix: sidebar collapse (‹/›) now works in HA companion app — removed viewport width guard that prevented collapse when `window.innerWidth ≤ 768`
- Fix: ‹ button flips to › when sidebar is collapsed and back on expand

## 1.18.3
- Trash bin: 🗑 button moves shot to trash instead of permanent delete
- Trashed shots hidden from main sidebar, shown in collapsible Papierkorb section
- Each trashed shot shows days remaining until auto-deletion (30 days)
- Restore (↩) and permanent delete (✕) per trashed shot
- Server: auto-purges expired trash on startup and daily
- Fixes issue #6

## 1.18.2
- Fix: shot delete fetch URL used absolute path (/api/...) — changed to relative (api/...) so requests correctly route through HA ingress

## 1.18.1
- Fix: shot delete used HTTP DELETE which HA ingress proxy blocks — changed to POST /api/shots/:id/delete

## 1.18.0
- Shot delete: trash button in sidebar removes shot + annotation permanently (with confirmation)
- Sidebar collapsible on desktop: ‹/› toggle button gives full-width chart view
- Mobile: chart legend now always visible (compact size on small screens)
- Mobile: meta-grid stays 2-column, tighter spacing — less scrolling before chart

## 1.17.9
- Fix: CSV export now exports only the currently selected shot (not all shots)
- Fix: CSV headers use ASCII only — no more encoding issues in Excel/Numbers
- Fix: CSV filename includes date and profile (e.g. `glp_shot_2026-05-18_Adaptive.csv`)
- New: `exportAllCSV()` available for exporting all shots at once

## 1.17.4
- feat: fullscreen chart (⤢ button) — time and P·Q chart as fullscreen overlay, ideal for landscape on mobile
- fix: Corsair plugin null-check prevents "Cannot destructure property 'x'" error
- fix: Chart.getChart() before each chart creation prevents "canvas already in use" (was causing invisible charts on mobile)
- fix: Chart.js scale ID `temp` → `y1` fixes right Y-axis (was showing max=6 instead of ~98)
- server: Cache-Control no-cache for HTML prevents caching in HA app

## 1.17.0
- fix: Chart.js scale ID `temp` → `y1` — fixes mobile rendering bug (right Y-axis showed max=6 instead of ~98 on Android/HA app)
- fix: debug panel improved — try-catch + "timeout ran" marker for better error diagnosis

## 1.16.0
- Steckdosen-Steuerung: `switch_entity` Konfigurationsoption – ⏻ Button in der Sidebar zum Ein-/Ausschalten der Maschine via HA-Switch
- Live-Tab Sperrung: Live-Ansicht automatisch deaktiviert wenn `switch_entity` konfiguriert und Maschine ausgeschaltet ist
- README: vollständig überarbeitet mit Feature-Tabelle, Konfiguration, HA-Dashboard-Karte, Architekturübersicht

## 1.15.0
- Mobile: Sidebar als Overlay-Drawer von links (HA-Sidebar-Stil) mit Backdrop
- Export: ↓ .shot Button für aktuellen Shot (Decent Espresso Format, Visualizer.coffee-kompatibel)
- DOCS.md: vollständige englische Dokumentation hinzugefügt

## 1.14.0
- Chart-Beschriftung: Druck/Fluss etc. zeigen (A)/(B) nur im Vergleichsmodus
- Sortierung: zweiter Klick auf aktiven Sort-Button kehrt Reihenfolge um (↑/↓)
- Mobile: Tippen außerhalb der Sidebar schließt diese
- Maschinentitel unter dem Shot-Namen zeigt jetzt den konfigurierten Hostnamen dynamisch
- Mobile Chart: erzwungener Resize nach Initialisierung behebt leere Canvas in HA-App
- Röstdatum: Eingabe und Anzeige jetzt im deutschen Format (TT.MM.JJJJ)
- Release-Tags v1.12.0 und v1.13.0 auf GitHub erstellt

## 1.13.0
- Shot-Score in Sidebar: jeder Shot zeigt farbige Score-Pill direkt im Listeneintrag
- Sortierung: Sidebar sortierbar nach Neueste / Score / Bewertung / Dauer
- P·Q Diagramm: zweiter Chart-Tab zeigt Druck vs. Pumpenfluss (Extraktions-Signatur)
- Röstdatum + Frische-Badge: Tage seit Röstung neben Kaffee-Name angezeigt
- Extraction Yield (EY %): automatisch berechnet wenn TDS und Dosis eingetragen
- Mahlgrad-Empfehlung: Hinweis basierend auf Bezugsdauer und Channeling-Erkennung
- Fix: Verbindungsfehler in Sidebar unterscheidet jetzt zwischen Netzwerkfehler (mit Retry-Button) und JavaScript-Fehlern

## 1.12.0
- Mobile: Hamburger-Icon (☰/✕) links in der Sidebar-Kopfzeile ersetzt den Text-Toggle-Button
- Fix: Shot-Score wird nicht mehr für Test-/Leerlauf-Shots angezeigt (Score setzt aktiven Extraktionsdruck ≥5 bar voraus)

## 1.11.1
- DOCS.md: Shot-Score-Berechnung vollständig dokumentiert (Faktoren, Gewichtungen, Farbskala)

## 1.11.0
- Shot-Score (0–100): automatisch berechnet aus Extraktionsdruck, Temp-Stabilität, Dauer, Ratio und Channeling
- Phasen-Visualisierung: deutlichere Hintergrundzonen + farbige Pill-Labels im Chart
- Responsive / Mobile: einklappbare Sidebar, kompaktes Layout, Auto-Collapse beim Shot-Auswahl
- Sidebar-Toggle-Button (mobile)

## 1.10.2
- Neues Add-on Icon: Druckprofil-Kurve über Espresso-Cup (icon.png, 512×512)

## 1.10.1
- Phasen-Visualisierung im Chart: Preinfusion (blau) und Extraktion (orange) als Hintergrundzonen mit Trennlinie und Labels

## 1.10.0
- Suche/Filter in der Shot-Seitenleiste (nach Profil, Kaffee, Mühle)
- Dose → Yield → Ratio-Berechnung (z.B. 18g → 36g · 1:2.0)
- Temperatur-Stabilität (±σ) als Metrik in der Shot-Ansicht
- Phasen-Erkennung: Preinfusion und Extraktion mit Zeitangaben
- Channeling-Warnung bei plötzlichem Druckabfall (>1.5 bar)
- CSV-Export aller Shots mit Annotationen
- Live-Modus: Shot-ID nach Bezugsende eingeblendet + automatische Shot-Liste aktualisiert
- server.js: Poll-Stacking-Guard verhindert gestapelte Requests
- server.js: Validierung eingehender Shot-Daten vom Controller

## 1.9.0
- Live-Modus: Controller direkt via `/api/system/status` abfragen statt HA-Sensoren – sofortige Brew-Erkennung ohne 30s Delay
- HA-Integration im Hintergrund (30s) für Auto-Sync via `latest_shot_id`

## 1.8.0
- HA-Sensor-Integration für Live-Modus: `brew_switch`, Druck, Temp, Gewicht, Shot-ID
- Auto-Sync bei steigender `gaggiuino_latest_shot_id`

## 1.7.1
- Fix: EACCES-Fehler beim Lesen von `/data/options.json` behoben (non-root User entfernt)

## 1.7.0
- Sicherheits-Audit: XSS-Schutz, Body-Limit, URL-Validierung, Shot-ID-Bounds
- HA best practices: `homeassistant_api: true`, Ingress-Konfiguration
- Vollständige Dokumentation (DOCS.md) und README aktualisiert

## 1.6.0
- Live-Modus: Echtzeit-Anzeige während eines laufenden Bezugs (SSE)
- Notizen-Panel unter den Chart verschoben
- Live-Polling via SSE-Endpoint `/api/live`

## 1.5.0
- Kaffee-Notizen: Bohne, Mühle, Mahlgrad, Dosis, Freitext
- Sternebewertung (1–5) pro Shot
- App-Icon und Favicon

## 1.4.0
- `machine_url` und `sync_interval` konfigurierbar über HA Add-on Optionen
- UI-Verbesserungen: Ladezustände, Leer-Zustand, Sidebar-Verbesserungen
- Dokumentation (DOCS.md, README.md)

## 1.3.9
- Fix: Ingress-Kompatibilität für relativen API-Pfad
- Persistenz: Daten unter `/data` gespeichert

## 1.3.6
- Fix: API-Endpunkt für Ingress-Kompatibilität angepasst

## 1.2.0
- SD-Karten Sync via Gaggiuino HTTP API

## 1.0.0
- Erste Version: Lokales Dashboard für die Gaggiuino-Espressomaschine
