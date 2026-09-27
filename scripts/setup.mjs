// Assistant de configuration de l'usine à contenu.
//
// Il pose les questions (modèles, nombre de rédacteurs, Slack, Notion…), teste
// les clés pour de vrai, puis écrit .env, config/factory.json et
// docker-compose.yml. Le code n'a jamais besoin d'être modifié.
//
//   node scripts/setup.mjs                       questions interactives
//   node scripts/setup.mjs --answers FICHIER     réponses lues dans un fichier JSON
//                                                (pour un agent comme Claude Code :
//                                                les secrets restent dans .env)
//   node scripts/setup.mjs --print-questions     les questions et les choix, en JSON
//   node scripts/setup.mjs --check               vérifie seulement la configuration actuelle
//
// Sans Node sur le serveur, install.sh le lance dans un conteneur.
import { createInterface } from "node:readline"
import { existsSync, readFileSync, writeFileSync, copyFileSync, chmodSync } from "node:fs"
import { randomBytes } from "node:crypto"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const ROOT = new URL("../", import.meta.url)
const path = (p) => new URL(p, ROOT)
const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null)

const GATEWAY = "https://ai-gateway.vercel.sh/v1"

// --- Le catalogue des moteurs -------------------------------------------------
// needs : la clé de .env dont le moteur a besoin. "claude" : abonnement ou clé.

const TEXT_ENGINES = {
  claude: { label: "Claude (abonnement Pro/Max ou clé Anthropic)", needs: "claude", engine: { type: "claude-code", model: "claude-sonnet-5" } },
  mistral: { label: "Mistral Large 3, via Vercel AI Gateway (européen)", needs: "AI_GATEWAY_API_KEY", engine: { type: "api", baseUrl: GATEWAY, model: "mistral/mistral-large-3", apiKeyEnv: "AI_GATEWAY_API_KEY" } },
  gemini: { label: "Gemini 3.5 Flash, via Vercel AI Gateway", needs: "AI_GATEWAY_API_KEY", engine: { type: "api", baseUrl: GATEWAY, model: "google/gemini-3.5-flash", apiKeyEnv: "AI_GATEWAY_API_KEY" } },
  deepseek: { label: "DeepSeek V4 Flash, via Vercel AI Gateway (très économique)", needs: "AI_GATEWAY_API_KEY", engine: { type: "api", baseUrl: GATEWAY, model: "deepseek/deepseek-v4-flash", apiKeyEnv: "AI_GATEWAY_API_KEY" } },
  "gateway-autre": { label: "Un autre modèle de Vercel AI Gateway (~390 au choix)", needs: "AI_GATEWAY_API_KEY", ask: ["model"], engine: { type: "api", baseUrl: GATEWAY, apiKeyEnv: "AI_GATEWAY_API_KEY" } },
  "mistral-direct": { label: "Mistral, directement chez Mistral AI", needs: "MISTRAL_API_KEY", engine: { type: "api", baseUrl: "https://api.mistral.ai/v1", model: "mistral-large-latest", apiKeyEnv: "MISTRAL_API_KEY" } },
  openrouter: { label: "OpenRouter (un modèle de votre choix)", needs: "OPENROUTER_API_KEY", ask: ["model"], engine: { type: "api", baseUrl: "https://openrouter.ai/api/v1", apiKeyEnv: "OPENROUTER_API_KEY" } },
  "ollama-local": { label: "Ollama installé sur ce serveur (modèle local, sans clé)", needs: null, ask: ["model"], engine: { type: "api", baseUrl: "http://host.docker.internal:11434/v1" } },
  "api-perso": { label: "Toute autre API compatible OpenAI (adresse et modèle)", needs: "LLM_API_KEY", ask: ["baseUrl", "model"], engine: { type: "api", apiKeyEnv: "LLM_API_KEY" } },
}

