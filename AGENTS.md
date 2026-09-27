# Instructions pour les agents (Codex, Cursor, etc.)

Les mêmes que pour Claude Code : lisez `CLAUDE.md`, puis la procédure de configuration dans `.claude/skills/configurer-usine/SKILL.md`.

En une phrase : on ne modifie pas le code pour configurer. On pose les questions de `node scripts/setup.mjs --print-questions`, la personne colle ses secrets elle-même dans `.env`, puis on lance `bash install.sh --answers setup.answers.json --yes`.
