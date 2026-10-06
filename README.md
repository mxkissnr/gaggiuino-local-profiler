<p align="center">
  <img src="gaggiuino-local-profiler/logo.svg" alt="Gaggiuino Local Profiler" width="660"/>
</p>

<p align="center">
  <a href="https://github.com/mxkissnr/gaggiuino-local-profiler/releases/latest">
    <img src="https://img.shields.io/github/v/tag/mxkissnr/gaggiuino-local-profiler?color=%23f59e0b&label=Version&style=flat-square" alt="Version"/>
  </a>
  <img src="https://img.shields.io/badge/Home%20Assistant-App-41bdf5?logo=home-assistant&style=flat-square" alt="HA App"/>
  <img src="https://img.shields.io/badge/arch-amd64%20%7C%20armv7%20%7C%20aarch64-6b7280?style=flat-square" alt="Architectures"/>
  <img src="https://img.shields.io/badge/Backend-Go-00ADD8?logo=go&style=flat-square" alt="Go backend"/>
  <img src="https://img.shields.io/badge/Built%20with%20AI-Claude%20%2B%20DeepSeek-D97706?style=flat-square" alt="Built with AI: Claude + DeepSeek"/>
  <img src="https://img.shields.io/badge/license-GPL--3.0-blue?style=flat-square" alt="License GPL-3.0"/>
</p>

<p align="center">
  Local shot-profiling dashboard for <a href="https://gaggiuino.github.io/">Gaggiuino</a>- and <a href="https://github.com/jniebuhr/gaggimate">GaggiMate</a>-based espresso machines.<br/>
  Syncs shots automatically, visualizes extraction profiles and provides a real-time live view — all from Home Assistant.
</p>

<p align="center">
  <img src="gaggiuino-local-profiler/docs/screenshots/shots.png" alt="Shots view with pressure/flow/weight/temperature chart" width="100%"/>
</p>

<p align="center">
  <strong>Try the demo in your browser: <a href="https://mxkissnr.github.io/gaggiuino-local-profiler/">https://mxkissnr.github.io/gaggiuino-local-profiler/</a>, with sample data. Nothing is saved.</strong>
</p>

---

