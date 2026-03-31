FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY dashboard/ dashboard/
COPY src/ src/
EXPOSE 4200
CMD ["node", "dashboard/server.js"]
