# Gaggiuino Local Profiler

Lokales Dashboard für die [Gaggiuino](https://gaggiuino.github.io/)-Espressomaschine. Das Add-on synchronisiert Shot-Daten automatisch vom Controller, zeigt sie in einem interaktiven Profil-Browser und stellt einen Echtzeit-Live-Modus bereit.

## Funktionen

- **Shot-Archiv** – alle Bezüge mit Druck-, Fluss-, Gewichts- und Temperaturkurven
- **Live-Modus** – Echtzeit-Anzeige während eines laufenden Bezugs via HA-Sensoren
- **Auto-Sync** – neuer Shot wird automatisch geladen sobald `gaggiuino_latest_shot_id` steigt
- **Vergleichsmodus** – zwei Shots direkt nebeneinander vergleichen
- **Notizen & Bewertung** – Kaffee/Bohne, Mühle, Mahlgrad, Dosis, Freitext; Sternebewertung 1–5
- **Manueller Sync** – Sync-Button im Dashboard (max. 1×/30s)
- **Datenpersistenz** – Shots und Notizen bleiben bei Updates und Neustarts erhalten

## Voraussetzungen

- Gaggiuino-Controller per HTTP vom Home Assistant Host erreichbar
- Gaggiuino-Integration in Home Assistant installiert (optional, für Auto-Sync via `latest_shot_id`)

Test im HA-Terminal: `curl http://<ip>/api/shots/latest`

## Konfiguration

| Option | Beschreibung | Standard |
|---|---|---|
| `machine_url` | API-URL des Gaggiuino-Controllers | `http://gaggia.intern/api/shots` |
| `sync_interval` | Automatischer Sync-Intervall in Minuten (1–60) | `5` |

### Beispiel

```yaml
machine_url: "http://192.168.1.42/api/shots"
sync_interval: 10
```

## Verwendung

### Shot-Archiv

1. Add-on starten und Dashboard über **Öffnen** aufrufen
2. Shots erscheinen nach dem ersten Sync in der Seitenleiste
3. Shot anklicken → Profil-Ansicht mit allen Messwerten
4. **⇄**-Button → Vergleichsmodus (Shot B wählen)
5. Notizen-Panel unterhalb des Charts → Daten eingeben und **Speichern**

### Live-Modus

1. Tab **Live** oben im Dashboard anklicken
2. Sobald der Brew-Switch aktiv ist, startet die Echtzeit-Anzeige automatisch
3. Stat-Boxen und Chart aktualisieren sich sekündlich direkt vom Controller
4. Nach Ende des Bezugs wird der vollständige Shot automatisch synchronisiert

Der Live-Modus fragt den Gaggiuino-Controller direkt über `/api/system/status` ab (1-Sekunden-Intervall) – **nicht** über die HA-Sensoren. Dadurch ist die Erkennung des Brew-Starts sofort, ohne Verzögerung durch das HA-Polling-Intervall.

Die HA-Integration wird im Hintergrund alle 30 Sekunden geprüft, um bei steigender `sensor.gaggiuino_latest_shot_id` einen Auto-Sync auszulösen.

**Datenquelle Live-Modus:**

| Feld | Quelle | Endpunkt |
|---|---|---|
| Brew-Switch (Start/Stop) | Gaggiuino direkt | `/api/system/status` → `brewSwitchState` |
| Druck | Gaggiuino direkt | `/api/system/status` → `pressure` |
| Temperatur | Gaggiuino direkt | `/api/system/status` → `temperature` |
| Gewicht / Fluss | Gaggiuino direkt | `/api/system/status` → `weight` |
| Ziel-Temperatur | Gaggiuino direkt | `/api/system/status` → `targetTemperature` |
| Auto-Sync (neuer Shot) | HA-Sensor (optional) | `sensor.gaggiuino_latest_shot_id` |

## API-Endpunkte (intern)

| Endpunkt | Methode | Beschreibung |
|---|---|---|
| `/shots.json` | GET | Alle Shots mit Annotationen |
| `/api/status` | GET | Sync-Status, Shot-Anzahl, HA-Verbindung |
| `/api/sync` | POST | Manuellen Sync auslösen (max. 1×/30s) |
| `/api/shots/:id/annotate` | POST | Annotation für Shot speichern |
| `/api/live` | GET (SSE) | Echtzeit-Datenstrom |

## Datenspeicherung

| Datei | Inhalt |
|---|---|
| `/data/shots.json` | Maschinendaten aller Bezüge |
| `/data/annotations.json` | Notizen und Bewertungen (getrennt, sync-sicher) |

## Sicherheit

Das Add-on läuft hinter dem Home Assistant Ingress-Proxy, der die Authentifizierung übernimmt. Alle API-Endpunkte sind nur über das HA-Dashboard erreichbar. Der Zugriff auf die HA-API erfolgt ausschließlich lesend über den Supervisor-Token.
