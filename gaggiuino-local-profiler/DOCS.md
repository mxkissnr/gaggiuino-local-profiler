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

For full documentation — features, live mode, analytics, shot score, exports, compatibility — see the [Wiki](https://github.com/mxkissnr/gaggiuino-local-profiler/wiki).
