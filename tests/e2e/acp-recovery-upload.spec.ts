import fs from 'node:fs'
import path from 'node:path'
import { expect, openFarming, test } from './fixtures'

async function createCodexChat(page: import('@playwright/test').Page, workspace: string) {
  fs.mkdirSync(workspace, { recursive: true })
  const response = await page.request.post('/farming/api/control/agents', {
    data: { command: 'codex', workspace, agentRuntimeMode: 'chat' },
  })
  expect(response.ok()).toBeTruthy()
  const { agentId } = await response.json() as { agentId: string }
  return agentId
}

test('keeps a fresh Chat in its empty state when the startup transcript read fails', async ({ page, workspaceRoot }) => {
  const agentId = await createCodexChat(page, path.join(workspaceRoot, 'acp-fresh-empty-read-failure'))
  let transcriptRequests = 0
  const transcriptRoute = new RegExp(`/farming/api/agents/${agentId}/acp-transcript(?:\\?.*)?$`)
  await page.route(transcriptRoute, async route => {
    transcriptRequests += 1
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'startup fixture unavailable' }) })
  })

  await openFarming(page)
  await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
  await expect.poll(() => transcriptRequests).toBeGreaterThanOrEqual(1)
  await expect(page.locator('.code-agent-transcript-blank')).toHaveText('No conversation yet.')
  await expect(page.getByText('Chat history is unavailable for this session.', { exact: true })).toHaveCount(0)

  await page.waitForTimeout(1_200)
  await expect(page.locator('.code-agent-transcript-blank')).toHaveText('No conversation yet.')
  await expect(page.getByText('Chat history is unavailable for this session.', { exact: true })).toHaveCount(0)
  await page.unroute(transcriptRoute)
})

test('retries an unsettled authoritative transcript when returning to and refreshing an existing Chat', async ({ page, workspaceRoot }) => {
  const agentId = await createCodexChat(page, path.join(workspaceRoot, 'acp-existing-chat-recovery'))
  const emptyAgentId = await createCodexChat(page, path.join(workspaceRoot, 'acp-existing-chat-recovery-empty'))
  await openFarming(page)
  const agentRow = page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
  await agentRow.click()

  const input = page.getByTestId('code-acp-composer-input')
  await input.fill('rich timeline')
  await page.getByTestId('code-acp-composer-send').click()
  await expect(page.getByText('Rich ACP timeline complete.', { exact: true })).toBeVisible({ timeout: 20_000 })

  await page.locator(`[data-testid="code-agent-row"][data-agent-id="${emptyAgentId}"]`).click()
  await expect(page.locator('.code-agent-transcript-blank')).toHaveText('No conversation yet.')

  let transcriptRequests = 0
  let releaseSettledTranscript: (() => void) | null = null
  const settledTranscriptGate = new Promise<void>(resolve => {
    releaseSettledTranscript = resolve
  })
  await page.route(new RegExp(`/farming/api/agents/${agentId}/acp-transcript(?:\\?.*)?$`), async route => {
    transcriptRequests += 1
    if (transcriptRequests === 1) {
      const response = await route.fetch()
      const payload = await response.json() as Record<string, unknown>
      await route.fulfill({
        response,
        contentType: 'application/json',
        body: JSON.stringify({ ...payload, settled: false }),
      })
      return
    }
    await settledTranscriptGate
    await route.continue()
  })

  const restoreStartedAt = Date.now()
  await agentRow.click()
  await expect(page.getByText('Rich ACP timeline complete.', { exact: true })).toBeVisible({ timeout: 1_000 })
  const unsettledTranscriptVisibleMs = Date.now() - restoreStartedAt
  expect(unsettledTranscriptVisibleMs).toBeLessThan(1_000)
  await expect(page.locator('.code-agent-transcript-state.subtle')).toHaveCount(0)
  await expect(page.locator('.code-agent-transcript-blank')).toHaveCount(0)
  releaseSettledTranscript?.()
  await expect.poll(() => transcriptRequests).toBeGreaterThanOrEqual(2)
  expect(transcriptRequests).toBeGreaterThanOrEqual(2)
  test.info().annotations.push({
    type: 'performance-budget',
    description: `unsettled-transcript-visible=${unsettledTranscriptVisibleMs}ms`,
  })

  await page.unroute(new RegExp(`/farming/api/agents/${agentId}/acp-transcript(?:\\?.*)?$`))
  await page.reload()
  await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
  await expect(page.getByText('Rich ACP timeline complete.', { exact: true })).toBeVisible({ timeout: 10_000 })
  await expect(page.locator('.code-agent-transcript-blank')).toHaveCount(0)
})

