# GLP App — Go rewrite (in progress)

This directory holds the future Go implementation of the Gaggiuino Local
Profiler backend and frontend. It exists **parallel to** the current
Express/Node app (`server.js`, `lib/`, `routes/`, `public-src/`) at the repo
root, which remains the shipping, stable implementation. Nothing under `go/`
is wired into the repo-root Docker image or the running stable/dev add-on
yet — the one exception is the standalone beta channel described in "Go
preview channel (publishing)" below.

## Status: Phase 5 in progress (go-preview beta channel — mxkissnr/glp-go-preview-app + .github/workflows/go-preview-publish.yaml, on top of Phase 4's complete build-only CI, Phase 2's complete frontend and Phase 3b's complete backend)

Phase 0 was scaffolding only. Phase 1a ported the first two foundational
packages everything else builds on. Phase 1b added a real, listening HTTP
server plus the `/api/events` SSE endpoint. Phase 1c (issue #901) ports
`routes/shots.js` — the first REST domain to go the full HTTP-request →
handler → `internal/db` → response path, establishing the pattern every
later domain package follows. Phase 1d (issue #901) ports the coffee
library domain on top of that same pattern:

- `internal/db` — real SQLite schema init + migrations on
  `modernc.org/sqlite`, verified against a fixture generated from
  `lib/db.js`'s own code (see `internal/db/doc.go`).
- `internal/auth` — real ingress-trust checks, constant-time token
  comparison, token file persistence, the security-header middleware, and
  `RequireToken`, the full API-token-auth middleware ported from
  server.js's `app.use` block (see `internal/auth/doc.go`).
- `internal/ratelimit` — the app-level rate limiter ported from
  `lib/middleware/rateLimit.js` onto `golang.org/x/time/rate`: 600 req/min
  per socket address, `/assets/*` exempt (see `internal/ratelimit/doc.go`).
- `internal/sse` — the `/api/events` Server-Sent Events endpoint ported
  from `routes/sse.js`: same headers, same 2048-byte Ingress-buffering
  padding comment, same connect-time priming, same 20s keepalive, same
  event multiplexing, plus a Go-channel pub/sub (`Hub`) domain packages
  publish onto (see `internal/sse/doc.go`).
- `internal/shots` (Phase 1c, new) — the full shot-history REST domain:
  `/shots.json`, `GET /api/shots` (keyset-paginated metadata list, no curve
  data — #957), `/api/shots/last`, `/api/shots/defaults` (GET+POST),
  `/api/shots/:id`, `/api/shots/:id/annotate`, `/api/shots/:id/{trash,
  restore,delete}`, and `/api/shots/:id/image` (GET+POST+DELETE) —
  `lib/score.js`'s scoring, `ShotService`'s annotation/trash/blocklist
  logic, and `ShotRepository`'s + `ShotDefaultsRepository`'s DB access, all
  ported. `GET /api/shots/:id/card` (share-card PNG) was ported in Phase 2f
  as an SVG template rasterised by a cgo-free resvg-wasm renderer
  (`internal/shots/card*.go`) — see `internal/shots/doc.go` for its
  deliberate cosmetic deviations, and `internal/shots/doc.go` for the
  `#450`/`#456` library-dependent scoring/notification paths still deferred
  to the not-yet-ported Library phase.
- `internal/library` (Phase 1d, new) — the full coffee-library REST domain:
  `GET /api/library` (grinders enriched with a computed `wear` field),
  `GET /api/library/beans-info`, full CRUD + bag/frozen-portion lifecycle +
  known-grind + image upload/serve for beans, full CRUD + burr-wear/reset +
  image for grinders, full CRUD + image for baskets/puck screens, full CRUD
  + stock-deduct for milks, full CRUD for recipes, and the SSRF-guarded
  `GET /api/library/scan/:barcode` Open Food Facts proxy — `LibraryService`'s
  `getBeansInfo`/`computeGrinderWearStats`/`upsertKnownGrindSetting`/
  `setBeanImage`, `LibraryRepository`'s `getLibrary`/`saveLibrary`, and
  `lib/ssrf-guard.js`'s `assertPublicHost` DNS-rebinding guard, all ported.
  Deliberately NOT ported: the five one-time `migrateX()` startup
  migrations (data already migrated on any install this binary can run
  against — none turned out to be live business logic on inspection);
  `geocodeBean` (external geocoding provider, out of this phase's scope);
  and the maintenance-domain cross-call grinder delete would otherwise make
  (`internal/maintenance` is still Phase 0) — see `internal/library/doc.go`
  for exactly what each deferral does and doesn't change, including the one
  genuine (if minor) behavior gap: deleting a grinder through the Go server
  doesn't clean up its stale `maintenance` table row the way Node does.
- `cmd/server` — `main.go` opens the DB, loads/creates the API token, and
  wires the above into a real `net/http` server listening on port 8099
  (same port as Node), with the same middleware order server.js actually
  registers (security headers → rate limiter → token auth), verified by
  manually booting the binary and curling it end-to-end (401
  unauthenticated; working `/api/events` stream and the full `/api/shots/*`
  + `/api/library/*` surface with a valid token).

- `internal/machines` (Phase 1e, new) — the full machine-registry +
  machine-control + machine-profile domain: `GET|POST /api/machines`,
  `PUT|DELETE /api/machines/:id`, `.../default`, `.../test`; the #597
  Gaggiuino settings/control proxy (`/api/machine/{settings,
  settings/save, settings/:category, opmode, tare, service-test,
  profile/save, firmware/progress, firmware/update, firmware/version,
  live}`); and the machine-profile CRUD (`GET /api/machine/profiles`,
  `POST /api/machine/profile/set`, `GET|POST|PUT|DELETE
  /api/machine/profile[/:id]`). Ports `lib/machines/registry.js`
  (`Registry`), the `adapter-base.js` contract as a real Go interface with
  two implementations (`GaggiuinoAdapter`, `GaggiMateAdapter`), and both
  machines' WebSocket clients — Gaggiuino's binary protobuf protocol
  (`internal/machines/proto`, a from-scratch hand-written wire codec since
  no `.proto` sources exist anywhere for this firmware, cross-validated
  field-for-field against `lib/gaggiuino-proto.js`'s real
  `@protobuf-ts/runtime` output) over `nhooyr.io/websocket`, plus
  GaggiMate's JSON WebSocket protocol. `live.go`'s persistent Gaggiuino WS
  session caches every live sensor/system-state push, read (not
  re-polled) by Phase 1g's `internal/system.Poller` — this phase's own
  original design had `live.go` publishing those pushes directly onto
  `internal/sse.Hub` as a stand-in `EventLiveSnapshot` producer; Phase 1g
  reconciled that into the real `lib/poll.js`-equivalent producer (see
  `internal/system/doc.go`). The Gaggiuino REST API's settings
  bool-as-string quirk (some boolean fields are JSON
  *strings* `"true"`/`"false"`, not real booleans — see
  `internal/machines/doc.go`) is preserved byte-for-byte end to end by
  treating every settings payload as opaque bytes, never a typed struct.
  Deliberately NOT ported in this phase: `GET /api/machine/status` +
  `/api/preheat*` + `/api/live/data` (all four depend on `lib/poll.js`'s
  background polling loop — `system` domain; now ported in Phase 1g); the
  default machine's on-disk profiles-cache persistence; GaggiMate's binary shot-
  history parsing; MQTT live-data transport; and backup/restore — see
  `internal/machines/doc.go` for the full list and rationale. A standalone
  CLI, `cmd/gaggiuino-ws-probe`, exists so the protobuf decoder can be
  verified against a real machine's live traffic once one is reachable
  (no network access to real hardware was available while this package
  was built).
- `cmd/gaggiuino-ws-probe` — manual verification tool for
  `internal/machines/proto`'s decoder: connects to a real machine and
  dumps every decoded WS frame, or replays one recorded hex frame offline.
  Not part of the server binary or any test suite.

- `internal/orders` (Phase 1f, new) — the full barista-orders REST domain:
  menu CRUD, orders settings, queue ETA, milk stock, order placement +
  accept/complete/decline lifecycle, notify mapping, and stats. Ports
  `OrderService.js`'s `resolveMachineId`/`resolveBeanId`/`computeQueueEta`/
  lifecycle methods and `OrderRepository.js`'s DB access. Every path
  `glp-integration`'s `orders_api.py` proxy allowlists is covered and
  contract-tested (`handlers_test.go`'s `TestProxiedPaths_Answer200`), as
  is the `X-GLP-HA-User-ID` header's precedence over both the body field
  and the `mine` endpoint's query parameter (#547). `GetActiveBeans`/
  `GetActiveMilks`/`DeductMilkByName`/`ComputeBeanRemaining` — deferred out
  of Phase 1d's scope — are now ported too, in
  `internal/library/orders_support.go`. Deliberately NOT ported: the
  shop-open/shop-closed HA-notify broadcast `POST /api/orders/settings`
  triggers (needs the default machine's live runtime state from the
  still-unported `system` domain) — settings themselves persist correctly,
  only that notification side effect is missing — see
  `internal/orders/doc.go`.
- `internal/maintenance` (Phase 1f, new) — the full maintenance-tracking
  REST domain: per-task/per-grinder due tracking with thresholds, the
  maintenance log, and the `machineId=all` aggregate view. Ports
  `LibraryService.js`'s `computeMaintenanceStats`/
  `computeAllMachinesMaintenance` and `LibraryRepository.js`'s
  maintenance-table methods, split into their own package (Node keeps them
  in the library domain's files; this rewrite doesn't). Closes a Phase 1d
  gap: deleting a grinder now also removes its `grinder_{id}` maintenance
  row, wired from `internal/library` via a callback
  (`SetOnGrinderDeleted`) rather than a direct import, since this package
  already imports `internal/library` the other way around (grinder
  existence checks, grinder names).
- `internal/backup` (Phase 1f, new) — the full backup/restore REST domain:
  `GET`/`POST /api/backup` (legacy self-contained JSON export and the zip
  export the app's UI actually uses, both with optional section scoping
  and passphrase-encrypted secrets), and `POST /api/restore` (dry-run
  preview, per-section apply, zip or legacy-JSON body). Ports
  `lib/backup-crypto.js` (AES-256-GCM-scrypt) verbatim, uses Go's stdlib
  `archive/zip` instead of porting `lib/zip.js`'s hand-rolled DEFLATE/CRC32
  implementation (no behavior difference — same ZIP format), and closes
  two more cross-domain gaps flagged deferred by earlier phases:
  `internal/machines/registry.go`'s `RestoreMachines` (flagged in
  Phase 1e) and `internal/library`'s whole-entity restore sanitizers
  (`SanitizeBeanFields` et al., flagged in Phase 1d — now in
  `internal/library/restore_sanitize.go`). **Memory (#959):** every
  export/import path streams — peak heap growth is bounded by O(one shot +
  one image + the small sections) and does not rise with the shot/image
  count (`internal/backup/memory_test.go` quadruples the dataset and
  asserts the same ceiling). The bundle JSON is written incrementally and
  parsed twice with a streaming decoder; the `POST /api/restore` and `POST
  /api/debug/import-db` request bodies go to a temp file, never a slice.
  **Remaining atomicity gap:** #959 made the structured shots restore
  (wipe + upserts + annotations + trash + blocklist + library) commit as
  one transaction, and orders restore is one tx — but atomicity *across*
  sections (a failure after the shots tx commits but during maintenance /
  machines / kv) is still not Node-identical. `routes/debug.js`'s
  `export-db`/`import-db` (raw SQLite file dump/restore) are explicitly
  NOT part of this domain (they live in `internal/debug`); `import-db` now
  streams the upload to a temp file and validates it (SQLite magic +
  `PRAGMA integrity_check` + core-table schema probe) before touching the
  live DB — a corrupt upload is a clean 400 with the live DB untouched.
  See `internal/backup/doc.go` and `internal/debug/debug.go` for the full
  reasoning.
- `internal/ha` (Phase 1f, extended in Phase 1g) — ports `lib/ha.js`:
  `SendNotify`, `GetNotifyServices`, `GetPersons` (Phase 1f, orders domain),
  plus `GetSwitchState`, `CallHaService`, `GetHaLanguage` (Phase 1g, the
  system domain's power-check/ready-by-preheat needs). Degrades to a
  no-op/empty-result (or, for `CallHaService`, an error) when no
  `SUPERVISOR_TOKEN`/`GLP_HA_URL` is configured, exactly like the Node
  original — HA integration is optional.
- `internal/system` (Phase 1g, new, #901) — the last REST domain package
  from the migration plan, plus the background polling mechanism the other
  domains depend on for live machine data: `GET /api/machine/status`,
  `GET /api/live/data`, `GET /api/preheat`, `POST /api/preheat/ready-by`,
  `GET /api/version`, `POST /api/demo/{seed,end}`, and `lib/poll.js`'s 1s
  polling loop (`checkAndApplyMachinePower`/`backgroundHaCheck`,
  `startLivePolling`/`stopLivePolling`, the `#655` `machineReachable`
  powered-off-vs-idle-but-reachable distinction) plus `lib/preheat.js`'s
  `buildPreheatResponse`/`SetReadyByTarget`/the ready-by auto turn-on
  watcher. Reconciles Phase 1e's `internal/machines/live.go`, which
  published its own WS-session-cache snapshots directly onto the SSE hub
  as a stand-in before this phase existed — that package's `live.go` no
  longer publishes directly; `internal/system`'s `Poller` is now the sole
  `live-snapshot` SSE producer, reading the same WS cache through
  `machines.Adapter`'s `GetLiveSensorSnapshot`/`GetLiveSystemState` (see
  `internal/system/doc.go`'s "Reconciling with Phase 1e's live.go"
  section). Also closes `internal/orders`' shop-open/shop-closed
  HA-notify-broadcast deferral flagged in Phase 1f, wired via a
  `PreheatInfoFunc` callback (not a direct import, which would close a
  package cycle against this domain's own still-deferred
  `_checkPreheatNotify`). Phase 3b (#901) added `GET /api/token` and
  `GET /api/status`, found missing when verifying a standalone Go backend
  against a real `glp-integration` install: `GET /api/token` is the only
  way any consumer (glp-integration's `GlpAuth`, the installable PWA) ever
  obtains a working `X-GLP-Token`, and `GET /api/status` is
  glp-integration's discovery probe and every `GlpDataCoordinator` poll's
  first call — Phase 1g's own "not required to make the endpoints above
  correct" scope cut had missed that both are load-bearing for every real
  client, not just this phase's own six endpoints. `GET /api/status`'s
  `lastSync`/`syncRetryCount`/`lastSyncError` fields stay permanently
  null/0 in this Go port, same reason as the next paragraph.
  Deliberately NOT ported: `lib/sync.js` entirely (the shot-history sync
  engine — its own future phase, and the reason for the three always-null
  fields above), `lib/connectivity-stats.js`'s debug-log summary,
  `_checkPreheatNotify` (the barista "preheat ready" push notification —
  needs a read dependency on `internal/orders`' settings this phase's
  budget didn't cover), `lib/machines/options-adoption.js`'s
  `adoptOptionChanges()` (so `GET /api/status`'s
  `legacyMachineOptionsPending` is a documented always-false stub), and a
  handful of `routes/system.js` routes not in any phase's endpoint list
  (`GET`/`POST /api/switch(/toggle)`, `POST /api/sync`,
  `GET /api/openapi.json`, `GET /api/debug/machine`) — see
  `internal/system/doc.go`'s "Scope" section for the full reasoning on
  each.
- `internal/debug` (Phase 2e, extended Phase 3) — `routes/debug.js`'s
  `GET /api/debug/export-db` / `POST /api/debug/import-db` (raw SQLite
  dump/restore, `GLP_DEV_BUILD`-gated) plus `routes/system.js`'s
  `GET /api/debug/machine`. Phase 3 (#901) adds a **Go-only** ingress
  self-check, `GET /api/debug/ingress` (+ `/sse-probe`), gated the same way
  `GET /api/debug/machine` is (`NODE_ENV !== 'production'`, behind
  `auth.RequireToken`): open it through the real HA sidebar panel and it
  reports what the add-on received from the Supervisor ingress proxy
  (source IP, `X-Ingress-Path`, `X-Forwarded-*`, the reused
  `auth.IsIngressRequest` verdict, which auth path let the request in) and
  live-probes — with `EventSource` against `/sse-probe`'s 5 staggered
  200ms ticks — whether that proxy buffers SSE, printing a green/red
  verdict. `cmd/server/smoke_test.go` covers the app side of the three
  ingress traps from a dev machine; this is the piece that can only be
  answered against a real install. Serves JSON to `Accept: application/json`
  / `?format=json`, the self-contained HTML page (inline style + a
  SHA-256-pinned inline script, no external assets) otherwise.

Every REST domain package named in the original migration plan now exists
and routes the endpoints its phase brief scoped it to, including the two
bootstrap-critical endpoints (`GET /api/token`, `GET /api/status`) Phase 1g
had originally deferred — see `internal/system/doc.go` for the small
number of `routes/system.js` routes that remain unrouted by design, none
of them depended on by anything any phase has built. `go build ./...`,
`go vet ./...`, `gofmt -l .`, and `go test ./...` (including `-race`) are
all green — the backend side of the migration plan is done.

Phase 2a (`internal/web`, new, #901) is the frontend's turn: the
templ+htmx+Alpine tooling foundation described in the "Frontend" section
below, plus one fully working page (`GET /shots`, built on
`internal/shots`' existing Phase 1c service layer) as the template every
later page follows — the same role `internal/shots` played for the REST
domain packages above. Phase 2b (#901) follows that template for the
Library domain: `GET /beans` (plus its one htmx write action,
toggle-active) and, at this phase, read-only list pages for Grinders,
Baskets, Puck Screens, Milks, and Recipes — a later pass gave every one of
these six pages a "New ..." create form too, see the "Create/Edit
follow-up pass" paragraph below — all built on `internal/library`'s
existing Repository/service functions (`ComputeGrinderWearStats`,
`ComputeBeanRemaining`, the now-exported `ToggleBeanActive`) rather than
its REST handlers. Phase 2c (#901) follows the same template for the
Machines domain: `GET /machines` (the registry list, with set-default and
delete htmx actions — the latter behind an Alpine confirm step, delete
guarded server-side by `internal/machines`'s own
`ErrCannotDeleteDefault`/`ErrCannotDeleteLastMachine`) and `GET /live`, the
live shot chart page. `GET /live` is the one page in this rewrite that
does NOT follow the templ+htmx fragment-swap pattern: pressure/flow/
weight/temperature update several times a second over SSE during a pull,
so a server round trip per animation frame is the wrong tool for that job
(see the already-agreed frontend-stack decision in "Frontend" below). Its
templ template renders only static chrome (current machine name, DOM ids
for everything else); the actual chart is `static/live.js`, a largely
unchanged, standalone port of `public-src/views/live.js`'s Chart.js
line-chart + SSE-consumption logic (see that file's own header comment for
exactly what carried over — the core chart/status-badge/preheat-widget/
readouts logic and the #655 machineReachable-wins-over-isLive precedence —
and what deliberately didn't: the reference-shot overlay, the animated
per-machine SVG icon, multi-machine live-capability gating, and i18n).
Chart.js itself is now vendored unmodified alongside htmx/Alpine
(`static/vendor/`, see that directory's NOTICE.md). Phase 2d (#901) adds
the Orders domain: `GET /orders`, the barista-facing queue (pending/accepted
orders, with accept/complete/decline htmx actions, built on
`internal/orders.Service`'s existing `AcceptOrder`/`CompleteOrder`/
`DeclineOrder`), and `GET /menu`, the customer-facing ordering form (item
select, an optional bean select sourced from `library.GetActiveBeans`, a
note field, built on `PlaceOrder`) — both pages degrade to a plain notice
instead of an error when `enable_orders` is off
(`orders.IsOrdersEnabled()`, a new exported wrapper around the same
options.json read `withOrdersGate` already used) or, for the ordering form,
when the barista's own shop-open toggle is off. Live updates originally
used htmx polling (`hx-trigger="every 10s"`, matching
`public-src/views/orders.js`'s own `setInterval(loadOrdersView, 10000)`
cadence) rather than the htmx SSE extension: evaluating that first (per the
architecture note in this phase's dispatch brief) found two concrete
blockers, not just "more scope than this package covers" — the vendored
`static/vendor/htmx-sse-ext-2.0.10.js`'s `hx-trigger="sse:*"` handling
parses the trigger but never calls `source.addEventListener` for it (dead
code in this vendored version; only its `sse-swap` mechanism is fully
wired), and `sse-swap` itself needs the SSE payload to be raw HTML while
`internal/sse.Handler`'s `send()` unconditionally `json.Marshal`s
`Event.Data` for every event on the shared `/api/events` stream (`live.js`'s
own JSON consumers depend on that encoding staying JSON). A later pass
(#901, design pass 4 follow-up) closed both: `sse.HTML` marks an event's
Data as pre-rendered HTML to send through unmarshaled (every other event
type is untouched — `live.js`'s JSON consumers keep working exactly as
before), and `#orders-queue` now uses `sse-connect="api/events"` +
`sse-swap="orders-update"` — no extension patch needed, since `sse-swap`
itself was already fully wired. `internal/orders.Service`'s new
`OnQueueChanged` callback (nil-safe, the same "callback field instead of a
direct import" seam `internal/library`'s `SetOnGrinderDeleted` already
established to avoid a package cycle) fires after every successful
`PlaceOrder`/`AcceptOrder`/`CompleteOrder`/`DeclineOrder` regardless of
caller — the REST API included, not just this page's own htmx actions —
so every open `/orders` tab updates live. See `templates/orders.templ`'s
own doc comment for the full wiring. Phase 2e (#901) closes out the frontend migration plan's
last domain gap: `GET /maintenance` (per-machine task tracking —
descaling/backflush/grouphead/gaskets/waterfilter plus one entry per
currently registered grinder — with a "mark done" htmx action built on a
new `maintenance.MarkTaskDone` service-layer function, not a duplicate of
`internal/maintenance`'s own REST `taskDone` handler's logic; that REST
handler is now a thin wrapper around the same function, closing the class
of gap Phase 2d found the hard way — see that function's own doc comment),
`GET /settings` (the default machine's Gaggiuino settings categories — at
this phase, "display" editable via a raw-JSON `<textarea>` round trip that
preserves the bool-as-string quirk byte-for-byte, the same opaque-bytes
discipline `internal/machines`' adapter layer already holds end to end,
boiler/led/scales/system read-only — a later pass changed which
categories land on which side of that line, see the "Create/Edit
follow-up pass" paragraph below — built on `machines.Adapter`'s
`GetSettings`/`UpdateSettings` via a small `AdapterProvider` interface seam
mirroring `internal/system/poll.go`'s own), and `GET /backup` (a download
link for the existing `GET /api/backup` export). Backup restore is a
deliberate, documented scope cut for this phase — no `<input type=file>`
upload UI, only a pointer at `POST /api/restore`'s JSON API — see
`handlers_backup.go`'s own doc comment for the two concrete reasons (the
endpoint's header/body shape doesn't fit a plain HTML form, and a real
restore needs a dry-run preview step to be safe to expose at all, which is
its own follow-up-sized piece of work). Every frontend domain the original
migration plan named now has a page — see "Frontend" below for the
complete list.

**Create/Edit follow-up pass (#901):** a later pass, prompted by Max
hitting a real "ich kann garnix anlegen" (I can't create anything) wall
live-testing Phase 2b/2c/2e's read-only pages, gave every Library page
(Beans, Grinders, Baskets, Puck Screens, Milks, Recipes) a "New ..."
create form and gave Machines the same, each posting straight to the
existing `internal/library.Create*`/`machines.CreateMachineChecked`
service functions (`internal/library/create.go`, `internal/machines/
create.go`) rather than reimplementing validation — still create-only,
not a full edit UI (see the Phase 2b/2c paragraphs above for the fields
each form exposes). That same pass also made all five Settings categories
editable via the raw-JSON `<textarea>` round trip. A follow-up code review
(finding #1) flagged that last change as a real safety regression:
`machines.ValidateSettingsPayload` only checks "is this valid JSON", never
field ranges/types, before forwarding straight to `adapter.UpdateSettings`
— boiler holds real hardware temperature/PID setpoints and system holds
the OTA firmware release channel, so both went back to read-only
`<pre>` blocks; display/led/scales (cosmetic/calibration-only, where a bad
value is at worst a wrong number on screen) stay editable — see
`internal/web/handlers_settings.go`'s own doc comment for the full
reasoning. A later design pass (#901, design pass 3) added Beans'/Milks'
inline stock bars, a Maintenance due/soon/ok verdict-first summary, and a
Machines default-machine status header, all built on data these pages
already fetch — no new service-layer wiring — see `internal/web/static/
style.css`'s own header comment for the exact component list.

## Why

Replace Node/Express + better-sqlite3 with a single static Go binary
(`net/http` + `modernc.org/sqlite`, no CGo) to eliminate the multi-arch
`better-sqlite3` rebuild pain on Home Assistant's ARM hardware, cut the
resource footprint, and remove the npm supply-chain surface.

This is a rollout, not a rewrite-and-flip: the plan is to ship the Go
binary first on the dev channel as an opt-in beta alongside the existing
Node image, promote it to the stable/main add-on only once it's proven
itself there, and keep Node as the fallback until then — no big-bang cutover.
Two things anchor that compatibility bar:

- `openapi.yaml` at the repo root is the frozen contract — every Go endpoint
  must match paths, methods, status codes, and response shapes exactly, so
  `glp-integration`, `glp-lovelace-card`, and `glp-order-card` don't need to
  care which binary answers a request.
- The existing `/data/glp.db` SQLite file must keep opening unchanged — no
  data migration, only schema compatibility (see `internal/db/doc.go`).

Security parity with the Node app's ingress-trust model (HA Ingress vs.
direct-port trust boundary, `X-GLP-Token` auth, SSRF guards on machine
hosts, rate limiting) is non-negotiable and must be replicated 1:1, not
approximated — see `internal/auth/doc.go`.

## Layout

```
go/
  go.mod
  README.md              — this file
  RESEARCH.md             — Phase 0 research spikes (protobuf sources, image/QR libs)
  cmd/
    server/                main.go — HTTP bootstrap: db + auth + sse + shots + library + machines + orders + maintenance + backup + system wiring
    gaggiuino-ws-probe/     manual protobuf-decoder verification tool (not part of the server binary)
  internal/
    db/                    lib/db.js — schema + migrations
    auth/                  server.js's ingress-trust + token-auth
    ratelimit/              lib/middleware/rateLimit.js — app-level rate limiter
    sse/                   routes/sse.js — /api/events (implemented, Phase 1b)
    shots/                 routes/shots.js + ShotService/ShotRepository (implemented, Phase 1c)
    library/               routes/library/*.js + LibraryService (implemented, Phase 1d)
    machines/              routes/machines.js + machine-control.js + lib/machines/* (implemented, Phase 1e)
    machines/proto/         Gaggiuino's binary protobuf schema (implemented, Phase 1e)
    orders/                routes/orders.js + OrderService (implemented, Phase 1f, extended Phase 1g)
    maintenance/           routes/maintenance.js + LibraryService/LibraryRepository's maintenance-table methods (implemented, Phase 1f)
    backup/                routes/backup.js + lib/backup-crypto.js (implemented, Phase 1f)
    ha/                    lib/ha.js — SendNotify/GetNotifyServices/GetPersons/GetSwitchState/CallHaService/GetHaLanguage (implemented, Phase 1f, extended Phase 1g)
    debug/                 routes/debug.js's export-db/import-db + /api/debug/machine + the Go-only /api/debug/ingress self-check (implemented, Phase 2e, ingress in Phase 3)
    system/                routes/system.js's token/status/live/preheat/version/demo endpoints + lib/poll.js + lib/preheat.js (implemented, Phase 1g; token/status added Phase 3b)
    web/                   templ+htmx+Alpine pages, now the frozen no-JS fallback view mounted under /ui/ (Phase 1 parity round, #901): GET /ui/shots (Phase 2a) + Library (2b) + Machines/Live (2c) + Orders/Menu (2d) + Maintenance/Settings/Backup (2e)
      templates/             .templ sources (own package — see internal/web/doc.go)
      static/                vendored htmx/Alpine/Chart.js + style.css + live.js, embedded via embed.FS
    webapp/                 the production frontend: the existing Vite SPA bundle (gaggiuino-local-profiler/public-src) embedded via //go:embed and served at / (Phase 1 parity round, #901 — see internal/webapp/doc.go)
  Makefile                 `make generate`/`build`/`vet`/`test`/`fmt-check` — templ codegen first, every target (Phase 2a); `make frontend` stages the Vite build into internal/webapp/dist (Phase 1 parity round)
  Dockerfile               build-only multi-arch image, native Go cross-compile (implemented, Phase 4, see "Docker")
  docker-entrypoint.sh     chown /data + drop to unprivileged `glp` user, mirrors the repo-root Node entrypoint (Phase 4)
  scripts/
    smoke-test.sh            native-binary + (GLP_SMOKE_DOCKER_IMAGE mode) Docker-image smoke test (Phase 3a, extended Phase 4)
```

`.github/workflows/go-build.yaml` (repo root) is this package's CI — see
"Docker" below; it's separate from the repo root's Node-app workflows.

Every backend package under `internal/` is implemented — see
`go/internal/system/doc.go` for the small, deliberate set of
`routes/system.js` routes it doesn't route. `internal/web` now covers every
frontend domain the migration plan named: Shots, the Library domain's six
pages, Machines, the live shot chart, the Orders domain's barista queue +
customer ordering form, and (Phase 2e) Maintenance's per-machine task
tracking, Settings' machine-settings categories, and a Backup download
page — see "Frontend" below for what's deliberately still read-only or
deferred within each (per-task threshold editing and the maintenance log,
and backup restore's own upload UI all stay JSON-API-only pending a
follow-up phase; all five settings categories, including boiler/system,
are now editable — see the "Status" section's "Design pass 4 follow-up"
paragraph for how that closed the safety-scoped revert instead of just
undoing it).

## Frontend

The Go rewrite's frontend stack, per the Migrationsplan's Phase 2/frontend
decision: [`templ`](https://templ.guide) (typesafe, compiled server
templates) + [htmx](https://htmx.org) (server-driven fragment swaps for
CRUD/navigation/forms, including the htmx SSE extension for non-high-
frequency live updates) + [Alpine.js](https://alpinejs.dev) (declarative
local UI interactivity — dropdowns, modals, filters — no bespoke JS for
that). The one deliberate exception, now built (Phase 2c): the live shot
chart (pressure/flow during a pull, several updates a second over SSE)
keeps a thin vanilla-JS canvas component (`static/live.js`, Chart.js under
the hood) consuming SSE directly, because server-round-tripping every
animation frame is the wrong tool for that one job — see the
Migrationsplan's frontend-stack rationale. Goal: no Node/npm anywhere in
the Docker image (build or runtime); the only external browser runtime is
htmx (~50 KB) plus Alpine (~54 KB) plus, on the one page that needs it,
Chart.js (~200 KB), all vendored locally, never loaded from a CDN.

**Phase 1 parity round (#901, in progress):** the templ pages above are
NOT the shipping UI. Re-implementing the full Vite SPA (`public-src/`) in
templ — shot charts, ECharts analytics, dial-in convergence, six-language
i18n, the annotator, achievements — is ~15-20k lines chasing a target that
keeps moving as `dev` ships, and the SPA already builds to relative-path,
REST+SSE-only assets that run behind HA Ingress unmodified. So
`internal/webapp` embeds that build output (`//go:embed all:dist`, staged
by `make frontend` or the Dockerfile's `frontend` stage) and serves it at
`/`, byte-for-byte the UI the Node app serves today, reaching frontend
parity in one step. The eleven templ pages are frozen, not deleted:
`cmd/server` mounts them under a `/ui/` prefix (via `http.StripPrefix` onto
a dedicated sub-mux) as a no-JS fallback. Their relative-path convention is
unchanged — every route simply moved one segment deeper, together. Only a
committed `internal/webapp/dist/index.html` placeholder is tracked in git,
so a bare `go build ./...` (CI's go-build.yaml test job) resolves the embed
with no npm step; the Docker image and `make frontend` supply the real
bundle.

**Status (Phase 2a-2e, #901, complete):** the tooling foundation plus every
frontend domain's pages. Phase 2a's `GET /ui/shots` is a shot-history list built on
`internal/shots`' existing Phase 1c service layer (not its REST handlers —
see `internal/web/doc.go`); it supports trashing a shot (with an Alpine
confirm step before the destructive htmx POST) and restoring one from the
trash section, plus a client-side Alpine filter over profile/coffee text.
Phase 2b adds the Library domain: `GET /beans` (with its one write action,
toggle-active, ported onto `internal/library`'s now-exported
`ToggleBeanActive`) and, at this phase, read-only list pages for Grinders
(with computed wear stats via `ComputeGrinderWearStats`), Baskets, Puck
Screens, Milks, and Recipes — a later Create/Edit follow-up pass (see the
"Status" section above) gave every one of these six pages a "New ..."
create form too; a full edit UI stays deferred. Phase 2c adds the Machines
domain: `GET /machines` (with
set-default and Alpine-confirmed delete htmx actions, built on
`internal/machines.Registry` directly) and `GET /live`, the live shot chart
— the one page that breaks from the htmx-fragment-swap pattern the other
pages establish, per the paragraph above. Phase 2d adds the Orders domain:
`GET /orders` (the barista queue, with accept/complete/decline htmx actions,
whole-queue-fragment re-renders since accepting/declining moves an order
between sections — the same convention Phase 2c's set-default action
established) and `GET /menu` (the customer ordering form, its one write
action `POST /menu/order` built on `PlaceOrder`) — `GET /orders` originally
polled (`hx-trigger="every 10s"`) rather than using either the plain
htmx-fragment pattern or Phase 2c's vanilla-JS SSE consumer, later upgraded
to real `sse-swap`-driven SSE (see the "Status" section above for the full
wiring). Phase 2e adds the last three pages: `GET /maintenance`
(per-machine task tracking, with a "mark done" htmx action built on the new
`maintenance.MarkTaskDone` service-layer function — see that function's own
doc comment for why REST handler and web page now share it rather than the
web page duplicating a private REST-handler method, the same class of gap
Phase 2d found and fixed for orders' HA-notify side effect), `GET /settings`
(the default machine's Gaggiuino settings categories, at this phase only
"display" editable via a raw-JSON `<textarea>` round trip chosen
specifically to preserve the settings bool-as-string quirk without any new
per-field parsing logic — the Create/Edit follow-up pass above widened
this to display/led/scales, after a security-motivated revert took boiler/
system back out), and `GET /backup` (a download link only; restore stays
JSON-API-only, a documented scope cut — see `handlers_backup.go`'s doc
comment). Together Phase 2a/2b's pages are the *template* every later page
follows, the same role `internal/shots` played for the REST domain
packages; `public-src/`'s Node-served SPA remains the only frontend Home
Assistant or a standalone install actually sees until a later phase flips
that switch — none of Phase 2a-2e is itself a cutover, only the frontend
migration plan's page-by-page groundwork for one.

**Design pass 4 (#901):** live testing in HA (screenshot comparison against
the Node app) found two structural mismatches design passes 1-3's visual-
polish work hadn't touched: `templates/layout.templ`'s original flat
top-tab menu is now a fixed left icon sidebar (see that file's own doc
comment for exactly which Node file the icon glyphs/visual language is and
isn't ported from), and `GET /shots` is now a master-detail view — a
compact left-column list (score, coffee-or-profile name, dose, star
rating, date, a delete-icon button) beside a right-column detail panel for
the selected shot (score + a single-shot dial-in-advice verdict line via
the new `internal/shots.ComputeGrindAdvice`/`ComputeShotMetrics`, a dose to
yield/ratio/duration Metrics Grid, the bean/grinder/grind-setting line, the
shot photo, and a static post-shot Chart.js chart — `static/shot-chart.js`,
fetching `GET /api/shots/{id}` directly rather than duplicating that
endpoint's data server-side). Selecting a row is a plain htmx fragment
swap (`GET /shots/{id}`, new) into `#shot-detail`, the same pattern every
other Phase-2 write action already established.

**Design pass 4 follow-up (#901):** a later round closed every item design
pass 4 itself had deferred for needing the full shot list/history rather
than just one shot. `internal/web/handlers_library.go`/
`handlers_machines.go` gained a full inline Edit UI for every Library
entity (Beans/Grinders/Baskets/Puck Screens/Milks/Recipes) and Machines —
an Edit button swaps a row for a pre-filled htmx form (`GET
/{kind}/{id}/edit`), Save persists via new `internal/library.UpdateX`/
`machines.UpdateMachineChecked` functions (`internal/library/update.go`,
`internal/machines/update.go` — extracted from what were the REST PUT
handlers' own inline field-patch logic, the same "one service function,
called from both REST and web" convention `CreateBean` et al. already
established for POST), and Cancel swaps back to the view row (`GET
/{kind}/{id}`) — still create-and-edit, no delete UI added for Library
entities (Machines already had one). `templates/shots.templ`'s list rows
gained freshness/firmware/"ordered by" badges (`internal/web/view.go`'s
`freshnessDays`/`orderedByLabel`/`firmwareVersion`, reading
`annotation.beanAgeDays`/`glpFirmwareVersion`/`annotation.orderedBy` —
display-only pass-throughs of data other layers already write, not new
business logic). `templates/settings.templ`'s boiler/system categories are
editable again, this time with real field-level validation
(`internal/machines/settings_validation.go`'s `ValidateBoilerSettings`/
`ValidateSystemSettings`, sourced from the official Gaggiuino REST API
docs) closing the code-review finding that had reverted them to read-only,
instead of just re-reverting it. `templates/orders.templ`'s barista queue
dropped its 10s poll for real SSE: `internal/sse.HTML`
(`internal/sse/sse.go`) lets an event's Data be pre-rendered HTML sent
through `Handler`'s `send()` unmarshaled instead of always
`json.Marshal`ed, and `internal/orders.Service`'s new `OnQueueChanged`
callback (fired after every `PlaceOrder`/`AcceptOrder`/`CompleteOrder`/
`DeclineOrder`, REST API included) renders and publishes the queue
fragment as an `orders-update` event `#orders-queue`'s `sse-swap` picks up
— no extension patch needed, `sse-swap` (unlike `hx-trigger="sse:*"`) was
already fully wired in the vendored `htmx-sse-ext-2.0.10.js`. And
`templates/shots_detail.templ` gained everything design pass 4 itself
deferred: a score-delta chip and a same-profile ghost-curve overlay (both
via `shots.Service.GetPreviousByProfile`, which already existed from an
earlier phase), a comparative grind-advice panel
(`internal/shots.ComputeComparativeGrindAdvice`, a new port of
`calcComparativeGrindAdvice` — "which grind setting scores best among this
shot's comparable siblings", grouped by bean/grinder/profile/dose), and a
real A/B compare mode (a "Compare with…" `<select>` driving `GET
/shots/{id}?compare={id2}`, rendering `ShotCompareFragment` — both shots'
verdict/metrics side by side, one shared chart with both curves drawn by
`static/shot-chart.js`'s extended `buildDatasets`, matching
`public-src/views/shots/index.js`'s exact per-series colors/dash-patterns/
opacities for the solid-A/dashed-B/dashed-ghost three-layer styling).

One known gap remains, not attempted this round: neither the web UI's new
Edit forms nor `internal/machines/settings_validation.go` close the
REST API's own equivalent gap (`internal/machines.ValidateSettingsPayload`
stays the same opaque "is this JSON" check for every REST caller,
boiler/system included) — extending that hardening to the REST surface
too is its own dedicated pass, deliberately not bundled into a frontend-UI
round.

**Codegen:** `.templ` sources live under `internal/web/templates/` and are
NOT valid Go until `templ generate` runs, which writes a `_templ.go` next
to each `.templ` file. Those generated files are git-ignored (see the
repo-root `.gitignore`'s `gaggiuino-local-profiler/go/**/*_templ.go` entry)
— run codegen before building/testing.

`templ generate` is a separate CLI binary, not something `go.mod`/`go.sum`
pull in on their own (those only give you the `github.com/a-h/templ`
*runtime library* `internal/web/templates` imports, not the codegen tool).
Install it once per machine/CI runner before running `make generate` or
`go generate ./...`:

```
go install github.com/a-h/templ/cmd/templ@latest
```

(`$(go env GOPATH)/bin` — where that installs `templ` — needs to be on
`PATH`, same as any other `go install`ed tool.) Without this step, `make
generate`/`go generate ./...` fails with `templ: command not found` even
though `go.mod`/`go.sum` look complete. `go/Makefile`'s `generate` target
also auto-installs `templ` via the same command if it isn't already on
`PATH`, so this manual step is a fallback for anyone invoking `templ`
directly rather than through `make`.

```
cd go
make generate   # or: go generate ./...
go build ./...
```

`make build`/`make vet`/`make test`/`make fmt-check` (see `go/Makefile`)
all run `generate` first automatically, so CI or a fresh checkout never
needs a separate manual step.

**Assets:** `internal/web/static/` holds the vendored, unmodified htmx +
htmx-SSE-extension + Alpine files (see
`internal/web/static/vendor/NOTICE.md` for exact versions/licenses/sources)
plus `style.css` and `glp-token.js` (first-party, see "Auth model" below),
all embedded into the binary via `embed.FS` (`internal/web/assets.go`) and
served at `/web/static/*` — no separate asset directory needs to ship
alongside the binary at runtime. Alpine is vendored as `@alpinejs/csp`, not
plain `alpinejs`: core Alpine's expression evaluator needs `script-src
'unsafe-eval'`, which `internal/auth.SecurityHeaders`'s CSP intentionally
doesn't grant — see that NOTICE.md for the full reasoning.

**Auth model:** `GET /shots` (and `/web/static/*`) are registered outside
`/api/`, so they fall through `internal/auth.RequireToken`'s bypass for
non-API GET/HEAD requests — the same trust boundary `public-src/`'s static
HTML/JS/CSS already relies on today (HA Ingress's own auth, or LAN/port
access in standalone mode), not a new session/cookie scheme. The two htmx
write actions (`POST /shots/{id}/trash`, `POST /shots/{id}/restore`) do
NOT get that bypass — `RequireToken` scopes it to GET/HEAD specifically (a
#901 code-review fix; it originally matched any non-`/api/` path
regardless of method, which let any page in the user's browser trigger
these writes with a plain unauthenticated POST — a CSRF hole), so they
require the same `X-GLP-Token`/Ingress trust the JSON API does.

That header is wired into htmx structurally, not per button:
`templates/layout.templ` loads `static/glp-token.js` once, globally, for
every current and future Phase-2 page. It fetches the token from the
already-public `GET /api/token` (mirroring `public-src/api.js`'s
`initToken()` for the existing SPA) and attaches it as `X-GLP-Token` to
every htmx request via htmx's `htmx:configRequest` event — no per-page
wiring, no SSR-embedded token in `GET /shots`' own (deliberately
unauthenticated) HTML. See `internal/web/doc.go`'s "Auth model" section and
`glp-token.js`'s own doc comment for the full reasoning, including why
fetch-and-attach was chosen over an SSR meta tag. The fetch itself is
relative (`api/token`, not `/api/token`) — a #901 code-review fix, mirroring
`public-src/api.js`'s `initToken()` — so it resolves correctly against the
HA Ingress-prefixed page URL and reaches the add-on's own handler on the
primary access path; a root-absolute fetch would resolve against the
origin root instead and miss it. Standalone mode with `expose_api_port`
explicitly set to `false` still 401s a non-Ingress Trash/Restore click —
`GET /api/token` itself refuses that caller — but that's the same
`isApiPortBlocked()` state the SPA already surfaces today, not a new gap,
and it's the only caller this fetch is expected to fail for.

## Contract

`openapi.yaml` at the repo root (kept in sync with the Node app's actual
routes as of this package's creation) is the frozen reference contract for
this rewrite — every Go endpoint must match it exactly (paths, methods,
status codes, response shapes) before it's considered done, verified via
contract tests against recorded Node traffic (Phase 0/1, not yet built).

## Building

```
cd go
make generate   # templ codegen — required before build/vet/test, see "Frontend"
                # (needs the `templ` CLI on PATH; `make generate` auto-installs
                # it via `go install github.com/a-h/templ/cmd/templ@latest`
                # if missing — see "Frontend"'s "Codegen" section)
make frontend   # OPTIONAL: `npm ci && npm run build` at the repo root, staged
                # into internal/webapp/dist for the //go:embed. Skip it and the
                # binary embeds the committed dist/index.html placeholder
                # instead (fine for backend work; the real SPA won't be served).
go build ./...
```

## Docker (#901 Phase 4, build-only — no release channel yet)

`go/Dockerfile` and `.github/workflows/go-build.yaml` (repo root) exist so
this binary's containerization is proven ahead of time, not so it ships:
neither is wired into any real install, dev channel, or registry push yet —
that's Phase 5, still undecided (see the top of this file and the "Why"
section above). The repo-root `Dockerfile`/`config.yaml`/`build.yaml`/
`docker-entrypoint.sh` and `.github/workflows/{build,build-dev}.yaml` are
the Node app's unchanged release pipeline and are untouched by any of this.

**Image:** two build stages instead of the Node Dockerfile's three — a
`frontend` stage (`npm ci && npm run build`, host-platform only, output
staged into `internal/webapp/dist` for the `//go:embed`; added in the
Phase 1 parity round) and the Go builder. No npm prod-dependency stage and
no `better-sqlite3` native module to rebuild per target arch, since
`modernc.org/sqlite` is pure Go (no CGo) and every template/static/SPA
asset is compiled into the binary via `embed.FS` (see
`internal/web/assets.go`, `internal/webapp/assets.go`). The build context
is `gaggiuino-local-profiler/` (not `go/`) so the frontend stage can reach
`public-src/`. Runtime is Alpine (`alpine:3.22`), not
scratch/distroless: those have no shell, so they can't keep the Node
image's chown-`/data`-then-run-unprivileged entrypoint pattern
(`docker-entrypoint.sh`, ported almost verbatim from the repo-root one,
just for `su-exec`/the `glp` user instead of `gosu`/`node`) — see the
Dockerfile's own top-of-file comment for the full reasoning, including why
Alpine's tiny `apk add` is the one place a few seconds of QEMU emulation
can still happen (see "Multi-arch" below). `HEALTHCHECK` hits `/`, which
serves `internal/webapp`'s SPA shell — always 200 without a token
(`auth.RequireToken`'s GET/HEAD static bypass), matching the Node
healthcheck's actual intent (proving the HTTP server answers) without
depending on DB/auth state. `/data` is created and chowned to `glp` at build time too,
so the image also runs standalone without an explicit `-v` (Supervisor
always provides the real mount; `docker-entrypoint.sh`'s own `chown -R`
still re-fixes ownership for that case, whose host-side UID isn't known at
build time). Verified locally: **25.1 MB** built image (`docker build`,
`docker run`, curl against every domain, healthy `HEALTHCHECK` — see
"Local verification" below for exact numbers and reasoning), versus the
Node image's multi-hundred-MB `node:22-slim`-based one.

**Multi-arch:** native Go cross-compilation (`GOOS`/`GOARCH`/`GOARM`), not
QEMU emulation, for the expensive step — the central speed win this phase
exists to prove. `go/Dockerfile`'s builder stage is pinned
`FROM --platform=$BUILDPLATFORM golang:1.25-alpine`, so it always runs on
the CI runner's own amd64 regardless of which target platform buildx is
assembling; `go build` cross-compiles the actual target binary without
ever executing target-arch code. Verified locally with a real
`docker buildx build --platform linux/arm64,linux/arm/v7` (binfmt/QEMU
registered via `tonistiigi/binfmt` for the exercise): the build log's own
step names it `linux/amd64->arm64 builder`/`linux/amd64->arm/v7 builder`,
confirming the compile itself ran natively. This has no equivalent to the
Node image's actual pain point (rebuilding `better-sqlite3`'s C++ addon
from source under QEMU for non-amd64 — see the repo-root Dockerfile's
`prod-deps` stage comment) at all, since there's no native module here.
The one place emulation is still needed: the runtime stage's `apk add`
(three tiny prebuilt Alpine packages) executes target-arch code to install,
which — unlike a C++ compile — costs a few seconds, not minutes; the CI
workflow keeps `docker/setup-qemu-action` scoped to exactly that, with a
comment on the step explaining it's not needed for (and not used by) the Go
build itself.

**CI (`.github/workflows/go-build.yaml`):** triggers on push to
`go-migration` (paths-scoped to `gaggiuino-local-profiler/go/**` and the
workflow file itself) plus `workflow_dispatch`, separate from `build.yaml`/
`build-dev.yaml` since there's no Go release channel to trigger on
`release: published` or push-to-`dev` yet. Two jobs: `test` (`go build`,
`go vet`, `go test -race`, `gofmt -l .`, working-directory
`gaggiuino-local-profiler/go`, mirroring this section's own gates) gates
`docker` (the amd64/arm64/armv7 build matrix above, `push: false`, no
registry login step exists in the job at all). Only the amd64 image is
`load: true`d into the runner's own Docker daemon and smoke-tested — that's
the only arch this runner can actually *run* a container from without
QEMU-emulating execution (not just a package install); arm64/armv7 stay
build-verified only (a full behavioral test under emulated execution
defeats the point of avoiding QEMU and adds nothing `go build`/`go vet`/
`go test -race` for that `GOARCH` didn't already prove).

**Smoke test:** `go/scripts/smoke-test.sh` — the same script Phase 3a
built for the native binary — gained a `GLP_SMOKE_DOCKER_IMAGE` mode: when
set, every assertion (auth, all seven REST domains, SSE priming/padding,
all three cross-domain scenarios including the direct-SQLite-file
maintenance-row check and the two-instance backup/restore round trip) runs
against real `docker run` containers from that image tag instead of two
native processes, proving the whole container — entrypoint, privilege
drop, `embed.FS` static assets, port, healthcheck — works end to end, not
just the Go code in isolation. Container `/data` is left as the
container's own ephemeral writable layer (no bind mount); the token file
and SQLite DB (including its `-wal`/`-shm` siblings, needed for a
consistent read — a single-file `docker cp` would risk missing
not-yet-checkpointed commits) are pulled out via `docker cp` instead,
so this never depends on the container's UID (1000, `glp`) matching
whatever UID the host or CI runner happens to use.

**Local verification (this phase):** `docker build` (image, 25.1 MB),
manual `docker run` both with and without a bind-mounted `/data` (both
work — see "Image" above), `HEALTHCHECK` observed transitioning to
`healthy`, then the full `GLP_SMOKE_DOCKER_IMAGE` smoke-test run — **30
passed, 0 failed**, identical to the native-binary run's own 30/0. A real
`docker buildx build --platform linux/arm64,linux/arm/v7` (see "Multi-arch"
above) also completed successfully for both non-amd64 targets.

## Go preview channel (publishing, #901 Phase 5)

A third, independent Home Assistant app channel — separate from both the
stable app and the Node dev channel (`glp-dev-app`) — so the Go rewrite can
be beta-tested on a real HA instance without waiting for the still-
undecided full cutover. This is exactly the "ship the Go binary first on
the dev channel as an opt-in beta" rollout the "Why" section above
describes, now underway.

**Manifest repository:** [`mxkissnr/glp-go-preview-app`](https://github.com/mxkissnr/glp-go-preview-app)
(same reason the manifest lives outside this repo as `glp-dev-app` does —
see `build-dev.yaml`'s own header comment: Home Assistant shows every app
in a repository's root to everyone who has added that repository, so a
separate repository keeps this invisible unless deliberately added). Slug
`glp_go_preview`, host port 8097 (stable=8099, Node dev=8098), sidebar
"GLP Go" with its own icon so all three channels are visually distinguishable.
Its `options`/`schema` mirror this app's own `config.yaml` exactly —
`internal/system/options.go` reads `/data/options.json` with the same keys
Node's `lib/data.js` `loadOptions()` does, so the Configuration tab behaves
identically. `hassio_api`/`services: - mqtt:want` are deliberately not
requested there — `lib/mqtt-discovery.js` has no Go port yet.

**Publish workflow:** `.github/workflows/go-preview-publish.yaml` (repo
root) — triggers on push to `go-migration` (paths-scoped to
`gaggiuino-local-profiler/go/**` and the workflow file itself, same scoping
as `go-build.yaml`) plus `workflow_dispatch`. Separate from `go-build.yaml`,
which stays build-only CI (`push: false`, no registry login) and gates
nothing here directly — this workflow re-runs the same `test` job (`go
build`/`go vet`/`go test -race`/`gofmt -l .`) itself so a broken push can
never reach the registry-push jobs regardless of `go-build.yaml`'s own run.
Once `test` passes: `build-amd64` and `build-other-archs` (armv7, aarch64 —
note the HA/ghcr.io arch names, not `go-build.yaml`'s CI-internal `arm64`
label) push real multi-arch images to
`ghcr.io/mxkissnr/gaggiuino-local-profiler/{arch}` tagged
`go-preview-YYYYMMDD_HHMM` plus a floating `:go-preview` tag — the same
registry repository the stable/dev images already live in, just a
different tag scheme, exactly like the Node dev channel's `:dev` tag. Both
build jobs pass that same version string as the `GLP_DEV_BUILD` build-arg
(go/Dockerfile's own `ARG`/`ENV` pair, mirroring the repo-root Node
Dockerfile's identical pattern), so `internal/system/version.go` suppresses
the GitHub-release "update available" check for this channel (an
experimental build's version string would otherwise always compare as
"behind" the stable release tag) and `GET /api/status`'s `devBuild` field
is populated for the frontend, same as the Node dev channel's own badge.
`publish-manifest` then (gated on `build-amd64` only, same `#705` trade-off
`build-dev.yaml` accepts for its own two occasional-testing architectures)
bumps `glp-go-preview-app`'s `config.yaml` version, re-syncs its
`options`/`schema` from this app's own `config.yaml` via the existing
`scripts/sync-dev-config.mjs` (generic over any two `config.yaml` paths,
reused as-is — no Go-specific version of that script exists or is needed),
copies `go/apparmor.txt` over the manifest's copy, and prepends a
`CHANGELOG.md` entry, committing and pushing straight to
`glp-go-preview-app`'s `main` branch.

**`go/apparmor.txt`** (this directory) is the source of truth the publish
workflow copies from — adapted, not copied verbatim, from the repo-root
(Node) `apparmor.txt`: alpine base instead of `node:22-slim`, `su-exec`
instead of `gosu` (path `/sbin/su-exec`), no `/app` directory (`embed.FS`
ships every template/static asset inside the single `glp-server` binary),
no native-addon/font paths (no CGo, no `@napi-rs/canvas` port), and no
MQTT-specific network reasoning (no `lib/mqtt-discovery.js` port). Same
broad `file,`-rule strategy and privilege-drop capability set as the Node
profile — see the file's own header comment for the full reasoning. Its
declared profile name (`glp_go_preview`) deliberately differs from the
Node profile's own (`gaggiuino_local_profiler`, reused unchanged by
`glp-dev-app` today) so the three channels never share one kernel-loaded
AppArmor profile identity, even though today's rule bodies happen to be
functionally equivalent.

**Not live yet:** `publish-manifest`'s checkout-and-push step needs
`secrets.GO_PREVIEW_ADDON_REPO_TOKEN` — a GitHub PAT with `contents: write`
scope on `mxkissnr/glp-go-preview-app` only — configured as a repository
secret on `mxkissnr/gaggiuino-local-profiler` (Settings → Secrets and
variables → Actions → New repository secret, name
`GO_PREVIEW_ADDON_REPO_TOKEN`). This is deliberately a separate secret from
`secrets.DEV_ADDON_REPO_TOKEN` (the Node dev channel's own PAT, scoped only
to `glp-dev-app`) so the two beta channels' write access never overlaps.
Until that secret exists, `go-preview-publish.yaml` will build and push
images successfully but fail at the `publish-manifest` job's checkout step
— the images land in `ghcr.io` either way, only the manifest repo's
`version` bump (and therefore the HA update banner) won't happen. Nobody
but Max can create this PAT or add it as a secret; no agent has the
GitHub account access required.
