# Gaggiuino Local Profiler

Lokales Shot-Profiling-Dashboard für [Gaggiuino](https://gaggiuino.github.io/)-basierte Espressomaschinen.

**Vollständige Dokumentation:** [github.com/mxkissnr/gaggiuino-local-profiler/wiki](https://github.com/mxkissnr/gaggiuino-local-profiler/wiki)

## Architektur — wie die Komponenten zusammenspielen

Das GLP-Ökosystem (GLP = Gaggiuino Local Profiler) besteht aus vier unabhängigen Teilen, die aufeinander aufbauen:

```
  Gaggiuino-Maschine
  └─ /api/shots          (Shot-Verlauf)
  └─ /api/system/status  (Live-Brühdaten)
  └─ /api/system/info    (Firmware-Version)
         │
         │  Sync alle N Min. + Live-Polling während des Bezugs
         ▼
  ┌──────────────────────────────────┐
  │       GLP App                 │  ← dieses App
  │  Node.js-Server, Port 8099       │
  │  speichert Shots in /data/       │
  │  REST-API + Web-Oberfläche       │
  └────────┬─────────────────────────┘
           │                    ▲
           │  fragt ab          │  HA Ingress (Browser, authentifiziert)
           │  /api/status       │  Port 8099 direkt (Integration, Karten)
           │  /api/shots        │
           │  /api/preheat      ├──────────────────────────┐
           │  /api/maintenance  │                          │
           │  /api/orders †     │                          │
           ▼                    │                          │
  ┌─────────────────────┐  ┌────┴─────────────────┐  ┌────┴─────────────────┐
  │  GLP HA-Integration │  │  GLP Shot Card       │  │  GLP Order Card      │
  │  (Custom Component) │─►│  Maschinenstatus,    │  │  Kundenbestellung,   │
  │  erstellt Sensoren, │  │  letzter Shot,       │  │  Bestellstatus,      │
  │  feuert HA-Events   │─►│  Aufwärm-Fortschritt │  │  Shot-Zusammenfassung│
  └─────────────────────┘  └──────────────────────┘  └──────────────────────┘
           │          Sensor-Attribute → beide Karten erkennen switch_entity
           ▼
    HA-Sensoren, Automationen, Energie-Monitoring, …

† erfordert enable_orders: true in der App-Konfiguration
```

### GLP App (dieses Repo)

Das zentrale Stück. Es synchronisiert den Shot-Verlauf von der Gaggiuino-Maschine, speichert ihn in einer lokalen SQLite-Datenbank (`/data/glp.db`) und stellt Folgendes bereit:
- Eine Web-Oberfläche, die über HA Ingress erreichbar ist (das ☕-Panel in der HA-Seitenleiste)
- Eine REST-API auf Port 8099, die von der Integration und den Lovelace-Karten genutzt wird

### GLP HA-Integration

Ein Custom Component, das das App alle 60 Sekunden abfragt (konfigurierbar). Es stellt alle GLP-Daten als native HA-Sensoren bereit — Shot-Anzahl, letztes Profil, Score, Dauer, Gewicht, Wartungsstatus, Aufwärmstatus usw. — sodass sie in Automationen, Energie-Dashboards und Lovelace-Dashboards verwendet werden können.

Installation via HACS: [github.com/mxkissnr/glp-integration](https://github.com/mxkissnr/glp-integration)

### GLP Shot Card

Eine Custom Lovelace-Karte, die Maschinenstatus, letzten Shot, Aufwärm-Fortschritt, einen Power-Button und eine **Profil-Auswahl** anzeigt. Sie kommuniziert direkt mit Port 8099 und liest die `switch_entity` aus dem `machine_status`-Sensor-Attribut (automatisch von der Integration gesetzt) — keine manuelle Konfiguration erforderlich.

Die Profil-Auswahl liest und schreibt `select.gaggiuino_profiler_profile`, bereitgestellt nativ durch die GLP Integration (v1.9.0+). Die Auswahl wird automatisch ausgeblendet wenn die Entität nicht vorhanden ist.

Installation via HACS: [github.com/mxkissnr/glp-lovelace-card](https://github.com/mxkissnr/glp-lovelace-card)

### GLP Order Card

Eine kunden-seitige Lovelace-Karte für das Bestellsystem. Kunden wählen ein Getränk aus der Karte, geben eine optionale Notiz ein und verfolgen den Bestellstatus in Echtzeit. Wenn der Barista eine Bestellung als fertig markiert, zeigt die Karte eine Shot-Zusammenfassung mit Druckkurve. Erfordert `enable_orders: true` in der App-Konfiguration.

Bohnen-Varianten kommen aus der Kaffee-Bibliothek über `/api/orders/active-beans`: Angeboten werden nur Bohnen, die tatsächlich noch vorrätig sind (Rest = Packungsvorrat minus der in Shot-Annotationen erfassten Dosen), und jede Bohne liefert ihre kundengerechte Beschreibung mit (Geschmacksnoten, Herkunft, Aufbereitung), damit die Karte zeigen kann, was den Kaffee ausmacht.

Installation via HACS: [github.com/mxkissnr/glp-order-card](https://github.com/mxkissnr/glp-order-card)

### API-Token

Alle Komponenten authentifizieren sich automatisch über einen gemeinsamen Token:

1. Das App generiert beim ersten Start einen zufälligen 64-stelligen Token und speichert ihn in `/data/api_token.txt`.
2. `GET /api/token` gibt den Token zurück — aber nur für Anfragen aus dem HA-Supervisor-internen Netz (Loopback oder `172.30.0.0/16`), also über den HA-Ingress-Proxy, oder für Anfragen mit einem gültigen Supervisor-Bearer-Token (genutzt von der HA-Integration). Externe LAN-Clients können den Token nicht über einen nicht-authentifizierten Endpunkt lesen.
3. Browser-UI und Integration lesen den Token beim Start über `/api/token` (die Anfrage läuft durch den Supervisor) und schicken ihn danach als `X-GLP-Token`-Header bei allen Anfragen mit.
4. Anfragen über HA Ingress umgehen die Token-Prüfung vollständig — HA hat den Benutzer bereits authentifiziert.
5. **GLP Order Card im Direkt-URL-Modus** (`glp_url` konfiguriert): `glp_token: <token>` in der Karten-YAML-Konfiguration setzen. Den Token findest du unter **Einstellungen → API Token** in der App-Oberfläche (App einmal über HA Ingress öffnen, oder eine Sitzung nutzen, die bereits einen gültigen Token besitzt).

Keine manuelle Konfiguration für den HA-Ingress-Pfad erforderlich. Um den Token zu erneuern, `/data/api_token.txt` löschen und das App neu starten.

#### Vertrauensmodell

Der API-Token gewährt vollen API-Zugriff — inklusive `/api/restore`, das die gesamte Datenbank löscht und ersetzt. Deshalb gibt `/api/token` den Token nur an zwei Arten von Anfragen heraus:

- **Supervisor-interne Anfragen**: Loopback und das HA-Supervisor-eigene Netz (`172.30.0.0/16`). Das deckt den HA-Ingress-Proxy (Browser-UI) sowie die GLP-HA-Integration ab, die sich mit ihrem Supervisor-Bearer-Token authentifiziert.
- **Bereits authentifizierte Sitzungen**: eine Anfrage, die bereits einen gültigen `X-GLP-Token`-Header mitschickt.

Gewöhnliche LAN- oder Docker-Bridge-Adressen sind **nicht** vertrauenswürdig — dass ein Gerät Port 8099 erreichen kann, reicht nicht mehr aus, um den Token zu erhalten. Jede andere Integration, die den Token direkt benötigt (z. B. die Order Card im Direkt-URL-Modus), muss ihn explizit erhalten: App einmal über HA Ingress öffnen, zu **Einstellungen → API Token** gehen und über den Kopieren-Button übernehmen.

Alle persistenten Daten werden in SQLite (`/data/glp.db`) mit aktiviertem WAL-Journal-Modus gespeichert — Schreibvorgänge sind standardmäßig absturzsicher, ohne dass ein inkonsistenter Zustand entstehen kann.

### API-Spec

Eine maschinenlesbare OpenAPI-3.0.3-Spezifikation aller Endpunkte ist unter `GET /api/openapi.json` (ohne Auth) abrufbar und als [`openapi.yaml`](openapi.yaml) im Repository abgelegt. Einfach die URL oder die Datei in den [Swagger Editor](https://editor.swagger.io/) einfügen, um die vollständige API zu erkunden.

## Schnellstart

`machine_host` auf die IP oder den Hostnamen des Controllers setzen und App starten.

```yaml
machine_host: "192.168.1.42"                 # IP oder Hostname des Gaggiuino-Controllers
sync_interval: 5
switch_entity: "switch.espresso_steckdose"   # optional
```

Verbindung im HA-Terminal testen:
```bash
curl http://<gaggiuino-ip>/api/shots/latest
```

## Konfigurationsoptionen

| Option | Beschreibung | Standard |
|---|---|---|
| `machine_host` | IP oder Hostname des Gaggiuino-Controllers | `gaggiuino.local` |
| `sync_interval` | Automatischer Sync-Intervall in Minuten (1–60) | `5` |
| `switch_entity` | HA-Switch-Entität zum Ein-/Ausschalten der Maschine | *(leer)* |
| `preheat_time` | Aufwärmzeit in Minuten — wie lange nach dem Einschalten bis die Maschine brühbereit ist (1–120) | `20` |
| `enable_orders` | Bestellsystem aktivieren — Barista-Backend-Tab + Kunden-Bestellkarte; standardmäßig deaktiviert | `false` |
| `port` | Port, auf dem der Server lauscht (1024–65535) | `8099` |

## Features

| Tab | Beschreibung |
|---|---|
| **Live** | Echtzeit-Charts für Druck, Flow, Gewicht und Temperatur während eines Shots. Beim Start eines Bezugs wird automatisch der letzte Shot mit demselben Profil als gestrichelte Referenzkurve eingeblendet. Kann über das Dropdown überschrieben oder entfernt werden. Der Tab ist nur sichtbar wenn die Maschine eingeschaltet ist (erfordert `switch_entity`). |
| **Shots** | Shot-Verlauf mit vollständigem Chart, Score, Annotation (**Kaffee-Dropdown** aus der Bibliothek, Mühle, Dosis, Notizen, **Getränktyp**, **Bohnenalter beim Shot**) und Vollbild-Chart. Bei Sortierung nach "Neueste" werden Shots älter als der aktuelle Monat in der Sidebar zu monatsweisen, aufklappbaren Abschnitten zusammengefasst — der aktuelle Monat bleibt immer eine flache Liste. Das Kaffeefeld ist ein Dropdown, das aus der Bohnenbibliothek befüllt wird — eigene Einträge die nicht in der Bibliothek sind bleiben erhalten. Annotationsfelder werden **automatisch gespeichert** 1 Sekunde nach der letzten Eingabe. Wenn eine bekannte Bohne ausgewählt wird, wird das Alter der Bohne zum Zeitpunkt des Shots automatisch aus dem Röstdatum der aktiven Packung berechnet und in der Annotation gespeichert. Getränkoptionen kommen aus demselben Menü wie das Bestellsystem. Ein **Teilen**-Button in der Toolbar öffnet eine Formatauswahl und exportiert den Shot als PNG-Karte — zwei Formate: **Quadrat (1:1)** 1080×1080 für Feed-Posts, **Story (9:16)** 1080×1920 für Instagram Stories. Nutzt die native Web Share API auf Mobilgeräten, fällt auf Desktop auf Download zurück. Karten-Layout: schwarz/weißes Theme, GLP-Logo im Header mit Shot-ID und Datum, Profilname, Bohne, Dosis → Yield · Ratio · Dauer, Phasen-Chips (Preinfusion / Extraktion in Blau/Orange) über dem vollständigen Datenchart mit Legende, zweispaltiger Stats-Bereich (DRUCK, PUMPENFLUSS, TEMPERATUR links; GEWICHT, GEWICHTSFLUSS, DAUER, DOSIS → YIELD · RATIO rechts), Score-Badge. |
| **Analytics** | Aggregierte Statistiken über alle Shots: **Übersicht-KPIs** (Shots gesamt, Ø Score, Kaffee gesamt, Shots diese Woche, längste tägliche Streak), **Persönliche Bestleistungen** (bester Shot mit direktem Link, längste Streak, Lieblingsbohne/-profil, aktivster Tag), **Score-Trend**-Chart (30 / 90 / alle), **Shot-Kalender**-Heatmap, **Bohnen-Auswertung**, **Profil-Performance**-Balkendiagramm, **Mühlen-Auswertung**, **Kaffee-Weltkarte** (interaktiv: Scrollen/Pinchen zum Zoomen, Ziehen zum Verschieben — Choropleth der Bohnen-Herkunftsländer nach Shot-Anzahl im Akzentfarbverlauf der App eingefärbt, mit Farbskalen-Legende, Ansicht startet automatisch auf die Länder/Bohnen mit tatsächlichen Daten fokussiert statt auf die ganze Welt, bei Blends anteilig auf alle Herkunftsländer aufgeteilt, plus ein pulsierender Punkt pro Bohne an der geocodeten Anbau-Region oder ersatzweise am Länder-Mittelpunkt mit dauerhaft sichtbarem Label sobald mindestens ein Shot erfasst ist, Tooltips mit Flagge + lokalisiertem Ländernamen), **Dosis & Ratio-Verteilung** als Histogramme, **Tageszeit**-Balkendiagramm nach Ø Score eingefärbt. |
| **Bibliothek** | Kaffeebohnen- und Mühlenkatalog plus **Rezepte**-Tab. Bohnenkarten zeigen eine **Sterne-Bewertung** (Mittelwert aus den Shot-Bewertungen dieser Bohne, rein berechnet — kein manuelles Feld) und ein **Röstfrische-Badge** (Tage seit Röstung, eingefärbt nach Degassing-/Peak-/Fading-Fenster, aus dem Röstdatum der aktiven Packung — ausgeblendet sobald der Restbestand einer bestandsgeführten Bohne null erreicht). Bohnen unterstützen: **Herkunftsländer** (eines oder mehrere, aus einer Liste von Kaffeeanbauländern ausgewählt und als Chips mit Flagge und lokalisiertem Namen angezeigt — eine Bohne mit mehr als einem Herkunftsland ist ein Blend, mit optionalem prozentualem Gewichtungsanteil pro Land für die anteilige Aufteilung auf der Kaffee-Weltkarte in Statistiken), **Varietät** (Arabica, Robusta, Geisha, … mit Vorschlägen), **Aufbereitung** (Washed, Natural, Honey, Anaerobic, … mit Vorschlägen), **Geschmacksnoten als Tags** (Chips-Eingabe; Importe befüllen sie automatisch, das Notizfeld bleibt für persönliche Anmerkungen — siehe auch das **Aroma-Rad** unten), **Röstung** (Espresso / Filter / Omni, aus Shop-Tags importiert), **Anbau-Region** (Freitext, serverseitig via Nominatim zu Kartenkoordinaten geocodet), ein beim Import einmalig heruntergeladenes **Produktbild** (als Thumbnail und im Aroma-Rad angezeigt) — oder manuell hochgeladen, falls der automatische Download fehlschlägt, optionale Felder für **Höhenlage, Importeur, Ernte, Preis, Produzent und Zertifizierung** (nur angezeigt wenn gesetzt; Höhenlage/Importeur/Ernte/Preis werden importiert, wo der Shop sie liefert), eine manuelle **Zubereitungsempfehlung** (Temperatur, Verhältnis, Zeit, Hinweis — nur angezeigt wenn gesetzt; keine Import-Quelle liefert das als strukturierte Daten), Entkoffeiniert-Flag, Chargen-Tracking (Röstdatum + Anfangsgewicht pro Packung, Verbrauch pro Packung und Gesamtverbrauch über alle Packungen), URL-Import von kaffeebraun.com, hoppenworth-ploch.de und elbgold.com (jeweils einzeln deaktivierbar) plus generischem Fallback (Shopify/JSON-LD/Webseiten-Metadaten) für jeden anderen Shop, mit Einstellungen-Panel für eigene Shopify-Shop-Domains, Barcode-Scan, QR-Code. Mühlen unterstützen optional **Mahlwerk-Typ** (mit Vorschlägen), **Kaufdatum** und ein direkt hochgeladenes **Foto**. Rezepte speichern Brühmethode (Espresso, AeroPress, V60, French Press, Moka, Cold Brew), Dosis, Ausbeute, Zeit, Wassertemperatur, Wassermenge, Eismenge, Mahlgrad, Quellenlink und Workflow-Schritte. |
| **Einwählen** | Einwähl-Assistent: Ziel-Shot mit aktuellen Versuchen vergleichen. Der Mahlgrad-Hinweis in der Shot-Ansicht markiert zusätzlich Brew-Ratios außerhalb des klassischen Espresso-Fensters (1:1.8–2.2), wenn die Dauer selbst passt. |
| **Wartung** | Fünf Maschinenwartungs-Erinnerungen (Entkalken, Backflush, Gruppenköpf-Service, Dichtungen & Siebe, Wasserfilter) plus ein eigener Reinigungsplan pro Mühle. Alle Aufgaben haben konfigurierbare Shot- oder Tages-Schwellenwerte, Fortschrittsbalken und „Jetzt erledigt"-Button. Backflush und Entkalken bieten zusätzlich eine **geführte Anleitung**: eine Schritt-für-Schritt-Checkliste, die den Erledigt-Button erst freischaltet, wenn alle Schritte abgehakt sind, und die Aufgabe dann protokolliert. Unterhalb der Karten: ein **Wartungsprotokoll**, das jeden Servicevorgang aufzeichnet — Datum, Aufgabe, Shot-Anzahl zum Zeitpunkt und Maschinenname. Einträge entstehen automatisch beim „Jetzt erledigt"-Klick; vergangene Wartungen können per Formular (Aufgabe, Datum, Notizen) nachgetragen werden. Einzelne Einträge sind löschbar. Gespeichert in `/data/maintenance_log.json`. |
| **Bestellungen** | Barista-Backend für Bestellverwaltung *(erfordert `enable_orders: true`)*. Bestellannahme per Toggle ein-/ausschalten, Getränkemenü verwalten (Emoji + Name + optionale **Varianten** — entweder manuell eingetragen, automatisch aus der aktiven Bohnenbibliothek über den 🫘-Toggle, oder aus der aktiven Milchbibliothek über den 🥛-Toggle, gespeichert in `/data/menu.json`), eine optionale Milchmenge pro Bestellung (**ml**), die bei Bestellabschluss von der passenden Milch in der Bibliothek abgezogen wird — Milchsorten ohne Restbestand verschwinden aus der aktiven Liste, Live-Warteschlange mit automatisch vorgeschlagenem ETA basierend auf der aktuellen Warteschlangenlänge, und Verlauf einsehen. Bestellungen annehmen mit ETA-Auswahl (vorausgefüllt mit Warteschlangen-Schätzung) oder mit Freitext ablehnen. Kunden-Statistik-Panel zeigt Gesamtbestellungen und Auswertung pro Kunde. **Push-Benachrichtigungen** (einklappbare Sektion): drei unabhängige Bereiche — (1) **Broadcast-Empfänger**: ein oder mehrere `notify.mobile_app_*`-Geräte auswählen, die eine Nachricht erhalten wenn Bestellungen geöffnet werden ("☕ geöffnet — Bestellungen über das Menü Kaffeebar aufgeben"; aufheiz-bewusst: "öffnet in ca. X Min." während der Aufheizphase) oder geschlossen werden ("🚫 geschlossen"); (2) **Barista-Benachrichtigung**: ein Gerät, das sofort eine Benachrichtigung erhält wenn eine neue Bestellung eingeht (Titel: Getränkename, Text: Kundenname + Notiz), wenn die Maschine fertig aufgeheizt ist ("☕ Maschine bereit") sowie einmal pro Packung wenn der Restbestand einer Bohne unter 100 g fällt ("🫘 Bohne fast leer"); (3) **Pro-Kunden-Zuordnung**: jedem HA-Nutzer ein Gerät zuweisen (alle `person.*` Entities werden angezeigt, plus Kunden aus dem Bestellverlauf) — dieses Gerät wird benachrichtigt wenn die eigene Bestellung angenommen, fertig oder abgelehnt wird. Erfordert `homeassistant_api: true` und die HA Companion App. Kundenbestellung über die [GLP Order Card](https://github.com/mxkissnr/glp-order-card). |

### Ersteinrichtung & Demo-Modus

Ist die Gaggiuino-Maschine nicht erreichbar (falscher/nicht erreichbarer `machine_host`), zeigt GLP ein schließbares Banner am oberen Seitenrand mit dem konfigurierten Host und einem Link zum [Wiki](https://github.com/mxkissnr/gaggiuino-local-profiler/wiki) mit Einrichtungshilfe. Das Ausblenden gilt nur für die aktuelle Browser-Sitzung.

Wenn die Datenbank noch keine Shots enthält **und** die Maschine noch nie erreichbar war, zeigt die Shots-Ansicht statt des einfachen Leerzustands ein **Ersteinrichtungs-Panel**: drei Einrichtungsschritte (`machine_host` setzen, Gaggiuino-Erreichbarkeit im Netzwerk prüfen, Add-on neu starten) sowie einen Button **„Demo-Daten laden"**.

Das Laden von Demo-Daten befüllt die App mit einem statischen Beispieldatensatz — rund einem Dutzend Shots mit plausiblen Druck-/Fluss-/Temperaturkurven und Bewertungen, drei Beispiel-Bohnen (darunter eine Blend-Bohne mit dem Mehrfach-Origin-Feld `origins[]`) und einem Rezept — sodass Shots-, Analytics- (Weltkarte, Score-Trend, Bohnen-Statistik) und Aroma-Rad-Ansicht zur Bewertung gefüllt sind. Solange Demo-Daten vorhanden sind, zeigt die Sidebar ein Badge **„Demo-Modus"** mit einem Button **„Demo beenden"**; das Beenden löscht genau die zuvor angelegten Zeilen. Demo-Daten lassen sich nur in eine ansonsten leere Datenbank laden (keine bestehenden Shots/Bohnen/Rezepte).

### Live-Tab, Switch-Entity und Aufwärmtimer

Wenn `switch_entity` gesetzt ist, wird der **Live**-Tab ausgeblendet solange die Maschine aus ist und erscheint automatisch sobald sie eingeschaltet wird. Ohne Switch-Entity ist der Tab immer sichtbar.

Nach dem Einschalten zeigt der Live-Tab einen Fortschrittsbalken und einen Countdown. Die Maschine gilt als bereit wenn **thermische Stabilität** erkannt wird: die Temperatur muss die letzten 30 Sekunden innerhalb von ±1,5 °C bei oder nahe dem Zielwert liegen. Der feste `preheat_time`-Timer dient als Sicherheits-Ceiling — nach Ablauf wird die Maschine in jedem Fall als bereit markiert, auch ohne erkannte Stabilität. Der Timer wird **nicht** zurückgesetzt bei kurzen Stromunterbrechungen (< 5 Minuten, Temperatur noch über 80 °C). Der Aufwärmstatus wird auch als HA-Sensoren bereitgestellt (`binary_sensor.…preheat_ready`, `sensor.…preheat_elapsed`, `sensor.…preheat_remaining`).

### Import von kaffeebraun.com

Im Bibliothek-Tab auf **🔗 URL** neben „Bohne hinzufügen" klicken, eine Produkt-URL von [kaffeebraun.com](https://kaffeebraun.com) einfügen und auf „Importieren" drücken. Das App lädt die Produktseite serverseitig und befüllt das Bohnen-Formular mit:

- Name und Rösterei (wird automatisch auf „Kaffee Braun" gesetzt)
- Aromen als **Geschmacks-Tags** (Chips)
- Herkunft — Einzelland-Herkünfte werden auf das strukturierte Herkunftsland-Feld gemappt (Flagge + lokalisierter Name); Blends bleiben in den Notizen
- Aufbereitungsart — befüllt das strukturierte Aufbereitungs-Feld
- Röstgrad (Label und Punktzahl)

Importierte Bohnen zeigen in der Bibliothekskarte eine kleine Zeile **„Importiert von kaffeebraun.com · Datum"**, damit man immer weiß woher die Daten stammen und wann sie importiert wurden.

### Import von hoppenworth-ploch.de

Dasselbe **🔗 URL**-Feld akzeptiert auch Produkt-URLs von [hoppenworth-ploch.de](https://hoppenworth-ploch.de) (Hoppenworth & Ploch, Frankfurt). Der Import nutzt die strukturierten Produktdaten des Shops und befüllt: Name (z.B. „Shyira Washed - Ruanda"), Rösterei, Tasting Notes als **Geschmacks-Tags**, **Herkunftsland** (aus dem Titel gemappt), Anbau-**Region**, **Varietät**, **Aufbereitung**, **Röstung** (aus den Espresso/Filter-Shop-Tags) und das **Decaf**-Flag bei DECAF-Produkten. Bietet der Shop dieselbe Bohne in mehreren Größen zu unterschiedlichen Preisen an, fragt ein Picker vor dem Ausfüllen des Formulars welche Größe gekauft wurde — Preis und Gewicht der gewählten Größe werden zusammen übernommen, damit sie immer zusammenpassen.

### Import von elbgold.com

Dasselbe Feld akzeptiert auch Produkt-URLs von [elbgold.com](https://elbgold.com) (Hamburg). Anders als bei den beiden anderen Quellen liefern elbgolds Produktseiten keine strukturierte Spec-Tabelle — die Beschreibung ist freier deutscher Fließtext — daher ist der Import **Best-Effort**: Name und Rösterei ("elbgold") sind exakt; Tasting Notes werden aus einem „Noten von …"-Satz extrahiert, oder — falls der fehlt — per Fallback-Stichwortsuche im Fließtext nach einer „Sensorik"/„Geschmack"/„Aromen"-Überschrift gegen eine kleine kuratierte deutsche Vokabelliste (nicht erschöpfend; manche Formulierungen liefern trotzdem nichts); die Anbau-Region kommt aus einer „Herkunft – …"-Überschrift; Herkunftsländer werden erkannt, indem die gesamte Beschreibung nach Kaffeeanbauländern durchsucht wird — bis zu 3 verschiedene Länder gelten als echter Blend, mehr als das wird als Rauschen (z.B. Shop-Boilerplate) gewertet und bleibt ungemappt; die Röstung kommt aus den Espresso/Filter-Shop-Tags; Decaf wird aus dem Titel erkannt. Das vorbefüllte Formular vor dem Speichern immer prüfen.

### Import von jedem anderen Shop

Der Button **⚙ Quellen** neben **🔗 URL** öffnet das Import-Einstellungen-Panel: jeder der 3 eingebauten Parser oben kann deaktiviert werden, und eigene Shopify-Shop-Domains können hinzugefügt werden — diese werden direkt über den generischen Shopify-Parser unten geleitet.

Für jede URL, die keiner der 3 eingebauten Quellen oder einer selbst hinzugefügten Domain entspricht, versucht der Import automatisch der Reihe nach, bis einer erfolgreich ist:

1. **Generisches Shopify** — jeder Shopify-Shop stellt einen Endpunkt `<Produkt-URL>/products/<handle>.js` bereit; passt die URL, wird dessen JSON genauso geparst wie bei den eingebauten Shopify-Shops (Name, Rösterei, aus der Beschreibung abgeleitete Aromen/Herkünfte, Bild, Preis, Größenvarianten).
2. **JSON-LD** — viele Shops betten einen `schema.org/Product`-Block ein (`<script type="application/ld+json">`) mit Name, Bild, Beschreibung und Preis, unabhängig von der Shop-Plattform.
3. **Webseiten-Metadaten** — als letzter Ausweg werden die `og:title`/`og:image`/`og:description`-Meta-Tags genutzt, die fast jede Produktseite setzt, mit derselben Stichwort- und Herkunftsland-Erkennung auf dem kombinierten Text.

Das Import-Ergebnis zeigt an, welche dieser Methoden die Daten geliefert hat (z.B. „Quelle: generischer Shopify-Import (shop.example.com)", „Quelle: JSON-LD (…)", „Quelle: Webseiten-Metadaten (…)"). Alles außer den eingebauten Parsern ist Best-Effort — das vorbefüllte Formular vor dem Speichern immer prüfen.

Abrufe sind gegen SSRF gehärtet: es werden nur `https://`-URLs akzeptiert, und der Ziel-Hostname (sowie jeder Redirect-Hop) wird aufgelöst und abgelehnt, falls er auf eine private, Loopback-, Link-Local- oder Carrier-Grade-NAT-Adresse statt auf eine öffentliche zeigt.

### Kaffee-Aroma-Rad

Jede Bohne mit Geschmacks-Tags zeigt in der Bibliothek einen 🎡-Button. Er öffnet ein Sunburst-Diagramm der Kaffee-Aroma-Hierarchie — die Kategorienstruktur folgt dem SCA/WCR *Coffee Taster's Flavor Wheel* (2016); dies sind eigens abgeleitete Daten, übersetzt in alle 6 UI-Sprachen (DE, EN, IT, FR, ES, NL), nicht die Original-Grafik. Die Aromen aus den Tags der Bohne werden gegen das Rad gematcht (exakter Label-Treffer in jeder der 6 Sprachen, eine deutsche Alias-Tabelle für zusammengesetzte/umgangssprachliche Begriffe, dann Wortgrenzen-Textcontainment). Nur der Treffer-Pfad — die tatsächlichen Aromen der Bohne plus ihre übergeordneten Kategorien — wird groß, vollfarbig und beschriftet gezeigt (die äußeren Ringe zeigen Text radial, wie Speichen, genau wie beim Original); alles andere bleibt ein schmaler, entsättigter, unbeschrifteter Streifen — das komplette Rad bleibt als Kontext sichtbar, ohne mit den eigentlichen Treffern um Aufmerksamkeit zu konkurrieren. Nicht zugeordnete Aromen werden als einfache Chips unter dem Diagramm gelistet, damit nichts stillschweigend verloren geht. Das Rad-Modal scrollt nie — es passt sich immer an den Viewport an und lässt sich über das ✕ oder per Klick/Tap außerhalb schließen.

Fallen alle gematchten Aromen unter einen einzigen Zweig — der Normalfall bei ein bis zwei Geschmacksnotizen —, öffnet sich das Rad direkt hineingezoomt in diesen Zweig statt in die volle 9-Kategorien-Übersicht, damit der relevante Ausschnitt von Anfang an genug Platz für lesbaren Text hat. Tippen bzw. Klicken auf ein Segment mit Unterkategorien zoomt hinein, ein Klick auf einen Eintrag im Breadcrumb-Pfad über dem Diagramm springt dorthin zurück — beides funktioniert identisch per Touch und mit der Maus.

### Barcode- und QR-Scanner

Im Bibliothek-Tab auf **⬛ Scan** neben „Bohne hinzufügen" tippen, um den Kamera-Scanner zu öffnen.

- **EAN/UPC-Barcode** (z.B. auf einer Supermarkt-Kaffeepackung) — GLP schlägt den Code bei [Open Food Facts](https://world.openfoodfacts.org) nach und befüllt Name, Rösterei und Notizen vor. Specialty-Kaffees sind oft nicht in der Datenbank — Rest manuell ausfüllen.
- **GLP-QR-Code** — QR-Code einer anderen GLP-Installation scannen für einen Direktimport von Name, Rösterei, Röstdatum und Notizen.
- Jede Bohne in der Bibliothek hat einen **QR-Button** der einen teilbaren QR-Code mit Name, Rösterei, Röstdatum und Notizen erzeugt (Notizen werden gekürzt, damit der Code zuverlässig scanbar bleibt).

Erfordert einen Chromium-basierten Browser (nutzt die native BarcodeDetector Web API). Firefox und Safari werden nicht unterstützt.

### UI-Sprache

GLP unterstützt sechs Oberflächensprachen, umschaltbar unter ⚙ Einstellungen → Sprache:

| Code | Sprache |
|---|---|
| DE | Deutsch |
| EN | English |
| IT | Italiano |
| FR | Français |
| ES | Español |
| NL | Nederlands |

Die Auswahl wird in `localStorage` gespeichert. Alle UI-Texte, Chart-Beschriftungen, Mahlgrad-Empfehlungen, Wartungserinnerungen, Bestellstatus-Meldungen und Bibliothekstexte sind in allen sechs Sprachen vollständig übersetzt.

### Hell / Dunkel Theme

GLP hat einen eingebauten Theme-Wechsler (⚙ Einstellungen → Theme). Die Wahl wird in `localStorage` gespeichert und sofort angewandt. **Dark** ist die Voreinstellung; **Hell** kehrt die Grau-Skala auf eine weiß-basierte Palette um.

### HA-Theme

Eine passende Home-Assistant-Theme-Datei (`glp-ha-theme.yaml`) liegt im Repository-Root. Sie enthält **GLP Dark** und **GLP Light** für die gesamte HA-Oberfläche (Sidebar, Karten, Inputs, Switches, Statusfarben).

**Installation:**
1. `glp-ha-theme.yaml` in `config/themes/` des HA-Konfigurationsverzeichnisses kopieren (`themes/` ggf. anlegen).
2. `themes: !include_dir_merge_named themes` in `configuration.yaml` eintragen, HA einmal neu starten.
3. Im HA-Profil *GLP Dark* oder *GLP Light* auswählen.

### Kompatibilität mit ALERTua/hass-gaggiuino

Ab glp-integration v1.9.0 ist [ALERTua/hass-gaggiuino](https://github.com/ALERTua/hass-gaggiuino) nicht mehr notwendig. Die GLP-Integration deckt denselben Maschinen-Sensor-Satz ab und fügt alle GLP-spezifischen Sensoren hinzu:

| Entität | glp-integration | hass-gaggiuino |
|---|---|---|
| `select.…_profile` | ✅ `select.gaggiuino_profiler_profile` | `select.gaggiuino_profile` |
| Temperatur (live) | ✅ `sensor.…_machine_live_temperature` | ✅ |
| Zieltemperatur | ✅ `sensor.…_machine_target_temperature_live` | ✅ |
| Druck (live) | ✅ `sensor.…_machine_live_pressure` | ✅ |
| Wasserstand | ✅ `sensor.…_machine_water_level` | ✅ |
| Gewicht (live) | ✅ `sensor.…_machine_live_weight` | ✅ |
| Betriebszeit | ✅ `sensor.…_machine_uptime` | ✅ |
| Aktives Profil | ✅ `sensor.…_machine_live_profile` | ✅ |
| Brühschalter-Status | ✅ `binary_sensor.…_brew_switch` | ✅ |
| Dampfschalter-Status | ✅ `binary_sensor.…_steam_switch` | ✅ |
| Shot-Anzahl, Score, Wartung, Aufwärmen … | ✅ (GLP-exklusiv) | ✗ |

Die Profil-Endpunkte in GLP wurden vom Konzept der ALERTua/hass-gaggiuino-Integration inspiriert. Danke an [@ALERTua](https://github.com/ALERTua) für die ursprüngliche Integration.

Vollständige Dokumentation — Features, Live-Modus, Analytics, Shot-Score, Exporte, Kompatibilität — im [Wiki](https://github.com/mxkissnr/gaggiuino-local-profiler/wiki).