test('settles a fast image upload, enables Send, and delivers the first media Prompt', async ({ page, workspaceRoot }) => {
  const workspace = path.join(workspaceRoot, 'acp-fast-image-upload')
  const agentId = await createCodexChat(page, workspace)
  const imagePath = path.join(workspace, 'fast-upload.png')
  fs.writeFileSync(
    imagePath,
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=', 'base64'),
  )

  await openFarming(page)
  await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
  const uploadStartedAt = Date.now()
  await page.getByTestId('code-acp-composer-file-input').setInputFiles(imagePath)
  const attachment = page.getByTestId('code-composer-attachment')
  await expect(attachment).toHaveClass(/ready/, { timeout: 3_000 })
  const uploadReadyMs = Date.now() - uploadStartedAt
  const send = page.getByTestId('code-acp-composer-send')
  await expect(send).toBeEnabled()
  await expect(send).toHaveAttribute('data-action', 'send')

  const input = page.getByTestId('code-acp-composer-input')
  await input.fill('inspect this uploaded image')
  const timings = await page.evaluate(async expected => {
    const composer = document.querySelector<HTMLTextAreaElement>('[data-testid="code-acp-composer-input"]')
    const sendButton = document.querySelector<HTMLButtonElement>('[data-testid="code-acp-composer-send"]')
    if (!composer || !sendButton) throw new Error('Composer controls unavailable')
    const startedAt = performance.now()
    sendButton.click()
    const result = { inputClearedMs: -1, userMessageVisibleMs: -1, agentResponseStartedMs: -1 }
    while (performance.now() - startedAt < 10_000) {
      const elapsed = performance.now() - startedAt
      if (result.inputClearedMs < 0 && composer.value === '') result.inputClearedMs = elapsed
      if (result.userMessageVisibleMs < 0 && [...document.querySelectorAll('.code-agent-transcript-user')].some(element => element.textContent?.includes(expected))) {
        result.userMessageVisibleMs = elapsed
      }
      if (result.agentResponseStartedMs < 0) {
        const processText = document.querySelector('[data-testid="code-agent-transcript-process-summary"]')?.textContent || ''
        const assistantAnswer = document.querySelector('.code-agent-transcript-assistant')?.textContent || ''
        const waitingPlaceholder = document.querySelector('.code-agent-transcript-placeholder')?.textContent || ''
        if (
          /Working for/.test(processText)
          || document.querySelector('[data-testid="code-agent-transcript-live-activity"]')
          || assistantAnswer.trim()
          || waitingPlaceholder.trim()
        ) {
          result.agentResponseStartedMs = elapsed
        }
      }
      if (Object.values(result).every(value => value >= 0)) return result
      await new Promise(resolve => requestAnimationFrame(resolve))
    }
    return result
  }, 'inspect this uploaded image')

  expect(timings.inputClearedMs).toBeGreaterThanOrEqual(0)
  expect(timings.userMessageVisibleMs).toBeGreaterThanOrEqual(0)
  expect(timings.agentResponseStartedMs).toBeGreaterThanOrEqual(0)
  await expect(page.getByTestId('code-composer-attachment')).toHaveCount(0)
  await expect(page.getByTestId('code-agent-transcript-user-images').locator('img')).toHaveCount(1)
  test.info().annotations.push({
    type: 'performance-budget',
    description: `upload-ready=${uploadReadyMs}ms input-cleared=${timings.inputClearedMs.toFixed(1)}ms user-visible=${timings.userMessageVisibleMs.toFixed(1)}ms agent-response-started=${timings.agentResponseStartedMs.toFixed(1)}ms`,
  })
})
