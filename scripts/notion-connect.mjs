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
import { STATES, discover as discoverWith, suggestPlanning, suggestSource } from "../orchestrator/src/notionMapping.mjs"

const ROOT = new URL("../", import.meta.url)
const path = (p) => new URL(p, ROOT)
const args = process.argv.slice(2)
const env = Object.fromEntries(readFileSync(path(".env"), "utf8").split(/\r?\n/).map((l) => /^([A-Z_]+)=(.*)$/.exec(l)).filter(Boolean).map((m) => [m[1], m[2].trim()]))
if (!env.NOTION_TOKEN) throw new Error("NOTION_TOKEN est vide dans .env.")


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

// --- Découverte -----------------------------------------------------------------

const discover = () => discoverWith(notion)

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
