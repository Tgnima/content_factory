// Les réglages éditoriaux, modifiés dans Notion par l'équipe (sans toucher au
// serveur) et relus toutes les 5 minutes (editorial.syncMinutes) :
//   - base "Formats" : une ligne par format (blog, social, newsletter…), avec son
//     libellé, ses longueurs, ses consignes ;
//   - base "Règles"  : une ligne par règle (termes interdits, JEV, pack…).
//
// Chaque valeur est vérifiée. Une valeur invalide est ignorée (l'ancienne reste
// en place) et signalée : dans les journaux et dans le panneau Slack.
import { dataSource, queryAll, readProperty, resolveId } from "./notionClient.mjs"

// La règle -> où elle va dans config, et comment la lire.
const number = (min, max) => (v) => {
  const n = Number(String(v).replace(",", "."))
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`un nombre entre ${min} et ${max} est attendu`)
  return n
}
const bool = (v) => {
  if (/^(oui|yes|vrai|true|1|on|actif)$/i.test(String(v).trim())) return true
  if (/^(non|no|faux|false|0|off|inactif)$/i.test(String(v).trim())) return false
  throw new Error("« oui » ou « non » est attendu")
}
const words = (v) => String(v).split(/[,;\n]/).map((s) => s.trim()).filter(Boolean)

export const RULES = {
  "Termes interdits": { help: "Séparés par des virgules. Un texte qui en contient est réécrit.", read: words, apply: (c, v) => (c.forbiddenTerms = v), current: (c) => (c.forbiddenTerms ?? []).join(", ") },
  "Tentatives automatiques": { help: "Passages supplémentaires quand un contrôle échoue (0 à 3).", read: number(0, 3), apply: (c, v) => (c.maxAutoRetries = v), current: (c) => c.maxAutoRetries },
  "Format par défaut": { help: "Format utilisé quand /contenu n'en précise pas.", read: String, apply: (c, v) => { if (!c.contentTypes[v]) throw new Error(`format inconnu « ${v} »`); c.defaultType = v }, current: (c) => c.defaultType },
  "JEV actif": { help: "Contrôle de la clarté des demandes et de la charte (oui / non).", read: bool, apply: (c, v) => (c.jev = { ...(c.jev ?? {}), enabled: v }), current: (c) => (c.jev?.enabled ? "oui" : "non") },
  "JEV seuil de clarté": { help: "Sous ce seuil (0 à 1), une demande est jugée trop vague.", read: number(0, 1), apply: (c, v) => (c.jev = { ...(c.jev ?? {}), briefThreshold: v }), current: (c) => c.jev?.briefThreshold ?? 0.3 },
  "JEV seuil charte": { help: "Sous ce seuil (0 à 1), le texte est réécrit pour mieux suivre la charte.", read: number(0, 1), apply: (c, v) => (c.jev = { ...(c.jev ?? {}), charteThreshold: v }), current: (c) => c.jev?.charteThreshold ?? 0.4 },
  "JEV seuil faits inventés": { help: "Au-dessus de ce seuil (0 à 1), le texte est réécrit sans les faits inventés.", read: number(0, 1), apply: (c, v) => (c.jev = { ...(c.jev ?? {}), inventedThreshold: v }), current: (c) => c.jev?.inventedThreshold ?? 0.6 },
  "Pack : textes": { help: "Formats produits par /contenu pack, séparés par des virgules.", read: words, apply: (c, v) => { const bad = v.filter((t) => !c.contentTypes[t]); if (bad.length) throw new Error(`format(s) inconnu(s) : ${bad.join(", ")}`); c.pack = { ...(c.pack ?? {}), texts: v, visualFrom: c.pack?.visualFrom && v.includes(c.pack.visualFrom) ? c.pack.visualFrom : v[0] } }, current: (c) => (c.pack?.texts ?? []).join(", ") },
  "Pack : visuel": { help: "Ajouter un visuel au pack (oui / non).", read: bool, apply: (c, v) => (c.pack = { ...(c.pack ?? {}), visualFrom: v ? c.pack?.texts?.[0] ?? "blog" : null }), current: (c) => (c.pack?.visualFrom ? "oui" : "non") },
  "Planning : fréquence (minutes)": { help: "Toutes les combien de minutes le planning Notion est vérifié (1 à 60).", read: number(1, 60), apply: (c, v) => (c.planning = { ...(c.planning ?? {}), pollMinutes: v }), current: (c) => c.planning?.pollMinutes ?? 5 },
  "Contexte : nombre de références": { help: "Références envoyées au rédacteur au plus (0 à 10).", read: number(0, 10), apply: (c, v) => (c.context = { ...(c.context ?? {}), references: v }), current: (c) => c.context?.references ?? 4 },
  "Contexte : nombre de faits": { help: "Faits vérifiés envoyés au rédacteur au plus (0 à 20).", read: number(0, 20), apply: (c, v) => (c.context = { ...(c.context ?? {}), facts: v }), current: (c) => c.context?.facts ?? 8 },
}

