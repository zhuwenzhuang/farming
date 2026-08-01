import { randomUUID } from 'node:crypto'
import type { DesktopBackendInput, DesktopBackendProfile } from '../shared/desktop-contract.js'

export interface StoredDesktopBackendProfile extends Omit<DesktopBackendProfile, 'hasToken'> {
  encryptedToken: string
}

export const DEFAULT_FARMING_HOME = '~/.farming-desktop'

function boundedText(value: unknown, label: string, maxLength: number) {
  const text = String(value ?? '').trim()
  if (!text) throw new Error(`${label} is required.`)
  if (text.length > maxLength || /[\0\r\n]/.test(text)) throw new Error(`${label} is invalid.`)
  return text
}

export function normalizeDesktopBasePath(value: unknown) {
  const text = String(value ?? '').trim()
  if (!text || text === '/') return ''
  if (/[?#\0\r\n]/.test(text)) throw new Error('Base path is invalid.')
  const withSlash = text.startsWith('/') ? text : `/${text}`
  return withSlash.replace(/\/+$/, '')
}

export function normalizeDesktopBackendInput(
  input: DesktopBackendInput,
  previous?: StoredDesktopBackendProfile,
): StoredDesktopBackendProfile {
  const name = boundedText(input.name, 'Name', 80)
  const transport = input.transport
  if (transport !== 'ssh' && transport !== 'direct') throw new Error('Transport is invalid.')

  const remotePort = Number(input.remotePort ?? previous?.remotePort ?? 3000)
  if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65_535) {
    throw new Error('Remote port must be between 1 and 65535.')
  }

  const basePath = normalizeDesktopBasePath(input.basePath ?? previous?.basePath)
  const farmingHome = String(input.farmingHome || previous?.farmingHome || DEFAULT_FARMING_HOME).trim()
  if (!farmingHome || farmingHome.length > 1024 || /[\0\r\n]/.test(farmingHome)) {
    throw new Error('Farming Home is invalid.')
  }
  let sshHost = ''
  let remoteHost = '127.0.0.1'
  let directUrl = ''

  if (transport === 'ssh') {
    sshHost = boundedText(input.sshHost, 'SSH host', 255)
    if (sshHost.startsWith('-')) throw new Error('SSH host cannot start with a dash.')
    remoteHost = boundedText(input.remoteHost || '127.0.0.1', 'Remote host', 255)
    if (!/^[A-Za-z0-9.-]+$/.test(remoteHost)) {
      throw new Error('Remote host must be a hostname or IPv4 address.')
    }
  } else {
    const parsed = new URL(boundedText(input.directUrl, 'Direct URL', 2048))
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('Direct URL must use HTTP or HTTPS.')
    }
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error('Direct URL cannot contain credentials, query parameters, or a fragment.')
    }
    if (parsed.pathname !== '/') throw new Error('Put the Direct URL path in the Base path field.')
    directUrl = parsed.origin
  }

  const id = previous?.id ?? input.id ?? randomUUID()
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(id)) throw new Error('Backend ID is invalid.')

  return {
    id,
    kind: 'remote',
    name,
    transport,
    sshHost,
    remoteHost,
    remotePort,
    basePath,
    directUrl,
    farmingHome,
    encryptedToken: previous?.encryptedToken ?? '',
  }
}

export function publicDesktopBackendProfile(profile: StoredDesktopBackendProfile): DesktopBackendProfile {
  const { encryptedToken: _encryptedToken, ...publicProfile } = profile
  return { ...publicProfile, hasToken: Boolean(profile.encryptedToken) }
}
