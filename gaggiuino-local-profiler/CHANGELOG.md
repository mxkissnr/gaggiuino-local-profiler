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
- feat: Nederlands (NL) als sechste UI-Sprache hinzugefügt — vollständige Übersetzung aller Schlüssel inkl. Library, Rezepte, Bestellungen, Wartung, Charts

## 1.70.1
- fix: i18n — chart labels, tooltip titles and y-axis descriptions were hardcoded in German; now use `t()` with keys `chart_pressure`, `chart_flow`, `chart_weightflow`, `chart_weight`, `chart_temp`, `chart_target_*`, `chart_time`, `chart_*_unit`; `'gerade eben'` in orders view replaced with `t('orders_just_now')`; all 5 languages covered

## 1.70.0
- feat: orders — **Warteschlangen-ETA** (#130): neuer Endpoint `GET /api/orders/queue-eta` berechnet geschätzte Wartezeit pro Bestellung (Summe restlicher accepted-Zeit + Position × durchschnittliche Zubereitungszeit aus letzten 10 Bestellungen); Barista-Ansicht zeigt Queue-Banner wenn ≥2 Bestellungen aktiv und schlägt ETA-Wert im Picker vor; Customer Card (glp-order-card v1.7.0) zeigt Queue-Position und Wartezeit wenn Bestellung pending

## 1.69.0
- feat: Shots — **Bohnenalter beim Shot** (#129): beim Annotieren wird `beanAgeDays` automatisch berechnet (Shot-Zeitstempel − Röstdatum der aktiven Packung) und in der Annotation gespeichert; Freshness-Badge zeigt jetzt "X Tage beim Shot" statt aktuellem Alter; wenn Bean ausgewählt wird, erscheint ein Hinweis mit dem berechneten Alter; Auto-fill Röstdatum nutzt die Packung die zum Shot-Zeitpunkt aktiv war

## 1.68.0
- feat: preheat thermal stability detection improved (#124): `isTempStable()` now uses **range (max−min ≤ 1.5 °C)** over the last 30 seconds instead of statistical variance over the full history — reacts to recent stability even if the machine oscillated earlier; `state.stabilityReady` flag tracks whether preheat was completed by stability or timer; `/api/preheat` response includes `stabilityReady: bool`

## 1.67.1
- feat: Library Rezepte — **Wassermenge (g)**, **Eismenge (g)** und **Quellenlink (URL)** als neue Felder; Karte zeigt 💧/🧊 in der Parameterzeile und einen klickbaren 🔗-Link

## 1.67.0
- feat: Library Rezepte — **Brühmethode** (Espresso / AeroPress / V60 / French Press / Moka / Cold Brew), **Wassertemperatur**, **Mahlgrad** und **Workflow-Schritte** (geordnete Liste mit optionaler Dauer je Schritt); Rezeptkarte zeigt alle Schritte nummeriert an; Schritte live hinzufügen/entfernen im Formular

## 1.66.0
- feat: Library — **Decaf-Flag** (#127): Bohnen können als entkoffeiniert markiert werden (Checkbox im Formular, grünes DECAF-Badge auf der Karte)
- feat: Library — **Chargen-Tracking** (#128): "Neue Packung"-Button auf jeder Bohne; aktuelle Packung + Gesamtverbrauch über alle Packungen; aufklappbarer Packungsverlauf
- feat: Library — **Rezepte** (#126): neuer "Rezepte"-Tab mit Name, Getränketyp, Dosis/Ausbeute/Zeit, Profil, Bohne, Notizen; vollständiges CRUD

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
- Vollbild-Chart (⤢ Button): Zeit- und P·Q-Chart als Fullscreen-Overlay, ideal für Querformat auf Mobile
- Fix: Corsair-Plugin Null-Check verhindert "Cannot destructure property 'x'" Fehler
- Fix: Chart.getChart() vor jeder Chart-Erstellung verhindert "canvas already in use" (war Ursache unsichtbarer Charts auf Mobile)
- Fix: Chart.js Scale-ID `temp` → `y1` behebt rechte Y-Achse (zeigte max=6 statt ~98)
- Server: Cache-Control no-cache für HTML verhindert Caching in HA-App

## 1.17.0
- Fix: Chart.js Scale-ID `temp` → `y1` – behebt mobilen Rendering-Fehler (rechte Y-Achse zeigte max=6 statt ~98 auf Android/HA-App)
- Debug-Panel verbessert: try-catch + "timeout ran"-Marker für bessere Fehlerdiagnose

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
