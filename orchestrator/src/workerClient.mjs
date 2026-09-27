// Parle à un rédacteur par le réseau interne de Docker.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function call(config, url, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: { "content-type": "application/json", authorization: `Bearer ${config.workerToken}`, ...init.headers },
    signal: AbortSignal.timeout(15_000),
  })
  const body = await res.json().catch(() => ({}))
  return { status: res.status, body }
}

export async function checkHealth(worker) {
  try {
    const res = await fetch(`${worker.url}/health`, { signal: AbortSignal.timeout(5_000) })
    return res.ok
  } catch {
    return false
  }
}

// Lance une rédaction et attend son résultat.
// Renvoie { result, costUsd } ou lève une erreur.
export async function runOnWorker(config, worker, prompt, { onTick } = {}) {
  const deadline = Date.now() + (config.jobTimeoutMinutes + 2) * 60_000

  // 409 : le rédacteur finit encore une rédaction lancée avant un redémarrage
  // de l'orchestrateur. On attend qu'il se libère.
  let started
  while (true) {
    // Le moteur (sans secret : seulement le nom de la variable qui porte la clé)
    // voyage avec la demande. Changer de modèle = modifier config/factory.json
    // et redémarrer l'orchestrateur, sans reconstruire les workers.
    const engine = worker.engine ? config.engines[worker.engine] : null
    started = await call(config, `${worker.url}/run`, { method: "POST", body: JSON.stringify({ prompt, engine }) })
    if (started.status !== 409) break
    if (Date.now() > deadline) throw new Error(`${worker.id} est resté occupé trop longtemps.`)
    await sleep(10_000)
  }
  if (started.status !== 202) throw new Error(`${worker.id} a refusé la rédaction (${started.status} ${JSON.stringify(started.body)}).`)

  const { jobId } = started.body
  const begin = Date.now()
  while (Date.now() < deadline) {
    await sleep(5_000)
    const { status, body } = await call(config, `${worker.url}/status/${jobId}`)
    if (status !== 200) throw new Error(`${worker.id} a perdu la rédaction (${status}). A-t-il redémarré ?`)
    if (body.state === "done") return { result: body.result, costUsd: body.costUsd ?? 0, tokens: body.tokens ?? 0, image: body.image ?? null, model: body.model ?? null }
    if (body.state === "error") throw new Error(body.error)
    onTick?.((Date.now() - begin) / 60_000)
  }
  throw new Error(`${worker.id} n'a pas terminé dans le temps imparti.`)
}
