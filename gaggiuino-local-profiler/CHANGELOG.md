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
