FROM node:24-slim

# Claude Code en mode headless, toujours en dernière version (choix assumé).
# Chaque `docker compose build` prend la version du jour : après une
# reconstruction, lancez une demande de test avant la production.
RUN npm install -g @anthropic-ai/claude-code@latest && npm cache clean --force

ENV DISABLE_AUTOUPDATER=1 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    NODE_OPTIONS=--max-old-space-size=768

COPY server.mjs /opt/worker/server.mjs

# La charte (dossier maison/) est montée ici en lecture seule par docker-compose.
RUN mkdir -p /workspace/maison && chown -R node:node /workspace
USER node
WORKDIR /workspace/maison

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "/opt/worker/server.mjs"]
