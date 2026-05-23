# Gaggiuino Local Profiler

Local shot profiling dashboard for [Gaggiuino](https://gaggiuino.github.io/)-based espresso machines. The add-on syncs shot data automatically from the controller, visualizes extraction profiles, and provides a real-time live mode — all from within Home Assistant.

## Features

- **Shot Archive** – all shots with pressure, flow, weight and temperature curves
- **Live Mode** – real-time display directly from the controller (`/api/system/status`), no HA polling delay
- **Auto-Sync** – new shot loads automatically when `gaggiuino_latest_shot_id` rises
- **Compare Mode** – overlay two shots side by side
- **Annotations & Rating** – coffee/bean, grinder, grind setting, dose, roast date, TDS %, free text; 1–5 star rating
- **Coffee Library** – persistent bean and grinder database with autocomplete in annotation fields; roast date auto-fills on selection
- **Shot Score** – automatic 0–100 score based on pressure, temperature stability, duration, ratio and channeling; shown as colored pill in the sidebar
- **Analytics** – dedicated tab with score trend chart, shot calendar heatmap, bean stats and profile performance
- **Sidebar Sorting** – sort by newest / score / rating / duration; click again to reverse
- **Analysis Metrics** – dose → yield → ratio, EY (Extraction Yield), temperature stability (±σ), phase detection, channeling warning
- **P·Q Diagram** – pressure vs. flow chart (extraction signature), alternate chart tab
- **Grind Recommendation** – automatic advice based on shot duration and channeling detection
- **Roast Date & Freshness** – days since roast shown as a colored badge (green: 7–21 days optimal)
- **Shot Search** – sidebar filter by profile, coffee, grinder
- **Fullscreen Chart** – expand chart to fullscreen with auto landscape rotation on mobile
- **.shot Export** – export in Decent Espresso format (Visualizer.coffee compatible)
- **CSV Export** – all shots with annotations as CSV
- **Smart Plug** – optional: power machine on/off via HA switch entity
- **Data Persistence** – shots and notes are preserved across updates and restarts

## Prerequisites

- Gaggiuino controller reachable via HTTP from the Home Assistant host
- Gaggiuino HA integration installed (optional, required for auto-sync via `latest_shot_id`)

Verify connectivity from the HA terminal:
```bash
curl http://<gaggiuino-ip>/api/shots/latest
```

## Configuration

| Option | Description | Default |
|---|---|---|
| `machine_url` | API URL of the Gaggiuino controller | `http://gaggia.intern/api/shots` |
| `sync_interval` | Auto-sync interval in minutes (1–60) | `5` |
| `switch_entity` | HA switch entity to power the machine on/off (e.g. `switch.espresso_plug`) | *(empty)* |

### Example

```yaml
machine_url: "http://192.168.1.42/api/shots"
sync_interval: 5
switch_entity: "switch.espresso_plug"
```

## Smart Plug Control (optional)

When `switch_entity` is configured, a **⏻ power button** appears in the sidebar footer:

- **Green** → machine is on
- **Grey** → machine is off
- Click to toggle the switch via the HA API

The **Live tab** is automatically disabled when the machine is off — preventing pointless connection attempts.

## Usage

### Shot Archive

1. Start the add-on and open the dashboard via **Open Web UI**
2. Shots appear in the sidebar after the first sync
3. Click a shot → profile view with all measurements
4. **⇄** button → compare mode (select shot B from the sidebar)
5. Annotation panel below the chart → enter data and click **Save**
6. **⤢** button → fullscreen chart (auto-rotates to landscape on mobile)

### Live Mode

1. Click the **Live** tab at the top of the dashboard
2. Once the brew switch is active, the real-time display starts automatically
3. Stat boxes and chart update every second directly from the controller
4. After the shot ends, the complete shot is synced automatically

The live mode polls the Gaggiuino controller directly via `/api/system/status` (1-second interval) — **not** via HA sensors. This means brew-start detection is immediate, with no delay from the HA polling interval.

The HA integration is checked in the background every 30 seconds to trigger an auto-sync when `sensor.gaggiuino_latest_shot_id` rises.

**Live mode data sources:**

| Field | Source | Endpoint |
|---|---|---|
| Brew switch (start/stop) | Gaggiuino direct | `/api/system/status` → `brewSwitchState` |
| Pressure | Gaggiuino direct | `/api/system/status` → `pressure` |
| Temperature | Gaggiuino direct | `/api/system/status` → `temperature` |
| Weight / flow | Gaggiuino direct | `/api/system/status` → `weight` |
| Target temperature | Gaggiuino direct | `/api/system/status` → `targetTemperature` |
| Auto-sync (new shot) | HA sensor (optional) | `sensor.gaggiuino_latest_shot_id` |

## P·Q Diagram

The **P·Q Curve** tab shows pressure (Y-axis) vs. pump flow (X-axis) instead of the time axis. This reveals the extraction behavior of the puck:

- **Tight, smooth curve** → homogeneous extraction, even puck
- **Wide, noisy curve** → channeling or uneven distribution
- **Curve far right** → high flow at low pressure (grind too coarse)
- **Curve far left** → low flow despite high pressure (grind too fine)

## Extraction Yield (EY)

EY = (Beverage Weight × TDS %) / Dose

Enter **dose** and **TDS %** (measured with a refractometer) in the Annotations panel — the dashboard calculates EY automatically. SCA target range: **18–22 %**.

| Color | Range | Meaning |
|---|---|---|
| 🟢 Green | 18–22 % | Optimal extraction |
| 🟡 Yellow | 16–17 % or 23–24 % | Slight under/over-extraction |
| 🔴 Red | < 16 % or > 24 % | Significant under/over-extraction |

## Grind Recommendation

The automatic recommendation is based on shot duration and channeling detection:

| Shot duration | Recommendation |
|---|---|
| < 18 s | Grind finer |
| 18–22 s | Grind slightly finer |
| 23–42 s | Grind setting is good |
| 43–50 s | Grind slightly coarser |
| > 50 s | Grind coarser |
| Channeling detected | Check puck prep (distribution & tamping) |

## Shot Score

Each shot automatically receives a score from 0–100, shown in the top right of the profile view and as a colored pill in the sidebar.

| Color | Range | Meaning |
|---|---|---|
| 🟢 Green | 88–100 | Excellent shot |
| 🟡 Yellow-green | 75–87 | Good shot |
| 🟡 Amber | 60–74 | Solid shot |
| 🟠 Orange | 45–59 | Room for improvement |
| 🔴 Red | 0–44 | Problematic shot |

### Score factors

| Factor | Weight | Optimum | Scoring |
|---|---|---|---|
| **Extraction pressure** | 25 % | 7–9.5 bar (avg of values ≥ 5 bar) | 100 at optimum, linear penalty outside |
| **Temperature stability (σ)** | 20 % | σ ≤ 0.3 °C | 100 / 90 / 72 / 50 / <50 depending on σ |
| **Shot duration** | 20 % | 25–35 s | 100 at optimum, 82 at 20–25 s or 35–42 s |
| **Dose → yield ratio** | 20 % | 1:1.8 – 1:2.5 | Only when dose is entered in annotations |
| **Channeling** | 15 % | no channeling | 100 (none) or 20 (detected) |

> **Ratio note:** This factor is only included when a dose is entered under Annotations. Without dose, the remaining weights are scaled proportionally.

> **Pressure note:** The average is calculated only over values ≥ 5 bar to avoid penalizing the pre-infusion phase.

## Analytics

The **Analytics** tab provides four overview sections based on all stored shots:

### Score Trend

Line chart of shot scores over time, with a 5-shot moving average overlay. Use the filter buttons to show the last 30, 90, or all shots.

### Shot Calendar

GitHub-style activity heatmap for the past 52 weeks. Each cell represents one day — darker red means more shots. Hover a cell to see the date, shot count and average score.

### Bohnen-Auswertung (Bean Stats)

Cards grouped by coffee bean (from annotations). Each card shows:
- Total shot count
- Average score
- Best score
- Average duration

Only shots with a coffee name in the annotation are included.

### Profil-Performance

Horizontal bar chart showing the average score per extraction profile, sorted from best to worst. Bar color follows the score color scale (green → red). Hover a bar to see the total shot count for that profile.

## Coffee Library

The **Bibliothek** tab in the top navigation opens the library, or use the **☕ Bibliothek** shortcut button in the annotation panel to jump there directly.

### Beans

Store coffee beans with name, roaster, roast date and notes. Saved beans appear as autocomplete suggestions in the **Kaffee / Bohne** annotation field. If a matching bean is selected and the roast date field is empty, it is filled in automatically.

### Grinders

Store grinder names for quick selection in the **Mühle** annotation field.

### Storage

The library is saved to `/data/coffee_library.json` and persists across updates and restarts.

## .shot Export

Exports the currently selected shot in Decent Espresso `.shot` format. Compatible with [Visualizer.coffee](https://visualizer.coffee/) and other tools that accept Decent Espresso shot files.

## API Endpoints (internal)

| Endpoint | Method | Description |
|---|---|---|
| `/shots.json` | GET | All shots with annotations |
| `/api/status` | GET | Sync status, shot count, HA connection |
| `/api/sync` | POST | Trigger manual sync (max. once per 30 s) |
| `/api/shots/:id/annotate` | POST | Save annotation for a shot |
| `/api/live` | GET (SSE) | Real-time data stream |

## Data Storage

| File | Contents |
|---|---|
| `/data/shots.json` | Machine data for all shots |
| `/data/annotations.json` | Notes and ratings (separate file, sync-safe) |

## Deleting Shots

The trash button (🗑) in the sidebar removes a shot and its annotations from the local storage. However, the sync is **incremental and one-directional**: it tracks the highest local shot ID and only fetches shots with a higher ID from the machine.

| What you delete | Result |
|---|---|
| An older shot (not the latest) | Safe — stays deleted. The sync only fetches IDs higher than the current maximum, so it won't re-download old shots. |
| The most recent shot | Will come back on the next sync — the machine still has it and the local max ID drops below the machine's latest ID. |

**Practical use:** Deleting works well for test shots, aborted pulls, or cleaning up older data. The very last shot (highest ID) will always be re-synced from the machine.

Deleted shots are automatically added to a blocklist so they are never re-downloaded on the next sync.

## API Endpoints (internal)

| Endpoint | Method | Description |
|---|---|---|
| `/shots.json` | GET | All shots with annotations |
| `/api/status` | GET | Sync status, shot count, HA connection |
| `/api/sync` | POST | Trigger manual sync (max. once per 30 s) |
| `/api/shots/:id/annotate` | POST | Save annotation for a shot |
| `/api/shots/:id/delete` | POST | Delete a shot and its annotation |
| `/api/live` | GET (SSE) | Real-time data stream |

## Data Storage

| File | Contents |
|---|---|
| `/data/shots.json` | Machine data for all shots |
| `/data/annotations.json` | Notes and ratings (separate file, sync-safe) |

## Security

The add-on runs behind the Home Assistant Ingress proxy, which handles authentication. All API endpoints are only accessible through the HA dashboard. HA API access is read-only via the Supervisor token.
