// La boucle qui répartit le travail : toutes les 3 secondes, chaque rédacteur
// libre prend la plus ancienne demande en attente qu'il sait traiter.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"
import { busyWorkerIds, claimNextRequest, getRequest, updateRequest } from "./db.mjs"
import { buildImagePrompt, buildPrompt } from "./prompt.mjs"
import { houseContext } from "./charte.mjs"
import { describeStats, selectContext } from "./library.mjs"
import { checkAgainstCharte } from "./jev.mjs"
import { STATUTS, syncStatus } from "./notion.mjs"
import { onPackTextReady } from "./requests.mjs"
import { checkContent } from "./checks.mjs"
import { runOnWorker } from "./workerClient.mjs"
import { draftBlocks, postInThread, setStatus } from "./slack.mjs"

const TICK_MS = 3_000

export function startDispatcher({ config, db, client }) {
  const tick = () => {
    const busy = new Set(busyWorkerIds(db))
    for (const worker of config.workers) {
      if (busy.has(worker.id)) continue
      const request = claimNextRequest(db, worker)
      if (!request) continue
      console.log(`Demande #${request.id} -> ${worker.id}`)
      processRequest({ config, db, client }, worker, request).catch((error) => console.error(`Demande #${request.id} :`, error))
    }
  }
  setInterval(() => {
    try {
      tick()
    } catch (error) {
      console.error("Dispatcher :", error)
    }
  }, TICK_MS)
}

const isImageType = (config, type) => config.contentTypes[type]?.kind === "image"

async function processRequest(ctx, worker, request) {
  if (isImageType(ctx.config, request.type)) return processImage(ctx, worker, request)
  return processText(ctx, worker, request)
}

// Un visuel : une seule génération (pas de contrôles automatiques), l'image
// part dans le fil, puis un message avec sa description et les boutons.
async function processImage({ config, db, client }, worker, request) {
  const isRevision = Boolean(request.draft && request.feedback)
  await setStatus(client, request, "running")
  await postInThread(client, request, `:art: *${worker.id}* ${isRevision ? "reprend le visuel" : "crée le visuel"} (OpenAI)…`)

  try {
    const selected = await selectContext({ config, db }, { type: request.type, brief: request.brief })
    const run = await runOnWorker(config, worker, buildImagePrompt(config, request, { context: selected.text }))
    if (!run.image) throw new Error("Aucune image reçue.")

    const revisions = request.revisions + (isRevision ? 1 : 0)
    const imagesDir = join(config.dataDir, "images")
    mkdirSync(imagesDir, { recursive: true })
    const imagePath = join(imagesDir, `visuel-${request.id}-v${revisions + 1}.png`)
    writeFileSync(imagePath, Buffer.from(run.image, "base64"))

    await client.files.uploadV2({
      channel_id: request.channel_id,
      thread_ts: request.thread_ts,
      filename: basename(imagePath),
      title: `Visuel #${request.id}${revisions ? ` (révision ${revisions})` : ""}`,
      file: readFileSync(imagePath),
    })

    updateRequest(db, request.id, { status: "review", draft: run.result, image_path: imagePath, revisions, error: null })
    const updated = getRequest(db, request.id)
    const footer = `${worker.id}${run.model ? ` · ${run.model}` : ""}${revisions ? ` · révision ${revisions}` : ""} · ${describeStats(selected.stats)}`
    const posted = await client.chat.postMessage({
      channel: request.channel_id,
      thread_ts: request.thread_ts,
      text: `Visuel #${request.id} prêt à relire`,
      blocks: draftBlocks(updated, { footer, buttons: true, isImage: true }),
    })
    updateRequest(db, request.id, { draft_msg_ts: posted.ts })
    await setStatus(client, updated, "review")
  } catch (error) {
    await failRequest({ config, db, client }, request, error)
  }
}

async function failRequest({ config, db, client }, request, error) {
  updateRequest(db, request.id, { status: "failed", error: error.message })
  await setStatus(client, request, "failed")
  await syncStatus(config, request, STATUTS.failed)
  await postInThread(client, request, `:warning: La demande #${request.id} a échoué : ${error.message.slice(0, 500)}\nRelancez \`/contenu\` pour réessayer.`)
}

