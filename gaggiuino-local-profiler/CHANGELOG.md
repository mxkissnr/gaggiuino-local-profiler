## [Unreleased]

### Added
- **Coffee flavor wheel** — a 🎡 button on beans with tasting notes opens a sunburst chart of the coffee flavor hierarchy (structure after the SCA/WCR Coffee Taster's Flavor Wheel, 2016 — our own derived data with German + English labels, no original artwork used) with the bean's matched flavors and their ancestor categories highlighted, everything else dimmed. Matching goes exact label → German alias table (`Zartbitterschokolade` → dark chocolate, `Nougat` → hazelnut, …) → word-boundary containment (`getrocknete Aprikose` → apricot), diacritics-insensitive; unmatched flavors are listed as plain chips below the wheel. Rendered with ECharts (already loaded for the world map); the matching logic lives in `flavor-match.js`, framework-free and unit-tested independently of the DOM. Closes #238

### Changed
- **Interactive world map** — the Statistics origin map now runs on Apache ECharts instead of chartjs-chart-geo: scroll/pinch to zoom, drag to pan, and each bean shows as a pulsing point at its geocoded region (or a jittered country centroid as fallback) alongside the shot-count choropleth. The vendored topojson is unchanged, converted client-side via topojson-client; both libraries come from the CDN with the same offline guard and empty state as before. Closes #237

### Added
- **Import provider: elbgold.com** — the URL import now also accepts Hamburg roaster elbgold's Shopify product pages. Since elbgold ships no structured spec table (just German prose), extraction is best-effort: tasting notes from a "Noten von …" sentence, growing region from a "Herkunft – …" heading, origin country by scanning the whole description for exactly one coffee-growing country name (`findCountryInText` in `lib/coffee-countries.js` — ambiguous/multi-country text stays unmapped), roast profile from the Espresso/Filter shop tags, decaf from the title. The Shopify product-JSON rewrite (`shopifyJsonUrl`) is now shared between Hoppenworth & Ploch and elbgold. Closes #236
- **Growing region + automatic geocoding** — beans get a `region` field (form input; the Hoppenworth & Ploch import stores its Herkunft district there instead of the notes). After saving, the backend resolves "region, country" to coordinates via Nominatim (fire-and-forget, custom user agent, ≥1.1 s request spacing, kv-cached including misses) and stores them as `bean.location` — the upcoming interactive map places bean points there. Changing the region re-geocodes; hosts without internet simply keep the country-level fallback. Closes #235
- **Roast profile field** — beans carry `roastType` (espresso / filter / omni) as a select in the form and a blue badge next to the bean name. Imports derive it from the shop tags (Hoppenworth & Ploch, and elbgold once added): espresso tag → espresso, filter tag → filter, both → omni. `beans-info` exposes it for the cards. Closes #234
- **Structured tasting notes (flavors)** — beans get a `flavors[]` tag list with a chips input in the form (Enter/comma adds, ✕ removes, Backspace on empty input removes the last chip; max 20 tags, deduped). Imports fill it automatically: kaffeebraun aroma properties and Hoppenworth & Ploch Geschmack lists become tags (qualifiers like "(Filter)" stripped) instead of a notes blob — the notes field stays free for personal notes. A startup migration moves the aroma segment of previously imported beans into flavors (shape heuristics protect personal notes; manual beans are never touched). Flavor chips render on the bean card and `beans-info` exposes `flavors` for the cards. Closes #233

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
