## 1.11.1
- DOCS.md: Shot-Score-Berechnung vollständig dokumentiert (Faktoren, Gewichtungen, Farbskala)

## 1.11.0
- Shot-Score (0–100): automatisch berechnet aus Extraktionsdruck, Temp-Stabilität, Dauer, Ratio und Channeling
- Phasen-Visualisierung: deutlichere Hintergrundzonen + farbige Pill-Labels im Chart
- Responsive / Mobile: einklappbare Sidebar, kompaktes Layout, Auto-Collapse beim Shot-Auswahl
- Sidebar-Toggle-Button (mobile)

## 1.10.2
- Neues Add-on Icon: Druckprofil-Kurve über Espresso-Cup (icon.png, 512×512)

## 1.10.1
- Phasen-Visualisierung im Chart: Preinfusion (blau) und Extraktion (orange) als Hintergrundzonen mit Trennlinie und Labels

## 1.10.0
- Suche/Filter in der Shot-Seitenleiste (nach Profil, Kaffee, Mühle)
- Dose → Yield → Ratio-Berechnung (z.B. 18g → 36g · 1:2.0)
- Temperatur-Stabilität (±σ) als Metrik in der Shot-Ansicht
- Phasen-Erkennung: Preinfusion und Extraktion mit Zeitangaben
- Channeling-Warnung bei plötzlichem Druckabfall (>1.5 bar)
- CSV-Export aller Shots mit Annotationen
- Live-Modus: Shot-ID nach Bezugsende eingeblendet + automatische Shot-Liste aktualisiert
- server.js: Poll-Stacking-Guard verhindert gestapelte Requests
- server.js: Validierung eingehender Shot-Daten vom Controller

## 1.9.0
- Live-Modus: Controller direkt via `/api/system/status` abfragen statt HA-Sensoren – sofortige Brew-Erkennung ohne 30s Delay
- HA-Integration im Hintergrund (30s) für Auto-Sync via `latest_shot_id`

## 1.8.0
- HA-Sensor-Integration für Live-Modus: `brew_switch`, Druck, Temp, Gewicht, Shot-ID
- Auto-Sync bei steigender `gaggiuino_latest_shot_id`

## 1.7.1
- Fix: EACCES-Fehler beim Lesen von `/data/options.json` behoben (non-root User entfernt)

## 1.7.0
- Sicherheits-Audit: XSS-Schutz, Body-Limit, URL-Validierung, Shot-ID-Bounds
- HA best practices: `homeassistant_api: true`, Ingress-Konfiguration
- Vollständige Dokumentation (DOCS.md) und README aktualisiert

## 1.6.0
- Live-Modus: Echtzeit-Anzeige während eines laufenden Bezugs (SSE)
- Notizen-Panel unter den Chart verschoben
- Live-Polling via SSE-Endpoint `/api/live`

## 1.5.0
- Kaffee-Notizen: Bohne, Mühle, Mahlgrad, Dosis, Freitext
- Sternebewertung (1–5) pro Shot
- App-Icon und Favicon

## 1.4.0
- `machine_url` und `sync_interval` konfigurierbar über HA Add-on Optionen
- UI-Verbesserungen: Ladezustände, Leer-Zustand, Sidebar-Verbesserungen
- Dokumentation (DOCS.md, README.md)

## 1.3.9
- Fix: Ingress-Kompatibilität für relativen API-Pfad
- Persistenz: Daten unter `/data` gespeichert

## 1.3.6
- Fix: API-Endpunkt für Ingress-Kompatibilität angepasst

## 1.2.0
- SD-Karten Sync via Gaggiuino HTTP API

## 1.0.0
- Erste Version: Lokales Dashboard für die Gaggiuino-Espressomaschine
