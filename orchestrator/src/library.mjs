// Le contexte de l'entreprise : tout ce qui rend un contenu "maison" plutôt
// que générique. Il vient de SOURCES que l'on branche (config/factory.json >
// context.sources), sans imposer de schéma :
//   - des bases Notion existantes (posts publiés, fiches produits, charte…),
//     avec la correspondance de leurs colonnes ;
//   - des fichiers Markdown dans maison/.
//
// Chaque élément a un TYPE :
//   Référence         un contenu qui a marché, à imiter (ton, structure)
//   Fait vérifié      une offre, un chiffre, une certification, un client citable
//   Code de marque    vocabulaire, accroches, appels à l'action, hashtags
//   Cible             un persona : ses problèmes, ses mots
//   Identité visuelle palette, style, règles pour les images
//   À éviter          sujets, mots, concurrents, erreurs passées
//
// Les éléments sont copiés dans SQLite (avec leur embedding) à chaque
// synchronisation. Pour une demande, on n'envoie au worker que ce qui compte :
// les codes et les interdits toujours, puis les faits, la cible et les
// références les plus proches du sujet, dans un budget de caractères.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { dataSource, equalsFilter, notion, pageMarkdown, queryAll, readProperty, resolveId, writeProperty } from "./notionClient.mjs"

export const TYPES = ["Référence", "Fait vérifié", "Code de marque", "Cible", "Identité visuelle", "À éviter"]
const GATEWAY = "https://ai-gateway.vercel.sh/v1"

const settings = (config) => ({
  embeddingModel: "openai/text-embedding-3-small",
  syncMinutes: 15,
  references: 4,
  facts: 8,
  targets: 1,
  budgetChars: 9000,
  minSimilarity: 0.3,
  relativeSimilarity: 0.7,
  sources: [],
  ...(config.context ?? {}),
})

export function initLibrary(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS context_items (
      key        TEXT PRIMARY KEY,
      source     TEXT NOT NULL,
      type       TEXT NOT NULL,
      formats    TEXT NOT NULL DEFAULT '[]',
      title      TEXT NOT NULL,
      body       TEXT NOT NULL,
      why        TEXT,
      url        TEXT,
      edited     TEXT,
      embedding  TEXT
    );
  `)
}

// --- Embeddings ----------------------------------------------------------------

async function embed(config, texts) {
  if (!config.jevApiKey || texts.length === 0) return texts.map(() => null)
  const out = []
  for (let i = 0; i < texts.length; i += 50) {
    const batch = texts.slice(i, i + 50).map((t) => t.slice(0, 8000))
    try {
      const res = await fetch(`${GATEWAY}/embeddings`, {
        method: "POST",
        headers: { authorization: `Bearer ${config.jevApiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ model: settings(config).embeddingModel, input: batch }),
        signal: AbortSignal.timeout(30_000),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error?.message ?? res.status)
      out.push(...json.data.map((d) => d.embedding))
    } catch (error) {
      console.warn(`Contexte : embeddings indisponibles (${error.message}), sélection par récence.`)
      out.push(...batch.map(() => null))
    }
  }
  return out
}

const cosine = (a, b) => {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return dot / Math.sqrt(na * nb)
}

// --- Lecture des sources ---------------------------------------------------------

// Une valeur de la source -> un type de l'usine. Sans table de correspondance,
// la valeur doit déjà être l'un des TYPES.
const mapValue = (values, value) => (values ? values[value] ?? null : value)

