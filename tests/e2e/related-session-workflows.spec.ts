import fs from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { expect, openFarming, test } from './fixtures'

async function resizeSidebar(page: Page, width: number) {
  const sidebar = page.getByTestId('code-sidebar')
  const sidebarBox = await sidebar.boundingBox()
  const resizerBox = await page.getByTestId('code-sidebar-resizer').boundingBox()
  if (!sidebarBox || !resizerBox) throw new Error('Sidebar resize handles are unavailable')

  const pointerY = resizerBox.y + Math.min(120, resizerBox.height / 2)
  await page.mouse.move(resizerBox.x + resizerBox.width / 2, pointerY)
  await page.mouse.down()
  await page.mouse.move(sidebarBox.x + width, pointerY)
  await page.mouse.up()
  await expect.poll(async () => Math.round((await sidebar.boundingBox())?.width ?? 0)).toBe(width)
}


test('keeps an unfinished Composer submission locked across file navigation', { tag: ['@critical-behavior', '@behavior-CODE-COMPOSER-SUBMISSION-OWNERSHIP'] }, async ({ page, workspaceRoot }) => {
  const workspace = path.join(workspaceRoot, 'submission-owner')
  fs.mkdirSync(workspace, { recursive: true })
  fs.writeFileSync(path.join(workspace, 'notes.md'), '# Notes\n')
  const response = await page.request.post('/farming/api/control/agents', { data: { command: 'codex', workspace, agentRuntimeMode: 'chat' } })
  const { agentId } = await response.json() as { agentId: string }
  let releaseSubmission: (() => void) | null = null
  await page.routeWebSocket(/\/farming\/ws(?:\?|$)/, socket => {
    const server = socket.connectToServer()
    socket.onMessage(message => {
      const parsed = JSON.parse(String(message)) as { type?: string }
      if (parsed.type === 'composer-input' && !releaseSubmission) {
        releaseSubmission = () => server.send(message)
        return
      }
      server.send(message)
    })
    server.onMessage(message => socket.send(message))
  })
  await openFarming(page)
  await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
  const input = page.getByTestId('code-acp-composer-input')
  await input.fill('PERSIST_SUBMISSION_OWNER')
  await page.getByTestId('code-acp-composer-send').click()
  await expect(page.getByTestId('code-acp-composer-send')).toBeDisabled()

  const project = page.getByTestId('code-project-group').filter({ hasText: 'submission-owner' })
  const files = project.getByTestId('code-files-section')
  if (await files.locator('.code-files-title').getAttribute('aria-expanded') !== 'true') await files.locator('.code-files-title').click()
  await files.locator('[data-file-path="notes.md"]').dblclick()
  await expect(page.getByTestId('code-file-editor')).toBeVisible()
  await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()

  await expect(page.getByTestId('code-acp-composer-send')).toBeDisabled()
  await expect(page.getByTestId('code-acp-composer-send')).toHaveAttribute('aria-busy', 'true')
  await expect(input).toHaveValue('PERSIST_SUBMISSION_OWNER')
  expect(releaseSubmission).not.toBeNull()
  releaseSubmission?.()
  await expect(page.getByTestId('code-acp-composer-send')).toBeEnabled()
  await expect(input).toHaveValue('')
})


