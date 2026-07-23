import fs from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

async function createControlAgent(page: Page, command: string, workspace: string) {
  const response = await page.request.post('/farming/api/control/agents', {
    data: { command, workspace },
  })
  expect(response.ok()).toBeTruthy()
  const data = await response.json() as { agentId?: string }
  expect(data.agentId).toBeTruthy()
  return data.agentId as string
}

async function controlAgents(page: Page) {
  const response = await page.request.get('/farming/api/control/agents')
  expect(response.ok()).toBeTruthy()
  const data = await response.json() as {
    agents?: Array<{
      id: string
      cwd?: string
      providerSessionTemporary?: boolean
      providerSessionId?: string
    }>
  }
  return data.agents ?? []
}

function agentRow(page: Page, agentId: string) {
  return page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
}

async function openPermissionTestApp(page: Page) {
  await page.goto('/farming/', { waitUntil: 'domcontentloaded' })
  await expect(page.getByTestId('app-shell')).toBeVisible()
}

test.describe('permission switching', () => {
  test('restarts a fresh Codex and never falls through to another agent', async ({ page, workspaceRoot }) => {
    const workspace = path.join(workspaceRoot, 'fresh-permission-switch')
    fs.mkdirSync(workspace, { recursive: true })
    const codexAgentId = await createControlAgent(page, 'codex', workspace)
    const bashAgentId = await createControlAgent(page, 'bash', workspace)
    const initialCodex = (await controlAgents(page)).find(agent => agent.id === codexAgentId)
    expect(initialCodex?.providerSessionTemporary).toBe(false)
    expect(initialCodex?.providerSessionId).toBe('acp-new-session')

    let patchCount = 0
    let restartedAgentId = ''
    let releaseResponse = () => {}
    let markBackendFinished = () => {}
    const backendFinished = new Promise<void>(resolve => { markBackendFinished = resolve })
    const responseGate = new Promise<void>(resolve => { releaseResponse = resolve })
    await page.route(new RegExp(`/farming/api/agents/${codexAgentId}$`), async route => {
      const body = route.request().postDataJSON() as { launchPermissionMode?: string } | null
      if (route.request().method() !== 'PATCH' || typeof body?.launchPermissionMode !== 'string') {
        await route.continue()
        return
      }
      patchCount += 1
      const response = await route.fetch()
      const payload = await response.json() as { restartedAgentId?: string }
      restartedAgentId = payload.restartedAgentId ?? ''
      markBackendFinished()
      await responseGate
      await route.fulfill({ response })
    })

    await openPermissionTestApp(page)
    await agentRow(page, codexAgentId).click()
    await expect(agentRow(page, codexAgentId)).toHaveClass(/active/)
    await expect(page.getByTestId('code-agent-terminal-view')).toHaveClass(/active/)
    const unsentDraft = 'keep this unsent draft across the permission restart'
    await page.getByTestId('code-composer-input').fill(unsentDraft)
    await page.getByTestId('code-composer-approval').click()
    const fullAccess = page.getByTestId('code-approval-menu').getByRole('menuitemradio', { name: /Full access/ })
    await fullAccess.evaluate(element => {
      ;(element as HTMLButtonElement).click()
      ;(element as HTMLButtonElement).click()
    })

    await backendFinished
    await expect(page.getByTestId('code-permission-switching')).toBeVisible()
    await expect(page.getByTestId('code-agent-work-pane')).toHaveAttribute('aria-busy', 'true')
    await expect(page.getByTestId('code-composer-input')).toBeDisabled()
    await expect(page.getByTestId('code-composer-input')).toHaveValue(unsentDraft)
    expect(restartedAgentId).not.toBe('')
    await expect(agentRow(page, restartedAgentId)).toHaveClass(/active/)
    await expect(agentRow(page, codexAgentId)).toHaveCount(0)
    await expect(agentRow(page, bashAgentId)).not.toHaveClass(/active/)
    expect(patchCount).toBe(1)

    await page.getByTestId('code-nav-history').click()
    await expect(page.getByTestId('code-history-panel')).toBeVisible()
    releaseResponse()
    await expect.poll(() => restartedAgentId).not.toBe('')
    await expect(agentRow(page, restartedAgentId)).toHaveClass(/active/)
    await expect(agentRow(page, codexAgentId)).toHaveCount(0)
    await expect(agentRow(page, bashAgentId)).not.toHaveClass(/active/)
    await expect(page.getByTestId('code-history-panel')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('code-terminal-grid')).toBeVisible()
    await expect(page.getByTestId('code-permission-switching')).toHaveCount(0)
    await expect(page.getByTestId('code-agent-terminal-view')).toHaveClass(/active/)
    await expect(page.getByTestId('code-composer-input')).toHaveValue(unsentDraft)
    const replacement = (await controlAgents(page)).find(agent => agent.id === restartedAgentId)
    expect(replacement?.providerSessionTemporary).toBe(false)
    expect(replacement?.providerSessionId).toBe(initialCodex?.providerSessionId)
  })

  test('keeps the WebSocket replacement when the PATCH response is lost', async ({ page, workspaceRoot }) => {
    const workspace = path.join(workspaceRoot, 'lost-permission-response')
    fs.mkdirSync(workspace, { recursive: true })
    const codexAgentId = await createControlAgent(page, 'codex', workspace)
    const bashAgentId = await createControlAgent(page, 'bash', workspace)

    let restartedAgentId = ''
    let releaseAbort = () => {}
    let markBackendFinished = () => {}
    const backendFinished = new Promise<void>(resolve => { markBackendFinished = resolve })
    const abortGate = new Promise<void>(resolve => { releaseAbort = resolve })
    await page.route(new RegExp(`/farming/api/agents/${codexAgentId}$`), async route => {
      const body = route.request().postDataJSON() as { launchPermissionMode?: string } | null
      if (route.request().method() !== 'PATCH' || typeof body?.launchPermissionMode !== 'string') {
        await route.continue()
        return
      }
      const response = await route.fetch()
      const payload = await response.json() as { restartedAgentId?: string }
      restartedAgentId = payload.restartedAgentId ?? ''
      markBackendFinished()
      await abortGate
      await route.abort('failed')
    })

    await openPermissionTestApp(page)
    await agentRow(page, codexAgentId).click()
    const unsentDraft = 'keep draft when the permission response disappears'
    await page.getByTestId('code-composer-input').fill(unsentDraft)
    await page.getByTestId('code-composer-approval').click()
    await page.getByTestId('code-approval-menu').getByRole('menuitemradio', { name: /Full access/ }).click()

    await backendFinished
    expect(restartedAgentId).not.toBe('')
    await expect(agentRow(page, restartedAgentId)).toHaveClass(/active/)
    await expect(agentRow(page, codexAgentId)).toHaveCount(0)
    await expect(agentRow(page, bashAgentId)).not.toHaveClass(/active/)
    await expect(page.getByTestId('code-permission-switching')).toBeVisible()
    await page.getByTestId('code-nav-history').click()
    await expect(page.getByTestId('code-history-panel')).toBeVisible()

    releaseAbort()
    await expect(page.getByTestId('code-permission-switching')).toHaveCount(0)
    await expect(page.getByTestId('code-history-panel')).toBeVisible()
    await expect(agentRow(page, restartedAgentId)).toHaveClass(/active/)
    await expect(agentRow(page, bashAgentId)).not.toHaveClass(/active/)
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('code-agent-terminal-view')).toHaveClass(/active/)
    await expect(page.getByTestId('code-composer-input')).toHaveValue(unsentDraft)
    await expect(page.getByTestId('code-composer-approval')).toBeEnabled()
  })

  test('reconciles a replacement that arrives after the PATCH has already failed', async ({ page, workspaceRoot }) => {
    const workspace = path.join(workspaceRoot, 'late-websocket-permission-replacement')
    fs.mkdirSync(workspace, { recursive: true })
    const codexAgentId = await createControlAgent(page, 'codex', workspace)
    const bashAgentId = await createControlAgent(page, 'bash', workspace)

    let markRequestAborted = () => {}
    const requestAborted = new Promise<void>(resolve => { markRequestAborted = resolve })
    await page.route(new RegExp(`/farming/api/agents/${codexAgentId}$`), async route => {
      const body = route.request().postDataJSON() as { launchPermissionMode?: string } | null
      if (route.request().method() !== 'PATCH' || typeof body?.launchPermissionMode !== 'string') {
        await route.continue()
        return
      }
      await route.abort('failed')
      markRequestAborted()
    })

    await openPermissionTestApp(page)
    await agentRow(page, codexAgentId).click()
    const unsentDraft = 'keep draft when replacement arrives after fetch failure'
    await page.getByTestId('code-composer-input').fill(unsentDraft)
    await page.getByTestId('code-composer-approval').click()
    await page.getByTestId('code-approval-menu').getByRole('menuitemradio', { name: /Full access/ }).click()

    await requestAborted
    await page.waitForTimeout(100)
    await expect(page.getByTestId('code-permission-switching')).toBeVisible()
    await expect(agentRow(page, codexAgentId)).toHaveClass(/active/)

    const replacementResponse = await page.request.patch(`/farming/api/agents/${codexAgentId}`, {
      data: { launchPermissionMode: 'full' },
    })
    expect(replacementResponse.ok()).toBeTruthy()
    const replacementPayload = await replacementResponse.json() as { restartedAgentId?: string }
    const replacementAgentId = replacementPayload.restartedAgentId ?? ''
    expect(replacementAgentId).not.toBe('')
    await expect(agentRow(page, replacementAgentId)).toHaveClass(/active/)
    await expect(agentRow(page, codexAgentId)).toHaveCount(0)
    await expect(agentRow(page, bashAgentId)).not.toHaveClass(/active/)
    await expect(page.getByTestId('code-permission-switching')).toHaveCount(0)
    await expect(page.getByTestId('code-agent-terminal-view')).toHaveClass(/active/)
    await expect(page.getByTestId('code-composer-input')).toHaveValue(unsentDraft)
  })

  test('follows a replacement restarted by another client before the first response returns', async ({ page, workspaceRoot }) => {
    const workspace = path.join(workspaceRoot, 'chained-permission-switch')
    fs.mkdirSync(workspace, { recursive: true })
    const codexAgentId = await createControlAgent(page, 'codex', workspace)
    const bashAgentId = await createControlAgent(page, 'bash', workspace)

    let intermediateAgentId = ''
    let releaseResponse = () => {}
    let markBackendFinished = () => {}
    const backendFinished = new Promise<void>(resolve => { markBackendFinished = resolve })
    const responseGate = new Promise<void>(resolve => { releaseResponse = resolve })
    await page.route(new RegExp(`/farming/api/agents/${codexAgentId}$`), async route => {
      const body = route.request().postDataJSON() as { launchPermissionMode?: string } | null
      if (route.request().method() !== 'PATCH' || typeof body?.launchPermissionMode !== 'string') {
        await route.continue()
        return
      }
      const response = await route.fetch()
      const payload = await response.json() as { restartedAgentId?: string }
      intermediateAgentId = payload.restartedAgentId ?? ''
      markBackendFinished()
      await responseGate
      await route.fulfill({ response })
    })

    await openPermissionTestApp(page)
    await agentRow(page, codexAgentId).click()
    const unsentDraft = 'keep draft through a chained permission restart'
    await page.getByTestId('code-composer-input').fill(unsentDraft)
    await page.getByTestId('code-composer-approval').click()
    await page.getByTestId('code-approval-menu').getByRole('menuitemradio', { name: /Full access/ }).click()

    await backendFinished
    expect(intermediateAgentId).not.toBe('')
    await expect(agentRow(page, intermediateAgentId)).toHaveClass(/active/)
    await expect(page.getByTestId('code-permission-switching')).toBeVisible()

    const chainedResponse = await page.request.patch(`/farming/api/agents/${intermediateAgentId}`, {
      data: { launchPermissionMode: 'ask' },
    })
    expect(chainedResponse.ok()).toBeTruthy()
    const chainedPayload = await chainedResponse.json() as { restartedAgentId?: string }
    const finalAgentId = chainedPayload.restartedAgentId ?? ''
    expect(finalAgentId).not.toBe('')
    await expect(agentRow(page, finalAgentId)).toHaveClass(/active/)
    await expect(agentRow(page, codexAgentId)).toHaveCount(0)
    await expect(agentRow(page, intermediateAgentId)).toHaveCount(0)
    await expect(agentRow(page, bashAgentId)).not.toHaveClass(/active/)
    await expect(page.getByTestId('code-permission-switching')).toBeVisible()

    await page.getByTestId('code-nav-history').click()
    await expect(page.getByTestId('code-history-panel')).toBeVisible()
    releaseResponse()
    await expect(page.getByTestId('code-permission-switching')).toHaveCount(0)
    await expect(page.getByTestId('code-history-panel')).toBeVisible()
    await expect(agentRow(page, finalAgentId)).toHaveClass(/active/)
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('code-agent-terminal-view')).toHaveClass(/active/)
    await expect(page.getByTestId('code-composer-input')).toHaveValue(unsentDraft)
  })

  test('keeps an observing browser on the same agent and view', async ({ page, context, workspaceRoot }) => {
    const workspace = path.join(workspaceRoot, 'observing-browser-permission-switch')
    fs.mkdirSync(workspace, { recursive: true })
    const sessionId = '019f0000-0000-7000-8000-00000000b22f'
    const codexAgentId = await createControlAgent(page, `codex resume ${sessionId}`, workspace)
    const bashAgentId = await createControlAgent(page, 'bash', workspace)
    const observerPage = await context.newPage()

    await openPermissionTestApp(page)
    await openPermissionTestApp(observerPage)
    await agentRow(observerPage, codexAgentId).click()
    await expect(observerPage.getByRole('button', { name: 'Terminal' })).toHaveAttribute('aria-pressed', 'true')
    const observerDraft = 'keep the observing browser draft and view'
    await observerPage.getByTestId('code-composer-input').fill(observerDraft)
    await observerPage.getByTestId('code-nav-history').click()
    await expect(observerPage.getByTestId('code-history-panel')).toBeVisible()

    await page.waitForTimeout(180)
    await agentRow(page, codexAgentId).click()
    await page.getByTestId('code-composer-approval').click()
    await page.getByTestId('code-approval-menu').getByRole('menuitemradio', { name: /Full access/ }).click()

    let replacementAgentId = ''
    await expect.poll(async () => {
      const agents = await controlAgents(page)
      replacementAgentId = agents.find(agent => (
        agent.cwd === workspace && agent.id !== codexAgentId && agent.id !== bashAgentId
      ))?.id ?? ''
      return replacementAgentId
    }).not.toBe('')
    await expect(agentRow(observerPage, replacementAgentId)).toHaveClass(/active/)
    await expect(agentRow(observerPage, codexAgentId)).toHaveCount(0)
    await expect(agentRow(observerPage, bashAgentId)).not.toHaveClass(/active/)
    await expect(observerPage.getByTestId('code-history-panel')).toBeVisible()
    await observerPage.keyboard.press('Escape')
    await expect(observerPage.getByTestId('code-agent-terminal-view')).toHaveClass(/active/)
    await expect(observerPage.getByTestId('code-agent-chat-view')).toHaveCount(0)
    await expect(observerPage.getByTestId('code-composer-input')).toHaveValue(observerDraft)
  })

  test('preserves explicit navigation and Terminal view across a resumable restart', async ({ page, workspaceRoot }) => {
    const workspace = path.join(workspaceRoot, 'resumable-permission-switch')
    fs.mkdirSync(workspace, { recursive: true })
    const sessionId = '019f0000-0000-7000-8000-00000000a11e'
    const codexAgentId = await createControlAgent(page, `codex resume ${sessionId}`, workspace)
    const bashAgentId = await createControlAgent(page, 'bash', workspace)

    let restartedAgentId = ''
    let releaseResponse = () => {}
    let markBackendFinished = () => {}
    const backendFinished = new Promise<void>(resolve => { markBackendFinished = resolve })
    const responseGate = new Promise<void>(resolve => { releaseResponse = resolve })
    await page.route(new RegExp(`/farming/api/agents/${codexAgentId}$`), async route => {
      const body = route.request().postDataJSON() as { launchPermissionMode?: string } | null
      if (route.request().method() !== 'PATCH' || typeof body?.launchPermissionMode !== 'string') {
        await route.continue()
        return
      }
      const response = await route.fetch()
      const payload = await response.json() as { restartedAgentId?: string }
      restartedAgentId = payload.restartedAgentId ?? ''
      markBackendFinished()
      await responseGate
      await route.fulfill({ response })
    })

    await openPermissionTestApp(page)
    await agentRow(page, codexAgentId).click()
    await expect(page.getByRole('button', { name: 'Terminal' })).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('code-agent-terminal-view')).toHaveClass(/active/)
    await expect(page.getByTestId('code-agent-chat-view')).toHaveCount(0)
    await page.getByTestId('code-composer-approval').click()
    await page.getByTestId('code-approval-menu').getByRole('menuitemradio', { name: /Full access/ }).click()

    await backendFinished
    await expect(page.getByTestId('code-permission-switching')).toBeVisible()
    await agentRow(page, bashAgentId).click()
    await expect(agentRow(page, bashAgentId)).toHaveClass(/active/)
    await page.getByTestId('code-nav-history').click()
    await expect(page.getByTestId('code-history-panel')).toBeVisible()
    releaseResponse()

    await expect.poll(() => restartedAgentId).not.toBe('')
    await expect(page.getByTestId('code-history-panel')).toBeVisible()
    await expect(agentRow(page, bashAgentId)).toHaveClass(/active/)
    await expect(agentRow(page, restartedAgentId)).not.toHaveClass(/active/)
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('code-terminal-grid')).toBeVisible()
    await agentRow(page, restartedAgentId).click()
    await expect(page.getByTestId('code-agent-terminal-view')).toHaveClass(/active/)
    await expect(page.getByTestId('code-agent-chat-view')).toHaveCount(0)
  })
})