async function readNotionSource(config, source) {
  const schema = await dataSource(config, source.database)
  const col = source.columns ?? {}
  const filters = []
  if (col.disabled) filters.push(equalsFilter(schema, col.disabled, false))
  if (source.filter) filters.push(equalsFilter(schema, source.filter.column, source.filter.equals))
  const pages = await queryAll(config, schema.id, filters.length ? { filter: filters.length === 1 ? filters[0] : { and: filters } } : {})

  const items = []
  for (const page of pages) {
    const p = page.properties
    const type = source.type ?? mapValue(source.typeValues, readProperty(p[col.type]))
    if (!TYPES.includes(type)) continue
    const rawFormats = source.formats ?? [].concat(readProperty(p[col.formats]) ?? [])
    const formats = source.formatValues ? rawFormats.map((f) => source.formatValues[f]).filter(Boolean) : rawFormats
    const titleCol = col.title ?? Object.keys(p).find((k) => p[k].type === "title")
    // Les autres colonnes (prix, date, lien, catégorie…) accompagnent le contenu :
    // dans une base produits, ce sont souvent elles qui portent les faits.
    const used = new Set([titleCol, col.type, col.formats, col.why, col.disabled, col.body, col.origin, source.filter?.column])
    const extra = Object.entries(p)
      .filter(([name]) => !used.has(name))
      .map(([name, prop]) => [name, readProperty(prop)])
      .filter(([, v]) => v !== null && v !== "" && !(Array.isArray(v) && v.length === 0) && typeof v !== "boolean")
      .map(([name, v]) => `${name} : ${[].concat(v).join(", ")}`)
    items.push({
      extra: extra.join("\n"),
      key: `${source.name}:${page.id}`,
      pageId: page.id,
      type,
      formats,
      title: String(readProperty(p[titleCol]) ?? "").trim() || "(sans titre)",
      why: col.why ? String(readProperty(p[col.why]) ?? "") : "",
      bodyColumn: col.body ?? null,
      bodyValue: col.body ? String(readProperty(p[col.body]) ?? "") : null,
      url: page.url,
      edited: page.last_edited_time,
    })
  }
  return items
}

function readFolderSource(config, source) {
  const dir = join(config.maisonDir, source.path)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((n) => n.endsWith(".md") && n.toLowerCase() !== "readme.md")
    .map((name) => {
      const file = join(dir, name)
      return { key: `${source.name}:${name}`, type: source.type ?? "Référence", formats: source.formats ?? [], title: name.replace(/\.md$/, ""), why: "", url: null, edited: statSync(file).mtime.toISOString(), bodyValue: readFileSync(file, "utf8") }
    })
    .filter((item) => TYPES.includes(item.type))
}

// --- Synchronisation ----------------------------------------------------------------

// Une seule synchronisation à la fois. Une demande qui arrive pendant qu'une
// autre tourne en relance une à la fin : un élément ajouté entre-temps n'est
// jamais oublié.
let syncing = null
let again = null
export function syncLibrary(ctx) {
  if (!syncing) {
    syncing = doSync(ctx).finally(() => (syncing = null))
    return syncing
  }
  again ??= syncing.catch(() => {}).then(() => {
    again = null
    return syncLibrary(ctx)
  })
  return again
}

async function doSync({ config, db }) {
  const s = settings(config)
  const stats = { added: 0, updated: 0, removed: 0, failed: [] }
  for (const source of s.sources) {
    let items
    try {
      if (source.kind === "notion") {
        if (!config.notionToken || !resolveId(source.database)) continue
        items = await readNotionSource(config, source)
      } else if (source.kind === "folder") {
        items = readFolderSource(config, source)
      } else continue
    } catch (error) {
      // Une source en erreur garde ses éléments : on ne vide pas le contexte
      // pour une panne passagère.
      stats.failed.push(`${source.name} (${error.message})`)
      continue
    }

    const known = new Map(db.prepare("SELECT key, edited FROM context_items WHERE source = ?").all(source.name).map((r) => [r.key, r.edited]))
    const changed = items.filter((i) => known.get(i.key) !== i.edited)
    for (const item of changed) {
      if (item.bodyValue === null) item.bodyValue = await pageMarkdown(config, item.pageId).catch(() => "")
      if (item.extra) item.bodyValue = `${item.extra}\n\n${item.bodyValue}`
    }
    // Le type n'entre pas dans le calcul : c'est déjà un filtre, et il
    // rapprocherait artificiellement tous les éléments d'un même type.
    const vectors = await embed(config, changed.map((i) => `${i.title}\n${i.why}\n${i.bodyValue}`))
    const upsert = db.prepare(`INSERT INTO context_items (key, source, type, formats, title, body, why, url, edited, embedding) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET type = excluded.type, formats = excluded.formats, title = excluded.title, body = excluded.body, why = excluded.why, url = excluded.url, edited = excluded.edited, embedding = excluded.embedding`)
    changed.forEach((item, i) => {
      upsert.run(item.key, source.name, item.type, JSON.stringify(item.formats), item.title, item.bodyValue.trim(), item.why, item.url, item.edited, vectors[i] ? JSON.stringify(vectors[i]) : null)
      known.has(item.key) ? stats.updated++ : stats.added++
    })
    const present = new Set(items.map((i) => i.key))
    for (const key of known.keys()) {
      if (!present.has(key)) {
        db.prepare("DELETE FROM context_items WHERE key = ?").run(key)
        stats.removed++
      }
    }
  }
  const total = db.prepare("SELECT COUNT(*) AS n FROM context_items").get().n
  console.log(`Contexte synchronisé : ${total} élément(s) (+${stats.added}, ~${stats.updated}, -${stats.removed})${stats.failed.length ? ` ; en erreur : ${stats.failed.join(", ")}` : ""}.`)
  return { ...stats, total }
}