test('quotes spreadsheet and side-chat results without losing drafts or sending automatically', { tag: ['@critical-behavior', '@behavior-CODE-RELATED-WORKFLOWS', '@iphone-human'] }, async ({ page, workspaceRoot, isMobile }, testInfo) => {
  const workspace = path.join(workspaceRoot, 'quoted-data')
  fs.mkdirSync(workspace, { recursive: true })
  fs.writeFileSync(path.join(workspace, 'data.csv'), 'id,amount\n00123,42\n00456,99\n')
  await page.request.post('/farming/api/settings', { data: { language: 'en' } })
  const response = await page.request.post('/farming/api/control/agents', { data: { command: 'codex', workspace, agentRuntimeMode: 'chat' } })
  expect(response.ok()).toBeTruthy()
  const { agentId } = await response.json() as { agentId: string }
  await openFarming(page)
  const openSidebar = async () => { if (isMobile) await page.getByTestId('code-mobile-menu').click() }
  await openSidebar()
  await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
  const parentInput = page.locator('.code-composer-shell').getByTestId('code-acp-composer-input')
  await expect(parentInput).toBeEditable()
  await parentInput.fill('image attachment parent context')
  await page.getByTestId('code-acp-composer-send').click()
  await expect(page.getByTestId('code-acp-composer-send')).toBeDisabled()
  await parentInput.fill('Keep my parent draft')
  await openSidebar()
  const project = page.getByTestId('code-project-group').filter({ hasText: 'quoted-data' })
  const files = project.getByTestId('code-files-section')
  if (await files.locator('.code-files-title').getAttribute('aria-expanded') !== 'true') await files.locator('.code-files-title').click()
  await files.locator('[data-file-path="data.csv"]').dblclick()
  const spreadsheet = page.getByTestId('code-spreadsheet-preview')
  await expect(spreadsheet).toBeVisible()
  const address = spreadsheet.getByRole('textbox', { name: 'Cell address' })
  await address.fill('A2')
  await address.press('Enter')
  await expect(spreadsheet.locator('.code-spreadsheet-inspector span')).toHaveText('00123')
  await expect(spreadsheet.getByRole('link', { name: 'Download original' })).toHaveCount(0)
  await page.evaluate(() => Object.defineProperty(navigator.clipboard, 'writeText', {
    configurable: true, value: () => Promise.reject(new Error('Clipboard denied')),
  }))
  await page.evaluate(() => Object.defineProperty(document, 'execCommand', { configurable: true, value: () => false }))
  await spreadsheet.getByRole('button', { name: 'Copy selection', exact: true }).click()
  await expect(spreadsheet.getByRole('textbox', { name: 'Copy selection' })).toHaveValue('00123')
  for (const appearance of ['light', 'dark', 'paper']) {
    await page.locator('body').evaluate((element, value) => { element.dataset.appearance = value }, appearance)
    await page.screenshot({ path: testInfo.outputPath(`spreadsheet-quote-${appearance}.png`), animations: 'disabled' })
  }
  await spreadsheet.getByRole('button', { name: 'Quote in chat', exact: true }).click()
  await expect(parentInput).toBeVisible()
  await expect(parentInput).toHaveValue(/Keep my parent draft/)
  await expect(parentInput).toHaveValue(/Sheet:.*Sheet1/)
  await expect(parentInput).toHaveValue(/Range: A2:A2/)
  await expect(parentInput).toHaveValue(/SHA-1: [a-f0-9]{40}/)
  await expect(parentInput).toHaveValue(/00123/)
  await expect(parentInput).toBeFocused()
  const preserved = await parentInput.inputValue()
  await parentInput.fill('/side')
  const opened = page.waitForResponse(res => res.url().endsWith(`/agents/${agentId}/subagent`))
  await page.getByTestId('code-acp-composer-send').click()
  expect((await (await opened).json()).error).toBeFalsy()
  const pane = page.getByTestId('code-subagent-panel')
  await expect(pane).toBeVisible()
  if (!isMobile) {
    const parentRow = page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
    const childRow = page.locator('[data-testid="code-agent-row"].related-child')
    await expect(childRow).toBeVisible()
    await parentRow.hover()
    const visibility = parentRow.getByTestId('code-agent-row-related-visibility')
    await visibility.click()
    await expect(childRow).toBeHidden()
    await expect(pane).toBeVisible()
    await visibility.click()
    await expect(childRow).toBeVisible()
  }
  if (isMobile) await page.getByRole('button', { name: 'Parent', exact: true }).click()
  await parentInput.fill(preserved)
  if (isMobile) await page.getByRole('navigation', { name: 'Related sessions' }).getByRole('button', { name: 'Subagent', exact: true }).click()
  const childInput = pane.getByTestId('code-acp-composer-input')
  await childInput.fill('image attachment result for parent')
  await pane.getByTestId('code-acp-composer-send').click()
  await expect(pane).toContainText('Received 0 image.')
  await childInput.fill('Keep my child draft')
  const answer = pane.locator('.code-agent-transcript-assistant').last()
  await answer.evaluate(element => {
    const range = document.createRange()
    range.selectNodeContents(element)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
  })
  await page.getByTestId('code-agent-transcript-selection-actions').getByRole('button', { name: 'Quote in parent chat' }).click()
  await expect(parentInput).toBeVisible()
  await expect(parentInput).toHaveValue(/Keep my parent draft/)
  await expect(parentInput).toHaveValue(/Source: Subagent/)
  await expect(parentInput).toHaveValue(/Received 0 image/)
  for (const appearance of ['light', 'dark', 'paper']) {
    await page.locator('body').evaluate((element, value) => { element.dataset.appearance = value }, appearance)
    await page.screenshot({ path: testInfo.outputPath(`parent-quote-${appearance}.png`), animations: 'disabled' })
  }
  if (isMobile) await page.getByRole('navigation', { name: 'Related sessions' }).getByRole('button', { name: 'Subagent', exact: true }).click()
  await expect(childInput).toHaveValue('Keep my child draft')
})

