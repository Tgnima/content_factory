// Propositions de correspondance entre une base Notion existante et l'usine :
// quelle colonne sert de sujet, de format, de date, de statut ; quelle valeur de
// statut veut dire « en cours »… Utilisé par scripts/notion-connect.mjs et par le
// panneau d'administration Slack.
//
// source : { id, name, columns: { nom: { type, values? } } }, tel que décrit par discover().

export const TYPES = ["Référence", "Fait vérifié", "Code de marque", "Cible", "Identité visuelle", "À éviter"]
export const STATES = { todo: "à faire", running: "en cours", review: "à relire", published: "publié", failed: "échec" }

// Les bases que l'intégration voit, avec leurs colonnes et leurs valeurs.
export async function discover(notion) {
  const found = await notion("/search", { method: "POST", body: { filter: { property: "object", value: "data_source" }, page_size: 100 } })
  const plain = (rich) => (rich ?? []).map((t) => t.plain_text ?? "").join("")
  return found.results.map((ds) => ({
    id: ds.id,
    name: plain(ds.title) || "(sans titre)",
    url: ds.url ?? null,
    columns: Object.fromEntries(Object.entries(ds.properties).map(([name, p]) => [name, { type: p.type, ...(p[p.type]?.options ? { values: p[p.type].options.map((o) => o.name) } : {}) }])),
  }))
}


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
