#!/usr/bin/env -S node --import tsx

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

const repoRoot = path.resolve(__dirname, '..')
const basePath = '/farming'
const harnessProject = path.join(repoRoot, 'tests', 'ios-pwa', 'FarmingPWAHarness.xcodeproj')
const harnessScheme = 'FarmingPWAHarness'
const harnessBundleIds = [
  'com.farming.iospwa.harness',
  'com.farming.iospwa.harness.uitests.xctrunner',
]

type SimulatorDevice = {
  dataPath?: string
  dataPathSize?: number
  deviceTypeIdentifier?: string
  isAvailable?: boolean
  lastBootedAt?: string
  logPath?: string
  name: string
  state: 'Booted' | 'Shutdown' | string
  udid: string
}

type InstalledApp = {
  CFBundleDisplayName?: string
  CFBundleIdentifier?: string
  CFBundleName?: string
  Path?: string
}

type CleanupReport = {
  agentDeleted: boolean
  serverProcessGroupKilled: boolean
  portClosed: boolean
  removedWebClips: string[]
  removedHarnessApps: string[]
  removedTemporaryDirectories: string[]
  simulatorShutdown: boolean
  errors: string[]
}

function runToken(): string {
  return new Date().toISOString().replace(/\D/g, '').slice(0, 14)
}

