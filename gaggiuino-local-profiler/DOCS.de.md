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
  │       GLP Add-on                 │  ← dieses Add-on
  │  Node.js-Server, Port 8099       │
  │  speichert Shots in /data/       │
  │  REST-API + Web-Oberfläche       │
  └────────┬─────────────────────────┘
           │                    ▲
           │  fragt ab          │  HA Ingress (Browser, authentifiziert)
           │  /api/status       │  Port 8099 direkt (Integration, Karten)
           │  /shots.json       │
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

† erfordert enable_orders: true in der Add-on-Konfiguration
```

### GLP Add-on (dieses Repo)

Das zentrale Stück. Es synchronisiert den Shot-Verlauf von der Gaggiuino-Maschine, speichert ihn lokal in `/data/shots.json` und stellt Folgendes bereit:
- Eine Web-Oberfläche, die über HA Ingress erreichbar ist (das ☕-Panel in der HA-Seitenleiste)
- Eine REST-API auf Port 8099, die von der Integration und den Lovelace-Karten genutzt wird

### GLP HA-Integration

Ein Custom Component, das das Add-on alle 60 Sekunden abfragt (konfigurierbar). Es stellt alle GLP-Daten als native HA-Sensoren bereit — Shot-Anzahl, letztes Profil, Score, Dauer, Gewicht, Wartungsstatus, Aufwärmstatus usw. — sodass sie in Automationen, Energie-Dashboards und Lovelace-Dashboards verwendet werden können.

Installation via HACS: [github.com/mxkissnr/glp-integration](https://github.com/mxkissnr/glp-integration)

### GLP Shot Card

Eine Custom Lovelace-Karte, die Maschinenstatus, letzten Shot, Aufwärm-Fortschritt, einen Power-Button und eine **Profil-Auswahl** anzeigt. Sie kommuniziert direkt mit Port 8099 und liest die `switch_entity` aus dem `machine_status`-Sensor-Attribut (automatisch von der Integration gesetzt) — keine manuelle Konfiguration erforderlich.

Die Profil-Auswahl erfordert die originale [Gaggiuino HA-Integration](https://github.com/ALERTua/hass-gaggiuino); diese erstellt die `select.gaggiuino_profile`-Entität, die die Karte liest und beschreibt. Die Auswahl wird automatisch ausgeblendet wenn die Entität nicht vorhanden ist.

Installation via HACS: [github.com/mxkissnr/glp-lovelace-card](https://github.com/mxkissnr/glp-lovelace-card)

### GLP Order Card

Eine kunden-seitige Lovelace-Karte für das Bestellsystem. Kunden wählen ein Getränk aus der Karte, geben eine optionale Notiz ein und verfolgen den Bestellstatus in Echtzeit. Wenn der Barista eine Bestellung als fertig markiert, zeigt die Karte eine Shot-Zusammenfassung mit Druckkurve. Erfordert `enable_orders: true` in der Add-on-Konfiguration.

Installation via HACS: [github.com/mxkissnr/glp-order-card](https://github.com/mxkissnr/glp-order-card)

### API-Token

Alle Komponenten authentifizieren sich automatisch über einen gemeinsamen Token:

1. Das Add-on generiert beim ersten Start einen zufälligen 64-stelligen Token und speichert ihn in `/data/api_token.txt`.
2. `/api/status` ist öffentlich zugänglich und gibt den Token zurück.
3. Browser-UI und Integration lesen den Token beim Start aus `/api/status` und schicken ihn danach als `X-GLP-Token`-Header bei allen Anfragen mit.
4. Anfragen über HA Ingress umgehen die Token-Prüfung — HA hat den Benutzer bereits authentifiziert.

Keine manuelle Konfiguration erforderlich. Um den Token zu erneuern, `/data/api_token.txt` löschen und das Add-on neu starten.

## Schnellstart

`machine_url` auf die API-URL des Controllers setzen und Add-on starten.

```yaml
machine_url: "http://192.168.1.42/api/shots"
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
| `machine_url` | API-URL des Gaggiuino-Controllers | `http://gaggia.intern/api/shots` |
| `sync_interval` | Automatischer Sync-Intervall in Minuten (1–60) | `5` |
| `switch_entity` | HA-Switch-Entität zum Ein-/Ausschalten der Maschine | *(leer)* |
| `preheat_time` | Aufwärmzeit in Minuten — wie lange nach dem Einschalten bis die Maschine brühbereit ist (1–120) | `20` |
| `enable_orders` | Bestellsystem aktivieren — Barista-Backend-Tab + Kunden-Bestellkarte; standardmäßig deaktiviert | `false` |
| `port` | Port, auf dem der Server lauscht (1024–65535) | `8099` |

## Features