const IMAGE_ENGINES = {
  aucun: { label: "Pas de visuels", needs: null, engine: null },
  "images-codex": { label: "Abonnement ChatGPT (via Codex, connexion après l'installation)", needs: null, engine: { type: "codex" } },
  "images-openai": { label: "Clé OpenAI : GPT-6 Astra + GPT Image 2.5", needs: "OPENAI_API_KEY", engine: { type: "openai-responses", model: "gpt-6-astra", imageModel: "gpt-image-2.5-flare", apiKeyEnv: "OPENAI_API_KEY" } },
  "images-flux": { label: "Flux 2 Pro, via Vercel AI Gateway (sobre, sans texte parasite)", needs: "AI_GATEWAY_API_KEY", engine: { type: "images-api", baseUrl: GATEWAY, model: "bfl/flux-2-pro", apiKeyEnv: "AI_GATEWAY_API_KEY" } },
  "images-recraft": { label: "Recraft v4.1, via Vercel AI Gateway (illustrations de marque)", needs: "AI_GATEWAY_API_KEY", engine: { type: "images-api", baseUrl: GATEWAY, model: "recraft/recraft-v4.1", apiKeyEnv: "AI_GATEWAY_API_KEY" } },
  "images-gemini": { label: "Gemini 3.1 Flash Image, via Vercel AI Gateway (très réaliste)", needs: "AI_GATEWAY_API_KEY", engine: { type: "chat-image", baseUrl: GATEWAY, model: "google/gemini-3.1-flash-image", apiKeyEnv: "AI_GATEWAY_API_KEY" } },
}

// Où trouver chaque secret. Affiché avant de le demander.
const SECRETS = {
  SLACK_BOT_TOKEN: { label: "Token du bot Slack (xoxb-…)", help: "api.slack.com/apps > votre app > Install App > Bot User OAuth Token. Créez l'app avec slack-manifest.yml si ce n'est pas fait.", prefix: "xoxb-" },
  SLACK_APP_TOKEN: { label: "Token de l'app Slack (xapp-…)", help: "api.slack.com/apps > votre app > Basic Information > App-Level Tokens > Generate (scope connections:write).", prefix: "xapp-" },
  CLAUDE_CODE_OAUTH_TOKEN: { label: "Token d'abonnement Claude (sk-ant-oat01-…)", help: "Laissez vide : install.sh le génère avec vous après la construction des images (claude setup-token).", optional: true },
  ANTHROPIC_API_KEY: { label: "Clé API Anthropic (sk-ant-api…)", help: "console.anthropic.com > API Keys. Fixez un plafond de dépenses.", prefix: "sk-ant-" },
  AI_GATEWAY_API_KEY: { label: "Clé Vercel AI Gateway (vck_…)", help: "vercel.com > AI Gateway > API Keys. Une carte doit être enregistrée et des crédits ajoutés pour certains modèles (dont JEV).", prefix: "vck_" },
  OPENAI_API_KEY: { label: "Clé API OpenAI (sk-…)", help: "platform.openai.com > API keys, avec du crédit et un plafond de dépenses.", prefix: "sk-" },
  MISTRAL_API_KEY: { label: "Clé API Mistral", help: "console.mistral.ai > API Keys." },
  OPENROUTER_API_KEY: { label: "Clé OpenRouter (sk-or-…)", help: "openrouter.ai > Keys.", prefix: "sk-or-" },
  LLM_API_KEY: { label: "Clé de votre API compatible OpenAI", help: "Chez votre fournisseur." },
  NOTION_TOKEN: { label: "Token d'intégration Notion (ntn_…)", help: "notion.so/profile/integrations > Nouvelle intégration (Interne), capacités Lire / Mettre à jour / Insérer. Connectez-la ensuite à une page (••• > Connexions).", prefix: "ntn_" },
}

