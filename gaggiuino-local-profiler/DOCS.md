# Gaggiuino Local Profiler

Local shot profiling dashboard for [Gaggiuino](https://gaggiuino.github.io/)-based espresso machines.

**Full documentation:** [github.com/mxkissnr/gaggiuino-local-profiler/wiki](https://github.com/mxkissnr/gaggiuino-local-profiler/wiki)

## Architecture — how the components work together

The GLP (Gaggiuino Local Profiler) ecosystem consists of four independent pieces that build on each other:

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
           │  /api/status       │  direct port 8099 (integration, cards)
           │  /shots.json       │
           │  /api/preheat      ├──────────────────────────┐
           │  /api/maintenance  │                          │
           │  /api/orders †     │                          │
           ▼                    │                          │
  ┌─────────────────────┐  ┌────┴─────────────────┐  ┌────┴─────────────────┐
  │  GLP HA Integration │  │  GLP Shot Card       │  │  GLP Order Card      │
  │  (custom component) │─►│  machine status,     │  │  customer ordering,  │
  │  creates sensors,   │  │  last shot summary,  │  │  order status,       │
  │  fires HA events    │─►│  preheat progress    │  │  shot summary on done│
  └─────────────────────┘  └──────────────────────┘  └──────────────────────┘
           │          sensor attrs → both cards auto-detect switch_entity
           ▼
    HA sensors, automations, energy monitoring, …

† requires enable_orders: true in add-on configuration
```

### GLP Add-on (this repo)

The central piece. It syncs shot history from the Gaggiuino machine, stores it locally in `/data/shots.json`, and serves:
- A web UI accessible via HA Ingress (the ☕ panel icon in the HA sidebar)
- A REST API on port 8099 consumed by the integration and the Lovelace cards

### GLP HA Integration

A custom component that polls the add-on every 60 s (configurable). It exposes all GLP data as native HA sensors — shot count, last shot profile, score, duration, weight, maintenance status, preheat state, etc. — so they can be used in automations, energy dashboards, and Lovelace dashboards.

Install via HACS: [github.com/mxkissnr/glp-integration](https://github.com/mxkissnr/glp-integration)

### GLP Shot Card

A custom Lovelace card that displays machine status, last shot summary, preheat progress, a power button and a **profile selector**. It talks to port 8099 directly and reads the `switch_entity` from the `machine_status` sensor attribute (set automatically by the integration) — no manual card configuration needed.

The profile selector requires the original [Gaggiuino HA integration](https://github.com/ALERTua/hass-gaggiuino) to be installed; it creates the `select.gaggiuino_profile` entity that the card reads and writes. The selector is automatically hidden when the entity is not present.

Install via HACS: [github.com/mxkissnr/glp-lovelace-card](https://github.com/mxkissnr/glp-lovelace-card)

### GLP Order Card

A customer-facing Lovelace card for the order system. Customers browse the drink menu, place an order and track its status in real time. When the barista marks an order as done, the card shows the shot summary with a pressure sparkline. Requires `enable_orders: true` in the add-on configuration.

Install via HACS: [github.com/mxkissnr/glp-order-card](https://github.com/mxkissnr/glp-order-card)

### API token

All components authenticate automatically via a shared token:

1. The add-on generates a random 64-character token at first start and stores it in `/data/api_token.txt`.
2. `/api/status` is public and returns the token.
3. The browser UI and the integration read the token from `/api/status` on startup and include it as an `X-GLP-Token` header on all subsequent requests.
4. Requests coming through HA Ingress bypass the token check — HA already authenticated the user.

No manual configuration is required. To rotate the token, delete `/data/api_token.txt` and restart the add-on.

All persistent data is written atomically (write to `.tmp`, then `fs.renameSync`) so a crash during a write cannot produce a half-written JSON file.

### API spec

A machine-readable OpenAPI 3.0.3 specification of all endpoints is served at `GET /api/openapi.json` (no auth required) and committed as [`openapi.yaml`](openapi.yaml) in the repository. You can paste the URL or the file into [Swagger Editor](https://editor.swagger.io/) to browse the full API.

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
| `enable_orders` | Enable the order management system — barista backend tab + customer order card support; disabled by default | `false` |
| `port` | Port the add-on server listens on (1024–65535) | `8099` |

## Features

| Tab | Description |
|---|---|
| **Live** | Real-time pressure, flow, weight and temperature charts during a shot. When a brew starts, the most recent shot with the same profile name is automatically overlaid as a dashed reference curve. Can be overridden or cleared via the dropdown. The tab is only visible when the machine is on (requires `switch_entity`). |
| **Shots** | Shot history with full chart view, score, annotation (coffee, grinder, dose, notes, **drink type**) and a fullscreen chart. Annotation fields **auto-save** 1 s after the last keystroke — a green ✓ appears briefly; manual Save still works. The last selected shot and any active comparison are restored after a page reload (persisted in `localStorage`). Drink type options are loaded from the same menu used by the orders feature (`GET /api/menu`). |
| **Analytics** | Aggregated statistics and trend charts across all shots. |
| **Library** | Coffee bean and grinder catalogue linked to shots. |
| **Einwählen** | Dial-in assistant: compare a target shot with recent attempts. |
| **Maintenance** | Five machine maintenance reminders (descaling, backflush, group head service, gaskets & screens, water filter) plus a per-grinder cleaning schedule. All tasks have configurable shot or day thresholds, progress bars and a "Done now" button. |
| **Bestellungen** | Barista order management backend *(requires `enable_orders: true`)*. Toggle order acceptance on/off, manage the drink menu (emoji + name, persisted in `/data/menu.json`), see the live order queue (pending / in progress) and history. Accept orders with an ETA picker, or decline with a free-text reason. Customer statistics panel shows total orders and per-customer breakdown. **Push notifications** (collapsible section): map each HA user ID to a `notify.mobile_app_*` service — the add-on then sends a push notification to that device when an order is accepted, completed, or declined (requires `homeassistant_api: true` and the HA Companion app). Customer-facing order placement is handled by the [GLP Order Card](https://github.com/mxkissnr/glp-order-card). |

### Live tab, switch entity and preheat timer

When `switch_entity` is set, the **Live** tab is hidden while the machine is off and appears automatically once it powers on. If no switch entity is configured the tab is always visible.

Once the machine turns on, a preheat progress bar and countdown are shown in the Live tab until `preheat_time` minutes have elapsed. The timer does **not** reset if the machine is briefly switched off and back on while the temperature is still above 80 °C (off for < 5 minutes) — short power cycles are ignored. The preheat state is also exposed as HA sensors via the companion integration (`binary_sensor.…preheat_ready`, `sensor.…preheat_elapsed`, `sensor.…preheat_remaining`).

### Import from kaffeebraun.com

In the Library tab, click **🔗 URL** next to "Add Bean", paste any product URL from [kaffeebraun.com](https://kaffeebraun.com) and press Import. The add-on fetches the product page server-side and pre-fills the bean form with:

- Name and roaster (auto-set to "Kaffee Braun")
- Aromas / tasting notes
- Origin (Herkunft)
- Processing method (Aufbereitungsart)
- Roast level label and score

Imported beans show a small **"Imported from kaffeebraun.com · date"** line in the library card so you always know where the data came from and when.

### Barcode and QR scanner

In the Library tab, tap **⬛ Scan** next to "Add Bean" to open the camera scanner.

- **EAN/UPC barcode** (e.g. on a supermarket coffee bag) — GLP looks up the code on [Open Food Facts](https://world.openfoodfacts.org) and pre-fills name, roaster and notes. Specialty coffees are often not in the database; fill in the rest manually.
- **GLP QR code** — scan a QR code generated by another GLP installation for a full instant import.
- Each bean in the library has a **QR button** that generates a shareable QR code encoding all bean fields.

Requires a Chromium-based browser (uses the native BarcodeDetector Web API). Not supported on Firefox or Safari.

### Light / Dark theme

GLP has a built-in theme toggle (⚙ Settings → Theme). The choice is saved in `localStorage` and applied immediately. **Dark** is the default; **Light** inverts the grey scale to a white-based palette.

### HA theme

A matching Home Assistant theme (`glp-ha-theme.yaml`) is included in the repository root. It provides **GLP Dark** and **GLP Light** variants for the full HA interface (sidebar, cards, inputs, switches, status colours).

**Installation:**
1. Copy `glp-ha-theme.yaml` to `config/themes/` in your HA config directory (create `themes/` if it doesn't exist).
2. Add `themes: !include_dir_merge_named themes` to `configuration.yaml` and restart HA once.
3. In your HA profile select *GLP Dark* or *GLP Light*.

### ALERTua/hass-gaggiuino compatibility

As of glp-integration v1.9.0, you no longer need to install [ALERTua/hass-gaggiuino](https://github.com/ALERTua/hass-gaggiuino). The GLP integration covers the same machine sensor set plus all GLP-specific sensors:

| Entity | glp-integration | hass-gaggiuino |
|---|---|---|
| `select.…_profile` | ✅ `select.gaggiuino_profiler_profile` | `select.gaggiuino_profile` |
| Temperature (live) | ✅ `sensor.…_machine_live_temperature` | ✅ |
| Target Temperature | ✅ `sensor.…_machine_target_temperature_live` | ✅ |
| Pressure (live) | ✅ `sensor.…_machine_live_pressure` | ✅ |
| Water Level | ✅ `sensor.…_machine_water_level` | ✅ |
| Weight (live) | ✅ `sensor.…_machine_live_weight` | ✅ |
| Uptime | ✅ `sensor.…_machine_uptime` | ✅ |
| Active Profile | ✅ `sensor.…_machine_live_profile` | ✅ |
| Brew Switch state | ✅ `binary_sensor.…_brew_switch` | ✅ |
| Steam Switch state | ✅ `binary_sensor.…_steam_switch` | ✅ |
| Shot count, score, maintenance, preheat … | ✅ (GLP-specific) | ✗ |

The profile endpoint design in GLP was inspired by the pioneering work in ALERTua/hass-gaggiuino. Thank you to [@ALERTua](https://github.com/ALERTua) for the original integration.

For full documentation — features, live mode, analytics, shot score, exports, compatibility — see the [Wiki](https://github.com/mxkissnr/gaggiuino-local-profiler/wiki).