test('keeps active children visible and pages past 200 historical turns', { tag: ['@critical-behavior', '@behavior-CODE-RELATED-WORKFLOWS', '@iphone-human'] }, async ({ page, workspaceRoot, isMobile }, testInfo) => {
  const workspace = path.join(workspaceRoot, 'related-history')
  fs.mkdirSync(workspace, { recursive: true })
  await page.request.post('/farming/api/settings', { data: { language: 'en' } })
  const response = await page.request.post('/farming/api/control/agents', { data: { command: 'codex', workspace, agentRuntimeMode: 'chat' } })
  const { agentId } = await response.json() as { agentId: string }
  await openFarming(page)
  if (isMobile) await page.getByTestId('code-mobile-menu').click()
  await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
  const input = page.getByTestId('code-acp-composer-input')
  await expect(input).toBeEditable()
  await input.fill('related workflow demo')
  await page.getByTestId('code-acp-composer-send').click()
  await expect(page.getByTestId('code-agent-chat-view')).toContainText('Review group ready.')
  if (isMobile) await page.getByTestId('code-mobile-menu').click()
  const rows = page.getByTestId('code-native-related-row')
  await expect(rows.filter({ hasText: 'Review 12' }).locator('.code-agent-dot')).toHaveClass(/turn-active/)
  await expect(rows.filter({ hasText: 'Review 12' })).toHaveAttribute('aria-label', /In progress/)
  await expect(rows.filter({ hasText: 'Review 13' }).getByTestId('code-agent-chat-failure')).toBeVisible()
  await expect(rows.filter({ hasText: 'Review 0' })).toBeHidden()
  const finished = page.getByTestId('code-native-related-finished')
  await expect(finished.locator('summary')).toHaveText('Finished · 12')
  for (const appearance of ['light', 'dark', 'paper']) {
    await page.locator('body').evaluate((element, value) => { element.dataset.appearance = value }, appearance)
    await page.screenshot({ path: testInfo.outputPath(`related-status-${appearance}.png`), animations: 'disabled' })
  }
  await finished.locator('summary').click()
  await expect(finished.getByTestId('code-native-related-row')).toHaveCount(6)
  await finished.getByRole('button', { name: 'Show more' }).click()
  await expect(finished.getByTestId('code-native-related-row')).toHaveCount(12)
  await rows.filter({ hasText: 'Review 0' }).click()
  const panel = page.getByTestId('code-related-session-panel')
  await expect(panel).toContainText('Answer 259')
  for (let pageNumber = 0; pageNumber < 10; pageNumber++) {
    await panel.getByRole('button', { name: 'Load earlier messages' }).click()
    await expect(panel).toContainText(`Answer ${259 - (pageNumber + 1) * 24}`)
  }
  await expect(panel).toContainText('Question 0')
  await expect(panel.getByRole('button', { name: 'Load earlier messages' })).toHaveCount(0)
  await panel.getByRole('button', { name: 'Return to latest' }).click()
  await expect(panel).toContainText('Answer 259')
  await expect(panel).not.toContainText('Question 0')
})


