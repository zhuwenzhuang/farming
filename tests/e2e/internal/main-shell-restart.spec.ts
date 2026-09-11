import { test, expect } from '@playwright/test'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { FarmingSessionStore } from '../../../backend/farming-session-store.cjs'

const exec = promisify(execFile)

test('hard restart retires Main Shells without adding bash rows', async ({ page }, testInfo) => {
  test.setTimeout(120_000)
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'farming-main-shell-restart-'))
  const configDir = path.join(root, 'config')
  const workspace = path.join(root, 'demo-project')
  fs.mkdirSync(workspace)
  const store = new FarmingSessionStore(configDir)
  store.init()
  fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify({
    workspace, projectWorkspaces: [workspace], instanceName: 'Restart demo',
    browserExtensionEnabled: false, computerExtensionEnabled: false,
    languageServerEnabled: false, theme: 'terminal', appearance: 'light', language: 'en',
  }))
  for (let index = 0; index < 45; index += 1) {
    store.ensureRecordForAgent({
      id: `retired-main-${index}`, command: 'bash', forkCommand: 'bash',
      cwd: workspace, projectWorkspace: workspace, mainWorkspace: workspace,
      wantsMain: false, category: 'other', agentRuntimeMode: 'terminal',
    }, { visibleOnMainPage: true })
  }
  // Ordinary Shell history alone must not create a runtime row either.
  store.ensureRecordForAgent({
    id: 'ordinary-shell', command: 'bash', forkCommand: 'bash',
    cwd: workspace, projectWorkspace: workspace, wantsMain: false,
    category: 'other', agentRuntimeMode: 'terminal', customTitle: 'Project terminal',
  }, { visibleOnMainPage: true })
  const port = await new Promise<number>((resolve, reject) => {
    const listener = net.createServer()
    listener.once('error', reject)
    listener.listen(0, '127.0.0.1', () => {
      const address = listener.address()
      if (!address || typeof address === 'string') return reject(new Error('No test port'))
      listener.close(() => resolve(address.port))
    })
  })
  const baseUrl = `http://127.0.0.1:${port}/farming`
  const fixtureBin = path.resolve('tests/e2e/fixtures')
  const env = {
    ...process.env, FARMING_DISABLE_AUTH: '1', FARMING_BASE_PATH: '/farming',
    FARMING_E2E_FAKE_EXECUTABLES: '1', FARMING_E2E_FAKE_ACP_AGENT: '1',
    FARMING_CODEX_BIN: path.join(fixtureBin, 'fake-codex'),
    FARMING_ANONYMIZE_SHELL_PROMPT: '1', NODE_ENV: 'test',
    PATH: `${fixtureBin}${path.delimiter}${process.env.PATH || ''}`,
  }
  const command = (operation: 'start' | 'stop') => exec(process.execPath, [
    'bin/farming', operation === 'start' ? 'daemon' : 'stop', '--config-dir', configDir, '--port', String(port),
  ], { env, timeout: 30_000 })
  const inventory = async () => {
    const response = await page.request.get(`${baseUrl}/api/control/agents`)
    expect(response.ok()).toBeTruthy()
    return (await response.json()).agents as Array<{ id: string; isMain: boolean; status: string }>
  }
  try {
    await command('start')
    await page.goto(`${baseUrl}/`)
    await expect(page.getByTestId('app-shell')).toBeVisible()
    await expect.poll(async () => (await inventory()).filter(agent => agent.isMain && agent.status === 'running').length).toBe(1)
    const initialMain = (await inventory()).find(agent => agent.isMain)!.id
    await page.goto('about:blank')
    // The product stop command kills the entire exact Config-owned process set.
    await command('stop')
    await command('start')
    await page.goto(`${baseUrl}/`)
    await expect(page.getByTestId('app-shell')).toBeVisible()
    await expect.poll(async () => (await inventory()).filter(agent => agent.isMain && agent.status === 'running').length).toBe(1)
    const recovered = await inventory()
    expect(recovered.map(agent => agent.id)).not.toContain(initialMain)
    expect(recovered.filter(agent => agent.id.startsWith('retired-main-'))).toHaveLength(0)
    expect(recovered.find(agent => agent.id === 'ordinary-shell')).toBeUndefined()
    expect(recovered).toHaveLength(1)
    const created = await page.request.post(`${baseUrl}/api/control/agents`, {
      data: { command: 'bash', workspace, wantsMain: false },
    })
    expect(created.ok()).toBeTruthy()
    const { agentId: liveTerminalId } = await created.json()
    const terminalRow = page.locator(`.code-agent-row[data-agent-id="${liveTerminalId}"]`)
    await expect(terminalRow).toBeVisible()
    await terminalRow.click()
    await expect(page.locator(`[data-testid="code-terminal-pane"][data-agent-id="${liveTerminalId}"]`)).toBeVisible()
    await expect(page.locator(`.code-agent-row[data-agent-id="${initialMain}"]`)).toHaveCount(0)
    for (const appearance of ['light', 'dark', 'paper']) {
      await page.locator('body').evaluate((body, value) => { body.dataset.appearance = value }, appearance)
      await page.screenshot({ path: testInfo.outputPath(`main-shell-restart-${appearance}.png`), animations: 'disabled' })
    }
  } catch (error) {
    if (!page.isClosed()) await page.screenshot({ path: testInfo.outputPath('failure.png') })
    const log = path.join(configDir, 'farming-server.log')
    if (fs.existsSync(log)) await testInfo.attach('server-log', { path: log, contentType: 'text/plain' })
    throw error
  } finally {
    await page.close()
    await command('stop')
    fs.rmSync(root, { recursive: true, force: true })
  }
})
