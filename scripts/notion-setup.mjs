// Crée les bases Notion de l'usine dans la page partagée avec l'intégration,
// puis écrit leurs identifiants dans .env :
//   - "Planning éditorial"  -> NOTION_DATABASE_ID  (sujets programmés, publication)
//   - "Bibliothèque de marque" -> NOTION_LIBRARY_ID (le contexte : références,
//     faits vérifiés, codes de marque, cibles, identité visuelle, à éviter)
// Une base déjà créée (identifiant présent dans .env) n'est pas recréée.
//
//   node scripts/notion-setup.mjs            aperçu
//   node scripts/notion-setup.mjs --yes      crée les bases manquantes
//
// Prérequis : NOTION_TOKEN dans .env, et une page Notion (par exemple
// "Usine à contenu") connectée à l'intégration (••• > Connexions).
import { readFileSync, writeFileSync } from "node:fs"

const ENV_FILE = new URL("../.env", import.meta.url)
const VERSION = "2026-03-11"
const PAGE_TITLE = process.env.NOTION_PAGE_TITLE ?? "Usine à contenu"

let envText = readFileSync(ENV_FILE, "utf8")
const env = Object.fromEntries(envText.split(/\r?\n/).map((l) => /^([A-Z_]+)=(.*)$/.exec(l)).filter(Boolean).map((m) => [m[1], m[2].trim()]))
if (!env.NOTION_TOKEN) throw new Error("NOTION_TOKEN est vide dans .env.")

const choices = (names) => ({ options: names.map((name) => ({ name })) })
const DATABASES = [
  {
    envKey: "NOTION_DATABASE_ID",
    title: "Planning éditorial",
    properties: {
      "Sujet": { title: {} },
      "Format": { select: choices(["blog", "social"]) },
      "Date prévue": { date: {} },
      "Statut": { select: choices(["À faire", "En cours", "À relire", "Publié", "Échec"]) },
      "Slack": { url: {} },
      "Publié le": { date: {} },
    },
  },
  {
    envKey: "NOTION_LIBRARY_ID",
    title: "Bibliothèque de marque",
    properties: {
      "Titre": { title: {} },
      "Type": { select: choices(["Référence", "Fait vérifié", "Code de marque", "Cible", "Identité visuelle", "À éviter"]) },
      "Formats": { multi_select: choices(["blog", "social", "visuel"]) },
      "Pourquoi ça marche": { rich_text: {} },
      "Désactivé": { checkbox: {} },
      "Source": { select: choices(["Manuel", "Usine"]) },
    },
  },
]

// Seules les bases que la configuration utilise sont créées : une entreprise
// branchée sur son propre calendrier (scripts/notion-connect.mjs) n'a pas besoin
// du "Planning éditorial" de l'usine.
const configFile = [new URL("../config/factory.json", import.meta.url), new URL("../config/factory.example.json", import.meta.url)].find((f) => {
  try {
    readFileSync(f)
    return true
  } catch {
    return false
  }
})
const config = JSON.parse(readFileSync(configFile, "utf8"))
const referenced = new Set(
  [config.notion?.planning?.database ?? "env:NOTION_DATABASE_ID", ...(config.context?.sources ?? []).filter((s) => s.kind === "notion").map((s) => s.database)]
    .filter((v) => typeof v === "string" && v.startsWith("env:"))
    .map((v) => v.slice(4)),
)
const todo = DATABASES.filter((d) => referenced.has(d.envKey) && !env[d.envKey])
if (todo.length === 0) {
  console.log("Aucune base Notion à créer : elles existent déjà, ou l'usine est branchée sur les vôtres.")
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

console.log(`Page parente : "${titleOf(page)}" (${page.url})`)
for (const d of todo) console.log(`À créer : "${d.title}" (${Object.keys(d.properties).join(", ")})`)
if (!process.argv.includes("--yes")) {
  console.log("\nAperçu seulement. Relancez avec --yes pour créer les bases.")
  process.exit(0)
}

for (const d of todo) {
  const title = [{ type: "text", text: { content: d.title } }]
  const parent = { type: "page_id", page_id: page.id }
  let db
  try {
    // API 2025-09-03 et suivantes : les colonnes vont dans la première source de données.
    db = await notion("/databases", { method: "POST", body: { parent, title, initial_data_source: { properties: d.properties } } })
  } catch (error) {
    if (error.status !== 400) throw error
    db = await notion("/databases", { method: "POST", body: { parent, title, properties: d.properties } })
  }
  const line = `${d.envKey}=${db.id}`
  envText = new RegExp(`^${d.envKey}=.*$`, "m").test(envText) ? envText.replace(new RegExp(`^${d.envKey}=.*$`, "m"), line) : `${envText.trimEnd()}\n${line}\n`
  console.log(`Créée : "${d.title}" ${db.url}`)
}
writeFileSync(ENV_FILE, envText)
console.log("Identifiants écrits dans .env.")