// Les colonnes des deux bases (créées par scripts/notion-setup.mjs).
export const FORMAT_COLUMNS = { key: "Format", label: "Libellé", min: "Mots min", max: "Mots max", instructions: "Consignes", disabled: "Désactivé" }
export const RULE_COLUMNS = { name: "Réglage", value: "Valeur", help: "Aide" }

export const editorialEnabled = (config) => Boolean(config.notionToken && (resolveId(config.editorial?.formats) || resolveId(config.editorial?.rules)))

export const editorialStatus = { lastSync: null, errors: [], formats: 0, rules: 0 }

export async function syncEditorial({ config }) {
  if (!editorialEnabled(config)) return editorialStatus
  const errors = []

  // 1. Les formats de texte. Les formats d'image (visuel) restent ceux de la config.
  if (resolveId(config.editorial.formats)) {
    try {
      const schema = await dataSource(config, config.editorial.formats)
      const rows = await queryAll(config, schema.id)
      const c = FORMAT_COLUMNS
      const formats = {}
      for (const row of rows) {
        const p = row.properties
        if (readProperty(p[c.disabled]) === true) continue
        const key = String(readProperty(p[c.key]) ?? "").trim().toLowerCase()
        if (!key) continue
        if (!/^[a-z0-9-]{2,20}$/.test(key)) {
          errors.push(`Format « ${key} » : le nom doit faire 2 à 20 caractères, lettres minuscules, chiffres ou tirets.`)
          continue
        }
        const min = Number(readProperty(p[c.min]))
        const max = Number(readProperty(p[c.max]))
        const instructions = String(readProperty(p[c.instructions]) ?? "").trim()
        if (!(min > 0 && max >= min && max <= 5000)) {
          errors.push(`Format « ${key} » : mots min et max invalides (${min}–${max}).`)
          continue
        }
        if (!instructions) {
          errors.push(`Format « ${key} » : les consignes sont vides.`)
          continue
        }
        formats[key] = { label: String(readProperty(p[c.label]) ?? "").trim() || key, minWords: min, maxWords: max, instructions }
      }
      if (Object.keys(formats).length === 0) {
        errors.push("Aucun format de texte valide dans Notion : les formats actuels sont conservés.")
      } else {
        const images = Object.fromEntries(Object.entries(config.contentTypes).filter(([, t]) => t.kind === "image"))
        config.contentTypes = { ...formats, ...images }
        // Tous les rédacteurs savent écrire tous les formats de texte.
        for (const w of config.workers) {
          if (!w.types.some((t) => images[t])) w.types = Object.keys(formats)
        }
        if (!config.contentTypes[config.defaultType]) config.defaultType = Object.keys(formats)[0]
        editorialStatus.formats = Object.keys(formats).length
      }
    } catch (error) {
      errors.push(`Base Formats illisible : ${error.message}`)
    }
  }

  // 2. Les règles.
  if (resolveId(config.editorial.rules)) {
    try {
      const schema = await dataSource(config, config.editorial.rules)
      const rows = await queryAll(config, schema.id)
      let applied = 0
      for (const row of rows) {
        const name = String(readProperty(row.properties[RULE_COLUMNS.name]) ?? "").trim()
        const raw = readProperty(row.properties[RULE_COLUMNS.value])
        const rule = RULES[name]
        if (!rule) {
          if (name) errors.push(`Règle inconnue : « ${name} » (ignorée).`)
          continue
        }
        if (raw === null || String(raw).trim() === "") continue
        try {
          rule.apply(config, rule.read(raw))
          applied++
        } catch (error) {
          errors.push(`${name} : ${error.message} (valeur « ${raw} » ignorée).`)
        }
      }
      editorialStatus.rules = applied
    } catch (error) {
      errors.push(`Base Règles illisible : ${error.message}`)
    }
  }

  editorialStatus.lastSync = new Date().toISOString()
  editorialStatus.errors = errors
  console.log(`Réglages éditoriaux relus : ${editorialStatus.formats} format(s), ${editorialStatus.rules} règle(s)${errors.length ? `, ${errors.length} problème(s) : ${errors.join(" | ")}` : ""}.`)
  return editorialStatus
}

export function startEditorialSync(ctx) {
  if (!editorialEnabled(ctx.config)) return console.log("Réglages éditoriaux Notion désactivés (bases Formats et Règles absentes).")
  const tick = () => syncEditorial(ctx).catch((e) => console.error("Réglages éditoriaux :", e.message))
  tick()
  setInterval(tick, (ctx.config.editorial.syncMinutes ?? 5) * 60_000)
}
