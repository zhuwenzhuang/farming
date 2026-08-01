export function joinUpstreamUrl(baseUrl: string, requestUrl: string) {
  const base = new URL(baseUrl)
  const request = new URL(requestUrl, 'http://desktop.invalid')
  const basePath = base.pathname === '/' ? '' : base.pathname.replace(/\/+$/, '')
  base.pathname = `${basePath}${request.pathname.startsWith('/') ? request.pathname : `/${request.pathname}`}`
  base.search = request.search
  base.hash = ''
  return base
}

export function bearerCredential(token: string) {
  return Buffer.from(token, 'utf8').toString('base64url')
}