// Les questions, dans l'ordre. --print-questions les donne telles quelles à un agent.
const QUESTIONS = [
  { id: "botName", question: "Nom affiché du bot Slack (celui choisi dans l'app Slack)", default: "Content_Factory" },
  { id: "channelId", question: "Identifiant du canal Slack de l'usine (clic droit sur le canal > Copier le lien : la fin du lien, C…). Vide = tous les canaux", default: "" },
  { id: "allowedUserIds", question: "Identifiants Slack des personnes autorisées, séparés par des virgules. Vide = tout l'espace de travail", default: "" },
  { id: "writers", question: "Nombre de rédacteurs (travaillent en parallèle)", default: 2, type: "number" },
  { id: "writerEngines", question: "Moteur de chaque rédacteur (un par rédacteur ; s'il y en a moins, le dernier est répété)", choices: TEXT_ENGINES, default: ["claude"], type: "list" },
  { id: "claudeAuth", question: "Connexion Claude : abonnement (Pro/Max, usage personnel) ou clé API (usage d'équipe)", choices: { abonnement: { label: "Abonnement Claude" }, api: { label: "Clé API Anthropic" } }, default: "abonnement", when: (a) => a.writerEngines.includes("claude") },
  { id: "claudeModel", question: "Modèle Claude", default: "claude-sonnet-5", when: (a) => a.writerEngines.includes("claude") },
  { id: "customModel", question: "Identifiant du modèle (par exemple mistral/mistral-medium-3.5 ou llama3.1)", default: "", when: (a) => a.writerEngines.some((e) => TEXT_ENGINES[e]?.ask?.includes("model")) },
  { id: "customBaseUrl", question: "Adresse de l'API compatible OpenAI (se termine souvent par /v1)", default: "", when: (a) => a.writerEngines.includes("api-perso") },
  { id: "illustrator", question: "Moteur des visuels", choices: IMAGE_ENGINES, default: "images-codex" },
  { id: "jev", question: "Activer JEV, le contrôleur bon marché de la clarté des demandes et de la charte (clé Vercel AI Gateway) ?", default: false, type: "boolean" },
  { id: "notion", question: "Activer le planning éditorial et la publication dans Notion ?", default: false, type: "boolean" },
  { id: "notionPageTitle", question: "Titre de la page Notion connectée à l'intégration, où créer la base", default: "Usine à contenu", when: (a) => a.notion },
]

// --- .env -----------------------------------------------------------------------

function readEnv() {
  if (!existsSync(path(".env"))) copyFileSync(path(".env.example"), path(".env"))
  const text = readFileSync(path(".env"), "utf8")
  const values = Object.fromEntries(text.split(/\r?\n/).map((l) => /^([A-Z_]+)=(.*)$/.exec(l)).filter(Boolean).map((m) => [m[1], m[2].trim()]))
  return { text, values }
}

// Met à jour les lignes KEY= existantes et ajoute les autres à la fin.
function writeEnv(updates) {
  let { text } = readEnv()
  for (const [key, value] of Object.entries(updates)) {
    const line = `${key}=${value ?? ""}`
    text = new RegExp(`^${key}=.*$`, "m").test(text) ? text.replace(new RegExp(`^${key}=.*$`, "m"), line) : `${text.trimEnd()}\n${line}\n`
  }
  writeFileSync(path(".env"), text)
  try {
    chmodSync(path(".env"), 0o600)
  } catch {}
}

// --- Entrées ----------------------------------------------------------------------

// Les lignes reçues sont mises en file : des réponses envoyées d'un coup (par
// un tube, un agent) ne se perdent pas entre deux questions. En terminal, la
// saisie d'un secret s'affiche en étoiles.
let rl = null
let muted = false
let closed = false
const lines = []
const waiting = []
function input() {
  if (!rl) {
    rl = createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) })
    const write = rl._writeToOutput?.bind(rl)
    if (write) rl._writeToOutput = (s) => (muted && !s.includes("\n") && !s.includes("\r") ? process.stdout.write("*".repeat(s.length)) : write(s))
    rl.on("line", (line) => (waiting.length ? waiting.shift().resolve(line) : lines.push(line)))
    rl.on("close", () => {
      closed = true
      while (waiting.length) waiting.shift().reject(new Error("Entrée terminée avant la fin des questions."))
    })
  }
  return rl
}
function ask(question, { secret = false } = {}) {
  input()
  process.stdout.write(question)
  muted = secret && Boolean(process.stdin.isTTY)
  const done = (answer) => {
    muted = false
    if (!process.stdin.isTTY) process.stdout.write(secret ? "***\n" : `${answer}\n`)
    return answer.trim()
  }
  if (lines.length) return Promise.resolve(done(lines.shift()))
  if (closed) return Promise.reject(new Error("Entrée terminée avant la fin des questions."))
  return new Promise((resolve, reject) => waiting.push({ resolve: (l) => resolve(done(l)), reject }))
}

