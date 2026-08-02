import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { StoredDesktopBackendProfile } from './profile-model.js'

export const LOCAL_BACKEND_ID = 'local'

export interface DesktopLocalBackendTarget {
  profile: StoredDesktopBackendProfile
  token: string
}

type LocalBackendPhase = 'idle' | 'starting' | 'ready' | 'stopping' | 'stopped' | 'failed'

interface LocalBackendOptions {
  configDir: string
  electronExecutable: string
  resourcesPath: string
  repositoryRoot: string
  injectedUrl?: string
  injectedToken?: string
  cliPath?: string
  commandPolicies?: Partial<Record<'daemon' | 'stop', DesktopLocalCommandPolicy>>
  handshakeTimeoutMs?: number
  onProgress?: (message: string) => void
  signal?: AbortSignal
}

interface ServerState {
  basePath?: unknown
  port?: unknown
}

const HANDSHAKE_TIMEOUT_MS = 30_000
const DEFAULT_COMMAND_POLICIES: Record<'daemon' | 'stop', DesktopLocalCommandPolicy> = {
  daemon: {
    absoluteTimeoutMs: 20 * 60_000,
    idleTimeoutMs: 5 * 60_000,
    killGraceMs: 2_000,
  },
  stop: {
    absoluteTimeoutMs: 45_000,
    idleTimeoutMs: 45_000,
    killGraceMs: 2_000,
  },
}

export interface DesktopLocalCommandPolicy {
  absoluteTimeoutMs: number
  idleTimeoutMs: number
  killGraceMs: number
}

class DesktopLocalCommandTimeoutError extends Error {
  readonly code = 'FARMING_DESKTOP_COMMAND_TIMEOUT'
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error || 'Unknown error')
}

function startupCancelledError() {
  return new Error('Farming Desktop startup was cancelled.')
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw startupCancelledError()
}

function abortableDelay(milliseconds: number, signal?: AbortSignal) {
  throwIfAborted(signal)
  if (!signal) return new Promise<void>(resolve => setTimeout(resolve, milliseconds))
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolve()
    }, milliseconds)
    const abort = () => {
      clearTimeout(timeout)
      reject(startupCancelledError())
    }
    signal.addEventListener('abort', abort, { once: true })
  })
}

function runCommand(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  policy: DesktopLocalCommandPolicy,
  signal?: AbortSignal,
  onProgress?: (message: string) => void,
) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let terminationReason = ''
    let idleTimeout: NodeJS.Timeout | null = null
    let killTimeout: NodeJS.Timeout | null = null
    let settled = false

    const clearTimers = () => {
      clearTimeout(absoluteTimeout)
      if (idleTimeout) clearTimeout(idleTimeout)
      if (killTimeout) clearTimeout(killTimeout)
      signal?.removeEventListener('abort', abort)
    }
    const finish = (operation: () => void) => {
      if (settled) return
      settled = true
      clearTimers()
      operation()
    }
    const terminate = (reason: string) => {
      if (terminationReason || settled) return
      terminationReason = reason
      child.kill('SIGTERM')
      killTimeout = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      }, policy.killGraceMs)
    }
    const armIdleTimeout = () => {
      if (idleTimeout) clearTimeout(idleTimeout)
      idleTimeout = setTimeout(() => terminate(
        `produced no command progress for ${Math.ceil(policy.idleTimeoutMs / 1000)} seconds`,
      ), policy.idleTimeoutMs)
    }
    const observeOutput = (stream: 'stdout' | 'stderr', chunk: Buffer | string) => {
      const output = String(chunk)
      if (stream === 'stdout') stdout = `${stdout}${output}`.slice(-8_000)
      else stderr = `${stderr}${output}`.slice(-8_000)
      const progress = output.split(/\r?\n/).map(line => line.trim()).filter(Boolean).at(-1)
      if (progress) onProgress?.(progress.slice(0, 400))
      armIdleTimeout()
    }
    const abort = () => terminate('was cancelled while the desktop application was stopping')
    const absoluteTimeout = setTimeout(() => terminate(
      `exceeded its ${Math.ceil(policy.absoluteTimeoutMs / 60_000)} minute deadline`,
    ), policy.absoluteTimeoutMs)
    armIdleTimeout()
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()

    child.stdout.on('data', chunk => observeOutput('stdout', chunk))
    child.stderr.on('data', chunk => observeOutput('stderr', chunk))
    child.once('error', error => {
      finish(() => reject(error))
    })
    child.once('exit', code => {
      finish(() => {
        const output = (stderr || stdout).trim()
        if (terminationReason) {
          const message = `Farming daemon ${terminationReason}.${output ? `\n${output}` : ''}`
          if (terminationReason.startsWith('exceeded') || terminationReason.startsWith('produced no')) {
            reject(new DesktopLocalCommandTimeoutError(message))
          } else {
            reject(new Error(message))
          }
        } else if (code === 0) {
          resolve()
        } else {
          reject(new Error(output || `Farming daemon command exited with code ${code ?? 'unknown'}.`))
        }
      })
    })
  })
}

function localProfile(directUrl: string, basePath: string, configDir: string): StoredDesktopBackendProfile {
  return {
    id: LOCAL_BACKEND_ID,
    kind: 'local',
    name: 'This Mac',
    transport: 'direct',
    sshHost: '',
    remoteHost: '127.0.0.1',
    remotePort: 0,
    basePath,
    directUrl,
    farmingHome: configDir,
    encryptedToken: '',
  }
}

