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
  `mqtt`, `img`, `achievements`, `netguard`, `webapp` (SPA embed + serve).
- Each package has a `doc.go` that is the authoritative description of what
  it does and why. The Node → Go migration history lives in
  [`docs/history/go-migration.md`](../../docs/history/go-migration.md).

## Config

Runtime configuration is env vars (all optional, sensible defaults):
`GLP_PORT` (8099), `GLP_DB_PATH` (`/data/glp.db`), `GLP_TOKEN_FILE`
(`/data/api_token.txt`), `GLP_ENABLE_ORDERS`, `GLP_SYNC_INTERVAL`,
`GLP_PREHEAT_TIME`, `GLP_DEBUG_LOGGING`, `GLP_HA_URL` + `GLP_HA_TOKEN`
(standalone HA integration), `MACHINE_URL`, `GLP_RATE_LIMIT_*`. Inside the
HA app the Supervisor writes `/data/options.json` and those take
precedence over the env fallbacks.

The version string served from `GET /api/version` lives in
`internal/system/version.go` (`glpVersion`); it and
`internal/backup/bundle.go`'s copy must match `../config.yaml`'s canonical
`version:` — enforced by `../test/version-sync.test.ts`.

## Why

Replace Node/Express + better-sqlite3 with a single static Go binary
(`net/http` + `modernc.org/sqlite`, no CGo) to eliminate the multi-arch
`better-sqlite3` rebuild pain on Home Assistant's ARM hardware, cut the
resource footprint, and remove the npm supply-chain surface.

The rollout ran in phases on a `go-migration` branch, then a dev-channel
beta, then the #977 cutover that made this the shipping image — see
[`docs/history/go-migration.md`](../../docs/history/go-migration.md). Two
compatibility bars anchored it and still hold:

- The API contract: every endpoint keeps the paths, methods, status codes
  and response shapes `glp-integration`, `glp-lovelace-card` and
  `glp-order-card` depend on. `internal/system/openapi.yaml` (served at
  `/api/openapi.json`) is the current spec.
- The existing `/data/glp.db` SQLite file keeps opening unchanged — no
  data migration, only schema compatibility (see `internal/db/doc.go`).

Security parity with the Node app's ingress-trust model (HA Ingress vs.
direct-port trust boundary, `X-GLP-Token` auth, SSRF guards on machine
hosts, rate limiting) is non-negotiable and is kept 1:1, not
approximated — see `internal/auth/doc.go`.

## Layout

```
go/
  go.mod
  README.md              — this file
  Makefile               `make build`/`vet`/`test`/`fmt-check`; `make frontend` bundles the SPA into `internal/webapp/dist` via `cmd/frontend-build`
  cmd/
    server/                main() — opens the DB, wires every `internal/<domain>` package together, and serves the REST/SSE API
    frontend-build/        bundles `../public-src` into `internal/webapp/dist` (esbuild's Go API, #1033)
    gaggiuino-ws-probe/    manual protobuf-decoder verification tool (not part of the server binary)
  internal/
    achievements/  achievements ("stamp card") domain
    auth/          ingress-trust checks + API-token auth
    backup/        backup/restore (JSON export + zip)
    config/        shared, dependency-free `options.json` helpers
    db/            SQLite schema init + migrations
    debug/         export-db/import-db + the Go-only ingress self-check
    ha/            Home Assistant REST client (notify/persons/switch)
    httputil/      shared JSON-response helpers
    img/           shared entity-image helpers + optimize
    importer/      bean import from shop/roaster URLs
    library/       coffee library (beans, grinders, baskets, milks, recipes)
    machines/      machine registry + control proxy + per-type adapters
      proto/         Gaggiuino's binary WS codec
    maintenance/   maintenance tasks + log
    mqtt/          MQTT live-data transport
    netguard/      SSRF/host guards
    orders/        barista-orders queue
    ratelimit/     app-level rate limiter
    shots/         shot history + scoring
    sse/           `/api/events` Server-Sent Events hub
    system/        status/preheat/version/demo + background polling
    webapp/        the SPA from `../public-src`, embedded via `//go:embed` and served at `/`
  scripts/
    smoke-test.sh            native-binary + Docker-image smoke test
```

This package's CI is `.github/workflows/test.yaml`'s `go-test` job (gofmt/
vet/build/`go test -race`/govulncheck/route-parity) plus that same file's
`docker-smoke` job (`needs: go-test`; multi-arch matrix build of the
repo-root Dockerfile — amd64/arm64/armv7 — plus `go/scripts/smoke-test.sh`
against the amd64 image) — both added at the #977 cutover, replacing the
now-deleted `go-build.yaml`; see
[`docs/history/go-migration.md`](../../docs/history/go-migration.md) for that
history.

Every backend package under `internal/` is implemented — see
`internal/system/doc.go` for the small, deliberate set of
`routes/system.js` routes that were not ported.

## Frontend

The shipping UI is the SPA in `../public-src/`. `cmd/frontend-build` bundles
it (esbuild's Go API, #1033) into `internal/webapp/dist`, which
`internal/webapp` embeds via `//go:embed all:dist` and serves at `/`.
`kiosk.html` is a second entry of the same bundle; `GET /ui/kiosk` redirects
to it for old bookmarks. Only a placeholder `internal/webapp/dist/index.html`
is committed, so a plain `go build` resolves the embed with no npm step; the
Docker image and `make frontend` supply the real bundle.

## Contract

`internal/system/openapi.yaml`, served at `/api/openapi.json`, is the API
spec. External consumers (`glp-integration`, `glp-lovelace-card`,
`glp-order-card`) depend on the paths, methods, status codes and response
shapes it documents.

## Building

```
cd go
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
