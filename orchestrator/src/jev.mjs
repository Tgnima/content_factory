// JEV (TypeSafe AI, via Vercel AI Gateway) : un modèle qui n'écrit rien mais
// répond à des questions typées pour une fraction de centime. Il sert de
// contrôleur bon marché :
//   - avant : une demande trop floue est renvoyée avec une question, au lieu
//     de lancer une rédaction entière pour rien ;
//   - après : le texte est vérifié contre la charte, et une nouvelle tentative
//     n'est lancée que si JEV y voit un problème.
//
// JEV n'est jamais bloquant. Sans clé, ou si le service est saturé (erreur
// 429, fréquente au lancement du modèle), l'usine continue comme sans lui.
const ENDPOINT = "https://ai-gateway.vercel.sh/typesafe/v1/systemone"
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export const jevEnabled = (config) => Boolean(config.jevApiKey) && config.jev?.enabled !== false

// Renvoie { answers, cost } ou null si JEV n'a pas pu répondre.
async function evaluate(config, state, questions) {
  if (!jevEnabled(config)) return null
  const tries = config.jev?.tries ?? 2
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { authorization: `Bearer ${config.jevApiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "typesafe-ai/jev", state, questions }),
        signal: AbortSignal.timeout(20_000),
      })
      const body = await res.json().catch(() => ({}))
      if (res.ok && body.answers) return { answers: body.answers, cost: Number(body.provider_metadata?.gateway?.cost ?? 0) }
      console.warn(`JEV ${res.status} (essai ${attempt}/${tries}) : ${body.error?.message ?? body.message ?? "réponse inattendue"}`)
      if (res.status !== 429 && res.status < 500) return null // erreur de requête : réessayer n'y changera rien
    } catch (error) {
      console.warn(`JEV injoignable (essai ${attempt}/${tries}) : ${error.message}`)
    }
    if (attempt < tries) await sleep(3_000 * attempt)
  }
  return null
}

const probability = (answer) => (typeof answer?.noul === "number" ? answer.noul : null)

// Avant la rédaction. Renvoie { clear: true|false|null, p }. null = pas d'avis
// (JEV indisponible), et la demande part normalement.
export async function checkBrief(config, { typeLabel, brief }) {
  const result = await evaluate(config, `Demande de contenu (${typeLabel}) : "${brief}"`, {
    precise: {
      type: "noul",
      instructions: "La demande est-elle assez précise pour produire un contenu utile : on peut identifier au moins le sujet et soit l'angle, soit le public, soit l'objectif ?",
    },
  })
  const p = probability(result?.answers?.precise)
  if (p === null) return { clear: null, p: null }
  return { clear: p >= (config.jev?.briefThreshold ?? 0.3), p }
}

// Après la rédaction. Renvoie { problems: [...], summary } ; summary est null
// si JEV n'a pas donné d'avis.
export async function checkAgainstCharte(config, { charte, brief, content }) {
  const state = `<charte>\n${charte}\n</charte>\n<demande>\n${brief}\n</demande>\n<contenu>\n${content}\n</contenu>`
  const result = await evaluate(config, state, {
    charte: { type: "noul", instructions: "Le contenu respecte-t-il le ton, le public et les règles de la charte ?" },
    invente: {
      type: "noul",
      instructions: "Le contenu contient-il des chiffres, des noms de clients, des témoignages ou des certifications précis qui ne figurent ni dans la demande ni dans la charte ?",
    },
  })
  const pCharte = probability(result?.answers?.charte)
  const pInvente = probability(result?.answers?.invente)
  if (pCharte === null && pInvente === null) return { problems: [], summary: null }

  const problems = []
  if (pCharte !== null && pCharte < (config.jev?.charteThreshold ?? 0.4)) {
    problems.push("Le ton ou les règles de la charte ne semblent pas respectés : relis la charte et ajuste le texte.")
  }
  if (pInvente !== null && pInvente > (config.jev?.inventedThreshold ?? 0.6)) {
    problems.push("Le texte semble contenir des chiffres, clients ou faits précis non fournis : remplace-les par [À COMPLÉTER : …].")
  }
  const pct = (p) => (p === null ? "?" : `${Math.round(p * 100)} %`)
  return { problems, summary: `JEV : charte ${pct(pCharte)}, faits inventés ${pct(pInvente)}` }
}
