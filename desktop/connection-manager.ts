import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import net from 'node:net'
import type { DesktopBackendConnection, DesktopCapabilitySummary } from '../shared/desktop-contract.js'
import {
  DesktopBackendReadinessCancelledError,
  DesktopBackendReadinessFatalError,
  probeDesktopBackendWebSocket,
} from './backend-readiness.js'
import type { StoredDesktopBackendProfile } from './profile-model.js'
import { DesktopProfileStore } from './profile-store.js'
import { bootstrapRemoteServer } from './remote-bootstrap.js'
import { bearerCredential, joinUpstreamUrl } from './upstream.js'

interface ConnectionRecord extends DesktopBackendConnection {
  abortController: AbortController | null
  attempt: Promise<void> | null
  process: ChildProcess | null
  targetBaseUrl: string
  targetToken: string
}

export interface DesktopConnectionTarget {
  baseUrl: string
  token: string
}

const CONNECT_TIMEOUT_MS = 12_000
const PROBE_INTERVAL_MS = 200
const STDERR_LIMIT = 4_000

function errorMessage(error: unknown) {
  return (error instanceof Error ? error.message : String(error || 'Unknown error'))
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, 800)
}

function delay(milliseconds: number, signal?: AbortSignal) {
  if (signal?.aborted) {
    return Promise.reject(new DesktopBackendReadinessCancelledError('Farming backend connection was cancelled.'))
  }
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }, milliseconds)
    const abort = () => {
      clearTimeout(timeout)
      reject(new DesktopBackendReadinessCancelledError('Farming backend connection was cancelled.'))
    }
    signal?.addEventListener('abort', abort, { once: true })
  })
}

async function unusedLoopbackPort() {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Could not allocate a loopback port.')))
        return
      }
      server.close(error => error ? reject(error) : resolve(address.port))
    })
  })
}

export function buildSshTunnelArgs(sshHost: string, remoteHost: string, remotePort: number, localPort: number) {
  return [
    '-N',
    '-T',
    '-o', 'BatchMode=yes',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    '-L', `127.0.0.1:${localPort}:${remoteHost}:${remotePort}`,
    sshHost,
  ]
}

export class DesktopConnectionManager extends EventEmitter {
  private readonly records = new Map<string, ConnectionRecord>()

  constructor(
    private readonly profiles: DesktopProfileStore,
    private readonly options: { appVersion: string; cacheDir: string } = { appVersion: '0.0.0', cacheDir: '' },
  ) {
    super()
  }

  list(): DesktopBackendConnection[] {
    return this.profiles.list().map(profile => {
      const record = this.records.get(profile.id)
      return record
        ? {
          backendId: profile.id,
          generation: record.generation,
          status: record.status,
          error: record.error,
          message: record.message,
          server: record.server,
        }
        : { backendId: profile.id, generation: 0, status: 'disconnected', error: '', message: '', server: null }
    })
  }

  target(backendId: string | null): DesktopConnectionTarget | null {
    if (!backendId) return null
    const record = this.records.get(backendId)
    if (!record || record.status !== 'ready') return null
    return { baseUrl: record.targetBaseUrl, token: record.targetToken }
  }

  connect(backendId: string): Promise<void> {
    const profile = this.profiles.getStored(backendId)
    if (!profile) return Promise.reject(new Error('Backend not found.'))
    const current = this.records.get(backendId)
    if (current?.status === 'ready') return Promise.resolve()
    if (current?.status === 'connecting' && current.attempt) return current.attempt

    const generation = (current?.generation ?? 0) + 1
    current?.abortController?.abort()
    current?.process?.kill()
    const abortController = new AbortController()
    const record: ConnectionRecord = {
      backendId,
      generation,
      status: 'connecting',
      error: '',
      abortController,
      attempt: null,
      process: null,
      targetBaseUrl: '',
      targetToken: '',
      message: 'Connecting…',
      server: null,
    }
    this.records.set(backendId, record)
    this.emitChange()
    record.attempt = this.runConnection(record, profile)
    return record.attempt
  }

  private async runConnection(record: ConnectionRecord, profile: StoredDesktopBackendProfile) {
    try {
      if (profile.transport === 'direct') {
        record.targetBaseUrl = `${profile.directUrl}${profile.basePath}`
        record.targetToken = this.profiles.readToken(profile.id)
        await this.probe(record, profile)
      } else {
        await this.connectSsh(record, profile)
      }
      if (!this.isCurrent(record)) {
        throw new DesktopBackendReadinessCancelledError('Farming backend connection was cancelled.')
      }
      record.status = 'ready'
      record.error = ''
      record.message = ''
      record.abortController = null
      record.attempt = null
      this.emitChange()
    } catch (error) {
      if (!this.isCurrent(record)) throw error
      record.process?.kill()
      record.process = null
      record.abortController = null
      record.attempt = null
      record.status = 'error'
      record.error = errorMessage(error)
      this.emitChange()
      throw error
    }
  }

  disconnect(backendId: string) {
    const current = this.records.get(backendId)
    const generation = (current?.generation ?? 0) + 1
    current?.abortController?.abort()
    current?.process?.kill()
    this.records.set(backendId, {
      backendId,
      generation,
      status: 'disconnected',
      error: '',
      abortController: null,
      attempt: null,
      process: null,
      targetBaseUrl: '',
      targetToken: '',
      message: '',
      server: null,
    })
    this.emitChange()
  }

  close() {
    this.records.forEach(record => {
      record.abortController?.abort()
      record.process?.kill()
    })
    this.records.clear()
  }