test('streams a side-chat reply while the parent stays selected', async ({ page, workspaceRoot }, testInfo) => {
  let watchedAgentIds: string[] = []
  let watchMessages = 0
  let disconnect: (() => Promise<void>) | null = null
  await page.routeWebSocket(/\/farming\/ws(?:\?|$)/, socket => {
    const server = socket.connectToServer()
    socket.onMessage(payload => {
      const message = JSON.parse(String(payload)) as { type?: string; agentIds?: string[] }
      if (message.type === 'watch-acp-transcripts') {
        watchedAgentIds = message.agentIds || []
        watchMessages++
      }
      server.send(payload)
    })
    disconnect = async () => {
      await Promise.all([
        socket.close({ code: 1012, reason: 'side-pane reconnect test' }),
        server.close({ code: 1012, reason: 'side-pane reconnect test' }),
      ])
    }
  })
  const workspace = path.join(workspaceRoot, 'side-chat-live-reply')
  fs.mkdirSync(workspace, { recursive: true })
  await page.request.post('/farming/api/settings', { data: { language: 'en' } })
  const response = await page.request.post('/farming/api/control/agents', {
    data: { command: 'codex', workspace, agentRuntimeMode: 'chat' },
  })
  expect(response.ok()).toBeTruthy()
  const { agentId } = await response.json() as { agentId: string }
  await openFarming(page)
  await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
  const parentInput = page.locator('.code-composer-shell').getByTestId('code-acp-composer-input')
  await expect(parentInput).toBeEditable()
  await parentInput.fill('image attachment parent context')
  await page.getByTestId('code-acp-composer-send').click()
  await expect(page.getByTestId('code-agent-chat-view')).toContainText('Received 0 image.')
  await parentInput.fill('/side')
  const opened = page.waitForResponse(res => res.url().endsWith(`/agents/${agentId}/subagent`))
  await page.getByTestId('code-acp-composer-send').click()
  expect((await (await opened).json()).error).toBeFalsy()
  const pane = page.getByTestId('code-subagent-panel')
  const childInput = pane.getByTestId('code-acp-composer-input')
  await expect(childInput).toBeEditable()
  await expect(pane).toContainText('Continued from original Agent')
  const inventory = await (await page.request.get('/farming/api/control/agents')).json() as {
    agents: Array<{ id: string; subagentParentSessionKey?: string }>
  }
  const child = inventory.agents.find(agent => agent.subagentParentSessionKey)
  expect(child).toBeDefined()
  await expect.poll(() => watchedAgentIds).toContain(child!.id)
  await childInput.fill('progressive answer stream')
  await pane.getByTestId('code-acp-composer-send').click()
  await expect(pane).toContainText('Visible segment 10 stays continuous')
  await expect(pane.getByTestId('code-acp-composer-send')).toBeDisabled()
  await parentInput.fill('Retain the parent draft')
  await childInput.fill('Retain the child draft')
  const parentRow = page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
  const childRow = page.locator(`[data-testid="code-agent-row"][data-agent-id="${child!.id}"]`)
  await expect(childRow.locator('.code-agent-row-provider-icon')).toHaveCount(0)
  const childIcon = childRow.locator('.code-collaboration-agent-icon')
  const headerIcon = pane.locator('.code-related-session-header .code-collaboration-agent-icon')
  await expect(childIcon).toHaveCount(1)
  expect(await childIcon.locator('svg').innerHTML()).toBe(await headerIcon.locator('svg').innerHTML())
  for (const sidebarWidth of [296, 420]) {
    await resizeSidebar(page, sidebarWidth)
    const parentLabel = await parentRow.locator('.code-agent-name').boundingBox()
    const childLabel = await childRow.locator('.code-agent-name').boundingBox()
    expect(childLabel!.x - parentLabel!.x).toBe(20)
    for (const appearance of ['light', 'dark', 'paper']) {
      await page.locator('body').evaluate((element, value) => { element.dataset.appearance = value }, appearance)
      expect(await childIcon.evaluate(element => getComputedStyle(element).color)).toBe(
        await headerIcon.evaluate(element => getComputedStyle(element).color),
      )
      await page.screenshot({ path: testInfo.outputPath(`side-chat-sidebar-${sidebarWidth}-${appearance}.png`), animations: 'disabled' })
    }
  }
  await resizeSidebar(page, 296)
  for (const appearance of ['light', 'dark', 'paper']) {
    await page.locator('body').evaluate((element, value) => { element.dataset.appearance = value }, appearance)
    await parentRow.click()
    await expect(pane).toHaveCount(0)
    await expect.poll(() => watchedAgentIds).not.toContain(child!.id)
    await expect(parentRow).toHaveClass(/\bactive\b/)
    await expect(parentInput).toHaveValue('Retain the parent draft')
    await expect(page.locator('.code-related-session-resizer')).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath(`parent-only-${appearance}.png`), animations: 'disabled' })
    await childRow.click()
    await expect(pane).toContainText('Visible segment 10 stays continuous')
    await expect(childRow).toHaveClass(/\bactive\b/)
    await expect(childInput).toHaveValue('Retain the child draft')
    await expect.poll(() => watchedAgentIds).toContain(child!.id)
  }
  for (const appearance of ['light', 'dark', 'paper']) {
    await page.locator('body').evaluate((element, value) => { element.dataset.appearance = value }, appearance)
    await page.screenshot({ path: testInfo.outputPath(`side-chat-live-${appearance}.png`), animations: 'disabled' })
  }
  const previousWatchMessages = watchMessages
  expect(disconnect).not.toBeNull()
  await disconnect!()
  await expect.poll(() => watchMessages).toBeGreaterThan(previousWatchMessages)
  await expect.poll(() => watchedAgentIds).toContain(child!.id)
  await expect(pane.locator('.code-agent-transcript-user').filter({ hasText: 'progressive answer stream' })).toHaveCount(1)
  await expect(childInput).toHaveValue('Retain the child draft')
})

