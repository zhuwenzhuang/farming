declare global {
  interface Window {
    __FARMING_BASE_PATH__?: string
  }
}

const runtimeBasePath = typeof window !== 'undefined' ? window.__FARMING_BASE_PATH__ : ''
const rawBaseUrl = runtimeBasePath || import.meta.env.BASE_URL || '/'

function normalizeBasePath(baseUrl: string) {
  if (!baseUrl || baseUrl === '/') return ''
  return baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl
}

const basePath = normalizeBasePath(rawBaseUrl)

export function getBasePath() {
  return basePath
}

export function appPath(path = '/') {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  return basePath ? `${basePath}${normalizedPath}` : normalizedPath
}

export function appWsUrl() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${location.host}${appPath('/ws')}`
}
