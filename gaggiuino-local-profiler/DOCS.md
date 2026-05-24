# Gaggiuino Local Profiler

Local shot profiling dashboard for [Gaggiuino](https://gaggiuino.github.io/)-based espresso machines.

**Full documentation:** [github.com/mxkissnr/gaggiuino-local-profiler/wiki](https://github.com/mxkissnr/gaggiuino-local-profiler/wiki)

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
| `port` | Port the add-on server listens on (1024–65535) | `8099` |

## Features

| Tab | Description |
|---|---|
| **Live** | Real-time pressure, flow, weight and temperature charts during a shot. Optionally overlay any previous shot as a dashed reference curve. The tab is only visible when the machine is on (requires `switch_entity`). |
| **Shots** | Shot history with full chart view, score, annotation (coffee, grinder, dose, notes) and a fullscreen chart. |
| **Analytics** | Aggregated statistics and trend charts across all shots. |
| **Library** | Coffee bean and grinder catalogue linked to shots. |
| **Einwählen** | Dial-in assistant: compare a target shot with recent attempts. |
| **Maintenance** | Five maintenance reminders (descaling, backflush, group head service, gaskets & screens, water filter) with configurable thresholds, progress bars and a "Done now" button. Cards displayed in a 2-column grid on wider screens. |

### Live tab and switch entity

When `switch_entity` is set, the **Live** tab is hidden while the machine is off and appears automatically once it powers on. If no switch entity is configured the tab is always visible.

For full documentation — features, live mode, analytics, shot score, exports, compatibility — see the [Wiki](https://github.com/mxkissnr/gaggiuino-local-profiler/wiki).
