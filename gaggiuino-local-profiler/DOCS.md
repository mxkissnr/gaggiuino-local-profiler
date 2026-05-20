# Gaggiuino Local Profiler

Lokales Dashboard für die [Gaggiuino](https://gaggiuino.github.io/)-Espressomaschine. Das Add-on synchronisiert Shot-Daten automatisch von der Maschine und zeigt sie in einem interaktiven Profil-Browser an.

## Funktionen

- Automatische Synchronisation der Shot-Daten vom Gaggiuino-Controller
- Interaktive Profil-Ansicht: Druck, Fluss, Gewicht, Temperatur im Zeitverlauf
- Vergleichsmodus: zwei Shots direkt nebeneinander vergleichen
- Manueller Sync-Button im Dashboard
- Konfigurierbare Sync-URL und Intervall über die HA-Oberfläche
- Datenpersistenz im Home Assistant `/data`-Verzeichnis

## Konfiguration

| Option | Beschreibung | Standard |
|---|---|---|
| `machine_url` | API-URL des Gaggiuino-Controllers | `http://gaggia.intern/api/shots` |
| `sync_interval` | Sync-Intervall in Minuten | `5` |

### Beispiel

```yaml
machine_url: "http://192.168.1.42/api/shots"
sync_interval: 10
```

## Voraussetzungen

Der Gaggiuino-Controller muss vom Home Assistant Host aus per HTTP erreichbar sein. Teste dies ggf. vorab mit `curl http://<ip>/api/shots/latest` aus einem HA-Terminal.

## Verwendung

1. Add-on starten
2. Dashboard über **Öffnen** oder Ingress aufrufen
3. Shots erscheinen automatisch in der Seitenleiste nach dem ersten Sync
4. Auf einen Shot klicken zum Anzeigen, **⇄**-Button für den Vergleichsmodus

## Datenspeicherung

Die Shot-Daten werden unter `/data/shots.json` persistent gespeichert und bleiben bei Updates und Neustarts erhalten.
