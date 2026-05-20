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
- Gaggiuino-Integration in Home Assistant installiert und konfiguriert (für Live-Modus und Auto-Sync)

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
2. Sobald `binary_sensor.gaggiuino_brew_switch` auf `on` geht, startet die Echtzeit-Anzeige automatisch
3. Stat-Boxen und Chart aktualisieren sich sekündlich mit Daten aus den HA-Sensoren
4. Nach Ende des Bezugs wird der vollständige Shot automatisch synchronisiert

**Verwendete HA-Sensoren:**

| Sensor | Verwendung |
|---|---|
| `binary_sensor.gaggiuino_brew_switch` | Bezug-Erkennung (start / stop) |
| `sensor.gaggiuino_pressure` | Live-Druck |
| `sensor.gaggiuino_temperature` | Live-Temperatur |
| `sensor.gaggiuino_weight` | Live-Gewicht (Gewichtsfluss wird abgeleitet) |
| `sensor.gaggiuino_target_temperature` | Ziel-Temperatur |
| `sensor.gaggiuino_profile_name` | Aktives Profil |
| `sensor.gaggiuino_latest_shot_id` | Auto-Sync bei neuer Shot-ID |

> **Hinweis:** Wenn kein `SUPERVISOR_TOKEN` verfügbar ist (z.B. lokale Entwicklung), fällt der Live-Modus automatisch auf direktes Gaggiuino-API-Polling zurück.

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
