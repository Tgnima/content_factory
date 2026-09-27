#!/usr/bin/env bash
# Installation de l'usine à contenu sur un serveur Linux (Ubuntu/Debian).
#
#   git clone <dépôt> usine-contenu && cd usine-contenu
#   bash install.sh                                questions interactives
#   bash install.sh --answers reponses.json --yes  réponses préparées (par exemple par Claude Code)
#
# Étapes : Docker et swap si besoin, assistant de configuration (scripts/setup.mjs),
# construction des images, connexions par abonnement (Claude, ChatGPT) si choisies,
# démarrage et vérification. Relancer ce script est sans danger : il reprend la
# configuration existante.
set -euo pipefail
cd "$(dirname "$0")"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

# --yes : répond oui aux confirmations (installation de Docker, swap), pour un
# agent qui lance le script sans terminal. Les autres options vont à setup.mjs.
YES=0
SETUP_ARGS=()
for a in "$@"; do
  if [ "$a" = "--yes" ]; then YES=1; else SETUP_ARGS+=("$a"); fi
done
confirm() {
  if [ "$YES" = 1 ]; then echo "$1 oui (--yes)"; return 0; fi
  read -r -p "$1 [o/N] " r
  [[ "$r" =~ ^([oO]|oui|y|yes)$ ]]
}

# Un terminal interactif ? Sinon (agent, CI), pas de -t pour Docker et pas de
# saisie : les étapes de connexion sont expliquées au lieu d'être lancées.
TTY_FLAGS="-i"
INTERACTIVE=0
if [ -t 0 ] && [ -t 1 ]; then TTY_FLAGS="-it"; INTERACTIVE=1; fi

# --- 1. Docker ------------------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  say "Docker n'est pas installé."
  confirm "L'installer maintenant (dépôt officiel Docker, nécessite sudo) ?" || { echo "Docker est nécessaire. Arrêt."; exit 1; }
  sudo apt-get update -y
  sudo apt-get install -y ca-certificates curl
  sudo install -m 0755 -d /etc/apt/keyrings
  . /etc/os-release
  sudo curl -fsSL "https://download.docker.com/linux/${ID}/gpg" -o /etc/apt/keyrings/docker.asc
  sudo chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/${ID} ${VERSION_CODENAME} stable" | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
  sudo apt-get update -y
  sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
DOCKER="docker"
docker info >/dev/null 2>&1 || DOCKER="sudo docker"
COMPOSE="$DOCKER compose"

# --- 2. Swap (conseillé sous 8 Go de RAM) ----------------------------------------
if [ "$(awk '/SwapTotal/ {print $2}' /proc/meminfo)" = "0" ] && [ "$(awk '/MemTotal/ {print $2}' /proc/meminfo)" -lt 8000000 ]; then
  say "Ce serveur n'a pas de swap. Il évite qu'un rédacteur soit arrêté faute de mémoire."
  if confirm "Créer 4 Go de swap (nécessite sudo) ?"; then
    sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile >/dev/null && sudo swapon /swapfile
    grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
    sudo sysctl -w vm.swappiness=10 >/dev/null
  fi
fi

# --- 3. Assistant de configuration ---------------------------------------------
# Avec Node 22+ sur le serveur, directement. Sinon dans un conteneur Node, avec
# l'utilisateur courant pour que les fichiers écrits lui appartiennent.
run_node() {
  if command -v node >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 22 ]; then
    node "$@"
  else
    $DOCKER run --rm $TTY_FLAGS --user "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/app" -w /app node:24-slim node "$@"
  fi
}
say "Configuration"
set +e
run_node scripts/setup.mjs ${SETUP_ARGS[@]+"${SETUP_ARGS[@]}"}
code=$?
set -e
if [ "$code" -eq 2 ]; then
  confirm "Des accès sont à corriger. Continuer quand même ?" || exit 2
elif [ "$code" -ne 0 ]; then
  exit "$code"
fi

# --- 4. Construction -------------------------------------------------------------
say "Construction des images (quelques minutes la première fois)"
$COMPOSE build

NEXT="$(cat .setup-next 2>/dev/null || true)"
needs() { grep -qx "$1" <<<"$NEXT"; }

# --- 5. Token d'abonnement Claude -----------------------------------------------
if needs claude-token; then
  say "Connexion à votre abonnement Claude"
  if [ "$INTERACTIVE" = 1 ]; then
    echo "Un lien va s'afficher : ouvrez-le, connectez-vous, autorisez, collez le code ici."
    echo "À la fin, copiez le token affiché (il commence par sk-ant-oat01-)."
    $COMPOSE run --rm --no-deps --entrypoint claude redacteur-1 setup-token || true
    read -r -s -p "Collez le token (il ne s'affiche pas) : " token
    echo
    if [[ "$token" =~ ^sk-ant-[A-Za-z0-9_-]+$ ]]; then
      sed -i "s|^CLAUDE_CODE_OAUTH_TOKEN=.*|CLAUDE_CODE_OAUTH_TOKEN=${token}|" .env
      echo "Token enregistré dans .env."
    else
      echo "Token absent ou mal formé : remplissez CLAUDE_CODE_OAUTH_TOKEN dans .env puis relancez install.sh."
    fi
  else
    echo "À faire dans un terminal : $COMPOSE run --rm --no-deps --entrypoint claude redacteur-1 setup-token"
    echo "puis collez le token dans .env (ligne CLAUDE_CODE_OAUTH_TOKEN=) et relancez install.sh."
  fi
fi

# --- 6. Démarrage ------------------------------------------------------------------
say "Démarrage"
$COMPOSE up -d --remove-orphans

# --- 7. Connexion ChatGPT de l'illustrateur (mode abonnement) ----------------------
if needs codex-login; then
  sleep 5
  if $COMPOSE exec -T illustrateur-1 codex login status 2>/dev/null | grep -qi "logged in"; then
    echo "L'illustrateur est déjà connecté à ChatGPT."
  elif [ "$INTERACTIVE" = 1 ]; then
    say "Connexion de l'illustrateur à votre abonnement ChatGPT"
    echo "Un lien et un code vont s'afficher : ouvrez le lien, connectez-vous, saisissez le code."
    echo "Si ChatGPT refuse, activez la connexion par code d'appareil : ChatGPT > Paramètres > Sécurité."
    $COMPOSE exec -it illustrateur-1 codex login --device-auth || echo "À refaire plus tard : $COMPOSE exec -it illustrateur-1 codex login --device-auth"
  else
    say "Connexion ChatGPT de l'illustrateur à faire"
    echo "Dans un terminal : $COMPOSE exec -it illustrateur-1 codex login --device-auth"
  fi
fi

# --- 8. Vérification ------------------------------------------------------------------
say "Vérification"
sleep 15
$COMPOSE ps --format '{{.Service}}: {{.Status}}'
echo
$COMPOSE logs --no-color --since 2m orchestrateur | grep -E "prêt|INJOIGNABLE|Planning|connectée|Erreur|Error" || true

cat <<'EOF'

Terminé. Dans Slack :
  1. Invitez le bot dans votre canal : /invite @<nom du bot>
  2. Testez : /contenu social Annonce de notre nouvelle offre
  3. Adaptez la charte éditoriale : /contenu charte

Pour changer un réglage plus tard (modèles, nombre de rédacteurs, Notion…) :
relancez simplement « bash install.sh ».
EOF
