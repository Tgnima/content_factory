# Usine à contenu

On tape `/contenu` dans Slack. Des workers, dans des conteneurs Docker, rédigent des articles et des posts, et créent des visuels. Le résultat revient dans le fil Slack avec les boutons **Valider**, **Corriger** et **Publier sur Notion**. Chaque worker peut utiliser le modèle de votre choix : Claude, Mistral, Gemini, DeepSeek, Flux, un modèle local…

```
Slack ──Socket Mode──► orchestrateur ──HTTP interne──► redacteur-1..N   (texte)
  ▲                    (Node + SQLite)                 illustrateur-1   (images)
  │                         │  ▲
  │                         ▼  │ planning, publication
  │                       Notion
  └──── brouillon, boutons, fichier final ◄──────────────────────────┘
```

## Installation sur un serveur (environ 20 minutes)

Il faut un serveur Linux (Ubuntu ou Debian), avec au moins 4 Go de RAM pour 2 rédacteurs et un illustrateur, et un espace Slack où vous pouvez installer une app.

**1. Créer l'app Slack.** Sur https://api.slack.com/apps, cliquez sur **Create New App**, puis **From a manifest**, et collez `slack-manifest.yml`. Ensuite :
- **Basic Information**, puis **App-Level Tokens**, puis **Generate** (scope `connections:write`) : vous obtenez le token `xapp-…` ;
- **Install App** : vous obtenez le token `xoxb-…`.

**2. Récupérer le projet et lancer l'installation :**

```bash
git clone https://github.com/Tgnima/content_factory.git
cd content_factory
bash install.sh
```

L'assistant pose les questions suivantes :
- le nom du bot, le canal et les personnes autorisées ;
- le nombre de rédacteurs, et le **moteur de chacun** (Claude, Mistral, Gemini, DeepSeek, un autre modèle de Vercel AI Gateway, Mistral en direct, OpenRouter, Ollama, ou toute API compatible OpenAI) ;
- le moteur des visuels (abonnement ChatGPT, clé OpenAI, Flux, Recraft, Gemini, ou aucun) ;
- s'il faut activer JEV et Notion.

Pour chaque clé nécessaire, il indique où la trouver, la demande sans l'afficher, puis la **teste**, tout comme les modèles choisis. Il installe ensuite Docker et le swap si besoin, construit les images, vous guide pour les connexions par abonnement (Claude, ChatGPT) et démarre l'usine.

**3. Tester dans Slack** : `/invite @<nom du bot>` dans votre canal, puis `/contenu social Un sujet précis`.

### Avec Claude Code (ou un autre agent)

Ouvrez le projet dans Claude Code et demandez-lui de « configurer l'usine ». Le skill `configurer-usine` lui fait poser les mêmes questions, une par une. Vous collez vos clés vous-même dans `.env`, et elles ne passent jamais par la conversation. L'agent lance ensuite `bash install.sh --answers setup.answers.json --yes`. Voir `CLAUDE.md` et `AGENTS.md`.

### Changer un réglage plus tard

- **Tout réglage** : relancez `bash install.sh`. L'assistant reprend les clés déjà présentes.
- **Seulement vérifier** : `node scripts/setup.mjs --check`.
- **Seulement changer de modèle** : dans `config/factory.json`, modifiez `workers[].engine` ou le `model` d'un moteur, puis lancez `docker compose restart orchestrateur`.

## Ce que fait l'usine

| Étape | Dans Slack |
|---|---|
| Demande | `/contenu blog Pourquoi héberger ses données en France` (formats `blog`, `social`, `visuel`, `pack`) |
| En attente | :hourglass_flowing_sand: sur le message, avec la position dans la file si tous les workers sont pris |
| Rédaction | :writing_hand: « redacteur-1 rédige… » dans le fil |
| Contrôles | Longueur, termes interdits et, avec JEV, respect de la charte. Si un contrôle échoue, le rédacteur refait un passage |
| Relecture | :eyes: brouillon dans le fil, avec **Valider**, **Corriger** et **🎨 Ajouter un visuel** |
| Validation | :white_check_mark: fichier `.md` joint dans le fil, puis **📤 Publier sur Notion** |

