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
export function draftBlocks(request, { footer, buttons, visualButton = false, isImage = false, publishButton = false, referenceButton = false }) {
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
  // Après validation : envoyer le contenu dans Notion, et / ou le garder comme
  // référence dans le contexte de l'entreprise.
  const after = []
  if (publishButton) after.push({ type: "button", action_id: "publier", style: "primary", text: { type: "plain_text", text: ":outbox_tray: Publier sur Notion", emoji: true }, value: String(request.id) })
  if (referenceButton) after.push({ type: "button", action_id: "reference", text: { type: "plain_text", text: ":star: Ajouter aux références", emoji: true }, value: String(request.id) })
  if (after.length) blocks.push({ type: "actions", elements: after })
  return blocks
}

// La fenêtre /contenu contexte : ajouter un élément au contexte de l'entreprise.
export function contextModal(types, formats, channelId) {
  const option = (value, label = value) => ({ text: { type: "plain_text", text: label }, value })
  const input = (block_id, label, element, optional = false, hint) => ({ type: "input", block_id, optional, label: { type: "plain_text", text: label }, element, ...(hint ? { hint: { type: "plain_text", text: hint } } : {}) })
  const DESCRIPTIONS = {
    "Référence": "Référence : un contenu qui a bien marché",
    "Fait vérifié": "Fait vérifié : offre, chiffre, certification, client citable",
    "Code de marque": "Code de marque : vocabulaire, accroches, CTA, hashtags",
    "Cible": "Cible : un persona, ses problèmes, ses mots",
    "Identité visuelle": "Identité visuelle : palette, style d'image",
    "À éviter": "À éviter : sujets, mots, concurrents, erreurs",
  }
  return {
    type: "modal",
    callback_id: "contexte_modal",
    private_metadata: channelId,
    title: { type: "plain_text", text: "Contexte de l'entreprise" },
    submit: { type: "plain_text", text: "Ajouter" },
    close: { type: "plain_text", text: "Annuler" },
    blocks: [
      { type: "context", elements: [{ type: "mrkdwn", text: "Les workers s'appuient sur ce contexte pour chaque contenu : les codes et les interdits toujours, les faits, cibles et références quand ils sont proches du sujet." }] },
      input("type", "Type", { type: "static_select", action_id: "v", options: types.map((t) => option(t, DESCRIPTIONS[t] ?? t)) }),
      input("titre", "Titre", { type: "plain_text_input", action_id: "v", max_length: 200, placeholder: { type: "plain_text", text: "Ex. : Post LinkedIn sur la certification HDS" } }),
      input("contenu", "Contenu", { type: "plain_text_input", action_id: "v", multiline: true, max_length: 3000, placeholder: { type: "plain_text", text: "Collez le post, le fait, la règle…" } }),
      input("pourquoi", "Pourquoi ça marche (pour une référence)", { type: "plain_text_input", action_id: "v", multiline: true, max_length: 1000, placeholder: { type: "plain_text", text: "Ex. : accroche chiffrée, 12 000 vues, 40 commentaires" } }, true),
      input("formats", "Formats concernés (vide = tous)", { type: "multi_static_select", action_id: "v", options: formats.map((f) => option(f)) }, true),
    ],
  }
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
    "Contexte de l'entreprise : `/contenu contexte` (ajouter), `/contenu contexte liste`, `/contenu contexte sync`",
  ].join("\n")
