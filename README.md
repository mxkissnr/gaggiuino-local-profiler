<p align="center">
  <img src="gaggiuino-local-profiler/logo.svg" alt="Gaggiuino Local Profiler" width="640"/>
</p>

<p align="center">
  <a href="https://github.com/mxkissnr/gaggiuino-local-profiler/releases"><img src="https://img.shields.io/badge/version-1.17.8-green" alt="Version"/></a>
  <img src="https://img.shields.io/badge/Home%20Assistant-Add--on-blue?logo=home-assistant" alt="HA Add-on"/>
  <img src="https://img.shields.io/badge/arch-amd64%20%7C%20armv7%20%7C%20aarch64-lightgrey" alt="Architectures"/>
</p>

## Installation

1. **Settings → Add-ons → Add-on Store → ⋮ → Repositories**
2. Add the URL:
   ```
   https://github.com/mxkissnr/gaggiuino-local-profiler
   ```
3. Search for **Gaggiuino Local Profiler** and install
4. Set `machine_url` in the add-on options to your controller's IP
5. Start the add-on → open the dashboard via **Open Web UI**

## Features

| Feature | Description |
|---|---|
| **Shot Archive** | All shots with pressure, flow, weight and temperature curves |
| **Live Mode** | Real-time display directly from the controller (`/api/system/status`) |
| **Auto-Sync** | New shots load automatically when `gaggiuino_latest_shot_id` rises |
| **Compare Mode** | Overlay two shots side by side |
| **Shot Score** | Automatic 0–100 score (pressure, stability, duration, ratio, channeling) |
| **Sidebar Sorting** | Sort by newest / score / rating / duration; click again to reverse |
| **P·Q Diagram** | Pressure vs. flow chart — reveals extraction signature |
| **EY Calculation** | Extraction Yield % when TDS and dose are entered |
| **Grind Recommendation** | Automatic advice based on shot duration and channeling |
| **Roast Date & Freshness** | Days since roast as colored badge |
| **Annotations & Rating** | Coffee, grinder, grind setting, dose, roast date, TDS, notes; 1–5 stars |
| **Shot Search** | Filter sidebar by profile, coffee, grinder |
| **.shot Export** | Export in Decent Espresso format (Visualizer.coffee compatible) |
| **CSV Export** | All shots with annotations as CSV |
| **Smart Plug** | Optional: power machine on/off via HA switch entity |
| **Live Tab Gating** | Live tab is disabled when the machine is switched off |

## Configuration

| Option | Default | Description |
|---|---|---|
| `machine_url` | `http://gaggia.intern/api/shots` | API URL of the Gaggiuino controller |
| `sync_interval` | `5` | Auto-sync interval in minutes (1–60) |
| `switch_entity` | *(empty)* | HA switch entity to power the machine on/off (e.g. `switch.espresso_plug`) |

### Example

```yaml
machine_url: "http://192.168.1.42/api/shots"
sync_interval: 10
switch_entity: "switch.espresso_plug"
```

## Prerequisites

- Gaggiuino controller reachable via HTTP from the HA host
- Gaggiuino HA integration (optional, for auto-sync via `latest_shot_id`)

Test in HA terminal: `curl http://<ip>/api/shots/latest`

## HA Dashboard Card

To embed the profiler in a Lovelace dashboard:

1. **Settings → Dashboards → Edit → Add Card → Webpage**
2. URL: `/api/hassio_ingress/<addon-slug>/`  
   *(find the slug in the add-on info page URL)*
3. Or use a **Markdown card** with an iframe:
   ```yaml
   type: markdown
   content: >
     <iframe src="/api/hassio_ingress/gaggiuino_local_profiler/" 
             style="width:100%;height:800px;border:none;border-radius:12px">
     </iframe>
   ```

## Architecture

```
HA Host
├── Add-on (Node.js / Express)
│   ├── /data/shots.json          Shot data from machine
│   ├── /data/annotations.json    Notes and ratings
│   └── Supervisor API            HA switch control, auto-sync
└── Gaggiuino Controller
    ├── /api/shots                Shot list & individual shots
    └── /api/system/status        Live data (1s polling)
```

→ [Full documentation](gaggiuino-local-profiler/DOCS.md) · [Changelog](gaggiuino-local-profiler/CHANGELOG.md)
