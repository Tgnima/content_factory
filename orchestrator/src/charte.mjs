// La charte éditoriale (maison/CLAUDE.md), modifiable depuis Slack avec
// `/contenu charte`. Le fichier est découpé en sections "## Titre" : les quatre
// sections ci-dessous sont éditées dans la fenêtre Slack, les autres (par
// exemple "Exemples") sont conservées telles quelles.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"

export const SECTIONS = [
  { id: "qui", heading: "Qui nous sommes", label: "Entreprise et offres", placeholder: "Nom, activité, offres à mettre en avant, ce qui vous différencie" },
  { id: "public", heading: "Public", label: "Public visé", placeholder: "À qui s'adressent les contenus, ce qu'ils attendent" },
  { id: "ton", heading: "Ton", label: "Ton et style", placeholder: "Ex. : expert mais accessible, vouvoiement, phrases courtes" },
  { id: "regles", heading: "Règles", label: "Règles à respecter", placeholder: "Ex. : ne jamais inventer de chiffres, citer la marque 3 fois maximum" },
]

// Une zone de texte Slack accepte au plus 3 000 caractères.
const MAX_LENGTH = 3000

const charteFile = (config) => join(config.maisonDir, "CLAUDE.md")

// Découpe le Markdown en un préambule (avant le premier "## ") et une liste
// ordonnée de sections { heading, body }.
function parse(markdown) {
  const parts = markdown.split(/^## +(.+)$/m)
  const preamble = parts[0].trim()
  const sections = []
  for (let i = 1; i < parts.length; i += 2) sections.push({ heading: parts[i].trim(), body: (parts[i + 1] ?? "").trim() })
  return { preamble, sections }
}

export function readCharte(config) {
  const file = charteFile(config)
  return parse(existsSync(file) ? readFileSync(file, "utf8") : "# Charte éditoriale\n")
}

// Ce que le rédacteur doit savoir de la maison, joint à chaque consigne : la
// charte, puis les exemples (plafonnés, car chaque caractère se paie en
// tokens à chaque rédaction).
const EXAMPLES_BUDGET = 6000

export function houseContext(config) {
  const file = charteFile(config)
  const charte = existsSync(file) ? readFileSync(file, "utf8").trim() : ""
  const dir = join(config.maisonDir, "exemples")
  const examples = []
  let budget = EXAMPLES_BUDGET
  if (existsSync(dir)) {
    for (const name of readdirSync(dir).filter((n) => n.endsWith(".md") && n.toLowerCase() !== "readme.md").sort()) {
      if (budget <= 0) break
      const text = readFileSync(join(dir, name), "utf8").trim().slice(0, budget)
      budget -= text.length
      examples.push(`<exemple fichier="${name}">\n${text}\n</exemple>`)
    }
  }
  return { charte, examples: examples.join("\n") }
}

export function charteModal(config, channelId) {
  const { sections } = readCharte(config)
  const current = (heading) => sections.find((s) => s.heading === heading)?.body.slice(0, MAX_LENGTH) ?? ""

  return {
    type: "modal",
    callback_id: "charte_modal",
    private_metadata: channelId,
    title: { type: "plain_text", text: "Charte éditoriale" },
    submit: { type: "plain_text", text: "Enregistrer" },
    close: { type: "plain_text", text: "Annuler" },
    blocks: [
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: "Les rédacteurs lisent cette charte avant chaque contenu. Les changements s'appliquent dès la prochaine demande. L'ancienne version est conservée." }],
      },
      ...SECTIONS.map((section) => ({
        type: "input",
        block_id: section.id,
        optional: true,
        label: { type: "plain_text", text: section.label },
        element: {
          type: "plain_text_input",
          action_id: "text",
          multiline: true,
          max_length: MAX_LENGTH,
          placeholder: { type: "plain_text", text: section.placeholder },
          ...(current(section.heading) ? { initial_value: current(section.heading) } : {}),
        },
      })),
    ],
  }
}

// Enregistre la charte à partir des valeurs de la fenêtre. L'ancienne version
// part dans data/charte-historique/, et le nouveau fichier remplace l'ancien
// d'un coup (écriture puis renommage), pour qu'un rédacteur ne lise jamais un
// fichier à moitié écrit.
export function saveCharte(config, values, userId) {
  const file = charteFile(config)
  const { preamble, sections } = readCharte(config)

  const edited = new Map(SECTIONS.map((s) => [s.heading, (values[s.id]?.text?.value ?? "").trim()]))
  const kept = sections.filter((s) => !edited.has(s.heading))
  const body = [
    preamble || "# Charte éditoriale",
    ...SECTIONS.map((s) => `## ${s.heading}\n\n${edited.get(s.heading) || "_Non renseigné._"}`),
    ...kept.map((s) => `## ${s.heading}\n\n${s.body}`),
  ].join("\n\n")

  if (existsSync(file)) {
    const historyDir = join(config.dataDir, "charte-historique")
    mkdirSync(historyDir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, "-")
    writeFileSync(join(historyDir, `CLAUDE-${stamp}-avant-${userId}.md`), readFileSync(file))
  }

  const tmp = `${file}.tmp`
  writeFileSync(tmp, `${body.trimEnd()}\n`)
  renameSync(tmp, file)
}