async function askQuestion(q, answers) {
  const def = Array.isArray(q.default) ? q.default.join(",") : String(q.default)
  if (q.choices) {
    const keys = Object.keys(q.choices)
    console.log(`\n${q.question}`)
    keys.forEach((k, i) => console.log(`  ${i + 1}. ${k.padEnd(15)} ${q.choices[k].label}`))
    const hint = q.type === "list" ? `numéros ou noms séparés par des virgules, défaut ${def}` : `numéro ou nom, défaut ${def}`
    const raw = (await ask(`> (${hint}) `)) || def
    const picked = raw.split(",").map((s) => s.trim()).filter(Boolean).map((s) => (/^\d+$/.test(s) ? keys[Number(s) - 1] : s))
    const bad = picked.filter((p) => !keys.includes(p))
    if (bad.length) {
      console.log(`  Choix inconnu : ${bad.join(", ")}`)
      return askQuestion(q, answers)
    }
    return q.type === "list" ? picked : picked[0]
  }
  const raw = await ask(`\n${q.question}\n> (défaut : ${def === "" ? "vide" : def}) `)
  if (q.type === "boolean") return raw ? /^(o|oui|y|yes|1|true)$/i.test(raw) : q.default
  if (q.type === "number") return raw ? Number(raw) : q.default
  return raw || q.default
}

// --- Vérifications en ligne ---------------------------------------------------

async function json(url, init = {}) {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) })
    return { ok: res.ok, status: res.status, body: await res.json().catch(() => ({})) }
  } catch (error) {
    return { ok: false, status: 0, body: { error: { message: error.message } } }
  }
}

const bearer = (key) => ({ headers: { authorization: `Bearer ${key}` } })
let gatewayModels = null

const CHECKS = {
  SLACK_BOT_TOKEN: async (v) => {
    const r = await json("https://slack.com/api/auth.test", { method: "POST", ...bearer(v) })
    return r.body.ok ? `bot « ${r.body.user} » dans l'espace « ${r.body.team} »` : `refusé (${r.body.error})`
  },
  SLACK_APP_TOKEN: async (v) => {
    const r = await json("https://slack.com/api/apps.connections.open", { method: "POST", ...bearer(v) })
    return r.body.ok ? "Socket Mode accepté" : `refusé (${r.body.error})`
  },
  AI_GATEWAY_API_KEY: async (v) => {
    const r = await json(`${GATEWAY}/models`, bearer(v))
    if (!r.ok) return `refusée (${r.status})`
    gatewayModels = new Set(r.body.data.map((m) => m.id))
    return `${gatewayModels.size} modèles accessibles`
  },
  OPENAI_API_KEY: async (v) => ((await json("https://api.openai.com/v1/models", bearer(v))).ok ? "acceptée" : "refusée"),
  MISTRAL_API_KEY: async (v) => ((await json("https://api.mistral.ai/v1/models", bearer(v))).ok ? "acceptée" : "refusée"),
  OPENROUTER_API_KEY: async (v) => ((await json("https://openrouter.ai/api/v1/key", bearer(v))).ok ? "acceptée" : "refusée"),
  ANTHROPIC_API_KEY: async (v) => ((await json("https://api.anthropic.com/v1/models", { headers: { "x-api-key": v, "anthropic-version": "2023-06-01" } })).ok ? "acceptée" : "refusée"),
  NOTION_TOKEN: async (v) => {
    const r = await json("https://api.notion.com/v1/search", { method: "POST", headers: { authorization: `Bearer ${v}`, "Notion-Version": "2026-03-11", "content-type": "application/json" }, body: JSON.stringify({ filter: { property: "object", value: "page" }, page_size: 50 }) })
    return r.ok ? `${r.body.results.length} page(s) partagée(s) avec l'intégration` : `refusé (${r.status})`
  },
}
const isFailure = (text) => /^refus|aucun/i.test(text)

// --- Rendu des fichiers -----------------------------------------------------------

