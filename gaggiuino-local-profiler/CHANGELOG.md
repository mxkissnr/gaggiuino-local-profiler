## 1.23.1
- Fix: analytics layout no longer overflows horizontally — added `min-width: 0` to `#main`, `#analytics-view`, and `.analytics-card`; grid columns use `minmax(0, 1fr)` instead of `1fr`

## 1.23.0
- Feature: Multi-language UI — DE / EN / IT / FR / ES selectable via language switcher in sidebar footer
- Language auto-detected from browser (`navigator.language`), persisted in `localStorage`
- All UI strings translated; dynamic strings (grind advice, confirm dialogs, freshness badge) use `t()` helper
- Date formatting follows selected locale (`Intl` / `toLocaleString`)
- Fix: Analytics container no longer has a fixed max-width — uses full screen width on desktop and scales correctly on mobile

## 1.22.0
- Feature: Coffee Library is now a dedicated top-level tab ("Bibliothek") in the mode-bar — no longer a modal overlay
- The "☕ Bibliothek" button in the annotation panel switches to the new tab

## 1.21.1
- Fix: roastDate and tds now correctly persisted in annotation endpoint (were silently dropped, causing data loss after page reload)
- Fix: removed undefined broadcastLive() call in syncAfterBrew() — silent ReferenceError swallowed by catch block
- Fix: removed dead liveClients Set (leftover from SSE removal in v1.19.3)
- Hardening: server-side field length limits added to all library endpoints (name 200, roastDate 10, notes 1000)

## 1.21.0
- Feature: Analytics tab — new dedicated view with 4 sections
- Analytics: Score-Trend chart with 5-shot moving average (filter: last 30 / 90 / all shots)
- Analytics: Shot calendar — GitHub-style heatmap showing shot activity over the last 52 weeks
- Analytics: Bohnen-Auswertung — stats per bean (shot count, avg score, best score, avg duration)
- Analytics: Profil-Performance — horizontal bar chart with avg score per profile

## 1.20.1
- Fix: expand button (›) and mode tabs stay visible when scrolling with sidebar collapsed — mode-bar uses `position: sticky`

## 1.20.0
- Feature: Coffee Library — save beans (name, roaster, roast date, notes) and grinders in a persistent library (`/data/coffee_library.json`)
- Annotation panel: coffee and grinder fields now have browser autocomplete from library entries
- Annotation panel: roast date auto-fills when a library bean is selected and the field is empty
- Annotation panel: "☕ Bibliothek" button opens library management modal (add, edit, delete)
- Sidebar footer: current GLP version shown as subtle badge next to sync button

## 1.19.4
- Fix: server crash on start — removed leftover `broadcastLive()` call after SSE removal

## 1.19.3
- Fix: live mode replaced SSE/EventSource with fetch-polling — HA's ServiceWorker was blocking EventSource connections through ingress (#7)
- Server polls machine every second continuously (not only when client is connected)
- Frontend polls `api/live/data` every second; auto-reloads shot list when brew ends

## 1.19.2
- Fix: live mode brew detection now accepts `brewSwitchState`, `brewActive`, or `isBrewing` fields — handles multiple Gaggiuino firmware versions (#7)
- Debug: `GET api/debug/machine` shows raw `/api/system/status` response from controller
- Polish: sidebar collapse transition uses `cubic-bezier` + `will-change` for smooth GPU animation
- Polish: sidebar children get `min-width: 320px` so content doesn't reflow during transition

## 1.19.1
- Mobile: meta-items now horizontal (label left, value right) — halves the height of each row
- Mobile: phases (Preinfusion / Extraktion) moved from meta-grid into header subtitle area, saving a full row (#5)

## 1.19.0
- Machine firmware version shown next to hostname in shot header (fetched from controller `/api/system/info` on startup, silently ignored if endpoint not available)

## 1.18.9
- Fix: permanently deleted shots added to blocklist — sync never re-fetches them from machine (#1)
- Fix: machine subtitle shows hostname from server (`machineHostname` in `/api/status`), no client-side URL parsing (#9)

## 1.18.8
- Polish: sidebar slides in/out smoothly (0.3s ease transition on width)
- Expand button › fades in/out instead of hard show/hide

## 1.18.7
- Fix: sidebar collapse button ‹ now inline with "Shots" heading (missing `display:flex` on h2)

## 1.18.6
- Polish: sidebar collapse button ‹ styled as proper pill button (dark bg, border, rounded) with hover state

## 1.18.5
- Fix: sidebar collapse button ‹ now visible — color changed from near-black to visible gray, slightly larger

## 1.18.4
- Fix: sidebar collapse (‹/›) now works in HA companion app — removed viewport width guard that prevented collapse when `window.innerWidth ≤ 768`
- Fix: ‹ button flips to › when sidebar is collapsed and back on expand

## 1.18.3
- Trash bin: 🗑 button moves shot to trash instead of permanent delete
- Trashed shots hidden from main sidebar, shown in collapsible Papierkorb section
- Each trashed shot shows days remaining until auto-deletion (30 days)
- Restore (↩) and permanent delete (✕) per trashed shot
- Server: auto-purges expired trash on startup and daily
- Fixes issue #6

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
