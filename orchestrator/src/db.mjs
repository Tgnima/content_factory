// L'état de l'usine dans un seul fichier SQLite : les demandes, leur statut,
// et quel rédacteur travaille sur quoi. Un seul processus y écrit (cet
// orchestrateur), ce qui rend la réservation d'un rédacteur sans ambiguïté.
//
// Statuts d'une demande :
//   new (le temps de poster le message Slack)
//   queued -> running -> review -> approved
//                 |         |
//                 v         +-- "Corriger" --> queued (avec feedback)
//              failed ou question (le rédacteur demande une précision)
import { DatabaseSync } from "node:sqlite"

export function openDb(path) {
  const db = new DatabaseSync(path)
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS requests (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id      TEXT NOT NULL,
      channel_id   TEXT NOT NULL,
      thread_ts    TEXT,
      type         TEXT NOT NULL,
      brief        TEXT NOT NULL,
      status       TEXT NOT NULL DEFAULT 'queued',
      worker_id    TEXT,
      draft        TEXT,
      feedback     TEXT,
      draft_msg_ts TEXT,
      revisions    INTEGER NOT NULL DEFAULT 0,
      cost_usd     REAL NOT NULL DEFAULT 0,
      error        TEXT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)

  // Colonnes ajoutées avec les visuels. Une base créée avant les reçoit ici.
  //   status_ts  : le message qui porte les réactions d'état. D'habitude le
  //                message d'origine, mais un visuel demandé depuis un brouillon
  //                vit dans le fil de l'article et a son propre message.
  //   image_path : l'image générée, dans data/images/.
  const columns = new Set(db.prepare("PRAGMA table_info(requests)").all().map((c) => c.name))
  //   pack_id    : la demande "pack" dont fait partie cet élément.
  //   notion_page_id : la ligne du planning Notion d'où vient la demande.
  //   notion_url : la page Notion où le contenu a été publié.
  //   library_url : la page du contexte si le contenu est devenu une référence.
  for (const [name, type] of [["status_ts", "TEXT"], ["image_path", "TEXT"], ["pack_id", "INTEGER"], ["notion_page_id", "TEXT"], ["notion_url", "TEXT"], ["library_url", "TEXT"]]) {
    if (!columns.has(name)) db.exec(`ALTER TABLE requests ADD COLUMN ${name} ${type}`)
  }
  return db
}

// Une demande naît en "new" : le dispatcher l'ignore tant que son fil Slack
// n'existe pas.
export const createRequest = (db, { userId, channelId, type, brief, threadTs = null }) =>
  Number(db.prepare("INSERT INTO requests (user_id, channel_id, type, brief, thread_ts, status) VALUES (?, ?, ?, ?, ?, 'new')").run(userId, channelId, type, brief, threadTs).lastInsertRowid)

export const getRequest = (db, id) => db.prepare("SELECT * FROM requests WHERE id = ?").get(id)

export function updateRequest(db, id, fields) {
  const keys = Object.keys(fields)
  const sets = keys.map((k) => `${k} = ?`).join(", ")
  db.prepare(`UPDATE requests SET ${sets}, updated_at = datetime('now') WHERE id = ?`).run(...keys.map((k) => fields[k]), id)
}

// Position d'une demande dans la file (1 = la prochaine servie).
export const queuePosition = (db, id) =>
  db.prepare("SELECT COUNT(*) AS n FROM requests WHERE status = 'queued' AND id <= ?").get(id).n

export const busyWorkerIds = (db) => db.prepare("SELECT worker_id FROM requests WHERE status = 'running'").all().map((r) => r.worker_id)

// Réserve la plus ancienne demande en attente que ce rédacteur sait traiter.
// Tout se passe dans une transaction : la demande passe à "running" avec le nom
// du rédacteur, ou rien ne change.
export function claimNextRequest(db, worker) {
  db.exec("BEGIN IMMEDIATE")
  try {
    const marks = worker.types.map(() => "?").join(", ")
    const next = db.prepare(`SELECT * FROM requests WHERE status = 'queued' AND type IN (${marks}) ORDER BY id LIMIT 1`).get(...worker.types)
    if (next) db.prepare("UPDATE requests SET status = 'running', worker_id = ?, updated_at = datetime('now') WHERE id = ?").run(worker.id, next.id)
    db.exec("COMMIT")
    return next ? { ...next, status: "running", worker_id: worker.id } : null
  } catch (error) {
    db.exec("ROLLBACK")
    throw error
  }
}

// Au redémarrage, une demande restée "running" a perdu son suivi : on la remet
// en file. Le rédacteur, lui, a été redémarré avec l'orchestrateur ou finira
// sa rédaction dans le vide.
export const requeueInterrupted = (db) => db.prepare("UPDATE requests SET status = 'queued', worker_id = NULL WHERE status = 'running'").run().changes
