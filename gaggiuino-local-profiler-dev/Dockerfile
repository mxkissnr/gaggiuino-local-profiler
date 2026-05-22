FROM node:18.20.4-alpine3.20

WORKDIR /app

COPY package.json ./
RUN npm install --only=production

COPY server.js ./
COPY public/ ./public/

EXPOSE 8099

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD wget -q --spider http://localhost:8099/ || exit 1

CMD [ "node", "server.js" ]
