declare global {
  interface Window {
    __FARMING_BASE_PATH__?: string
  }
}

const runtimeBasePath = typeof window !== 'undefined' ? window.__FARMING_BASE_PATH__ : undefined
const buildBaseUrl = import.meta.env?.BASE_URL || '/'

export function normalizeAppBasePath(baseUrl: string) {
  if (!baseUrl || baseUrl === '/') return ''
  return baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl
}

export function resolveAppBasePath(runtimeBaseUrl: string | undefined, fallbackBaseUrl: string) {
  return normalizeAppBasePath(runtimeBaseUrl !== undefined ? runtimeBaseUrl : fallbackBaseUrl || '/')
}

export function resolveAppPath(baseUrl: string, path = '/') {
  const basePath = normalizeAppBasePath(baseUrl)
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  return basePath ? `${basePath}${normalizedPath}` : normalizedPath
}

const basePath = resolveAppBasePath(runtimeBasePath, buildBaseUrl)

export function appPath(path = '/') {
  return resolveAppPath(basePath, path)
}

export function appWsUrl() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${location.host}${appPath('/ws')}`
}
