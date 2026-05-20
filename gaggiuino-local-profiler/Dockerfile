FROM node:18-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --only=production

COPY server.js ./
COPY public/ ./public/

EXPOSE 8099

CMD [ "node", "server.js" ]
