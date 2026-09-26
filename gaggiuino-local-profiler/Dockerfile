# Go backend. The Go rewrite (go/, #901) is the sole runtime as of the
# #977 cutover; the legacy Node.js/Express backend source (server.js, lib/,
# routes/) was removed from the tree in 3.0.0 (#1028) and its last in-tree
# state is archived at tag `archive/node-backend-final` / branch
# `legacy/node-backend`. This file used to live at go/Dockerfile while the
# Go image was build-only CI (.github/workflows/go-build.yaml); that
# workflow was deleted as redundant to this file/build.yaml/build-dev.yaml
# during the cutover.
#
# Multi-arch strategy: native Go cross-compilation, not QEMU emulation, for
# the expensive step. `--platform=$BUILDPLATFORM` below pins the builder
# stage to the CI runner's own architecture (amd64) regardless of which
# target platform buildx is assembling, so `go build` itself always runs
# natively — GOOS/GOARCH/GOARM cross-compile the actual target binary
# without ever executing target-arch code. The former Node image's slow
# part (compiling better-sqlite3's C++ addon under QEMU for arm64/armv7)
# has no equivalent here at all — modernc.org/sqlite is pure Go, no CGo.
# The one place a few seconds of QEMU emulation can still happen is the
# runtime stage's own `apk add` below, which — unlike a C++ compile —
# installs three tiny prebuilt packages.

# ── Frontend deps: `npm ci` only, no Vite build ──────────────────────────
# The SPA is bundled by Go (cmd/frontend-build, #1033), but esbuild still
# resolves the app's bare imports (echarts, chart.js/auto, topojson-client)
# out of node_modules, so the image needs the dependency tree — just never a
# `npm run build`. This is the same stage the Vite build used to run in,
# reduced to `npm ci`; its output is COPYed into the builder below.
#
# Host-platform only (no QEMU) and dependency-only, so there's nothing to
# compile: since 3.0.0 (#1028) the dependency set is frontend-only, so this
# pulls prebuilts with no toolchain packages (python3/make/g++). node:24
# dropped its 32-bit ARM (arm/v7) images, but this stage is pinned to the CI
# runner's own architecture via --platform=$BUILDPLATFORM (amd64) and its
# output is architecture-independent, so that has no bearing here.
# Digest-pinned (multi-arch manifest) like the alpine runtime stage below;
# Renovate's dockerfile manager keeps it current.
FROM --platform=$BUILDPLATFORM node:24-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS frontend-deps

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

# ── Go builder ────────────────────────────────────────────────────────────
# Digest-pinned (#1063, Scorecard pinned-dependencies) like the alpine
# runtime stage below; Renovate's dockerfile manager keeps it current the
# same way. This stage compiles /out/glp-server (see the `go build` below)
# and that exact binary is COPYed into the runtime image further down, so
# the digest pin is about the supply-chain integrity of the shipped
# artifact itself, not just build reproducibility (#1052 — an earlier
# version of this comment wrongly claimed the stage "builds nothing that
# ships"). The pin also carries a toolchain-currency concern: at pin time
# this digest already resolves to a 1.27.x toolchain, ahead of the
# `toolchain go1.25.14` directive in go/go.mod, so `go build` doesn't need
# to fetch a newer toolchain at image-build time. If go.mod's directive is
# bumped ahead of Renovate's next digest PR, `go build` falls back to
# downloading the newer toolchain itself — ubuntu-latest GitHub-hosted
# runners have network access, so that degrades to a slower build rather
# than failing.
FROM --platform=$BUILDPLATFORM golang:1.27-alpine@sha256:8a5910f31396cd4d89662f56c68b3ae31d374308270a1c3bd96672ee5ed43414 AS builder
ARG TARGETOS
ARG TARGETARCH
ARG TARGETVARIANT

WORKDIR /src

COPY go/go.mod go/go.sum ./
RUN go mod download

# templ generate is a required codegen step — internal/web/templates'
# .templ sources aren't valid Go until this runs (see go/README.md's
# "Codegen" section). Pinned to the same version go.mod already pulls in as
# the templ runtime library's own indirect dependency, so the codegen tool
# and the library it generates code against never drift apart.
RUN go install github.com/a-h/templ/cmd/templ@v0.3.1020

