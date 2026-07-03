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
  Local shot-profiling dashboard for <a href="https://gaggiuino.github.io/">Gaggiuino</a>-based espresso machines.<br/>
  Syncs shots automatically, visualizes extraction profiles and provides a real-time live view — all from Home Assistant.
</p>

---

## ⚡ Quick Install

<p>
  <a href="https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2Fmxkissnr%2Fgaggiuino-local-profiler">
    <img src="https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg" alt="Add Repository to Home Assistant" height="40"/>
  </a>
</p>

Click the button above to add this repository directly to your Home Assistant — no copy-pasting needed.

---

## ✨ Features

| | Feature | Description |
|---|---|---|
| 📈 | **Shot Archive** | All shots with pressure, flow, weight and temperature curves |
| 🔴 | **Live Mode** | Real-time display directly from the controller (`/api/system/status`) |
| 🔄 | **Auto-Sync** | New shots load automatically when `gaggiuino_latest_shot_id` rises |
| ⇄ | **Compare Mode** | Overlay two shots side by side |
| 🏆 | **Shot Score** | Automatic 0–100 score (pressure, stability, duration, ratio, channeling) |
| 📊 | **Analytics** | Score trend, shot calendar heatmap, bean stats, profile performance |
| 📊 | **P·Q Diagram** | Pressure vs. flow chart — reveals extraction signature |
| ⚗️ | **EY Calculation** | Extraction Yield % when TDS and dose are entered |
| ☕ | **Grind Recommendation** | Automatic advice based on shot duration and channeling |
| 📅 | **Roast Date & Freshness** | Days since roast as colored badge (green: 7–21 days optimal) |
| ☕ | **Coffee Library** | Persistent bean and grinder database with autocomplete; roast date auto-fills |
| 📝 | **Annotations & Rating** | Coffee, grinder, grind setting, dose, roast date, TDS, notes, **drink type** (from menu); 1–5 stars; auto-saves 1 s after last keystroke |
| 🔍 | **Shot Search** | Filter sidebar by profile, coffee, grinder |
| ⛶ | **Fullscreen Chart** | Expand chart to fullscreen with auto landscape rotation on mobile |
| 💾 | **.shot Export** | Export in Decent Espresso format (Visualizer.coffee compatible) |
| 📤 | **CSV Export** | All shots with annotations as CSV |
| 🖼️ | **Share Card** | Export any shot as a 1080×1080 PNG card — score, pressure curve, metadata and GLP branding. Share button uses the native Web Share API on mobile or downloads the PNG on desktop. |
| 🔌 | **Smart Plug** | Optional: power machine on/off via HA switch entity |
| ☕ | **Preheat Timer** | Progress bar + countdown after machine switches on; configurable warmup time; smart reset (ignores brief off/on cycles while still warm) |
| 🌐 | **Multi-Language UI** | DE / EN / IT / FR / ES / NL — auto-detected from browser, persisted per session |
| 🎨 | **Accent Color Themes** | 5 color schemes: Amber (default), Ocean, Aurora, Ember, Forest — persisted in localStorage |
| 🔧 | **Grinder Maintenance** | Per-grinder cleaning schedule with configurable shot or day threshold; cards shown alongside machine maintenance tasks |
| 📷 | **Barcode / QR Scanner** | Scan coffee bag barcodes (EAN/UPC) via camera — name and roaster looked up on Open Food Facts; GLP QR schema for full bean import between installations; each bean card generates a shareable QR code |
| 🔗 | **kaffeebraun.com Import** | Paste a product URL from kaffeebraun.com — name, roaster, aromas, origin, roast level and processing are imported automatically; imported beans show source and import date |
| 🌙 | **Light / Dark theme** | Built-in theme toggle (Settings); choice persisted in localStorage; matching `glp-ha-theme.yaml` for the full HA interface |
| 🎛️ | **Profile Selector** | Lovelace card shows a dropdown to switch the active brew profile via `select.gaggiuino_profiler_profile` (provided by GLP Integration v1.9.0+) |
| 📋 | **Order Management** | Barista backend tab to manage espresso orders — queue, accept with ETA, complete or decline with reason; configurable menu (emoji + drink name); bean variants offered only while actually in stock, with customer-facing bean descriptions (taste notes, origin, processing); companion Lovelace card for customers (`glp-order-card`) |

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

**Install via HACS:**

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

## 🔗 Component Compatibility

| Component | Current | Requires |
|---|---|---|
| **GLP App** | v1.90.4 | — |
| **GLP Integration** ([glp-integration](https://github.com/mxkissnr/glp-integration)) | v1.14.1 | App v1.82.7+ |
| **GLP Lovelace Card** ([glp-lovelace-card](https://github.com/mxkissnr/glp-lovelace-card)) | v2.12.3 | Integration v1.9.0+ |
| **GLP Order Card** ([glp-order-card](https://github.com/mxkissnr/glp-order-card)) | v1.10.2 | Integration v1.7.0+ |

All four components are optional and independently installable — only install what you need.

> **No longer requires ALERTua/hass-gaggiuino** — as of GLP Integration v1.9.0 all machine sensors (temperature, pressure, water level, weight, profiles, switch states) are provided natively.

---

## 🏗️ Architecture

```
Home Assistant Host
├── GLP App  (Node.js / Express, Port 8099)
│   ├── /data/glp.db              ← SQLite database (shots, annotations, library, …)
│   └── Supervisor API            ← HA switch control & sensor polling
│
└── Gaggiuino Controller
    ├── GET /api/shots             ← Shot list & profiles
    └── GET /api/system/status     ← Live data (1 s polling)
```

---

<p align="center">
  <a href="https://github.com/mxkissnr/gaggiuino-local-profiler/wiki">📖 Documentation (EN)</a> ·
  <a href="https://github.com/mxkissnr/gaggiuino-local-profiler/wiki/Home-de">📖 Dokumentation (DE)</a> ·
  <a href="gaggiuino-local-profiler/CHANGELOG.md">📋 Changelog</a> ·
  <a href="https://github.com/mxkissnr/gaggiuino-local-profiler/issues">🐛 Issues</a>
</p>

---

## License

GPL-3.0 © 2024–2026 mxkissnr — free to use, fork and modify; any derivative work must remain open source under the same license. Commercial use is not permitted.

## Acknowledgements

Inspired by [BeanConqueror](https://github.com/graphefruit/beanconqueror) by graphefruit — a fantastic open-source coffee tracking app that pioneered many of the ideas around shot logging and coffee library management that influenced this project.

Built on top of the [Gaggiuino](https://gaggiuino.github.io/) project. The machine sensor integration in glp-integration was inspired by [ALERTua/hass-gaggiuino](https://github.com/ALERTua/hass-gaggiuino) — the original Home Assistant integration for Gaggiuino. Thank you to [@ALERTua](https://github.com/ALERTua) for pioneering the HA connectivity concepts that made this possible.

---

<p align="center">
  <sub>Built with AI assistance — designed and developed together with <a href="https://claude.ai">Claude</a> by Anthropic</sub>
</p>