function renderCompose({ writers, illustrator }) {
  const writerIds = Array.from({ length: writers }, (_, i) => `redacteur-${i + 1}`)
  const deps = [...writerIds, ...(illustrator ? ["illustrateur-1"] : [])]
  return `# Usine à contenu. Fichier écrit par scripts/setup.mjs : relancez l'assistant
# plutôt que de le modifier à la main (${writers} rédacteur(s)${illustrator ? ", 1 illustrateur" : ", pas d'illustrateur"}).
#
# Aucun port n'est exposé : l'orchestrateur parle à Slack en Socket Mode
# (connexion sortante) et aux workers par le réseau interne de Docker.

x-logging: &logging
  driver: json-file
  options:
    max-size: "10m"
    max-file: "3"

# Les rédacteurs ne reçoivent que ce dont ils ont besoin : les accès aux
# modèles, jamais les tokens Slack ni Notion.
x-redacteur: &redacteur
  build: ./worker
  restart: unless-stopped
  environment:
    CLAUDE_CODE_OAUTH_TOKEN: \${CLAUDE_CODE_OAUTH_TOKEN:-}
    ANTHROPIC_API_KEY: \${ANTHROPIC_API_KEY:-}
    # Clés des moteurs "api" (config/factory.json > engines). Seules celles qui
    # sont remplies servent.
    AI_GATEWAY_API_KEY: \${AI_GATEWAY_API_KEY:-}
    OPENAI_API_KEY: \${OPENAI_API_KEY:-}
    MISTRAL_API_KEY: \${MISTRAL_API_KEY:-}
    OPENROUTER_API_KEY: \${OPENROUTER_API_KEY:-}
    LLM_API_KEY: \${LLM_API_KEY:-}
    WORKER_TOKEN: \${WORKER_TOKEN}
    CLAUDE_MODEL: \${CLAUDE_MODEL:-claude-sonnet-5}
    JOB_TIMEOUT_MINUTES: \${JOB_TIMEOUT_MINUTES:-10}
  # Pour un modèle local (Ollama sur le serveur) : http://host.docker.internal:11434/v1
  extra_hosts:
    - "host.docker.internal:host-gateway"
  volumes:
    - ./maison:/workspace/maison:ro
  mem_limit: 1.5g
  cpus: 0.9
  logging: *logging

services:
  orchestrateur:
    build: ./orchestrator
    restart: unless-stopped
    environment:
      SLACK_BOT_TOKEN: \${SLACK_BOT_TOKEN}
      SLACK_APP_TOKEN: \${SLACK_APP_TOKEN}
      WORKER_TOKEN: \${WORKER_TOKEN}
      ALLOWED_USER_IDS: \${ALLOWED_USER_IDS:-}
      ALLOWED_CHANNEL_IDS: \${ALLOWED_CHANNEL_IDS:-}
      # JEV, le contrôleur bon marché (facultatif).
      AI_GATEWAY_API_KEY: \${AI_GATEWAY_API_KEY:-}
      # Notion : planning éditorial et publication (facultatif).
      NOTION_TOKEN: \${NOTION_TOKEN:-}
      NOTION_DATABASE_ID: \${NOTION_DATABASE_ID:-}
      PLANNING_CHANNEL_ID: \${PLANNING_CHANNEL_ID:-}
    volumes:
      - ./config:/app/config:ro
      - orchestrateur-data:/app/data
      # En écriture pour /contenu charte. Les workers, eux, le lisent seulement.
      - ./maison:/app/maison
    depends_on:
${deps.map((d) => `      - ${d}`).join("\n")}
    mem_limit: 256m
    cpus: 0.5
    logging: *logging
${writerIds.map((id) => `\n  ${id}:\n    <<: *redacteur\n`).join("")}${
    illustrator
      ? `
  # Les visuels. Le moteur se choisit dans config/factory.json.
  illustrateur-1:
    build: ./illustrator
    restart: unless-stopped
    environment:
      OPENAI_API_KEY: \${OPENAI_API_KEY:-}
      AI_GATEWAY_API_KEY: \${AI_GATEWAY_API_KEY:-}
      MISTRAL_API_KEY: \${MISTRAL_API_KEY:-}
      OPENROUTER_API_KEY: \${OPENROUTER_API_KEY:-}
      LLM_API_KEY: \${LLM_API_KEY:-}
      OPENAI_MODEL: \${OPENAI_MODEL:-gpt-6-astra}
      OPENAI_IMAGE_MODEL: \${OPENAI_IMAGE_MODEL:-gpt-image-2.5-flare}
      OPENAI_IMAGE_SIZE: \${OPENAI_IMAGE_SIZE:-1536x1024}
      OPENAI_IMAGE_QUALITY: \${OPENAI_IMAGE_QUALITY:-medium}
      CODEX_MODEL: \${CODEX_MODEL:-}
      WORKER_TOKEN: \${WORKER_TOKEN}
      JOB_TIMEOUT_MINUTES: \${JOB_TIMEOUT_MINUTES:-10}
    volumes:
      - ./maison:/workspace/maison:ro
      # Connexion ChatGPT de Codex (mode abonnement), gardée entre les redémarrages.
      - illustrateur-codex:/home/node/.codex
    mem_limit: 512m
    cpus: 0.5
    logging: *logging
`
      : ""
  }
volumes:
  orchestrateur-data:
${illustrator ? "  illustrateur-codex:\n" : ""}`
}

