# Usine à contenu

Une usine à contenu pilotée depuis Slack. `/contenu` fait rédiger des articles, des posts et des visuels par des workers (des conteneurs Docker), avec relecture dans le fil, charte éditoriale, planning et publication dans Notion. Voir `README.md`.

## Si l'on te demande d'installer ou de configurer le projet

Utilise le skill `configurer-usine` (`.claude/skills/configurer-usine/SKILL.md`). En résumé :

1. `node scripts/setup.mjs --print-questions` donne les questions, les choix possibles et l'endroit où trouver chaque secret.
2. Pose ces questions à la personne, une par une, en proposant le défaut.
3. **Ne demande jamais un secret dans la conversation.** La personne colle ses clés elle-même dans `.env`, créé depuis `.env.example`. Tu vérifies ensuite avec `node scripts/setup.mjs --check`, qui n'affiche jamais les valeurs.
4. Écris les réponses dans `setup.answers.json` (ignoré par Git, sans aucun secret), puis lance `bash install.sh --answers setup.answers.json --yes` sur le serveur.
5. Les connexions par abonnement (Claude, ChatGPT) demandent un navigateur et un terminal interactif. Donne à la personne la commande exacte que `install.sh` affiche, et laisse-la faire.

## Où sont les réglages

| Fichier | Contenu | Qui le modifie |
|---|---|---|
| `.env` | Secrets et identifiants (Slack, clés de modèles, Notion) | La personne, ou `setup.mjs` |
| `config/factory.json` | Workers et moteurs, formats, pack, planning, JEV, termes interdits. Non suivi par Git, créé depuis `config/factory.example.json` | `setup.mjs` pour les workers et moteurs. Le reste à la main |
| `docker-compose.yml` | Généré par `setup.mjs` selon les workers. Non suivi par Git | Ne pas modifier à la main : relancer l'assistant |
| `maison/` | Charte éditoriale et exemples. Non suivi par Git, créé une fois depuis `maison.example/` | La personne, ou `/contenu charte` dans Slack. Ne jamais l'écraser |

**Après l'installation, tout se règle sans le serveur.** Il y a deux surfaces :
- **le panneau Slack**, dans l'onglet Accueil, réservé aux administrateurs (`orchestrator/src/admin.mjs`), pour les modèles, les accès, le branchement Notion, les clés, les workers et la mise à jour ;
- **les bases Notion « Réglages : formats » et « Réglages : règles »** (`editorial.mjs`), pour l'éditorial.

Les réglages immédiats vont dans `data/overrides.json` (`settings.mjs`). Ceux qui demandent Docker passent par le **superviseur** (`superviseur/server.mjs`), qui exécute une liste fermée d'actions. N'ajoute jamais l'accès à Docker à l'orchestrateur. Une nouvelle action se déclare à la fois dans `superviseur/server.mjs` (HANDLERS) et dans `orchestrator/src/actions.mjs`. Une nouvelle règle éditoriale s'ajoute dans `RULES` (`editorial.mjs`), et `notion-setup.mjs` la pré-remplira.

**Plug and play** : l'usine se branche sur les bases Notion existantes de l'entreprise, au lieu d'imposer les siennes. `node scripts/notion-connect.mjs --json` décrit les bases visibles et propose les correspondances. Montre-les à la personne, ajuste avec elle, puis écris-les avec `--apply`. Le contexte de l'entreprise (références, faits vérifiés, codes, cibles, identité visuelle, interdits) est lu depuis `context.sources`, et le code ne suppose aucun nom de colonne (`orchestrator/src/notionClient.mjs`).

**Mettre à jour une installation** : `bash update.sh` (git pull, puis `setup.mjs --upgrade` qui ajoute les nouveaux réglages sans rien écraser, puis reconstruction). Un nouveau réglage du code s'ajoute dans `config/factory.example.json` : `--upgrade` le reportera chez chacun.

## Règles pour modifier le code

- Node ES modules, sans framework. Une seule dépendance : `@slack/bolt`, pour l'orchestrateur.
- Les workers ne reçoivent que les clés de modèles, jamais les tokens Slack ni Notion.
- JEV et Notion sont facultatifs et ne doivent jamais bloquer une demande.
- Les outils s'installent en dernière version (`@latest`). C'est un choix assumé : après une reconstruction, on teste une demande.
- Commentaires et messages en français.
