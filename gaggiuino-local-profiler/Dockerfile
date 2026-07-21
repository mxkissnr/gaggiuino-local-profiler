# Build stage — always runs on host platform (amd64); no QEMU, pure JS tooling
FROM --platform=$BUILDPLATFORM node:22-slim AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/* \
    && npm ci

COPY vite.config.js ./
COPY public-src/ ./public-src/
COPY lib/ ./lib/
RUN npm run build

# Dependency stage — runs on the target platform itself (arm64/armv7 under
# QEMU when cross-building), so npm's own os/cpu-scoped optionalDependency
# resolution and any native compilation naturally target the right arch
# without a hand-rolled cross-compiler/arch mapping.
FROM node:22-slim AS prod-deps
ARG TARGETARCH

WORKDIR /app
COPY package.json package-lock.json ./

RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/* \
    && npm ci --omit=dev

# better-sqlite3 ships a bundled prebuilt addon for linux-x64/linux-arm64,
# but the arm64 prebuild links against glibc >= 2.38 while node:22-slim
# (Debian Bookworm) only has glibc 2.36 — and armv7 has no bundled prebuild
# at all. Force a from-source rebuild for every non-amd64 target so the
# addon is compiled against this image's actual glibc (see #419). The amd64
# prebuild is verified compatible, so it's left alone to keep that build fast.
RUN if [ "$TARGETARCH" != "amd64" ]; then \
      rm -f node_modules/better-sqlite3/prebuilds/*.node; \
      npm rebuild better-sqlite3; \
    fi

# Runtime stage — only copies pre-built artifacts; no compilation at all
FROM node:22-slim

ENV NODE_ENV=production

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends wget fonts-liberation gosu \
    && rm -rf /var/lib/apt/lists/*

COPY --from=prod-deps /app/node_modules ./node_modules
COPY package.json ./
COPY server.js ./
COPY icon.png ./
COPY lib/ ./lib/
COPY routes/ ./routes/
COPY openapi.yaml ./
COPY --from=builder /app/public ./public
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 8099

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD wget -q --spider http://localhost:8099/ || exit 1

# Container starts as root (needed to chown the /data bind mount at runtime,
# see docker-entrypoint.sh) and immediately drops to the unprivileged `node`
# user before running the actual app — the process itself never runs as root.
ENTRYPOINT [ "docker-entrypoint.sh" ]
CMD [ "node", "server.js" ]
