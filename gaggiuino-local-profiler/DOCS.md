# Gaggiuino Local Profiler

Local shot profiling dashboard for [Gaggiuino](https://gaggiuino.github.io/)-based espresso machines.

**Full documentation:** [github.com/mxkissnr/gaggiuino-local-profiler/wiki](https://github.com/mxkissnr/gaggiuino-local-profiler/wiki)

## Architecture — how the three components work together

The GLP (Gaggiuino Local Profiler) ecosystem consists of three independent pieces that build on each other:

```
  Gaggiuino Machine
  └─ /api/shots          (shot history)
  └─ /api/system/status  (live brew data)
  └─ /api/system/info    (firmware version)
         │
         │  sync every N min + live polling during brew
         ▼
  ┌──────────────────────────────────┐
  │         GLP Add-on               │  ← this add-on
  │  Node.js server, port 8099       │
  │  stores shots in /data/shots.json│
  │  REST API + web UI               │
  └────────┬─────────────────────────┘
           │                    ▲
           │  polls             │  HA Ingress (browser, authenticated)
           │  /api/status       │  direct port 8099 (integration, card)
           │  /shots.json       │
           │  /api/preheat      │
           │  /api/maintenance  │
           ▼                    │
  ┌─────────────────────┐       │
  │  GLP HA Integration │       │  ┌──────────────────────┐
  │  (custom component) │       └──│  GLP Lovelace Card   │
  │  creates sensors,   │          │  (custom card)       │
  │  fires HA events    │─────────►│  reads switch_entity │
  └─────────────────────┘  sensor  │  from machine_status │
           │               attrs   │  sensor attribute    │
           ▼                       └──────────────────────┘
    HA sensors, automations,
    energy monitoring, …
```

### GLP Add-on (this repo)

The central piece. It syncs shot history from the Gaggiuino machine, stores it locally in `/data/shots.json`, and serves:
- A web UI accessible via HA Ingress (the ☕ panel icon in the HA sidebar)
- A REST API on port 8099 consumed by the integration and the Lovelace card

### GLP HA Integration

A custom component that polls the add-on every 60 s (configurable). It exposes all GLP data as native HA sensors — shot count, last shot profile, score, duration, weight, maintenance status, preheat state, etc. — so they can be used in automations, energy dashboards, and Lovelace dashboards.

Install via HACS: [github.com/mxkissnr/gaggiuino-profiler-integration](https://github.com/mxkissnr/gaggiuino-profiler-integration)

### GLP Lovelace Card

A custom Lovelace card that displays machine status, last shot summary, preheat progress and a power button. It talks to port 8099 directly and reads the `switch_entity` from the `machine_status` sensor attribute (set automatically by the integration) — no manual card configuration needed beyond the GLP URL.

Install via HACS: [github.com/mxkissnr/glp-lovelace-card](https://github.com/mxkissnr/glp-lovelace-card)

### API token

All three components authenticate automatically via a shared token:

1. The add-on generates a random 64-character token at first start and stores it in `/data/api_token.txt`.
2. `/api/status` is public and returns the token.
3. The browser UI and the integration read the token from `/api/status` on startup and include it as an `X-GLP-Token` header on all subsequent requests.
4. Requests coming through HA Ingress bypass the token check — HA already authenticated the user.

No manual configuration is required. To rotate the token, delete `/data/api_token.txt` and restart the add-on.

## Quick start

Set `machine_url` to your controller's API URL and start the add-on.

```yaml
machine_url: "http://192.168.1.42/api/shots"
sync_interval: 5
switch_entity: "switch.espresso_plug"   # optional
```

Verify connectivity from the HA terminal:
```bash
curl http://<gaggiuino-ip>/api/shots/latest
```

## Configuration options

| Option | Description | Default |
|---|---|---|
| `machine_url` | API URL of the Gaggiuino controller | `http://gaggia.intern/api/shots` |
| `sync_interval` | Auto-sync interval in minutes (1–60) | `5` |
| `switch_entity` | HA switch entity to power the machine on/off | *(empty)* |
| `preheat_time` | Warmup time in minutes — how long after switch-on until the machine is ready to brew (1–120) | `20` |
| `port` | Port the add-on server listens on (1024–65535) | `8099` |

## Features

| Tab | Description |
|---|---|
| **Live** | Real-time pressure, flow, weight and temperature charts during a shot. When a brew starts, the most recent shot with the same profile name is automatically overlaid as a dashed reference curve. Can be overridden or cleared via the dropdown. The tab is only visible when the machine is on (requires `switch_entity`). |
| **Shots** | Shot history with full chart view, score, annotation (coffee, grinder, dose, notes) and a fullscreen chart. |
| **Analytics** | Aggregated statistics and trend charts across all shots. |
| **Library** | Coffee bean and grinder catalogue linked to shots. |
| **Einwählen** | Dial-in assistant: compare a target shot with recent attempts. |
| **Maintenance** | Five machine maintenance reminders (descaling, backflush, group head service, gaskets & screens, water filter) plus a per-grinder cleaning schedule. All tasks have configurable shot or day thresholds, progress bars and a "Done now" button. |

### Live tab, switch entity and preheat timer

When `switch_entity` is set, the **Live** tab is hidden while the machine is off and appears automatically once it powers on. If no switch entity is configured the tab is always visible.

Once the machine turns on, a preheat progress bar and countdown are shown in the Live tab until `preheat_time` minutes have elapsed. The timer does **not** reset if the machine is briefly switched off and back on while the temperature is still above 80 °C (off for < 5 minutes) — short power cycles are ignored. The preheat state is also exposed as HA sensors via the companion integration (`binary_sensor.…preheat_ready`, `sensor.…preheat_elapsed`, `sensor.…preheat_remaining`).

### Barcode and QR scanner

In the Library tab, tap **⬛ Scan** next to "Add Bean" to open the camera scanner.

- **EAN/UPC barcode** (e.g. on a supermarket coffee bag) — GLP looks up the code on [Open Food Facts](https://world.openfoodfacts.org) and pre-fills name, roaster and notes. Specialty coffees are often not in the database; fill in the rest manually.
- **GLP QR code** — scan a QR code generated by another GLP installation for a full instant import.
- Each bean in the library has a **QR button** that generates a shareable QR code encoding all bean fields.

Requires a Chromium-based browser (uses the native BarcodeDetector Web API). Not supported on Firefox or Safari.

### Install as a standalone app (PWA)

GLP ships a Web App Manifest and Service Worker that allow it to be installed as a standalone app on your phone.

**Android (Chrome):** Open GLP → tap the install banner or ⋮ menu → *Add to Home Screen*
**iOS (Safari):** Open GLP → share icon → *Add to Home Screen*

Once installed, GLP opens without browser chrome and the app shell loads instantly from cache. Shot data and live mode always fetch from the network.

For full documentation — features, live mode, analytics, shot score, exports, compatibility — see the [Wiki](https://github.com/mxkissnr/gaggiuino-local-profiler/wiki).
