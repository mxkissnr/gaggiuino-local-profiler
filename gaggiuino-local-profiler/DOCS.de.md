# Gaggiuino Local Profiler

Lokales Shot-Profiling-Dashboard für [Gaggiuino](https://gaggiuino.github.io/)-basierte Espressomaschinen. Das Add-on synchronisiert Shot-Daten automatisch vom Controller, visualisiert Extraktionsprofile und bietet einen Echtzeit-Live-Modus — alles direkt aus Home Assistant.

## Funktionen

- **Shot-Archiv** – alle Bezüge mit Druck-, Fluss-, Gewichts- und Temperaturkurven
- **Live-Modus** – Echtzeit-Anzeige direkt vom Controller (`/api/system/status`), kein HA-Polling-Delay
- **Auto-Sync** – neuer Shot wird automatisch geladen sobald `gaggiuino_latest_shot_id` steigt
- **Vergleichsmodus** – zwei Shots direkt nebeneinander vergleichen
- **Notizen & Bewertung** – Kaffee/Bohne, Mühle, Mahlgrad, Dosis, Röstdatum, TDS %, Freitext; Sternebewertung 1–5
- **Shot-Score** – automatisch berechneter 0–100-Score aus Druck, Temperaturstabilität, Dauer, Ratio und Channeling; Score-Pill direkt in der Sidebar sichtbar
- **Sortierung** – Sidebar sortierbar nach Neueste / Score / Bewertung / Dauer; zweiter Klick kehrt Reihenfolge um
- **Analyse-Metriken** – Dose → Yield → Ratio, EY (Extraction Yield), Temperatur-Stabilität (±σ), Phasen-Erkennung, Channeling-Warnung
- **P·Q Diagramm** – Druck-Fluss-Kurve als alternative Chart-Ansicht (Extraktions-Signatur)
- **Mahlgrad-Empfehlung** – automatischer Hinweis basierend auf Bezugsdauer und Channeling-Erkennung
- **Röstdatum & Frische** – Tage seit Röstung als farbiger Badge (grün: 7–21 Tage Optimum)
- **Shot-Suche** – Sidebar-Filter nach Profil, Kaffee, Mühle
- **Vollbild-Chart** – Chart auf Vollbild erweitern mit automatischer Querformat-Drehung auf Mobile
- **Shot löschen** – Trash-Button in der Sidebar entfernt Shot und Annotation dauerhaft (mit Bestätigung)
- **.shot-Export** – Export im Decent Espresso Format (Visualizer.coffee-kompatibel)
- **CSV-Export** – aktuell ausgewählter Shot als CSV mit korrektem UTF-8-Encoding
- **Steckdosen-Steuerung** – optional: Maschine per HA-Switch-Entität ein-/ausschalten
- **Datenpersistenz** – Shots und Notizen bleiben bei Updates und Neustarts erhalten

## Voraussetzungen

- Gaggiuino-Controller per HTTP vom Home Assistant Host erreichbar
- Gaggiuino HA-Integration installiert (optional, für Auto-Sync via `latest_shot_id`)

Verbindung im HA-Terminal testen:
```bash
curl http://<gaggiuino-ip>/api/shots/latest
```

## Konfiguration

| Option | Beschreibung | Standard |
|---|---|---|
| `machine_url` | API-URL des Gaggiuino-Controllers | `http://gaggia.intern/api/shots` |
| `sync_interval` | Automatischer Sync-Intervall in Minuten (1–60) | `5` |
| `switch_entity` | HA-Switch-Entität zum Ein-/Ausschalten der Maschine (z.B. `switch.espresso_steckdose`) | *(leer)* |

### Beispiel

```yaml
machine_url: "http://192.168.1.42/api/shots"
sync_interval: 5
switch_entity: "switch.espresso_steckdose"
```

## Steckdosen-Steuerung (optional)

Wenn `switch_entity` konfiguriert ist, erscheint in der Sidebar-Fußzeile ein **⏻ Schalter-Button**:

- **Grün** → Maschine ist eingeschaltet
- **Grau** → Maschine ist ausgeschaltet
- Klicken togglet den Switch über die HA-API

Der **Live-Tab** ist automatisch deaktiviert wenn die Maschine ausgeschaltet ist – so entstehen keine sinnlosen Verbindungsversuche.

## Verwendung

### Shot-Archiv

1. Add-on starten und Dashboard über **Öffnen** aufrufen
2. Shots erscheinen nach dem ersten Sync in der Seitenleiste
3. Shot anklicken → Profil-Ansicht mit allen Messwerten
4. **⇄**-Button → Vergleichsmodus (Shot B aus Sidebar wählen)
5. Notizen-Panel unterhalb des Charts → Daten eingeben und **Speichern**
6. **⤢**-Button → Vollbild-Chart (dreht automatisch auf Querformat auf Mobile)
7. **‹**-Button → Sidebar einklappen für mehr Chart-Platz (Desktop)

### Live-Modus

1. Tab **Live** oben im Dashboard anklicken
2. Sobald der Brew-Switch aktiv ist, startet die Echtzeit-Anzeige automatisch
3. Stat-Boxen und Chart aktualisieren sich sekündlich direkt vom Controller
4. Nach Ende des Bezugs wird der vollständige Shot automatisch synchronisiert

Der Live-Modus fragt den Gaggiuino-Controller direkt über `/api/system/status` ab (1-Sekunden-Intervall) — **nicht** über die HA-Sensoren. Dadurch ist die Erkennung des Brew-Starts sofort, ohne Verzögerung durch das HA-Polling-Intervall.

**Datenquellen Live-Modus:**

| Feld | Quelle | Endpunkt |
|---|---|---|
| Brew-Switch (Start/Stop) | Gaggiuino direkt | `/api/system/status` → `brewSwitchState` |
| Druck | Gaggiuino direkt | `/api/system/status` → `pressure` |
| Temperatur | Gaggiuino direkt | `/api/system/status` → `temperature` |
| Gewicht / Fluss | Gaggiuino direkt | `/api/system/status` → `weight` |
| Ziel-Temperatur | Gaggiuino direkt | `/api/system/status` → `targetTemperature` |
| Auto-Sync (neuer Shot) | HA-Sensor (optional) | `sensor.gaggiuino_latest_shot_id` |

## P·Q Diagramm

Der Tab **P·Q Kurve** zeigt Druck (Y-Achse) gegen Pumpenfluss (X-Achse) statt der Zeitachse. Diese Darstellung offenbart das Extraktionsverhalten des Pucks:

- **Enge, ruhige Kurve** → homogene Extraktion, gleichmäßiger Puck
- **Breite, zittrige Kurve** → Channeling oder ungleichmäßige Füllung
- **Kurve weit rechts** → viel Fluss bei wenig Druck (zu grob gemahlen)
- **Kurve weit links** → wenig Fluss trotz hohem Druck (zu fein gemahlen)

## Extraction Yield (EY)

EY = (Bezugsgewicht × TDS %) / Dosis

Unter *Notizen & Bewertung* **Dosis** und **TDS %** (gemessen mit Refraktometer) eintragen — das Dashboard berechnet den EY automatisch. Zielbereich nach SCA: **18–22 %**.

| Farbe | Bereich | Bedeutung |
|---|---|---|
| 🟢 Grün | 18–22 % | Optimale Extraktion |
| 🟡 Gelb | 16–17 % oder 23–24 % | Leichte Unter-/Überextraktion |
| 🔴 Rot | < 16 % oder > 24 % | Deutliche Unter-/Überextraktion |

## Mahlgrad-Empfehlung

Die automatische Empfehlung basiert auf Bezugsdauer und Channeling-Erkennung:

| Bezugsdauer | Empfehlung |
|---|---|
| < 18 s | Feiner mahlen |
| 18–22 s | Leicht feiner mahlen |
| 23–42 s | Mahlgrad passt |
| 43–50 s | Leicht gröber mahlen |
| > 50 s | Gröber mahlen |
| Channeling erkannt | Puck-Vorbereitung (Verteilung & Tamping) prüfen |

## Shot-Score

Jeder Shot erhält automatisch einen Score von 0–100, der oben rechts in der Profil-Ansicht und als farbige Pill in der Sidebar angezeigt wird.

| Farbe | Bereich | Bedeutung |
|---|---|---|
| 🟢 Grün | 88–100 | Sehr guter Bezug |
| 🟡 Gelbgrün | 75–87 | Guter Bezug |
| 🟡 Amber | 60–74 | Solider Bezug |
| 🟠 Orange | 45–59 | Verbesserungswürdig |
| 🔴 Rot | 0–44 | Problematischer Bezug |

### Berechnungsfaktoren

| Faktor | Gewichtung | Optimum | Punkte |
|---|---|---|---|
| **Extraktionsdruck** | 25 % | 7–9,5 bar (Ø aktiver Anteil ≥ 5 bar) | 100 bei Optimum, lineare Abwertung außerhalb |
| **Temperaturstabilität (σ)** | 20 % | σ ≤ 0,3 °C | 100 / 90 / 72 / 50 / <50 je nach σ |
| **Bezugsdauer** | 20 % | 25–35 s | 100 bei Optimum, 82 bei 20–25 s oder 35–42 s |
| **Dose → Yield-Ratio** | 20 % | 1:1,8 – 1:2,5 | Nur wenn Dosis in den Notizen eingetragen |
| **Channeling** | 15 % | kein Channeling | 100 (keins) oder 20 (erkannt) |

> **Hinweis zur Ratio:** Der Faktor wird nur berücksichtigt wenn unter Notizen eine Dosis eingetragen ist. Ohne Dosis werden die restlichen Gewichtungen anteilig hochgerechnet.

> **Hinweis zum Druck:** Der Durchschnitt wird nur über Messwerte ≥ 5 bar berechnet, um die Preinfusionsphase nicht zu bestrafen.

## Shots löschen

Der Trash-Button (🗑) in der Sidebar entfernt einen Shot und seine Annotation aus dem lokalen Speicher. Der Sync ist jedoch **inkrementell und einseitig**: er merkt sich die höchste lokale Shot-ID und holt nur Shots mit höherer ID von der Maschine.

| Was gelöscht wird | Ergebnis |
|---|---|
| Ein älterer Shot (nicht der neueste) | Sicher — bleibt gelöscht. Der Sync holt nur IDs die höher als das aktuelle Maximum sind. |
| Der neueste Shot (höchste ID) | Kommt beim nächsten Sync zurück — die Maschine hat ihn noch und die lokale Max-ID sinkt unter die letzte Maschinen-ID. |

**Praktische Nutzung:** Löschen eignet sich gut für Test-Bezüge, abgebrochene Shots oder das Bereinigen älterer Daten. Der allerneueste Shot (höchste ID) wird immer von der Maschine neu synchronisiert.

> Eine zukünftige Version wird eine Blockliste einführen, damit gelöschte Shots dauerhaft vom Sync ausgeschlossen werden können.

## .shot-Export

Exportiert den aktuell ausgewählten Shot im Decent Espresso `.shot`-Format. Kompatibel mit [Visualizer.coffee](https://visualizer.coffee/) und anderen Tools die das Decent-Format unterstützen.

## API-Endpunkte (intern)

| Endpunkt | Methode | Beschreibung |
|---|---|---|
| `/shots.json` | GET | Alle Shots mit Annotationen |
| `/api/status` | GET | Sync-Status, Shot-Anzahl, HA-Verbindung |
| `/api/sync` | POST | Manuellen Sync auslösen (max. 1×/30 s) |
| `/api/shots/:id/annotate` | POST | Annotation für Shot speichern |
| `/api/shots/:id` | DELETE | Shot und Annotation löschen |
| `/api/live` | GET (SSE) | Echtzeit-Datenstrom |

## Datenspeicherung

| Datei | Inhalt |
|---|---|
| `/data/shots.json` | Maschinendaten aller Bezüge |
| `/data/annotations.json` | Notizen und Bewertungen (getrennt, sync-sicher) |

## Sicherheit

Das Add-on läuft hinter dem Home Assistant Ingress-Proxy, der die Authentifizierung übernimmt. Alle API-Endpunkte sind nur über das HA-Dashboard erreichbar. Der Zugriff auf die HA-API erfolgt ausschließlich lesend über den Supervisor-Token.