## Arborescence

```
install.sh                   installation et reconfiguration (point d'entrée unique)
scripts/setup.mjs            l'assistant : questions, tests des clés, écriture des fichiers
setup.answers.example.json   modèle de réponses pour une installation sans questions
.env.example                 la liste des secrets (copiée en .env, jamais commitée)
docker-compose.yml           généré par l'assistant selon le nombre de workers
config/factory.json          workers, moteurs, formats, pack, planning, JEV
maison.example/              modèle de charte et d'exemples, copié une fois dans maison/ (à vous, jamais écrasé)
slack-manifest.yml           pour créer l'app Slack en un clic
orchestrator/                Slack, file d'attente SQLite, répartition, contrôles, Notion
worker/                      rédacteur : Claude Code ou toute API compatible OpenAI
illustrator/                 illustrateur : Codex, OpenAI, Flux, Recraft, Gemini…
scripts/notion-setup.mjs     crée la base Notion « Planning éditorial »
CLAUDE.md, AGENTS.md, .claude/skills/   consignes pour les agents
```

## Au quotidien

```bash
docker stats                                   # mémoire et CPU en direct
docker compose logs -f                         # tous les logs
docker compose restart orchestrateur           # après une modif de config/factory.json
docker compose cp orchestrateur:/app/data/exports ./exports   # récupérer les contenus validés
docker compose up -d --build                   # après une modif du code
```

### Modifier la charte depuis Slack

`/contenu charte` ouvre une fenêtre pré-remplie avec les quatre parties de
`maison/CLAUDE.md` : entreprise et offres, public, ton, règles. À l'envoi :

- la charte est enregistrée et s'applique dès le contenu suivant, sans redémarrage ;
- un message dans le canal indique qui l'a modifiée ;
- l'ancienne version est archivée dans `/app/data/charte-historique/`.

Les autres sections du fichier (par exemple « Exemples ») ne sont pas touchées.
Chaque partie accepte 3 000 caractères au plus. Pour revenir à une ancienne
version :

```bash
docker compose exec orchestrateur ls /app/data/charte-historique
docker compose exec orchestrateur cp /app/data/charte-historique/<fichier> /app/maison/CLAUDE.md
```

Les rédacteurs lisent `maison/` en lecture seule. Seul l'orchestrateur peut
l'écrire.

## Choisir les modèles (plusieurs fournisseurs)

Chaque worker désigne un **moteur** dans `config/factory.json` (`"engine": "…"`). Les moteurs sont décrits dans la section `engines`, sans aucun secret : seulement le nom de la variable de `.env` qui porte la clé.

| Type de moteur | Pour | Exemple |
|---|---|---|
| `claude-code` | Rédacteurs | Claude, par abonnement ou clé Anthropic |
| `api` | Rédacteurs | Toute API compatible OpenAI : Vercel AI Gateway (`mistral/mistral-large-3`, `google/gemini-3.5-flash`, `deepseek/deepseek-v4-flash`…), Mistral en direct, OpenRouter, Ollama en local |
| `codex` | Illustrateur | Abonnement ChatGPT |
| `openai-responses` | Illustrateur | GPT-6 Astra + GPT Image, clé OpenAI |
| `chat-image` | Illustrateur | Modèles multimodaux via la passerelle (`google/gemini-3.1-flash-image`) |
| `images-api` | Illustrateur | Modèles d'image purs via la passerelle (`bfl/flux-2-pro`, `recraft/recraft-v4.1`) |

**Changer de modèle** : modifiez `"engine"` sur le worker, ou le `model` du moteur, puis lancez `docker compose restart orchestrateur`. Aucune reconstruction n'est nécessaire. Le modèle utilisé s'affiche sous chaque brouillon.

Avec la seule clé `AI_GATEWAY_API_KEY`, près de 390 modèles sont disponibles. La liste s'obtient avec `curl -H "Authorization: Bearer $AI_GATEWAY_API_KEY" https://ai-gateway.vercel.sh/v1/models`.

