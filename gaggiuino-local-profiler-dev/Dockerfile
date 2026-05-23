FROM node:18.20.4-alpine3.20

WORKDIR /app

# Pre-install dependencies (image rebuild only needed when package.json changes)
COPY package.json ./
RUN npm install --only=production

# Startup script pulls latest server.js + index.html from main branch on every start
COPY run.sh /run.sh
RUN chmod +x /run.sh

EXPOSE 8100

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD wget -q --spider http://localhost:8100/ || exit 1

CMD ["/run.sh"]
