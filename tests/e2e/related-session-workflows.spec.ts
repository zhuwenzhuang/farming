import fs from 'node:fs'
import path from 'node:path'
import { expect, openFarming, test } from './fixtures'


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
