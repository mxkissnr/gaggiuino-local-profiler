# Go rewrite Docker image (#901 Phase 4, build-only CI infrastructure — see
# go/README.md). NOT wired into any release/dev channel yet: this Dockerfile
# exists so the CI workflow (.github/workflows/go-build.yaml) and a
# maintainer can prove the Go binary actually containerizes and runs, ahead
# of the still-undecided Phase 5 cutover. The repo-root Dockerfile (Node)
# remains the only image any real install pulls.
#
# Build context is the repo subdir gaggiuino-local-profiler/ (NOT go/) —
# Phase 1 (#901) embeds the production Vite SPA bundle into the binary via
# internal/webapp's //go:embed, so the frontend source (public-src/,
# vite.config.js, the shared lib/ files vite.config.js pulls in) must be in
# context alongside go/. The CI workflows pass `context:
# ./gaggiuino-local-profiler` + `file: ./gaggiuino-local-profiler/go/Dockerfile`.
#
# Multi-arch strategy: native Go cross-compilation, not QEMU emulation, for
# the expensive step. `--platform=$BUILDPLATFORM` below pins the builder
# stage to the CI runner's own architecture (amd64) regardless of which
# target platform buildx is assembling, so `go build` itself always runs
# natively — GOOS/GOARCH/GOARM cross-compile the actual target binary
# without ever executing target-arch code. That's the speed win #901 Phase
# 4 exists to prove: the Node image's slow part (compiling better-sqlite3's
# C++ addon under QEMU for arm64/armv7, see the repo-root Dockerfile's
# prod-deps stage comment) has no equivalent here at all. The one place a
# few seconds of QEMU emulation can still happen is the runtime stage's own
# `apk add` below, which — unlike a C++ compile — installs three tiny
# prebuilt packages; docker/setup-qemu-action is kept in the CI workflow
# for exactly that (and only that) reason.

# ── Frontend stage: the Vite/rolldown SPA build (Phase 1, #901) ────────────
# Same inputs as the repo-root Node Dockerfile's own builder stage: the JS
# toolchain is host-platform only (no QEMU), and `npm ci` needs python3/
# make/g++ for the native deps in devDependencies (vite itself is a
# devDependency, so --omit=dev is not an option). Output is /app/public,
# copied into internal/webapp/dist/ in the Go builder below.
FROM --platform=$BUILDPLATFORM node:22-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS frontend

WORKDIR /app

