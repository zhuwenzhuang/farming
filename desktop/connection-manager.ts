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
  tunnel: SshTunnelState | null
  targetBaseUrl: string
  targetToken: string
}

interface SshTunnelState {
  child: ChildProcess
  abortController: AbortController
  exitPromise: Promise<never>
  failure: Error | null
  stderr: string
}

interface DesktopConnectionManagerOptions {
  appVersion: string
  cacheDir: string
  bootstrapRemoteServer?: typeof bootstrapRemoteServer
  allocateLoopbackPort?: () => Promise<number>
  spawnSshTunnel?: (sshHost: string, remoteHost: string, remotePort: number, localPort: number) => ChildProcess
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

function spawnSshTunnel(sshHost: string, remoteHost: string, remotePort: number, localPort: number) {
  return spawn('ssh', buildSshTunnelArgs(sshHost, remoteHost, remotePort, localPort), {
    stdio: ['ignore', 'ignore', 'pipe'],
  })
}

export class DesktopConnectionManager extends EventEmitter {
  private readonly records = new Map<string, ConnectionRecord>()

  constructor(
    private readonly profiles: DesktopProfileStore,
    private readonly options: DesktopConnectionManagerOptions = { appVersion: '0.0.0', cacheDir: '' },
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
    current?.tunnel?.abortController.abort()
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
      tunnel: null,
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
    let tunnel: SshTunnelState | null = null
    try {
      if (profile.transport === 'direct') {
        record.targetBaseUrl = `${profile.directUrl}${profile.basePath}`
        record.targetToken = this.profiles.readToken(profile.id)
        await this.probe(record, profile)
      } else {
        tunnel = await this.connectSsh(record, profile)
      }
      if (!this.isCurrent(record)) {
        throw new DesktopBackendReadinessCancelledError('Farming backend connection was cancelled.')
      }
      if (tunnel) this.assertTunnelReady(record, tunnel)
      record.status = 'ready'
      record.error = ''
      record.message = ''
      record.abortController = null
      record.attempt = null
      this.emitChange()
    } catch (error) {
      if (!this.isCurrent(record)) throw error
      record.abortController?.abort(error)
      record.tunnel?.abortController.abort(error)
      record.process?.kill()
      record.process = null
      record.tunnel = null
      record.abortController = null
      record.attempt = null
      record.server = null
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
    current?.tunnel?.abortController.abort()
    current?.process?.kill()
    this.records.set(backendId, {
      backendId,
      generation,
      status: 'disconnected',
      error: '',
      abortController: null,
      attempt: null,
      process: null,
      tunnel: null,
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
      record.tunnel?.abortController.abort()
      record.process?.kill()
    })
    this.records.clear()
  }

  private async connectSsh(record: ConnectionRecord, profile: StoredDesktopBackendProfile) {
    const handshake = await (this.options.bootstrapRemoteServer ?? bootstrapRemoteServer)({
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
    if (!this.isCurrent(record)) {
      throw new DesktopBackendReadinessCancelledError('Farming backend connection was cancelled.')
    }
    const localPort = await (this.options.allocateLoopbackPort ?? unusedLoopbackPort)()
    if (!this.isCurrent(record)) {
      throw new DesktopBackendReadinessCancelledError('Farming backend connection was cancelled.')
    }
    record.message = 'Opening SSH tunnel…'
    record.targetBaseUrl = `http://127.0.0.1:${localPort}${handshake.basePath}`
    record.targetToken = handshake.token
    const child = (this.options.spawnSshTunnel ?? spawnSshTunnel)(
      profile.sshHost,
      handshake.host,
      handshake.port,
      localPort,
    )
    record.process = child
    const tunnelAbortController = new AbortController()
    let rejectExit!: (error: Error) => void
    const tunnel: SshTunnelState = {
      child,
      abortController: tunnelAbortController,
      exitPromise: new Promise<never>((_resolve, reject) => { rejectExit = reject }),
      failure: null,
      stderr: '',
    }
    record.tunnel = tunnel
    child.stderr?.on('data', chunk => {
      tunnel.stderr = `${tunnel.stderr}${String(chunk)}`.slice(-STDERR_LIMIT)
    })
    const latchFailure = (error: Error) => {
      if (tunnel.failure) return
      tunnel.failure = error
      tunnel.abortController.abort(error)
      rejectExit(error)
      if (
        !this.isCurrent(record)
        || record.process !== child
        || record.tunnel !== tunnel
        || record.status !== 'ready'
      ) return
      record.process = null
      record.tunnel = null
      record.server = null
      record.status = 'error'
      record.error = errorMessage(error)
      this.emitChange()
    }
    child.once('error', error => latchFailure(error))
    child.once('exit', (code, signal) => {
      const detail = tunnel.stderr.trim()
        || `ssh exited with ${signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`}`
      latchFailure(new Error(detail))
    })
    if (child.exitCode !== null || child.signalCode !== null) {
      const detail = tunnel.stderr.trim()
        || `ssh exited with ${child.signalCode ? `signal ${child.signalCode}` : `code ${child.exitCode ?? 'unknown'}`}`
      latchFailure(new Error(detail))
    }
    await Promise.race([this.probe(record, profile), tunnel.exitPromise])
    record.message = 'Discovering remote capabilities…'
    const capabilities = await Promise.race([
      this.discoverCapabilities(record, tunnel.abortController.signal),
      tunnel.exitPromise,
    ])
    record.server = {
      version: handshake.version,
      platform: handshake.platform,
      arch: handshake.arch,
      farmingHome: handshake.farmingHome,
      runtime: handshake.runtime,
      capabilities,
    }
    return tunnel
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

  private async discoverCapabilities(
    record: ConnectionRecord,
    tunnelSignal: AbortSignal,
  ): Promise<DesktopCapabilitySummary[]> {
    const token = record.targetToken
    const read = async (id: string, pathname: string) => {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 3_000)
      try {
        const response = await fetch(joinUpstreamUrl(record.targetBaseUrl, pathname), {
          headers: token ? { authorization: `Bearer ${bearerCredential(token)}` } : undefined,
          signal: AbortSignal.any([
            controller.signal,
            ...(record.abortController ? [record.abortController.signal] : []),
            tunnelSignal,
          ]),
        })
        if (!response.ok) return { id, state: `error (HTTP ${response.status})` }
        const body = await response.json() as { available?: unknown; enabled?: unknown }
        return {
          id,
          state: body.available === true ? 'available' : body.enabled === true ? 'unavailable' : 'disabled',
        }
      } catch {
        if (record.abortController?.signal.aborted) {
          throw new DesktopBackendReadinessCancelledError('Farming backend connection was cancelled.')
        }
        if (tunnelSignal.aborted) {
          throw tunnelSignal.reason instanceof Error
            ? tunnelSignal.reason
            : new Error('SSH tunnel closed during capability discovery.')
        }
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

  private assertTunnelReady(record: ConnectionRecord, tunnel: SshTunnelState) {
    if (!this.isCurrent(record) || record.process !== tunnel.child || record.tunnel !== tunnel) {
      throw new DesktopBackendReadinessCancelledError('Farming backend connection was cancelled.')
    }
    if (tunnel.failure) throw tunnel.failure
    if (tunnel.child.exitCode !== null || tunnel.child.signalCode !== null) {
      const detail = tunnel.stderr.trim()
        || `ssh exited with ${tunnel.child.signalCode ? `signal ${tunnel.child.signalCode}` : `code ${tunnel.child.exitCode ?? 'unknown'}`}`
      throw new Error(detail)
    }
  }

  private isCurrent(record: ConnectionRecord) {
    return this.records.get(record.backendId)?.generation === record.generation
  }

  private emitChange() {
    this.emit('change')
  }
}
