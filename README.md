# Gaggiuino Local Profiler – Home Assistant Add-on Repository

Dieses Repository enthält das **Gaggiuino Local Profiler** Add-on für Home Assistant.

## Installation

1. **Einstellungen → Add-ons → Add-on-Store → ⋮ → Repositories**
2. URL hinzufügen:
   ```
   https://github.com/mxkissnr/gaggiuino-local-profiler
   ```
3. **Gaggiuino Local Profiler** suchen und installieren
4. In den Add-on-Optionen `machine_url` auf die IP deines Gaggiuino-Controllers setzen
5. Add-on starten → Dashboard über **Öffnen** aufrufen

## Funktionen

- Shot-Archiv mit interaktivem Profil-Browser (Druck, Fluss, Gewicht, Temperatur)
- **Live-Modus** – Echtzeit-Anzeige während eines laufenden Bezugs
- Vergleichsmodus (zwei Shots nebeneinander)
- Notizen, Kaffee-Infos, Mühleneinstellungen und Sternebewertung pro Shot
- Automatischer und manueller Sync vom Controller
- Persistente Datenspeicherung in `/data`

## Konfiguration

| Option | Standard | Beschreibung |
|---|---|---|
| `machine_url` | `http://gaggia.intern/api/shots` | API-URL des Controllers |
| `sync_interval` | `5` | Sync-Intervall in Minuten (1–60) |

→ [Vollständige Dokumentation](gaggiuino-local-profiler/DOCS.md)
