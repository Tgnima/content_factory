// Notion : le planning éditorial (une base de données) et la publication.
//
// Colonnes de la base "Planning éditorial" (créée par scripts/notion-setup.mjs) :
//   Sujet (titre) · Format (blog|social) · Date prévue · Statut · Slack · Publié le
// Statut : À faire -> En cours -> À relire -> Publié (ou Échec)
//
// API Notion 2026-03-11 : une base contient une ou plusieurs "data sources".
// On lit et on écrit dans la première.
const API = "https://api.notion.com/v1"
const VERSION = "2026-03-11"

export const STATUTS = { todo: "À faire", running: "En cours", review: "À relire", published: "Publié", failed: "Échec" }

export const notionEnabled = (config) => Boolean(config.notionToken && config.notionDatabaseId)

async function notion(config, path, { method = "GET", body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${config.notionToken}`, "Notion-Version": VERSION, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`Notion ${res.status} : ${json.message ?? JSON.stringify(json).slice(0, 300)}`)
  return json
}

let dataSourceId = null
async function getDataSourceId(config) {
  if (!dataSourceId) {
    const db = await notion(config, `/databases/${config.notionDatabaseId}`)
    dataSourceId = db.data_sources?.[0]?.id
    if (!dataSourceId) throw new Error("La base Notion n'a pas de source de données.")
  }
  return dataSourceId
}

const text = (value) => [{ type: "text", text: { content: String(value).slice(0, 2000) } }]
const plain = (richText) => (richText ?? []).map((t) => t.plain_text ?? "").join("")

function properties({ sujet, format, statut, datePrevue, slackUrl, publieLe }) {
  const props = {}
  if (sujet !== undefined) props["Sujet"] = { title: text(sujet) }
  if (format !== undefined) props["Format"] = { select: { name: format } }
  if (statut !== undefined) props["Statut"] = { select: { name: statut } }
  if (datePrevue !== undefined) props["Date prévue"] = { date: { start: datePrevue } }
  if (slackUrl !== undefined) props["Slack"] = { url: slackUrl }
  if (publieLe !== undefined) props["Publié le"] = { date: { start: publieLe } }
  return props
}

// Les sujets "À faire" dont la date prévue est arrivée.
export async function dueItems(config) {
  const ds = await getDataSourceId(config)
  const result = await notion(config, `/data_sources/${ds}/query`, {
    method: "POST",
    body: {
      filter: {
        and: [
          { property: "Statut", select: { equals: STATUTS.todo } },
          { property: "Date prévue", date: { on_or_before: new Date().toISOString() } },
        ],
      },
      sorts: [{ property: "Date prévue", direction: "ascending" }],
      page_size: 20,
    },
  })
  return result.results.map((page) => ({
    pageId: page.id,
    sujet: plain(page.properties["Sujet"]?.title).trim(),
    format: page.properties["Format"]?.select?.name ?? null,
  }))
}

export const setItem = (config, pageId, fields) => notion(config, `/pages/${pageId}`, { method: "PATCH", body: { properties: properties(fields) } })

// Ajoute un sujet au planning (depuis /contenu planifier).
export async function addPlanningItem(config, { sujet, format, datePrevue }) {
  const ds = await getDataSourceId(config)
  const page = await notion(config, "/pages", {
    method: "POST",
    body: { parent: { type: "data_source_id", data_source_id: ds }, properties: properties({ sujet, format, datePrevue, statut: STATUTS.todo }) },
  })
  return page.url
}

// Publie un contenu validé. Un sujet venu du planning est écrit dans sa propre
// page. Sinon, une nouvelle ligne est créée, déjà au statut "Publié".
export async function publish(config, request) {
  const now = new Date().toISOString()
  if (request.notion_page_id) {
    await notion(config, `/pages/${request.notion_page_id}/markdown`, {
      method: "PATCH",
      body: { type: "replace_content", replace_content: { new_str: request.draft } },
    })
    const page = await setItem(config, request.notion_page_id, { statut: STATUTS.published, publieLe: now })
    return page.url
  }
  const ds = await getDataSourceId(config)
  const title = /^#\s+(.+)$/m.exec(request.draft)?.[1] ?? request.brief.slice(0, 100)
  const page = await notion(config, "/pages", {
    method: "POST",
    body: {
      parent: { type: "data_source_id", data_source_id: ds },
      properties: properties({ sujet: title, format: request.type, statut: STATUTS.published, publieLe: now }),
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
