// Point d'entrée : connexion à Slack en Socket Mode, commandes, boutons.
import { copyFileSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"
import bolt from "@slack/bolt"
import { isAllowedChannel, isAllowedUser, loadConfig } from "./config.mjs"
import { getRequest, openDb, requeueInterrupted, updateRequest } from "./db.mjs"
import { startDispatcher } from "./dispatcher.mjs"
import { queueVisualFor, startPack, submitRequest } from "./requests.mjs"
import { addPlanningItem, notionEnabled, publish as publishToNotion } from "./notion.mjs"
import { startPlanner } from "./planner.mjs"
import { checkHealth } from "./workerClient.mjs"
import { charteModal, saveCharte } from "./charte.mjs"
import { HELP_TEXT, correctionModal, draftBlocks, postEphemeral, postInThread, setStatus } from "./slack.mjs"

const { App, LogLevel } = bolt

const config = loadConfig()
const db = openDb(join(config.dataDir, "usine.db"))
const isImageType = (type) => config.contentTypes[type]?.kind === "image"
const app = new App({ token: config.slackBotToken, appToken: config.slackAppToken, socketMode: true, logLevel: LogLevel.INFO })

// /contenu [format] demande
app.command("/contenu", async ({ command, ack, client }) => {
  const text = command.text.trim()
  if (!isAllowedUser(config, command.user_id)) return ack({ response_type: "ephemeral", text: "Vous n'êtes pas autorisé à utiliser l'usine à contenu." })
  if (!isAllowedChannel(config, command.channel_id)) return ack({ response_type: "ephemeral", text: "L'usine à contenu n'est pas ouverte dans ce canal." })
  if (!text || text === "aide") return ack({ response_type: "ephemeral", text: HELP_TEXT(config) })

  // /contenu charte : ouvre la fenêtre d'édition de la charte éditoriale.
  if (text.toLowerCase() === "charte") {
    await ack()
    await client.views.open({ trigger_id: command.trigger_id, view: charteModal(config, command.channel_id) })
    return
  }

  // /contenu planifier AAAA-MM-JJ [format] <sujet> : ajoute un sujet au planning Notion.
  const planMatch = /^planifier\s+(\d{4}-\d{2}-\d{2})\s+([\s\S]+)$/i.exec(text)
  if (planMatch) {
    await ack()
    const where = { channel: command.channel_id, user: command.user_id }
    if (!notionEnabled(config)) return postEphemeral(client, where, "Le planning Notion n'est pas configuré (NOTION_TOKEN et NOTION_DATABASE_ID).")
    const [word, ...others] = planMatch[2].trim().split(/\s+/)
    const isFormat = config.contentTypes[word.toLowerCase()] && config.contentTypes[word.toLowerCase()].kind !== "image"
    const format = isFormat ? word.toLowerCase() : config.defaultType
    const sujet = isFormat ? others.join(" ") : planMatch[2].trim()
    if (!sujet) return postEphemeral(client, where, "Précisez le sujet : `/contenu planifier 2026-10-05 blog Votre sujet`")
    try {
      const url = await addPlanningItem(config, { sujet, format, datePrevue: planMatch[1] })
      await postEphemeral(client, where, `:spiral_calendar_pad: Ajouté au planning pour le ${planMatch[1]} (${config.contentTypes[format].label}) : <${url}|voir dans Notion>. Il partira en production automatiquement ce jour-là.`)
    } catch (error) {
      await postEphemeral(client, where, `Impossible d'ajouter au planning : ${error.message}`)
    }
    return
  }

  // /contenu pack <sujet> : article, post et visuel sur un même sujet.
  const packMatch = /^pack\s+([\s\S]+)$/i.exec(text)
  if (packMatch && config.pack) {
    await ack()
    try {
      await startPack({ config, db, client }, { userId: command.user_id, channelId: command.channel_id, subject: packMatch[1].trim() })
    } catch (error) {
      await postEphemeral(client, { channel: command.channel_id, user: command.user_id }, `Impossible de lancer le pack (${error.data?.error ?? error.message}). Invitez le bot dans ce canal avec \`/invite @${config.slackBotName ?? "Content_Factory"}\`.`)
    }
    return
  }

  const [first, ...rest] = text.split(/\s+/)
  const explicitType = config.contentTypes[first.toLowerCase()] ? first.toLowerCase() : null
  const type = explicitType ?? config.defaultType
  const brief = explicitType ? rest.join(" ") : text
  if (!brief) return ack({ response_type: "ephemeral", text: HELP_TEXT(config) })

  // Slack attend une réponse sous 3 secondes. Le reste se fait après.
  await ack()
  try {
    await submitRequest({ config, db, client }, { userId: command.user_id, channelId: command.channel_id, type, brief })
  } catch (error) {
    await postEphemeral(client, { channel: command.channel_id, user: command.user_id }, `Impossible de poster dans ce canal (${error.data?.error ?? error.message}). Invitez le bot dans ce canal avec \`/invite @${config.slackBotName ?? "Content_Factory"}\`.`)
  }
})

// Bouton "Valider" : le brouillon devient le contenu final.
app.action("valider", async ({ ack, body, client }) => {
  await ack()
  const request = getRequest(db, Number(body.actions[0].value))
  const where = { channel: body.channel.id, user: body.user.id, threadTs: request?.thread_ts }
  if (!isAllowedUser(config, body.user.id)) return postEphemeral(client, where, "Vous n'êtes pas autorisé à valider.")
  if (!request || request.status !== "review") return postEphemeral(client, where, "Ce brouillon a déjà été traité.")

  const isImage = isImageType(request.type)
  updateRequest(db, request.id, { status: "approved" })
  await client.chat.update({
    channel: request.channel_id,
    ts: request.draft_msg_ts,
    text: `Contenu #${request.id} validé`,
    blocks: draftBlocks(request, { footer: `:white_check_mark: Validé par <@${body.user.id}>`, buttons: false, isImage, publishButton: !isImage && notionEnabled(config) }),
  })

  if (isImage) {
    // L'image est déjà dans le fil. On la range avec les contenus validés.
    copyFileSync(request.image_path, join(config.dataDir, "exports", basename(request.image_path)))
  } else {
    const filename = `contenu-${request.id}-${request.type}.md`
    writeFileSync(join(config.dataDir, "exports", filename), request.draft)
    await client.files.uploadV2({ channel_id: request.channel_id, thread_ts: request.thread_ts, filename, title: `Contenu #${request.id}`, content: request.draft })
  }
  await setStatus(client, request, "approved")
})

// Bouton "Publier sur Notion", sous un contenu validé.
app.action("publier", async ({ ack, body, client }) => {
  await ack()
  const request = getRequest(db, Number(body.actions[0].value))
  const where = { channel: body.channel.id, user: body.user.id, threadTs: request?.thread_ts }
  if (!isAllowedUser(config, body.user.id)) return postEphemeral(client, where, "Vous n'êtes pas autorisé à publier.")
  if (!request || request.status !== "approved") return postEphemeral(client, where, request?.status === "published" ? "Ce contenu est déjà publié." : "Validez le contenu avant de le publier.")

  // Marqué tout de suite : un double clic ne publie pas deux fois.
  updateRequest(db, request.id, { status: "publishing" })
  try {
    const url = await publishToNotion(config, request)
    updateRequest(db, request.id, { status: "published", notion_url: url })
    await client.chat.update({
      channel: request.channel_id,
      ts: request.draft_msg_ts,
      text: `Contenu #${request.id} publié sur Notion`,
      blocks: draftBlocks(request, { footer: `:outbox_tray: Publié sur Notion par <@${body.user.id}> · <${url}|Ouvrir la page>`, buttons: false }),
    })
    await setStatus(client, request, "published")
  } catch (error) {
    updateRequest(db, request.id, { status: "approved" })
    console.error(`Publication #${request.id} :`, error)
    await postEphemeral(client, where, `La publication sur Notion a échoué : ${error.message}`)
  }
})

// Bouton "Ajouter un visuel" sous un brouillon de texte : une demande de visuel
// naît dans le même fil, à partir du texte. Le brouillon garde ses boutons.
app.action("visuel", async ({ ack, body, client }) => {
  await ack()
  const source = getRequest(db, Number(body.actions[0].value))
  const where = { channel: body.channel.id, user: body.user.id, threadTs: source?.thread_ts }
  if (!isAllowedUser(config, body.user.id)) return postEphemeral(client, where, "Vous n'êtes pas autorisé à demander un visuel.")
  if (!source?.draft) return postEphemeral(client, where, "Ce contenu n'a pas encore de texte à illustrer.")
  await queueVisualFor({ config, db, client }, source, body.user.id)
})

// Bouton "Corriger" : ouvre une fenêtre pour écrire les retours.
app.action("corriger", async ({ ack, body, client }) => {
  await ack()
  const request = getRequest(db, Number(body.actions[0].value))
  const where = { channel: body.channel.id, user: body.user.id, threadTs: request?.thread_ts }
  if (!isAllowedUser(config, body.user.id)) return postEphemeral(client, where, "Vous n'êtes pas autorisé à demander une correction.")
  if (!request || request.status !== "review") return postEphemeral(client, where, "Ce brouillon a déjà été traité.")
  await client.views.open({ trigger_id: body.trigger_id, view: correctionModal(request) })
})

// Envoi de la fenêtre de correction : la demande repart en file avec les retours.
app.view("corriger_modal", async ({ ack, view, body, client }) => {
  const feedback = view.state.values.feedback.text.value?.trim()
  if (!feedback) return ack({ response_action: "errors", errors: { feedback: "Décrivez ce qui doit changer." } })
  await ack()

  const request = getRequest(db, Number(view.private_metadata))
  if (!request || request.status !== "review") return

  updateRequest(db, request.id, { status: "queued", feedback, worker_id: null })
  await client.chat.update({
    channel: request.channel_id,
    ts: request.draft_msg_ts,
    text: `Correction demandée pour le contenu #${request.id}`,
    blocks: draftBlocks(request, { footer: `:repeat: Correction demandée par <@${body.user.id}>`, buttons: false, isImage: isImageType(request.type) }),
  })
  await postInThread(client, request, `:repeat: Correction en file d'attente :\n>${feedback.replace(/\n/g, "\n>")}`)
  await setStatus(client, request, "queued")
})

// Envoi de la fenêtre de la charte.
app.view("charte_modal", async ({ ack, view, body, client }) => {
  if (!isAllowedUser(config, body.user.id)) return ack({ response_action: "errors", errors: { qui: "Vous n'êtes pas autorisé à modifier la charte." } })
  await ack()
  try {
    saveCharte(config, view.state.values, body.user.id)
    await client.chat.postMessage({
      channel: view.private_metadata,
      text: `:memo: <@${body.user.id}> a mis à jour la charte éditoriale. Elle s'applique dès la prochaine demande.`,
    })
  } catch (error) {
    console.error("Charte :", error)
    await postEphemeral(client, { channel: view.private_metadata, user: body.user.id }, `La charte n'a pas pu être enregistrée : ${error.message}`)
  }
})

app.error(async (error) => console.error("Slack :", error))

const requeued = requeueInterrupted(db)
if (requeued) console.log(`${requeued} demande(s) interrompue(s) remise(s) en file.`)

for (const worker of config.workers) {
  const engine = worker.engine ? config.engines[worker.engine] : null
  const engineText = engine ? `moteur ${worker.engine}${engine.model ? ` = ${engine.model}` : ""}` : "moteur par défaut"
  console.log(`${worker.id} (${worker.types.join(", ")}, ${engineText}) : ${(await checkHealth(worker)) ? "prêt" : "INJOIGNABLE"}`)
}

await app.start()
startDispatcher({ config, db, client: app.client })
startPlanner({ config, db, client: app.client })
console.log("Usine à contenu connectée à Slack.")