export function startLibrarySync(ctx) {
  const minutes = settings(ctx.config).syncMinutes
  setTimeout(() => syncLibrary(ctx).catch((e) => console.error("Contexte :", e.message)), 5_000)
  setInterval(() => syncLibrary(ctx).catch((e) => console.error("Contexte :", e.message)), minutes * 60_000)
}

// --- Sélection pour une demande ---------------------------------------------------

// Renvoie { text, stats } : le bloc de contexte à joindre à la consigne, et ce
// qu'il contient (affiché sous le brouillon).
export async function selectContext({ config, db }, { type, brief }) {
  const s = settings(config)
  const isImage = config.contentTypes[type]?.kind === "image"
  const rows = db.prepare("SELECT * FROM context_items").all().map((r) => ({ ...r, formats: JSON.parse(r.formats), embedding: r.embedding ? JSON.parse(r.embedding) : null }))
  const fits = (r) => r.formats.length === 0 || r.formats.includes(type)
  const [briefVector] = rows.some((r) => r.embedding) ? await embed(config, [brief]) : [null]
  const score = (r) => (briefVector && r.embedding ? cosine(briefVector, r.embedding) : 0)
  // Avec les embeddings, un élément trop éloigné du sujet n'est pas envoyé,
  // même s'il reste de la place : mieux vaut peu de contexte que du hors-sujet.
  // Sans embeddings (pas de clé), on prend les plus récents.
  // Deux seuils : un minimum absolu, et 70 % du meilleur score de la catégorie
  // (un élément très pertinent fait passer à la trappe ses voisins moyens).
  const ranked = (list) => {
    const sorted = [...list].sort((a, b) => score(b) - score(a) || String(b.edited).localeCompare(String(a.edited)))
    if (!briefVector) return sorted
    const best = Math.max(0, ...sorted.map(score))
    return sorted.filter((r) => !r.embedding || (score(r) >= s.minSimilarity && score(r) >= best * s.relativeSimilarity))
  }

  const of = (t) => rows.filter((r) => r.type === t && fits(r))
  const picks = isImage
    ? { "Identité visuelle": of("Identité visuelle"), "À éviter": of("À éviter") }
    : {
        "Code de marque": of("Code de marque"),
        "À éviter": of("À éviter"),
        "Cible": ranked(of("Cible")).slice(0, s.targets),
        "Fait vérifié": ranked(of("Fait vérifié")).slice(0, s.facts),
        "Référence": ranked(of("Référence")).slice(0, s.references),
      }

  // Le budget se remplit dans cet ordre : ce qui est toujours vrai d'abord.
  const TITLES = {
    "Code de marque": "Codes de la marque (à respecter)",
    "À éviter": "À éviter absolument",
    "Cible": "Cible de ce contenu",
    "Fait vérifié": "Faits vérifiés (les seuls chiffres, offres et noms que tu peux citer)",
    "Référence": "Contenus qui ont bien marché (inspire-toi du ton et de la structure, ne les recopie pas)",
    "Identité visuelle": "Identité visuelle de la marque",
  }
  let budget = s.budgetChars
  const sections = []
  const stats = {}
  for (const [t, list] of Object.entries(picks)) {
    const parts = []
    for (const r of list) {
      const text = `### ${r.title}${r.why ? `\nPourquoi ça marche : ${r.why}` : ""}\n${r.body}`.trim()
      if (text.length > budget) {
        if (budget > 400) parts.push(`${text.slice(0, budget)}…`)
        budget = 0
        break
      }
      parts.push(text)
      budget -= text.length
    }
    if (parts.length) {
      sections.push(`## ${TITLES[t]}\n\n${parts.join("\n\n")}`)
      stats[t] = parts.length
    }
    if (budget <= 0) break
  }
  return { text: sections.length ? `<contexte_entreprise>\n${sections.join("\n\n")}\n</contexte_entreprise>` : "", stats }
}

