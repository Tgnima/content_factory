// L'illustrateur : même protocole que les rédacteurs, pour des images.
//
// Deux façons de se connecter à OpenAI, choisies au démarrage :
//   - clé API (OPENAI_API_KEY) : GPT-6 Astra, en directeur artistique, appelle
//     l'outil image_generation par l'API Responses. Facturé à l'usage.
//   - abonnement ChatGPT : Codex CLI, connecté une fois avec `codex login`,
//     crée l'image avec son outil intégré. Pris sur le quota de l'abonnement.
//
//   POST /run            { prompt }  -> 202 { jobId }
//   GET  /status/:jobId              -> { state, result (description), image (base64), error? }
//   GET  /health                     -> { ok, busy, mode }
import { createServer } from "node:http"
import { spawn } from "node:child_process"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { randomUUID } from "node:crypto"

const PORT = Number(process.env.PORT || 8080)
const TOKEN = process.env.WORKER_TOKEN
const API_KEY = process.env.OPENAI_API_KEY
const MODEL = process.env.OPENAI_MODEL || "gpt-6-astra"
const IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || "gpt-image-2.5-flare"
const SIZE = process.env.OPENAI_IMAGE_SIZE || "1536x1024"
const QUALITY = process.env.OPENAI_IMAGE_QUALITY || "medium"
// Modèle de Codex en mode abonnement. Vide = le modèle par défaut de Codex.
const CODEX_MODEL = process.env.CODEX_MODEL || ""
const TIMEOUT_MS = Number(process.env.JOB_TIMEOUT_MINUTES || 10) * 60_000

const CODEX_HOME = join(process.env.HOME || "/home/node", ".codex")
const MODE = API_KEY ? "api" : "abonnement"

if (!TOKEN) throw new Error("WORKER_TOKEN manquant.")

const SYSTEM =
  "Tu es le directeur artistique de l'entreprise décrite dans cette charte éditoriale. Tu crées une seule image, cohérente avec la marque. Pas de texte dans l'image sauf si la demande le réclame explicitement. Pas de logo inventé."

const readCharte = () => {
  try {
    return readFileSync("/workspace/maison/CLAUDE.md", "utf8")
  } catch {
    return "(pas de charte)"
  }
}

// Les seules variables que l'orchestrateur peut désigner comme clé d'un moteur.
const KEY_ENVS = ["AI_GATEWAY_API_KEY", "OPENAI_API_KEY", "MISTRAL_API_KEY", "OPENROUTER_API_KEY", "LLM_API_KEY"]

function keyFor(engine, fallback) {
  const name = engine?.apiKeyEnv ?? fallback
  if (!KEY_ENVS.includes(name)) throw new Error(`apiKeyEnv "${name}" non autorisé. Possibles : ${KEY_ENVS.join(", ")}.`)
  const key = process.env[name]
  if (!key) throw new Error(`La clé ${name} n'est pas remplie dans .env.`)
  return key
}

const fullPromptOf = (prompt) => `${SYSTEM}\n\n<charte>\n${readCharte()}\n</charte>\n\n${prompt}`
const base64Of = (dataUri) => String(dataUri).replace(/^data:[^;]+;base64,/, "")

// --- Moteur "openai-responses" : GPT-6 Astra + outil image_generation ---------

async function generateWithApi(prompt, engine = {}) {
  const key = keyFor(engine, "OPENAI_API_KEY")
  const res = await fetch(`${(engine.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "")}/responses`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    body: JSON.stringify({
      model: engine.model ?? MODEL,
      input: [
        { role: "developer", content: `${SYSTEM}\n\n<charte>\n${readCharte()}\n</charte>` },
        { role: "user", content: prompt },
      ],
      tools: [{ type: "image_generation", model: engine.imageModel ?? IMAGE_MODEL, size: engine.size ?? SIZE, quality: engine.quality ?? QUALITY }],
      tool_choice: { type: "image_generation" },
    }),
  })
  const out = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`OpenAI ${res.status} : ${out.error?.message ?? JSON.stringify(out).slice(0, 500)}`)

  const call = (out.output ?? []).find((item) => item.type === "image_generation_call" && item.result)
  if (!call) throw new Error("OpenAI n'a renvoyé aucune image.")
  return { result: call.revised_prompt ?? "", image: call.result, model: `${engine.model ?? MODEL} + ${engine.imageModel ?? IMAGE_MODEL}` }
}

