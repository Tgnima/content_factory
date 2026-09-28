// Le superviseur : il exécute les actions qui demandent Docker (changer une clé,
// changer le nombre de workers, redémarrer, mettre à jour), déposées par
// l'orchestrateur dans actions/. L'orchestrateur, lui, n'a aucun accès à
// Docker : s'il était compromis, il ne pourrait demander que ces actions-là.
//
// Protocole :
//   actions/<id>.json          { id, type, params, by }   déposé par l'orchestrateur
//   actions/results/<id>.json  { id, ok, message, log }    écrit par le superviseur
//
// Ce conteneur n'écoute sur aucun port et ne parle ni à Slack ni à Notion.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { spawn } from "node:child_process"
import { join } from "node:path"

const PROJECT = process.env.PROJECT_DIR || process.cwd()
const ACTIONS = join(PROJECT, "actions")
const RESULTS = join(ACTIONS, "results")
mkdirSync(RESULTS, { recursive: true })

// Les seules clés modifiables depuis Slack. Les tokens Slack n'en font pas
// partie : une erreur couperait l'accès au panneau qui sert à la corriger.
const SECRET_KEYS = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "AI_GATEWAY_API_KEY", "OPENAI_API_KEY", "MISTRAL_API_KEY", "OPENROUTER_API_KEY", "LLM_API_KEY", "NOTION_TOKEN"]
const SECRET_VALUE = /^[A-Za-z0-9._\-:+/=]{8,400}$/
const SERVICE = /^(orchestrateur|redacteur-\d{1,2}|illustrateur-1)$/

function run(cmd, args, { input, timeoutMs = 20 * 60_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: PROJECT, env: { ...process.env, PWD: PROJECT } })
    let log = ""
    child.stdout.on("data", (d) => (log += d))
    child.stderr.on("data", (d) => (log += d))
    if (input) child.stdin.end(input)
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs)
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({ code, log: log.slice(-4000) })
    })
  })
}
const compose = (...args) => run("docker", ["compose", ...args])

function setEnv(key, value) {
  const file = join(PROJECT, ".env")
  let text = readFileSync(file, "utf8")
  const line = `${key}=${value}`
  text = new RegExp(`^${key}=.*$`, "m").test(text) ? text.replace(new RegExp(`^${key}=.*$`, "m"), () => line) : `${text.trimEnd()}\n${line}\n`
  writeFileSync(file, text, { mode: 0o600 })
}

