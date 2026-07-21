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

Bean variants come from the coffee library via `/api/orders/active-beans`: only beans that are actually still in stock are offered (remaining = bag stock minus the doses logged in shot annotations), and each bean carries its customer-facing description (taste notes, origin, processing) so the card can show what characterizes the coffee. Blend beans carry their full multi-origin data as `origins[]` (`{code, percent?}`) alongside the legacy single-string `origin`, so a Card version that supports it can render all of a blend's countries. A bean can also be manually excluded from the picker without deleting it or touching its stock — see the eye/eye-off toggle in the Coffee Library below.

Install via HACS: [github.com/mxkissnr/glp-order-card](https://github.com/mxkissnr/glp-order-card)

### API token

All components authenticate automatically via a shared token:

1. The app generates a random 64-character token at first start and stores it in `/data/api_token.txt`.
2. `GET /api/token` returns the token to requests originating from the HA Supervisor-internal network (loopback or `172.30.0.0/16`) — i.e. requests going through the HA Ingress proxy, or a valid Supervisor Bearer token (used by the HA integration). External LAN clients cannot read the token from an unauthenticated endpoint.
3. The browser UI reads the token via `/api/token` on startup (the request goes through the Supervisor) and includes it as an `X-GLP-Token` header on all subsequent requests.
4. Requests coming through HA Ingress bypass the token check entirely — HA already authenticated the user.
5. **GLP Order Card in direct-URL mode** (`glp_url` configured): set `glp_token: <your-token>` in the card YAML. Copy the token from **Settings → API Token** in the app UI (open the app once through HA Ingress, or on a session that already holds a valid token).

No manual configuration is required for the HA Ingress path. To rotate the token, delete `/data/api_token.txt` and restart the app.

#### Trust model

The API token grants full API access — including `/api/restore`, which wipes and replaces the entire database. Because of that, `/api/token` only ever hands out the token to two kinds of caller:

- **Supervisor-internal callers**: loopback and the HA Supervisor's own network (`172.30.0.0/16`). This covers the HA Ingress proxy (browser UI) and the GLP HA Integration, which authenticates with its Supervisor Bearer token.
- **Already-authenticated sessions**: a request that already carries a valid `X-GLP-Token` header.

Ordinary LAN or Docker-bridge addresses are *not* trusted — a device merely being able to reach port 8099 is no longer enough to obtain the token. Any other integration that needs the token directly (e.g. the Order Card in direct-URL mode) must be given it explicitly: open the app through HA Ingress, go to **Settings → API Token**, and use the copy button.

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

## Install as an App (PWA)

GLP can be installed as a standalone app (own icon, no browser address bar) when you open it directly — not through the Home Assistant dashboard/Ingress panel:

- **Android (Chrome)**: open the menu (⋮) → **Install app** (Chrome may also show an install banner automatically).
- **Desktop (Chrome/Edge)**: click the install icon in the address bar, or menu → **Install GLP…**.
- **iOS (Safari)**: tap the Share icon → **Add to Home Screen**.

Two important limitations:

- **Requires HTTPS.** Service workers need a secure context — a plain `http://` address on your LAN is not enough, even if you access GLP directly on its own port. You'll only get the install option if GLP sits behind your own HTTPS reverse proxy (or on a host Chrome otherwise treats as secure, like `localhost`).
- **Does not work through the HA Companion App / Ingress panel — by design.** GLP loads through Ingress there, and the manifest link + service worker registration are deliberately never sent to Ingress requests (see below). Inside the Companion App, GLP keeps running exactly as it does today: a normal embedded panel, no install prompt, no offline shell. This is intentional, not a bug — an earlier attempt at PWA support (v1.102.0) registered its service worker unconditionally and broke the Companion App's live shot graph; this version fixes that class of bug at the source instead of trying to detect it client-side.

### Layout

Desktop shows a horizontal **topbar tab row** (Shots / Live / Bibliothek / Statistiken / Bezugslog / Wartung / Bestellungen / Einstellungen, each with an inline icon, raised active surface, hidden-scrollbar horizontal overflow if it doesn't fit), the shot list panel, and the content area below. **This replaces v2.6.0's collapsible left navigation rail**, which was removed again after real Home Assistant Ingress testing showed it stacking a second left-hand menu on top of Ingress's own sidebar — if you liked the rail, please comment on the repo. The multi-machine switcher and machine online-dot/name sit in the topbar next to the tabs; the shot list panel keeps its own separate collapse button.

On narrow viewports (phones, portrait tablets) the topbar tabs are hidden and a **bottom navigation bar** takes over: Shots / Live / Bibliothek / Statistiken by default, plus a "Mehr" sheet collapsing Bezugslog / Wartung / Einstellungen / Bestellungen — every entry has an inline icon, no emoji anywhere in the nav chrome. The Shots tab opens the shot detail view directly — the last-selected shot (persisted in `localStorage`), falling back to the newest one. The shot list itself is reachable exclusively through the left **burger drawer**, which slides in as an overlay with a backdrop, closable via swipe-left or backdrop-tap, reachable from any view/mode alongside the bottom nav — so you can jump to the shot list without leaving Live, Bibliothek, or Statistiken first, and tapping a shot there closes the drawer and opens its detail view (with a back chevron in the topbar returning to wherever you came from). Buttons and controls that are hover-revealed on desktop (e.g. the shot-list compare button, the star rating) get a full 44×44px touch target on touch devices instead. Two things are not yet mirrored into the mobile layout: pending-count badges (Wartung/Bestellungen) don't show up on the "Mehr" sheet entries, only the section's visibility is gated the same way as on desktop; and the Live tab's pulsing "shot in progress" indicator isn't mirrored onto the bottom-nav icon, which only shows or hides.

**Configurable bottom-nav picks (mobile only).** Which 4 destinations show up as the main bottom-nav icons is configurable from Settings → "Mobile Navigationsleiste": a checkbox to show/hide each destination plus up/down arrows to reorder them (no drag-and-drop). Shots is pinned as a mandatory, always-first slot. Once 4 destinations are checked, further checkboxes disable themselves rather than silently bumping an earlier pick out of the bar. Anything left unchecked automatically falls into the "Mehr" overflow sheet. This sits on top of the existing capability gates — a destination hidden because the machine is offline (Live) or Orders isn't enabled (Bestellungen) still never appears in the bar even if selected. The choice is stored only in the browser (`localStorage`, not synced to the server); clearing site data or an empty/corrupted stored value falls back to exactly today's default set described above. Desktop's topbar is unaffected — this is mobile-only, by design.

## Configuration options

| Option | Description | Default |
|---|---|---|
| `machine_host` | **Deprecated since v2.0.0** — IP or hostname of the Gaggiuino controller. Used only once, on first start, to seed the default machine in the new [multi-machine registry](#multi-machine-v200) below; edit machines afterward from the app's Settings UI, not this option. | `gaggiuino.local` |
| `sync_interval` | Auto-sync interval in minutes (1–60) | `5` |
| `switch_entity` | HA switch entity to power the machine on/off | *(empty)* |
| `preheat_time` | Warmup time in minutes — how long after switch-on until the machine is ready to brew (1–120) | `20` |
| `enable_orders` | Enable the order management system — barista backend tab + customer order card support; disabled by default | `false` |
| `port` | Port the app server listens on (1024–65535) | `8099` |

## Multi-machine (v2.0.0)

GLP can manage more than one espresso machine from a single add-on instance — no second add-on install needed. Each machine is either:

- **Gaggiuino** — the original REST + protobuf-WebSocket machine type this app was built for. Full support: shot sync, live status, profile create/read/update/delete, profile select.
- **GaggiMate** ([jniebuhr/gaggimate](https://github.com/jniebuhr/gaggimate)) — a different ESP32 controller with a JSON WebSocket API and binary shot-history files. GLP's GaggiMate adapter is **experimental**: live status and shot history sync are supported and have been verified against real GaggiMate hardware as of v2.2.1–v2.2.3 (a WebSocket request-id correlation bug, a `.slog` URL zero-padding bug, and shot duration/profile-name mapping bugs were all found and fixed via live testing); profile editing is read-only (creating/editing GaggiMate profiles from GLP is a stretch goal for a later release); brew cannot be started from GLP (GaggiMate's own API has no start/stop command — only a Gaggiuino machine, and only via its physical brew switch, can be triggered from GLP, and even then GLP itself never sends a start command, only detects it).

| | Gaggiuino | GaggiMate |
|---|---|---|
| Shot sync | ✅ | ✅ |
| Live status (temp/pressure/flow) | ✅ | ✅ |
| Profile read | ✅ | ✅ |
| Profile create/update/delete | ✅ | 🚧 read-only in v2.0.0 |
| Brew start from GLP | ❌ (machine has no start API either) | ❌ (no start API) |

On upgrade from a pre-2.0.0 install, the existing `machine_host`/`switch_entity` add-on options are automatically migrated into machine #1 (named "Gaggiuino", marked as the **default machine**) — no manual steps, and every existing URL, shot id, image and annotation keeps working exactly as before. Add further machines from the app's **Settings** view (name, type, host, optional HA switch entity); each gets a "Test connection" button before saving. The default machine keeps its original REST API surface untouched.

A machine switcher in the topbar (only shown once a second machine is registered) lets you pick "All machines" or one specific machine — Shots list and Analytics scope to that choice, and in "All machines" mode each shot in the list carries a small machine-name badge. **Shot sync now runs for every registered machine** (not just the default one) — since v2.2.0 the scheduled and manual sync loops poll every enabled machine's own adapter and ingest its shots. **Live view is currently only available for the default machine** — additional machines don't have a live-status polling loop yet, so switching to one while on the Live tab shows an explanatory message instead of stale/fake data.

## Features

| Tab | Description |
|---|---|
| **Live** | Real-time pressure, flow, weight and temperature charts during a shot. When a brew starts, the most recent shot with the same profile name is automatically overlaid as a dashed reference curve. Can be overridden or cleared via the dropdown. The tab is only visible when the machine is on (requires `switch_entity`). |
| **Shots** | Shot history with full chart view, score, annotation (**coffee dropdown** from library, grinder, dose, notes, **drink type**, **bean age at shot time**, an optional **photo** of the shot shown as a small round thumbnail in the sidebar, next to the machine/freshness line in the shot-detail header, and a larger preview in the annotation panel, with upload/remove controls — picking a photo opens a zoom/pan crop editor so you control which part of the image becomes the thumbnail; clicking the thumbnail opens it fullscreen in a lightbox) and a fullscreen chart. The shot detail opens with a **verdict header**: a score ring plus the dial-in advice as a plain-language headline and a one-line subline (profile, shot no., bean, duration, avg pressure), replacing the old green dial-in banner and separate score badge. Below it, metrics are grouped into a **Recipe** zone (dose → yield, ratio + EY, duration + phases, bean & grinder **and grind setting**) above the chart and a **Process** zone (pressure, pump flow, temperature) below it — the chart itself is unchanged. Viewing the newest shot of a bean additionally shows a **"Letzter Mahlgrad"** (last grind) baseline chip next to the grind advice, with the last recorded grind setting for that bean, so the baseline and any suggested correction read together. When an earlier shot exists with the **same profile on the same machine**, the shot detail auto-compares against it: a **score delta chip** on the verdict header (e.g. "+2 vs. Shot 1"), signed delta chips on the Process zone's pressure/flow/temp metrics, and the previous shot's pressure/flow/weight curves overlaid on the chart as a dashed, lower-opacity **ghost curve** — all silently omitted when there's no earlier same-profile shot. This is separate from the explicit A/B compare button described below, which stays a manual, any-two-shots comparison. The **sidebar shot list** shows a rich 3-line card per shot (plus its photo thumbnail when it has one): profile name + right-aligned score (and a machine badge in "all machines" mode) on line 1, coffee + dose on line 2, star rating + grinder + grind setting + time-of-day on line 3; the compare button appears on row hover/focus (always visible on touch). When sorted by "Newest", the full timestamp moves into a separator header above each group instead of appearing per row, using **hybrid date grouping**: recent shots (today/yesterday, up to roughly the last 14 days) keep their own per-day header, while older shots collapse into per-month headers (e.g. "Juli 2026") instead of accumulating one header per day forever — each month header is a **collapsible accordion toggle** (▸/▾ chevron), collapsed by default and expandable on click, with the expanded state kept for the rest of the session (not persisted across reloads). The coffee field is a dropdown populated from your bean library — custom entries not in the library are preserved. Annotation fields **auto-save** 1 s after the last keystroke, with an inline status ("Speichert…" while pending, "Gespeichert" with a check icon once saved) — the save is also flushed immediately on field blur, tab/page hide, or switching shots/modes, so a pending edit is never silently lost. When a known bean is selected, the bean's age at shot time is calculated automatically from the active bag's roast date and stored in the annotation, and **grinder/grind setting/dose are prefilled from that bean's own history** (its best-scoring historical grinder+grind combo, falling back to its saved known grind setting, falling back to its own last shot) rather than from whichever shot happens to be chronologically last — the same applies to the **↩ Clone last** button, so switching beans often no longer carries over the wrong bean's grind setting. Drink type options are loaded from the same menu used by the orders feature. A **Share** button in the toolbar opens a format picker and exports the shot as a PNG card — two formats available: **Square (1:1)** 1080×1080 for feed posts, **Story (9:16)** 1080×1920 for Instagram Stories (the shot graph stays roughly square in Story format rather than stretching to fill the extra height). Uses the native Web Share API on mobile, falls back to download on desktop. Card layout matches the app's own dark/amber theme (not a separate black/white brand): GLP logo in header with shot ID and date, a small **circular shot photo** next to the headline when the shot has one, **bean name as the headline** (with a small origin-country stamp when the bean's origin is known) instead of the profile name, a **contextual phrase based on the score** (e.g. "Herausragender Shot"), a **star rating** row, profile name/machine and dose → yield · ratio · duration as secondary metadata, phase chips (Preinfusion / Extraktion in blue/orange) above the full-data chart — weight and temperature each get their own axis scale so the chart isn't dominated by empty space — with a soft-tint legend, two-column stats (DRUCK, PUMPENFLUSS, TEMPERATUR on the left; GEWICHT, GEWICHTSFLUSS, DAUER, DOSIS → YIELD · RATIO on the right), and a progress-ring score badge. |
| **Analytics** | Aggregated statistics across all shots: **Summary KPIs** (total shots, avg score, total coffee consumed, shots this week, longest daily streak), **Personal Bests** (best shot linked directly, longest streak, favourite bean/profile, busiest day), **Score Trend** chart (30 / 90 / all), **Shot Calendar** heatmap, **Bean Stats** cards, **Profile Performance** bar chart, **Grinder Stats** cards, **Coffee World Map** (interactive: scroll/pinch to zoom, drag to pan — choropleth of bean origin countries flat-filled in the app's accent color (any coffee from that country lights it up — shot count/bean list stays in the hover tooltip, not the fill), initial view auto-framed on the countries/beans that actually have data instead of the whole globe, a blend's shots split proportionally across its origin countries, plus a pulsing point per bean at its geocoded growing region or a country fallback with an always-visible label (auto-hidden when it would overlap a neighboring label) once it has at least one shot, flag + localized country name tooltips), **Dose & Ratio Distribution** histograms, **Time of Day** bar chart coloured by avg score, a **Weekday × Hour heatmap** (a true 7×24 shot-count matrix, same visual language as the Shot Calendar), a sortable **Bean Ranking** table (shots, avg score, last grind setting used, and a last-5-vs-previous-5 scored trend indicator — click a column to sort), a **Machine Comparison** table (avg score, avg duration, temperature stability — mean absolute deviation from target — per machine, shown once a second machine is registered; deliberately ignores the active-machine filter since comparing machines only makes sense across all of them), and a per-bean **Dial-In Progression** chart (grind setting and score plotted across that bean's own shot sequence, with a bean picker). |
| **Library** | Coffee bean and grinder catalogue plus a **Recipes** tab. Bean cards show the **origin** as its own eyebrow line above the bean name (serif under the Crema accent theme — see [Accent color scheme](#accent-color-scheme)), flavor tags as quiet outline pills, and a small proportional **stock-remaining bar** next to the existing gram figure. Bean cards also show a **star rating** (average of that bean's shot ratings, purely computed — no manual field), a **best grinder+grind-setting combo** (e.g. "Best combo: Niche Zero @ 18 · Ø score 92" — computed across the bean's whole shot history, grouped by grinder and grind setting, shown once at least 3 shots share a combo so the average isn't a fluke) and a **roast freshness badge** (days since roast, colored by degassing/peak/fading window, from the active bag's roast date — hidden once a stock-tracked bean's remaining stock hits zero). Beans support: **origin countries** (one or more, picked from a list of coffee-growing countries and shown as chips with flag and localized name — a bean with more than one origin is a blend, with an optional per-country weighting percent used to split its shots proportionally on the Analytics world map), **species** (Arabica / Robusta / Liberica / Blend — a constrained dropdown, manual-entry only), **variety/cultivar** (Bourbon, Geisha, Typica, Caturra, SL28, … with suggestions — distinct from species, since e.g. Red Bourbon is a cultivar within Arabica), **processing** (Washed, Natural, Honey, Anaerobic, … with suggestions), **tasting notes as tags** (chips input; imports fill them automatically, notes stays free for personal remarks — see also the **flavor wheel** below), **roast profile** (espresso / filter / omni, imported from shop tags), **growing region** (free text, geocoded server-side via Nominatim into map coordinates), a **product image** downloaded once from the shop on import (shown as a thumbnail and in the flavor wheel, clicking it opens it fullscreen in the same lightbox used for shot photos) — or uploaded manually if the automatic download fails (opens the same zoom/pan crop editor as shot photos), optional **altitude, importer, harvest, price, producer and certification** fields (shown only when set; altitude/importer/harvest/price are imported where the shop provides them), a manual **brew recommendation** (temperature, ratio, time, note — shown only when set; no import source provides this as structured data), decaf flag, bag/batch tracking (roast date, initial weight and an optional **batch/lot number** per bag, manual-entry only, consumption tracked per bag and total across all bags), a manual **enable/disable toggle** (eye/eye-off button next to edit/delete) to exclude a bean from the order card's bean picker without deleting it or touching its stock — independent of stock, a disabled bean's card is dimmed and shows a "Disabled" badge but stays fully visible and editable, URL import from kaffeebraun.com, hoppenworth-ploch.de and elbgold.com (each individually toggleable) plus a generic fallback (Shopify/JSON-LD/webpage metadata) for any other shop, with a settings panel to add your own Shopify shop domains, barcode scan, QR code. Grinders support an optional **burr type** (with suggestions), **purchase date**, a directly-uploaded **photo** (cropped via the same zoom/pan editor, clicking the thumbnail opens it fullscreen in the same lightbox used for shot and bean photos), and **burr wear tracking**: a "🔩 N shots · X g/kg since last burr swap" line (matched against annotated shots by grinder name, summing dose) with a "Burrs replaced" button to reset the counter — separate from the calendar/shot-count-based cleaning maintenance system, since burrs dull with cumulative throughput rather than calendar time. Recipes store brew method (Espresso, AeroPress, V60, French Press, Moka, Cold Brew), dose, yield, time, water temperature, water amount, ice amount, grind size, source URL and step-by-step workflow. A **Profiles** tab manages Gaggiuino machine profiles — see [Machine profile editor](#machine-profile-editor) below. |
| **Dial-in** | Dial-in assistant: compare a target shot with recent attempts. The shot view's grind advice additionally flags brew ratios outside the classic espresso window (1:1.8–2.2) when the duration itself is fine. A **Guided Dial-In wizard** — see [below](#guided-dial-in-wizard) — walks through the whole set-grind → pull-shot → evaluate → next-grind loop step by step. |
| **Maintenance** | A dashboard-style overview: **summary tiles** (due / soon / OK counts plus log entries this year) and an **"Als Nächstes" banner** naming the single most-overdue task and machine with an inline done-button (only shown when something is actually due). Five machine maintenance reminders (descaling, backflush, group head service, gaskets & screens, water filter) plus a per-grinder cleaning schedule, shown as compact tiles (status pill, progress bar, machine tag). In [multi-machine](#multi-machine-v200) setups, a **machine filter segment control** (local to this view, independent of the topbar switcher) scopes the whole dashboard to one machine or "all" — descaling/backflush/group head/gaskets are tracked **per machine**; water filter and grinder cleaning remain **global** ("geteilt"/"shared" tag, shown once) since that equipment is genuinely shared across machines. Each tile's threshold input, shots/days toggle and **guided walkthrough** (a step-by-step checklist that unlocks the done button once every step is ticked) live behind a "Details" expand instead of always-visible controls. Below the tiles: a **Maintenance Log** table (date, task, machine badge, shot count at time, notes) filtered to whichever scope is selected. Entries are created automatically when marking a task done; past events can be back-filled via the "Add entry" form (task, date, notes). Each entry can be deleted. Stored in `/data/maintenance_log.json`. |
| **Orders** | Barista order management backend *(requires `enable_orders: true`)*. Toggle order acceptance on/off, manage the drink menu (emoji + name + optional **variants** — either manually entered strings, automatically sourced from the active bean library via the 🫘 toggle, or from the active milk library via the 🥛 toggle, persisted in `/data/menu.json`), an optional milk amount per order (**ml**) that is deducted from the matching milk in the library on order completion — milks with no stock left drop out of the active list, see the live order queue with auto-suggested ETAs based on current queue length, and history. Accept orders with an ETA picker (pre-filled with queue estimate), or decline with a free-text reason. Customer statistics panel shows total orders and per-customer breakdown. **Push notifications** (collapsible section): three independent sub-sections — (1) **Broadcast recipients**: select one or more `notify.mobile_app_*` devices that receive a broadcast when orders open ("☕ open — order via the Kaffeebar menu"; preheat-aware: "opens in ~X min" while warming up) or close ("🚫 closed"); (2) **Barista notification**: one device that is notified instantly when any new order is placed (title: drink name, body: customer + note), when the machine finishes warming up ("☕ Machine ready — Warm-up complete — ready to brew"), and once per bag when a bean's remaining stock drops below 100 g ("🫘 Bean running low"); (3) **Per-customer mapping**: assign a specific device to each HA user (all `person.*` entities are listed, plus anyone who has already placed an order) — that device is notified when their individual order is accepted, completed, or declined. Requires `homeassistant_api: true` and the HA Companion app. Customer-facing order placement is handled by the [GLP Order Card](https://github.com/mxkissnr/glp-order-card). |

### Machine profile editor

> **⚠ Experimental / work in progress:** the bean-based profile suggestion ("Profil aus Bohne", the 🎛 Create profile button) is usable but not finished — it's a starting point derived from one fixed 4-phase skeleton, not a guarantee of a good shot for every bean. Always review the generated phases (and the live preview chart) before sending a suggested profile to the machine.

The **Profiles** tab in the Coffee Library lists the brew profiles currently stored on the machine (read via `GET /api/machine/profiles`), with edit and delete actions. "+ New profile" opens the profile editor blank; a **🎛 Create profile** button on each bean card opens it pre-filled with a suggestion derived from that bean.

The editor covers a profile's name, water temperature, recipe (dose/yield/ratio) and its phases — each phase has a name, type (Flow/Pressure/Manual), a target (start/end/curve/time/volume), a flow/pressure restriction, an optional per-phase water temperature override and stop conditions (time, pressure/flow thresholds, weight, water pumped). Phases can be added, removed and reordered; a live preview chart redraws as you edit, synthesizing a time series from the phase curves the same way the machine itself would run them.

**Bean-based suggestions** reuse a fixed 4-phase skeleton (adaptive preinfusion → bloom rest → linear pressure ramp → declining-flow finish) rather than inventing a different structure per bean — only the parameters vary: decaf and natural-process beans (more porous, easier to channel) get a longer, gentler preinfusion, a lower ramp pressure and a lower brew temperature; washed beans get a shorter preinfusion and standard espresso pressure.

"Send to machine" asks for confirmation, then creates or updates the profile directly on the Gaggiuino controller over its WebSocket API (the machine has no REST endpoint for writing profiles) — a failed send surfaces an error toast rather than failing silently.

### Guided Dial-In wizard

> **⚠ Experimental / work in progress:** the guided dial-in wizard is usable but still evolving — its grind suggestions are a starting point based on a target extraction-time band, not a guaranteed dial-in. Treat suggested grind steps as a helpful nudge, not gospel, and always confirm shots make sense before accepting a round.

The Dial-in tab's **"Start guided dial-in"** button (or the **🎯** button on any bean card in the Library) opens a step-by-step wizard for dialing in a new bean or grinder, instead of pulling shots and comparing them manually. The Gaggiuino machine has no way to control grind — the wizard only ever tells you what to set on your grinder, it never automates anything.

Setup pre-fills a starting grind from, in order: the bean's best historical (grinder, grind setting) combo across all its shots, the bean's saved **known grind setting** for the chosen grinder, the most recent shot ground on that grinder, or blank. Each round then shows the current grind setting large and waits for a shot — new shots are never auto-matched to the session (you might pull one for a guest mid-session): when one appears, it's offered as a candidate with explicit **"This is my dial-in shot"** / **"Not this one, still waiting"** buttons.

Once a shot is confirmed, it's scored and the wizard suggests the next grind setting using a target extraction-time band of 25–32 s (aiming for the middle, 28.5 s): a ±1 s dead zone counts as "in the zone", and the step size behaves like a binary search — it starts proportional to how far off the first shot was and halves every time the suggested direction flips (overshoot), down to a 0.3 floor below which further refinement is noise for most grinders. The session is considered dialed in once two shots in a row land in the dead zone, or two shots in a row score 80+ within 0.5 grind units of each other; after 6 rounds without either, the wizard says so instead of looping forever. Each round can be accepted, overridden with a custom grind value, or the session can be ended early — a compact chip strip along the bottom always shows the round history (grind → score).

At the end (converged or manually stopped), the best-scoring round can be saved as the bean's **known grind setting** for that grinder, feeding back into the starting-grind suggestion the next time the same bean/grinder combo is dialed in.

### Profile Dial-In wizard

The **🎯** button on any profile in the Profiles tab's list opens a sibling wizard to the Guided Dial-In above — same session/candidate-confirm architecture, but tunes a machine profile's phases instead of a grind setting, for when a freshly created or bean-suggested profile isn't quite right yet.

Each round: confirm the trial shot (never auto-matched, same reasoning as the grind wizard — you might pull one for a guest mid-session), see its score, and pick how it tasted (balanced / sour / bitter / watery / channeling). The pick maps to exactly one concrete phase adjustment: sour/underdeveloped lengthens the Preinfusion phase or raises the Ramp phase's target pressure; bitter/over-extracted lowers the water temperature, the Ramp pressure, or shortens the Decline phase; watery/thin lowers the target ratio or raises the Decline phase's flow restriction; channeling lengthens or raises the Preinfusion phase's saturation threshold (distribution/tamping still matters — a profile change alone can't fully fix channeling). The step size behaves like a binary search on that one field, same philosophy as the grind wizard: it halves whenever the suggested direction reverses. Accepting a round sends the updated profile straight back to the machine before the next round starts waiting — there's no separate save step, the machine always reflects the session's current profile. The session converges on two consecutive "balanced" picks, two consecutive scores of 80+, or a 6-round safety valve.

This first version deliberately doesn't parse the phase data embedded on a shot record as a tuning signal — that field's exact shape hasn't been confirmed against real hardware — so the suggestion logic relies only on the shot's overall score and your own taste judgment, not an automated curve comparison.

### First-run onboarding & demo mode

If the Gaggiuino controller can't be reached (wrong/unreachable `machine_host`), GLP shows a dismissible banner at the top of the page naming the configured host, with a link to the [wiki](https://github.com/mxkissnr/gaggiuino-local-profiler/wiki) for setup help. Dismissal is per browser session.

When the database has no shots yet **and** the machine has never been reachable, the Shots view shows a **first-run onboarding panel** instead of the plain empty state: three setup steps (set `machine_host`, ensure the Gaggiuino is on the network, restart the add-on) plus a **"Load demo data"** button.

Loading demo data seeds a static sample dataset — about a dozen shots with plausible pressure/flow/temperature curves and ratings, three sample beans (including a blend using the multi-origin `origins[]` field), and one recipe — so the Shots, Analytics (world map, score trend, bean stats), and flavor wheel views are populated for evaluation. While demo data is present, a **"Demo mode"** badge with an **"End demo"** button is shown in the sidebar; ending demo mode deletes exactly the seeded rows. Demo data can only be loaded into an otherwise empty database (no existing shots/beans/recipes).

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

The same **🔗 URL** field also accepts product URLs from [hoppenworth-ploch.de](https://hoppenworth-ploch.de) (Hoppenworth & Ploch, Frankfurt). The import uses the shop's structured product data and pre-fills: name (e.g. "Shyira Washed - Ruanda"), roaster, tasting notes as **flavor tags**, **origin country** (mapped from the title), growing **region**, **variety**, **processing**, **roast profile** (from the Espresso/Filter shop tags), and the **decaf** flag for DECAF products. When the shop offers the same bean in more than one size at different prices, a picker asks which size you bought before the form is filled — the chosen size's price and weight are used together, so they always match.

### Import from elbgold.com

The same field also accepts product URLs from [elbgold.com](https://elbgold.com) (Hamburg). Unlike the other two sources, elbgold's product pages carry no structured spec table — the description is free German prose — so the import is **best-effort**: name and roaster ("elbgold") are exact; tasting notes are parsed from a "Noten von …" sentence, or — when that's absent — a fallback keyword scan over the prose following a "Sensorik"/"Geschmack"/"Aromen" heading against a small curated German vocabulary (not exhaustive; some products' wording may still yield nothing); the growing region comes from a "Herkunft – …" heading; origin countries are detected by scanning the full description for coffee-growing country names — up to 3 distinct countries are treated as a genuine blend, more than that is treated as noise (e.g. shop boilerplate) and left unmapped; roast profile comes from the Espresso/Filter shop tags; decaf is detected from the title. Always review the pre-filled form before saving.

### Import from any other shop

The **⚙ Sources** button next to **🔗 URL** opens the import settings panel: each of the 3 built-in parsers above can be disabled, and you can add your own Shopify shop domains — those get routed straight through the Shopify-specific parser below.

For any URL that isn't one of the 3 built-ins or a domain you've added, the import automatically tries, in order, until one succeeds:

1. **Generic Shopify** — every Shopify storefront exposes a `<product-url>/products/<handle>.js` endpoint; if the URL matches, its JSON is parsed the same way as the built-in Shopify shops (name, roaster, description-derived flavors/origins, image, price, size variants). The curated flavor vocabulary now includes more specialty/English terms (lychee, tropical, lactic, guava, passion fruit, papaya, in addition to mango) and is matched heading-agnostically, so shops without an elbgold-style "Sensorik/Geschmack" heading still get flavor tags extracted. The roaster name prefers a real name (`og:site_name` or a header-logo `alt` attribute) over the bare shop hostname when the shop's `vendor` field doesn't read as a real roaster name (e.g. a shop that misuses it for a taste-profile tag). The **producer** field, when present, is now applied to the bean instead of being parsed and silently dropped before reaching the import dialog. The downloaded product image is kept up to **4 MB** (previously capped at 1.5 MB, which silently dropped some real Shopify photos). Some themes render **process/variety/producer/region/origin/elevation/roast type and a brew guide** only into the product page's HTML, not the `.js` JSON — when the JSON leaves those fields empty, a bounded, SSRF-checked second fetch of the product page scrapes accordion label:value lines, the tasting-notes subtitle and any brew-guide recipe block, filling gaps into the bean's notes without ever overwriting a value the JSON already provided; text extraction inserts newlines at `<br>`/`<p>`/`<div>`/`<li>`/heading/`<tr>` boundaries so adjacent block-level content (e.g. "Espresso" / "In: 19.7g" / "Out: 48g") doesn't get silently concatenated into one run-on line. The brew guide's Temp/Time/Ratio lines are additionally mapped into the bean's structured `brewTempC`/`brewTimeS`/`brewRatio` fields (ranges resolved via midpoint) plus a `brewNotes` caveat sentence, the same as the built-in parsers.
2. **JSON-LD** — many shops embed a `schema.org/Product` block (`<script type="application/ld+json">`) with name, image, description and price, regardless of the storefront platform.
3. **Webpage metadata** — as a last resort, the `og:title`/`og:image`/`og:description` meta tags almost every product page sets, plus `og:site_name` as a roaster guess and `og:price:amount`/`product:price:amount` for price, with the same flavor-keyword and origin-country detection run on the combined text. If that text is too thin to find anything (short, or no origin/flavor hit), the visible page body is scanned as well (capped, preferring a `<main>`/`<article>` container) without discarding anything the meta tags already found.

The import result shows which of these methods produced the data (e.g. "Source: generic Shopify (shop.example.com)", "Source: JSON-LD (…)", "Source: webpage metadata (…)"). Anything other than a built-in parser is best-effort — always review the pre-filled fields before saving.

Every import is also checked against your existing library for a likely duplicate — the same URL imported before, or a bean with the same name and roaster — and shows a non-blocking "⚠ May already be in your library: …" hint if one is found; you can still import anyway (e.g. a new bag of the same bean).

Fetches are hardened against SSRF: only `https://` URLs are accepted, and the target hostname (and every redirect hop) is resolved and rejected if it points at a private, loopback, link-local or carrier-grade-NAT address instead of a public one.

### Coffee flavor wheel

Any bean with tasting-note tags shows a 🎡 button in the library. It opens a sunburst chart of the coffee flavor hierarchy — the category structure follows the SCA/WCR *Coffee Taster's Flavor Wheel* (2016); this is our own derived data, translated into all 6 UI languages (DE, EN, IT, FR, ES, NL), not the original artwork. Flavors from the bean's tags are matched against the wheel (exact label in any of the 6 languages, a German alias table for compound/colloquial terms, then word-boundary text containment). Every segment always renders at full saturation in its real category color and carries its own label, rotated to follow its wedge's spoke on the outer two rings (exactly like the printed poster — you tilt your head to read the far side), with ECharts' own overlap detection quietly dropping a label only where a wedge is genuinely too thin to hold legible text. A bean's actual matched flavors (plus their ancestor categories) are called out instead via a bright white glow/border rather than by dimming everything else, so they still pop against the now fully-colored wheel. Flavors that couldn't be matched are listed as plain chips below the chart so nothing gets silently dropped. The wheel modal never scrolls — it always fits the viewport, and can be closed via the ✕ or by tapping outside it.

If every matched flavor falls under a single branch — the common case, one or two tasting notes — the wheel opens already zoomed into that branch instead of the full 9-category overview, so the relevant wedge has room for readable text from the start. Tap or click any wedge (with sub-flavors) to zoom into it, or any crumb in the breadcrumb above the chart to jump back to it — both work identically on touch and with a mouse.

### Machine profile editor

> **⚠ Experimental / work in progress:** the bean-based profile suggestion (🎛 Create profile) is usable but not finished — treat it as a starting point, not a guarantee of a good shot. Always review the generated phases and the live preview chart before sending a suggestion to the machine.

The **Profiles** tab in the Coffee Library lists your Gaggiuino machine's profiles (fetched over the machine's WebSocket API) with edit/delete controls, plus a "+ New profile" button. The editor covers a profile's name, water temperature, recipe (dose/yield/ratio) and a full **phase editor** — each phase has a name, type (Flow / Pressure / Manual), a target transition (start/end/curve/duration/volume), a restriction value, an optional per-phase water temperature override, stop conditions (time, pressure above/below, flow above/below, weight, water pumped) and a skip toggle. Phases can be added and removed freely; a **live preview chart** redraws as you edit, synthesizing a time series from each phase's target curve so you can see the shape of the shot before sending it to the machine.

Every bean card has a **🎛 Create profile** button that opens the editor pre-filled with a profile suggestion built from that bean's attributes. The suggestion always reuses the same fixed 4-phase skeleton — adaptive preinfusion (stops on time, pressure or volume, whichever comes first), a bloom pause, a linear pressure ramp, and a declining-flow finish — only the parameters vary: decaf beans and natural-processed beans (both leave a more porous, uneven puck) get a longer, gentler preinfusion, a lower target ramp pressure and a lower brew temperature; the recipe's dose/yield/ratio come from the bean's manual brew ratio if one is set, otherwise a default 18 g → 36 g (1:2) recipe is used. The suggestion can also be applied from inside the editor via the "Apply bean suggestion" button when it was opened from a bean.

"Send to machine" asks for confirmation (existing values on the machine are overwritten) and then creates or updates the profile over the machine's WebSocket API; a failed request shows an error toast instead of failing silently.

### Barcode and QR scanner

In the Library tab, tap **⬛ Scan** next to "Add Bean" to open the camera scanner.

- **EAN/UPC barcode** (e.g. on a supermarket coffee bag) — GLP looks up the code on [Open Food Facts](https://world.openfoodfacts.org) and pre-fills name, roaster and notes. Specialty coffees are often not in the database; fill in the rest manually.
- **GLP QR code** — scan a QR code generated by another GLP installation for an instant import of name, roaster, roast date and notes.
- Each bean in the library has a **QR button** that generates a shareable QR code encoding its name, roaster, roast date and notes (notes truncated to keep the code reliably scannable).

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

### Accent color scheme

Independent of the Dark/Light toggle, ⚙ Settings → Color scheme offers six accent themes: **Amber** (default), **Ocean**, **Aurora**, **Ember**, **Forest** and **Crema**. Each has its own dark and light variant, contrast-checked to a ≥4.5:1 floor for text on its own background. **Crema** is the odd one out — it also warms the neutral grey scale itself (espresso-brown instead of true grey) rather than only recoloring accents — and pairs with a bundled serif display font (Fraunces, SIL Open Font License, served locally, no external font CDN) used exclusively for bean names in the Bibliothek view and on the shareable shot card; every numeric/data display stays in the regular sans-serif font regardless of accent theme.

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