export class DesktopLocalBackend {
  private phase: LocalBackendPhase = 'idle'
  private startPromise: Promise<DesktopLocalBackendTarget> | null = null
  private stopPromise: Promise<void> | null = null
  private readonly startAbort = new AbortController()

  constructor(private readonly options: LocalBackendOptions) {}

  state() {
    return this.phase
  }

  start() {
    if (this.startPromise) return this.startPromise
    if (this.phase !== 'idle') return Promise.reject(new Error(`Local backend cannot start from ${this.phase}.`))
    this.phase = 'starting'
    this.startPromise = this.startOnce().then(target => {
      if (this.phase === 'starting') this.phase = 'ready'
      return target
    }).catch(error => {
      if (this.phase === 'starting') this.phase = 'failed'
      throw error
    })
    return this.startPromise
  }

  stop() {
    if (this.stopPromise) return this.stopPromise
    if (this.phase === 'idle' || this.phase === 'stopped') {
      this.phase = 'stopped'
      return Promise.resolve()
    }
    this.phase = 'stopping'
    this.startAbort.abort()
    this.stopPromise = (async () => {
      try {
        await this.startPromise?.catch(() => null)
        if (!this.options.injectedUrl) await this.runCli('stop')
      } finally {
        this.phase = 'stopped'
      }
    })()
    return this.stopPromise
  }

  private async startOnce(): Promise<DesktopLocalBackendTarget> {
    const signal = this.options.signal
      ? AbortSignal.any([this.startAbort.signal, this.options.signal])
      : this.startAbort.signal
    throwIfAborted(signal)
    if (this.options.injectedUrl) {
      this.options.onProgress?.('Using the configured local Farming Server…')
      const url = new URL(this.options.injectedUrl)
      return {
        profile: localProfile(url.origin, url.pathname === '/' ? '' : url.pathname.replace(/\/$/, ''), this.options.configDir),
        token: this.options.injectedToken || '',
      }
    }
    fs.mkdirSync(this.options.configDir, { recursive: true })
    this.options.onProgress?.('Verifying installed Farming runtime…')
    try {
      await this.runCli('daemon', signal)
    } catch (error) {
      if (!(error instanceof DesktopLocalCommandTimeoutError)) throw error
      try {
        const target = await this.readTarget(signal)
        this.options.onProgress?.('Local Farming environment is ready.')
        return target
      } catch (handshakeError) {
        if (signal.aborted) throw handshakeError
        throw error
      }
    }
    throwIfAborted(signal)
    this.options.onProgress?.('Waiting for the local Farming Server…')
    const target = await this.readTarget(signal)
    this.options.onProgress?.('Local Farming environment is ready.')
    return target
  }

  private cliPath() {
    if (this.options.cliPath) return path.resolve(this.options.cliPath)
    const packaged = path.join(this.options.resourcesPath, 'farming', 'bin', 'farming')
    if (fs.existsSync(packaged)) return packaged
    return path.join(this.options.repositoryRoot, 'bin', 'farming')
  }

  private runCli(command: 'daemon' | 'stop', signal?: AbortSignal) {
    const cli = this.cliPath()
    if (!fs.existsSync(cli)) throw new Error(`Local Farming CLI is missing: ${cli}`)
    const policy = this.options.commandPolicies?.[command] ?? DEFAULT_COMMAND_POLICIES[command]
    const packageRoot = fs.existsSync(path.join(this.options.resourcesPath, 'farming', 'bin', 'farming'))
      ? path.join(this.options.resourcesPath, 'farming')
      : this.options.repositoryRoot
    const runtimeSeedDir = path.join(packageRoot, '.farming-runtime-seed')
    return runCommand(this.options.electronExecutable, [
      cli,
      command,
      '--base-path', '/farming',
      '--config-dir', this.options.configDir,
    ], {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      FARMING_NODE_BIN: this.options.electronExecutable,
      FARMING_RUNTIME_DOWNLOAD_POLICY: 'forbid',
      FARMING_RUNTIME_SEED_DIR: runtimeSeedDir,
    }, policy, signal, command === 'daemon' ? this.options.onProgress : undefined)
  }

  private async readTarget(signal?: AbortSignal): Promise<DesktopLocalBackendTarget> {
    const stateFile = path.join(this.options.configDir, 'farming-server.json')
    const tokenFile = path.join(this.options.configDir, '.session-token')
    const deadline = Date.now() + (this.options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS)
    let lastError = ''
    while (Date.now() < deadline) {
      throwIfAborted(signal)
      try {
        const state = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as ServerState
        const port = Number(state.port)
        const basePath = String(state.basePath || '')
        const token = fs.readFileSync(tokenFile, 'utf8').trim()
        if (!Number.isInteger(port) || port < 1 || port > 65_535 || !token) {
          throw new Error('Local Farming daemon handshake is incomplete.')
        }
        return {
          profile: localProfile(`http://127.0.0.1:${port}`, basePath, this.options.configDir),
          token,
        }
      } catch (error) {
        lastError = errorMessage(error)
      }
      await abortableDelay(100, signal)
    }
    throwIfAborted(signal)
    throw new Error(`Local Farming daemon did not publish a valid handshake: ${lastError}`)
  }
}