| Tab | Beschreibung |
|---|---|
| **Live** | Echtzeit-Charts für Druck, Flow, Gewicht und Temperatur während eines Shots. Beim Start eines Bezugs wird automatisch der letzte Shot mit demselben Profil als gestrichelte Referenzkurve eingeblendet. Kann über das Dropdown überschrieben oder entfernt werden. Der Tab ist nur sichtbar wenn die Maschine eingeschaltet ist (erfordert `switch_entity`). |
| **Shots** | Shot-Verlauf mit vollständigem Chart, Score, Annotation (Kaffee, Mühle, Dosis, Notizen) und Vollbild-Chart. |
| **Analytics** | Aggregierte Statistiken und Trendcharts über alle Shots. |
| **Bibliothek** | Kaffeebohnen- und Mühlenkatalog mit Verknüpfung zu Shots. |
| **Einwählen** | Einwähl-Assistent: Ziel-Shot mit aktuellen Versuchen vergleichen. |
| **Wartung** | Fünf Maschinenwartungs-Erinnerungen (Entkalken, Backflush, Gruppenköpf-Service, Dichtungen & Siebe, Wasserfilter) plus ein eigener Reinigungsplan pro Mühle. Alle Aufgaben haben konfigurierbare Shot- oder Tages-Schwellenwerte, Fortschrittsbalken und „Jetzt erledigt"-Button. |
| **Bestellungen** | Barista-Backend für Bestellverwaltung *(erfordert `enable_orders: true`)*. Bestellannahme per Toggle ein-/ausschalten, Getränkemenü verwalten (Emoji + Name, gespeichert in `/data/menu.json`), Live-Warteschlange (ausstehend / in Zubereitung) und Verlauf einsehen. Bestellungen annehmen mit ETA-Auswahl oder mit Freitext ablehnen. Kunden-Statistik-Panel zeigt Gesamtbestellungen und Auswertung pro Kunde. **Push-Benachrichtigungen** (einklappbare Sektion): jedem HA-Benutzer einen `notify.mobile_app_*`-Dienst zuweisen — das Add-on sendet dann eine Push-Benachrichtigung auf dieses Gerät wenn eine Bestellung angenommen, fertiggestellt oder abgelehnt wird (erfordert `homeassistant_api: true` und die HA Companion App). Kundenbestellung über die [GLP Order Card](https://github.com/mxkissnr/glp-order-card). |

### Live-Tab, Switch-Entity und Aufwärmtimer

Wenn `switch_entity` gesetzt ist, wird der **Live**-Tab ausgeblendet solange die Maschine aus ist und erscheint automatisch sobald sie eingeschaltet wird. Ohne Switch-Entity ist der Tab immer sichtbar.

Nach dem Einschalten zeigt der Live-Tab einen Fortschrittsbalken und einen Countdown bis `preheat_time` Minuten abgelaufen sind. Der Timer wird **nicht** zurückgesetzt, wenn die Maschine kurz aus- und wieder eingeschaltet wird, solange die Temperatur noch über 80 °C liegt (Auszeit < 5 Minuten) — kurze Stromunterbrechungen werden ignoriert. Der Aufwärmstatus wird auch als HA-Sensoren über die Companion-Integration bereitgestellt (`binary_sensor.…preheat_ready`, `sensor.…preheat_elapsed`, `sensor.…preheat_remaining`).

### Import von kaffeebraun.com

Im Bibliothek-Tab auf **🔗 URL** neben „Bohne hinzufügen" klicken, eine Produkt-URL von [kaffeebraun.com](https://kaffeebraun.com) einfügen und auf „Importieren" drücken. Das Add-on lädt die Produktseite serverseitig und befüllt das Bohnen-Formular mit:

- Name und Rösterei (wird automatisch auf „Kaffee Braun" gesetzt)
- Aromen / Tasting Notes
- Herkunft
- Aufbereitungsart
- Röstgrad (Label und Punktzahl)

Importierte Bohnen zeigen in der Bibliothekskarte eine kleine Zeile **„Importiert von kaffeebraun.com · Datum"**, damit man immer weiß woher die Daten stammen und wann sie importiert wurden.

### Barcode- und QR-Scanner

Im Bibliothek-Tab auf **⬛ Scan** neben „Bohne hinzufügen" tippen, um den Kamera-Scanner zu öffnen.

- **EAN/UPC-Barcode** (z.B. auf einer Supermarkt-Kaffeepackung) — GLP schlägt den Code bei [Open Food Facts](https://world.openfoodfacts.org) nach und befüllt Name, Rösterei und Notizen vor. Specialty-Kaffees sind oft nicht in der Datenbank — Rest manuell ausfüllen.
- **GLP-QR-Code** — QR-Code einer anderen GLP-Installation scannen für vollständigen Direktimport.
- Jede Bohne in der Bibliothek hat einen **QR-Button** der einen teilbaren QR-Code mit allen Bohnen-Feldern erzeugt.

Erfordert einen Chromium-basierten Browser (nutzt die native BarcodeDetector Web API). Firefox und Safari werden nicht unterstützt.

### Als Standalone-App installieren (PWA)

GLP liefert ein Web App Manifest und einen Service Worker mit, sodass es als eigenständige App auf dem Handy installiert werden kann.

**Android (Chrome):** GLP öffnen → Installations-Banner tippen oder ⋮-Menü → *Zum Startbildschirm hinzufügen*
**iOS (Safari):** GLP öffnen → Teilen-Symbol → *Zum Home-Bildschirm*

Nach der Installation öffnet GLP ohne Browser-Chrome und die App-Shell lädt sofort aus dem Cache. Shot-Daten und Live-Modus holen immer frische Daten vom Netzwerk.

Vollständige Dokumentation — Features, Live-Modus, Analytics, Shot-Score, Exporte, Kompatibilität — im [Wiki](https://github.com/mxkissnr/gaggiuino-local-profiler/wiki).