> [!IMPORTANT]
> **Heads-up — this requires a machine running [Gaggiuino](https://gaggiuino.github.io/) or [GaggiMate](https://github.com/jniebuhr/gaggimate) firmware.** GLP does not work with stock espresso machines. Both are hardware mods (custom controller, pressure/temperature sensors) — Gaggiuino and GaggiMate are both fully supported (see the multi-machine bullet below). These mods aren't limited to one machine brand: **the "type" GLP asks for when you add a machine selects the firmware adapter it talks to, not the physical machine.** Any single-boiler machine with a Gaggiuino or GaggiMate board installed — Gaggia Classic, Rancilio Silvia, Lelit, and others — works identically from GLP's side. If your machine doesn't run either firmware yet, start there first.

> [!NOTE]
> **AI-built project.** Almost all code, tests and documentation are written by AI models — mainly Claude (Anthropic), with DeepSeek in the automated agent pipeline — plus community contributions. A human maintainer sets the scope, reviews every change, tests on real hardware (Gaggia Classic + Gaggiuino) and makes all release decisions. Keep that in mind before installing this on your machine. **armv7 (32-bit ARM) is supported** alongside amd64 and aarch64, though the armv7 image is not regularly tested on real hardware.

## Why GLP?

You love your Gaggiuino or GaggiMate machine, but your shot data disappears into the void? GLP brings live extraction charts, a searchable coffee library and full analytics straight into Home Assistant — completely local, no cloud, no account. From *"what was that bean from last week again?"* to a real shot archive with automatic scoring, compare view and flavor wheel: everything runs on your HA server, and your data stays yours.

---

## Features

- **Multi-machine** - run Gaggiuino and GaggiMate machines side by side from one app instance, each with its own shots, live view and maintenance, while shared equipment such as the grinder stays global.
- **Shot archive & live view** - every shot is stored with pressure, flow, weight and temperature curves, and the Live tab streams the current brew, preheat state and machine status straight from the controller.
- **Shot score & dial-in help** - an automatic 0-100 score with a plain-language verdict, grind recommendations, and a guided dial-in wizard that tunes grind against a 25-32 s extraction target.
- **Compare mode & ghost curve** - overlay any two shots by hand, or let the shot detail auto-compare against the previous shot on the same profile with delta chips and a dashed ghost curve.
- **Coffee library** - beans, grinders, baskets, puck screens, recipes and frozen portions in one catalogue, with roaster URL import, barcode/QR scan and per-entity photos.
- **Bean shelf** - your beans stand as bag photos with a stock bar, with search, filter and sort, and empty or archived beans tidy themselves away.
- **Sticker cut-out** - cut a bean photo out as a sticker right in the app, on your own device (the models download once on first use).
- **Analytics** - score trends, a shot calendar heatmap, a month calendar with a photo of each day's bean, a coffee world map, bean/grinder/basket rankings, machine comparison and per-bean dial-in progression.
- **Machine profile editor** - build and edit Gaggiuino and GaggiMate profiles phase by phase with a live preview chart, then send them straight to the machine.
- **Maintenance tracking** - descaling, backflush, group-head and gasket tasks tracked per machine, with grinder cleaning and burr-wear tracking alongside.
- **Orders & kiosk mode** - take drink orders from a tablet kiosk page with variants and notes, and watch the barista queue update on its own.
- **Exports & sharing** - export shots as `.shot` or CSV, or turn any shot into a shareable card.
- **AI assistants via MCP** - optionally expose a built-in Model Context Protocol server so AI assistants can read your shots, beans, maintenance and analytics, with separate opt-ins for write and developer tools.
- **Six languages & themes** - the full UI ships in DE, EN, IT, FR, ES and NL, with light/dark/auto themes and eight accent colour schemes. Your view, filter and sort choices are synced across devices.

All features in detail: [wiki: Features](https://github.com/mxkissnr/gaggiuino-local-profiler/wiki/Features).

---

## Screenshots

<table>
  <tr>
    <td width="50%"><img src="gaggiuino-local-profiler/docs/screenshots/flavor-wheel.png" alt="Interactive flavor wheel for a bean" width="100%"/></td>
    <td width="50%"><img src="gaggiuino-local-profiler/docs/screenshots/analytics.png" alt="Analytics view with interactive coffee world map" width="100%"/></td>
  </tr>
  <tr>
    <td><img src="gaggiuino-local-profiler/docs/screenshots/analytics-machines.png" alt="Analytics machine comparison, bean ranking and dial-in progression" width="100%"/></td>
    <td><img src="gaggiuino-local-profiler/docs/screenshots/maintenance.png" alt="Maintenance dashboard with summary tiles, next-due banner and per-machine task tiles" width="100%"/></td>
  </tr>
  <tr>
    <td><img src="gaggiuino-local-profiler/docs/screenshots/library.png" alt="Coffee library shelf with bean bags" width="100%"/></td>
    <td></td>
  </tr>
</table>

More in [`docs/screenshots/`](gaggiuino-local-profiler/docs/screenshots/) (Dial-in, Live, Orders, Settings). Regenerated on demand via `node scripts/screenshots.mts`.

---

## The GLP Ecosystem

| Component | Version | Requires |
|---|---|---|
| **GLP App** (this repo) | ![Version](https://img.shields.io/github/v/tag/mxkissnr/gaggiuino-local-profiler?label=&color=22c55e) | Gaggiuino or GaggiMate machine + HA OS/Supervised |
| [**GLP Integration**](https://github.com/mxkissnr/glp-integration)<br/><sub>includes Shot Card + Order Card</sub> | ![Version](https://img.shields.io/github/v/release/mxkissnr/glp-integration?label=&color=22c55e) | App v1.82.7+ · [HACS](https://hacs.xyz) |

Both components are optional — the integration adds HA sensors plus the bundled Shot Card and Order Card.

> **No longer requires ALERTua/hass-gaggiuino** — as of GLP Integration v1.9.0 all machine sensors (temperature, pressure, water level, weight, profiles, switch states) are provided natively.

---

## Installation

<p>
  <a href="https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2Fmxkissnr%2Fgaggiuino-local-profiler">
    <img src="https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg" alt="Add Repository to Home Assistant" height="40"/>
  </a>
</p>

Click the button above to add this repository directly to your Home Assistant — no copy-pasting needed.

### Step 1 — Add this repository to Home Assistant

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

### Step 3 — Open the dashboard

Click **Open Web UI** in the app page — or open it directly from your HA sidebar under **GLP**.

### Step 4 — Configure the app

Set your controller's IP/hostname — and, optionally, an HA switch entity to power it on/off — under **Settings → Machines**.

> **Verify connectivity** from the HA terminal:
> ```bash
> curl http://<gaggiuino-ip>/api/shots/latest
> ```

---

## Standalone Docker Install (Unraid, TrueNAS, HA Container, …)

No HA Supervisor, no Home Assistant app store — this is for HA Container/HA Core installs (Unraid, TrueNAS SCALE and similar). GLP already ships as a plain multi-arch image, so it runs like any other Docker app:

```bash
docker run -d --name glp --restart unless-stopped \
  -p 8099:8099 -v ./data:/data \
  ghcr.io/mxkissnr/gaggiuino-local-profiler/amd64:latest
```

Or use the ready-made [`docker-compose.standalone.yml`](gaggiuino-local-profiler/docker-compose.standalone.yml) (`docker compose -f docker-compose.standalone.yml up -d`) — it also documents the optional env vars that replace Supervisor-only app config and HA integration for this install path. Then:

- **GLP Integration** ([Step 2](#step-2--install-the-glp-integration-recommended) above) — auto-discovery needs a Supervisor, so on the config step just enter `http://<docker-host>:8099` manually.
- **Dashboard panel** — no Ingress, so embed it as a normal iframe/Webpage card pointed at `http://<docker-host>:8099` (see [Embed in HA Dashboard](#embed-in-ha-dashboard) below) instead of a sidebar panel.

Full walkthrough, env-var reference and a feature-parity table against the Supervisor-managed app: see [DOCS.md](gaggiuino-local-profiler/DOCS.md#standalone-docker-installation) / [DOCS.de.md](gaggiuino-local-profiler/DOCS.de.md#standalone-docker-installation).

---

## Configuration

| Option | Default | Description |
|---|---|---|
| `sync_interval` | `5` | Auto-sync interval in minutes (1–60) |

Machine host and switch entity are configured in-app under **Settings → Machines**, not here — see [DOCS.md](gaggiuino-local-profiler/DOCS.md#configuration-options) for details.

Updates run through the Home Assistant app store — the app itself only checks and shows whether a newer version is available, it never triggers an install (no elevated Supervisor role required).

---

## Embed in HA Dashboard

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

## Architecture

GLP is a Go app with an embedded SQLite database. It talks to the machines directly (REST, WebSocket or MQTT) and serves the dashboard through Home Assistant Ingress. The GLP Integration polls the app for Home Assistant entities and bundles the Shot Card and Order Card.

Diagrams of the ecosystem and the app internals (interactive): [wiki: Architecture](https://github.com/mxkissnr/gaggiuino-local-profiler/wiki/Architecture).

---

## Development at a glance

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/dev-stats/commits-per-repo-dark.svg">
  <img src="docs/dev-stats/commits-per-repo-light.svg" alt="Commits per repo" width="100%">
</picture>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/dev-stats/model-breakdown-dark.svg">
  <img src="docs/dev-stats/model-breakdown-light.svg" alt="AI model breakdown by commits" width="100%">
</picture>

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

The in-app flavor wheel's category structure follows the SCA (Specialty Coffee Association) / WCR (World Coffee Research) *Coffee Taster's Flavor Wheel* (2016). `public-src/flavor-data.ts` is our own derived dataset (labels in all 6 UI languages — DE, EN, IT, FR, ES, NL — and a German alias table) — no artwork from the original wheel is used or reproduced.

## Disclaimer

GLP is an independent, community-built companion project. It is not officially affiliated with, endorsed by, or supported by the [Gaggiuino](https://gaggiuino.github.io/) firmware project or its maintainers, nor by Caffinnova S.r.l. or the [GaggiMate](https://github.com/jniebuhr/gaggimate) project or its maintainers.

---

<p align="center">
  <sub>Built with AI — developed with <a href="https://claude.ai">Claude</a> (Anthropic) and <a href="https://www.deepseek.com">DeepSeek</a>, maintained by a human</sub>
</p>
