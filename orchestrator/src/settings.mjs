// Les réglages modifiés après l'installation, sans toucher au serveur.
//
// Trois couches, de la plus basse à la plus haute :
//   1. config/factory.json   écrit à l'installation (setup.mjs) ;
//   2. data/overrides.json   ce que les administrateurs changent dans le panneau
//                            Slack : moteurs des workers, accès, branchement Notion ;
//   3. Notion "Réglages"     les règles éditoriales (formats, longueurs, termes
//                            interdits…), relues régulièrement (editorial.mjs).
//
// config est un objet partagé par tous les modules : on le modifie en place,
// et les changements valent dès la demande suivante, sans redémarrage.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const file = (config) => join(config.dataDir, "overrides.json")

export function loadOverrides(config) {
  try {
    return existsSync(file(config)) ? JSON.parse(readFileSync(file(config), "utf8")) : {}
  } catch (error) {
    console.error(`Réglages (overrides.json illisible, ignoré) : ${error.message}`)
    return {}
  }
}

// Applique les réglages enregistrés sur la configuration en mémoire.
export function applyOverrides(config, overrides = loadOverrides(config)) {
  if (overrides.engines) config.engines = { ...config.engines, ...overrides.engines }
  for (const [workerId, engine] of Object.entries(overrides.workerEngines ?? {})) {
    const worker = config.workers.find((w) => w.id === workerId)
    if (worker && config.engines[engine]) worker.engine = engine
  }
  if (overrides.allowedUsers) config.allowedUsers = overrides.allowedUsers
  if (overrides.allowedChannels) config.allowedChannels = overrides.allowedChannels
  if (overrides.adminUsers?.length) config.adminUsers = overrides.adminUsers
  if (overrides.planning) config.notion = { ...(config.notion ?? {}), planning: overrides.planning }
  if (overrides.contextSources) config.context = { ...(config.context ?? {}), sources: overrides.contextSources }
  if (overrides.planningChannelId) config.planningChannelId = overrides.planningChannelId
  return config
}

// Enregistre un changement (écriture puis renommage : jamais de fichier à
// moitié écrit), puis l'applique.
export function saveOverride(config, changes, byUser) {
  const current = loadOverrides(config)
  const next = { ...current, ...changes, updatedAt: new Date().toISOString(), updatedBy: byUser }
  const tmp = `${file(config)}.tmp`
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`)
  renameSync(tmp, file(config))
  applyOverrides(config, next)
  console.log(`Réglages modifiés par ${byUser} : ${Object.keys(changes).join(", ")}`)
  return next
}

// Les administrateurs changent les réglages ; les utilisateurs autorisés
// produisent des contenus. Sans administrateur déclaré, personne ne peut
// modifier les réglages depuis Slack (il faut en nommer un à l'installation).
export const isAdmin = (config, userId) => (config.adminUsers ?? []).includes(userId)
