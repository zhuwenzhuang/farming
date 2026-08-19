let startupAccessToken = ''
let startupSearch = ''

export function rememberStartupAccessToken(value: string): void {
  const url = new URL(value)
  startupAccessToken = url.searchParams.get('token') || ''
  startupSearch = url.search
}

export function getStartupAccessToken(): string {
  return startupAccessToken
}

export function getStartupSearch(): string {
  return startupSearch
}
