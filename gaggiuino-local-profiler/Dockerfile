# Go backend (#977 cutover). Replaces the former Node.js production image
# (server.js) as of this Dockerfile — the Go rewrite (go/, #901) was
# security-audited, smoke-tested (go/scripts/smoke-test.sh) and route-parity
# checked (go/scripts/route-parity.sh) against the Node app before the flip.
# This file used to live at go/Dockerfile while the Go image was build-only
# CI (.github/workflows/go-build.yaml); that workflow has since been deleted
# as redundant to this file/build.yaml/build-dev.yaml as part of this same
# cutover. The Node app's history is preserved in git, its
# source files (server.js, lib/, routes/) are left in the tree for now and
# removed in a follow-up cleanup issue, not this one.
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

# ── Frontend stage: the Vite/rolldown SPA build ────────────────────────────
# Host-platform only (no QEMU), same as the old Node builder stage. Output
# is /app/public, copied into internal/webapp/dist/ in the Go builder below.
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
# the templ runtime library's own indirect dependency, so the codegen tool
# and the library it generates code against never drift apart.
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
# pattern the old Node image used (#271). Alpine also gives HEALTHCHECK a
# plain `wget`, and ships a CA bundle for the outbound HTTPS calls to Open
# Food Facts (barcode scan) and GitHub (update check).
# Digest-pinned like the node:22-slim stage above — this is the image that
# actually ships, so a moved upstream tag must not change it silently.
# Renovate's dockerfile manager keeps the digest current.
FROM alpine:3.22@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce

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
