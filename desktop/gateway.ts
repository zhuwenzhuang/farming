import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import https from 'node:https'
import path from 'node:path'
import { WebSocket, WebSocketServer, type RawData } from 'ws'
import { DesktopConnectionManager } from './connection-manager.js'
import { DesktopProfileStore } from './profile-store.js'
import { bearerCredential, joinUpstreamUrl } from './upstream.js'

const SESSION_COOKIE = 'farming_desktop_session'
const MAX_QUEUED_WEBSOCKET_BYTES = 1024 * 1024
const DESKTOP_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'none'",
  "connect-src 'self' ws://127.0.0.1:*",
  "font-src 'self' data:",
  "form-action 'self'",
  "frame-src 'self'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "object-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval' 'sha256-UVP3DE6wlLHoOMAEu0MMhgh+it68V2l14Lw37UgjBC0='",
  "style-src 'self' 'unsafe-inline'",
  "worker-src 'self' blob:",
].join('; ')

const CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

function sendJson(response: ServerResponse, status: number, body: object) {
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
  })
  response.end(JSON.stringify(body))
}

function rawDataByteLength(data: RawData) {
  if (Array.isArray(data)) return data.reduce((total, chunk) => total + chunk.length, 0)
  return data.byteLength
}

function staticFilePath(distDir: string, requestPath: string) {
  let pathname = ''
  try {
    pathname = decodeURIComponent(requestPath)
  } catch {
    return null
  }
  if (pathname === '/' || /^\/(code|review|error-preview)(\/|$)/.test(pathname)) {
    return path.join(distDir, 'index.html')
  }
  const relative = pathname.replace(/^\/+/, '')
  const candidate = path.resolve(distDir, relative)
  if (!candidate.startsWith(`${path.resolve(distDir)}${path.sep}`)) return null
  try {
    return fs.statSync(candidate).isFile() ? candidate : null
  } catch {
    return null
  }
}

function localRendererReferences(indexHtml: string) {
  const references: string[] = []
  for (const match of indexHtml.matchAll(/<(script|link)\b[^>]*>/gi)) {
    const tag = match[0]
    const kind = (match[1] || '').toLowerCase()
    if (kind === 'link') {
      const rel = tag.match(/\brel=["']([^"']+)["']/i)?.[1] || ''
      if (!/(?:^|\s)(?:modulepreload|stylesheet)(?:\s|$)/i.test(rel)) continue
    }
    const reference = tag.match(kind === 'script' ? /\bsrc=["']([^"']+)["']/i : /\bhref=["']([^"']+)["']/i)?.[1]
    if (reference) references.push(reference)
  }
  return references
}

export function validateDesktopRendererAssets(distDir: string) {
  const indexPath = path.join(distDir, 'index.html')
  let indexHtml = ''
  try {
    indexHtml = fs.readFileSync(indexPath, 'utf8')
  } catch {
    throw new Error(`Desktop renderer is missing ${indexPath}. Run npm run desktop:build.`)
  }
  const references = localRendererReferences(indexHtml)
  if (!/<script\b[^>]*\bsrc=["'][^"']+["']/i.test(indexHtml)) {
    throw new Error('Desktop renderer index does not reference an entry script.')
  }
  for (const reference of references) {
    const resourceUrl = new URL(reference, 'http://farming.desktop')
    if (resourceUrl.origin !== 'http://farming.desktop') continue
    if (!staticFilePath(distDir, resourceUrl.pathname)) {
      throw new Error(`Desktop renderer asset is missing or uses the wrong base path: ${resourceUrl.pathname}`)
    }
  }
}

export class DesktopGateway {
  private readonly bootstrapKey = randomBytes(24).toString('base64url')
  private readonly sessionKey = randomBytes(24).toString('base64url')
  private readonly webSockets = new WebSocketServer({ noServer: true })
  private readonly server = http.createServer((request, response) => this.handleRequest(request, response))
  private port = 0

  constructor(
    private readonly distDir: string,
    private readonly profiles: DesktopProfileStore,
    private readonly connections: DesktopConnectionManager,
  ) {
    this.server.on('upgrade', (request, socket, head) => {
      if (!this.authorized(request)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return
      }
      const target = this.connections.target(this.profiles.getActiveBackendId())
      if (!target) {
        socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return
      }
      this.webSockets.handleUpgrade(request, socket, head, client => this.bridgeWebSocket(client, request, target))
    })
  }

