// Petit serveur HTTP interne : reçoit une consigne, la fait rédiger par le
// moteur demandé, garde le résultat jusqu'à ce que l'orchestrateur vienne le
// chercher.
//
// Deux sortes de moteurs (config/factory.json, section "engines") :
//   - "claude-code" : Claude Code en mode headless, avec un abonnement Claude
//     (CLAUDE_CODE_OAUTH_TOKEN) ou une clé Anthropic (ANTHROPIC_API_KEY) ;
//   - "api" : n'importe quelle API compatible OpenAI (Vercel AI Gateway et ses
//     centaines de modèles, Mistral, OpenRouter, Ollama en local…).
//
// Un rédacteur ne traite qu'un contenu à la fois. L'orchestrateur le sait déjà
// (il réserve les rédacteurs), le 409 n'est qu'un garde-fou.
//
//   POST /run            { prompt, engine? }  -> 202 { jobId }
//   GET  /status/:jobId  -> { state: running|done|error, result?, tokens?, model?, costUsd?, error? }
//   GET  /health         -> { ok, busy }
import { createServer } from "node:http"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"

const PORT = Number(process.env.PORT || 8080)
const TOKEN = process.env.WORKER_TOKEN
const DEFAULT_CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5"
const TIMEOUT_MS = Number(process.env.JOB_TIMEOUT_MINUTES || 10) * 60_000

// Les seules variables que l'orchestrateur peut désigner comme clé d'un moteur
// "api". Il n'envoie jamais de secret, seulement l'un de ces noms.
const KEY_ENVS = ["AI_GATEWAY_API_KEY", "OPENAI_API_KEY", "MISTRAL_API_KEY", "OPENROUTER_API_KEY", "LLM_API_KEY"]

if (!TOKEN) throw new Error("WORKER_TOKEN manquant.")

// Claude Code se connecte soit avec un abonnement, soit avec une clé API. Une
// variable vide compterait quand même comme présente, donc on ne transmet à
// Claude Code que celle qui est remplie, et aucune des clés des autres moteurs.
const SUBSCRIPTION = Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN)
const CLAUDE_READY = SUBSCRIPTION || Boolean(process.env.ANTHROPIC_API_KEY)
if (SUBSCRIPTION && process.env.ANTHROPIC_API_KEY) throw new Error("CLAUDE_CODE_OAUTH_TOKEN et ANTHROPIC_API_KEY sont remplis tous les deux. Gardez-en un seul.")
const CLAUDE_ENV = Object.fromEntries(Object.entries(process.env).filter(([name, value]) => value !== "" && name !== "WORKER_TOKEN" && !KEY_ENVS.includes(name)))

// Mode allégé : la charte et les exemples arrivent déjà dans la consigne. On
// remplace donc le long prompt système de Claude Code (fait pour coder) par
// une phrase, on retire tous les outils, et la rédaction tient en un seul
// passage. Mesuré sur un post LinkedIn : ~1 500 tokens au lieu de ~89 000.
const SYSTEM_PROMPT = "Tu es un rédacteur professionnel. Tu suis strictement la charte éditoriale et les consignes fournies dans le message."

function runClaudeCode(prompt, engine) {
  if (!CLAUDE_READY) return Promise.reject(new Error("Claude n'est pas configuré sur ce rédacteur (CLAUDE_CODE_OAUTH_TOKEN ou ANTHROPIC_API_KEY dans .env)."))
  const model = engine?.model || DEFAULT_CLAUDE_MODEL
  return new Promise((resolve, reject) => {
    const args = ["-p", prompt, "--output-format", "json", "--model", model, "--system-prompt", SYSTEM_PROMPT, "--tools", "", "--max-turns", "1"]
    const child = spawn("claude", args, { cwd: "/workspace/maison", env: CLAUDE_ENV, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (d) => (stdout += d))
    child.stderr.on("data", (d) => (stderr += d))
    const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS)
    child.on("error", reject)
    child.on("close", (code, signal) => {
      clearTimeout(timer)
      if (signal) return reject(new Error(`Rédaction interrompue après ${TIMEOUT_MS / 60000} minutes.`))
      let out
      try {
        out = JSON.parse(stdout)
      } catch {
        return reject(new Error(`Réponse illisible de Claude Code (code ${code}) : ${(stderr || stdout).slice(-1500)}`))
      }
      if (out.is_error || code !== 0) return reject(new Error(`Claude Code a échoué : ${String(out.result ?? stderr).slice(-1500)}`))
      // Avec un abonnement, rien n'est facturé à l'usage : pas de coût à afficher.
      // Les tokens, eux, comptent dans les deux cas (quota ou facture).
      const u = out.usage ?? {}
      const tokens = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.output_tokens ?? 0)
      resolve({ result: String(out.result ?? "").trim(), costUsd: SUBSCRIPTION ? null : (out.total_cost_usd ?? null), tokens, model })
    })
  })
}

// N'importe quelle API compatible OpenAI (Chat Completions).
async function runApi(prompt, engine) {
  if (!engine.baseUrl || !engine.model) throw new Error("Moteur \"api\" incomplet : baseUrl et model sont obligatoires.")
  const headers = { "content-type": "application/json" }
  if (engine.apiKeyEnv) {
    if (!KEY_ENVS.includes(engine.apiKeyEnv)) throw new Error(`apiKeyEnv "${engine.apiKeyEnv}" non autorisé. Possibles : ${KEY_ENVS.join(", ")}.`)
    const key = process.env[engine.apiKeyEnv]
    if (!key) throw new Error(`La clé ${engine.apiKeyEnv} n'est pas remplie dans .env.`)
    headers.authorization = `Bearer ${key}`
  }
  const res = await fetch(`${engine.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers,
    signal: AbortSignal.timeout(TIMEOUT_MS),
    body: JSON.stringify({
      model: engine.model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
      ...(engine.temperature !== undefined ? { temperature: engine.temperature } : {}),
    }),
  })
  const out = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${engine.model} ${res.status} : ${out.error?.message ?? JSON.stringify(out).slice(0, 500)}`)
  const content = out.choices?.[0]?.message?.content
  if (!content) throw new Error(`${engine.model} n'a renvoyé aucun texte.`)
  return { result: String(content).trim(), costUsd: null, tokens: out.usage?.total_tokens ?? 0, model: engine.model }
}

const run = (prompt, engine) => (engine?.type === "api" ? runApi(prompt, engine) : runClaudeCode(prompt, engine))

let current = null

const send = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" })
  res.end(JSON.stringify(body))
}

createServer(async (req, res) => {
  if (req.url === "/health") return send(res, 200, { ok: true, busy: current?.state === "running" })
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
    run(prompt, engine)
      .then((out) => Object.assign(job, { state: "done", ...out }))
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
  const claude = CLAUDE_READY ? `Claude ${SUBSCRIPTION ? "par abonnement" : "par clé API"}` : "Claude non configuré"
  const apis = KEY_ENVS.filter((name) => process.env[name]).join(", ") || "aucune"
  console.log(`Rédacteur prêt sur le port ${PORT} (${claude} ; clés d'API disponibles : ${apis}).`)
})
