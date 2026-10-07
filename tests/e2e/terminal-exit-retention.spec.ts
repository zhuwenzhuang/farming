import fs from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { expect, openFarming, test } from './fixtures'
import type { Agent } from '../../src/types/agent'

async function stoppedCodex(page: Page, workspaceRoot: string) {
  const workspace = path.join(workspaceRoot, 'terminal-exit-demo')
  fs.mkdirSync(workspace, { recursive: true })
  fs.writeFileSync(path.join(workspace, 'README.md'), '# Terminal exit demo\n')
  const created = await page.request.post('/farming/api/control/agents', {
    data: { command: 'codex', workspace, agentRuntimeMode: 'terminal' },
  })
  expect(created.ok()).toBeTruthy()
  const { agentId } = await created.json() as { agentId: string }
  const readAgent = async () => {
    const response = await page.request.get('/farming/api/control/agents')
    expect(response.ok()).toBeTruthy()
    return (await response.json() as { agents: Agent[] }).agents.find(agent => agent.id === agentId)
  }
  await openFarming(page)
  const row = page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
  await row.click()
  const pane = page.locator(`[data-testid="code-terminal-pane"][data-agent-id="${agentId}"]`)
  await expect(pane).toBeVisible()
  await page.waitForFunction(id => window.__farmingTerminalTest?.isReady(id), agentId)
  expect((await readAgent())?.providerSessionTemporary).toBe(true)
  await pane.click()
  await page.keyboard.press('Control+c')
  await expect.poll(async () => (await readAgent())?.status).toMatch(/^(stopped|dead)$/)
  const notice = page.getByTestId('code-terminal-stopped')
  await expect(notice).toBeVisible()
  await expect(row).toBeHidden()
  return { workspace, agentId, readAgent, row, pane, notice }
}

function candidates(workspace: string) {
  const session = (id: string, title: string, overrides = {}) => ({
    provider: 'codex', providerHomeId: 'default', id, title,
    cwd: workspace, workspace, updatedAt: '2026-10-04T08:00:00.000Z', ...overrides,
  })
  return [
    session('conversation-a', 'Review terminal behavior'),
    session('conversation-b', 'Continue workspace changes'),
    session('conversation-b', 'Different Home', { providerHomeId: 'other' }),
    session('conversation-c', 'Different Provider', { provider: 'claude' }),
    session('conversation-d', 'Different workspace', { workspace: `${workspace}-other`, cwd: `${workspace}-other` }),
  ]
}

async function mockCandidates(page: Page, workspace: string) {
  await page.route(/\/api\/agent-sessions\?/, route => route.fulfill({ json: {
    sessions: candidates(workspace), hasMore: false, nextCursor: '', total: 5,
  } }))
}

