// Brancher l'usine sur des bases Notion EXISTANTES (plug and play) : votre
// calendrier éditorial, vos posts publiés, vos fiches produits, votre charte…
// L'usine s'adapte à vos colonnes et à vos valeurs : rien n'est recréé.
//
//   node scripts/notion-connect.mjs              questions, avec correspondances proposées
//   node scripts/notion-connect.mjs --json       les bases visibles, leurs colonnes et leurs
//                                                valeurs, en JSON (pour un agent)
//   node scripts/notion-connect.mjs --apply F    applique un branchement décrit dans le
//                                                fichier JSON F : { "planning": {...}, "sources": [...] }
//                                                (même forme que notion.planning et context.sources)
//
// Prérequis : NOTION_TOKEN dans .env, et les bases partagées avec l'intégration
// (sur chaque base ou sur une page parente : ••• > Connexions).
import { createInterface } from "node:readline"
import { readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs"

const ROOT = new URL("../", import.meta.url)
const path = (p) => new URL(p, ROOT)
const args = process.argv.slice(2)
const env = Object.fromEntries(readFileSync(path(".env"), "utf8").split(/\r?\n/).map((l) => /^([A-Z_]+)=(.*)$/.exec(l)).filter(Boolean).map((m) => [m[1], m[2].trim()]))
if (!env.NOTION_TOKEN) throw new Error("NOTION_TOKEN est vide dans .env.")

const TYPES = ["Référence", "Fait vérifié", "Code de marque", "Cible", "Identité visuelle", "À éviter"]
const STATES = { todo: "à faire", running: "en cours", review: "à relire", published: "publié", failed: "échec" }

async function notion(p, { method = "GET", body } = {}) {
  const res = await fetch(`https://api.notion.com/v1${p}`, {
    method,
    headers: { authorization: `Bearer ${env.NOTION_TOKEN}`, "Notion-Version": "2026-03-11", "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`Notion ${res.status} : ${json.message ?? JSON.stringify(json)}`)
  return json
}
const plain = (rich) => (rich ?? []).map((t) => t.plain_text ?? "").join("")

// --- Découverte -----------------------------------------------------------------

async function discover() {
  const found = await notion("/search", { method: "POST", body: { filter: { property: "object", value: "data_source" }, page_size: 100 } })
  return found.results.map((ds) => ({
    id: ds.id,
    name: plain(ds.title) || "(sans titre)",
    url: ds.url ?? null,
    columns: Object.fromEntries(
      Object.entries(ds.properties).map(([name, p]) => [name, { type: p.type, ...(p[p.type]?.options ? { values: p[p.type].options.map((o) => o.name) } : {}) }]),
    ),
  }))
}

// --- Correspondances proposées --------------------------------------------------------

const norm = (s) => String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
const pick = (columns, types, pattern) => Object.entries(columns).find(([n, c]) => types.includes(c.type) && pattern.test(norm(n)))?.[0] ?? Object.entries(columns).find(([, c]) => types.includes(c.type))?.[0] ?? null

const STATE_WORDS = {
  todo: /a faire|todo|to do|idee|backlog|a ecrire|planifie|pas commence|not started/,
  running: /en cours|redaction|in progress|en production|doing|ecriture/,
  review: /relire|relecture|review|validation|a valider|en attente/,
  published: /publie|published|done|termine|en ligne|live/,
  failed: /echec|bloque|blocked|annule|abandon|erreur/,
}
const FORMAT_WORDS = { social: /linkedin|social|post|reseau|twitter|x\b|facebook|instagram/, blog: /blog|article|site|seo/ }
const TYPE_WORDS = {
  "Référence": /post|article|publication|reference|exemple|contenu|best/,
  "Fait vérifié": /fait|chiffre|offre|produit|prix|certif|client|temoignage|faq/,
  "Code de marque": /charte|code|ton|voix|vocabulaire|style|marque/,
  "Cible": /cible|persona|audience|client type/,
  "Identité visuelle": /visuel|identite|couleur|logo|image|design/,
  "À éviter": /eviter|interdit|ne pas|sensible|concurrent/,
}
const guess = (words, value) => Object.entries(words).find(([, re]) => re.test(norm(value)))?.[0] ?? null

export function suggestPlanning(source) {
  const c = source.columns
  const status = pick(c, ["status", "select"], /statut|etat|status|avancement/)
  const format = pick(c, ["select", "multi_select"], /format|canal|reseau|type|support|channel/)
  const statusValues = {}
  for (const v of c[status]?.values ?? []) {
    const s = guess(STATE_WORDS, v)
    if (s && !statusValues[s]) statusValues[s] = v
  }
  const formatValues = {}
  for (const v of c[format]?.values ?? []) {
    const f = guess(FORMAT_WORDS, v)
    if (f) formatValues[v] = f
  }
  return {
    database: source.id,
    columns: {
      subject: pick(c, ["title"], /.*/),
      format,
      date: pick(c, ["date"], /date|publication|prevu|planifie|jour/),
      status,
      slack: Object.entries(c).find(([n, x]) => x.type === "url" && /slack/.test(norm(n)))?.[0] ?? null,
      publishedAt: Object.entries(c).find(([n, x]) => x.type === "date" && /publie le|published/.test(norm(n)))?.[0] ?? null,
    },
    formatValues,
    statusValues,
  }
}

export function suggestSource(source) {
  const c = source.columns
  const typeCol = Object.entries(c).find(([n, x]) => ["select", "status"].includes(x.type) && /type|categorie|nature/.test(norm(n)))?.[0] ?? null
  const typeValues = {}
  for (const v of c[typeCol]?.values ?? []) {
    const t = TYPES.includes(v) ? v : guess(TYPE_WORDS, v)
    if (t) typeValues[v] = t
  }
  const formatsCol = Object.entries(c).find(([n, x]) => ["select", "multi_select"].includes(x.type) && /format|canal|reseau|support|channel/.test(norm(n)))?.[0] ?? null
  const formatValues = {}
  for (const v of c[formatsCol]?.values ?? []) {
    const f = guess(FORMAT_WORDS, v) ?? (norm(v) === "visuel" ? "visuel" : null)
    if (f) formatValues[v] = f
  }
  const statusCol = Object.entries(c).find(([n, x]) => ["status", "select"].includes(x.type) && /statut|etat|status/.test(norm(n)))?.[0]
  const publishedValue = (c[statusCol]?.values ?? []).find((v) => STATE_WORDS.published.test(norm(v)))
  const suggestion = {
    name: source.name,
    kind: "notion",
    database: source.id,
    columns: {
      title: pick(c, ["title"], /.*/),
      ...(typeCol ? { type: typeCol } : {}),
      ...(formatsCol ? { formats: formatsCol } : {}),
      ...(Object.entries(c).find(([n, x]) => x.type === "rich_text" && /pourquoi|resultat|performance|commentaire|note/.test(norm(n))) ? { why: Object.entries(c).find(([n, x]) => x.type === "rich_text" && /pourquoi|resultat|performance|commentaire|note/.test(norm(n)))[0] } : {}),
      ...(Object.entries(c).find(([n, x]) => x.type === "checkbox" && /archiv|desactiv|masque|obsolete/.test(norm(n))) ? { disabled: Object.entries(c).find(([n, x]) => x.type === "checkbox" && /archiv|desactiv|masque|obsolete/.test(norm(n)))[0] } : {}),
    },
  }
  // Sans colonne de type : tout le contenu de la base est d'un seul type, deviné d'après son nom.
  if (typeCol && Object.keys(typeValues).length) suggestion.typeValues = typeValues
  else {
    delete suggestion.columns.type
    suggestion.type = guess(TYPE_WORDS, source.name) ?? "Référence"
  }
  if (formatsCol && Object.keys(formatValues).length) suggestion.formatValues = formatValues
  else delete suggestion.columns.formats
  // Un calendrier éditorial branché comme source : seulement ce qui est publié.
  if (publishedValue && suggestion.type === "Référence") suggestion.filter = { column: statusCol, equals: publishedValue }
  return suggestion
}

// --- Écriture ---------------------------------------------------------------------

function applyConnection({ planning, sources, replaceSources = false }) {
  if (!existsSync(path("config/factory.json"))) copyFileSync(path("config/factory.example.json"), path("config/factory.json"))
  const config = JSON.parse(readFileSync(path("config/factory.json"), "utf8"))
  config.notion ??= {}
  if (planning) config.notion.planning = planning
  if (sources?.length) {
    config.context ??= { sources: [] }
    const kept = replaceSources ? config.context.sources.filter((s) => s.kind !== "notion" || s.writable) : config.context.sources
    const names = new Set(sources.map((s) => s.name))
    config.context.sources = [...kept.filter((s) => !names.has(s.name)), ...sources]
  }
  writeFileSync(path("config/factory.json"), `${JSON.stringify(config, null, 2)}\n`)
}

// --- Questions ----------------------------------------------------------------------

const lines = []
const waiting = []
let rl
const ask = (q) => {
  rl ??= createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) }).on("line", (l) => (waiting.length ? waiting.shift()(l) : lines.push(l)))
  process.stdout.write(q)
  if (lines.length) {
    const l = lines.shift()
    if (!process.stdin.isTTY) process.stdout.write(`${l}\n`)
    return Promise.resolve(l.trim())
  }
  return new Promise((resolve) => waiting.push((l) => resolve(l.trim())))
}
const yes = async (q, def = true) => {
  const a = await ask(`${q} ${def ? "[O/n]" : "[o/N]"} `)
  return a ? /^(o|oui|y|yes)/i.test(a) : def
}
const show = (obj) => console.log(JSON.stringify(obj, null, 2).replace(/^/gm, "    "))

async function interactive(sources) {
  console.log("\nBases Notion visibles par l'intégration :")
  sources.forEach((s, i) => console.log(`  ${i + 1}. ${s.name}  (${Object.keys(s.columns).length} colonnes : ${Object.keys(s.columns).slice(0, 6).join(", ")}${Object.keys(s.columns).length > 6 ? "…" : ""})`))
  const byNumber = (n) => sources[Number(n) - 1]

  // 1. Le calendrier éditorial
  let planning = null
  const p = await ask("\nQuelle base est votre CALENDRIER ÉDITORIAL ? (numéro, ou Entrée pour garder le planning de l'usine) ")
  if (p && byNumber(p)) {
    planning = suggestPlanning(byNumber(p))
    console.log("\n  Correspondance proposée (vos colonnes et vos valeurs -> l'usine) :")
    show({ colonnes: planning.columns, formats: planning.formatValues, statuts: planning.statusValues })
    const missing = Object.keys(STATES).filter((k) => !planning.statusValues[k])
    if (missing.length) console.log(`  Statuts sans équivalent chez vous : ${missing.map((k) => STATES[k]).join(", ")}. Ces étapes ne seront pas notées dans Notion.`)
    if (!(await yes("  Utiliser cette correspondance ?"))) planning = null
    else if (!planning.columns.status || !planning.columns.date) {
      console.log("  Il faut au moins une colonne de statut et une colonne de date : correspondance abandonnée.")
      planning = null
    }
  }

  // 2. Les sources de contexte
  const chosen = []
  const c = await ask("\nQuelles bases contiennent votre CONTEXTE (posts publiés, produits, charte, personas…) ? (numéros séparés par des virgules, ou Entrée pour aucune) ")
  for (const n of c.split(",").map((s) => s.trim()).filter(Boolean)) {
    const src = byNumber(n)
    if (!src) continue
    const suggestion = suggestSource(src)
    console.log(`\n  « ${src.name} » : correspondance proposée`)
    show(suggestion)
    if (await yes("  Brancher cette source ?")) chosen.push(suggestion)
  }

  if (!planning && chosen.length === 0) return console.log("\nRien à brancher : la configuration n'a pas changé.")
  applyConnection({ planning, sources: chosen })
  console.log(`\nBranchement enregistré dans config/factory.json${planning ? " (calendrier éditorial" : " ("}${chosen.length ? `${planning ? ", " : ""}${chosen.length} source(s) de contexte` : ""}).`)
  console.log("Redémarrez l'orchestrateur pour l'appliquer : docker compose restart orchestrateur")
  console.log("Pour ajuster à la main : config/factory.json, sections notion.planning et context.sources.")
}

// --- Déroulé ------------------------------------------------------------------------

const sources = await discover()
if (args.includes("--json")) {
  console.log(JSON.stringify({ sources, suggestions: Object.fromEntries(sources.map((s) => [s.id, { asPlanning: suggestPlanning(s), asContext: suggestSource(s) }])) }, null, 2))
} else if (args.includes("--apply")) {
  const plan = JSON.parse(readFileSync(args[args.indexOf("--apply") + 1], "utf8"))
  applyConnection(plan)
  console.log("Branchement enregistré dans config/factory.json. Redémarrez l'orchestrateur : docker compose restart orchestrateur")
} else if (sources.length === 0) {
  console.log("L'intégration ne voit aucune base. Partagez vos bases avec elle : ••• > Connexions, sur la base ou sur une page parente.")
} else {
  await interactive(sources)
}
rl?.close()