COPY package.json package-lock.json ./
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/* \
    && npm ci

COPY vite.config.js ./
COPY public-src/ ./public-src/
COPY lib/ ./lib/
RUN npm run build

# ── Go builder ────────────────────────────────────────────────────────────
# Tag-pinned only (not by digest, unlike the node:22-slim / alpine:3.22
# stages): this stage builds nothing that ships, and floating to the latest
# 1.25.x patch is deliberate — it keeps the build toolchain ahead of, or
# equal to, the `toolchain go1.25.14` directive in go/go.mod, so `go build`
# never has to fetch a newer toolchain at image-build time (which would fail
# in a network-restricted buildx/CI builder). Renovate's gomod manager bumps
# that go.mod directive on its own cadence; this tag needs no maintenance.
FROM --platform=$BUILDPLATFORM golang:1.25-alpine AS builder
ARG TARGETOS
ARG TARGETARCH
ARG TARGETVARIANT

WORKDIR /src

COPY go/go.mod go/go.sum ./
RUN go mod download

# templ generate is a required codegen step — internal/web/templates'
# .templ sources aren't valid Go until this runs (see go/README.md's
# "Codegen" section). Pinned to the same version go.mod already pulls in as
# the templ *runtime* library's indirect dependency, so the codegen tool and
# the library it generates code against never drift apart.
RUN go install github.com/a-h/templ/cmd/templ@v0.3.1020

COPY go/ .
# Replace the committed dist/index.html placeholder with the real Vite
# build so internal/webapp's `//go:embed all:dist` picks up the full bundle.
RUN rm -rf internal/webapp/dist
COPY --from=frontend /app/public ./internal/webapp/dist
RUN templ generate

RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH GOARM=${TARGETVARIANT#v} \
    go build -trimpath -ldflags="-s -w" -o /out/glp-server ./cmd/server

# Runtime — Alpine, not scratch/distroless: modernc.org/sqlite needs no CGo
# so there's no glibc/musl runtime dependency pulling this choice either
# way, but the container still needs a real shell plus a privilege-drop
# tool to keep the same chown-/data-then-run-unprivileged entrypoint
# pattern the Node image uses (docker-entrypoint.sh at the repo root, #271)
# — distroless and scratch have neither, and embed.FS removes the only
# other reason a runtime asset directory might be needed. Alpine also gives
# HEALTHCHECK a plain `wget`, identical to the Node image's, and ships a CA
# bundle for the outbound HTTPS calls to Open Food Facts (barcode scan) and
# GitHub (update check) — the concrete case the task brief called out
# scratch failing on.
# Digest-pinned like the node:22-slim stages above — this is the image that
# actually ships, so a moved upstream tag must not change it silently.
# Renovate's dockerfile manager keeps the digest current.
FROM alpine:3.22@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce

# Empty by default, same as the repo-root Node Dockerfile's own
# GLP_DEV_BUILD ARG/ENV pair -- only .github/workflows/go-preview-publish.yaml
# passes this build-arg (as go-preview-<timestamp>), so it stays unset in
# any image built by go-build.yaml's own build-only CI. internal/system/
# version.go reads it to suppress the GitHub-release "update available"
# check (comparing an unreleased experimental build's version string
# against the stable release tag would always look "out of date"), and
# internal/system/handlers.go's GET /api/status surfaces it as `devBuild`
# for the frontend, mirroring public-src/components/status.js's existing
# dev-build badge.
ARG GLP_DEV_BUILD=""
ENV GLP_DEV_BUILD=${GLP_DEV_BUILD}

# #956 W3: cap the Go heap so the GC returns memory to the OS aggressively
# instead of the throughput-tuned default of letting RSS drift up and stay
# there. Soft limit — the runtime still exceeds it if the live heap genuinely
# needs to (it won't OOM the add-on), it just collects harder as it nears
# this. Governs the Go heap only (goccy decode buffers, json.RawMessage
# retention, the score cache); resvg's wasm linear memory is off-heap and is
# bounded separately by resvgPoolSize. 160 MiB leaves headroom over the
# steady-state working set while pulling the ~190 MB warm RSS back toward
# Node's ~90 MB.
ENV GOMEMLIMIT=160MiB

# /data is created (not just relied on as a bind-mount point) so the image
# also runs standalone without an explicit `-v` — matching the HA add-on's
# real usage, where Supervisor always provides the mount, but keeping local
# `docker run` (and this package's own scripts/smoke-test.sh in docker
# mode) simple. docker-entrypoint.sh's chown -R still re-fixes ownership
# every start for the real bind-mount case, whose host-side UID isn't known
# at build time.
RUN apk add --no-cache wget ca-certificates su-exec \
    && adduser -D -H -u 1000 glp \
    && mkdir -p /data \
    && chown glp:glp /data

COPY --from=builder /out/glp-server /usr/local/bin/glp-server
COPY go/docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 8099

# GET / now serves internal/webapp's SPA shell (Phase 1, #901) — always 200
# without a token (auth.RequireToken's GET/HEAD static bypass, same as the
# Node app's own index.html), so this only proves the HTTP server itself
# answers, matching the Node healthcheck's actual intent without depending
# on DB/auth state.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD wget -q --spider http://localhost:8099/ || exit 1

# Same as the Node image: starts as root (needed to chown the /data bind
# mount, see docker-entrypoint.sh) and immediately drops to the
# unprivileged `glp` user before running the actual app.
ENTRYPOINT [ "docker-entrypoint.sh" ]
CMD [ "glp-server" ]
