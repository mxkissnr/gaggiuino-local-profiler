<p align="center">
  <img src="gaggiuino-local-profiler/logo.svg" alt="Gaggiuino Local Profiler" width="660"/>
</p>

<p align="center">
  <a href="https://github.com/mxkissnr/gaggiuino-local-profiler/releases/latest">
    <img src="https://img.shields.io/github/v/tag/mxkissnr/gaggiuino-local-profiler?color=%23f59e0b&label=Version&style=flat-square" alt="Version"/>
  </a>
  <img src="https://img.shields.io/badge/Home%20Assistant-App-41bdf5?logo=home-assistant&style=flat-square" alt="HA App"/>
  <img src="https://img.shields.io/badge/arch-amd64%20%7C%20armv7%20%7C%20aarch64-6b7280?style=flat-square" alt="Architectures"/>
  <img src="https://img.shields.io/badge/Node.js-Express-339933?logo=node.js&style=flat-square" alt="Node.js"/>
  <img src="https://img.shields.io/badge/Built%20with-Claude%20by%20Anthropic-D97706?style=flat-square" alt="Built with Claude"/>
  <img src="https://img.shields.io/badge/status-Work%20In%20Progress-orange?style=flat-square" alt="Work In Progress"/>
  <img src="https://img.shields.io/badge/license-GPL--3.0-blue?style=flat-square" alt="License GPL-3.0"/>
</p>

<p align="center">
  Local shot-profiling dashboard for <a href="https://gaggiuino.github.io/">Gaggiuino</a>- and <a href="https://github.com/jniebuhr/gaggimate">GaggiMate</a>-based espresso machines.<br/>
  Syncs shots automatically, visualizes extraction profiles and provides a real-time live view — all from Home Assistant.
</p>

---