function commandOutput(command: string, args: string[], options: { input?: string } = {}): string {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    input: options.input,
  })
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed (${result.status ?? result.signal}): ${result.stderr || result.stdout}`,
    )
  }
  return result.stdout
}

function listDevices(): SimulatorDevice[] {
  const parsed = JSON.parse(commandOutput('xcrun', ['simctl', 'list', 'devices', 'available', '-j'])) as {
    devices?: Record<string, SimulatorDevice[]>
  }
  return Object.values(parsed.devices || {}).flat()
}

function resolveSimulator(): { device: SimulatorDevice, bootedByHarness: boolean } {
  const configured = String(process.env.FARMING_IOS_SIMULATOR_UDID || '').trim()
  const devices = listDevices()
  if (configured) {
    const device = devices.find(candidate => candidate.udid === configured)
    if (!device) throw new Error(`FARMING_IOS_SIMULATOR_UDID is not an available Simulator: ${configured}`)
    return { device, bootedByHarness: device.state !== 'Booted' }
  }

  const booted = devices.find(device => device.state === 'Booted' && /^iPhone\b/.test(device.name))
  if (booted) return { device: booted, bootedByHarness: false }

  const preferred = devices.find(device => device.name === 'iPhone 16 Pro')
    || devices.find(device => /^iPhone\b/.test(device.name))
  if (!preferred) throw new Error('No available iPhone Simulator was found')
  return { device: preferred, bootedByHarness: true }
}

function ensureSimulatorBooted(device: SimulatorDevice, bootedByHarness: boolean): void {
  if (!bootedByHarness) return
  commandOutput('xcrun', ['simctl', 'boot', device.udid])
  commandOutput('xcrun', ['simctl', 'bootstatus', device.udid, '-b'])
}

function listInstalledApps(udid: string): Map<string, InstalledApp> {
  const plist = commandOutput('xcrun', ['simctl', 'listapps', udid])
  const json = commandOutput('plutil', ['-convert', 'json', '-o', '-', '--', '-'], { input: plist })
  return new Map(Object.entries(JSON.parse(json) as Record<string, InstalledApp>))
}

function uninstall(udid: string, bundleId: string): boolean {
  const result = spawnSync('xcrun', ['simctl', 'uninstall', udid, bundleId], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
  if (result.status === 0) return true
  const output = `${result.stdout || ''}\n${result.stderr || ''}`
  if (/not installed|does not exist|No such file/i.test(output)) return false
  throw new Error(`Failed to uninstall ${bundleId}: ${output.trim()}`)
}

async function availableLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(error => {
        if (error) reject(error)
        else resolve((address as net.AddressInfo).port)
      })
    })
  })
}

async function waitForHTTP(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError = ''
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok) return
      lastError = `HTTP ${response.status}`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`Farming test server did not become ready at ${url}: ${lastError}`)
}

async function waitForPortClosed(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const open = await new Promise<boolean>(resolve => {
      const socket = net.createConnection({ host: '127.0.0.1', port })
      socket.setTimeout(300)
      socket.once('connect', () => {
        socket.destroy()
        resolve(true)
      })
      socket.once('error', () => resolve(false))
      socket.once('timeout', () => {
        socket.destroy()
        resolve(false)
      })
    })
    if (!open) return true
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  return false
}

async function requestJSON<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  const text = await response.text()
  if (!response.ok) throw new Error(`${init?.method || 'GET'} ${url} failed: ${response.status} ${text}`)
  return text ? JSON.parse(text) as T : {} as T
}

function spawnServer(
  port: number,
  configDir: string,
  logFile: string,
): ChildProcess {
  const fixtureBinDir = path.join(repoRoot, 'tests', 'e2e', 'fixtures')
  const log = fs.createWriteStream(logFile, { flags: 'wx' })
  const child = spawn(process.execPath, [path.join(repoRoot, 'backend', 'server.cjs')], {
    cwd: repoRoot,
    detached: true,
    env: {
      ...process.env,
      PORT: String(port),
      FARMING_BASE_PATH: basePath,
      FARMING_CONFIG_DIR: configDir,
      FARMING_DISABLE_AUTH: '1',
      FARMING_NATIVE_PTY_HOST_PERSIST: '0',
      FARMING_E2E_REAL_CODEX: '0',
      FARMING_E2E_FAKE_EXECUTABLES: '1',
      FARMING_E2E_FAKE_ACP_AGENT: '1',
      FARMING_CODEX_BIN: path.join(fixtureBinDir, 'fake-codex'),
      FARMING_ANONYMIZE_SHELL_PROMPT: '1',
      PATH: `${fixtureBinDir}${path.delimiter}${process.env.PATH || ''}`,
      NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout?.pipe(log)
  child.stderr?.pipe(log)
  child.once('exit', () => log.end())
  return child
}

async function waitForAgentIdle(baseURL: string, agentId: string): Promise<void> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const state = await requestJSON<{
      agents?: Array<{ id?: string, runtimeBinding?: { kind?: string, state?: string } }>
    }>(`${baseURL}/api/control/agents`)
    const agent = state.agents?.find(candidate => candidate.id === agentId)
    if (agent?.runtimeBinding?.kind === 'acp' && agent.runtimeBinding.state === 'idle') return
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`Fixture Agent ${agentId} did not reach authoritative ACP idle state`)
}

async function runXcodebuild(
  udid: string,
  resultBundle: string,
  derivedData: string,
  logFile: string,
  values: {
    appName: string
    baseURL: string
    chatAgentName: string
    terminalAgentName: string
  },
): Promise<number> {
  const args = [
    'test',
    '-project', harnessProject,
    '-scheme', harnessScheme,
    '-destination', `platform=iOS Simulator,id=${udid}`,
    '-derivedDataPath', derivedData,
    '-resultBundlePath', resultBundle,
    '-parallel-testing-enabled', 'NO',
    '-maximum-concurrent-test-simulator-destinations', '1',
    `FARMING_PWA_APP_NAME=${values.appName}`,
    `FARMING_PWA_BASE_URL=${values.baseURL}`,
    `FARMING_PWA_CHAT_AGENT_NAME=${values.chatAgentName}`,
    `FARMING_PWA_TERMINAL_AGENT_NAME=${values.terminalAgentName}`,
  ]
  const log = fs.createWriteStream(logFile, { flags: 'wx' })
  console.log(`Running: xcodebuild ${args.slice(0, 12).join(' ')} …`)
  const child = spawn('xcodebuild', args, {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout?.pipe(log)
  child.stderr?.pipe(log)
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      log.end()
      if (signal) reject(new Error(`xcodebuild exited from ${signal}`))
      else resolve(code ?? 1)
    })
  })
}

function exportResult(resultBundle: string, outputDir: string): void {
  if (!fs.existsSync(resultBundle)) return
  const summary = spawnSync(
    'xcrun',
    ['xcresulttool', 'get', 'test-results', 'summary', '--path', resultBundle, '--format', 'json'],
    { cwd: repoRoot, encoding: 'utf8' },
  )
  if (summary.status === 0) {
    fs.writeFileSync(path.join(outputDir, 'summary.json'), summary.stdout)
  }

  const attachmentsDir = path.join(outputDir, 'attachments')
  const exported = spawnSync(
    'xcrun',
    ['xcresulttool', 'export', 'attachments', '--path', resultBundle, '--output-path', attachmentsDir],
    { cwd: repoRoot, encoding: 'utf8' },
  )
  if (exported.status !== 0) return

  const manifestPath = path.join(attachmentsDir, 'manifest.json')
  if (!fs.existsSync(manifestPath)) return
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Array<{
    attachments?: Array<{ exportedFileName?: string, suggestedHumanReadableName?: string }>
  }>
  const screenshotsDir = path.join(outputDir, 'screenshots')
  for (const test of manifest) {
    for (const attachment of test.attachments || []) {
      const name = attachment.suggestedHumanReadableName || ''
      if (!/^(01|02|03)-/.test(name) || !attachment.exportedFileName) continue
      fs.mkdirSync(screenshotsDir, { recursive: true })
      fs.copyFileSync(
        path.join(attachmentsDir, attachment.exportedFileName),
        path.join(screenshotsDir, `${name.replace(/\.png$/i, '')}.png`),
      )
    }
  }
}

function exactRemove(directory: string, report: CleanupReport): void {
  if (!fs.existsSync(directory)) return
  fs.rmSync(directory, { recursive: true, force: true })
  report.removedTemporaryDirectories.push(directory)
}

async function stopProcessGroup(child: ChildProcess, report: CleanupReport): Promise<void> {
  if (!child.pid || child.exitCode !== null) {
    report.serverProcessGroupKilled = true
    return
  }
  try {
    process.kill(-child.pid, 'SIGKILL')
    report.serverProcessGroupKilled = true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    report.serverProcessGroupKilled = true
  }
  await new Promise<void>(resolve => {
    const timer = setTimeout(resolve, 5_000)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

async function main(): Promise<void> {
  if (process.platform !== 'darwin') {
    throw new Error('The native iOS Simulator acceptance harness requires macOS and Xcode')
  }
  commandOutput('xcodebuild', ['-version'])

  const token = runToken()
  const outputDir = path.resolve(
    process.env.FARMING_IOS_PWA_OUTPUT_DIR
      || path.join(repoRoot, '.tmp', 'ios-pwa-acceptance', token),
  )
  if (fs.existsSync(outputDir)) {
    throw new Error(`Refusing to replace an existing acceptance output directory: ${outputDir}`)
  }
  fs.mkdirSync(outputDir, { recursive: true })

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-ios-pwa-acceptance-'))
  const configDir = path.join(tempRoot, 'config')
  const workspace = path.join(tempRoot, 'workspace')
  const derivedData = path.join(tempRoot, 'DerivedData')
  fs.mkdirSync(configDir, { recursive: true })
  fs.mkdirSync(workspace, { recursive: true })

  const resultBundle = path.join(outputDir, 'FarmingPWAAcceptance.xcresult')
  const xcodeLog = path.join(outputDir, 'xcodebuild.log')
  const serverLog = path.join(outputDir, 'server.log')
  const cleanup: CleanupReport = {
    agentDeleted: false,
    serverProcessGroupKilled: false,
    portClosed: false,
    removedWebClips: [],
    removedHarnessApps: [],
    removedTemporaryDirectories: [],
    simulatorShutdown: false,
    errors: [],
  }

  const appName = `Farming 2 iOS Acceptance ${token}`
  const agentName = 'iOS PWA Acceptance Agent'
  let device: SimulatorDevice | null = null
  let bootedByHarness = false
  let pushBundlesBefore = new Set<string>()
  let port = 0
  let baseURL = ''
  let server: ChildProcess | null = null
  let agentId = ''
  let xcodeExitCode = 1

  try {
    const resolved = resolveSimulator()
    device = resolved.device
    bootedByHarness = resolved.bootedByHarness
    ensureSimulatorBooted(device, bootedByHarness)
    const installedBefore = listInstalledApps(device.udid)
    pushBundlesBefore = new Set(
      [...installedBefore.keys()].filter(bundleId => bundleId.startsWith('com.apple.WebKit.PushBundle.')),
    )
    port = await availableLoopbackPort()
    baseURL = `http://127.0.0.1:${port}${basePath}`

    server = spawnServer(port, configDir, serverLog)
    await waitForHTTP(`${baseURL}/`, 30_000)
    await requestJSON(`${baseURL}/api/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ composerFollowUpBehavior: 'queue' }),
    })
    const created = await requestJSON<{ agentId?: string }>(`${baseURL}/api/control/agents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        command: 'codex',
        workspace,
        name: agentName,
        agentRuntimeMode: 'chat',
      }),
    })
    if (!created.agentId) throw new Error('Fixture Agent creation returned no agentId')
    agentId = created.agentId
    await waitForAgentIdle(baseURL, agentId)
    await requestJSON(`${baseURL}/api/control/agents/${encodeURIComponent(agentId)}/title`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: agentName }),
    })

    fs.writeFileSync(path.join(outputDir, 'run.json'), `${JSON.stringify({
      revision: commandOutput('git', ['rev-parse', 'HEAD']).trim(),
      startedAt: new Date().toISOString(),
      simulator: device,
      xcode: commandOutput('xcodebuild', ['-version']).trim().split('\n'),
      node: process.version,
      baseURL,
      appName,
      agentId,
      agentName,
      resultBundle,
    }, null, 2)}\n`)

    xcodeExitCode = await runXcodebuild(
      device.udid,
      resultBundle,
      derivedData,
      xcodeLog,
      {
        appName,
        baseURL: `${baseURL}/`,
        chatAgentName: agentName,
        terminalAgentName: agentName,
      },
    )
    exportResult(resultBundle, outputDir)
  } finally {
    if (agentId && server?.exitCode === null) {
      try {
        await requestJSON(`${baseURL}/api/control/agents/${encodeURIComponent(agentId)}?recordHistory=0`, {
          method: 'DELETE',
        })
        cleanup.agentDeleted = true
      } catch (error) {
        cleanup.errors.push(`Agent cleanup: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (server) {
      try {
        await stopProcessGroup(server, cleanup)
      } catch (error) {
        cleanup.errors.push(`Server cleanup: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (port > 0) {
      cleanup.portClosed = await waitForPortClosed(port, 5_000)
      if (!cleanup.portClosed) cleanup.errors.push(`Port ${port} remained open after server cleanup`)
    } else {
      cleanup.portClosed = true
    }

    if (device) {
      try {
        const installedAfter = listInstalledApps(device.udid)
        for (const bundleId of installedAfter.keys()) {
          if (
            bundleId.startsWith('com.apple.WebKit.PushBundle.')
            && !pushBundlesBefore.has(bundleId)
            && uninstall(device.udid, bundleId)
          ) {
            cleanup.removedWebClips.push(bundleId)
          }
        }
        for (const bundleId of harnessBundleIds) {
          if (uninstall(device.udid, bundleId)) cleanup.removedHarnessApps.push(bundleId)
        }
      } catch (error) {
        cleanup.errors.push(`Simulator app cleanup: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    try {
      exactRemove(derivedData, cleanup)
      exactRemove(workspace, cleanup)
      exactRemove(configDir, cleanup)
      exactRemove(tempRoot, cleanup)
    } catch (error) {
      cleanup.errors.push(`Temporary directory cleanup: ${error instanceof Error ? error.message : String(error)}`)
    }

    if (device && bootedByHarness) {
      try {
        commandOutput('xcrun', ['simctl', 'shutdown', device.udid])
        cleanup.simulatorShutdown = true
      } catch (error) {
        cleanup.errors.push(`Simulator shutdown: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    fs.writeFileSync(path.join(outputDir, 'cleanup.json'), `${JSON.stringify(cleanup, null, 2)}\n`)
  }

  const log = fs.existsSync(xcodeLog) ? fs.readFileSync(xcodeLog, 'utf8') : ''
  const evidence = log.split('\n').filter(line => (
    line.includes('IOS_PWA_EVIDENCE')
    || /error: -\[HarnessUITests\.FarmingPWAUITests/.test(line)
  ))
  console.log(`Artifacts: ${outputDir}`)
  console.log(`xcresult: ${resultBundle}`)
  if (evidence.length > 0) console.log(evidence.join('\n'))
  if (cleanup.errors.length > 0) {
    throw new Error(`Acceptance cleanup was incomplete:\n${cleanup.errors.join('\n')}`)
  }
  process.exitCode = xcodeExitCode
}

if (require.main === module) {
  void main().catch(error => {
    console.error(error instanceof Error ? error.stack || error.message : error)
    process.exitCode = 1
  })
}
