# Graph Report - gaggiuino-local-profiler  (2026-07-06)

## Corpus Check
- 121 files · ~154,891 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1445 nodes · 2720 edges · 78 communities (71 shown, 7 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 17 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `fa40605b`
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
- [[_COMMUNITY_Community 72|Community 72]]
- [[_COMMUNITY_Community 73|Community 73]]
- [[_COMMUNITY_Community 75|Community 75]]
- [[_COMMUNITY_Community 76|Community 76]]
- [[_COMMUNITY_Community 77|Community 77]]
- [[_COMMUNITY_Community 78|Community 78]]

## God Nodes (most connected - your core abstractions)
1. `t()` - 94 edges
2. `apiFetch()` - 66 edges
3. `getDb()` - 56 edges
4. `log()` - 43 edges
5. `Session 14:02` - 25 edges
6. `updateView()` - 23 edges
7. `esc()` - 21 edges
8. `S` - 20 edges
9. `ShotRepository` - 19 edges
10. `LibraryService` - 19 edges

## Surprising Connections (you probably didn't know these)
- `seed()` --calls--> `imagePath()`  [INFERRED]
  gaggiuino-local-profiler/scripts/screenshots.mjs → gaggiuino-local-profiler/lib/services/ImageService.js
- `updateDegassing()` --calls--> `parseDMY()`  [EXTRACTED]
  gaggiuino-local-profiler/public-src/views/shots/annotation.js → gaggiuino-local-profiler/public-src/utils.js
- `shotToCSVRow()` --calls--> `avg()`  [INFERRED]
  gaggiuino-local-profiler/public-src/views/shots/index.js → gaggiuino-local-profiler/lib/card.js
- `updateView()` --calls--> `avg()`  [INFERRED]
  gaggiuino-local-profiler/public-src/views/shots/index.js → gaggiuino-local-profiler/lib/card.js
- `_checkPreheatNotify()` --calls--> `loadOptions()`  [EXTRACTED]
  gaggiuino-local-profiler/lib/preheat.js → gaggiuino-local-profiler/lib/data.js

## Import Cycles
- None detected.

## Communities (78 total, 7 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.01
Nodes (180): 1.0.0, 1.10.0, 1.10.1, 1.10.2, 1.11.0, 1.11.1, 1.12.0, 1.13.0 (+172 more)

### Community 1 - "Community 1"
Cohesion: 0.08
Nodes (18): axios, callHaService(), getNotifyServices(), getSwitchState(), { HA_API, HA_TOKEN }, { log }, axios, express (+10 more)

### Community 2 - "Community 2"
Cohesion: 0.24
Nodes (11): detectPreinfusionEnd(), F(), fmtDur(), fmtDurSec(), fs, generateShareCard(), getGlpIcon(), GLP (+3 more)

### Community 3 - "Community 3"
Cohesion: 0.06
Nodes (59): _cache, invalidateBeanImage(), invalidateGrinderImage(), _load(), loadBeanImageBlobUrl(), loadGrinderImageBlobUrl(), generateBeanQR(), parseGlpQrParams() (+51 more)

### Community 4 - "Community 4"
Cohesion: 0.05
Nodes (39): 1.0.0, 1.10.0, 1.10.1, 1.10.2, 1.11.0, 1.11.1, 1.12.0, 1.13.0 (+31 more)

### Community 5 - "Community 5"
Cohesion: 0.12
Nodes (26): ALLOWED_URL_SCHEMES, app, axios, backgroundHaCheck(), express, fetchMachineVersion(), fs, getMachineBaseUrl() (+18 more)

### Community 7 - "Community 7"
Cohesion: 0.15
Nodes (15): loadOrdersSettings(), getHaLanguage(), sendHaNotify(), N, notifyT(), _checkPreheatNotify(), fs, { getHaLanguage, sendHaNotify } (+7 more)

### Community 8 - "Community 8"
Cohesion: 0.09
Nodes (21): API Endpoints (internal), API Endpoints (internal), Configuration, Data Storage, Data Storage, Deleting Shots, Example, Extraction Yield (EY) (+13 more)

### Community 9 - "Community 9"
Cohesion: 0.14
Nodes (31): goToShot(), switchMode(), applyTranslations(), setLang(), acceptOrder(), addOrderMenuItem(), clearOrderHistory(), completeOrder() (+23 more)

### Community 10 - "Community 10"
Cohesion: 0.12
Nodes (33): getMachineBaseUrl(), getMachineUrl(), getSyncIntervalMs(), isOrdersEnabled(), loadOptions(), log(), axios, backgroundHaCheck() (+25 more)

### Community 11 - "Community 11"
Cohesion: 0.13
Nodes (14): 01:20, 01:28, 01:38, 01:43, 01:47, 01:49, 01:55, 02:01 (+6 more)

### Community 12 - "Community 12"
Cohesion: 0.29
Nodes (7): [1.87.0] – 2026-06-24, [1.93.0] – 2026-06-28, [1.97.0] – 2026-07-06, Added, Changed, Changed, Changed

### Community 14 - "Community 14"
Cohesion: 0.19
Nodes (22): avg(), avg(), avgActive(), detectChanneling(), detectPhases(), fmt(), max(), safeLast() (+14 more)

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
Cohesion: 0.12
Nodes (18): axios, enqueue(), geocodeRegion(), { getDb }, { GLP_VERSION }, loadCache(), { log }, _queue (+10 more)

### Community 20 - "Community 20"
Cohesion: 0.10
Nodes (16): app, crypto, { errorHandler }, express, { fetchMachineVersion, checkAndApplyMachinePower, backgroundHaCheck }, fs, { getDb }, { GLP_VERSION, DEFAULT_PORT, DATA_DIR, TOKEN_FILE, HA_INGRESS_PATH } (+8 more)

### Community 21 - "Community 21"
Cohesion: 0.08
Nodes (24): [1.88.0] – 2026-06-26, [1.89.0] – 2026-06-26, [1.90.0] – 2026-06-26, [1.91.0] – 2026-06-26, [1.92.0] – 2026-06-27, [1.94.0] – 2026-06-30, [1.95.0] – 2026-07-03, [1.96.0] – 2026-07-05 (+16 more)

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
Cohesion: 0.18
Nodes (11): closeMilkForm(), closeRecipeForm(), _collectSteps(), deleteMilk(), deleteRecipe(), loadLibrary(), renderMilkList(), renderRecipeList() (+3 more)

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
Cohesion: 0.08
Nodes (39): COFFEE_COUNTRY_CODES, findCountriesInText(), mapOriginToCode(), nameToCode, ALLOWED_IMPORT_HOSTS, FLAVOR_TERMS_DE, cheerio, escapeRegex() (+31 more)

### Community 39 - "Community 39"
Cohesion: 0.31
Nodes (15): germanToIso(), quickClone(), renderAnnotationPanel(), _renderBeanSelect(), _renderDrinkPills(), _renderMilkPills(), _renderRecipeSelect(), renderStars() (+7 more)

### Community 41 - "Community 41"
Cohesion: 0.21
Nodes (14): appRoot, constantsPath, crc32(), __dirname, main(), makeShotDatapoints(), makeSolidColorPng(), outDir (+6 more)

### Community 42 - "Community 42"
Cohesion: 0.10
Nodes (26): fs, { getDb }, libService, loadAnnotations(), loadMenu(), loadNotifyMapping(), loadOrders(), loadTrash() (+18 more)

### Community 43 - "Community 43"
Cohesion: 0.08
Nodes (25): 14:05, 14:11, 14:12, 14:12, 14:14, 14:15, 14:17, 14:18 (+17 more)

### Community 47 - "Community 47"
Cohesion: 0.36
Nodes (9): clearChartOnTouchEnd(), formatTimeLabel(), closeChartFullscreen(), getPQData(), openChartFullscreen(), renderFsChart(), switchChartTab(), switchFsTab() (+1 more)

### Community 48 - "Community 48"
Cohesion: 0.09
Nodes (20): saveLibrary(), saveMenu(), Database, dataPath, dbPath, express, { getDb }, imageServicePath (+12 more)

### Community 49 - "Community 49"
Cohesion: 0.18
Nodes (22): t(), downloadBackup(), renderDialin(), toggleBagHistory(), _buildMaintCard(), closeGuidedMaint(), closeMaintLogForm(), deleteMaintLogEntry() (+14 more)

### Community 50 - "Community 50"
Cohesion: 0.15
Nodes (20): _buildMonthGroup(), _buildShotWrapper(), closeSidebar(), collapseSidebarOnMobile(), filterShots(), _flapFlip(), _monthLabel(), openSidebar() (+12 more)

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
Cohesion: 0.12
Nodes (3): getDb(), OrderRepository, ShotRepository

### Community 56 - "Community 56"
Cohesion: 0.20
Nodes (3): LibraryService, require, require

### Community 57 - "Community 57"
Cohesion: 0.17
Nodes (8): corsairPlugin, GUIDED_MAINT_STEPS, MAINT_META, phasePlugin, PROCESS_SUGGESTIONS, VARIETY_SUGGESTIONS, LANGS, NEW_KEYS

### Community 58 - "Community 58"
Cohesion: 0.13
Nodes (13): { getDb }, _hydrate(), { TRASH_TTL_MS }, backupRouter, Database, dbPath, express, { getDb } (+5 more)

### Community 59 - "Community 59"
Cohesion: 0.14
Nodes (27): COFFEE_COUNTRIES, COUNTRY_CENTROIDS, countryName(), flagEmoji(), _isCountryCode(), scoreClass(), buildBeanStats(), buildCalendar() (+19 more)

### Community 60 - "Community 60"
Cohesion: 0.10
Nodes (18): loadOrCreateApiToken(), ALLOWED_URL_SCHEMES, _fileLocks, fs, rateLimit(), _rlWindows, writeFileSafe(), express (+10 more)

### Community 61 - "Community 61"
Cohesion: 0.16
Nodes (19): toggleMachinePower(), triggerSync(), updatePowerButton(), updateStatus(), checkForUpdate(), showUpdateBanner(), apiFetch(), initToken() (+11 more)

### Community 62 - "Community 62"
Cohesion: 0.36
Nodes (5): calcShotScore(), _detectChanneling(), _stddev(), { calcShotScore }, require

### Community 63 - "Community 63"
Cohesion: 0.21
Nodes (12): appRepoRoot, __dirname, fmtDate(), git(), glpProjectRoot, loadPricing(), main(), PRICING_PATH (+4 more)

### Community 64 - "Community 64"
Cohesion: 0.14
Nodes (8): calcBeanRating(), calcBrewRatio(), freshnessState(), isoToGerman(), parseDMY(), roastAgeDays(), shouldShowFreshBadge(), now

### Community 65 - "Community 65"
Cohesion: 0.23
Nodes (14): closeFlavorWheel(), disposeFlavorWheel(), openFlavorWheel(), renderFlavorWheel(), toSunburstData(), FLAVOR_ALIASES, FLAVOR_WHEEL, buildIndex() (+6 more)

### Community 66 - "Community 66"
Cohesion: 0.10
Nodes (13): loadLibrary(), { BEAN_IMAGE_MAX_BYTES }, express, { imagePath, CONTENT_TYPE_EXT, deleteBeanImage, deleteImage, saveUploadedImage }, libraryService, { loadLibrary, saveLibrary }, { rateLimit }, ROAST_TYPES (+5 more)

### Community 67 - "Community 67"
Cohesion: 0.18
Nodes (11): { DATA_DIR }, Database, DB_PATH, fixSchema(), fs, initSchema(), JSON_FILES, { log } (+3 more)

### Community 68 - "Community 68"
Cohesion: 0.13
Nodes (13): Database, dataPath, dbPath, { getDb }, haPath, libraryService, memDb, realData (+5 more)

### Community 69 - "Community 69"
Cohesion: 0.18
Nodes (11): TRANSLATIONS, S, _subs, mapToXY(), scoreColor(), calcComparativeGrindAdvice(), _miniShotChart(), _parseGrindNum() (+3 more)

### Community 70 - "Community 70"
Cohesion: 0.15
Nodes (11): validate(), { ZodError }, { annotationSchema }, express, { generateShareCard, isAvailable: cardAvailable }, libraryService, { log }, { MAX_SHOT_ID } (+3 more)

### Community 71 - "Community 71"
Cohesion: 0.11
Nodes (16): DEFAULT_MENU, MAINTENANCE_DEFAULTS, STATIC_MAINTENANCE_TASKS, { getDb }, { MAINTENANCE_DEFAULTS }, { DEFAULT_MENU, ORDERS_HISTORY_TTL_MS }, { getDb }, express (+8 more)

### Community 72 - "Community 72"
Cohesion: 0.24
Nodes (9): { annotationSchema, beanSchema, orderSchema }, require, annotationSchema, beanSchema, grinderSchema, maintenanceLogSchema, orderSchema, recipeSchema (+1 more)

### Community 73 - "Community 73"
Cohesion: 0.40
Nodes (4): Claude model breakdown (by commit co-author line), Development Stats, Rough cost estimate (illustrative only — not real billing data), Timeline

### Community 75 - "Community 75"
Cohesion: 0.23
Nodes (11): deleteBeanImage(), deleteImage(), imagePath(), saveUploadedImage(), axiosGet, axiosPath, constantsPath, { fetchBeanImage, deleteBeanImage, imagePath, isAllowedImageUrl, saveUploadedImage, deleteImage } (+3 more)

### Community 76 - "Community 76"
Cohesion: 0.22
Nodes (10): ALLOWED_IMAGE_HOSTS, axios, { BEAN_IMAGE_DIR, ALLOWED_IMAGE_HOSTS, BEAN_IMAGE_MAX_BYTES }, CONTENT_TYPE_EXT, fetchBeanImage(), fs, isAllowedImageUrl(), { log } (+2 more)

### Community 78 - "Community 78"
Cohesion: 0.29
Nodes (6): Database, dbPath, { getDb }, libraryService, memDb, realDb

## Knowledge Gaps
- **713 isolated node(s):** `name`, `version`, `main`, `express`, `axios` (+708 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **7 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `calcShotScore()` connect `Community 62` to `Community 60`, `Community 69`, `Community 70`, `Community 14`?**
  _High betweenness centrality (0.083) - this node is a cross-community bridge._
- **Why does `getDb()` connect `Community 55` to `Community 67`, `Community 68`, `Community 71`, `Community 42`, `Community 77`, `Community 78`, `Community 48`, `Community 18`, `Community 20`, `Community 58`, `Community 60`?**
  _High betweenness centrality (0.040) - this node is a cross-community bridge._
- **Why does `log()` connect `Community 10` to `Community 1`, `Community 67`, `Community 70`, `Community 7`, `Community 71`, `Community 6`, `Community 42`, `Community 76`, `Community 18`, `Community 20`, `Community 56`, `Community 60`?**
  _High betweenness centrality (0.027) - this node is a cross-community bridge._
- **What connects `name`, `version`, `main` to the rest of the system?**
  _713 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.011049723756906077 - nodes in this community are weakly interconnected._
- **Should `Community 1` be split into smaller, more focused modules?**
  _Cohesion score 0.08307692307692308 - nodes in this community are weakly interconnected._
- **Should `Community 3` be split into smaller, more focused modules?**
  _Cohesion score 0.061955965181771634 - nodes in this community are weakly interconnected._