export const describeStats = (stats) => {
  const short = { "Référence": "réf.", "Fait vérifié": "faits", "Code de marque": "codes", "Cible": "cible", "Identité visuelle": "identité visuelle", "À éviter": "interdits" }
  const parts = Object.entries(stats).map(([t, n]) => `${n} ${short[t]}`)
  return parts.length ? `:books: ${parts.join(" · ")}` : ":books: aucun contexte"
}

// --- Ajout depuis Slack -------------------------------------------------------------

// La source où l'on écrit : la première source Notion marquée "writable".
export const writableSource = (config) => settings(config).sources.find((s) => s.kind === "notion" && s.writable && resolveId(s.database))

export async function addToLibrary(ctx, { type, formats = [], title, body, why = "", origin = "Usine" }) {
  const { config } = ctx
  const source = writableSource(config)
  if (!source || !config.notionToken) throw new Error("Aucune source de contexte Notion accessible en écriture (context.sources, \"writable\": true).")
  const schema = await dataSource(config, source.database)
  const col = source.columns ?? {}
  const reverse = (values, v) => (values ? Object.entries(values).find(([, ours]) => ours === v)?.[0] ?? v : v)
  const props = {}
  const titleCol = col.title ?? Object.keys(schema.properties).find((k) => schema.properties[k].type === "title")
  props[titleCol] = writeProperty(schema, titleCol, title)
  if (col.type && !source.type) props[col.type] = writeProperty(schema, col.type, reverse(source.typeValues, type))
  if (col.formats && !source.formats && formats.length) props[col.formats] = writeProperty(schema, col.formats, formats.map((f) => reverse(source.formatValues, f)))
  if (col.why && why) props[col.why] = writeProperty(schema, col.why, why)
  if (col.origin) props[col.origin] = writeProperty(schema, col.origin, origin)
  const page = await notion(config, "/pages", { method: "POST", body: { parent: { type: "data_source_id", data_source_id: schema.id }, properties: props, markdown: body } })
  syncLibrary(ctx).catch(() => {})
  return page.url
}

export function librarySummary({ config, db }) {
  const rows = db.prepare("SELECT source, type, COUNT(*) AS n FROM context_items GROUP BY source, type ORDER BY source, type").all()
  const withVector = db.prepare("SELECT COUNT(*) AS n FROM context_items WHERE embedding IS NOT NULL").get().n
  const total = rows.reduce((sum, r) => sum + r.n, 0)
  const bySource = {}
  for (const r of rows) (bySource[r.source] ??= []).push(`${r.n} ${r.type}`)
  const sources = settings(config).sources.map((s) => `• *${s.name}* (${s.kind === "notion" ? "Notion" : `fichiers maison/${s.path}`}) : ${bySource[s.name]?.join(", ") ?? "vide"}`)
  return { total, withVector, text: sources.join("\n") }
}
