// Le panneau d'administration : l'onglet "Accueil" de l'app Slack. Après
// l'installation, tout se règle d'ici (ou dans Notion pour l'éditorial), sans
// toucher au serveur :
//   - modèles des workers           appliqué tout de suite
//   - accès (utilisateurs, admins, canaux)  appliqué tout de suite
//   - branchement des bases Notion  appliqué tout de suite
//   - clés d'API, nombre de workers, mise à jour, connexion ChatGPT
//                                   confiés au superviseur (quelques secondes à minutes)
// Seuls les administrateurs voient et utilisent les réglages.
import { busyWorkerIds } from "./db.mjs"
import { isAdmin, loadOverrides, saveOverride } from "./settings.mjs"
import { ACTION_LABELS, pendingActions, recentActions, requestAction, startActionWatcher, supervisorAvailable } from "./actions.mjs"
import { editorialStatus, syncEditorial } from "./editorial.mjs"
import { librarySummary, syncLibrary, TYPES } from "./library.mjs"
import { notion, resolveId } from "./notionClient.mjs"
import { discover, suggestPlanning, suggestSource, STATES } from "./notionMapping.mjs"
import { notionEnabled } from "./notion.mjs"

const GATEWAY = "https://ai-gateway.vercel.sh/v1"
const SECRET_KEYS = {
  CLAUDE_CODE_OAUTH_TOKEN: "Abonnement Claude (sk-ant-oat01-…)",
  ANTHROPIC_API_KEY: "Clé API Anthropic",
  AI_GATEWAY_API_KEY: "Clé Vercel AI Gateway (modèles, JEV, embeddings)",
  OPENAI_API_KEY: "Clé API OpenAI",
  MISTRAL_API_KEY: "Clé API Mistral",
  OPENROUTER_API_KEY: "Clé OpenRouter",
  LLM_API_KEY: "Clé d'une autre API compatible OpenAI",
  NOTION_TOKEN: "Token d'intégration Notion",
}

const text = (t) => ({ type: "plain_text", text: String(t).slice(0, 75), emoji: true })
const md = (t) => ({ type: "section", text: { type: "mrkdwn", text: String(t).slice(0, 3000) } })
const option = (value, label = value) => ({ text: text(label), value: String(value).slice(0, 150) })
const button = (action_id, label, extra = {}) => ({ type: "button", action_id, text: text(label), ...extra })
const input = (block_id, label, element, extra = {}) => ({ type: "input", block_id, label: text(label), element: { action_id: "v", ...element }, ...extra })
const notionUrl = (id) => `https://www.notion.so/${String(resolveId(id)).replace(/-/g, "")}`
const isImageWorker = (config, w) => w.types.some((t) => config.contentTypes[t]?.kind === "image")
const engineLabel = (config, name) => {
  const e = config.engines?.[name]
  return e ? `${name} (${e.model ?? e.type})` : name ?? "moteur par défaut"
}

// --- L'onglet Accueil ---------------------------------------------------------------

async function workerStates(config, db) {
  const busy = new Set(busyWorkerIds(db))
  return Promise.all(
    config.workers.map(async (w) => {
      let state = busy.has(w.id) ? "occupé" : "libre"
      try {
        const res = await fetch(`${w.url}/health`, { signal: AbortSignal.timeout(3_000) })
        if (!res.ok) state = "injoignable"
      } catch {
        state = "injoignable"
      }
      return `• *${w.id}* : ${engineLabel(config, w.engine)} · ${state}`
    }),
  )
}