  private async connectSsh(record: ConnectionRecord, profile: StoredDesktopBackendProfile) {
    const handshake = await bootstrapRemoteServer({
      sshHost: profile.sshHost,
      farmingHome: profile.farmingHome,
      version: this.options.appVersion,
      cacheDir: this.options.cacheDir,
      signal: record.abortController?.signal,
      onPhase: message => {
        if (!this.isCurrent(record)) return
        record.message = message
        this.emitChange()
      },
    })
    if (!this.isCurrent(record)) return
    const localPort = await unusedLoopbackPort()
    if (!this.isCurrent(record)) return
    record.message = 'Opening SSH tunnel…'
    record.targetBaseUrl = `http://127.0.0.1:${localPort}${handshake.basePath}`
    record.targetToken = handshake.token
    const child = spawn('ssh', buildSshTunnelArgs(profile.sshHost, handshake.host, handshake.port, localPort), {
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    record.process = child
    let stderr = ''
    child.stderr?.on('data', chunk => {
      stderr = `${stderr}${String(chunk)}`.slice(-STDERR_LIMIT)
    })
    const exited = new Promise<never>((_resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (code, signal) => {
        const detail = stderr.trim() || `ssh exited with ${signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`}`
        reject(new Error(detail))
      })
    })
    await Promise.race([this.probe(record, profile), exited])
    record.message = 'Discovering remote capabilities…'
    record.server = {
      version: handshake.version,
      platform: handshake.platform,
      arch: handshake.arch,
      farmingHome: handshake.farmingHome,
      runtime: handshake.runtime,
      capabilities: await this.discoverCapabilities(record),
    }
    child.once('exit', (code, signal) => {
      if (!this.isCurrent(record) || record.status !== 'ready') return
      record.process = null
      record.status = 'error'
      record.error = stderr.trim().slice(-STDERR_LIMIT)
        || `SSH tunnel closed with ${signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`}.`
      this.emitChange()
    })
  }

  private async probe(record: ConnectionRecord, profile: StoredDesktopBackendProfile) {
    const deadline = Date.now() + CONNECT_TIMEOUT_MS
    const token = record.targetToken || this.profiles.readToken(profile.id)
    let lastError = ''
    while (Date.now() < deadline && this.isCurrent(record)) {
      const remainingBeforeHttpMs = deadline - Date.now()
      if (remainingBeforeHttpMs <= 0) break
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), Math.min(1_500, remainingBeforeHttpMs))
      let authenticated = false
      try {
        const response = await fetch(joinUpstreamUrl(record.targetBaseUrl, '/api/auth/status'), {
          headers: token ? { authorization: `Bearer ${bearerCredential(token)}` } : undefined,
          signal: record.abortController
            ? AbortSignal.any([controller.signal, record.abortController.signal])
            : controller.signal,
        })
        if (response.ok) {
          const body = await response.json() as { authRequired?: unknown }
          authenticated = typeof body.authRequired === 'boolean'
        }
        if (!authenticated) lastError = `health probe returned HTTP ${response.status}`
      } catch (error) {
        lastError = errorMessage(error)
      } finally {
        clearTimeout(timeout)
      }
      if (authenticated) {
        if (!this.isCurrent(record)) {
          throw new DesktopBackendReadinessCancelledError('Farming backend connection was cancelled.')
        }
        record.message = 'Checking Farming protocol…'
        this.emitChange()
        const remainingMs = deadline - Date.now()
        if (remainingMs <= 0) break
        try {
          await probeDesktopBackendWebSocket({
            baseUrl: record.targetBaseUrl,
            token,
            signal: record.abortController?.signal,
            timeoutMs: Math.min(5_000, remainingMs),
          })
          return
        } catch (error) {
          if (
            error instanceof DesktopBackendReadinessCancelledError
            || error instanceof DesktopBackendReadinessFatalError
          ) throw error
          lastError = errorMessage(error)
        }
      }
      const remainingMs = deadline - Date.now()
      if (remainingMs > 0) {
        await delay(Math.min(PROBE_INTERVAL_MS, remainingMs), record.abortController?.signal)
      }
    }
    if (!this.isCurrent(record)) {
      throw new DesktopBackendReadinessCancelledError('Farming backend connection was cancelled.')
    }
    throw new Error(`Farming backend did not become ready within ${CONNECT_TIMEOUT_MS / 1000}s${lastError ? `: ${lastError}` : '.'}`)
  }

  private async discoverCapabilities(record: ConnectionRecord): Promise<DesktopCapabilitySummary[]> {
    const token = record.targetToken
    const read = async (id: string, pathname: string) => {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 3_000)
      try {
        const response = await fetch(joinUpstreamUrl(record.targetBaseUrl, pathname), {
          headers: token ? { authorization: `Bearer ${bearerCredential(token)}` } : undefined,
          signal: controller.signal,
        })
        if (!response.ok) return { id, state: `error (HTTP ${response.status})` }
        const body = await response.json() as { available?: unknown; enabled?: unknown }
        return {
          id,
          state: body.available === true ? 'available' : body.enabled === true ? 'unavailable' : 'disabled',
        }
      } catch {
        return { id, state: 'unknown' }
      } finally {
        clearTimeout(timeout)
      }
    }
    return Promise.all([
      read('browser', '/api/browsers/capability'),
      read('computer', '/api/computers/capability'),
    ])
  }

  private isCurrent(record: ConnectionRecord) {
    return this.records.get(record.backendId)?.generation === record.generation
  }

  private emitChange() {
    this.emit('change')
  }
}
