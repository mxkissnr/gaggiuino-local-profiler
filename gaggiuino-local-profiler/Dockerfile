# Build stage — always runs on host platform (amd64); no QEMU, pure JS tooling
FROM --platform=$BUILDPLATFORM node:20-slim AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/* \
    && npm ci

COPY vite.config.js ./
COPY public-src/ ./public-src/
COPY lib/ ./lib/
RUN npm run build

# Dependency stage — cross-compiles native modules for the target arch; no QEMU
FROM --platform=$BUILDPLATFORM node:20-slim AS prod-deps
ARG TARGETARCH

WORKDIR /app
COPY package.json package-lock.json ./

# Native cross-compilers for each supported arch
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make \
      gcc g++ \
      gcc-aarch64-linux-gnu g++-aarch64-linux-gnu \
      gcc-arm-linux-gnueabihf g++-arm-linux-gnueabihf \
    && rm -rf /var/lib/apt/lists/*

# Map Docker TARGETARCH → cross-compiler and npm arch name, then install
RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64)  NPM_ARCH=x64;   CC_X=gcc;                        CXX_X=g++                       ;; \
      arm64)  NPM_ARCH=arm64; CC_X=aarch64-linux-gnu-gcc;      CXX_X=aarch64-linux-gnu-g++     ;; \
      arm)    NPM_ARCH=arm;   CC_X=arm-linux-gnueabihf-gcc;    CXX_X=arm-linux-gnueabihf-g++   ;; \
      *)      NPM_ARCH=x64;   CC_X=gcc;                        CXX_X=g++                       ;; \
    esac; \
    CC=$CC_X CXX=$CXX_X npm_config_target_arch=$NPM_ARCH npm ci --omit=dev; \
    case "${TARGETARCH}" in \
      arm64) npm install --no-save --ignore-scripts --force @napi-rs/canvas-linux-arm64-gnu    ;; \
      arm)   npm install --no-save --ignore-scripts --force @napi-rs/canvas-linux-arm-gnueabihf ;; \
    esac

# Runtime stage — only copies pre-built artifacts; no compilation at all
FROM node:20-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends wget fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

COPY --from=prod-deps /app/node_modules ./node_modules
COPY package.json ./
COPY server.js ./
COPY lib/ ./lib/
COPY routes/ ./routes/
COPY openapi.yaml ./
COPY --from=builder /app/public ./public

EXPOSE 8099

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD wget -q --spider http://localhost:8099/ || exit 1

CMD [ "node", "server.js" ]
