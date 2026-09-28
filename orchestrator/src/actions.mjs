// Les actions confiées au superviseur (voir superviseur/server.mjs) : changer une
// clé, changer le nombre de workers, redémarrer, mettre à jour, connecter
// ChatGPT. L'orchestrateur dépose un fichier dans actions/, le superviseur
// répond dans actions/results/. Le suivi est gardé dans SQLite : un résultat
// arrivé pendant un redémarrage de l'orchestrateur n'est pas perdu.
//
// Les paramètres ne sont jamais gardés dans SQLite (ils peuvent contenir une
// clé) ; le fichier d'action lui-même est effacé par le superviseur.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { randomBytes } from "node:crypto"
import { join } from "node:path"

export const ACTION_LABELS = {
  "set-secret": "Changement de clé",
  "set-workers": "Changement du nombre de workers",
  restart: "Redémarrage",
  update: "Mise à jour",
  "update-fin": "Fin de la mise à jour",
  "codex-login": "Connexion ChatGPT de l'illustrateur",
  "codex-login-fin": "Connexion ChatGPT",
}

export function initActions(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS actions (
      id       TEXT PRIMARY KEY,
      type     TEXT NOT NULL,
      summary  TEXT,
      by       TEXT NOT NULL,
      status   TEXT NOT NULL DEFAULT 'pending',
      message  TEXT,
      created  TEXT NOT NULL DEFAULT (datetime('now')),
      done     TEXT
    );
  `)
}

const actionsDir = (config) => config.actionsDir ?? "/app/actions"
export const supervisorAvailable = (config) => existsSync(actionsDir(config))

// Dépose une action. summary : ce qu'on affichera (jamais la valeur d'une clé).
export function requestAction({ config, db }, type, params, { by, summary }) {
  if (!supervisorAvailable(config)) throw new Error("le superviseur n'est pas installé (dossier actions/ absent) : relancez install.sh ou update.sh sur le serveur")
  const id = `${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomBytes(3).toString("hex")}`
  const file = join(actionsDir(config), `${id}.json`)
  writeFileSync(`${file}.tmp`, JSON.stringify({ id, type, params, by }), { mode: 0o600 })
  renameSync(`${file}.tmp`, file)
  db.prepare("INSERT INTO actions (id, type, summary, by) VALUES (?, ?, ?, ?)").run(id, type, summary ?? ACTION_LABELS[type] ?? type, by)
  return id
}

export const pendingActions = (db) => db.prepare("SELECT * FROM actions WHERE status = 'pending' ORDER BY created").all()
export const recentActions = (db, limit = 5) => db.prepare("SELECT * FROM actions WHERE status != 'pending' ORDER BY done DESC LIMIT ?").all(limit)

// Relève les résultats. onDone(action) : prévenir la personne, rafraîchir le panneau.
export function startActionWatcher({ config, db }, onDone) {
  const results = join(actionsDir(config), "results")
  const tick = async () => {
    if (!existsSync(results)) return
    for (const action of pendingActions(db)) {
      const file = join(results, `${action.id}.json`)
      if (!existsSync(file)) continue
      let result
      try {
        result = JSON.parse(readFileSync(file, "utf8"))
      } catch {
        continue // en cours d'écriture
      }
      db.prepare("UPDATE actions SET status = ?, message = ?, done = datetime('now') WHERE id = ?").run(result.ok ? "ok" : "failed", result.message ?? "", action.id)
      // Une action en deux temps (mise à jour, connexion ChatGPT) annonce son
      // résultat final plus tard, sous un second identifiant.
      if (result.ok && result.followUp) {
        const type = result.followUpType ?? "update-fin"
        db.prepare("INSERT OR IGNORE INTO actions (id, type, summary, by) VALUES (?, ?, ?, ?)").run(result.followUp, type, ACTION_LABELS[type] ?? type, action.by)
      }
      await onDone({ ...action, ok: result.ok, message: result.message, extra: result }).catch((e) => console.error("Action (notification) :", e.message))
    }
  }
  setInterval(() => tick().catch((e) => console.error("Actions :", e.message)), 3_000)
  tick().catch(() => {})
}
