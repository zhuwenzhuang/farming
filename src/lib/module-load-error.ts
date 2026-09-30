export function isModuleLoadError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || '')
  return /dynamically imported module|loading chunk|module script/i.test(message)
}
