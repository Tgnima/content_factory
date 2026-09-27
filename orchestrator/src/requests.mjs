// Les demandes qui naissent dans un fil existant : les éléments d'un pack, et
// le visuel demandé depuis un brouillon. Chacune a son propre message dans le
// fil, qui porte ses réactions d'état.
import { busyWorkerIds, createRequest, getRequest, queuePosition, updateRequest } from "./db.mjs"
import { briefTooVagueText, postInThread, requestBlocks, setStatus } from "./slack.mjs"
import { checkBrief } from "./jev.mjs"
import { STATUTS, syncStatus } from "./notion.mjs"

// Une demande complète, depuis /contenu ou depuis le planning Notion :
// message d'origine, contrôle JEV, mise en file. Lève une erreur si Slack
// refuse le message (bot absent du canal).
export async function submitRequest({ config, db, client }, { userId, channelId, type, brief, notionPageId = null }) {
  const id = createRequest(db, { userId, channelId, type, brief })
  if (notionPageId) updateRequest(db, id, { notion_page_id: notionPageId })
  let parent
  try {
    parent = await client.chat.postMessage({ channel: channelId, text: `Demande #${id}`, blocks: requestBlocks(config, getRequest(db, id)) })
  } catch (error) {
    updateRequest(db, id, { status: "failed", error: error.message })
    throw error
  }
  updateRequest(db, id, { thread_ts: parent.ts })

  // Contrôle JEV avant la rédaction : une demande floue ne part pas en file.
  // Tant qu'elle est en "new", le dispatcher ne la voit pas.
  const verdict = await checkBrief(config, { typeLabel: config.contentTypes[type].label, brief })
  if (verdict.clear === false) {
    updateRequest(db, id, { status: "question" })
    const asked = getRequest(db, id)
    await setStatus(client, asked, "question")
    await postInThread(client, asked, briefTooVagueText(verdict.p))
    await syncStatus(config, asked, STATUTS.failed)
    return getRequest(db, id)
  }

  updateRequest(db, id, { status: "queued" })
  const queued = getRequest(db, id)
  await setStatus(client, queued, "queued")
  if (verdict.clear) await postInThread(client, queued, `:mag: JEV : demande jugée claire (${Math.round(verdict.p * 100)} %).`)

  const capable = config.workers.filter((w) => w.types.includes(type))
  const busy = new Set(busyWorkerIds(db))
  if (capable.every((w) => busy.has(w.id))) {
    await postInThread(client, queued, `:hourglass_flowing_sand: Tous les rédacteurs sont occupés. Position dans la file : ${queuePosition(db, id)}.`)
  }
  return queued
}

const imageTypeOf = (config) => Object.keys(config.contentTypes).find((t) => config.contentTypes[t].kind === "image")

export async function queueInThread({ config, db, client }, { userId, channelId, threadTs, type, brief, packId = null, announce }) {
  const id = createRequest(db, { userId, channelId, type, brief, threadTs })
  const message = await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: announce(id) })
  updateRequest(db, id, { status_ts: message.ts, status: "queued", pack_id: packId })
  await setStatus(client, getRequest(db, id), "queued")
  return id
}

// Le visuel d'un texte ne reçoit que le début du texte (titre et introduction) :
// c'est assez pour illustrer le sujet, et bien moins de tokens.
export const visualBriefFrom = (config, source) =>
  `Illustration pour ce contenu (${config.contentTypes[source.type].label}), d'après son début :\n${source.draft.slice(0, config.pack?.visualExcerptChars ?? 800)}`

export function queueVisualFor(ctx, source, userId, { packId = null } = {}) {
  const type = imageTypeOf(ctx.config)
  return queueInThread(ctx, {
    userId,
    channelId: source.channel_id,
    threadTs: source.thread_ts,
    type,
    brief: visualBriefFrom(ctx.config, source),
    packId,
    announce: (id) => `:art: *Visuel #${id}*${packId ? "" : ` demandé par <@${userId}>`} pour le contenu #${source.id}.`,
  })
}

// /contenu pack <sujet> : les textes du pack partent tout de suite, en
// parallèle chez les rédacteurs libres. Le visuel attend le texte qui lui
// sert de source (onPackTextReady).
export async function startPack(ctx, { userId, channelId, subject }) {
  const { config, db, client } = ctx
  const pack = config.pack
  const labels = [...pack.texts.map((t) => config.contentTypes[t].label), ...(pack.visualFrom && imageTypeOf(config) ? ["un visuel"] : [])]

  const packId = createRequest(db, { userId, channelId, type: "pack", brief: subject })
  const parent = await client.chat.postMessage({
    channel: channelId,
    text: `Pack #${packId}`,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `*Pack #${packId}* · par <@${userId}>\n${labels.join(", ")}. Suivez l'avancement dans le fil.` } },
      { type: "section", text: { type: "mrkdwn", text: `>${subject.replace(/\n/g, "\n>")}` } },
    ],
  })
  // Le pack lui-même n'est jamais traité par un worker : son statut "pack"
  // le tient hors de la file.
  updateRequest(db, packId, { thread_ts: parent.ts, status: "pack" })

  // Un sujet flou ne lance pas trois productions pour rien.
  const verdict = await checkBrief(config, { typeLabel: "pack article, post et visuel", brief: subject })
  if (verdict.clear === false) {
    updateRequest(db, packId, { status: "question" })
    const asked = getRequest(db, packId)
    await setStatus(client, asked, "question")
    await client.chat.postMessage({ channel: channelId, thread_ts: parent.ts, text: briefTooVagueText(verdict.p).replace("/contenu", "/contenu pack") })
    return
  }

  for (const type of pack.texts) {
    await queueInThread(ctx, {
      userId,
      channelId,
      threadTs: parent.ts,
      type,
      brief: subject,
      packId,
      announce: (id) => `:memo: *${config.contentTypes[type].label} #${id}*`,
    })
  }
}

// Appelé quand un texte arrive en relecture pour la première fois. Si c'est la
// source du visuel d'un pack, le visuel part à son tour.
export async function onPackTextReady(ctx, request) {
  const pack = ctx.config.pack
  if (!request.pack_id || !pack?.visualFrom || request.type !== pack.visualFrom || !imageTypeOf(ctx.config)) return
  const packRequest = getRequest(ctx.db, request.pack_id)
  await queueVisualFor(ctx, request, packRequest.user_id, { packId: request.pack_id })
}