// --- Moteur "chat-image" : modèles multimodaux (Gemini Image…) via Chat Completions

async function generateWithChatImage(prompt, engine) {
  const res = await fetch(`${engine.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${keyFor(engine)}`, "content-type": "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    body: JSON.stringify({
      model: engine.model,
      messages: [{ role: "user", content: `${fullPromptOf(prompt)}\n\nCrée l'image, puis décris-la en une phrase en français.` }],
      modalities: ["text", "image"],
      stream: false,
    }),
  })
  const out = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${engine.model} ${res.status} : ${out.error?.message ?? JSON.stringify(out).slice(0, 500)}`)
  const message = out.choices?.[0]?.message ?? {}
  const url = message.images?.[0]?.image_url?.url
  if (!url) throw new Error(`${engine.model} n'a renvoyé aucune image.`)
  return { result: String(message.content ?? "").trim(), image: base64Of(url), model: engine.model }
}

// --- Moteur "images-api" : modèles d'image purs (Flux, Recraft, GPT Image…) ----

async function generateWithImagesApi(prompt, engine) {
  const res = await fetch(`${engine.baseUrl.replace(/\/$/, "")}/images/generations`, {
    method: "POST",
    headers: { authorization: `Bearer ${keyFor(engine)}`, "content-type": "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    body: JSON.stringify({ model: engine.model, prompt: fullPromptOf(prompt).slice(0, 3900), n: 1, ...(engine.size ? { size: engine.size } : {}) }),
  })
  const out = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${engine.model} ${res.status} : ${out.error?.message ?? JSON.stringify(out).slice(0, 500)}`)
  const item = out.data?.[0] ?? {}
  let image = item.b64_json ? base64Of(item.b64_json) : null
  if (!image && item.url) {
    const img = await fetch(item.url, { signal: AbortSignal.timeout(60_000) })
    image = Buffer.from(await img.arrayBuffer()).toString("base64")
  }
  if (!image) throw new Error(`${engine.model} n'a renvoyé aucune image.`)
  return { result: item.revised_prompt ?? "", image, model: engine.model }
}

// Sans moteur désigné, l'ancien comportement : clé API si présente, sinon Codex.
function generate(prompt, engine, jobId) {
  switch (engine?.type) {
    case "codex":
      return generateWithCodex(prompt, jobId)
    case "openai-responses":
      return generateWithApi(prompt, engine)
    case "chat-image":
      return generateWithChatImage(prompt, engine)
    case "images-api":
      return generateWithImagesApi(prompt, engine)
    default:
      return MODE === "api" ? generateWithApi(prompt) : generateWithCodex(prompt, jobId)
  }
}

// --- Mode abonnement : Codex CLI -------------------------------------------------

// Codex range ses images dans ~/.codex/generated_images/. On demande en plus à
// l'agent de copier l'image finale à un chemin connu, parce que certaines
// versions de Codex n'exposent pas toujours le fichier : on prend le premier
// des deux qui existe.
function newestGeneratedImage(since) {
  const dir = join(CODEX_HOME, "generated_images")
  if (!existsSync(dir)) return null
  const files = []
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const path = join(d, name)
      const st = statSync(path)
      if (st.isDirectory()) walk(path)
      else if (/\.(png|jpe?g|webp)$/i.test(name) && st.mtimeMs >= since) files.push({ path, mtime: st.mtimeMs })
    }
  }
  walk(dir)
  return files.sort((a, b) => b.mtime - a.mtime)[0]?.path ?? null
}

