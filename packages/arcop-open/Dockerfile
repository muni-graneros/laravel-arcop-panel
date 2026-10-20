FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df
ENV NODE_ENV=production PORT=3001
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --chown=node:node src ./src
COPY --chown=node:node web ./web
USER node
EXPOSE 3001
CMD ["node","src/server.js"]