const HANDLERS = {
  // Une clé d'API : écrite dans .env, puis les conteneurs concernés sont recréés.
  async "set-secret"({ key, value }) {
    if (!SECRET_KEYS.includes(key)) throw new Error(`clé non modifiable depuis Slack : ${key}`)
    if (value !== "" && !SECRET_VALUE.test(value)) throw new Error("la valeur contient des caractères inattendus (espaces, guillemets…) ou est trop courte")
    setEnv(key, value)
    const r = await compose("up", "-d")
    if (r.code !== 0) throw Object.assign(new Error("les conteneurs n'ont pas redémarré"), { log: r.log })
    return { message: value ? `${key} enregistrée ; conteneurs redémarrés.` : `${key} effacée ; conteneurs redémarrés.` }
  },

  // Le nombre de rédacteurs, et l'illustrateur : la configuration des workers
  // change, docker-compose.yml est régénéré, puis l'usine est reconstruite.
  async "set-workers"({ writers, illustrator }) {
    if (!Number.isInteger(writers) || writers < 1 || writers > 8) throw new Error("de 1 à 8 rédacteurs")
    const file = join(PROJECT, "config/factory.json")
    const config = JSON.parse(readFileSync(file, "utf8"))
    const isImage = (w) => w.types.some((t) => config.contentTypes[t]?.kind === "image")
    const current = config.workers.filter((w) => !isImage(w))
    const textTypes = Object.keys(config.contentTypes).filter((t) => config.contentTypes[t].kind !== "image")
    const lastEngine = current.at(-1)?.engine ?? "claude"
    const next = Array.from({ length: writers }, (_, i) => current[i] ?? { id: `redacteur-${i + 1}`, url: `http://redacteur-${i + 1}:8080`, types: textTypes, engine: lastEngine })
    const image = config.workers.find(isImage) ?? (illustrator ? { id: "illustrateur-1", url: "http://illustrateur-1:8080", types: ["visuel"], engine: "images-codex" } : null)
    config.workers = [...next, ...(illustrator && image ? [image] : [])]
    writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`)
    const up = await run("node", ["scripts/setup.mjs", "--upgrade"])
    if (up.code !== 0) throw Object.assign(new Error("régénération de docker-compose.yml impossible"), { log: up.log })
    const r = await compose("up", "-d", "--build", "--remove-orphans")
    if (r.code !== 0) throw Object.assign(new Error("reconstruction impossible"), { log: r.log })
    return { message: `${writers} rédacteur(s)${illustrator ? " et 1 illustrateur" : ", sans illustrateur"} : usine reconstruite.` }
  },

  async restart({ service }) {
    if (service && !SERVICE.test(service)) throw new Error(`service inconnu : ${service}`)
    const r = await compose("restart", ...(service ? [service] : []))
    if (r.code !== 0) throw Object.assign(new Error("redémarrage impossible"), { log: r.log })
    return { message: service ? `${service} redémarré.` : "Usine redémarrée." }
  },

  // La mise à jour depuis GitHub (bash update.sh). Elle reconstruit tous les
  // conteneurs, superviseur compris : elle tourne donc dans un conteneur
  // ponctuel, que la reconstruction ne touche pas. Ce conteneur écrit lui-même
  // le résultat final, <id>-fin.json.
  async update(_params, id) {
    const script = [
      `bash update.sh > actions/results/${id}.log 2>&1`,
      "code=$?",
      `news=$(grep -cE '^[0-9a-f]{7,} ' actions/results/${id}.log || true)`,
      `printf '{"id":"%s","type":"update-fin","ok":%s,"message":"%s"}' "${id}-fin" "$([ $code = 0 ] && echo true || echo false)" "$([ $code = 0 ] && echo "Mise à jour terminée ($news changement(s)), usine redémarrée." || echo "Mise à jour interrompue : voir actions/results/${id}.log")" > actions/results/${id}-fin.json`,
    ].join("; ")
    const r = await compose("run", "-d", "--rm", "--no-deps", "--entrypoint", "bash", "superviseur", "-c", script)
    if (r.code !== 0) throw Object.assign(new Error("impossible de lancer la mise à jour"), { log: r.log })
    return { message: "Mise à jour lancée : l'usine redémarrera d'elle-même d'ici quelques minutes.", followUp: `${id}-fin` }
  },

  // La connexion ChatGPT de l'illustrateur : le lien et le code sont renvoyés
  // tout de suite pour être affichés dans Slack ; la connexion se termine quand
  // la personne a saisi le code.
  // Le processus de connexion reste ouvert jusqu'à ce que la personne ait saisi
  // le code (15 minutes au plus) ; sa fin donne le résultat final, <id>-fin.json.
  async "codex-login"(_params, id) {
    const child = spawn("docker", ["compose", "exec", "-T", "illustrateur-1", "codex", "login", "--device-auth"], { cwd: PROJECT, env: { ...process.env, PWD: PROJECT } })
    let out = ""
    // Codex affiche le lien et le code en couleur : les codes de couleur
    // (invisibles) collés au code empêcheraient de le reconnaître.
    const plain = () => out.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
    const found = await new Promise((resolve) => {
      const done = () => {
        const url = /(https:\/\/[^\s]+)/.exec(plain())?.[1]
        const code = /(?:^|\s)([A-Z0-9]{4,5}-[A-Z0-9]{4,5})(?:\s|$)/m.exec(plain())?.[1]
        if (url && code) resolve({ url, code })
      }
      child.stdout.on("data", (d) => ((out += d), done()))
      child.stderr.on("data", (d) => ((out += d), done()))
      child.on("close", () => resolve(null))
      setTimeout(() => resolve(null), 60_000)
    })
    if (!found) {
      child.kill()
      throw Object.assign(new Error("Codex n'a pas donné de code de connexion"), { log: plain().slice(-2000) })
    }
    child.on("close", async () => {
      // On demande à Codex lui-même s'il est connecté, plutôt que de deviner
      // d'après ce qu'il a affiché.
      const status = await compose("exec", "-T", "illustrateur-1", "codex", "login", "status")
      const ok = /logged in/i.test(status.log) && !/not logged in/i.test(status.log)
      writeFileSync(join(RESULTS, `${id}-fin.json`), JSON.stringify({ id: `${id}-fin`, type: "codex-login-fin", ok, message: ok ? "l'illustrateur est connecté à ChatGPT." : "la connexion n'a pas abouti (code expiré ou refusé). Relancez « Connecter ChatGPT »." }))
    })
    return { message: `Ouvrez ${found.url} et saisissez le code ${found.code} (valable 15 minutes).`, url: found.url, code: found.code, followUp: `${id}-fin`, followUpType: "codex-login-fin" }
  },
}

async function processAction(file) {
  const path = join(ACTIONS, file)
  const working = `${path}.encours`
  try {
    renameSync(path, working)
  } catch {
    return // déjà pris
  }
  let action
  let result
  try {
    action = JSON.parse(readFileSync(working, "utf8"))
    const handler = HANDLERS[action.type]
    if (!handler) throw new Error(`action inconnue : ${action.type}`)
    console.log(`Action ${action.id} (${action.type}) demandée par ${action.by}`)
    result = { ok: true, ...(await handler(action.params ?? {}, action.id)) }
  } catch (error) {
    result = { ok: false, message: error.message, log: error.log }
  }
  const id = action?.id ?? file.replace(/\.json$/, "")
  writeFileSync(join(RESULTS, `${id}.json`), JSON.stringify({ id, type: action?.type, by: action?.by, at: new Date().toISOString(), ...result }, null, 2))
  unlinkSync(working)
  console.log(`Action ${id} : ${result.ok ? "réussie" : `échec (${result.message})`}`)
}

// Les actions sont traitées une par une, dans l'ordre d'arrivée.
let busy = false
setInterval(async () => {
  if (busy || !existsSync(ACTIONS)) return
  const files = readdirSync(ACTIONS).filter((f) => f.endsWith(".json")).sort()
  if (files.length === 0) return
  busy = true
  try {
    for (const f of files) await processAction(f)
  } finally {
    busy = false
  }
}, 3_000)
console.log(`Superviseur prêt (projet ${PROJECT}).`)
