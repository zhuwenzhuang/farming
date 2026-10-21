interface CatalogModelIdentity {
  value: string
  displayName?: string
}

// Only the latest rendered footer is current provider evidence. Historical
// model-change notices and earlier footers cannot authorize a billed turn.
export function codexTerminalReportsModel(
  rendered: string,
  catalog: readonly CatalogModelIdentity[],
  model: string,
  effort: string,
): boolean {
  const identities = catalog.filter(candidate => candidate.value === model)
  if (identities.length !== 1) return false
  const footers = Array.from(rendered.replace(/\r\n?/g, '\n').matchAll(
    /^[ \t]*(.+?)[ \t]+(minimal|low|medium|high|xhigh|extra high|max|ultra|default)(?:[ \t]+fast)?[ \t]*[·•][ \t]*(?:~|\/)[^\r\n]*$/gm,
  ))
  const footer = footers.at(-1)
  if (!footer || footer[2] !== effort) return false
  const label = footer[1].trim()
  const matches = catalog.filter(candidate => candidate.value === label || candidate.displayName?.trim() === label)
  return matches.length === 1 && matches[0].value === model
}