  async listen() {
    validateDesktopRendererAssets(this.distDir)
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(0, '127.0.0.1', () => {
        const address = this.server.address()
        if (!address || typeof address === 'string') {
          reject(new Error('Desktop gateway did not receive a loopback port.'))
          return
        }
        this.port = address.port
        resolve()
      })
    })
  }

  origin() {
    return `http://127.0.0.1:${this.port}`
  }

  bootstrapUrl() {
    return `${this.origin()}/__desktop_bootstrap?key=${this.bootstrapKey}`
  }

  closeClientConnections() {
    this.webSockets.clients.forEach(client => client.close(1012, 'Backend changed'))
  }

  async close() {
    this.closeClientConnections()
    const closed = new Promise<void>(resolve => this.server.close(() => resolve()))
    this.server.closeAllConnections()
    await closed
  }

  private authorized(request: IncomingMessage) {
    const cookies = String(request.headers.cookie || '').split(';')
    return cookies.some(cookie => cookie.trim() === `${SESSION_COOKIE}=${this.sessionKey}`)
  }

  private handleRequest(request: IncomingMessage, response: ServerResponse) {
    const requestUrl = new URL(request.url || '/', this.origin())
    if (requestUrl.pathname === '/__desktop_bootstrap' && requestUrl.searchParams.get('key') === this.bootstrapKey) {
      response.writeHead(302, {
        'Cache-Control': 'no-store',
        Location: '/code/',
        'Set-Cookie': `${SESSION_COOKIE}=${this.sessionKey}; HttpOnly; SameSite=Strict; Path=/`,
      })
      response.end()
      return
    }
    if (!this.authorized(request)) {
      sendJson(response, 401, { error: 'Desktop session required.' })
      return
    }

    if (request.method === 'GET' || request.method === 'HEAD') {
      const filePath = staticFilePath(this.distDir, requestUrl.pathname)
      if (filePath) {
        this.serveFile(filePath, request.method === 'HEAD', response)
        return
      }
    }
    this.proxyHttp(request, response)
  }

  private serveFile(filePath: string, headOnly: boolean, response: ServerResponse) {
    let stat
    try {
      stat = fs.statSync(filePath)
    } catch {
      sendJson(response, 500, { error: `Desktop asset is missing: ${path.basename(filePath)}` })
      return
    }
    response.writeHead(200, {
      'Cache-Control': path.basename(filePath) === 'index.html' ? 'no-store' : 'public, max-age=31536000, immutable',
      'Content-Security-Policy': DESKTOP_CONTENT_SECURITY_POLICY,
      'Content-Length': stat.size,
      'Content-Type': CONTENT_TYPES[path.extname(filePath)] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
    })
    if (headOnly) {
      response.end()
      return
    }
    fs.createReadStream(filePath).pipe(response)
  }

  private proxyHttp(request: IncomingMessage, response: ServerResponse) {
    let target
    try {
      target = this.connections.target(this.profiles.getActiveBackendId())
    } catch (error) {
      sendJson(response, 503, { error: error instanceof Error ? error.message : String(error) })
      return
    }
    if (!target) {
      sendJson(response, 503, { error: 'No active Farming backend is connected.' })
      return
    }
    const upstreamUrl = joinUpstreamUrl(target.baseUrl, request.url || '/')
    const headers = { ...request.headers }
    delete headers.cookie
    delete headers.host
    delete headers.origin
    if (target.token) headers.authorization = `Bearer ${bearerCredential(target.token)}`
    const client = upstreamUrl.protocol === 'https:' ? https : http
    const upstream = client.request(upstreamUrl, {
      method: request.method,
      headers,
    }, upstreamResponse => {
      const responseHeaders = { ...upstreamResponse.headers }
      delete responseHeaders['set-cookie']
      response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders)
      upstreamResponse.pipe(response)
    })
    upstream.on('error', error => {
      if (!response.headersSent) sendJson(response, 502, { error: error.message })
      else response.destroy(error)
    })
    request.pipe(upstream)
  }

  private bridgeWebSocket(
    client: WebSocket,
    request: IncomingMessage,
    target: { baseUrl: string; token: string },
  ) {
    const upstreamUrl = joinUpstreamUrl(target.baseUrl, request.url || '/')
    upstreamUrl.protocol = upstreamUrl.protocol === 'https:' ? 'wss:' : 'ws:'
    const upstream = new WebSocket(upstreamUrl, {
      headers: target.token ? { authorization: `Bearer ${bearerCredential(target.token)}` } : undefined,
    })
    const queued: Array<{ data: RawData; binary: boolean }> = []
    let queuedBytes = 0

    client.on('message', (data, binary) => {
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.send(data, { binary })
        return
      }
      queuedBytes += rawDataByteLength(data)
      if (queuedBytes > MAX_QUEUED_WEBSOCKET_BYTES) {
        client.close(1009, 'Desktop gateway queue exceeded')
        return
      }
      queued.push({ data, binary })
    })
    upstream.on('open', () => {
      queued.splice(0).forEach(message => upstream.send(message.data, { binary: message.binary }))
    })
    upstream.on('message', (data, binary) => {
      if (client.readyState === WebSocket.OPEN) client.send(data, { binary })
    })
    upstream.on('error', error => {
      if (client.readyState === WebSocket.OPEN) client.close(1011, error.message.slice(0, 120))
    })
    upstream.on('close', (code, reason) => {
      const closeCode = code === 1000 || (code >= 3000 && code <= 4999) ? code : 1011
      if (client.readyState === WebSocket.OPEN) client.close(closeCode, reason.toString().slice(0, 120))
    })
    client.on('close', () => upstream.close())
    client.on('error', () => upstream.close())
  }
}
