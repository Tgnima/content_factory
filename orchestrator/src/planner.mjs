// La tâche planifiée (le "cron") : toutes les planning.pollMinutes minutes, les
// sujets du planning Notion au statut "À faire" dont la date prévue est
// arrivée partent en production, comme une demande /contenu. Le brouillon
// arrive dans le canal de planning pour relecture.
import { STATUTS, dueItems, notionEnabled, setItem } from "./notion.mjs"
import { submitRequest } from "./requests.mjs"

export const PLANNING_USER = "planning"

export function startPlanner(ctx) {
  const { config } = ctx
  if (!notionEnabled(config)) return console.log("Planning Notion désactivé (NOTION_TOKEN ou NOTION_DATABASE_ID manquant).")
  if (!config.planningChannelId) return console.log("Planning Notion désactivé : aucun canal (PLANNING_CHANNEL_ID ou ALLOWED_CHANNEL_IDS).")

  // La fréquence est relue à chaque passage : elle peut changer dans les
  // réglages Notion sans redémarrage. Un passage lent ne se superpose jamais
  // au suivant, puisque le suivant n'est programmé qu'à la fin.
  const tick = async () => {
    try {
      if (notionEnabled(config)) for (const item of await dueItems(config)) await launch(ctx, item)
    } catch (error) {
      console.error("Planning Notion :", error.message)
    } finally {
      setTimeout(tick, (config.planning?.pollMinutes ?? 5) * 60_000)
    }
  }
  setTimeout(tick, 10_000)
  console.log(`Planning Notion actif : vérification toutes les ${config.planning?.pollMinutes ?? 5} min, canal ${config.planningChannelId}.`)
}

async function launch({ config, db, client }, item) {
  const textTypes = Object.keys(config.contentTypes).filter((t) => config.contentTypes[t].kind !== "image")
  const type = textTypes.includes(item.format) ? item.format : config.defaultType
  if (!item.sujet) return setItem(config, item.pageId, { statut: STATUTS.failed })

  // Marqué "En cours" d'abord : un passage suivant ne le reprendra pas.
  await setItem(config, item.pageId, { statut: STATUTS.running })
  console.log(`Planning : « ${item.sujet} » (${type}) part en production.`)
  try {
    const request = await submitRequest({ config, db, client }, { userId: PLANNING_USER, channelId: config.planningChannelId, type, brief: item.sujet, notionPageId: item.pageId })
    const link = await client.chat.getPermalink({ channel: request.channel_id, message_ts: request.thread_ts }).catch(() => null)
    if (link?.permalink) await setItem(config, item.pageId, { slackUrl: link.permalink })
  } catch (error) {
    console.error(`Planning : « ${item.sujet} » n'a pas pu partir :`, error.message)
    await setItem(config, item.pageId, { statut: STATUTS.failed }).catch(() => {})
  }
}
