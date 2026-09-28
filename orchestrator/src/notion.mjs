// Le planning éditorial dans Notion : lire les sujets à produire, suivre leur
// statut, publier le contenu validé.
//
// L'usine se branche sur une base existante : les noms des colonnes et les
// valeurs de statut et de format viennent de config/factory.json
// (notion.planning), avec pour défaut la base "Planning éditorial" que crée
// scripts/notion-setup.mjs. Exemple pour un calendrier maison :
//
//   "planning": {
//     "database": "env:NOTION_DATABASE_ID",
//     "columns": { "subject": "Titre", "format": "Canal", "date": "Date de publication",
//                  "status": "État", "slack": null, "publishedAt": null },
//     "formatValues": { "LinkedIn": "social", "Blog": "blog" },
//     "statusValues": { "todo": "À écrire", "running": "En rédaction", "review": "En relecture",
//                       "published": "Publié", "failed": "Bloqué" }
//   }
import { dataSource, equalsFilter, notion, pageMarkdown, queryAll, readProperty, resolveId, writeProperty } from "./notionClient.mjs"

const DEFAULT_PLANNING = {
  database: "env:NOTION_DATABASE_ID",
  columns: { subject: "Sujet", format: "Format", date: "Date prévue", status: "Statut", slack: "Slack", publishedAt: "Publié le" },
  formatValues: { blog: "blog", social: "social" },
  statusValues: { todo: "À faire", running: "En cours", review: "À relire", published: "Publié", failed: "Échec" },
}

const planning = (config) => {
  const p = config.notion?.planning ?? {}
  return {
    database: p.database ?? DEFAULT_PLANNING.database,
    columns: { ...DEFAULT_PLANNING.columns, ...(p.columns ?? {}) },
    formatValues: p.formatValues ?? DEFAULT_PLANNING.formatValues,
    statusValues: { ...DEFAULT_PLANNING.statusValues, ...(p.statusValues ?? {}) },
  }
}

// Les états de l'usine. Leurs libellés dans Notion viennent de statusValues.
export const STATUTS = { todo: "todo", running: "running", review: "review", published: "published", failed: "failed" }

export const notionEnabled = (config) => Boolean(config.notionToken && resolveId(planning(config).database))

// Format Notion -> type de l'usine, et l'inverse pour écrire.
const toType = (p, value) => p.formatValues[value] ?? null
const fromType = (p, type) => Object.entries(p.formatValues).find(([, t]) => t === type)?.[0] ?? null

// Les sujets "à faire" dont la date prévue est arrivée.
export async function dueItems(config) {
  const p = planning(config)
  const schema = await dataSource(config, p.database)
  const c = p.columns
  const pages = await queryAll(config, schema.id, {
    filter: { and: [equalsFilter(schema, c.status, p.statusValues.todo), { property: c.date, date: { on_or_before: new Date().toISOString() } }] },
    sorts: [{ property: c.date, direction: "ascending" }],
  }, 20)
  return pages
    .map((page) => {
      const raw = c.format ? readProperty(page.properties[c.format]) : null
      const value = Array.isArray(raw) ? raw[0] : raw
      return { pageId: page.id, sujet: String(readProperty(page.properties[c.subject]) ?? "").trim(), rawFormat: value ?? null, format: value ? toType(p, value) : null }
    })
    // Un format que l'usine ne produit pas (une newsletter, une vidéo…) reste
    // pour les humains : on n'y touche pas. Sans format, on prend le format par défaut.
    .filter((item) => !item.rawFormat || item.format)
}

// Met à jour une ligne du planning. fields : { statut, slackUrl, publieLe, sujet, format, datePrevue }
// Une colonne absente de la correspondance (null) est ignorée.
export async function setItem(config, pageId, fields) {
  const p = planning(config)
  const schema = await dataSource(config, p.database)
  return notion(config, `/pages/${pageId}`, { method: "PATCH", body: { properties: planningProperties(p, schema, fields) } })
}

function planningProperties(p, schema, { statut, slackUrl, publieLe, sujet, format, datePrevue }) {
  const c = p.columns
  const props = {}
  const set = (column, value) => {
    if (column && value !== undefined) props[column] = writeProperty(schema, column, value)
  }
  set(c.subject, sujet)
  set(c.format, format === undefined ? undefined : fromType(p, format))
  set(c.status, statut === undefined ? undefined : p.statusValues[statut])
  set(c.date, datePrevue)
  set(c.slack, slackUrl)
  set(c.publishedAt, publieLe)
  return props
}

// Ajoute un sujet au planning (depuis /contenu planifier).
export async function addPlanningItem(config, { sujet, format, datePrevue }) {
  const p = planning(config)
  const schema = await dataSource(config, p.database)
  const page = await notion(config, "/pages", {
    method: "POST",
    body: { parent: { type: "data_source_id", data_source_id: schema.id }, properties: planningProperties(p, schema, { sujet, format, datePrevue, statut: STATUTS.todo }) },
  })
  return page.url
}

// Publie un contenu validé. Un sujet venu du planning est écrit dans sa propre
// page. Sinon, une nouvelle ligne est créée, déjà au statut "publié".
export async function publish(config, request) {
  const p = planning(config)
  const schema = await dataSource(config, p.database)
  const now = new Date().toISOString()
  if (request.notion_page_id) {
    await notion(config, `/pages/${request.notion_page_id}/markdown`, {
      method: "PATCH",
      body: { type: "replace_content", replace_content: { new_str: request.draft } },
    })
    const page = await setItem(config, request.notion_page_id, { statut: STATUTS.published, publieLe: now })
    return page.url
  }
  const title = /^#\s+(.+)$/m.exec(request.draft)?.[1] ?? request.brief.slice(0, 100)
  const page = await notion(config, "/pages", {
    method: "POST",
    body: {
      parent: { type: "data_source_id", data_source_id: schema.id },
      properties: planningProperties(p, schema, { sujet: title, format: request.type, statut: STATUTS.published, publieLe: now }),
      markdown: request.draft,
    },
  })
  return page.url
}

// Garde le statut Notion d'un sujet planifié en phase avec l'usine. Ne bloque
// jamais : une erreur Notion est seulement notée dans les journaux.
export async function syncStatus(config, request, statut) {
  if (!notionEnabled(config) || !request.notion_page_id) return
  await setItem(config, request.notion_page_id, { statut }).catch((error) => console.warn(`Notion (statut #${request.id}) : ${error.message}`))
}

export { pageMarkdown }
