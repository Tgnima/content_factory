FROM node:24-slim

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY src ./src

# Le volume nommé orchestrateur-data reprend ces droits à sa création.
RUN mkdir -p /app/data/exports && chown -R node:node /app/data
USER node

CMD ["node", "src/index.mjs"]
