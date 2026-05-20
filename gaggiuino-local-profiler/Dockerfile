FROM node:18.20.4-alpine3.20

WORKDIR /app

COPY package.json ./
RUN npm install --only=production \
    && addgroup -S glp \
    && adduser  -S glp -G glp

COPY server.js ./
COPY public/ ./public/

# /data wird vom HA Supervisor gemountet
RUN mkdir -p /data && chown glp:glp /data

USER glp

EXPOSE 8099

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD wget -q --spider http://localhost:8099/ || exit 1

CMD [ "node", "server.js" ]
