// Crée la base "Planning éditorial" dans la page Notion partagée avec
// l'intégration, puis écrit son identifiant dans .env (NOTION_DATABASE_ID).
//
//   node scripts/notion-setup.mjs            aperçu : quelle page, quelles colonnes
//   node scripts/notion-setup.mjs --yes      crée la base
//
// Prérequis : NOTION_TOKEN dans .env, et une page Notion (par exemple
// "Usine à contenu") connectée à l'intégration (••• > Connexions).
import { readFileSync, writeFileSync } from "node:fs"

const ENV_FILE = new URL("../.env", import.meta.url)
const VERSION = "2026-03-11"
const PAGE_TITLE = process.env.NOTION_PAGE_TITLE ?? "Usine à contenu"

const envText = readFileSync(ENV_FILE, "utf8")
const env = Object.fromEntries(envText.split(/\r?\n/).map((l) => /^([A-Z_]+)=(.*)$/.exec(l)).filter(Boolean).map((m) => [m[1], m[2].trim()]))
if (!env.NOTION_TOKEN) throw new Error("NOTION_TOKEN est vide dans .env.")
if (env.NOTION_DATABASE_ID) {
  console.log("NOTION_DATABASE_ID est déjà rempli dans .env : rien à faire.")
  process.exit(0)
}

async function notion(path, { method = "GET", body } = {}) {
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${env.NOTION_TOKEN}`, "Notion-Version": VERSION, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw Object.assign(new Error(`Notion ${res.status} : ${json.message ?? JSON.stringify(json)}`), { status: res.status })
  return json
}

const titleOf = (page) => Object.values(page.properties ?? {}).find((p) => p.type === "title")?.title?.map((t) => t.plain_text).join("") ?? "(sans titre)"

// Les pages que l'intégration peut voir.
const found = await notion("/search", { method: "POST", body: { filter: { property: "object", value: "page" }, page_size: 50 } })
const pages = found.results.filter((p) => p.parent?.type !== "data_source_id" && p.parent?.type !== "database_id")
if (pages.length === 0) {
  console.log(`L'intégration ne voit aucune page. Dans Notion, ouvrez la page "${PAGE_TITLE}", cliquez sur ••• > Connexions et ajoutez l'intégration.`)
  process.exit(1)
}
const page = pages.find((p) => titleOf(p).trim() === PAGE_TITLE) ?? pages[0]

const choices = (names) => ({ select: { options: names.map((name) => ({ name })) } })
const properties = {
  "Sujet": { title: {} },
  "Format": choices(["blog", "social"]),
  "Date prévue": { date: {} },
  "Statut": choices(["À faire", "En cours", "À relire", "Publié", "Échec"]),
  "Slack": { url: {} },
  "Publié le": { date: {} },
}

console.log(`Page parente : "${titleOf(page)}" (${page.url})`)
console.log(`Colonnes : ${Object.keys(properties).join(", ")}`)
if (!process.argv.includes("--yes")) {
  console.log("\nAperçu seulement. Relancez avec --yes pour créer la base.")
  process.exit(0)
}

const title = [{ type: "text", text: { content: "Planning éditorial" } }]
const parent = { type: "page_id", page_id: page.id }
let db
try {
  // API 2025-09-03 et suivantes : les colonnes vont dans la première source de données.
  db = await notion("/databases", { method: "POST", body: { parent, title, initial_data_source: { properties } } })
} catch (error) {
  if (error.status !== 400) throw error
  console.log("Format initial_data_source refusé, essai avec l'ancien format…")
  db = await notion("/databases", { method: "POST", body: { parent, title, properties } })
}

writeFileSync(ENV_FILE, envText.replace(/^NOTION_DATABASE_ID=.*$/m, `NOTION_DATABASE_ID=${db.id}`))
console.log(`\nBase créée : ${db.url}\nNOTION_DATABASE_ID écrit dans .env.`)
