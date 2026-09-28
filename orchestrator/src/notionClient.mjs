// Client Notion générique : l'usine se branche sur des bases existantes, avec
// leurs propres noms de colonnes et leurs propres types (select ou status,
// texte ou titre…). Rien ici ne suppose un schéma fixe : on lit le schéma de
// la base, puis on lit et écrit chaque colonne selon son type réel.
const API = "https://api.notion.com/v1"
const VERSION = "2026-03-11"

export async function notion(config, path, { method = "GET", body } = {}) {
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

// "env:NOM" -> la valeur de la variable NOM ; sinon l'identifiant tel quel.
export const resolveId = (value) => (typeof value === "string" && value.startsWith("env:") ? process.env[value.slice(4)] ?? "" : value ?? "")

// Accepte l'identifiant d'une base (database) ou directement d'une source de
// données (data source), et renvoie { id, properties } de la source.
const schemas = new Map()
export async function dataSource(config, databaseOrSourceId) {
  const key = resolveId(databaseOrSourceId)
  if (!key) throw new Error("Identifiant de base Notion vide (voir config/factory.json et .env).")
  if (!schemas.has(key)) {
    let source
    try {
      const db = await notion(config, `/databases/${key}`)
      source = await notion(config, `/data_sources/${db.data_sources[0].id}`)
    } catch {
      source = await notion(config, `/data_sources/${key}`)
    }
    schemas.set(key, { id: source.id, title: plainText(source.title), properties: source.properties })
  }
  return schemas.get(key)
}
export const forgetSchemas = () => schemas.clear()

export const plainText = (rich) => (rich ?? []).map((t) => t.plain_text ?? t.text?.content ?? "").join("")

// La valeur lisible d'une colonne, quel que soit son type.
export function readProperty(prop) {
  if (!prop) return null
  switch (prop.type) {
    case "title":
    case "rich_text":
      return plainText(prop[prop.type])
    case "select":
    case "status":
      return prop[prop.type]?.name ?? null
    case "multi_select":
      return prop.multi_select.map((o) => o.name)
    case "checkbox":
      return prop.checkbox
    case "number":
      return prop.number
    case "url":
    case "email":
    case "phone_number":
      return prop[prop.type]
    case "date":
      return prop.date?.start ?? null
    default:
      return null
  }
}

// Une valeur à écrire, mise en forme selon le type réel de la colonne.
export function writeProperty(schema, name, value) {
  const type = schema.properties[name]?.type
  if (!type) throw new Error(`La base Notion n'a pas de colonne "${name}".`)
  const text = (v) => [{ type: "text", text: { content: String(v).slice(0, 2000) } }]
  switch (type) {
    case "title":
      return { title: text(value) }
    case "rich_text":
      return { rich_text: text(value) }
    case "select":
      return { select: value ? { name: value } : null }
    case "status":
      return { status: value ? { name: value } : null }
    case "multi_select":
      return { multi_select: [].concat(value ?? []).map((n) => ({ name: n })) }
    case "checkbox":
      return { checkbox: Boolean(value) }
    case "date":
      return { date: value ? { start: value } : null }
    case "url":
      return { url: value || null }
    case "number":
      return { number: value === null || value === undefined ? null : Number(value) }
    default:
      throw new Error(`La colonne "${name}" est de type ${type}, que l'usine ne sait pas écrire.`)
  }
}

// Un filtre "colonne = valeur", selon le type de la colonne.
export function equalsFilter(schema, name, value) {
  const type = schema.properties[name]?.type
  if (!type) throw new Error(`La base Notion n'a pas de colonne "${name}".`)
  if (type === "checkbox") return { property: name, checkbox: { equals: Boolean(value) } }
  if (type === "multi_select") return { property: name, multi_select: { contains: value } }
  if (type === "title" || type === "rich_text") return { property: name, [type]: { equals: value } }
  return { property: name, [type]: { equals: value } }
}

// Toutes les pages d'une source qui passent le filtre (pagination comprise).
export async function queryAll(config, sourceId, body = {}, max = 500) {
  const results = []
  let cursor
  do {
    const page = await notion(config, `/data_sources/${sourceId}/query`, { method: "POST", body: { ...body, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) } })
    results.push(...page.results)
    cursor = page.has_more ? page.next_cursor : null
  } while (cursor && results.length < max)
  return results
}

export const titlePropertyOf = (schema) => Object.entries(schema.properties).find(([, p]) => p.type === "title")?.[0]

export const pageMarkdown = async (config, pageId) => (await notion(config, `/pages/${pageId}/markdown`)).markdown ?? ""
