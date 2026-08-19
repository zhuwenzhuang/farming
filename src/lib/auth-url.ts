let startupAccessToken = ''

export function rememberStartupAccessToken(value: string): void {
  startupAccessToken = new URL(value).searchParams.get('token') || ''
}

export function getStartupAccessToken(): string {
  return startupAccessToken
}
