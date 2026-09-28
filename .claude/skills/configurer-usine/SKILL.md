---
name: configurer-usine
description: Installer ou reconfigurer l'usine à contenu (Slack, workers, modèles, Notion) en posant des questions simples à la personne. À utiliser quand quelqu'un vient de cloner le projet, veut l'installer sur un serveur, changer de modèle ou de fournisseur, ajouter ou retirer des rédacteurs, activer les visuels, JEV ou Notion, ou vérifier que sa configuration fonctionne.
---

# Configurer l'usine à contenu

Tu aides une personne, souvent non technique, à configurer ce projet sans toucher au code. Tout passe par `scripts/setup.mjs` et `install.sh`. Tu ne modifies ni le code ni `docker-compose.yml` à la main.

## Règles

- **Aucun secret dans la conversation.** Tu ne demandes, ne lis et ne recopies jamais une clé. La personne les colle dans `.env`. Pour vérifier, utilise `node scripts/setup.mjs --check` : il teste les clés sans les afficher. Si elle colle quand même un secret dans le chat, écris-le dans `.env`, ne le répète pas, et conseille-lui de le renouveler plus tard.
- **Une question à la fois**, avec le défaut proposé et une phrase d'explication. La personne peut répondre « défaut ».
- **Tu dis ce que tu as vérifié.** « Écrit » n'est pas « testé ».
- Les actions qui coûtent de l'argent (crédits d'API, abonnements) ou qui touchent au serveur (Docker, swap) : explique-les d'abord, puis demande l'accord.

## Étapes

### 1. Charger les questions

```bash
node scripts/setup.mjs --print-questions
```

Tu obtiens la liste `questions` (id, question, défaut, choix) et `secrets` (où trouver chaque clé). Les questions marquées `conditional` ne se posent que si elles ont un sens (par exemple, le modèle Claude seulement si un rédacteur utilise Claude).

### 2. Mener l'entretien

Pose les questions dans l'ordre. Conseils pour aider la personne à choisir :

- **Nombre de rédacteurs.** Compte environ 1,2 Go de RAM par rédacteur Claude. Les rédacteurs « api » (passerelle, Mistral…) sont bien plus légers. Sur 4 Go : 2 rédacteurs et un illustrateur.
- **Moteurs de rédaction.**
  - `claude` : Claude. L'abonnement Pro/Max convient à un usage personnel. Pour une équipe, prends une clé API.
  - `mistral`, `gemini`, `deepseek`, `gateway-autre` : une seule clé Vercel AI Gateway donne accès à environ 390 modèles.
  - `ollama-local` : un modèle sur le serveur, sans clé. Il faut beaucoup de RAM.
- **Plusieurs moteurs à la fois** : une liste, par exemple `["claude", "mistral"]`. Chaque rédacteur prend le suivant, et le dernier est répété.
- **Visuels.**
  - `images-flux` : sobre, sans texte parasite.
  - `images-gemini` : très réaliste, mais ajoute parfois du faux texte dans l'image.
  - `images-codex` : abonnement ChatGPT.
  - `images-openai` : clé OpenAI.
- **JEV** : un contrôle très bon marché de la clarté des demandes et de la charte. Il demande des crédits Vercel et n'est jamais bloquant.
- **Notion** : le planning éditorial avec production automatique, et le bouton Publier. Il faut une intégration Notion, et une page connectée à cette intégration.

Pour `gateway-autre`, vérifie l'identifiant exact du modèle. `setup.mjs` signale un modèle introuvable, et la liste s'obtient avec :

```bash
curl -s -H "Authorization: Bearer $AI_GATEWAY_API_KEY" https://ai-gateway.vercel.sh/v1/models
```

### 3. Les secrets

D'après les réponses, liste les clés nécessaires :
- toujours `SLACK_BOT_TOKEN` et `SLACK_APP_TOKEN` ;
- selon les moteurs : `CLAUDE_CODE_OAUTH_TOKEN` ou `ANTHROPIC_API_KEY`, `AI_GATEWAY_API_KEY`, `OPENAI_API_KEY`, `MISTRAL_API_KEY`, `OPENROUTER_API_KEY`, `LLM_API_KEY` ;
- `NOTION_TOKEN` si Notion est activé.

Pour chacune, donne l'endroit où la trouver (champ `secrets` de `--print-questions`). Demande ensuite à la personne de la coller dans `.env`, qui se crée depuis `.env.example` s'il n'existe pas. Laisse `CLAUDE_CODE_OAUTH_TOKEN` vide pour un abonnement : `install.sh` le génère.

