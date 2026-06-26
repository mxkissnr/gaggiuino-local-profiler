FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
# Build tools needed to compile better-sqlite3 native addon
RUN apk add --no-cache --virtual .build-deps python3 make g++ && \
    npm ci && \
    apk del .build-deps

COPY vite.config.js ./
COPY public-src/ ./public-src/
COPY lib/ ./lib/
RUN npm run build

# ── Runtime stage ──────────────────────────────────────────────────────────
FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
# Build tools needed to compile better-sqlite3 native addon; removed after install
RUN apk add --no-cache --virtual .build-deps python3 make g++ && \
    npm ci --omit=dev && \
    apk del .build-deps

COPY server.js ./
COPY lib/ ./lib/
COPY routes/ ./routes/
COPY openapi.yaml ./
COPY --from=builder /app/public ./public

EXPOSE 8099

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD wget -q --spider http://localhost:8099/ || exit 1

CMD [ "node", "server.js" ]
