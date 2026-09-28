#!/usr/bin/env bash
# Met l'usine à jour depuis le dépôt GitHub, sans toucher à vos réglages :
# .env, config/factory.json, maison/ (charte) et les données restent tels quels.
#
#   bash update.sh
#
# Étapes : récupération du code (git pull), ajout des nouveaux réglages du
# modèle à votre configuration, reconstruction des images (dernières versions
# de Claude Code et Codex), redémarrage. Testez ensuite une demande dans Slack.
set -euo pipefail
cd "$(dirname "$0")"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

DOCKER="docker"
docker info >/dev/null 2>&1 || DOCKER="sudo docker"
COMPOSE="$DOCKER compose"

run_node() {
  if command -v node >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 22 ]; then
    node "$@"
  else
    $DOCKER run --rm -i --user "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/app" -w /app node:24-slim node "$@"
  fi
}

say "Récupération du code"
# Un dossier raccordé à GitHub après coup (git init + remote) n'a pas de branche
# suivie : on suit origin/main. Après un git clone, c'est déjà le cas.
git rev-parse --abbrev-ref '@{u}' >/dev/null 2>&1 || { git fetch -q origin && git branch -q --set-upstream-to=origin/main; }
before="$(git rev-parse HEAD)"
git pull --ff-only
after="$(git rev-parse HEAD)"
if [ "$before" = "$after" ]; then
  echo "Déjà à jour."
else
  git log --oneline "$before..$after"
fi

say "Mise à niveau de la configuration"
run_node scripts/setup.mjs --upgrade

# L'utilisateur du serveur et le groupe Docker : le superviseur tourne avec eux
# (pas en root), et les fichiers qu'il écrit restent à vous.
set_env() { if grep -q "^$1=" .env; then sed -i "s|^$1=.*|$1=$2|" .env; else printf "%s=%s\n" "$1" "$2" >> .env; fi; }
host_ids() {
  set_env HOST_UID "$(id -u)"
  set_env HOST_GID "$(id -g)"
  set_env DOCKER_GID "$(stat -c %g /var/run/docker.sock 2>/dev/null || echo 999)"
  mkdir -p actions/results
}
host_ids

say "Reconstruction et redémarrage"
$COMPOSE up -d --build --remove-orphans

sleep 15
$COMPOSE logs --no-color --since 1m orchestrateur | grep -E "prêt|INJOIGNABLE|Planning|connectée|Erreur|Error" || true
echo
echo "Mise à jour terminée. Testez une demande dans Slack."