Si l'app Slack n'existe pas encore : api.slack.com/apps, puis **Create New App**, puis **From a manifest**, avec le contenu de `slack-manifest.yml`. Ensuite, créer un App-Level Token avec le scope `connections:write`, puis **Install App**.

### 4. Écrire les réponses et installer

Écris `setup.answers.json` (ignoré par Git, sans secret), sur le modèle de `setup.answers.example.json`. Puis, **sur le serveur** :

```bash
bash install.sh --answers setup.answers.json --yes
```

`--yes` accepte l'installation de Docker et la création du swap : demande d'abord l'accord de la personne. Le script :
1. teste chaque clé et chaque modèle ;
2. écrit `.env`, `config/factory.json` et `docker-compose.yml` ;
3. crée la base Notion ;
4. construit les images et démarre l'usine.

Sans terminal interactif, il **affiche** les commandes de connexion par abonnement au lieu de les lancer.

### 5. Connexions par abonnement

Si `install.sh` les signale, donne ces commandes à la personne pour qu'elle les lance dans son terminal :

| Connexion | Commande à lancer | Ensuite |
|---|---|---|
| Claude | `docker compose run --rm --no-deps --entrypoint claude redacteur-1 setup-token` | Coller le token dans `.env` (`CLAUDE_CODE_OAUTH_TOKEN=`), puis `docker compose up -d` |
| ChatGPT | `docker compose exec -it illustrateur-1 codex login --device-auth` | Si ChatGPT refuse : Paramètres > Sécurité > connexion par code d'appareil |

### 6. Vérifier

```bash
node scripts/setup.mjs --check
docker compose ps
docker compose logs --since 5m orchestrateur
```

Les journaux doivent afficher `redacteur-N (…) : prêt` pour chaque worker, puis `Usine à contenu connectée à Slack`. Fais ensuite tester dans Slack :
- `/invite @<nom du bot>` dans le canal ;
- `/contenu social <un sujet précis>`.

## Brancher l'usine sur les bases existantes (plug and play)

Si la personne a déjà un calendrier éditorial, des posts publiés, des fiches produits ou une charte dans Notion, **branche l'usine dessus** plutôt que de lui faire créer de nouvelles bases :

1. Demande-lui de partager ces bases avec l'intégration Notion (••• > Connexions).
2. Lance `node scripts/notion-connect.mjs --json`. Pour chaque base, tu obtiens ses colonnes et ses valeurs, et deux correspondances proposées : `asPlanning` et `asContext`.
3. Présente les propositions simplement, par exemple : « votre colonne *Canal* servira de format, *LinkedIn* = post, *Blog* = article ; *En rédaction* = en cours ». Fais corriger ce qui ne va pas. Pour le contexte, vérifie avec elle :
   - le **type** de chaque base : références, faits vérifiés, codes de marque, cibles, identité visuelle, à éviter ;
   - le **filtre**, par exemple seulement les posts au statut « Publié ».
4. Écris `{ "planning": {…}, "sources": [ … ] }` dans un fichier, puis lance `node scripts/notion-connect.mjs --apply fichier.json` et `docker compose restart orchestrateur`.
5. Vérifie dans Slack avec `/contenu contexte liste`, puis `/contenu contexte sync`.

Ne pas brancher de calendrier : l'usine garde son « Planning éditorial ». Ne pas brancher de contexte : sa « Bibliothèque de marque » et `maison/exemples/` suffisent pour commencer.

## Après l'installation

Rappelle à la personne qu'**elle n'a plus besoin du serveur**. Tout se règle depuis :
- **l'onglet Accueil** de l'app Slack, si elle est administratrice : modèles, accès, branchement Notion, clés, workers, connexion ChatGPT, mise à jour ;
- **les bases Notion « Réglages : formats » et « Réglages : règles »** : formats, longueurs, consignes, termes interdits, JEV, pack, fréquence du planning.

Vérifie qu'au moins un administrateur est déclaré (`ADMIN_USER_IDS`). Sinon, le panneau reste inaccessible.

## Mettre à jour le code

`bash update.sh` sur le serveur. Il ne touche ni à `.env`, ni à `config/factory.json`, ni à `maison/`. Il signale les nouvelles variables ajoutées vides dans `.env` : si l'une d'elles est nécessaire, explique à la personne où trouver la valeur.

## Changer un réglage plus tard

Relance l'entretien, seulement pour ce qui change, puis `bash install.sh --answers setup.answers.json --yes`. Pour un simple changement de modèle, il suffit de modifier `config/factory.json` (`engines` et `workers[].engine`), puis de lancer `docker compose restart orchestrateur`. Aucune reconstruction n'est nécessaire.