test('reopens the same archived side chat with a live child row', async ({ page, workspaceRoot }, testInfo) => {
  const workspace = path.join(workspaceRoot, 'reopen-side-chat')
  fs.mkdirSync(workspace, { recursive: true })
  const fixtureHome = path.join(workspaceRoot, 'side-chat-provider-home')
  fs.mkdirSync(fixtureHome, { recursive: true })
  const settings = await (await page.request.get('/farming/api/settings')).json()
  const configured = await page.request.post('/farming/api/settings', { data: {
    language: 'en', agentLaunchProfiles: { ...settings.settings.agentLaunchProfiles, codex: {
      ...settings.settings.agentLaunchProfiles.codex, homeId: 'side-chat-test',
    } }, agentHomes: { ...settings.settings.agentHomes, codex: [
      ...settings.settings.agentHomes.codex,
      { id: 'side-chat-test', name: 'Side chat test', path: fixtureHome },
    ] },
  } })
  expect(configured.ok()).toBeTruthy()
  const created = await page.request.post('/farming/api/control/agents', {
    data: { command: 'codex', workspace, agentRuntimeMode: 'chat' },
  })
  expect(created.ok()).toBeTruthy()
  const { agentId } = await created.json() as { agentId: string }
  await openFarming(page)
  const parentRow = page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
  await parentRow.click()
  const input = page.locator('.code-composer-shell').getByTestId('code-acp-composer-input')
  await input.fill('image attachment parent context')
  await page.getByTestId('code-acp-composer-send').click()
  await expect(page.getByTestId('code-agent-chat-view')).toContainText('Received 0 image.')
  await input.fill('/side')
  const opened = page.waitForResponse(response => response.url().endsWith(`/agents/${agentId}/subagent`))
  await page.getByTestId('code-acp-composer-send').click()
  const first = await (await opened).json() as { agentId: string; providerSessionId: string; providerSessionKey: string }
  const pane = page.getByTestId('code-subagent-panel')
  await expect(pane.getByTestId('code-acp-composer-input')).toBeEditable()
  const inventory = await (await page.request.get('/farming/api/control/agents')).json() as {
    agents: Array<{ id: string; providerHomePath: string }>
  }
  const home = inventory.agents.find(agent => agent.id === first.agentId)!.providerHomePath
  // Give the fake provider a durable history file for the real resume coordinator.
  expect(home).toBe(fixtureHome)
  const history = path.join(home, 'sessions', `rollout-${first.providerSessionId}.jsonl`)
  const archived = path.join(home, 'archived_sessions', path.basename(history))
  fs.mkdirSync(path.dirname(history), { recursive: true })
  fs.mkdirSync(path.dirname(archived), { recursive: true })
  try {
    fs.writeFileSync(history, JSON.stringify({ type: 'session_meta', payload: {
      id: first.providerSessionId, cwd: workspace, timestamp: new Date().toISOString(),
    } }) + '\n', { flag: 'wx' })
    const archive = await page.request.patch(`/farming/api/agents/${first.agentId}`, { data: { archived: true } })
    expect(archive.ok()).toBeTruthy()
    await parentRow.click()
    await expect(pane).toHaveCount(0)
    // The fake ACP archive acknowledges lifecycle without moving provider files.
    if (fs.existsSync(history)) fs.renameSync(history, archived)
    await parentRow.click()
    await input.fill('/side')
    const reopening = page.waitForResponse(response => response.url().endsWith(`/agents/${agentId}/subagent`))
    await page.getByTestId('code-acp-composer-send').click()
    const reply = await reopening
    const reopened = await reply.json() as { error?: string; agentId: string; providerSessionKey: string }
    expect(reopened.error).toBeFalsy()
    expect(reply.ok()).toBeTruthy()
    expect(reopened.providerSessionKey).toBe(first.providerSessionKey)
    expect(reopened.agentId).not.toBe(first.agentId)
    await expect(pane.getByTestId('code-acp-composer-input')).toBeEditable()
    await expect(page.locator(`[data-testid="code-agent-row"][data-agent-id="${reopened.agentId}"]`)).toBeVisible()
    await expect(pane).not.toContainText('Subagent state has not synchronized.')
    await pane.getByTestId('code-acp-composer-input').fill('image attachment resumed reply')
    await pane.getByTestId('code-acp-composer-send').click()
    await expect(pane).toContainText('Received 0 image.')
    for (const appearance of ['light', 'dark', 'paper']) {
      await page.locator('body').evaluate((body, value) => { body.dataset.appearance = value }, appearance)
      await page.screenshot({ path: testInfo.outputPath(`reopened-side-chat-${appearance}.png`), animations: 'disabled' })
    }
  } finally {
    for (const file of [history, archived]) if (fs.existsSync(file)) fs.unlinkSync(file)
  }
})