// Moteurs choisis -> config/factory.json. Les autres sections sont conservées.
function writeFactoryConfig(answers) {
  const file = JSON.parse(readFileSync(path("config/factory.json"), "utf8"))
  const engines = { ...file.engines }
  const engineName = (key) => {
    const preset = TEXT_ENGINES[key]
    const engine = { ...preset.engine }
    if (key === "claude") engine.model = answers.claudeModel
    if (preset.ask?.includes("model")) engine.model = answers.customModel
    if (preset.ask?.includes("baseUrl")) engine.baseUrl = answers.customBaseUrl
    // Un moteur personnalisé prend un nom tiré de son modèle.
    const name = preset.ask ? `${key}-${String(engine.model).replace(/[^a-z0-9]+/gi, "-").toLowerCase()}` : key
    engines[name] = engine
    return name
  }
  const workers = Array.from({ length: answers.writers }, (_, i) => {
    const key = answers.writerEngines[Math.min(i, answers.writerEngines.length - 1)]
    return { id: `redacteur-${i + 1}`, url: `http://redacteur-${i + 1}:8080`, types: ["blog", "social"], engine: engineName(key) }
  })
  if (answers.illustrator !== "aucun") {
    engines[answers.illustrator] = IMAGE_ENGINES[answers.illustrator].engine
    workers.push({ id: "illustrateur-1", url: "http://illustrateur-1:8080", types: ["visuel"], engine: answers.illustrator })
  }
  file.workers = workers
  file.engines = engines
  file.slackBotName = answers.botName
  file.jev = { ...(file.jev ?? {}), enabled: Boolean(answers.jev) }
  // Sans illustrateur, le pack ne produit plus que les textes.
  if (file.pack) file.pack.visualFrom = answers.illustrator === "aucun" ? null : (file.pack.visualFrom ?? "blog")
  writeFileSync(path("config/factory.json"), `${JSON.stringify(file, null, 2)}\n`)
}

// --- Déroulé ----------------------------------------------------------------------

function neededSecrets(answers) {
  const needs = new Set(["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"])
  for (const key of answers.writerEngines) {
    const n = TEXT_ENGINES[key].needs
    if (n === "claude") needs.add(answers.claudeAuth === "api" ? "ANTHROPIC_API_KEY" : "CLAUDE_CODE_OAUTH_TOKEN")
    else if (n) needs.add(n)
  }
  const imageNeed = IMAGE_ENGINES[answers.illustrator].needs
  if (imageNeed) needs.add(imageNeed)
  if (answers.jev) needs.add("AI_GATEWAY_API_KEY")
  if (answers.notion) needs.add("NOTION_TOKEN")
  return [...needs]
}

