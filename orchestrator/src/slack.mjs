// Tout ce que l'usine affiche dans Slack : réactions d'état, messages du fil,
// brouillon avec ses boutons, fenêtre de correction.

// L'état d'une demande se lit d'un coup d'œil sur son message d'origine.
export const STATUS_EMOJI = {
  queued: "hourglass_flowing_sand",
  running: "writing_hand",
  review: "eyes",
  approved: "white_check_mark",
  failed: "warning",
  question: "question",
  published: "outbox_tray",
}

export async function setStatus(client, request, status) {
  const ts = request.status_ts ?? request.thread_ts
  if (!ts) return
  const target = { channel: request.channel_id, timestamp: ts }
  for (const [other, name] of Object.entries(STATUS_EMOJI)) {
    if (other !== status) await client.reactions.remove({ ...target, name }).catch(() => {})
  }
  await client.reactions.add({ ...target, name: STATUS_EMOJI[status] }).catch(() => {})
}

export const postInThread = (client, request, text) =>
  client.chat.postMessage({ channel: request.channel_id, thread_ts: request.thread_ts, text })

export const postEphemeral = (client, { channel, user, threadTs }, text) =>
  client.chat.postEphemeral({ channel, user, thread_ts: threadTs, text }).catch(() => {})

export function requestBlocks(config, request) {
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: `*Demande #${request.id}* · ${config.contentTypes[request.type].label} · ${request.user_id === "planning" ? ":spiral_calendar_pad: planning Notion" : `par <@${request.user_id}>`}` },
    },
    { type: "section", text: { type: "mrkdwn", text: `>${request.brief.replace(/\n/g, "\n>")}` } },
  ]
}

// Le bloc "markdown" de Slack affiche le Markdown standard (titres, listes).
// Il accepte 12 000 caractères. Au-delà, le texte complet part en fichier à la
// validation.
const MARKDOWN_LIMIT = 11_500

// Pour un texte, le brouillon lui-même. Pour un visuel, l'image est envoyée
// juste avant en fichier, et ce message porte sa description et les boutons.
export function draftBlocks(request, { footer, buttons, visualButton = false, isImage = false, publishButton = false }) {
  const draft = request.draft ?? ""
  const blocks = isImage
    ? [{ type: "section", text: { type: "mrkdwn", text: `*Visuel #${request.id}*${draft ? `\n_${draft.slice(0, 2800)}_` : ""}` } }]
    : [{ type: "markdown", text: draft.length > MARKDOWN_LIMIT ? `${draft.slice(0, MARKDOWN_LIMIT)}\n\n_[…] tronqué dans Slack, le fichier complet sera joint à la validation._` : draft }]
  blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: footer }] })

  if (buttons) {
    const elements = [
      { type: "button", action_id: "valider", style: "primary", text: { type: "plain_text", text: "Valider" }, value: String(request.id) },
      { type: "button", action_id: "corriger", text: { type: "plain_text", text: "Corriger" }, value: String(request.id) },
    ]
    if (visualButton) elements.push({ type: "button", action_id: "visuel", text: { type: "plain_text", text: ":art: Ajouter un visuel", emoji: true }, value: String(request.id) })
    blocks.push({ type: "actions", elements })
  }
  // Après validation : envoyer le contenu dans Notion.
  if (publishButton) {
    blocks.push({
      type: "actions",
      elements: [{ type: "button", action_id: "publier", style: "primary", text: { type: "plain_text", text: ":outbox_tray: Publier sur Notion", emoji: true }, value: String(request.id) }],
    })
  }
  return blocks
}

export function correctionModal(request) {
  return {
    type: "modal",
    callback_id: "corriger_modal",
    private_metadata: String(request.id),
    title: { type: "plain_text", text: "Demander une correction" },
    submit: { type: "plain_text", text: "Envoyer" },
    close: { type: "plain_text", text: "Annuler" },
    blocks: [
      {
        type: "input",
        block_id: "feedback",
        label: { type: "plain_text", text: `Qu'est-ce qui doit changer dans le contenu #${request.id} ?` },
        element: {
          type: "plain_text_input",
          action_id: "text",
          multiline: true,
          placeholder: { type: "plain_text", text: "Ex. : ton plus direct, ajouter une section sur la sécurité, raccourcir l'intro" },
        },
      },
    ],
  }
}

export const briefTooVagueText = (p) =>
  [
    `:question: JEV juge cette demande trop vague pour lancer une rédaction (clarté estimée à ${Math.round(p * 100)} %). Aucun token de rédaction n'a été dépensé.`,
    "Précisez au moins le sujet et l'angle, le public ou l'objectif, puis relancez `/contenu`. Par exemple :",
    "> `/contenu blog Pour les DSI de PME : pourquoi héberger ses données de santé en France (HDS, RGPD)`",
  ].join("\n")

export const HELP_TEXT = (config) =>
  [
    "*Usage :* `/contenu [format] votre demande`",
    `Formats : ${Object.entries(config.contentTypes).map(([key, t]) => `\`${key}\` (${t.label})`).join(", ")}. Par défaut : \`${config.defaultType}\`.`,
    "Exemple : `/contenu social Annonce de notre nouvelle offre VPS hébergée en France`",
    "Un visuel seul : `/contenu visuel Bannière pour notre offre cloud souverain`",
    "Tout d'un coup (article, post et visuel) : `/contenu pack Lancement de notre offre cloud souverain`",
    "Planifier un sujet dans Notion : `/contenu planifier 2026-10-05 blog Votre sujet`",
    "Modifier la charte éditoriale : `/contenu charte`",
  ].join("\n")
