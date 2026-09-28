FROM node:24-slim

# Le client Docker (avec compose) et git : de quoi redémarrer, reconstruire et
# mettre à jour l'usine. Aucun serveur n'écoute dans ce conteneur.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl gnupg git \
  && install -m 0755 -d /etc/apt/keyrings \
  && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
  && . /etc/os-release \
  && echo "deb [signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian ${VERSION_CODENAME} stable" > /etc/apt/sources.list.d/docker.list \
  && apt-get update && apt-get install -y --no-install-recommends docker-ce-cli docker-compose-plugin \
  && rm -rf /var/lib/apt/lists/*

COPY server.mjs /opt/superviseur/server.mjs
CMD ["node", "/opt/superviseur/server.mjs"]