function suggestWriters(illustrator) {
  try {
    const kb = Number(/MemTotal:\s+(\d+)/.exec(readFileSync("/proc/meminfo", "utf8"))[1])
    const gb = kb / 1024 / 1024
    const max = Math.max(1, Math.floor((gb - 1 - (illustrator ? 0.5 : 0)) / 1.2))
    return { gb: gb.toFixed(1), max }
  } catch {
    return null
  }
}

function validateAnswers(a) {
  const errors = []
  if (!Number.isInteger(a.writers) || a.writers < 1 || a.writers > 8) errors.push("writers doit être un entier entre 1 et 8.")
  for (const e of a.writerEngines ?? []) if (!TEXT_ENGINES[e]) errors.push(`Moteur de rédacteur inconnu : ${e}.`)
  if (!IMAGE_ENGINES[a.illustrator]) errors.push(`Moteur de visuels inconnu : ${a.illustrator}.`)
  if ((a.writerEngines ?? []).some((e) => TEXT_ENGINES[e]?.ask?.includes("model")) && !a.customModel) errors.push("customModel est obligatoire pour ce moteur.")
  if ((a.writerEngines ?? []).includes("api-perso") && !a.customBaseUrl) errors.push("customBaseUrl est obligatoire pour api-perso.")
  return errors
}

