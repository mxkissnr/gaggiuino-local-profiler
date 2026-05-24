# Gaggiuino Local Profiler

Lokales Shot-Profiling-Dashboard für [Gaggiuino](https://gaggiuino.github.io/)-basierte Espressomaschinen.

**Vollständige Dokumentation:** [github.com/mxkissnr/gaggiuino-local-profiler/wiki](https://github.com/mxkissnr/gaggiuino-local-profiler/wiki)

## Schnellstart

`machine_url` auf die API-URL des Controllers setzen und Add-on starten.

```yaml
machine_url: "http://192.168.1.42/api/shots"
sync_interval: 5
switch_entity: "switch.espresso_steckdose"   # optional
```

Verbindung im HA-Terminal testen:
```bash
curl http://<gaggiuino-ip>/api/shots/latest
```

## Konfigurationsoptionen

| Option | Beschreibung | Standard |
|---|---|---|
| `machine_url` | API-URL des Gaggiuino-Controllers | `http://gaggia.intern/api/shots` |
| `sync_interval` | Automatischer Sync-Intervall in Minuten (1–60) | `5` |
| `switch_entity` | HA-Switch-Entität zum Ein-/Ausschalten der Maschine | *(leer)* |
| `preheat_time` | Aufwärmzeit in Minuten — wie lange nach dem Einschalten bis die Maschine brühbereit ist (1–120) | `20` |
| `port` | Port, auf dem der Server lauscht (1024–65535) | `8099` |

## Features

| Tab | Beschreibung |
|---|---|
| **Live** | Echtzeit-Charts für Druck, Flow, Gewicht und Temperatur während eines Shots. Beim Start eines Bezugs wird automatisch der letzte Shot mit demselben Profil als gestrichelte Referenzkurve eingeblendet. Kann über das Dropdown überschrieben oder entfernt werden. Der Tab ist nur sichtbar wenn die Maschine eingeschaltet ist (erfordert `switch_entity`). |
| **Shots** | Shot-Verlauf mit vollständigem Chart, Score, Annotation (Kaffee, Mühle, Dosis, Notizen) und Vollbild-Chart. |
| **Analytics** | Aggregierte Statistiken und Trendcharts über alle Shots. |
| **Bibliothek** | Kaffeebohnen- und Mühlenkatalog mit Verknüpfung zu Shots. |
| **Einwählen** | Einwähl-Assistent: Ziel-Shot mit aktuellen Versuchen vergleichen. |
| **Wartung** | Fünf Wartungserinnerungen (Entkalken, Backflush, Gruppenköpf-Service, Dichtungen & Siebe, Wasserfilter) mit konfigurierbaren Schwellenwerten, Fortschrittsbalken und „Jetzt erledigt"-Button. Karten werden auf breiteren Bildschirmen im 2-Spalten-Grid angezeigt. |

### Live-Tab, Switch-Entity und Aufwärmtimer

Wenn `switch_entity` gesetzt ist, wird der **Live**-Tab ausgeblendet solange die Maschine aus ist und erscheint automatisch sobald sie eingeschaltet wird. Ohne Switch-Entity ist der Tab immer sichtbar.

Nach dem Einschalten zeigt der Live-Tab einen Fortschrittsbalken und einen Countdown bis `preheat_time` Minuten abgelaufen sind. Der Timer wird **nicht** zurückgesetzt, wenn die Maschine kurz aus- und wieder eingeschaltet wird, solange die Temperatur noch über 80 °C liegt (Auszeit < 5 Minuten) — kurze Stromunterbrechungen werden ignoriert. Der Aufwärmstatus wird auch als HA-Sensoren über die Companion-Integration bereitgestellt (`binary_sensor.…preheat_ready`, `sensor.…preheat_elapsed`, `sensor.…preheat_remaining`).

Vollständige Dokumentation — Features, Live-Modus, Analytics, Shot-Score, Exporte, Kompatibilität — im [Wiki](https://github.com/mxkissnr/gaggiuino-local-profiler/wiki).
