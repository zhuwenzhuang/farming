let startupAccessToken = ''

export function rememberStartupAccessToken(value: string): void {
  startupAccessToken = new URL(value).searchParams.get('token') || ''
}

export function getStartupAccessToken(): string {
  return startupAccessToken
}

export function visibleUrlWithoutToken(value: string): string | null {
  const url = new URL(value)
  if (!url.searchParams.has('token')) return null
  url.searchParams.delete('token')
  return `${url.pathname}${url.search}${url.hash}`
}