COPY go/ .
# The SPA bundle internal/webapp embeds via `//go:embed all:dist` is built
# here, from Go, with esbuild's Go API (#1033): templ generate, then
# cmd/frontend-build, which wipes and rebuilds the whole dist/ directory
# (replacing the committed dist/index.html placeholder the COPY above brought
# in). No Vite build runs in the image — but esbuild resolves the SPA's bare
# imports out of node_modules, so the dependency tree is COPYed in from the
# `npm ci` stage above and found at /src/node_modules (the frontend root,
# which cmd/frontend-build also uses as esbuild's AbsWorkingDir). Dropping
# that COPY is what broke this build's first CI round: esbuild reported
# "Could not resolve echarts/chart.js/auto/topojson-client" with no hint that
# the dependency tree was the missing piece.
# `go run` cross-compiles nothing: the tool runs natively on $BUILDPLATFORM
# and its output is architecture-independent, so all three matrix arches get
# byte-identical assets.
COPY public-src/ ./public-src/
COPY --from=frontend-deps /app/node_modules ./node_modules
RUN templ generate
RUN go run ./cmd/frontend-build -src ./public-src -out ./internal/webapp/dist

RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH GOARM=${TARGETVARIANT#v} \
    go build -trimpath -ldflags="-s -w" -o /out/glp-server ./cmd/server

# Runtime — Alpine, not scratch/distroless: modernc.org/sqlite needs no CGo
# so there's no glibc/musl runtime dependency pulling this choice either
# way, but the container still needs a real shell plus a privilege-drop
# tool to keep the same chown-/data-then-run-unprivileged entrypoint
# pattern the old Node image used (#271). Alpine also gives HEALTHCHECK a
# plain `wget`, and ships a CA bundle for the outbound HTTPS calls to Open
# Food Facts (barcode scan) and GitHub (update check).
# Digest-pinned like the node:24-slim stage above — this is the image that
# actually ships, so a moved upstream tag must not change it silently.
# Renovate's dockerfile manager keeps the digest current.
FROM alpine:3.24@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6

# Empty by default -- only .github/workflows/build-dev.yaml passes this
# build-arg (as dev-<run_number>); the release build (build.yaml) never sets
# it, so GLP_DEV_BUILD stays unset in every image users install and the UI's
# dev-build badge (public-src/components/status.js) never appears for them.
ARG GLP_DEV_BUILD=""
ENV GLP_DEV_BUILD=${GLP_DEV_BUILD}

# #956 W3: cap the Go heap so the GC returns memory to the OS aggressively
# instead of the throughput-tuned default of letting RSS drift up and stay
# there. Soft limit — the runtime still exceeds it if the live heap genuinely
# needs to (it won't OOM the add-on), it just collects harder as it nears
# this. 160 MiB leaves headroom over the steady-state working set while
# pulling the ~190 MB warm RSS back toward the old Node image's ~90 MB.
ENV GOMEMLIMIT=160MiB

# /data is created (not just relied on as a bind-mount point) so the image
# also runs standalone without an explicit `-v` — matching the HA add-on's
# real usage, where Supervisor always provides the mount, but keeping local
# `docker run` (and go/scripts/smoke-test.sh in docker mode) simple.
# docker-entrypoint.sh still re-fixes ownership every start for the real
# bind-mount case, whose host-side UID isn't known at build time.
RUN apk add --no-cache wget ca-certificates su-exec \
    && adduser -D -H -u 1000 glp \
    && mkdir -p /data \
    && chown glp:glp /data

COPY --from=builder /out/glp-server /usr/local/bin/glp-server
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 8099

# GET / serves internal/webapp's SPA shell — always 200 without a token
# (auth.RequireToken's GET/HEAD static bypass), so this only proves the
# HTTP server itself answers, not DB/auth state.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD wget -q --spider http://localhost:8099/ || exit 1

# Container starts as root (needed to chown the /data bind mount at runtime,
# see docker-entrypoint.sh) and immediately drops to the unprivileged `glp`
# user before running the actual app — the process itself never runs as root.
ENTRYPOINT [ "docker-entrypoint.sh" ]
CMD [ "glp-server" ]