function generateWithCodex(prompt, jobId) {
  if (!existsSync(join(CODEX_HOME, "auth.json"))) {
    return Promise.reject(new Error("L'illustrateur n'est pas connecté à ChatGPT. Lancez sur le serveur : sudo docker compose exec -it illustrateur-1 codex login --device-auth"))
  }
  const target = `/tmp/jobs/${jobId}.png`
  const lastMessage = `/tmp/jobs/${jobId}.txt`
  const fullPrompt = [
    SYSTEM,
    "",
    "<charte>",
    readCharte(),
    "</charte>",
    "",
    prompt,
    "",
    `Utilise ton outil de génération d'images pour créer UNE image au format paysage, puis copie le fichier image obtenu vers ${target}.`,
    "Termine par une seule phrase qui décrit l'image créée, en français.",
  ].join("\n")

  const args = ["exec", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", "--enable", "image_generation", "--output-last-message", lastMessage]
  if (CODEX_MODEL) args.push("--model", CODEX_MODEL)
  args.push(fullPrompt)

  const started = Date.now() - 1000
  return new Promise((resolve, reject) => {
    const child = spawn("codex", args, { cwd: "/tmp/jobs", stdio: ["ignore", "pipe", "pipe"] })
    let log = ""
    child.stdout.on("data", (d) => (log += d))
    child.stderr.on("data", (d) => (log += d))
    const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS)
    child.on("error", reject)
    child.on("close", (code, signal) => {
      clearTimeout(timer)
      if (signal) return reject(new Error(`Génération interrompue après ${TIMEOUT_MS / 60000} minutes.`))
      const imagePath = existsSync(target) ? target : newestGeneratedImage(started)
      if (!imagePath) return reject(new Error(`Codex n'a produit aucune image (code ${code}) : ${log.slice(-1200)}`))
      const description = existsSync(lastMessage) ? readFileSync(lastMessage, "utf8").trim() : ""
      resolve({ result: description, image: readFileSync(imagePath).toString("base64") })
    })
  })
}

// --- Serveur ----------------------------------------------------------------------

let current = null

const send = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" })
  res.end(JSON.stringify(body))
}

createServer(async (req, res) => {
  if (req.url === "/health") return send(res, 200, { ok: true, busy: current?.state === "running", mode: MODE })
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(res, 401, { error: "unauthorized" })

  if (req.method === "POST" && req.url === "/run") {
    if (current?.state === "running") return send(res, 409, { error: "busy" })
    let raw = ""
    for await (const chunk of req) raw += chunk
    let prompt, engine
    try {
      ;({ prompt, engine } = JSON.parse(raw || "{}"))
    } catch {
      return send(res, 400, { error: "JSON invalide" })
    }
    if (!prompt) return send(res, 400, { error: "prompt manquant" })

    const job = { id: randomUUID(), state: "running" }
    current = job
    generate(prompt, engine, job.id)
      .then(({ result, image, model }) => Object.assign(job, { state: "done", result, image, model: model ?? (engine?.type === "codex" || !engine ? "Codex (ChatGPT)" : null) }))
      .catch((error) => Object.assign(job, { state: "error", error: error.message }))
    return send(res, 202, { jobId: job.id })
  }

  const match = /^\/status\/([\w-]+)$/.exec(req.url ?? "")
  if (req.method === "GET" && match) {
    if (current?.id !== match[1]) return send(res, 404, { error: "job inconnu" })
    const { id, ...rest } = current
    return send(res, 200, rest)
  }

  send(res, 404, { error: "not found" })
}).listen(PORT, () => {
  const detail = MODE === "api" ? `clé API, ${MODEL} + ${IMAGE_MODEL}, ${SIZE}, qualité ${QUALITY}` : `abonnement ChatGPT via Codex${CODEX_MODEL ? `, modèle ${CODEX_MODEL}` : ""}, ${existsSync(join(CODEX_HOME, "auth.json")) ? "connecté" : "PAS ENCORE CONNECTÉ"}`
  console.log(`Illustrateur prêt sur le port ${PORT} (${detail}).`)
})