test('Ctrl+C hides the sidebar row while retaining Terminal inspection, Resume and Project', async ({ page, workspaceRoot }, testInfo) => {
  let afterExit = false
  const unexpectedTerminalInputs: string[] = []
  page.on('websocket', socket => socket.on('framesent', frame => {
    const message = JSON.parse(String(frame.payload)) as { type: string }
    if (afterExit && message.type === 'input') unexpectedTerminalInputs.push(String(frame.payload))
  }))
  const f = await stoppedCodex(page, workspaceRoot)
  afterExit = true
  await expect(f.row).toBeHidden()
  await expect(f.pane).toBeVisible()
  await expect(page.getByTestId('code-composer-input')).toBeDisabled()
  await expect(page.getByTestId('code-composer-input')).toHaveAttribute('placeholder', 'Agent stopped. Terminal is read-only.')
  await expect(page.getByTestId('code-composer-send')).toBeDisabled()
  const project = page.getByTestId('code-project-title').filter({ hasText: 'terminal-exit-demo' })
  await expect(project).toBeVisible()
  await page.keyboard.type('do not replay')
  const unexpectedMutations: string[] = []
  page.on('request', request => {
    if (request.method() === 'POST' && /\/api\/(?:control\/agents(?:\/[^/]+\/input)?|agent-sessions\/[^/]+\/[^/]+\/resume)(?:\?|$)/.test(request.url())) {
      unexpectedMutations.push(request.url())
    }
  })
  await mockCandidates(page, f.workspace)
  for (const appearance of ['light', 'dark', 'paper']) {
    await page.evaluate(value => {
      document.documentElement.dataset.appearance = value
      document.body.dataset.appearance = value
    }, appearance)
    await expect(f.notice.getByRole('button', { name: 'Resume', exact: true })).toBeEnabled()
    await expect(f.notice.getByRole('button', { name: 'Archive', exact: true })).toBeEnabled()
    await expect(f.row).toBeHidden()
    await page.screenshot({ path: testInfo.outputPath(`terminal-resume-stopped-${appearance}.png`), animations: 'disabled' })
    const fresh = page.waitForRequest(request => /\/api\/agent-sessions\?/.test(request.url()) && new URL(request.url()).searchParams.get('force') === '1')
    await f.notice.getByRole('button', { name: 'Resume', exact: true }).click()
    await fresh
    const dialog = page.getByTestId('code-resume-stopped-dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByTestId('code-resume-stopped-candidate')).toHaveCount(2)
    await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused()
    await page.screenshot({ path: testInfo.outputPath(`terminal-resume-picker-${appearance}.png`), animations: 'disabled' })
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(dialog).toBeHidden()
  }
  expect(unexpectedMutations).toEqual([])
  expect(unexpectedTerminalInputs).toEqual([])
  await page.reload()
  await expect(f.row).toBeHidden()
  await expect(f.pane).toBeVisible()
  await page.goto(`/farming/crt/?agent=${encodeURIComponent(f.agentId)}`)
  await expect(page.locator('#session-modal')).toHaveClass(/active/)
  expect(['stopped', 'dead']).toContain((await f.readAgent())?.status)
  await page.goto('/farming/')
  await expect(f.notice).toBeVisible()
  await f.notice.getByRole('button', { name: 'Archive', exact: true }).click()
  await expect(f.row).toBeHidden()
  await expect(f.notice).toBeHidden()
  await expect(project).toBeVisible()
  await expect.poll(async () => {
    const agent = await f.readAgent()
    return !agent || agent.archived === true
  }).toBe(true)
  expect(unexpectedMutations).toEqual([])
  expect(unexpectedTerminalInputs).toEqual([])
})

test('Resume retries history reads and only resumes the explicitly selected exact Provider Home session', async ({ page, workspaceRoot }) => {
  const f = await stoppedCodex(page, workspaceRoot)
  let failHistory = true
  await page.route(/\/api\/agent-sessions\?/, route => route.fulfill(failHistory
    ? { status: 503, json: { error: 'History unavailable' } }
    : { json: { sessions: candidates(f.workspace), hasMore: false, nextCursor: '', total: 5 } }))
  const resumes: Array<{ pathname: string; body: unknown }> = []
  await page.route(/\/api\/agent-sessions\/[^/]+\/[^/]+\/resume$/, async route => {
    resumes.push({ pathname: new URL(route.request().url()).pathname, body: route.request().postDataJSON() })
    await route.fulfill({ status: 409, json: { error: 'Fixture session cannot resume' } })
  })
  await f.notice.getByRole('button', { name: 'Resume', exact: true }).click()
  const dialog = page.getByTestId('code-resume-stopped-dialog')
  await expect(dialog.getByRole('alert')).toBeVisible()
  expect(resumes).toEqual([])
  failHistory = false
  await dialog.getByRole('button', { name: 'Retry', exact: true }).click()
  await expect(dialog.getByTestId('code-resume-stopped-candidate')).toHaveCount(2)
  expect(resumes).toEqual([])
  await dialog.locator('[data-session-id="conversation-b"]').click()
  await expect(dialog).toBeHidden()
  await expect(page.getByTestId('code-agent-opening')).toHaveAttribute('data-phase', 'failed')
  expect(resumes).toEqual([{ pathname: '/farming/api/agent-sessions/codex/conversation-b/resume', body: { providerHomeId: 'default', unarchiveArchived: true, agentRuntimeMode: 'chat', acpHistoryMode: 'load' } }])
  const original = await f.readAgent()
  expect(original?.archived).not.toBe(true)
  expect(['stopped', 'dead']).toContain(original?.status)
})

test('archiving the original Agent revokes an open Resume chooser', async ({ page, workspaceRoot }) => {
  const f = await stoppedCodex(page, workspaceRoot)
  await mockCandidates(page, f.workspace)
  await f.notice.getByRole('button', { name: 'Resume', exact: true }).click()
  const dialog = page.getByTestId('code-resume-stopped-dialog')
  await expect(dialog.getByTestId('code-resume-stopped-candidate')).toHaveCount(2)
  let resumes = 0
  await page.route(/\/api\/agent-sessions\/[^/]+\/[^/]+\/resume$/, route => { resumes += 1; return route.abort() })
  const archived = await page.request.patch(`/farming/api/agents/${f.agentId}`, { data: { archived: true } })
  expect(archived.ok()).toBeTruthy()
  await expect(dialog).toBeHidden()
  await expect(f.row).toBeHidden()
  await expect(page.getByTestId('code-project-title').filter({ hasText: 'terminal-exit-demo' })).toBeVisible()
  expect(resumes).toBe(0)
})

test('CRT stops accepting input when an open Provider Terminal exits', async ({ page, workspaceRoot }) => {
  const workspace = path.join(workspaceRoot, 'crt-terminal-exit-demo')
  fs.mkdirSync(workspace, { recursive: true })
  const created = await page.request.post('/farming/api/control/agents', {
    data: { command: 'codex', workspace, agentRuntimeMode: 'terminal' },
  })
  expect(created.ok()).toBeTruthy()
  const { agentId } = await created.json() as { agentId: string }
  const inputs: string[] = []
  page.on('websocket', socket => socket.on('framesent', frame => {
    const message = JSON.parse(String(frame.payload)) as { type: string }
    if (message.type === 'input') inputs.push(String(frame.payload))
  }))
  await page.goto(`/farming/crt/?agent=${encodeURIComponent(agentId)}`)
  await expect(page.locator('#session-modal')).toHaveClass(/active/)
  const textarea = page.locator('#terminal-output .xterm-helper-textarea')
  await expect(textarea).toBeAttached()
  await textarea.focus()
  await page.keyboard.press('Control+c')
  await expect(page.locator('#session-title')).toContainText('[READ ONLY]')
  const inputCount = inputs.length
  expect(inputCount).toBeGreaterThan(0)
  await page.keyboard.type('do not replay')
  expect(inputs.length).toBe(inputCount)
  await expect(page.locator('#session-modal')).toHaveClass(/active/)
})
