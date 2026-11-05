let startupSearch = ''

export function rememberStartupAccessToken(value: string): void {
  const url = new URL(value)
  startupSearch = url.search
}

export function getCurrentAccessToken(value = window.location.href): string {
  return new URL(value).searchParams.get('token') || ''
}

export function refreshAccessManifest(): void {
  const manifest = document.querySelector<HTMLLinkElement>('link[rel="manifest"]')
  if (!manifest) return
  const url = new URL(manifest.href)
  const token = getCurrentAccessToken()
  if (token) url.searchParams.set('token', token)
  else url.searchParams.delete('token')
  manifest.href = url.href
}

export function getStartupSearch(): string {
  return startupSearch
}
