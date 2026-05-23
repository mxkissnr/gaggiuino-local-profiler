FROM node:18.20.4-alpine3.20

WORKDIR /app

# Always pull the latest code from the dev branch at build time
RUN apk add --no-cache git && \
    git clone --branch dev --depth 1 https://github.com/mxkissnr/gaggiuino-local-profiler.git /tmp/src && \
    cp /tmp/src/gaggiuino-local-profiler/package.json . && \
    cp /tmp/src/gaggiuino-local-profiler/server.js . && \
    cp -r /tmp/src/gaggiuino-local-profiler/public . && \
    rm -rf /tmp/src && \
    apk del git

RUN npm install --only=production

EXPOSE 8100

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD wget -q --spider http://localhost:8100/ || exit 1

CMD [ "node", "server.js" ]
