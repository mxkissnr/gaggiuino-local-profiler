# Graph Report - gaggiuino-local-profiler  (2026-06-27)

## Corpus Check
- 86 files · ~94,867 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1092 nodes · 2028 edges · 53 communities (46 shown, 7 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS · INFERRED: 2 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `a1da3ed2`
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
- [[_COMMUNITY_Community 12|Community 12]]
- [[_COMMUNITY_Community 14|Community 14]]
- [[_COMMUNITY_Community 15|Community 15]]
- [[_COMMUNITY_Community 16|Community 16]]
- [[_COMMUNITY_Community 17|Community 17]]
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
- [[_COMMUNITY_Community 53|Community 53]]
- [[_COMMUNITY_Community 54|Community 54]]
- [[_COMMUNITY_Community 55|Community 55]]
- [[_COMMUNITY_Community 56|Community 56]]

## God Nodes (most connected - your core abstractions)
1. `t()` - 83 edges
2. `apiFetch()` - 59 edges
3. `getDb()` - 44 edges
4. `log()` - 34 edges
5. `Session 14:02` - 25 edges
6. `updateView()` - 23 edges
7. `S` - 19 edges
8. `loadOptions()` - 18 edges
9. `loadOrdersView()` - 18 edges
10. `Gaggiuino Local Profiler` - 17 edges

## Surprising Connections (you probably didn't know these)
- `shotToCSVRow()` --calls--> `avg()`  [INFERRED]
  gaggiuino-local-profiler/public-src/views/shots/index.js → gaggiuino-local-profiler/lib/card.js
- `updateView()` --calls--> `avg()`  [INFERRED]
  gaggiuino-local-profiler/public-src/views/shots/index.js → gaggiuino-local-profiler/lib/card.js
- `loadData()` --calls--> `renderSidebar()`  [EXTRACTED]
  gaggiuino-local-profiler/public-src/views/shots/index.js → gaggiuino-local-profiler/public-src/components/sidebar.js
- `loadData()` --calls--> `apiFetch()`  [EXTRACTED]
  gaggiuino-local-profiler/public-src/views/shots/index.js → gaggiuino-local-profiler/public-src/api.js
- `loadTrashData()` --calls--> `apiFetch()`  [EXTRACTED]
  gaggiuino-local-profiler/public-src/views/shots/index.js → gaggiuino-local-profiler/public-src/api.js

## Import Cycles
- None detected.

## Communities (53 total, 7 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.01
Nodes (180): 1.0.0, 1.10.0, 1.10.1, 1.10.2, 1.11.0, 1.11.1, 1.12.0, 1.13.0 (+172 more)

### Community 1 - "Community 1"
Cohesion: 0.08
Nodes (19): loadMenu(), axios, callHaService(), getHaPersons(), getNotifyServices(), getSwitchState(), { HA_API, HA_TOKEN }, { log } (+11 more)

### Community 2 - "Community 2"
Cohesion: 0.06
Nodes (36): avg(), detectPreinfusionEnd(), F(), fmtDur(), fmtDurSec(), fs, generateShareCard(), getGlpIcon() (+28 more)

### Community 3 - "Community 3"
Cohesion: 0.10
Nodes (48): goToShot(), switchMode(), addRecipeStep(), BREW_METHOD_LABELS, closeBeanForm(), closeGrinderForm(), closeMilkForm(), closeNewBagForm() (+40 more)

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
Cohesion: 0.23
Nodes (17): scoreClass(), buildBeanStats(), buildCalendar(), buildDistribution(), _buildDoseDist(), buildGrinderStats(), buildPersonalBests(), buildProfileChart() (+9 more)

### Community 10 - "Community 10"
Cohesion: 0.12
Nodes (32): getMachineBaseUrl(), getSyncIntervalMs(), isOrdersEnabled(), loadOptions(), log(), axios, backgroundHaCheck(), checkAndApplyMachinePower() (+24 more)

### Community 14 - "Community 14"
Cohesion: 0.12
Nodes (14): _fileLocks, fs, rateLimit(), _rlWindows, express, { getDb }, { GLP_VERSION, MAX_SHOT_ID }, libService (+6 more)

### Community 15 - "Community 15"
Cohesion: 0.10
Nodes (19): API-Endpunkte (intern), Beispiel, Berechnungsfaktoren, Datenspeicherung, Extraction Yield (EY), Funktionen, Gaggiuino Local Profiler, Konfiguration (+11 more)

### Community 16 - "Community 16"
Cohesion: 0.11
Nodes (18): ALERTua/hass-gaggiuino compatibility, API spec, API token, Architecture — how the components work together, Barcode and QR scanner, Configuration options, Features, Gaggiuino Local Profiler (+10 more)

### Community 17 - "Community 17"
Cohesion: 0.11
Nodes (18): API-Spec, API-Token, Architektur — wie die Komponenten zusammenspielen, Barcode- und QR-Scanner, Features, Gaggiuino Local Profiler, GLP App (dieses Repo), GLP HA-Integration (+10 more)

### Community 19 - "Community 19"
Cohesion: 0.09
Nodes (7): getDb(), LibraryRepository, OrderRepository, { getDb }, _hydrate(), ShotRepository, { TRASH_TTL_MS }

### Community 20 - "Community 20"
Cohesion: 0.09
Nodes (18): app, crypto, { errorHandler }, express, { fetchMachineVersion, checkAndApplyMachinePower, backgroundHaCheck }, fs, { getDb }, { GLP_VERSION, DEFAULT_PORT, DATA_DIR, TOKEN_FILE, HA_INGRESS_PATH } (+10 more)

### Community 21 - "Community 21"
Cohesion: 0.17
Nodes (12): [1.88.0] – 2026-06-26, [1.89.0] – 2026-06-26, [1.90.0] – 2026-06-26, [1.91.0] – 2026-06-26, [1.92.0] – 2026-06-27, Added, Added, Added (+4 more)

### Community 22 - "Community 22"
Cohesion: 0.13
Nodes (13): CLAUDE.md — Gaggiuino Local Profiler, Commits, GitHub project, Key conventions, Language rules, Repo structure, Versioning, Workflow (+5 more)

### Community 23 - "Community 23"
Cohesion: 0.12
Nodes (16): [1.88.1] – 2026-06-26, [1.89.1] – 2026-06-26, [1.90.1] – 2026-06-26, [1.90.2] – 2026-06-26, [1.90.3] – 2026-06-26, [1.90.4] – 2026-06-26, [1.91.1] – 2026-06-26, [1.92.1] – 2026-06-27 (+8 more)

### Community 24 - "Community 24"
Cohesion: 0.09
Nodes (22): allowScripts, better-sqlite3@12.11.1, esbuild@0.25.12, dependencies, axios, better-sqlite3, cheerio, express (+14 more)

### Community 25 - "Community 25"
Cohesion: 0.14
Nodes (13): Acknowledgements, 🏗️ Architecture, 🔗 Component Compatibility, ⚙️ Configuration, 🏠 Embed in HA Dashboard, ✨ Features, 🚀 Installation, License (+5 more)

### Community 26 - "Community 26"
Cohesion: 0.06
Nodes (79): closeSidebar(), collapseSidebarOnMobile(), filterShots(), _flapFlip(), openSidebar(), renderSidebar(), selectShot(), setSortMode() (+71 more)

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

### Community 40 - "Community 40"
Cohesion: 0.13
Nodes (30): checkForUpdate(), showUpdateBanner(), apiFetch(), loadDrinkMenu(), loadMilkTypes(), permanentDeleteShot(), acceptOrder(), addOrderMenuItem() (+22 more)

### Community 42 - "Community 42"
Cohesion: 0.07
Nodes (32): fs, { getDb }, libService, loadAnnotations(), loadLibrary(), loadNotifyMapping(), loadOrders(), loadTrash() (+24 more)

### Community 43 - "Community 43"
Cohesion: 0.08
Nodes (25): 14:05, 14:11, 14:12, 14:12, 14:14, 14:15, 14:17, 14:18 (+17 more)

### Community 47 - "Community 47"
Cohesion: 0.30
Nodes (13): _applyRefDatasets(), autoApplyRefShot(), clearReferenceShot(), connectLiveStream(), disconnectLiveStream(), fetchLiveData(), fetchPreheatData(), handleLiveData() (+5 more)

### Community 48 - "Community 48"
Cohesion: 0.11
Nodes (17): ALLOWED_IMPORT_HOSTS, ALLOWED_URL_SCHEMES, DEFAULT_MENU, MAINTENANCE_DEFAULTS, { getDb }, { MAINTENANCE_DEFAULTS }, { DEFAULT_MENU, ORDERS_HISTORY_TTL_MS }, { getDb } (+9 more)

### Community 49 - "Community 49"
Cohesion: 0.70
Nodes (4): toggleMachinePower(), triggerSync(), updatePowerButton(), updateStatus()

### Community 50 - "Community 50"
Cohesion: 0.14
Nodes (26): applyTranslations(), setLang(), t(), exportProfile(), loadData(), restoreFromFile(), restoreShot(), renderDialin() (+18 more)

### Community 51 - "Community 51"
Cohesion: 0.33
Nodes (6): 20:51, 20:52, 20:58, 20:59, 20:59, Session 20:50

### Community 53 - "Community 53"
Cohesion: 0.50
Nodes (4): 09:56, 10:00, 10:14, Session 09:56

### Community 54 - "Community 54"
Cohesion: 0.50
Nodes (4): 20:41, 20:42, 20:43, Session 20:40

### Community 55 - "Community 55"
Cohesion: 0.20
Nodes (10): { DATA_DIR }, Database, DB_PATH, fixSchema(), fs, JSON_FILES, { log }, migrate() (+2 more)

### Community 56 - "Community 56"
Cohesion: 0.22
Nodes (8): STATIC_MAINTENANCE_TASKS, getMachineUrl(), express, libraryService, { loadOptions, getMachineUrl }, machineHostname(), router, { STATIC_MAINTENANCE_TASKS }

## Knowledge Gaps
- **563 isolated node(s):** `Fixed`, `Fixed`, `Added`, `Fixed`, `Fixed` (+558 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **7 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `calcShotScore()` connect `Community 2` to `Community 48`, `Community 26`?**
  _High betweenness centrality (0.071) - this node is a cross-community bridge._
- **Why does `log()` connect `Community 10` to `Community 1`, `Community 2`, `Community 6`, `Community 7`, `Community 42`, `Community 14`, `Community 48`, `Community 20`, `Community 55`, `Community 56`?**
  _High betweenness centrality (0.034) - this node is a cross-community bridge._
- **Why does `getDb()` connect `Community 19` to `Community 42`, `Community 14`, `Community 48`, `Community 20`, `Community 55`, `Community 56`?**
  _High betweenness centrality (0.030) - this node is a cross-community bridge._
- **What connects `Fixed`, `Fixed`, `Added` to the rest of the system?**
  _563 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.011049723756906077 - nodes in this community are weakly interconnected._
- **Should `Community 1` be split into smaller, more focused modules?**
  _Cohesion score 0.07977207977207977 - nodes in this community are weakly interconnected._
- **Should `Community 2` be split into smaller, more focused modules?**
  _Cohesion score 0.06086956521739131 - nodes in this community are weakly interconnected._