async function processText({ config, db, client }, worker, request) {
  const isRevision = Boolean(request.draft && request.feedback)
  await setStatus(client, request, "running")
  await postInThread(client, request, `:writing_hand: *${worker.id}* ${isRevision ? "reprend le brouillon" : "rédige"}…`)

  try {
    let cost = 0
    let tokens = 0
    let model = null
    let content = null
    let check = { words: 0, problems: [] }
    let problems = []
    let jevVerdict = null
    // Lu à chaque demande : une charte modifiée depuis Slack s'applique aussitôt.
    // Le contexte de l'entreprise choisi pour ce sujet et ce format.
    const selected = await selectContext({ config, db }, { type: request.type, brief: request.brief })
    const house = { charte: houseContext(config).charte, context: selected.text }

    // Un premier passage, puis maxAutoRetries passages si les contrôles
    // échouent : le même principe que "un test échoue, l'agent réessaie".
    for (let attempt = 0; attempt <= config.maxAutoRetries; attempt++) {
      const prompt = buildPrompt(config, request, { problems, previous: content, house })
      const run = await runOnWorker(config, worker, prompt)
      cost += run.costUsd ?? 0
      tokens += run.tokens ?? 0
      model = run.model ?? model
      content = run.result

      if (/^QUESTION:/i.test(content)) {
        updateRequest(db, request.id, { status: "question", cost_usd: request.cost_usd + cost })
        await setStatus(client, request, "question")
        await syncStatus(config, request, STATUTS.failed)
        await postInThread(client, request, `:question: Le rédacteur a besoin d'une précision :\n>${content.replace(/^QUESTION:\s*/i, "")}\nRelancez \`/contenu\` avec une demande plus détaillée.`)
        return
      }

      // D'abord les contrôles locaux, gratuits. JEV ne passe que sur un texte
      // qui les a réussis, et une nouvelle tentative n'a lieu que s'il y voit
      // un problème.
      check = checkContent(config, request.type, content)
      if (check.problems.length === 0) {
        jevVerdict = await checkAgainstCharte(config, { charte: house.charte, brief: request.brief, content })
        check = { ...check, problems: jevVerdict.problems }
      }
      if (check.problems.length === 0) break
      problems = check.problems
      if (attempt < config.maxAutoRetries) {
        await postInThread(client, request, `:repeat: Contrôles non passés, nouvelle tentative :\n${problems.map((p) => `• ${p}`).join("\n")}`)
      }
    }

    const totalCost = request.cost_usd + cost
    const revisions = request.revisions + (isRevision ? 1 : 0)
    updateRequest(db, request.id, { status: "review", draft: content, cost_usd: totalCost, revisions, error: null })
    const updated = getRequest(db, request.id)

    const warnings = check.problems.length ? ` · :warning: ${check.problems.join(" ")}` : ""
    const costText = totalCost > 0 ? ` · coût cumulé ${totalCost.toFixed(3)} $` : ""
    const tokenText = tokens > 0 ? ` · ${tokens.toLocaleString("fr-FR")} tokens` : ""
    const jevText = jevVerdict?.summary ? ` · ${jevVerdict.summary}` : ""
    const footer = `${check.words} mots · ${worker.id}${model ? ` · ${model}` : ""}${revisions ? ` · révision ${revisions}` : ""}${tokenText}${costText} · ${describeStats(selected.stats)}${jevText}${warnings}`
    console.log(`Demande #${request.id} : ${tokens} tokens, ${check.words} mots`)
    const posted = await client.chat.postMessage({
      channel: request.channel_id,
      thread_ts: request.thread_ts,
      text: `Brouillon de la demande #${request.id} prêt à relire`,
      blocks: draftBlocks(updated, { footer, buttons: true, visualButton: hasIllustrator(config) }),
    })
    updateRequest(db, request.id, { draft_msg_ts: posted.ts })
    await setStatus(client, request, "review")
    await syncStatus(config, request, STATUTS.review)
    if (!isRevision) await onPackTextReady({ config, db, client }, getRequest(db, request.id))
  } catch (error) {
    await failRequest({ config, db, client }, request, error)
  }
}

// Le bouton "Ajouter un visuel" n'apparaît que si un illustrateur existe.
export const hasIllustrator = (config) => config.workers.some((w) => w.types.some((t) => isImageType(config, t)))
