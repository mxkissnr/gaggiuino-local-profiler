<p align="center">
  <img src="gaggiuino-local-profiler/logo.svg" alt="Gaggiuino Local Profiler" width="660"/>
</p>

<p align="center">
  <a href="https://github.com/mxkissnr/gaggiuino-local-profiler/releases/tag/v1.17.8">
    <img src="https://img.shields.io/github/v/tag/mxkissnr/gaggiuino-local-profiler?color=%23f59e0b&label=Version&style=flat-square" alt="Version"/>
  </a>
  <img src="https://img.shields.io/badge/Home%20Assistant-Add--on-41bdf5?logo=home-assistant&style=flat-square" alt="HA Add-on"/>
  <img src="https://img.shields.io/badge/arch-amd64%20%7C%20armv7%20%7C%20aarch64-6b7280?style=flat-square" alt="Architectures"/>
  <img src="https://img.shields.io/badge/Node.js-Express-339933?logo=node.js&style=flat-square" alt="Node.js"/>
  <img src="https://img.shields.io/badge/Built%20with-Claude%20by%20Anthropic-D97706?style=flat-square" alt="Built with Claude"/>
  <img src="https://img.shields.io/badge/status-Work%20In%20Progress-orange?style=flat-square" alt="Work In Progress"/>
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
| 📝 | **Annotations & Rating** | Coffee, grinder, grind setting, dose, roast date, TDS, notes; 1–5 stars |
| 🔍 | **Shot Search** | Filter sidebar by profile, coffee, grinder |
| ⛶ | **Fullscreen Chart** | Expand chart to fullscreen with auto landscape rotation on mobile |
| 💾 | **.shot Export** | Export in Decent Espresso format (Visualizer.coffee compatible) |
| 📤 | **CSV Export** | All shots with annotations as CSV |
| 🔌 | **Smart Plug** | Optional: power machine on/off via HA switch entity |
| 🌐 | **Multi-Language UI** | DE / EN / IT / FR / ES — auto-detected from browser, persisted per session |

---

## 🚀 Installation

### Step 1 — Add this repository to Home Assistant

Either click the Quick Install button above, or manually:

1. Go to **Settings → Add-ons → Add-on Store**
2. Click **⋮ → Repositories**
3. Add:
   ```
   https://github.com/mxkissnr/gaggiuino-local-profiler
   ```
4. Search for **Gaggiuino Local Profiler** and click **Install**

### Step 2 — Add the Gaggiuino integration (optional, for Auto-Sync)

The [Gaggiuino Home Assistant Integration](https://github.com/Homeassistant-Gaggiuino/Gaggiuino-HomeAssistant) enables automatic shot sync via `sensor.gaggiuino_latest_shot_id`.

**Install via HACS:**

<a href="https://my.home-assistant.io/redirect/hacs_repository/?owner=Homeassistant-Gaggiuino&repository=Gaggiuino-HomeAssistant&category=integration">
  <img src="https://my.home-assistant.io/badges/hacs_repository.svg" alt="Add Integration via HACS" height="40"/>
</a>

Or manually: HACS → Integrations → ⋮ → Custom repositories → add the URL above.

After installing, go to **Settings → Devices & Services → Add Integration** and search for **Gaggiuino**.

### Step 3 — Configure the add-on

In the add-on options set your controller URL:

```yaml
machine_url: "http://192.168.1.42/api/shots"
sync_interval: 5
switch_entity: "switch.espresso_plug"   # optional
```

> **Verify connectivity** from the HA terminal:
> ```bash
> curl http://<gaggiuino-ip>/api/shots/latest
> ```

### Step 4 — Open the dashboard

Click **Open Web UI** in the add-on page — or open it directly from your HA sidebar under **GLP**.

---

## ⚙️ Configuration

| Option | Default | Description |
|---|---|---|
| `machine_url` | `http://gaggia.intern/api/shots` | API URL of the Gaggiuino controller |
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
├── GLP Add-on  (Node.js / Express, Port 8099)
│   ├── /data/shots.json          ← Shot data
│   ├── /data/annotations.json    ← Notes & ratings
│   └── Supervisor API            ← HA switch control & sensor polling
│
└── Gaggiuino Controller
    ├── GET /api/shots             ← Shot list & profiles
    └── GET /api/system/status     ← Live data (1 s polling)
```

---

<p align="center">
  <a href="gaggiuino-local-profiler/DOCS.md">📖 Documentation (EN)</a> ·
  <a href="gaggiuino-local-profiler/DOCS.de.md">📖 Dokumentation (DE)</a> ·
  <a href="gaggiuino-local-profiler/CHANGELOG.md">📋 Changelog</a> ·
  <a href="https://github.com/mxkissnr/gaggiuino-local-profiler/issues">🐛 Issues</a>
</p>

<p align="center">
  <sub>Built with AI assistance — designed and developed together with <a href="https://claude.ai">Claude</a> by Anthropic</sub>
</p>