async function homeView({ config, db }, userId) {
  const admin = isAdmin(config, userId)
  const queue = db.prepare("SELECT COUNT(*) AS n FROM requests WHERE status = 'queued'").get().n
  const context = librarySummary({ config, db })
  const blocks = [
    { type: "header", text: text(admin ? "Usine à contenu · administration" : "Usine à contenu") },
    md(`*Workers*\n${(await workerStates(config, db)).join("\n")}\nFile d'attente : ${queue} demande(s)`),
    md(
      [
        `*Contexte* : ${context.total} élément(s)${context.total ? ` (${context.withVector} avec recherche par sens)` : ""}`,
        `*Réglages éditoriaux (Notion)* : ${editorialStatus.lastSync ? `${editorialStatus.formats} format(s), ${editorialStatus.rules} règle(s), relus le ${editorialStatus.lastSync.slice(0, 16).replace("T", " à ")}` : "non branchés"}`,
        ...(editorialStatus.errors.length ? [`:warning: ${editorialStatus.errors.slice(0, 5).join("\n:warning: ")}`] : []),
        `*Planning Notion* : ${notionEnabled(config) ? "actif" : "inactif"} · *JEV* : ${config.jevApiKey && config.jev?.enabled !== false ? "actif" : "inactif"}`,
        `*Formats* : ${Object.entries(config.contentTypes).map(([k, t]) => `\`${k}\` ${t.label}`).join(", ")}`,
      ].join("\n"),
    ),
  ]

  if (!admin) {
    blocks.push(
      { type: "divider" },
      md("*Utilisation* : `/contenu aide` dans votre canal. Les réglages sont réservés aux administrateurs" + ((config.adminUsers ?? []).length ? ` (${config.adminUsers.map((u) => `<@${u}>`).join(", ")}).` : ".")),
    )
    return { type: "home", blocks }
  }

  const pending = pendingActions(db)
  const recent = recentActions(db, 4)
  if (pending.length || recent.length) {
    blocks.push(
      md(
        [
          "*Actions*",
          ...pending.map((a) => `:hourglass_flowing_sand: ${a.summary} (par <@${a.by}>)`),
          ...recent.map((a) => `${a.status === "ok" ? ":white_check_mark:" : ":x:"} ${a.summary} : ${String(a.message ?? "").split("\n")[0].slice(0, 200)}`),
        ].join("\n"),
      ),
    )
  }

  const editorialLinks = [config.editorial?.formats, config.editorial?.rules].filter((id) => resolveId(id))
  blocks.push(
    { type: "divider" },
    md("*Réglages* : appliqués tout de suite, sauf les clés, le nombre de workers et la mise à jour, qui redémarrent l'usine (quelques secondes à quelques minutes)."),
    {
      type: "actions",
      elements: [
        button("admin_models", ":brain: Modèles"),
        button("admin_access", ":busts_in_silhouette: Accès"),
        button("admin_connect", ":link: Brancher Notion"),
        button("admin_sync", ":arrows_counterclockwise: Synchroniser"),
      ],
    },
    {
      type: "actions",
      elements: [
        button("admin_keys", ":key: Clés d'API"),
        button("admin_workers", ":construction_worker: Workers"),
        ...(config.workers.some((w) => config.engines?.[w.engine]?.type === "codex") ? [button("admin_codex", ":art: Connecter ChatGPT")] : []),
        button("admin_update", ":arrow_up: Mettre à jour"),
        button("admin_restart", ":repeat: Redémarrer"),
      ],
    },
    ...(editorialLinks.length
      ? [
          md("*Réglages éditoriaux* (formats, longueurs, consignes, termes interdits, JEV, pack…) : modifiez-les directement dans Notion. L'usine les relit toutes les 5 minutes, ou tout de suite avec « Synchroniser »."),
          { type: "actions", elements: [button("admin_open_formats", ":memo: Formats", { url: notionUrl(config.editorial.formats) }), button("admin_open_rules", ":scroll: Règles", { url: notionUrl(config.editorial.rules) })] },
        ]
      : []),
  )
  if (!supervisorAvailable(config)) blocks.push(md(":warning: Le superviseur n'est pas installé : les clés, le nombre de workers et la mise à jour ne peuvent pas être changés d'ici. Lancez `bash update.sh` une fois sur le serveur."))
  return { type: "home", blocks }
}

export const publishHome = async (ctx, client, userId) => client.views.publish({ user_id: userId, view: await homeView(ctx, userId) })

// --- Fenêtres ---------------------------------------------------------------------

const modal = (callback_id, title, blocks, { submit = "Enregistrer", metadata = "" } = {}) => ({
  type: "modal",
  callback_id,
  title: text(title),
  submit: text(submit),
  close: text("Annuler"),
  private_metadata: metadata,
  blocks,
})

function modelsModal(config) {
  const engines = Object.entries(config.engines ?? {})
  const textEngines = engines.filter(([, e]) => ["claude-code", "api"].includes(e.type))
  const imageEngines = engines.filter(([, e]) => ["codex", "openai-responses", "chat-image", "images-api"].includes(e.type))
  const blocks = [md("Choisissez le moteur de chaque worker. Le changement vaut dès la demande suivante, sans redémarrage.")]
  for (const w of config.workers) {
    const list = isImageWorker(config, w) ? imageEngines : textEngines
    const options = list.slice(0, 100).map(([name]) => option(name, engineLabel(config, name)))
    if (options.length === 0) continue // aucun moteur compatible : rien à choisir
    const initial = options.find((o) => o.value === w.engine)
    blocks.push(input(`w_${w.id}`, w.id, { type: "static_select", options, ...(initial ? { initial_option: initial } : {}) }))
  }
  blocks.push(
    { type: "divider" },
    input("new_model", "Ajouter un modèle de texte (Vercel AI Gateway)", { type: "plain_text_input", placeholder: text("ex. mistral/mistral-medium-3.5 ou alibaba/qwen3-max") }, { optional: true, hint: text("Vérifié sur la passerelle. Il sera ensuite proposé dans les listes ci-dessus.") }),
  )
  return modal("admin_models_modal", "Modèles", blocks)
}

function accessModal(config) {
  const users = config.allowedUsers ?? []
  const admins = config.adminUsers ?? []
  const channels = config.allowedChannels ?? []
  return modal("admin_access_modal", "Accès", [
    input("users", "Personnes autorisées à produire (vide = tout l'espace)", { type: "multi_users_select", ...(users.length ? { initial_users: users } : {}) }, { optional: true }),
    input("admins", "Administrateurs (réglages)", { type: "multi_users_select", ...(admins.length ? { initial_users: admins } : {}) }),
    input("channels", "Canaux où l'usine répond (vide = tous)", { type: "multi_conversations_select", filter: { include: ["public", "private"], exclude_bot_users: true }, ...(channels.length ? { initial_conversations: channels } : {}) }, { optional: true }),
    input("planning_channel", "Canal où arrivent les contenus planifiés", { type: "conversations_select", filter: { include: ["public", "private"], exclude_bot_users: true }, ...(config.planningChannelId ? { initial_conversation: config.planningChannelId } : {}) }, { optional: true }),
  ])
}

function keysModal() {
  return modal("admin_keys_modal", "Clés d'API", [
    md(":warning: Slack n'a pas de champ masqué : la clé est visible pendant la saisie et transite par Slack. Elle est ensuite écrite sur le serveur seulement, et n'est jamais affichée. Renouvelez-la chez le fournisseur si elle a pu être vue."),
    input("key", "Clé à changer", { type: "static_select", options: Object.entries(SECRET_KEYS).map(([k, l]) => option(k, l)) }),
    input("value", "Nouvelle valeur (vide = effacer la clé)", { type: "plain_text_input" }, { optional: true }),
    md("Les tokens Slack ne se changent pas d'ici : une erreur couperait l'accès à ce panneau. Ils restent à changer dans le fichier `.env` du serveur."),
  ])
}

function workersModal(config) {
  const writers = config.workers.filter((w) => !isImageWorker(config, w)).length
  const hasIllustrator = config.workers.some((w) => isImageWorker(config, w))
  const counts = [1, 2, 3, 4, 5, 6].map((n) => option(n, `${n} rédacteur${n > 1 ? "s" : ""}`))
  const yesNo = [option("oui", "Oui"), option("non", "Non")]
  return modal("admin_workers_modal", "Workers", [
    md("Compter environ 1,2 Go de RAM par rédacteur Claude (bien moins pour un moteur par API). L'usine est reconstruite : 1 à 3 minutes d'interruption, les demandes en cours reprennent ensuite."),
    input("writers", "Nombre de rédacteurs", { type: "static_select", options: counts, initial_option: counts[Math.min(writers, 6) - 1] }),
    input("illustrator", "Un illustrateur (visuels)", { type: "radio_buttons", options: yesNo, initial_option: yesNo[hasIllustrator ? 0 : 1] }),
  ], { submit: "Reconstruire" })
}

// Branchement Notion, étape 1 : quelles bases.
function connectModal(sources, config) {
  const current = resolveId(config.notion?.planning?.database)
  const options = sources.slice(0, 99).map((s) => option(s.id, s.name))
  const keep = option("__garder__", "Garder le calendrier actuel")
  return modal("admin_connect_modal", "Brancher Notion", [
    md("Les bases que l'intégration Notion voit. Pour en ajouter une : dans Notion, ••• > Connexions > ajoutez l'intégration de l'usine, puis rouvrez cette fenêtre."),
    input("planning", "Votre calendrier éditorial", { type: "static_select", options: [keep, ...options], initial_option: options.find((o) => o.value === current) ?? keep }),
    input("context", "Vos bases de contexte (posts publiés, produits, charte, personas…)", { type: "multi_static_select", options }, { optional: true }),
  ], { submit: "Suivant" })
}

// Étape 2 : vérifier les correspondances proposées.
function reviewModal(plan) {
  const blocks = []
  if (plan.planning) {
    const p = plan.planning
    const statusCol = plan.planningSource.columns[p.columns.status]
    const values = (statusCol?.values ?? []).map((v) => option(v))
    const none = option("__aucun__", "— aucune —")
    blocks.push(md(`*Calendrier « ${plan.planningSource.name} »*\nSujet : *${p.columns.subject}* · Date : *${p.columns.date ?? "?"}* · Format : *${p.columns.format ?? "aucun"}* · Statut : *${p.columns.status ?? "?"}*\nFormats reconnus : ${Object.entries(p.formatValues).map(([k, v]) => `${k} → ${v}`).join(", ") || "aucun (format par défaut)"}`))
    // Slack refuse une liste vide : sans valeurs connues, on garde la proposition.
    if (values.length) {
      for (const [state, label] of Object.entries(STATES)) {
        const initial = values.find((o) => o.value === p.statusValues[state]) ?? none
        blocks.push(input(`state_${state}`, `Statut « ${label} » chez vous`, { type: "static_select", options: [none, ...values.slice(0, 99)], initial_option: initial }))
      }
    }
  }
  plan.sources.forEach((s, i) => {
    const byColumn = s.typeValues ? [option("__colonne__", `D'après la colonne « ${s.columns.type} »`)] : []
    const options = [...byColumn, ...TYPES.map((t) => option(t))]
    const initial = s.typeValues ? byColumn[0] : options.find((o) => o.value === s.type)
    blocks.push(
      { type: "divider" },
      md(`*Contexte « ${s.name} »*${s.filter ? `\nSeulement les lignes où *${s.filter.column}* = *${s.filter.equals}*` : ""}`),
      input(`type_${i}`, "Ce que contient cette base", { type: "static_select", options, initial_option: initial }),
    )
  })
  if (blocks.length === 0) blocks.push(md("Rien à brancher."))
  return modal("admin_review_modal", "Vérifier le branchement", blocks.slice(0, 99), { submit: "Brancher" })
}

