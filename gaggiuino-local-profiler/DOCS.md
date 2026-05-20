# Gaggiuino Local Profiler

Lokales Dashboard für die [Gaggiuino](https://gaggiuino.github.io/)-Espressomaschine. Das Add-on synchronisiert Shot-Daten automatisch vom Controller und stellt sie in einem interaktiven Browser dar.

## Funktionen

- **Shot-Archiv** – alle Bezüge mit Druck-, Fluss-, Gewichts- und Temperaturkurven
- **Live-Modus** – Echtzeit-Anzeige während eines laufenden Bezugs (1-Sekunden-Polling)
- **Vergleichsmodus** – zwei Shots direkt nebeneinander vergleichen
- **Notizen & Bewertung** – Kaffee/Bohne, Mühle, Mahlgrad, Dosis und Freitext pro Shot; Sternebewertung 1–5
- **Manueller Sync** – Sync-Button im Dashboard
- **Datenpersistenz** – Shots und Notizen bleiben bei Updates und Neustarts erhalten

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

## Voraussetzungen

Der Gaggiuino-Controller muss vom Home Assistant Host aus per HTTP erreichbar sein.  
Test im HA-Terminal: `curl http://<ip>/api/shots/latest`

## Verwendung

### Shot-Archiv

1. Add-on starten und Dashboard über **Öffnen** aufrufen
2. Shots erscheinen nach dem ersten Sync in der Seitenleiste
3. Shot anklicken → Profil-Ansicht mit allen Messwerten
4. **⇄**-Button → Vergleichsmodus (Shot B wählen)
5. Notizen-Panel unterhalb des Charts → Daten eingeben und **Speichern**

### Live-Modus

1. Tab **Live** oben im Dashboard anklicken
2. Sobald ein Bezug startet, aktualisieren sich Stat-Boxen und Chart jede Sekunde automatisch
3. Der Tab-Button pulsiert rot während der Bezug läuft, wird grün wenn die Maschine bereit ist

## API-Endpunkte (intern)

| Endpunkt | Methode | Beschreibung |
|---|---|---|
| `/shots.json` | GET | Alle Shots mit Annotationen |
| `/api/status` | GET | Sync-Status und Shot-Anzahl |
| `/api/sync` | POST | Manuellen Sync auslösen (max. 1×/30s) |
| `/api/shots/:id/annotate` | POST | Annotation für Shot speichern |
| `/api/live` | GET (SSE) | Echtzeit-Datenstrom vom Controller |

## Datenspeicherung

| Datei | Inhalt |
|---|---|
| `/data/shots.json` | Maschinendaten aller Bezüge |
| `/data/annotations.json` | Notizen und Bewertungen (getrennt, sync-sicher) |

## Sicherheit

Das Add-on läuft hinter dem Home Assistant Ingress-Proxy, der die Authentifizierung übernimmt. Alle API-Endpunkte sind nur über das HA-Dashboard erreichbar.
