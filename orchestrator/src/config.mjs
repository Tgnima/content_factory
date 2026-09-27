// Charge config/factory.json et les variables d'environnement.
import { readFileSync } from "node:fs"

const CONFIG_PATH = process.env.FACTORY_CONFIG ?? "/app/config/factory.json"

const list = (value) => (value ?? "").split(",").map((s) => s.trim()).filter(Boolean)

export function loadConfig() {
  const file = JSON.parse(readFileSync(CONFIG_PATH, "utf8"))

  for (const name of ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN", "WORKER_TOKEN"]) {
    if (!process.env[name]) throw new Error(`Variable ${name} manquante (voir .env.example).`)
  }
  if (!file.workers?.length) throw new Error("Aucun rédacteur dans config/factory.json.")
  if (!file.contentTypes?.[file.defaultType]) throw new Error(`defaultType "${file.defaultType}" absent de contentTypes.`)
  for (const worker of file.workers) {
    for (const type of worker.types) {
      if (!file.contentTypes[type]) throw new Error(`Le rédacteur ${worker.id} accepte le type inconnu "${type}".`)
    }
  }

  // Chaque worker désigne un moteur de config.engines. Un rédacteur prend un
  // moteur de texte, un illustrateur un moteur d'images.
  const TEXT_ENGINES = ["claude-code", "api"]
  const IMAGE_ENGINES = ["codex", "openai-responses", "chat-image", "images-api"]
  for (const worker of file.workers) {
    if (!worker.engine) continue
    const engine = file.engines?.[worker.engine]
    if (!engine) throw new Error(`Le rédacteur ${worker.id} utilise le moteur inconnu "${worker.engine}" (voir "engines").`)
    const makesImages = worker.types.some((t) => file.contentTypes[t].kind === "image")
    const allowed = makesImages ? IMAGE_ENGINES : TEXT_ENGINES
    if (!allowed.includes(engine.type)) throw new Error(`Le moteur "${worker.engine}" (${engine.type}) ne convient pas à ${worker.id}. Types possibles : ${allowed.join(", ")}.`)
  }

  for (const type of file.pack?.texts ?? []) {
    if (!file.contentTypes[type]) throw new Error(`Le pack contient le type inconnu "${type}".`)
  }
  if (file.pack?.visualFrom && !file.pack.texts.includes(file.pack.visualFrom)) throw new Error(`pack.visualFrom "${file.pack.visualFrom}" doit faire partie de pack.texts.`)

  return {
    ...file,
    maxAutoRetries: file.maxAutoRetries ?? 1,
    jobTimeoutMinutes: file.jobTimeoutMinutes ?? 10,
    slackBotToken: process.env.SLACK_BOT_TOKEN,
    slackAppToken: process.env.SLACK_APP_TOKEN,
    workerToken: process.env.WORKER_TOKEN,
    allowedUsers: list(process.env.ALLOWED_USER_IDS),
    allowedChannels: list(process.env.ALLOWED_CHANNEL_IDS),
    dataDir: process.env.DATA_DIR ?? "/app/data",
    maisonDir: process.env.MAISON_DIR ?? "/app/maison",
    jevApiKey: process.env.AI_GATEWAY_API_KEY ?? "",
    notionToken: process.env.NOTION_TOKEN ?? "",
    notionDatabaseId: process.env.NOTION_DATABASE_ID ?? "",
    // Où arrivent les contenus du planning : PLANNING_CHANNEL_ID, sinon le
    // premier canal autorisé.
    planningChannelId: process.env.PLANNING_CHANNEL_ID || list(process.env.ALLOWED_CHANNEL_IDS)[0] || "",
  }
}

export const isAllowedUser = (config, userId) => config.allowedUsers.length === 0 || config.allowedUsers.includes(userId)
export const isAllowedChannel = (config, channelId) => config.allowedChannels.length === 0 || config.allowedChannels.includes(channelId)
