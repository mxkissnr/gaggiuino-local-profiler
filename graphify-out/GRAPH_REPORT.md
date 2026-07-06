# Graph Report - gaggiuino-local-profiler  (2026-07-06)

## Corpus Check
- 117 files · ~148,571 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1412 nodes · 2641 edges · 75 communities (69 shown, 6 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 17 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `0cf95ff5`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- [[_COMMUNITY_Community 0|Community 0]]
- [[_COMMUNITY_Community 1|Community 1]]
- [[_COMMUNITY_Community 2|Community 2]]
- [[_COMMUNITY_Community 3|Community 3]]
- [[_COMMUNITY_Community 4|Community 4]]
- [[_COMMUNITY_Community 5|Community 5]]
- [[_COMMUNITY_Community 6|Community 6]]
- [[_COMMUNITY_Community 7|Community 7]]
- [[_COMMUNITY_Community 8|Community 8]]
- [[_COMMUNITY_Community 9|Community 9]]
- [[_COMMUNITY_Community 10|Community 10]]
- [[_COMMUNITY_Community 11|Community 11]]
- [[_COMMUNITY_Community 12|Community 12]]
- [[_COMMUNITY_Community 14|Community 14]]
- [[_COMMUNITY_Community 15|Community 15]]
- [[_COMMUNITY_Community 16|Community 16]]
- [[_COMMUNITY_Community 17|Community 17]]
- [[_COMMUNITY_Community 18|Community 18]]
- [[_COMMUNITY_Community 19|Community 19]]
- [[_COMMUNITY_Community 20|Community 20]]
- [[_COMMUNITY_Community 21|Community 21]]
- [[_COMMUNITY_Community 22|Community 22]]
- [[_COMMUNITY_Community 23|Community 23]]
- [[_COMMUNITY_Community 24|Community 24]]
- [[_COMMUNITY_Community 25|Community 25]]
- [[_COMMUNITY_Community 26|Community 26]]
- [[_COMMUNITY_Community 27|Community 27]]
- [[_COMMUNITY_Community 28|Community 28]]
- [[_COMMUNITY_Community 29|Community 29]]
- [[_COMMUNITY_Community 30|Community 30]]
- [[_COMMUNITY_Community 31|Community 31]]
- [[_COMMUNITY_Community 32|Community 32]]
- [[_COMMUNITY_Community 33|Community 33]]
- [[_COMMUNITY_Community 34|Community 34]]
- [[_COMMUNITY_Community 36|Community 36]]
- [[_COMMUNITY_Community 37|Community 37]]
- [[_COMMUNITY_Community 38|Community 38]]
- [[_COMMUNITY_Community 39|Community 39]]
- [[_COMMUNITY_Community 40|Community 40]]
- [[_COMMUNITY_Community 41|Community 41]]
- [[_COMMUNITY_Community 42|Community 42]]
- [[_COMMUNITY_Community 43|Community 43]]
- [[_COMMUNITY_Community 47|Community 47]]
- [[_COMMUNITY_Community 48|Community 48]]
- [[_COMMUNITY_Community 49|Community 49]]
- [[_COMMUNITY_Community 50|Community 50]]
- [[_COMMUNITY_Community 51|Community 51]]
- [[_COMMUNITY_Community 52|Community 52]]
- [[_COMMUNITY_Community 53|Community 53]]
- [[_COMMUNITY_Community 54|Community 54]]
- [[_COMMUNITY_Community 55|Community 55]]
- [[_COMMUNITY_Community 56|Community 56]]
- [[_COMMUNITY_Community 57|Community 57]]
- [[_COMMUNITY_Community 58|Community 58]]
- [[_COMMUNITY_Community 59|Community 59]]
- [[_COMMUNITY_Community 60|Community 60]]
- [[_COMMUNITY_Community 61|Community 61]]
- [[_COMMUNITY_Community 62|Community 62]]
- [[_COMMUNITY_Community 63|Community 63]]
- [[_COMMUNITY_Community 64|Community 64]]
- [[_COMMUNITY_Community 65|Community 65]]
- [[_COMMUNITY_Community 66|Community 66]]
- [[_COMMUNITY_Community 67|Community 67]]
- [[_COMMUNITY_Community 68|Community 68]]
- [[_COMMUNITY_Community 69|Community 69]]
- [[_COMMUNITY_Community 70|Community 70]]
- [[_COMMUNITY_Community 71|Community 71]]
- [[_COMMUNITY_Community 73|Community 73]]
- [[_COMMUNITY_Community 79|Community 79]]
- [[_COMMUNITY_Community 81|Community 81]]

## God Nodes (most connected - your core abstractions)
1. `t()` - 93 edges
2. `apiFetch()` - 65 edges
3. `getDb()` - 56 edges
4. `log()` - 42 edges
5. `Session 14:02` - 25 edges
6. `updateView()` - 23 edges
7. `S` - 20 edges
8. `ShotRepository` - 19 edges
9. `esc()` - 19 edges
10. `loadOptions()` - 18 edges

## Surprising Connections (you probably didn't know these)
- `shotToCSVRow()` --calls--> `avg()`  [INFERRED]
  gaggiuino-local-profiler/public-src/views/shots/index.js → gaggiuino-local-profiler/lib/card.js
- `updateView()` --calls--> `avg()`  [INFERRED]
  gaggiuino-local-profiler/public-src/views/shots/index.js → gaggiuino-local-profiler/lib/card.js
- `seed()` --calls--> `imagePath()`  [INFERRED]
  gaggiuino-local-profiler/scripts/screenshots.mjs → gaggiuino-local-profiler/lib/services/ImageService.js
- `updateDegassing()` --calls--> `parseDMY()`  [EXTRACTED]
  gaggiuino-local-profiler/public-src/views/shots/annotation.js → gaggiuino-local-profiler/public-src/utils.js
- `_checkPreheatNotify()` --calls--> `loadOptions()`  [EXTRACTED]
  gaggiuino-local-profiler/lib/preheat.js → gaggiuino-local-profiler/lib/data.js

## Import Cycles
- None detected.

## Communities (75 total, 6 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.01
Nodes (180): 1.0.0, 1.10.0, 1.10.1, 1.10.2, 1.11.0, 1.11.1, 1.12.0, 1.13.0 (+172 more)

### Community 1 - "Community 1"
Cohesion: 0.11
Nodes (13): loadMenu(), axios, express, fs, { getSwitchState, callHaService }, { GLP_VERSION, HA_API, HA_TOKEN, PROFILES_CACHE_FILE }, { loadOptions, getMachineUrl, getMachineBaseUrl, isOrdersEnabled, loadMenu }, { log, rateLimit } (+5 more)

### Community 2 - "Community 2"
Cohesion: 0.23
Nodes (12): avg(), detectPreinfusionEnd(), F(), fmtDur(), fmtDurSec(), fs, generateShareCard(), getGlpIcon() (+4 more)

### Community 3 - "Community 3"
Cohesion: 0.07
Nodes (50): bindFlavorInput(), BREW_METHOD_LABELS, closeBeanForm(), closeBeanStockEdit(), closeGrinderForm(), closeMilkForm(), closeNewBagForm(), closeRecipeForm() (+42 more)

### Community 4 - "Community 4"
Cohesion: 0.05
Nodes (39): 1.0.0, 1.10.0, 1.10.1, 1.10.2, 1.11.0, 1.11.1, 1.12.0, 1.13.0 (+31 more)

### Community 5 - "Community 5"
Cohesion: 0.12
Nodes (26): ALLOWED_URL_SCHEMES, app, axios, backgroundHaCheck(), express, fetchMachineVersion(), fs, getMachineBaseUrl() (+18 more)

### Community 7 - "Community 7"
Cohesion: 0.10
Nodes (20): loadOrdersSettings(), axios, callHaService(), getHaLanguage(), getNotifyServices(), { HA_API, HA_TOKEN }, { log }, sendHaNotify() (+12 more)

### Community 8 - "Community 8"
Cohesion: 0.09
Nodes (21): API Endpoints (internal), API Endpoints (internal), Configuration, Data Storage, Data Storage, Deleting Shots, Example, Extraction Yield (EY) (+13 more)

### Community 9 - "Community 9"
Cohesion: 0.13
Nodes (33): goToShot(), switchMode(), applyTranslations(), setLang(), buildTrendChart(), setTrendWindow(), acceptOrder(), addOrderMenuItem() (+25 more)

### Community 10 - "Community 10"
Cohesion: 0.11
Nodes (35): loadOrCreateApiToken(), getMachineBaseUrl(), getSyncIntervalMs(), loadOptions(), getSwitchState(), log(), writeFileSafe(), axios (+27 more)

### Community 11 - "Community 11"
Cohesion: 0.13
Nodes (14): 01:20, 01:28, 01:38, 01:43, 01:47, 01:49, 01:55, 02:01 (+6 more)

### Community 12 - "Community 12"
Cohesion: 0.29
Nodes (7): [1.87.0] – 2026-06-24, [1.93.0] – 2026-06-28, [1.97.0] – 2026-07-06, Added, Changed, Changed, Changed

### Community 14 - "Community 14"
Cohesion: 0.18
Nodes (17): _buildMonthGroup(), closeSidebar(), collapseSidebarOnMobile(), filterShots(), _flapFlip(), _monthLabel(), openSidebar(), renderSidebar() (+9 more)

### Community 15 - "Community 15"
Cohesion: 0.10
Nodes (19): API-Endpunkte (intern), Beispiel, Berechnungsfaktoren, Datenspeicherung, Extraction Yield (EY), Funktionen, Gaggiuino Local Profiler, Konfiguration (+11 more)

### Community 16 - "Community 16"
Cohesion: 0.09
Nodes (21): ALERTua/hass-gaggiuino compatibility, API spec, API token, Architecture — how the components work together, Barcode and QR scanner, Coffee flavor wheel, Configuration options, Features (+13 more)

### Community 17 - "Community 17"
Cohesion: 0.09
Nodes (21): API-Spec, API-Token, Architektur — wie die Komponenten zusammenspielen, Barcode- und QR-Scanner, Features, Gaggiuino Local Profiler, GLP App (dieses Repo), GLP HA-Integration (+13 more)

### Community 18 - "Community 18"
Cohesion: 0.29
Nodes (10): toggleMachinePower(), triggerSync(), updatePowerButton(), updateStatus(), checkForUpdate(), showUpdateBanner(), apiFetch(), initToken() (+2 more)

### Community 19 - "Community 19"
Cohesion: 0.31
Nodes (15): germanToIso(), quickClone(), renderAnnotationPanel(), _renderBeanSelect(), _renderDrinkPills(), _renderMilkPills(), _renderRecipeSelect(), renderStars() (+7 more)

### Community 20 - "Community 20"
Cohesion: 0.11
Nodes (14): app, crypto, { errorHandler }, express, { fetchMachineVersion, checkAndApplyMachinePower, backgroundHaCheck }, fs, { getDb }, { GLP_VERSION, DEFAULT_PORT, DATA_DIR, TOKEN_FILE, HA_INGRESS_PATH } (+6 more)

### Community 21 - "Community 21"
Cohesion: 0.10
Nodes (21): [1.88.0] – 2026-06-26, [1.89.0] – 2026-06-26, [1.90.0] – 2026-06-26, [1.91.0] – 2026-06-26, [1.92.0] – 2026-06-27, [1.94.0] – 2026-06-30, [1.95.0] – 2026-07-03, [1.96.0] – 2026-07-05 (+13 more)

### Community 22 - "Community 22"
Cohesion: 0.12
Nodes (14): CLAUDE.md — Gaggiuino Local Profiler, Commits, GitHub project, Key conventions, Language rules, Release & documentation rules (since 2026-07-05), Repo structure, Versioning (+6 more)

### Community 23 - "Community 23"
Cohesion: 0.07
Nodes (29): [1.88.1] – 2026-06-26, [1.89.1] – 2026-06-26, [1.90.1] – 2026-06-26, [1.90.2] – 2026-06-26, [1.90.3] – 2026-06-26, [1.90.4] – 2026-06-26, [1.91.1] – 2026-06-26, [1.92.1] – 2026-06-27 (+21 more)

### Community 24 - "Community 24"
Cohesion: 0.08
Nodes (23): allowScripts, better-sqlite3@12.11.1, esbuild@0.25.12, dependencies, axios, better-sqlite3, cheerio, express (+15 more)

### Community 25 - "Community 25"
Cohesion: 0.13
Nodes (14): Acknowledgements, 🏗️ Architecture, 🔗 Component Compatibility, ⚙️ Configuration, 🏠 Embed in HA Dashboard, ✨ Features, 🚀 Installation, License (+6 more)

### Community 26 - "Community 26"
Cohesion: 0.14
Nodes (21): ALLOWED_IMAGE_HOSTS, axios, { BEAN_IMAGE_DIR, ALLOWED_IMAGE_HOSTS, BEAN_IMAGE_MAX_BYTES }, CONTENT_TYPE_EXT, deleteBeanImage(), deleteImage(), fetchBeanImage(), fs (+13 more)

### Community 27 - "Community 27"
Cohesion: 0.22
Nodes (8): 18:52, 18:54, 18:56, 19:07, 19:13, 23:45, 23:48, Session 23:48

### Community 28 - "Community 28"
Cohesion: 0.25
Nodes (7): Attribution, Contributor Covenant Code of Conduct, Enforcement, Enforcement Responsibilities, Our Pledge, Our Standards, Scope

### Community 29 - "Community 29"
Cohesion: 0.29
Nodes (6): dependencies, axios, express, main, name, version

### Community 31 - "Community 31"
Cohesion: 0.40
Nodes (4): Reporting a Vulnerability, Scope, Security Policy, Supported Versions

### Community 32 - "Community 32"
Cohesion: 0.50
Nodes (3): Checklist, Related issue, Summary

### Community 36 - "Community 36"
Cohesion: 0.09
Nodes (21): 09:04, 09:06, 09:09, 09:10, 09:11, 09:12, 09:13, 09:15 (+13 more)

### Community 37 - "Community 37"
Cohesion: 0.50
Nodes (4): [1.87.2] – 2026-06-26, [1.87.3] – 2026-06-26, Security, Security

### Community 38 - "Community 38"
Cohesion: 0.13
Nodes (28): COFFEE_COUNTRY_CODES, findCountryInText(), mapOriginToCode(), nameToCode, cheerio, extractAltitudeM(), hoploJsonUrl(), { mapOriginToCode, findCountryInText } (+20 more)

### Community 39 - "Community 39"
Cohesion: 0.15
Nodes (11): validate(), { ZodError }, { annotationSchema }, express, { generateShareCard, isAvailable: cardAvailable }, libraryService, { log }, { MAX_SHOT_ID } (+3 more)

### Community 41 - "Community 41"
Cohesion: 0.21
Nodes (14): appRoot, constantsPath, crc32(), __dirname, main(), makeShotDatapoints(), makeSolidColorPng(), outDir (+6 more)

### Community 42 - "Community 42"
Cohesion: 0.10
Nodes (26): fs, { getDb }, isOrdersEnabled(), libService, loadAnnotations(), loadNotifyMapping(), loadOrders(), loadTrash() (+18 more)

### Community 43 - "Community 43"
Cohesion: 0.08
Nodes (25): 14:05, 14:11, 14:12, 14:12, 14:14, 14:15, 14:17, 14:18 (+17 more)

### Community 47 - "Community 47"
Cohesion: 0.10
Nodes (26): COFFEE_COUNTRIES, COUNTRY_CENTROIDS, countryName(), flagEmoji(), GUIDED_MAINT_STEPS, _isCountryCode(), MAINT_META, PROCESS_SUGGESTIONS (+18 more)

### Community 48 - "Community 48"
Cohesion: 0.09
Nodes (20): saveLibrary(), saveOrders(), Database, dataPath, dbPath, express, { getDb }, imageServicePath (+12 more)

### Community 49 - "Community 49"
Cohesion: 0.18
Nodes (19): _buildMaintCard(), closeGuidedMaint(), closeMaintLogForm(), deleteMaintLogEntry(), loadMaintenanceView(), loadMaintLog(), _logEsc(), maintStatusLabel() (+11 more)

### Community 50 - "Community 50"
Cohesion: 0.16
Nodes (24): avg(), avgActive(), detectChanneling(), detectPhases(), fmt(), max(), safeLast(), scoreClass() (+16 more)

### Community 51 - "Community 51"
Cohesion: 0.22
Nodes (9): 20:51, 20:52, 20:58, 20:59, 20:59, 21:14, 21:16, 21:19 (+1 more)

### Community 52 - "Community 52"
Cohesion: 0.30
Nodes (13): _applyRefDatasets(), autoApplyRefShot(), clearReferenceShot(), connectLiveStream(), disconnectLiveStream(), fetchLiveData(), fetchPreheatData(), handleLiveData() (+5 more)

### Community 53 - "Community 53"
Cohesion: 0.50
Nodes (4): 09:56, 10:00, 10:14, Session 09:56

### Community 54 - "Community 54"
Cohesion: 0.50
Nodes (4): 20:41, 20:42, 20:43, Session 20:40

### Community 55 - "Community 55"
Cohesion: 0.06
Nodes (22): getDb(), axios, enqueue(), geocodeRegion(), { getDb }, { GLP_VERSION }, loadCache(), { log } (+14 more)

### Community 56 - "Community 56"
Cohesion: 0.18
Nodes (5): LibraryService, require, require, sendHaNotify, require

### Community 57 - "Community 57"
Cohesion: 0.19
Nodes (14): clearChartOnTouchEnd(), corsairPlugin, LOCALE_MAP, phasePlugin, S, _subs, formatTimeLabel(), closeChartFullscreen() (+6 more)

### Community 58 - "Community 58"
Cohesion: 0.18
Nodes (10): backupRouter, Database, dbPath, express, { getDb }, makeApp(), memDb, realDb (+2 more)

### Community 59 - "Community 59"
Cohesion: 0.15
Nodes (11): _fileLocks, fs, rateLimit(), _rlWindows, express, { getDb }, { GLP_VERSION, MAX_SHOT_ID }, libService (+3 more)

### Community 60 - "Community 60"
Cohesion: 0.10
Nodes (19): ALLOWED_IMPORT_HOSTS, ALLOWED_URL_SCHEMES, DEFAULT_MENU, MAINTENANCE_DEFAULTS, { getDb }, { MAINTENANCE_DEFAULTS }, { DEFAULT_MENU, ORDERS_HISTORY_TTL_MS }, { getDb } (+11 more)

### Community 61 - "Community 61"
Cohesion: 0.24
Nodes (9): { annotationSchema, beanSchema, orderSchema }, require, annotationSchema, beanSchema, grinderSchema, maintenanceLogSchema, orderSchema, recipeSchema (+1 more)

### Community 62 - "Community 62"
Cohesion: 0.36
Nodes (5): calcShotScore(), _detectChanneling(), _stddev(), { calcShotScore }, require

### Community 63 - "Community 63"
Cohesion: 0.21
Nodes (12): appRepoRoot, __dirname, fmtDate(), git(), glpProjectRoot, loadPricing(), main(), PRICING_PATH (+4 more)

### Community 64 - "Community 64"
Cohesion: 0.15
Nodes (11): Database, dataPath, dbPath, { getDb }, haPath, libraryService, memDb, realData (+3 more)

### Community 65 - "Community 65"
Cohesion: 0.24
Nodes (12): closeFlavorWheel(), disposeFlavorWheel(), hslFor(), openFlavorWheel(), renderFlavorWheel(), toSunburstData(), FLAVOR_ALIASES, FLAVOR_WHEEL (+4 more)

### Community 66 - "Community 66"
Cohesion: 0.10
Nodes (11): loadLibrary(), { BEAN_IMAGE_MAX_BYTES }, express, { imagePath, CONTENT_TYPE_EXT, deleteBeanImage, deleteImage, saveUploadedImage }, libraryService, { loadLibrary, saveLibrary }, { rateLimit }, ROAST_TYPES (+3 more)

### Community 67 - "Community 67"
Cohesion: 0.31
Nodes (8): mapToXY(), calcComparativeGrindAdvice(), _miniShotChart(), _parseGrindNum(), calcBeanAgeAtShot(), calcShotScore(), getShotData(), _parseDMY()

### Community 69 - "Community 69"
Cohesion: 0.17
Nodes (16): _buildShotWrapper(), t(), esc(), downloadBackup(), loadData(), permanentDeleteShot(), restoreFromFile(), restoreShot() (+8 more)

### Community 70 - "Community 70"
Cohesion: 0.11
Nodes (17): { DATA_DIR }, Database, DB_PATH, fixSchema(), fs, initSchema(), JSON_FILES, { log } (+9 more)

### Community 71 - "Community 71"
Cohesion: 0.22
Nodes (8): STATIC_MAINTENANCE_TASKS, getMachineUrl(), express, libraryService, { loadOptions, getMachineUrl }, machineHostname(), router, { STATIC_MAINTENANCE_TASKS }

### Community 73 - "Community 73"
Cohesion: 0.40
Nodes (4): Claude model breakdown (by commit co-author line), Development Stats, Rough cost estimate (illustrative only — not real billing data), Timeline

### Community 79 - "Community 79"
Cohesion: 0.24
Nodes (10): _cache, invalidateGrinderImage(), _load(), loadBeanImageBlobUrl(), loadGrinderImageBlobUrl(), deleteGrinder(), loadBeanThumbnails(), loadGrinderThumbnails() (+2 more)

### Community 81 - "Community 81"
Cohesion: 0.14
Nodes (8): calcBeanRating(), calcBrewRatio(), freshnessState(), isoToGerman(), parseDMY(), roastAgeDays(), scoreColor(), now

## Knowledge Gaps
- **704 isolated node(s):** `name`, `version`, `main`, `express`, `axios` (+699 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **6 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `calcShotScore()` connect `Community 62` to `Community 57`, `Community 67`, `Community 60`, `Community 39`?**
  _High betweenness centrality (0.082) - this node is a cross-community bridge._
- **Why does `getDb()` connect `Community 55` to `Community 64`, `Community 70`, `Community 71`, `Community 42`, `Community 48`, `Community 20`, `Community 58`, `Community 59`, `Community 60`?**
  _High betweenness centrality (0.046) - this node is a cross-community bridge._
- **Why does `log()` connect `Community 10` to `Community 1`, `Community 70`, `Community 71`, `Community 7`, `Community 39`, `Community 42`, `Community 6`, `Community 20`, `Community 55`, `Community 56`, `Community 26`, `Community 59`, `Community 60`?**
  _High betweenness centrality (0.031) - this node is a cross-community bridge._
- **What connects `name`, `version`, `main` to the rest of the system?**
  _704 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.011049723756906077 - nodes in this community are weakly interconnected._
- **Should `Community 1` be split into smaller, more focused modules?**
  _Cohesion score 0.10526315789473684 - nodes in this community are weakly interconnected._
- **Should `Community 3` be split into smaller, more focused modules?**
  _Cohesion score 0.07058823529411765 - nodes in this community are weakly interconnected._