# Gaggiuino Local Profiler – Home Assistant Add-on Repository

Lokales Dashboard für die Gaggiuino-Espressomaschine als Home Assistant Add-on.

## Installation

1. **Einstellungen → Add-ons → Add-on-Store → ⋮ → Repositories**
2. URL hinzufügen:
   ```
   https://github.com/mxkissnr/gaggiuino-local-profiler
   ```
3. **Gaggiuino Local Profiler** suchen und installieren
4. `machine_url` in den Add-on-Optionen auf die IP des Controllers setzen
5. Add-on starten → Dashboard über **Öffnen** aufrufen

## Funktionen

- Shot-Archiv mit interaktivem Profil-Browser (Druck, Fluss, Gewicht, Temperatur)
- **Live-Modus** – Echtzeit-Anzeige direkt vom Controller (`/api/system/status`, kein HA-Polling-Delay)
- **Auto-Sync** – neuer Shot wird automatisch geladen wenn `gaggiuino_latest_shot_id` steigt
- Vergleichsmodus (zwei Shots nebeneinander)
- Notizen, Kaffee-Infos, Mühleneinstellungen und Sternebewertung pro Shot
- **Analyse-Metriken** – Ratio, Temperatur-Stabilität (±σ), Phasen-Erkennung, Channeling-Warnung
- **Shot-Suche** – Sidebar-Filter nach Profil, Kaffee, Mühle
- **CSV-Export** – alle Shots mit Annotationen exportieren
- Persistente Datenspeicherung in `/data`

## Konfiguration

| Option | Standard | Beschreibung |
|---|---|---|
| `machine_url` | `http://gaggia.intern/api/shots` | API-URL des Controllers |
| `sync_interval` | `5` | Sync-Intervall in Minuten (1–60) |

## Voraussetzungen

- Gaggiuino-Controller per HTTP vom HA-Host erreichbar
- Gaggiuino-Integration in HA optional (für Auto-Sync via `latest_shot_id`)

→ [Vollständige Dokumentation](gaggiuino-local-profiler/DOCS.md)
