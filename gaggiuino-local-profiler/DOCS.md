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
  │         GLP App               │  ← this app
  │  Node.js server, port 8099       │
  │  stores data in /data/glp.db     │
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

† requires enable_orders: true in app configuration
```

### GLP App (this repo)

The central piece. It syncs shot history from the Gaggiuino machine, stores it in a local SQLite database (`/data/glp.db`), and serves:
- A web UI accessible via HA Ingress (the ☕ panel icon in the HA sidebar)
- A REST API on port 8099 consumed by the integration and the Lovelace cards

### GLP HA Integration

A custom component that polls the app every 60 s (configurable). It exposes all GLP data as native HA sensors — shot count, last shot profile, score, duration, weight, maintenance status, preheat state, etc. — so they can be used in automations, energy dashboards, and Lovelace dashboards.

Install via HACS: [github.com/mxkissnr/glp-integration](https://github.com/mxkissnr/glp-integration)

### GLP Shot Card

A custom Lovelace card that displays machine status, last shot summary, preheat progress, a power button and a **profile selector**. It talks to port 8099 directly and reads the `switch_entity` from the `machine_status` sensor attribute (set automatically by the integration) — no manual card configuration needed.

The profile selector reads and writes `select.gaggiuino_profiler_profile`, provided natively by the GLP Integration (v1.9.0+). The selector is automatically hidden when the entity is not present.

Install via HACS: [github.com/mxkissnr/glp-lovelace-card](https://github.com/mxkissnr/glp-lovelace-card)

### GLP Order Card

A customer-facing Lovelace card for the order system. Customers browse the drink menu, place an order and track its status in real time. When the barista marks an order as done, the card shows the shot summary with a pressure sparkline. Requires `enable_orders: true` in the app configuration.

Bean variants come from the coffee library via `/api/orders/active-beans`: only beans that are actually still in stock are offered (remaining = bag stock minus the doses logged in shot annotations), and each bean carries its customer-facing description (taste notes, origin, processing) so the card can show what characterizes the coffee.

Install via HACS: [github.com/mxkissnr/glp-order-card](https://github.com/mxkissnr/glp-order-card)

### API token

All components authenticate automatically via a shared token:

1. The app generates a random 64-character token at first start and stores it in `/data/api_token.txt`.
2. `GET /api/token` returns the token to requests originating from the HA Supervisor network (`172.30.x.x`) — i.e. requests going through the HA Ingress proxy. External LAN clients cannot read the token from an unauthenticated endpoint.
3. The browser UI reads the token via `/api/token` on startup (the request goes through the Supervisor) and includes it as an `X-GLP-Token` header on all subsequent requests.
4. Requests coming through HA Ingress bypass the token check entirely — HA already authenticated the user.
5. **GLP Order Card in direct-URL mode** (`glp_url` configured): set `glp_token: <your-token>` in the card YAML. The token is printed in the app logs on first start.

No manual configuration is required for the HA Ingress path. To rotate the token, delete `/data/api_token.txt` and restart the app.

All persistent data is stored in SQLite (`/data/glp.db`) with WAL journal mode enabled — writes are crash-safe by default, with no half-written state possible.

### API spec

A machine-readable OpenAPI 3.0.3 specification of all endpoints is served at `GET /api/openapi.json` (no auth required) and committed as [`openapi.yaml`](openapi.yaml) in the repository. You can paste the URL or the file into [Swagger Editor](https://editor.swagger.io/) to browse the full API.

## Quick start

Set `machine_host` to your controller's IP or hostname and start the app.

```yaml
machine_host: "192.168.1.42"           # IP or hostname of your Gaggiuino controller
sync_interval: 5
switch_entity: "switch.espresso_plug"  # optional
```

Verify connectivity from the HA terminal:
```bash
curl http://<gaggiuino-ip>/api/shots/latest
```

## Configuration options

| Option | Description | Default |
|---|---|---|
| `machine_host` | IP or hostname of the Gaggiuino controller | `gaggia.intern` |
| `sync_interval` | Auto-sync interval in minutes (1–60) | `5` |
| `switch_entity` | HA switch entity to power the machine on/off | *(empty)* |
| `preheat_time` | Warmup time in minutes — how long after switch-on until the machine is ready to brew (1–120) | `20` |
| `enable_orders` | Enable the order management system — barista backend tab + customer order card support; disabled by default | `false` |
| `port` | Port the app server listens on (1024–65535) | `8099` |

## Features

| Tab | Description |
|---|---|
| **Live** | Real-time pressure, flow, weight and temperature charts during a shot. When a brew starts, the most recent shot with the same profile name is automatically overlaid as a dashed reference curve. Can be overridden or cleared via the dropdown. The tab is only visible when the machine is on (requires `switch_entity`). |
| **Shots** | Shot history with full chart view, score, annotation (**coffee dropdown** from library, grinder, dose, notes, **drink type**, **bean age at shot time**) and a fullscreen chart. When sorted by "Newest", shots older than the current month collapse into per-month sections in the sidebar (click to expand) — the current month always stays a flat list. The coffee field is a dropdown populated from your bean library — custom entries not in the library are preserved. Annotation fields **auto-save** 1 s after the last keystroke. When a known bean is selected, the bean's age at shot time is calculated automatically from the active bag's roast date and stored in the annotation. Drink type options are loaded from the same menu used by the orders feature. A **Share** button in the toolbar opens a format picker and exports the shot as a PNG card — two formats available: **Square (1:1)** 1080×1080 for feed posts, **Story (9:16)** 1080×1920 for Instagram Stories. Uses the native Web Share API on mobile, falls back to download on desktop. Card layout: black/white theme, GLP logo in header with shot ID and date, profile name, bean, dose → yield · ratio · duration, phase chips (Preinfusion / Extraktion in blue/orange) above the full-data chart with legend, two-column stats (DRUCK, PUMPENFLUSS, TEMPERATUR on the left; GEWICHT, GEWICHTSFLUSS, DAUER, DOSIS → YIELD · RATIO on the right), score badge. |
| **Analytics** | Aggregated statistics across all shots: **Summary KPIs** (total shots, avg score, total coffee consumed, shots this week, longest daily streak), **Personal Bests** (best shot linked directly, longest streak, favourite bean/profile, busiest day), **Score Trend** chart (30 / 90 / all), **Shot Calendar** heatmap, **Bean Stats** cards, **Profile Performance** bar chart, **Grinder Stats** cards, **Coffee World Map** (interactive: scroll/pinch to zoom, drag to pan — choropleth of bean origin countries colored by shot count, a blend's shots split proportionally across its origin countries, plus a pulsing point per bean at its geocoded growing region or a country fallback, flag + localized country name tooltips), **Dose & Ratio Distribution** histograms, **Time of Day** bar chart coloured by avg score. |
| **Library** | Coffee bean and grinder catalogue plus a **Recipes** tab. Bean cards show a **star rating** (average of that bean's shot ratings, purely computed — no manual field) and a **roast freshness badge** (days since roast, colored by degassing/peak/fading window, from the active bag's roast date). Beans support: **origin countries** (one or more, picked from a list of coffee-growing countries and shown as chips with flag and localized name — a bean with more than one origin is a blend, with an optional per-country weighting percent used to split its shots proportionally on the Analytics world map), **variety** (Arabica, Robusta, Geisha, … with suggestions), **processing** (Washed, Natural, Honey, Anaerobic, … with suggestions), **tasting notes as tags** (chips input; imports fill them automatically, notes stays free for personal remarks — see also the **flavor wheel** below), **roast profile** (espresso / filter / omni, imported from shop tags), **growing region** (free text, geocoded server-side via Nominatim into map coordinates), a **product image** downloaded once from the shop on import (shown as a thumbnail and in the flavor wheel) — or uploaded manually if the automatic download fails, optional **altitude, importer, harvest, price, producer and certification** fields (shown only when set; altitude/importer/harvest/price are imported where the shop provides them), a manual **brew recommendation** (temperature, ratio, time, note — shown only when set; no import source provides this as structured data), decaf flag, bag/batch tracking (roast date + initial weight per bag, consumption tracked per bag and total across all bags), URL import from kaffeebraun.com, hoppenworth-ploch.de and elbgold.com, barcode scan, QR code. Grinders support an optional **burr type** (with suggestions), **purchase date** and a directly-uploaded **photo**. Recipes store brew method (Espresso, AeroPress, V60, French Press, Moka, Cold Brew), dose, yield, time, water temperature, water amount, ice amount, grind size, source URL and step-by-step workflow. |
| **Dial-in** | Dial-in assistant: compare a target shot with recent attempts. The shot view's grind advice additionally flags brew ratios outside the classic espresso window (1:1.8–2.2) when the duration itself is fine. |
| **Maintenance** | Five machine maintenance reminders (descaling, backflush, group head service, gaskets & screens, water filter) plus a per-grinder cleaning schedule. All tasks have configurable shot or day thresholds, progress bars and a "Done now" button. Backflush and descaling additionally offer a **guided walkthrough**: a step-by-step checklist that unlocks the done button once every step is ticked and then logs the task. Below the cards: a **Maintenance Log** that records every service event — date, task, shot count at time and machine hostname. Entries are created automatically when marking a task done; past events can be back-filled via the "Add entry" form (task, date, notes). Each entry can be deleted. Stored in `/data/maintenance_log.json`. |
| **Orders** | Barista order management backend *(requires `enable_orders: true`)*. Toggle order acceptance on/off, manage the drink menu (emoji + name + optional **variants** — either manually entered strings, automatically sourced from the active bean library via the 🫘 toggle, or from the active milk library via the 🥛 toggle, persisted in `/data/menu.json`), an optional milk amount per order (**ml**) that is deducted from the matching milk in the library on order completion — milks with no stock left drop out of the active list, see the live order queue with auto-suggested ETAs based on current queue length, and history. Accept orders with an ETA picker (pre-filled with queue estimate), or decline with a free-text reason. Customer statistics panel shows total orders and per-customer breakdown. **Push notifications** (collapsible section): three independent sub-sections — (1) **Broadcast recipients**: select one or more `notify.mobile_app_*` devices that receive a broadcast when orders open ("☕ open — order via the Kaffeebar menu"; preheat-aware: "opens in ~X min" while warming up) or close ("🚫 closed"); (2) **Barista notification**: one device that is notified instantly when any new order is placed (title: drink name, body: customer + note), when the machine finishes warming up ("☕ Machine ready — Warm-up complete — ready to brew"), and once per bag when a bean's remaining stock drops below 100 g ("🫘 Bean running low"); (3) **Per-customer mapping**: assign a specific device to each HA user (all `person.*` entities are listed, plus anyone who has already placed an order) — that device is notified when their individual order is accepted, completed, or declined. Requires `homeassistant_api: true` and the HA Companion app. Customer-facing order placement is handled by the [GLP Order Card](https://github.com/mxkissnr/glp-order-card). |

### Live tab, switch entity and preheat timer

When `switch_entity` is set, the **Live** tab is hidden while the machine is off and appears automatically once it powers on. If no switch entity is configured the tab is always visible.

Once the machine turns on, a preheat progress bar and countdown are shown in the Live tab. The machine is considered ready when **thermal stability** is detected: temperature must remain within ±1.5 °C over the last 30 seconds while at or near the target temperature. The fixed `preheat_time` timer acts as a safety ceiling — the machine will always be marked ready after that many minutes even if stability was not detected. The timer does **not** reset on brief power cycles (off for < 5 minutes, still above 80 °C). The preheat state is exposed as HA sensors via the companion integration (`binary_sensor.…preheat_ready`, `sensor.…preheat_elapsed`, `sensor.…preheat_remaining`).

### Import from kaffeebraun.com

In the Library tab, click **🔗 URL** next to "Add Bean", paste any product URL from [kaffeebraun.com](https://kaffeebraun.com) and press Import. The app fetches the product page server-side and pre-fills the bean form with:

- Name and roaster (auto-set to "Kaffee Braun")
- Aromas as **flavor tags** (chips)
- Origin (Herkunft) — single-country origins are mapped to the structured origin country field (flag + localized name); blends stay in the notes
- Processing method (Aufbereitungsart) — fills the structured processing field
- Roast level label and score

Imported beans show a small **"Imported from kaffeebraun.com · date"** line in the library card so you always know where the data came from and when.

### Import from hoppenworth-ploch.de

The same **🔗 URL** field also accepts product URLs from [hoppenworth-ploch.de](https://hoppenworth-ploch.de) (Hoppenworth & Ploch, Frankfurt). The import uses the shop's structured product data and pre-fills: name (e.g. "Shyira Washed - Ruanda"), roaster, tasting notes as **flavor tags**, **origin country** (mapped from the title), growing **region**, **variety**, **processing**, **roast profile** (from the Espresso/Filter shop tags), and the **decaf** flag for DECAF products.

### Import from elbgold.com

The same field also accepts product URLs from [elbgold.com](https://elbgold.com) (Hamburg). Unlike the other two sources, elbgold's product pages carry no structured spec table — the description is free German prose — so the import is **best-effort**: name and roaster ("elbgold") are exact; tasting notes are parsed from a "Noten von …" sentence, or — when that's absent — a fallback keyword scan over the prose following a "Sensorik"/"Geschmack"/"Aromen" heading against a small curated German vocabulary (not exhaustive; some products' wording may still yield nothing); the growing region comes from a "Herkunft – …" heading; origin countries are detected by scanning the full description for coffee-growing country names — up to 3 distinct countries are treated as a genuine blend, more than that is treated as noise (e.g. shop boilerplate) and left unmapped; roast profile comes from the Espresso/Filter shop tags; decaf is detected from the title. Always review the pre-filled form before saving.

### Coffee flavor wheel

Any bean with tasting-note tags shows a 🎡 button in the library. It opens a sunburst chart of the coffee flavor hierarchy — the category structure follows the SCA/WCR *Coffee Taster's Flavor Wheel* (2016); this is our own derived data (English + German labels), not the original artwork. Flavors from the bean's tags are matched against the wheel (exact label, a German alias table for compound/colloquial terms, then word-boundary text containment) and highlighted together with their parent categories; everything else is dimmed. Flavors that couldn't be matched are listed as plain chips below the chart so nothing gets silently dropped.

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
