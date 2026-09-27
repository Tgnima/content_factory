// Contrôles qualité automatiques, l'équivalent des tests de la version GitHub.
// Volontairement légers : le VPS de démo n'a qu'un CPU.

export function countWords(markdown) {
  const text = markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#>*_`~\[\]()!-]/g, " ")
  return text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length
}

export function checkContent(config, type, content) {
  const rules = config.contentTypes[type]
  const problems = []
  const words = countWords(content)

  if (words < rules.minWords) problems.push(`Trop court : ${words} mots, il en faut au moins ${rules.minWords}.`)
  if (words > rules.maxWords) problems.push(`Trop long : ${words} mots, il en faut au plus ${rules.maxWords}.`)

  const lower = content.toLowerCase()
  for (const term of config.forbiddenTerms ?? []) {
    if (lower.includes(term.toLowerCase())) problems.push(`Terme interdit par la charte : « ${term} ».`)
  }

  return { words, problems }
}
