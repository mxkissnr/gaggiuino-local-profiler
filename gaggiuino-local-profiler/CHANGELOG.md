## 1.18.2
- Fix: shot delete fetch URL used absolute path (/api/...) — changed to relative (api/...) so requests correctly route through HA ingress

## 1.18.1
- Fix: shot delete used HTTP DELETE which HA ingress proxy blocks — changed to POST /api/shots/:id/delete

## 1.18.0
- Shot delete: trash button in sidebar removes shot + annotation permanently (with confirmation)
- Sidebar collapsible on desktop: ‹/› toggle button gives full-width chart view
- Mobile: chart legend now always visible (compact size on small screens)
- Mobile: meta-grid stays 2-column, tighter spacing — less scrolling before chart

## 1.17.9
- Fix: CSV export now exports only the currently selected shot (not all shots)
- Fix: CSV headers use ASCII only — no more encoding issues in Excel/Numbers
- Fix: CSV filename includes date and profile (e.g. `glp_shot_2026-05-18_Adaptive.csv`)
- New: `exportAllCSV()` available for exporting all shots at once

## 1.17.4
- Vollbild-Chart (⤢ Button): Zeit- und P·Q-Chart als Fullscreen-Overlay, ideal für Querformat auf Mobile
- Fix: Corsair-Plugin Null-Check verhindert "Cannot destructure property 'x'" Fehler
- Fix: Chart.getChart() vor jeder Chart-Erstellung verhindert "canvas already in use" (war Ursache unsichtbarer Charts auf Mobile)
- Fix: Chart.js Scale-ID `temp` → `y1` behebt rechte Y-Achse (zeigte max=6 statt ~98)
- Server: Cache-Control no-cache für HTML verhindert Caching in HA-App

## 1.17.0
- Fix: Chart.js Scale-ID `temp` → `y1` – behebt mobilen Rendering-Fehler (rechte Y-Achse zeigte max=6 statt ~98 auf Android/HA-App)
- Debug-Panel verbessert: try-catch + "timeout ran"-Marker für bessere Fehlerdiagnose

## 1.16.0
- Steckdosen-Steuerung: `switch_entity` Konfigurationsoption – ⏻ Button in der Sidebar zum Ein-/Ausschalten der Maschine via HA-Switch
- Live-Tab Sperrung: Live-Ansicht automatisch deaktiviert wenn `switch_entity` konfiguriert und Maschine ausgeschaltet ist
- README: vollständig überarbeitet mit Feature-Tabelle, Konfiguration, HA-Dashboard-Karte, Architekturübersicht

## 1.15.0
- Mobile: Sidebar als Overlay-Drawer von links (HA-Sidebar-Stil) mit Backdrop
- Export: ↓ .shot Button für aktuellen Shot (Decent Espresso Format, Visualizer.coffee-kompatibel)
- DOCS.md: vollständige englische Dokumentation hinzugefügt

## 1.14.0
- Chart-Beschriftung: Druck/Fluss etc. zeigen (A)/(B) nur im Vergleichsmodus
- Sortierung: zweiter Klick auf aktiven Sort-Button kehrt Reihenfolge um (↑/↓)
- Mobile: Tippen außerhalb der Sidebar schließt diese
- Maschinentitel unter dem Shot-Namen zeigt jetzt den konfigurierten Hostnamen dynamisch
- Mobile Chart: erzwungener Resize nach Initialisierung behebt leere Canvas in HA-App
- Röstdatum: Eingabe und Anzeige jetzt im deutschen Format (TT.MM.JJJJ)
- Release-Tags v1.12.0 und v1.13.0 auf GitHub erstellt

## 1.13.0
- Shot-Score in Sidebar: jeder Shot zeigt farbige Score-Pill direkt im Listeneintrag
- Sortierung: Sidebar sortierbar nach Neueste / Score / Bewertung / Dauer
- P·Q Diagramm: zweiter Chart-Tab zeigt Druck vs. Pumpenfluss (Extraktions-Signatur)
- Röstdatum + Frische-Badge: Tage seit Röstung neben Kaffee-Name angezeigt
- Extraction Yield (EY %): automatisch berechnet wenn TDS und Dosis eingetragen
- Mahlgrad-Empfehlung: Hinweis basierend auf Bezugsdauer und Channeling-Erkennung
- Fix: Verbindungsfehler in Sidebar unterscheidet jetzt zwischen Netzwerkfehler (mit Retry-Button) und JavaScript-Fehlern

## 1.12.0
- Mobile: Hamburger-Icon (☰/✕) links in der Sidebar-Kopfzeile ersetzt den Text-Toggle-Button
- Fix: Shot-Score wird nicht mehr für Test-/Leerlauf-Shots angezeigt (Score setzt aktiven Extraktionsdruck ≥5 bar voraus)

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
