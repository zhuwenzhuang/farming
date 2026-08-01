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
}

interface ServerState {
  basePath?: unknown
  port?: unknown
}

const COMMAND_TIMEOUT_MS = 45_000
const HANDSHAKE_TIMEOUT_MS = 30_000

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error || 'Unknown error')
}

function delay(milliseconds: number) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

function runCommand(command: string, args: string[], env: NodeJS.ProcessEnv) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timeout = setTimeout(() => child.kill(), COMMAND_TIMEOUT_MS)
    child.stdout.on('data', chunk => { stdout = `${stdout}${String(chunk)}`.slice(-8_000) })
    child.stderr.on('data', chunk => { stderr = `${stderr}${String(chunk)}`.slice(-8_000) })
    child.once('error', error => {
      clearTimeout(timeout)
      reject(error)
    })
    child.once('exit', code => {
      clearTimeout(timeout)
      if (code === 0) resolve()
      else reject(new Error((stderr || stdout).trim() || `Farming daemon command exited with code ${code ?? 'unknown'}.`))
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
      this.phase = 'failed'
      throw error
    })
    return this.startPromise
  }

  stop() {
    if (this.stopPromise) return this.stopPromise
    if (this.phase === 'idle' || this.phase === 'stopped' || this.phase === 'failed') {
      this.phase = 'stopped'
      return Promise.resolve()
    }
    this.phase = 'stopping'
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
    if (this.options.injectedUrl) {
      const url = new URL(this.options.injectedUrl)
      return {
        profile: localProfile(url.origin, url.pathname === '/' ? '' : url.pathname.replace(/\/$/, ''), this.options.configDir),
        token: this.options.injectedToken || '',
      }
    }
    fs.mkdirSync(this.options.configDir, { recursive: true })
    await this.runCli('daemon')
    return await this.readTarget()
  }

  private cliPath() {
    if (this.options.cliPath) return path.resolve(this.options.cliPath)
    const packaged = path.join(this.options.resourcesPath, 'farming', 'bin', 'farming')
    if (fs.existsSync(packaged)) return packaged
    return path.join(this.options.repositoryRoot, 'bin', 'farming')
  }

  private runCli(command: 'daemon' | 'stop') {
    const cli = this.cliPath()
    if (!fs.existsSync(cli)) throw new Error(`Local Farming CLI is missing: ${cli}`)
    return runCommand(this.options.electronExecutable, [
      cli,
      command,
      '--base-path', '/farming',
      '--config-dir', this.options.configDir,
    ], {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      FARMING_NODE_BIN: this.options.electronExecutable,
    })
  }

  private async readTarget(): Promise<DesktopLocalBackendTarget> {
    const stateFile = path.join(this.options.configDir, 'farming-server.json')
    const tokenFile = path.join(this.options.configDir, '.session-token')
    const deadline = Date.now() + HANDSHAKE_TIMEOUT_MS
    let lastError = ''
    while (Date.now() < deadline) {
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
      await delay(100)
    }
    throw new Error(`Local Farming daemon did not publish a valid handshake: ${lastError}`)
  }
}