async function main() {
  if (flag("--print-questions")) {
    const printable = QUESTIONS.map(({ when, choices, ...q }) => ({ ...q, ...(choices ? { choices: Object.fromEntries(Object.entries(choices).map(([k, v]) => [k, v.label])) } : {}), ...(when ? { conditional: true } : {}) }))
    console.log(JSON.stringify({ questions: printable, secrets: Object.fromEntries(Object.entries(SECRETS).map(([k, v]) => [k, v.help])) }, null, 2))
    return
  }

  console.log("\n=== Configuration de l'usine à contenu ===")
  const env = readEnv().values

  // 1. Les réponses : fichier (agent) ou questions.
  let answers = {}
  const answersFile = option("--answers")
  if (flag("--check")) {
    answers = null
  } else if (answersFile) {
    answers = JSON.parse(readFileSync(answersFile, "utf8"))
    for (const q of QUESTIONS) if (answers[q.id] === undefined && (!q.when || q.when({ ...defaultsOf(), ...answers }))) answers[q.id] = q.default
  } else {
    const ram = suggestWriters(true)
    if (ram) console.log(`Serveur : ${ram.gb} Go de RAM, soit jusqu'à ${ram.max} rédacteur(s) Claude avec un illustrateur (les moteurs par API sont bien plus légers).`)
    for (const q of QUESTIONS) {
      if (q.when && !q.when(answers)) continue
      answers[q.id] = await askQuestion(q, answers)
    }
  }

  if (answers) {
    const errors = validateAnswers(answers)
    if (errors.length) throw new Error(`Réponses invalides :\n- ${errors.join("\n- ")}`)
  }

  // 2. Les secrets nécessaires : demandés s'ils manquent (mode interactif).
  const needs = answers ? neededSecrets(answers) : Object.keys(CHECKS).filter((k) => env[k] && !/^(xoxb|xapp)-$/.test(env[k]))
  const updates = {}
  for (const key of needs) {
    let value = env[key] && !/^(xoxb|xapp)-$/.test(env[key]) ? env[key] : ""
    const spec = SECRETS[key]
    if (!value && !answersFile && answers && !spec?.optional) {
      console.log(`\n${spec.label}\n  Où la trouver : ${spec.help}`)
      value = await ask("> (collez la valeur, elle ne s'affiche pas) ", { secret: true })
      process.stdout.write("\n")
    }
    if (value) updates[key] = value
  }
  // Tokens Slack inversés : une erreur fréquente, corrigée d'office.
  if (updates.SLACK_BOT_TOKEN?.startsWith("xapp-") && updates.SLACK_APP_TOKEN?.startsWith("xoxb-")) {
    ;[updates.SLACK_BOT_TOKEN, updates.SLACK_APP_TOKEN] = [updates.SLACK_APP_TOKEN, updates.SLACK_BOT_TOKEN]
    console.log("\nLes deux tokens Slack étaient inversés : corrigé.")
  }

  // 3. Vérifications en ligne.
  console.log("\n--- Vérification des accès ---")
  let failures = 0
  for (const key of needs) {
    const value = updates[key]
    const spec = SECRETS[key]
    if (!value) {
      const msg = spec?.optional ? "vide pour l'instant (install.sh le demandera)" : "MANQUANT"
      if (!spec?.optional) failures++
      console.log(`  ${key.padEnd(24)} ${msg}`)
      continue
    }
    if (spec?.prefix && !value.startsWith(spec.prefix)) console.log(`  ${key.padEnd(24)} attention : devrait commencer par ${spec.prefix}`)
    const result = CHECKS[key] ? await CHECKS[key](value) : "présent (non testable ici)"
    if (isFailure(result)) failures++
    console.log(`  ${key.padEnd(24)} ${result}`)
  }
  if (answers && gatewayModels) {
    for (const key of answers.writerEngines) {
      const model = TEXT_ENGINES[key].engine.baseUrl === GATEWAY ? (TEXT_ENGINES[key].ask ? answers.customModel : TEXT_ENGINES[key].engine.model) : null
      if (model) console.log(`  modèle ${model.padEnd(17)} ${gatewayModels.has(model) ? "disponible" : "INTROUVABLE sur la passerelle"}`)
      if (model && !gatewayModels.has(model)) failures++
    }
    const img = IMAGE_ENGINES[answers.illustrator].engine
    if (img?.baseUrl === GATEWAY) console.log(`  modèle ${img.model.padEnd(17)} ${gatewayModels.has(img.model) ? "disponible" : "INTROUVABLE sur la passerelle"}`)
  }

  if (!answers) {
    console.log(failures ? `\n${failures} problème(s) à corriger.` : "\nTout est en ordre.")
    process.exitCode = failures ? 1 : 0
    return
  }

  // 4. Écriture des fichiers.
  writeEnv({
    ...updates,
    WORKER_TOKEN: env.WORKER_TOKEN || randomBytes(32).toString("hex"),
    ALLOWED_CHANNEL_IDS: answers.channelId,
    ALLOWED_USER_IDS: answers.allowedUserIds,
    ...(answers.writerEngines.includes("claude") ? { CLAUDE_MODEL: answers.claudeModel } : {}),
  })
  writeFactoryConfig(answers)
  writeFileSync(path("docker-compose.yml"), renderCompose({ writers: answers.writers, illustrator: answers.illustrator !== "aucun" }))
  console.log("\nÉcrits : .env, config/factory.json, docker-compose.yml")

  // 5. La base Notion, si demandée et pas encore créée.
  if (answers.notion && updates.NOTION_TOKEN && !readEnv().values.NOTION_DATABASE_ID) {
    console.log("\n--- Création de la base Notion « Planning éditorial » ---")
    spawnSync(process.execPath, [fileURLToPath(new URL("notion-setup.mjs", import.meta.url)), "--yes"], { stdio: "inherit", env: { ...process.env, NOTION_PAGE_TITLE: answers.notionPageTitle } })
  }

  // 6. La suite, pour install.sh ou pour la personne.
  const next = []
  if (answers.writerEngines.includes("claude") && answers.claudeAuth === "abonnement" && !readEnv().values.CLAUDE_CODE_OAUTH_TOKEN) next.push("claude-token")
  if (answers.illustrator === "images-codex") next.push("codex-login")
  writeFileSync(path(".setup-next"), next.join("\n"))
  console.log(failures ? `\nConfiguration écrite, mais ${failures} accès à corriger (voir ci-dessus).` : "\nConfiguration terminée.")
  if (next.includes("claude-token")) console.log("  Il reste à générer le token d'abonnement Claude (install.sh le fait avec vous).")
  if (next.includes("codex-login")) console.log("  Il reste à connecter l'illustrateur à ChatGPT (install.sh le fait avec vous).")
  if (failures) process.exitCode = 2
}

const defaultsOf = () => Object.fromEntries(QUESTIONS.map((q) => [q.id, q.default]))

main()
  .catch((error) => {
    console.error(`\nErreur : ${error.message}`)
    process.exitCode = 1
  })
  .finally(() => rl?.close())
