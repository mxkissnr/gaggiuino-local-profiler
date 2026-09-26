# GLP backend

This directory is the GLP backend: a single static Go binary (`net/http` +
`modernc.org/sqlite`, no CGo) that serves the REST/SSE API and embeds and
serves the SPA built from `../public-src`, bundled by
`cmd/frontend-build` (esbuild's Go API, #1033). It is the only backend —
the legacy Node.js/Express implementation (`server.js`, `lib/`, `routes/`)
was removed from the tree in 3.0.0 (#1028); its last in-tree state is
archived at tag `archive/node-backend-final` and branch
`legacy/node-backend`.

The repo-root `Dockerfile` builds this directory (esbuild SPA bundle → Go
cross-compile → Alpine runtime) for amd64, armv7 and aarch64.

## Orientation

- Entrypoint: `cmd/server/main.go` — opens the DB, loads/creates the API
  token, wires every `internal/<domain>` package's `RegisterRoutes` into
  one `net/http` handler chain (security headers → rate limiter → token
  auth), listens on port 8099.
- One package per concern under `internal/`: `shots`, `library`,
  `machines` (+ `machines/proto` for the Gaggiuino binary WS codec),
  `orders`, `maintenance`, `backup`, `importer`, `db`, `auth`,
  `ratelimit`, `sse`, `system` (status/preheat/version/demo), `ha`,
  `mqtt`, `img`, `achievements`, `netguard`, `webapp` (SPA embed + serve),
  `web` (frozen no-JS templ fallback under `/ui/`).
- Each package has a `doc.go` that is the authoritative description of what
  it does and why. The narrative below is the migration history and is
  kept as background — the `doc.go` files are current.

## Config

Runtime configuration is env vars (all optional, sensible defaults):
`GLP_PORT` (8099), `GLP_DB_PATH` (`/data/glp.db`), `GLP_TOKEN_FILE`
(`/data/api_token.txt`), `GLP_ENABLE_ORDERS`, `GLP_SYNC_INTERVAL`,
`GLP_PREHEAT_TIME`, `GLP_DEBUG_LOGGING`, `GLP_HA_URL` + `GLP_HA_TOKEN`
(standalone HA integration), `MACHINE_URL`, `GLP_RATE_LIMIT_*`. Inside the
HA add-on the Supervisor writes `/data/options.json` and those take
precedence over the env fallbacks.

The version string served from `GET /api/version` lives in
`internal/system/version.go` (`glpVersion`); it and
`internal/backup/bundle.go`'s copy must match `../config.yaml`'s canonical
`version:` — enforced by `../test/version-sync.test.js`.

## Why

Replace Node/Express + better-sqlite3 with a single static Go binary
(`net/http` + `modernc.org/sqlite`, no CGo) to eliminate the multi-arch
`better-sqlite3` rebuild pain on Home Assistant's ARM hardware, cut the
resource footprint, and remove the npm supply-chain surface.

The rollout ran in phases on a `go-migration` branch, then a dev-channel
beta, then the #977 cutover that made this the shipping image. Two
compatibility bars anchored it and still hold:

- The API contract: every endpoint keeps the paths, methods, status codes
  and response shapes `glp-integration`, `glp-lovelace-card` and
  `glp-order-card` depend on. `internal/system/openapi.yaml` (served at
  `/api/openapi.json`) is the current spec.
- The existing `/data/glp.db` SQLite file keeps opening unchanged — no
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
    webapp/                 the production frontend: the SPA from gaggiuino-local-profiler/public-src, bundled by cmd/frontend-build (esbuild's Go API, #1033) and embedded via //go:embed, served at / (Phase 1 parity round, #901 — see internal/webapp/doc.go)
  Makefile                 `make generate`/`build`/`vet`/`test`/`fmt-check` — templ codegen first, every target (Phase 2a); `make frontend` bundles the SPA into internal/webapp/dist via cmd/frontend-build (#1033)
  Dockerfile               build-only multi-arch image, native Go cross-compile (implemented, Phase 4, see "Docker")
  docker-entrypoint.sh     chown /data + drop to unprivileged `glp` user, mirrors the repo-root Node entrypoint (Phase 4)
  scripts/
    smoke-test.sh            native-binary + (GLP_SMOKE_DOCKER_IMAGE mode) Docker-image smoke test (Phase 3a, extended Phase 4)
```

This package's CI is `.github/workflows/test.yaml`'s `go-test` job (gofmt/
vet/build/`go test -race`/govulncheck/route-parity) plus that same file's
`docker-smoke` job (`needs: go-test`; multi-arch matrix build of the
repo-root Dockerfile — amd64/arm64/armv7 — plus `go/scripts/smoke-test.sh`
against the amd64 image) — both added at the #977 cutover, replacing the
now-deleted `go-build.yaml`; see "Docker" below for that history.

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

`internal/system/openapi.yaml`, served at `/api/openapi.json`, is the API
spec. External consumers (`glp-integration`, `glp-lovelace-card`,
`glp-order-card`) depend on the paths, methods, status codes and response
shapes it documents.

## Building

```
cd go
make generate   # templ codegen — required before build/vet/test, see "Frontend"
                # (needs the `templ` CLI on PATH; `make generate` auto-installs
                # it via `go install github.com/a-h/templ/cmd/templ@latest`
                # if missing — see "Frontend"'s "Codegen" section)
make frontend   # OPTIONAL: runs cmd/frontend-build (esbuild's Go API, #1033),
                # which bundles ../public-src into internal/webapp/dist for the
                # //go:embed — no npm/Vite involved. Skip it and the binary
                # embeds the committed dist/index.html placeholder instead
                # (fine for backend work; the real SPA won't be served).
go build ./...
```

## History

The Node → Go migration (phases 0–4, #901, the #977 cutover, and the
build-only Docker phase) is archived in
[`docs/history/go-migration.md`](../../docs/history/go-migration.md).