> **Heads-up — this requires a machine running [Gaggiuino](https://gaggiuino.github.io/) or [GaggiMate](https://github.com/jniebuhr/gaggimate) firmware.** GLP does not work with stock espresso machines. Both are hardware mods (custom controller, pressure/temperature sensors) — Gaggiuino has full support, GaggiMate is experimental as of v2.0.0 (see the Multi-Machine row below). These mods aren't limited to one machine brand: **the "type" GLP asks for when you add a machine selects the firmware adapter it talks to, not the physical machine.** Any single-boiler machine with a Gaggiuino or GaggiMate board installed — Gaggia Classic, Rancilio Silvia, Lelit, and others — works identically from GLP's side. If your machine doesn't run either firmware yet, start there first.

## Why GLP?

You love your Gaggiuino or GaggiMate machine, but your shot data disappears into the void? GLP brings live extraction charts, a searchable coffee library and full analytics straight into Home Assistant — completely local, no cloud, no account. From *"what was that bean from last week again?"* to a real shot archive with automatic scoring, compare view and flavor wheel: everything runs on your HA server, and your data stays yours.

## 🔗 The GLP Ecosystem

| Component | Version | Requires |
|---|---|---|
| **GLP App** (this repo) | ![Version](https://img.shields.io/github/v/tag/mxkissnr/gaggiuino-local-profiler?label=&color=22c55e) | Gaggiuino or GaggiMate machine + HA OS/Supervised |
| [**GLP Integration**](https://github.com/mxkissnr/glp-integration) | ![Version](https://img.shields.io/github/v/release/mxkissnr/glp-integration?label=&color=22c55e) | App v1.82.7+ · [HACS](https://hacs.xyz) |
| [**GLP Shot Card**](https://github.com/mxkissnr/glp-lovelace-card) | ![Version](https://img.shields.io/github/v/release/mxkissnr/glp-lovelace-card?label=&color=22c55e) | Integration v1.9.0+ |
| [**GLP Order Card**](https://github.com/mxkissnr/glp-order-card) | ![Version](https://img.shields.io/github/v/release/mxkissnr/glp-order-card?label=&color=22c55e) | Integration v1.7.0+ |

All four components are optional and independently installable — only install what you need.

> **No longer requires ALERTua/hass-gaggiuino** — as of GLP Integration v1.9.0 all machine sensors (temperature, pressure, water level, weight, profiles, switch states) are provided natively.

---

## ⚡ Quick Install

<p>
  <a href="https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2Fmxkissnr%2Fgaggiuino-local-profiler">
    <img src="https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg" alt="Add Repository to Home Assistant" height="40"/>
  </a>
</p>

Click the button above to add this repository directly to your Home Assistant — no copy-pasting needed.

---

## 📸 Screenshots

<p align="center">
  <img src="gaggiuino-local-profiler/docs/screenshots/shots.png" alt="Shots view with pressure/flow/weight/temperature chart" width="49%"/>
  <img src="gaggiuino-local-profiler/docs/screenshots/library.png" alt="Coffee library with bean cards" width="49%"/>
</p>
<p align="center">
  <img src="gaggiuino-local-profiler/docs/screenshots/flavor-wheel.png" alt="Interactive flavor wheel for a bean" width="49%"/>
  <img src="gaggiuino-local-profiler/docs/screenshots/analytics.png" alt="Analytics view with interactive coffee world map" width="49%"/>
</p>
<p align="center">
  <img src="gaggiuino-local-profiler/docs/screenshots/maintenance.png" alt="Maintenance dashboard with summary tiles, next-due banner and per-machine task tiles" width="49%"/>
  <img src="gaggiuino-local-profiler/docs/screenshots/analytics-machines.png" alt="Analytics machine comparison, bean ranking and dial-in progression" width="49%"/>
</p>

More in [`docs/screenshots/`](gaggiuino-local-profiler/docs/screenshots/) (Dial-in). Regenerated on demand via `node scripts/screenshots.mjs`.

---

## ✨ Features

| | Feature | Description |
|---|---|---|
| 🔀 | **Multi-Machine** | Manage more than one espresso machine from a single add-on instance — Gaggiuino (full support) or [GaggiMate](https://github.com/jniebuhr/gaggimate) (experimental: sync + live status, read-only profiles). Shot sync now runs for every registered machine, not just the default one; live view stays default-machine-only for now. Maintenance (descaling/backflush/group head/gaskets) is tracked per machine; shared equipment (water filter, grinder) stays global. Existing single-machine installs upgrade automatically, no manual steps. |
| 📈 | **Shot Archive** | All shots with pressure, flow, weight and temperature curves |
| 🔴 | **Live Mode** | Real-time display directly from the controller (`/api/system/status`) |
| 🔄 | **Auto-Sync** | New shots load automatically when `gaggiuino_latest_shot_id` rises |
| ⇄ | **Compare Mode** | Overlay two shots side by side |
| 👻 | **Ghost Curve & Delta Chips** | When an earlier shot exists with the same profile on the same machine, the shot detail auto-compares: a score delta chip on the verdict header, signed delta chips on pressure/flow/temp, and the previous shot's curves overlaid on the chart as a dashed ghost — independent of the explicit Compare Mode above |
| 🏆 | **Shot Score** | Automatic 0–100 score (pressure, stability, duration, ratio, channeling), shown as a verdict-header score ring with a plain-language dial-in headline atop the shot detail; temperature/ratio target the bean's own brew recommendation from the Library when set, flagged with a target-icon badge on the header when it applies |
| 📊 | **Analytics** | Score trend, shot calendar heatmap, bean stats, profile performance, interactive coffee world map (zoom/pan, per-bean origin points), a weekday × hour heatmap, a sortable bean ranking table (shots/score/last grind/trend), a machine comparison table (score/duration/temperature stability, once ≥2 machines are registered) and a per-bean dial-in progression chart |
| 📊 | **P·Q Diagram** | Pressure vs. flow chart — reveals extraction signature |
| ⚗️ | **EY Calculation** | Extraction Yield % when TDS and dose are entered |
| ☕ | **Grind Recommendation** | Automatic advice based on shot duration and channeling |
| 🎯 | **Guided Dial-In Wizard** ⚠ *experimental* | Step-by-step "set grind → pull shot → evaluate → next grind" loop, opened from the Dial-in tab or a bean card; binary-search grind suggestions against a 25–32 s extraction-time target, explicit shot-match confirmation (never silent), and a "save as known grind" once dialed in — usable but still evolving, suggestions are a starting point, not a guarantee |
| 📅 | **Roast Date & Freshness** | Days since roast as colored badge (green: 7–21 days optimal) |
| ☕ | **Coffee Library** | Persistent bean and grinder database with autocomplete; roast date auto-fills; variety, processing, roast type, growing region, altitude, importer, harvest, price, producer, certification and a manual brew recommendation (temperature/ratio/time) — all shown only when set; bean cards show an origin eyebrow line, outline-style flavor tags and a proportional stock-remaining bar |
| 🧊 | **Frozen Portion Tracking** | Freeze a dated, weighed portion of a bag for later without touching its stock — the freshness clock pauses for time spent frozen; thaw one portion at a time from a multi-portion batch, or correct a portion's count/weight/date after the fact |
| 🎛 | **Machine Profile Editor** (bean suggestion ⚠ *experimental*) | Visual editor for Gaggiuino machine profiles in a new "Profiles" tab — name, recipe, and a full phase editor (type, target curve, restriction, stop conditions) with a live preview chart; "Create profile" on a bean card pre-fills a profile suggestion derived from that bean's decaf/process/roast attributes (usable but not finished — a starting point, not a guarantee, review before sending); sends directly to the machine over its WebSocket API |
| 🧪 | **Profile Dial-In Wizard** | Sibling to the Guided Dial-In wizard, but tunes a machine profile's phases against real trial shots instead of grind — pick how each shot tasted (balanced/sour/bitter/watery/channeling), get one concrete phase adjustment per round grounded in extraction science, sent straight back to the machine before the next round |
| 🎡 | **Flavor Wheel** | Interactive aroma sunburst per bean, built from structured tasting-note tags — see [Acknowledgements](#acknowledgements) for the SCA/WCR data credit |
| ⭐ | **Bean Rating** | Star rating per bean, computed automatically as the average of that bean's shot ratings — no manual field |
| 🖼️ | **Bean, Grinder & Shot Photos** | Bean photo imported once from the shop on URL import; grinder photo uploaded directly from your device — plus grinder burr type and purchase date; each shot can also have its own photo (e.g. the cup/crema), shown as a small round thumbnail in the sidebar; click any bean, grinder or shot photo to open it fullscreen in a shared lightbox |
| 📝 | **Annotations & Rating** | Coffee, grinder, grind setting, dose, roast date, TDS, notes, **drink type** (from menu); 1–5 stars; auto-saves 1 s after last keystroke, with an inline "Speichert…" → "Gespeichert" status and forced flush on blur/tab-switch/shot-switch so no edit is ever lost |
| 🎚️ | **Grind Setting Baseline** | The shot detail's Bean & Grinder recipe card shows the grind setting alongside the grinder; a bean's newest shot additionally shows a "Last grind" baseline chip with the last recorded grind setting for that bean, so baseline and correction read together next to the grind advice; sidebar shot cards' meta line includes the grind setting too |
| 🔍 | **Shot Search** | Filter sidebar by profile, coffee, grinder; each shot is a rich card (thumbnail, score, coffee + dose, star rating, grinder, time), grouped under day-separator headers ("Today" / "Yesterday" / date) |
| ☕ | **Bean Filter (Shot History)** | Click a bean in the Library to narrow the shot sidebar to that bean's shots, ANDed with the free-text search, with a clearable indicator |
| ⛶ | **Fullscreen Chart** | Expand chart to fullscreen with auto landscape rotation on mobile |
| 💾 | **.shot Export** | Export in Decent Espresso format (Visualizer.coffee compatible) |
| 📤 | **CSV Export** | All shots with annotations as CSV |
| 🖼️ | **Share Card** | Export any shot as a 1080×1080 PNG card — score, pressure curve, metadata and GLP branding. Share button uses the native Web Share API on mobile or downloads the PNG on desktop. |
| 🔌 | **Smart Plug** | Optional: power machine on/off via HA switch entity |
| ☕ | **Preheat Timer** | Progress bar + countdown after machine switches on; configurable warmup time; smart reset (ignores brief off/on cycles while still warm) |
| 🌐 | **Multi-Language UI** | DE / EN / IT / FR / ES / NL — auto-detected from browser, persisted per session |
| 🎨 | **Accent Color Themes** | 6 color schemes: Amber (default), Ocean, Aurora, Ember, Forest, Crema — persisted in localStorage; Crema also warms the neutral gray scale and pairs with a bundled serif (Fraunces) for bean names in the Library and on the share card |
| 🧹 | **Maintenance Dashboard** | Summary tiles (due/soon/OK + log entries this year), a "next up" banner naming the most-overdue task with an inline done-button, a per-view machine filter (independent of the topbar switcher), compact task tiles with threshold/guided-flow controls behind a details expand, and a filterable maintenance log table |
| 🔧 | **Grinder Maintenance** | Per-grinder cleaning schedule with configurable shot or day threshold; cards shown alongside machine maintenance tasks |
| 🔩 | **Grinder Burr Wear** | Shots and grams ground since the last burr swap, tracked separately from calendar-based cleaning maintenance since burrs dull by throughput, not time; one-click reset when burrs are replaced |
| 📷 | **Barcode / QR Scanner** | Scan coffee bag barcodes (EAN/UPC) via camera — name and roaster looked up on Open Food Facts; GLP QR schema for full bean import between installations; each bean card generates a shareable QR code |
| 🔗 | **Roaster URL Import** | Paste a product URL from kaffeebraun.com, hoppenworth-ploch.de or elbgold.com (each toggleable in settings) — name, roaster, photo, aromas, origin country, variety, roast type, processing, growing region, altitude/importer/harvest/price (where the shop provides them) and decaf flag are imported automatically; any other shop falls back to a generic Shopify / JSON-LD / webpage-metadata parser, and custom Shopify domains can be added; the generic Shopify parser also does a bounded, SSRF-checked HTML fallback fetch to fill in process/variety/producer/region/origin/elevation/roast-type/brew-guide fields some shop themes only render into the page HTML, never overwriting a value already found in the shop's JSON; imported beans show source, import method and import date |
| 🌙 | **Light / Dark theme** | Built-in theme toggle (Settings); choice persisted in localStorage; matching `glp-ha-theme.yaml` for the full HA interface |
| 🎛️ | **Profile Selector** | Lovelace card shows a dropdown to switch the active brew profile via `select.gaggiuino_profiler_profile` (provided by GLP Integration v1.9.0+) |
| 📋 | **Order Management** | Barista backend tab to manage espresso orders — queue, accept with ETA, complete or decline with reason; configurable menu (emoji + drink name); bean and milk variants offered only while actually in stock (milk is deducted automatically on order completion) and while manually enabled — a bean can be temporarily excluded from ordering without deleting it or touching its stock, with customer-facing bean descriptions (taste notes, origin, processing); companion Lovelace card for customers (`glp-order-card`) |
| 🧭 | **First-Run Onboarding & Demo Mode** | Dismissible banner when the machine isn't reachable; first-run panel with setup steps plus a "Load demo data" button that seeds a sample dataset (shots, beans, a blend, a recipe) so the app can be evaluated before connecting hardware; "End demo" removes exactly the seeded rows |
| 📱 | **Installable App (PWA)** | Install GLP as a standalone app when accessed directly over HTTPS (own icon, no browser chrome, offline app shell); server-side gated so it's never offered inside the HA Companion App/Ingress panel, which keeps running as a normal embedded panel |
| 🧭 | **Desktop Topbar Navigation** | Horizontal icon+label tab row (Shots/Live/Library/Analytics/Dial-in/Maintenance/Orders/Settings) in the content topbar next to the multi-machine switcher — no separate brand icon, since the app is already framed by the HA Ingress panel; replaces v2.6.0's collapsible left nav rail, removed again after real HA Ingress testing showed it stacking a second left-hand menu on top of Ingress's own sidebar |
| 📱 | **Mobile Bottom Navigation & Burger Drawer** | Bottom nav (Shots/Live/Library/Analytics + a "More" sheet, all icon-based, no emoji); the Shots tab opens the shot detail directly (last-selected shot, falling back to newest) — the shot list itself lives exclusively in the left burger drawer, an overlay reachable from any view (swipe-left or backdrop-tap to close), alongside the bottom nav; verdict header, recipe zone and full chart fit above the fold; touch targets sized 44×44px |
| 🗓️ | **Hybrid Shot-List Date Grouping** | Sidebar shot list groups recent shots (today/yesterday, up to ~14 days) by day; older shots collapse into per-month headers instead of one header per day forever — month headers are a collapsible accordion (collapsed by default, click to expand) |
| 📱 | **Configurable Mobile Bottom Nav** | Choose which 4 destinations appear as the mobile bottom-nav's main icons from Settings (checkbox + up/down reorder, no drag-and-drop); Shots is pinned first, unpicked destinations fall into the "More" sheet automatically, max 4 enforced by disabling further checkboxes; persisted client-side only, falls back to today's default set if cleared/corrupted; mobile-only, desktop topbar unaffected |

---

## 🚀 Installation

### Step 1 — Add this repository to Home Assistant

Either click the Quick Install button above, or manually:

1. Go to **Settings → Apps → App Store**
2. Click **⋮ → Repositories**
3. Add:
   ```
   https://github.com/mxkissnr/gaggiuino-local-profiler
   ```
4. Search for **Gaggiuino Local Profiler** and click **Install**

### Step 2 — Install the GLP Integration (recommended)

The [GLP HA Integration](https://github.com/mxkissnr/glp-integration) exposes all app data as native HA sensors — usable in automations, energy dashboards and Lovelace cards. Required for the GLP Shot Card and GLP Order Card.

**Install via HACS:** HACS is the community store for Home Assistant — one-time setup guide at [hacs.xyz](https://hacs.xyz) if you don't have it yet.

<a href="https://my.home-assistant.io/redirect/hacs_repository/?owner=mxkissnr&repository=glp-integration&category=integration">
  <img src="https://my.home-assistant.io/badges/hacs_repository.svg" alt="Add GLP Integration via HACS" height="40"/>
</a>

After installing, go to **Settings → Devices & Services → Add Integration** and search for **Gaggiuino Local Profiler**.

### Step 3 — Configure the app

In the app options set your controller URL:

```yaml
machine_host: "192.168.1.42"           # IP or hostname of your Gaggiuino controller
sync_interval: 5
switch_entity: "switch.espresso_plug"  # optional
```

> **Verify connectivity** from the HA terminal:
> ```bash
> curl http://<gaggiuino-ip>/api/shots/latest
> ```

### Step 4 — Open the dashboard

Click **Open Web UI** in the app page — or open it directly from your HA sidebar under **GLP**.

---

## ⚙️ Configuration

| Option | Default | Description |
|---|---|---|
| `machine_host` | `gaggia.intern` | IP or hostname of the Gaggiuino controller |
| `sync_interval` | `5` | Auto-sync interval in minutes (1–60) |
| `switch_entity` | *(empty)* | HA switch entity to power the machine on/off |

---

## 🏠 Embed in HA Dashboard

Add the profiler as a card in any Lovelace dashboard:

**Webpage Card:**
1. Edit dashboard → **Add Card → Webpage**
2. URL: `/api/hassio_ingress/gaggiuino_local_profiler/`

**Or via YAML:**
```yaml
type: iframe
url: /api/hassio_ingress/gaggiuino_local_profiler/
aspect_ratio: "16:9"
```

---

## 🏗️ Architecture

```
Home Assistant Host
├── GLP App  (Node.js / Express, Port 8099)
│   ├── /data/glp.db              ← SQLite database (shots, annotations, library, …)
│   └── Supervisor API            ← HA switch control & sensor polling
│
├── Gaggiuino Controller
│   ├── GET /api/shots             ← Shot list & profiles
│   └── GET /api/system/status     ← Live data (1 s polling)
│
└── GaggiMate Controller (experimental)
    ├── ws://<host>/ws             ← JSON WebSocket (live status, profiles)
    └── GET /api/history/*.slog    ← Binary shot history
```

---

## Development at a glance

<p align="center">
  <img src="docs/dev-stats/commits-per-repo.png" alt="Commits per repo" width="49%"/>
  <img src="docs/dev-stats/model-breakdown.png" alt="Claude model breakdown by commits" width="49%"/>
</p>

Full numbers (timeline, per-model breakdown, cost estimate) generated live from git history: see [DEVELOPMENT.md](DEVELOPMENT.md).

---

<p align="center">
  <a href="https://github.com/mxkissnr/gaggiuino-local-profiler/wiki">📖 Documentation (EN)</a> ·
  <a href="https://github.com/mxkissnr/gaggiuino-local-profiler/wiki/Home-de">📖 Dokumentation (DE)</a> ·
  <a href="gaggiuino-local-profiler/CHANGELOG.md">📋 Changelog</a> ·
  <a href="https://github.com/mxkissnr/gaggiuino-local-profiler/issues">🐛 Issues</a> ·
  <a href="DEVELOPMENT.md">📊 Dev Stats</a>
</p>

---

## License

GPL-3.0 © 2024–2026 mxkissnr — free to use, fork and modify; any derivative work must remain open source under the same license. Commercial use is not permitted.

## Acknowledgements

Inspired by [BeanConqueror](https://github.com/graphefruit/beanconqueror) by graphefruit — a fantastic open-source coffee tracking app that pioneered many of the ideas around shot logging and coffee library management that influenced this project.

Built on top of the [Gaggiuino](https://gaggiuino.github.io/) project. The machine sensor integration in glp-integration was inspired by [ALERTua/hass-gaggiuino](https://github.com/ALERTua/hass-gaggiuino) — the original Home Assistant integration for Gaggiuino. Thank you to [@ALERTua](https://github.com/ALERTua) for pioneering the HA connectivity concepts that made this possible.

Thanks also to Caffinnova S.r.l. and the [jniebuhr/gaggimate](https://github.com/jniebuhr/gaggimate) project for their openly documented WebSocket API and shot-history format, which made the GaggiMate adapter possible. The adapter was written from GaggiMate's public protocol documentation — no GaggiMate code is vendored in this repo.

The in-app flavor wheel's category structure follows the SCA (Specialty Coffee Association) / WCR (World Coffee Research) *Coffee Taster's Flavor Wheel* (2016). `public-src/flavor-data.js` is our own derived dataset (labels in all 6 UI languages — DE, EN, IT, FR, ES, NL — and a German alias table) — no artwork from the original wheel is used or reproduced.

## Disclaimer

GLP is an independent, community-built companion project. It is not officially affiliated with, endorsed by, or supported by the [Gaggiuino](https://gaggiuino.github.io/) firmware project or its maintainers, nor by Caffinnova S.r.l. or the [GaggiMate](https://github.com/jniebuhr/gaggimate) project or its maintainers.

---

<p align="center">
  <sub>Built with AI assistance — designed and developed together with <a href="https://claude.ai">Claude</a> by Anthropic</sub>
</p>