// --- Enregistrement ---------------------------------------------------------------

const pendingPlans = new Map() // utilisateur -> branchement en cours de vérification

export function registerAdmin(app, ctx) {
  const { config, db } = ctx
  const refresh = (client, userId) => publishHome(ctx, client, userId).catch((e) => console.error("Accueil :", e.data?.error ?? e.message))
  const dm = (client, userId, message) => client.chat.postMessage({ channel: userId, text: message }).catch(() => {})
  const guard = (fn) => async (args) => {
    await args.ack()
    const userId = args.body.user.id
    if (!isAdmin(config, userId)) return dm(args.client, userId, "Ces réglages sont réservés aux administrateurs de l'usine.")
    return fn(args, userId)
  }
  const open = (view) => async ({ body, client }) => client.views.open({ trigger_id: body.trigger_id, view: typeof view === "function" ? await view() : view })

  app.event("app_home_opened", async ({ event, client }) => {
    if (event.tab === "home") await refresh(client, event.user)
  })

  // Les boutons du panneau.
  app.action("admin_models", guard((args) => open(() => modelsModal(config))(args)))
  app.action("admin_access", guard((args) => open(() => accessModal(config))(args)))
  app.action("admin_keys", guard((args) => open(keysModal())(args)))
  app.action("admin_workers", guard((args) => open(() => workersModal(config))(args)))
  app.action("admin_open_formats", async ({ ack }) => ack())
  app.action("admin_open_rules", async ({ ack }) => ack())
  app.action("admin_connect", guard(async (args, userId) => {
    if (!config.notionToken) return dm(args.client, userId, "Notion n'est pas configuré : ajoutez d'abord la clé NOTION_TOKEN (bouton « Clés d'API »).")
    const sources = await discover((p, o) => notion(config, p, o))
    return args.client.views.open({ trigger_id: args.body.trigger_id, view: connectModal(sources, config) })
  }))
  app.action("admin_sync", guard(async (args, userId) => {
    const [lib, ed] = await Promise.all([syncLibrary(ctx).catch((e) => ({ error: e.message })), syncEditorial(ctx).catch((e) => ({ errors: [e.message] }))])
    await dm(args.client, userId, `:arrows_counterclockwise: Synchronisé : contexte ${lib.error ? `en erreur (${lib.error})` : `${lib.total} élément(s)`} ; réglages éditoriaux ${ed.errors?.length ? `avec ${ed.errors.length} problème(s)` : "à jour"}.`)
    return refresh(args.client, userId)
  }))
  const act = (type, params, summary) => guard(async (args, userId) => {
    try {
      requestAction(ctx, type, params, { by: userId, summary })
      await dm(args.client, userId, `:hourglass_flowing_sand: ${summary} : demandé au superviseur.`)
    } catch (error) {
      await dm(args.client, userId, `Impossible : ${error.message}`)
    }
    return refresh(args.client, userId)
  })
  app.action("admin_update", act("update", {}, "Mise à jour depuis GitHub"))
  app.action("admin_restart", act("restart", {}, "Redémarrage de l'usine"))
  app.action("admin_codex", act("codex-login", {}, "Connexion ChatGPT de l'illustrateur"))

  // Les fenêtres.
  app.view("admin_models_modal", async ({ ack, view, body, client }) => {
    const userId = body.user.id
    if (!isAdmin(config, userId)) return ack()
    const v = view.state.values
    const before = loadOverrides(config)
    const engines = { ...(before.engines ?? {}) }
    const workerEngines = { ...(before.workerEngines ?? {}) }
    const model = v.new_model?.v?.value?.trim()
    if (model) {
      // Un nouveau modèle n'est accepté que s'il existe vraiment sur la passerelle.
      const res = await fetch(`${GATEWAY}/models`, { headers: { authorization: `Bearer ${config.jevApiKey}` }, signal: AbortSignal.timeout(10_000) }).then((r) => r.json()).catch(() => null)
      if (!res?.data) return ack({ response_action: "errors", errors: { new_model: "Impossible de vérifier sur la passerelle (clé Vercel absente ou invalide)." } })
      if (!res.data.some((m) => m.id === model)) return ack({ response_action: "errors", errors: { new_model: `« ${model} » n'existe pas sur la passerelle.` } })
      engines[`gw-${model.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`] = { type: "api", baseUrl: GATEWAY, model, apiKeyEnv: "AI_GATEWAY_API_KEY" }
    }
    for (const w of config.workers) {
      const picked = v[`w_${w.id}`]?.v?.selected_option?.value
      if (picked) workerEngines[w.id] = picked
    }
    await ack()
    saveOverride(config, { engines, workerEngines }, userId)
    await dm(client, userId, `:brain: Modèles enregistrés : ${config.workers.map((w) => `${w.id} = ${engineLabel(config, w.engine)}`).join(" ; ")}.${model ? ` Nouveau modèle disponible : ${model}.` : ""}`)
    await refresh(client, userId)
  })

  app.view("admin_access_modal", async ({ ack, view, body, client }) => {
    const userId = body.user.id
    if (!isAdmin(config, userId)) return ack()
    const v = view.state.values
    const admins = v.admins.v.selected_users ?? []
    if (!admins.includes(userId)) return ack({ response_action: "errors", errors: { admins: "Gardez-vous parmi les administrateurs, sinon vous perdrez l'accès à ce panneau." } })
    await ack()
    saveOverride(config, {
      allowedUsers: v.users.v.selected_users ?? [],
      adminUsers: admins,
      allowedChannels: v.channels.v.selected_conversations ?? [],
      ...(v.planning_channel?.v?.selected_conversation ? { planningChannelId: v.planning_channel.v.selected_conversation } : {}),
    }, userId)
    await dm(client, userId, ":busts_in_silhouette: Accès enregistrés.")
    await refresh(client, userId)
  })

  app.view("admin_keys_modal", async ({ ack, view, body, client }) => {
    const userId = body.user.id
    if (!isAdmin(config, userId)) return ack()
    const key = view.state.values.key.v.selected_option.value
    const value = (view.state.values.value.v.value ?? "").trim()
    if (value && !/^[A-Za-z0-9._\-:+/=]{8,400}$/.test(value)) return ack({ response_action: "errors", errors: { value: "Valeur inattendue : pas d'espace ni de guillemet, 8 caractères au moins." } })
    await ack()
    try {
      requestAction(ctx, "set-secret", { key, value }, { by: userId, summary: `${value ? "Nouvelle valeur" : "Effacement"} de ${key}` })
      await dm(client, userId, `:key: ${key} : demandé au superviseur. Les conteneurs concernés vont redémarrer.`)
    } catch (error) {
      await dm(client, userId, `Impossible : ${error.message}`)
    }
    await refresh(client, userId)
  })

  app.view("admin_workers_modal", async ({ ack, view, body, client }) => {
    const userId = body.user.id
    if (!isAdmin(config, userId)) return ack()
    const writers = Number(view.state.values.writers.v.selected_option.value)
    const illustrator = view.state.values.illustrator.v.selected_option.value === "oui"
    await ack()
    try {
      requestAction(ctx, "set-workers", { writers, illustrator }, { by: userId, summary: `${writers} rédacteur(s)${illustrator ? " + illustrateur" : ""}` })
      await dm(client, userId, `:construction_worker: Reconstruction demandée : ${writers} rédacteur(s)${illustrator ? " et un illustrateur" : ", sans illustrateur"}. L'usine sera indisponible 1 à 3 minutes.`)
    } catch (error) {
      await dm(client, userId, `Impossible : ${error.message}`)
    }
    await refresh(client, userId)
  })

  app.view("admin_connect_modal", async ({ ack, view, body }) => {
    const userId = body.user.id
    if (!isAdmin(config, userId)) return ack()
    const sources = await discover((p, o) => notion(config, p, o))
    const byId = new Map(sources.map((s) => [s.id, s]))
    const planningId = view.state.values.planning.v.selected_option?.value
    const contextIds = (view.state.values.context.v.selected_options ?? []).map((o) => o.value)
    const planningSource = planningId && planningId !== "__garder__" ? byId.get(planningId) : null
    const plan = {
      planningSource,
      planning: planningSource ? suggestPlanning(planningSource) : null,
      sources: contextIds.map((id) => byId.get(id)).filter(Boolean).map(suggestSource),
    }
    if (plan.planning && (!plan.planning.columns.status || !plan.planning.columns.date)) {
      return ack({ response_action: "errors", errors: { planning: "Ce calendrier n'a pas de colonne de statut et de date reconnaissable." } })
    }
    pendingPlans.set(userId, plan)
    return ack({ response_action: "update", view: reviewModal(plan) })
  })

  app.view("admin_review_modal", async ({ ack, view, body, client }) => {
    const userId = body.user.id
    const plan = pendingPlans.get(userId)
    if (!isAdmin(config, userId) || !plan) return ack()
    await ack()
    const v = view.state.values
    const changes = {}
    if (plan.planning) {
      for (const state of Object.keys(STATES)) {
        if (!v[`state_${state}`]) continue // champ absent : on garde la proposition
        const picked = v[`state_${state}`].v?.selected_option?.value
        if (picked && picked !== "__aucun__") plan.planning.statusValues[state] = picked
        else delete plan.planning.statusValues[state]
      }
      changes.planning = plan.planning
    }
    if (plan.sources.length) {
      plan.sources.forEach((s, i) => {
        const picked = v[`type_${i}`]?.v?.selected_option?.value
        if (picked && picked !== "__colonne__") {
          s.type = picked
          delete s.typeValues
          delete s.columns.type
        }
      })
      const names = new Set(plan.sources.map((s) => s.name))
      changes.contextSources = [...(config.context?.sources ?? []).filter((s) => !names.has(s.name)), ...plan.sources]
    }
    pendingPlans.delete(userId)
    if (Object.keys(changes).length === 0) return
    saveOverride(config, changes, userId)
    const lib = changes.contextSources ? await syncLibrary(ctx).catch((e) => ({ error: e.message })) : null
    await dm(client, userId, [
      ":link: Branchement enregistré.",
      changes.planning ? `Calendrier : « ${plan.planningSource.name} ».` : null,
      changes.contextSources ? `Contexte : ${plan.sources.map((s) => `« ${s.name} »`).join(", ")} ; ${lib?.error ? `synchronisation en erreur (${lib.error})` : `${lib?.total ?? 0} élément(s) au total`}.` : null,
    ].filter(Boolean).join("\n"))
    await refresh(client, userId)
  })

  // Les résultats du superviseur : prévenir l'admin et rafraîchir son panneau.
  startActionWatcher(ctx, async (action) => {
    const label = ACTION_LABELS[action.type] ?? action.type
    const extra = action.type === "codex-login" && action.ok ? `\n:point_right: ${action.extra.url}  ·  code : *${action.extra.code}*` : ""
    await dm(app.client, action.by, `${action.ok ? ":white_check_mark:" : ":x:"} ${label} : ${action.message}${extra}`)
    await refresh(app.client, action.by)
  })
}
