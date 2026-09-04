FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src/ src/

ENTRYPOINT ["node", "src/server.js", "channel"]