## Planning et publication dans Notion

La base Notion « Planning éditorial » est créée par `node scripts/notion-setup.mjs --yes`, avec `NOTION_TOKEN` dans `.env` et une page « Usine à contenu » connectée à l'intégration. Ses colonnes sont Sujet, Format (`blog` ou `social`), Date prévue, Statut, Slack et Publié le.

- **Planifier** : ajoutez une ligne dans Notion au statut « À faire », ou tapez `/contenu planifier 2026-10-05 blog Votre sujet` dans Slack.
- **Production automatique** : toutes les `planning.pollMinutes` minutes (5 par défaut), les sujets « À faire » dont la date est arrivée partent en production dans le canal `PLANNING_CHANNEL_ID`, ou à défaut dans le premier canal autorisé.
- **Suivi** : le statut évolue tout seul (À faire → En cours → À relire → Publié, ou Échec), et le lien vers le fil Slack est ajouté.
- **Publier** : après **Valider**, le bouton **📤 Publier sur Notion** écrit le contenu dans la page du sujet. Un contenu non planifié crée une nouvelle ligne, directement au statut « Publié ».

## Économiser des tokens

- **Rédacteurs allégés** : la charte et les exemples sont joints à la consigne, et Claude rédige en un seul passage, sans outils ni prompt système de Claude Code. Mesuré : environ 1 500 tokens pour un post LinkedIn, contre environ 89 000 auparavant. Le nombre de tokens s'affiche sous chaque brouillon.
- **JEV** (TypeSafe AI, via Vercel AI Gateway, clé `AI_GATEWAY_API_KEY`) ne rédige rien. Il répond à des questions typées pour environ 0,00002 $ :
  - **avant** : une demande trop vague (clarté sous `jev.briefThreshold`) reçoit une question au lieu d'une rédaction ;
  - **après** : un texte qui a passé les contrôles locaux est vérifié contre la charte (ton, faits inventés). Une nouvelle tentative n'a lieu que si JEV y voit un problème.
  - JEV n'est **jamais bloquant** : sans clé, ou s'il est saturé (erreur 429), l'usine continue sans lui. Les seuils se règlent dans `config/factory.json`, section `jev`.

## Ressources

| Conteneur | Limite | Usage typique |
|---|---|---|
| orchestrateur | 256 Mo, 0,5 CPU | ~100 Mo |
| redacteur-1 | 1,5 Go, 0,9 CPU | ~0,5 à 1,2 Go pendant une rédaction |
| redacteur-2 | 1,5 Go, 0,9 CPU | idem |

Les rédacteurs passent l'essentiel de leur temps à attendre l'API Anthropic.
Un seul CPU suffit donc pour deux rédactions en parallèle. Les 4 Go de swap
absorbent les pics de mémoire.

## Sécurité

- Aucun port entrant. Slack est joint par une connexion sortante (Socket Mode), et les rédacteurs ne sont accessibles que depuis le réseau interne de Docker, avec un secret partagé.
- Les rédacteurs n'ont que la clé Anthropic, jamais les tokens Slack. Claude Code n'y a droit qu'aux outils de lecture (`Read`, `Glob`, `Grep`) : pas de commande shell, pas d'écriture.
- `ALLOWED_USER_IDS` et `ALLOWED_CHANNEL_IDS` limitent qui peut demander et valider. Une demande coûte des crédits API.
- Le texte de la demande est transmis à l'agent. Le prompt le traite comme un sujet, mais restez sur un canal réservé aux personnes de confiance.

## Limites connues de la démo

- Pas de publication automatique : le contenu validé est joint au fil en Markdown et gardé dans `/app/data/exports`.
- Pas de visuels. Il faudrait une API d'images externe.
- Au-delà de ~11 500 caractères, le brouillon est tronqué dans Slack. Le fichier complet est joint à la validation.
- Pour aller plus loin : publication CMS ou Notion, génération de visuels, plus de rédacteurs sur un VPS plus gros (il suffit d'ajouter des lignes dans `config/factory.json` et `docker-compose.yml`).

## Licence

MIT, voir `LICENSE`.
