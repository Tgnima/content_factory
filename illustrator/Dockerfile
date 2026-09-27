FROM node:24-slim

# Codex n'embarque pas de certificats, contrairement à Node : sans ce paquet,
# toute connexion HTTPS (dont la connexion ChatGPT) échoue.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*

# Codex CLI, pour créer les images avec un abonnement ChatGPT quand aucune clé
# API n'est fournie. Toujours en dernière version (choix assumé) : après une
# reconstruction, lancez un visuel de test avant la production.
RUN npm install -g @openai/codex@latest && npm cache clean --force

COPY server.mjs /opt/illustrator/server.mjs

# ~/.codex garde la connexion ChatGPT (auth.json) et les images générées. Il est
# monté sur un volume, pour que la connexion survive aux redémarrages.
RUN mkdir -p /home/node/.codex /tmp/jobs && chown -R node:node /home/node/.codex /tmp/jobs
USER node
WORKDIR /tmp/jobs

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "/opt/illustrator/server.mjs"]
