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
2. `GET /api/token` returns the token to requests originating from the HA Supervisor network (`172.30.x.x`) — i.e. requests going through the HA Ingress proxy. External LAN clients cannot read the token from an unauthenticated endpoint.
3. The browser UI reads the token via `/api/token` on startup (the request goes through the Supervisor) and includes it as an `X-GLP-Token` header on all subsequent requests.
4. Requests coming through HA Ingress bypass the token check entirely — HA already authenticated the user.
5. **GLP Order Card in direct-URL mode** (`glp_url` configured): set `glp_token: <your-token>` in the card YAML. The token is printed in the add-on logs on first start.

No manual configuration is required for the HA Ingress path. To rotate the token, delete `/data/api_token.txt` and restart the add-on.

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
| **Shots** | Shot history with full chart view, score, annotation (coffee, grinder, dose, notes, **drink type**, **bean age at shot time**) and a fullscreen chart. Annotation fields **auto-save** 1 s after the last keystroke. When a known bean is selected, the bean's age at shot time is calculated automatically from the active bag's roast date and stored in the annotation. Drink type options are loaded from the same menu used by the orders feature. |
| **Analytics** | Aggregated statistics across all shots: **Summary KPIs** (total shots, avg score, total coffee consumed, shots this week, longest daily streak), **Personal Bests** (best shot linked directly, longest streak, favourite bean/profile, busiest day), **Score Trend** chart (30 / 90 / all), **Shot Calendar** heatmap, **Bean Stats** cards, **Profile Performance** bar chart, **Grinder Stats** cards, **Dose & Ratio Distribution** histograms, **Time of Day** bar chart coloured by avg score. |
| **Library** | Coffee bean and grinder catalogue plus a **Recipes** tab. Beans support: decaf flag, bag/batch tracking (roast date + initial weight per bag, consumption tracked per bag and total across all bags), URL import from kaffeebraun.com, barcode scan, QR code. Recipes store brew method (Espresso, AeroPress, V60, French Press, Moka, Cold Brew), dose, yield, time, water temperature, water amount, ice amount, grind size, source URL and step-by-step workflow. |
| **Dial-in** | Dial-in assistant: compare a target shot with recent attempts. |
| **Maintenance** | Five machine maintenance reminders (descaling, backflush, group head service, gaskets & screens, water filter) plus a per-grinder cleaning schedule. All tasks have configurable shot or day thresholds, progress bars and a "Done now" button. Below the cards: a **Maintenance Log** that records every service event — date, task, shot count at time and machine hostname. Entries are created automatically when marking a task done; past events can be back-filled via the "Add entry" form (task, date, notes). Each entry can be deleted. Stored in `/data/maintenance_log.json`. |
| **Orders** | Barista order management backend *(requires `enable_orders: true`)*. Toggle order acceptance on/off, manage the drink menu (emoji + name + optional **variants** such as Regular / Decaf, persisted in `/data/menu.json`), see the live order queue with auto-suggested ETAs based on current queue length, and history. Accept orders with an ETA picker (pre-filled with queue estimate), or decline with a free-text reason. Customer statistics panel shows total orders and per-customer breakdown. **Push notifications** (collapsible section): three independent sub-sections — (1) **Broadcast recipients**: select one or more `notify.mobile_app_*` devices that receive a broadcast when orders open ("☕ open — order via the Kaffeebar menu"; preheat-aware: "opens in ~X min" while warming up) or close ("🚫 closed"); (2) **Barista notification**: one device that is notified instantly when any new order is placed (title: drink name, body: customer + note); (3) **Per-customer mapping**: assign a specific device to each HA user (all `person.*` entities are listed, plus anyone who has already placed an order) — that device is notified when their individual order is accepted, completed, or declined. Requires `homeassistant_api: true` and the HA Companion app. Customer-facing order placement is handled by the [GLP Order Card](https://github.com/mxkissnr/glp-order-card). |

### Live tab, switch entity and preheat timer

When `switch_entity` is set, the **Live** tab is hidden while the machine is off and appears automatically once it powers on. If no switch entity is configured the tab is always visible.

Once the machine turns on, a preheat progress bar and countdown are shown in the Live tab. The machine is considered ready when **thermal stability** is detected: temperature must remain within ±1.5 °C over the last 30 seconds while at or near the target temperature. The fixed `preheat_time` timer acts as a safety ceiling — the machine will always be marked ready after that many minutes even if stability was not detected. The timer does **not** reset on brief power cycles (off for < 5 minutes, still above 80 °C). The preheat state is exposed as HA sensors via the companion integration (`binary_sensor.…preheat_ready`, `sensor.…preheat_elapsed`, `sensor.…preheat_remaining`).

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

### UI language

GLP ships with six interface languages selectable in ⚙ Settings → Language:

| Code | Language |
|---|---|
| DE | Deutsch |
| EN | English |
| IT | Italiano |
| FR | Français |
| ES | Español |
| NL | Nederlands |

The selection is saved in `localStorage`. All UI strings, chart labels, grind recommendations, maintenance reminders, order status messages, and library labels are fully translated in all six languages.

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
