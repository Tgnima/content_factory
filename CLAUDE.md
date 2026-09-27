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
| `config/factory.json` | Workers et moteurs, formats, pack, planning, JEV, termes interdits | `setup.mjs` pour les workers et moteurs. Le reste à la main |
| `docker-compose.yml` | Généré par `setup.mjs` selon le nombre de workers | Ne pas modifier à la main : relancer l'assistant |
| `maison/` | Charte éditoriale et exemples | La personne, ou `/contenu charte` dans Slack |

## Règles pour modifier le code

- Node ES modules, sans framework. Une seule dépendance : `@slack/bolt`, pour l'orchestrateur.
- Les workers ne reçoivent que les clés de modèles, jamais les tokens Slack ni Notion.
- JEV et Notion sont facultatifs et ne doivent jamais bloquer une demande.
- Les outils s'installent en dernière version (`@latest`). C'est un choix assumé : après une reconstruction, on teste une demande.
- Commentaires et messages en français.
