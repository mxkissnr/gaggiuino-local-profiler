# Security audit #977 — round 3 (deferred areas)

Closes the three areas deferred from the round-2 comment on
[#977](https://github.com/mxkissnr/gaggiuino-local-profiler/issues/977)
("Security audit round 2 done, more areas deferred"), ahead of the Phase 4
Go cutover decision. Round 2 (card/SVG + GaggiMate parser) shipped as #994.

Scope: the Go rewrite in `gaggiuino-local-profiler/go/`, with the Node
reference in `lib/` and `routes/` used as the parity baseline.

Toolchain used: `go1.25.14`, `govulncheck` (golang.org/x/vuln), `npm audit`
(npm 11), Docker `buildx imagetools` for digest resolution.

---

## Area 1 — DB / SQL layer (injection)

**Result: CLEAN.** No SQL injection surface found.

### Findings

| # | Severity | File:line | Finding |
|---|----------|-----------|---------|
| 1.1 | Info (clean) | `internal/db/db.go` | Every repository query in `internal/*/repository.go`, `internal/db/`, `internal/backup/kv.go`, `internal/achievements/repository.go`, `internal/shots/*_repo.go` uses either a compile-time-constant SQL string or `?` placeholder binding. No user-derived value is ever concatenated or `fmt.Sprintf`-ed into a query. |
| 1.2 | Low (fixed this round) | `internal/db/db.go:281`, `internal/db/db.go:361` | `SELECT 1 FROM pragma_table_info('%s')` and `ALTER TABLE %s ADD COLUMN …` build SQL with `fmt.Sprintf` on a table name. SQLite refuses a bound parameter for a table name in both spots, so interpolation is unavoidable. Every current call site passes a hard-coded literal (`"shots"`, `"orders"`, `"maintenance_log"`, `"maintenance"`, `"machines"`), so there is **no live injection** — but nothing structurally stopped a future edit from passing a request-derived name. **Fixed:** added `migrationTables` allowlist + `assertKnownTable()` guard that panics at startup on any unknown name. |
| 1.3 | Info (clean) | (whole tree) | **No request-parameter-driven `ORDER BY` / `WHERE`.** The Node concern (request params flowing into `ORDER BY`) does not exist in the Go port: all `ORDER BY` clauses are compile-time constants (`internal/shots/repository.go`, `internal/machines/registry.go`, `internal/shots/backup_repo.go`, …). Sorting that depends on request input (orders lists, customer aggregates, comparative analysis) is done in-memory in Go after the query. |
| 1.4 | Info (clean) | (whole tree) | **No `LIKE` queries at all.** Library / shot search and filtering is performed in-memory over the fully-loaded dataset (`internal/library/service.go`'s Unicode-case-folding match), mirroring the Node app's "load all, filter in JS" model. There is therefore no `LIKE` pattern-escaping surface. |
| 1.5 | Info (clean) | `internal/backup/restore.go`, `internal/backup/restore_stream.go` | Restore never names a table from the uploaded backup. It validates each section and delegates writes to the typed repository layer (`shotsRepo`, `libRepo`, `ordersRepo`, `maintenanceRepo`, `registry`), all of which use parameterized inserts. |
| 1.6 | Info (clean) | `internal/db/db.go:62`, `internal/debug/debug.go:357` | DSN strings are built with `"file:" + path + "?_pragma=…"`. `path` is an internal constant (`/data/glp.db`) or a test-injected path, never request input. |

### Recommendation

Area 1 needs no further work. Finding 1.2's guard is included in the
round-3 PR.

---

## Area 2 — Dependency / container hardening

**Result: mostly clean; three low-risk items fixed this round, one CI
enhancement filed as an issue.**

### Dependency scan

| Tool | Result |
|------|--------|
| `npm audit --omit=dev` | **0 vulnerabilities** |
| `npm audit` (incl. dev) | **0 vulnerabilities** |
| `govulncheck ./...` (toolchain `go1.25.0`, pre-fix) | 28 findings, **all Go standard library**, each fixed in a `go1.25.x` patch. 0 findings in third-party code the app calls. 10 imported + 10 required-module advisories, none called. |
| `govulncheck ./...` (toolchain `go1.25.14`, post-fix) | **0 called vulnerabilities**, 0 in imported packages, 3 in required-but-not-called modules. |

The 28 stdlib findings were an artifact of the build toolchain, not the
dependency graph: `go.mod` declared `go 1.25.0` with no `toolchain`
directive, and `actions/setup-go` reads that file — so CI's `go build` /
`go test` / `go vet` ran on an unpatched `go1.25.0`. (The shipped binary
was already unaffected: `go/Dockerfile`'s builder floats `golang:1.25-alpine`
to the latest patch.)

| # | Severity | File:line | Finding |
|---|----------|-----------|---------|
| 2.1 | Medium (fixed this round) | `go/go.mod:3` | CI toolchain pinned to unpatched `go1.25.0`; `govulncheck` flags 28 stdlib CVEs (DoS / panic / quadratic-parsing in `crypto/x509`, `net/http`, `crypto/tls`, `encoding/asn1`, `net/url`, `encoding/pem`, `html/template`, …). **Fixed:** added `toolchain go1.25.14`; `govulncheck` now clean. |
| 2.2 | Low (fixed this round) | `go/Dockerfile` (builder + runtime `FROM`) | `alpine:3.22` (runtime — the image that actually ships) pinned by tag only, unlike the digest-pinned `node:22-slim` stages in the same file and the repo-root Node Dockerfile. **Fixed:** `alpine:3.22` digest-pinned; Renovate's `dockerfile` manager keeps it current. The `golang:1.25-alpine` builder stage is deliberately left tag-only — it builds nothing that ships, and floating to the latest 1.25.x keeps it ahead of the `toolchain go1.25.14` directive in `go.mod` (finding 2.1), so `go build` never fetches a newer toolchain at image-build time. |
| 2.3 | Low / Info | `.github/workflows/go-build.yaml` | No `govulncheck` step in Go CI, so a future dependency (or toolchain regression) with a *called* vulnerability would not be caught. **Filed as an issue** (advisory-vs-blocking is a maintainer call). |
| 2.4 | Info (clean) | `Dockerfile` (repo root — the image real installs pull) | `node:22-slim` digest-pinned across all three stages; process drops root via `gosu node` in `docker-entrypoint.sh`; `HEALTHCHECK` present; no secret in any build arg (`GLP_DEV_BUILD` is a non-secret build tag); runtime `apt` limited to `wget fonts-liberation gosu`. No change needed. |
| 2.5 | Info (clean) | `go/Dockerfile` | Non-root `glp` (uid 1000) created and `/data` chowned; root only for the entrypoint's bind-mount chown, then `su-exec glp`; `HEALTHCHECK` present; `CGO_ENABLED=0` static build; no build secret; runtime `apk` limited to `wget ca-certificates su-exec`. |
| 2.6 | Info (clean) | `config.yaml` | No `privileged`, `host_network`, `host_pid`, `host_ipc`, `devices`, `usb`, `udev`, `full_access`, `docker_api`, or `map:` of sensitive host paths. `homeassistant_api` / `hassio_api` / `services: mqtt:want` each carry a code-referenced justification. `ports: 8099/tcp` is intentional and gated by the `expose_api_port` option (default open for upgrade-compat, documented in DOCS.md's trust model). |
| 2.7 | Info (clean) | `apparmor.txt` | Ships enforced. Broad `file,` rule is a deliberate, documented trade-off (a Node app's per-arch dynamic native-addon lookups can't be safely path-enumerated without field breakage, and CI can't validate AppArmor mediation). `capability` / `network` / exec lists are scoped to the documented runtime shape (privilege-drop caps, inet stream/dgram + netlink, no raw/packet sockets). |
| 2.8 | Info | `build.yaml` | `build_from:` points at `ghcr.io/home-assistant/*-base:latest` (floating), but `go/Dockerfile` and the repo-root `Dockerfile` both hard-code their own `FROM …@sha256:…` and never reference `$BUILD_FROM`, so `build_from` is dead config. Cosmetic only — no runtime effect. Not fixed (out of round-3 scope; safe to drop or ignore). |

### Third-party module advisories (not called — informational)

`govulncheck` post-fix lists 3 advisories in required-but-not-reachable
modules (e.g. `golang.org/x/net/idna`, `x/net` http2 internal). None are on
a call path from this codebase. Renovate's `vulnerabilityAlerts` (already
enabled, `security` label) will surface these if they become reachable.

---

## Area 3 — Rate-limiting: full API surface

**Result: app-wide backstop covers 100% of routes; feature-level limits
match Node parity exactly. One parity-preserved gap flagged for a
maintainer decision.**

### How the limiter is mounted

`cmd/server/main.go` builds a single `http.ServeMux` (`mux`). Every route —
REST `/api/*`, `/shots.json`, the `/api/events` SSE endpoint, `/api/debug/export-db`,
the `/ui/` templ sub-mux (mounted via `mux.Handle("/ui/", …)`), and the
embedded-SPA catch-all `GET /` — is registered on that one mux. The server
runs exactly one `http.Server{Handler: handler}`, where:

```
handler = auth.SecurityHeaders( limiter.Middleware( auth.RequireToken(token)(mux) ) )
```

So the app-wide token-bucket limiter (`ratelimit.DefaultMax` = 600 req /
60 s, keyed on the raw socket address, IPv6 masked to /64, `/assets/*`
exempt) sits **outside** auth and gates **every** request to **every**
route, authenticated or not. Verified against the full `RegisterRoutes`
inventory — no route escapes it. This matches `server.js`'s
`app.use(createApiRateLimiter())` placement.

### Feature-level limits (`KeyedLimiter` / `library.rateLimiter`) — Node parity

| Endpoint(s) | Key | Limit | Node reference | Go |
|---|---|---|---|---|
| `POST /api/library/scan` (barcode → Open Food Facts) | `scan:<ip>` | 20/min | `routes/library/scan.js:26` | `internal/library/scan.go:51` ✅ |
| `POST` create on beans / milks / grinders / baskets / recipes / puckscreens | `lib:<ip>` | 30/min | `routes/library/*.js` | `internal/library/handlers*.go` via `rateLimitCreate` ✅ (all 6) |
| `GET /api/token` | `token:<ip>` | 10/min | `routes/system.js:115` | `internal/system/handlers.go:243` ✅ |
| `POST /api/restore` (full) | `restore:<ip>` | 3/min | `routes/backup.js:506` | `internal/backup/restore.go:161` ✅ |
| `POST /api/restore` (preview) | `restore-preview:<ip>` | 30/min | `routes/backup.js:505` | `internal/backup/restore.go:159` ✅ |
| `POST /api/orders` | `orders:<ip>` | 10/min | `routes/orders.js:349` | `internal/orders/handlers.go:964` ✅ |
| htmx write actions (`/ui/` machines / library / menu) | `web-*:<ip>` | 10–30/min | (Go-only pages) | `internal/web/handlers_*.go` ✅ |
| manual machine sync | 30 s debounce | — | `routes/system.js:282` | ported ✅ |

Every Node feature-level `rateLimit()` call has an equivalent in the Go
port. No feature-level regression.

### Findings

| # | Severity | File:line | Finding |
|---|----------|-----------|---------|
| 3.1 | Info (clean) | `cmd/server/main.go:452-476` | App-wide limiter proven to wrap every route via the single shared mux. No unlimited endpoint exists. |
| 3.2 | Low — needs maintainer decision | `internal/shots/handlers.go:77` (`GET /api/shots/{id}/card`), `internal/debug/debug.go:123` (`GET /api/debug/export-db`) | Two disproportionately expensive endpoints sit **only** under the generous 600/min backstop, with no dedicated feature limit: the card endpoint runs an SVG→PNG render through the resvg wasm pool (already a measured concurrency hot-spot — see #977's `c=10` card-render regression note), and export-db streams the entire SQLite file. 600 renders or 600 full-DB dumps per minute from one socket is a cheap local DoS / bandwidth amplifier. **This matches Node** (neither endpoint is feature-limited there either), so it is *not a Go regression* — but the Go port is the moment to add a small dedicated limit (e.g. `card:<ip>` ~30/min, `export-db:<ip>` ~5/min). Filed as an issue; behavioral change, so maintainer decision. |
| 3.3 | Info — parity-preserved | `internal/ratelimit/doc.go` | Behind HA Ingress every browser shares **one** bucket (all ingress traffic arrives from the single Supervisor source IP), so the 600/min ceiling is effectively per-ingress, not per-user. Documented as intentional in `doc.go` and identical to Node (`server.js` never sets `trust proxy`). Trusting `X-Forwarded-For` here would let a LAN client on the exposed port spoof its key, which is the worse trade. No action; noted for completeness. |

---

## Summary of changes shipped in the round-3 PR

1. `internal/db/db.go` — `migrationTables` allowlist + `assertKnownTable()` guard on the two unavoidable `fmt.Sprintf` table-name interpolations (finding 1.2).
2. `go/go.mod` — `toolchain go1.25.14` directive; `govulncheck` goes from 28 stdlib findings to 0 (finding 2.1).
3. `go/Dockerfile` — digest-pin the `alpine:3.22` runtime stage (finding 2.2); the `golang:1.25-alpine` builder stays tag-only by design.

## Issues opened

- **#997** — tracking issue for this round + the low-risk PR (findings 1.2, 2.1, 2.2).
- **#998** (needs maintainer decision) — Finding 2.3: add `govulncheck` to `go-build.yaml`, advisory vs blocking.
- **#999** (needs maintainer decision) — Finding 3.2: dedicated rate limits for `GET /api/shots/{id}/card` and `GET /api/debug/export-db` (behavioral change; also relevant to the #977 card-render concurrency note).

## Not changed (out of scope / cosmetic)

- **Finding 2.8** — `build.yaml`'s dead `build_from:` config. No runtime effect.
- **Finding 2.7** — `apparmor.txt` broad `file,` rule. Deliberate, documented.
