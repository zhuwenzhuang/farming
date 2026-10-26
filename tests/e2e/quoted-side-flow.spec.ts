import { expect, openFarming, test } from './fixtures'
import type { Page } from '@playwright/test'
import { expectValue, selection } from './composer-test-input'

async function setup(page: Page, workspace: string, appearance = 'paper') {
  await page.request.post('/farming/api/settings', { data: { appearance, language: 'en' } })
  await page.setViewportSize({ width: 1600, height: 1000 })
  const response = await page.request.post('/farming/api/control/agents', { data: { command: 'codex', workspace, agentRuntimeMode: 'chat' } })
  const { agentId } = await response.json() as { agentId: string }
  await openFarming(page)
  await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
  return agentId
}
async function selectAnswer(page: Page) {
  const answer = page.locator('.code-terminal-grid .code-agent-transcript-assistant').last()
  await expect(answer).toBeVisible()
  return answer.evaluate(element => {
    const selection = window.getSelection(); const range = document.createRange()
    range.selectNodeContents(element); selection?.removeAllRanges(); selection?.addRange(range)
    document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
    return selection?.toString().trim() || ''
  })
}
for (const appearance of ['light', 'dark', 'paper']) {
  test(`quoting a side answer preserves the parent draft and focuses its end in ${appearance}`, async ({ page, workspaceRoot }, testInfo) => {
    await setup(page, workspaceRoot, appearance)
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    const main = page.locator('.code-composer-shell')
    const input = main.getByTestId('code-acp-composer-input')
    await input.fill('/side')
    await main.getByTestId('code-acp-composer-send').click()
    const side = page.getByTestId('code-subagent-panel')
    await side.getByTestId('code-acp-composer-input').fill('markdown image response')
    await side.getByTestId('code-acp-composer-send').click()
    await side.getByRole('button', { name: 'Allow', exact: true }).click()
    const answer = side.locator('.code-agent-transcript-assistant').last()
    await expect(answer).toBeVisible()
    await input.fill('Parent draft')
    await answer.click()
    const quote = await answer.evaluate(element => {
      const range = document.createRange(); range.selectNodeContents(element)
      const selection = getSelection(); selection?.removeAllRanges(); selection?.addRange(range)
      document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
      return selection?.toString().trim() || ''
    })
    expect(quote).not.toBe('')
    await page.getByRole('button', { name: 'Quote in parent chat', exact: true }).click()
    await expect(input).toBeFocused()
    await expectValue(input, 'Parent draft')
    expect(await selection(input)).toEqual([12, 12])
    await expect(main.getByTestId('code-composer-quote')).toContainText(quote.split('\n')[0])
    await page.keyboard.insertText(' + follow-up')
    await expectValue(input, 'Parent draft + follow-up')
    expect(errors).toEqual([])
    await main.screenshot({ path: testInfo.outputPath(`quote-parent-${appearance}.png`), animations: 'disabled' })
  })

  test(`quoted side preparation, history and Goal geometry in ${appearance}`, async ({ page, workspaceRoot }, testInfo) => {
    test.setTimeout(120_000)
    const parentId = await setup(page, workspaceRoot, appearance)
    const main = page.locator('.code-composer-shell')
    await main.getByTestId('code-acp-composer-input').fill('markdown image response\nUse compiler optimization and buffered writes. Preserve the selected text as context, including all details.\n\nThis is a longer second paragraph that remains readable when expanded without filling the question bubble.')
    await main.getByTestId('code-acp-composer-send').click()
    await expect(main.getByTestId('code-acp-composer-send')).toBeDisabled()
    const quote = await selectAnswer(page)
    expect(quote).not.toBe('')
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    let requests = 0
    await page.route(`**/api/agents/${parentId}/subagent`, async route => { requests++; await held; await route.continue() })
    const clickedAt = Date.now()
    await page.getByRole('button', { name: 'Ask in subagent', exact: true }).click()
    const pane = page.getByTestId('code-subagent-panel')
    await expect(pane).toBeVisible({ timeout: 1000 })
    expect(Date.now() - clickedAt).toBeLessThan(1000)
    const preparation = pane.getByTestId('code-subagent-preparation-input')
    await expect(pane.getByTestId('code-composer-quote')).toContainText(quote.split('\n')[0])
    await preparation.fill('image attachment: explain selected passage')
    await main.getByTestId('code-acp-composer-input').fill('Parent draft')
    await preparation.focus()
    expect(requests).toBe(1)
    const opened = page.waitForResponse(response => response.url().endsWith(`/agents/${parentId}/subagent`))
    release()
    const child = await (await opened).json() as { agentId: string }
    const input = pane.getByTestId('code-acp-composer-input')
    await expect(input).toHaveText('image attachment: explain selected passage')
    await expect(input).toBeFocused()
    await pane.getByTestId('code-acp-composer-send').click()
    const quoted = pane.getByTestId('code-user-quoted-context')
    await expect(quoted).toHaveCount(1)
    await expect(quoted.locator('details')).not.toHaveAttribute('open', '')
    await expect(quoted).not.toContainText('Referenced context:')
    await quoted.locator('summary').click()
    await expect(quoted.locator('pre')).toHaveText(quote)
    await quoted.locator('summary').click()
    await expect(main.getByTestId('code-acp-composer-input')).toHaveText('Parent draft')
    await page.reload()
    await page.locator(`[data-testid="code-agent-row"][data-agent-id="${child.agentId}"]`).click()
    await expect(quoted).toHaveCount(1)
    await input.focus(); await page.keyboard.press('ArrowUp')
    await expect(input).toHaveText('image attachment: explain selected passage')
    await expect(pane.getByTestId('code-composer-quote')).toContainText(quote.split('\n')[0])
    await pane.getByTestId('code-composer-quote').getByRole('button', { name: 'Remove Quoted text' }).click()
    await input.fill('goal cancellation fixture'); await pane.getByTestId('code-acp-composer-send').click()
    const goal = pane.getByTestId('code-agent-goal-driver')
    await expect(goal).toBeVisible()
    const goalBox = (await goal.boundingBox())!
    const editorBox = (await input.boundingBox())!
    expect(goalBox.y + goalBox.height).toBeLessThanOrEqual(editorBox.y)
    expect(goalBox.x).toBeGreaterThanOrEqual((await pane.boundingBox())!.x)
    await page.screenshot({ path: testInfo.outputPath(`side-quote-goal-${appearance}.png`), animations: 'disabled' })
    await pane.getByTestId('code-acp-composer-send').click()
    await expect(pane.getByTestId('code-acp-composer-send')).not.toHaveAttribute('data-action', 'interrupt')
    await main.getByTestId('code-acp-composer-input').fill('goal cancellation fixture')
    await main.getByTestId('code-acp-composer-send').click()
    const parentGoal = page.locator('.code-main > .code-agent-activity-dock').getByTestId('code-agent-goal-driver')
    await expect(parentGoal).toBeVisible()
    const parentGoalBox = (await parentGoal.boundingBox())!
    expect(parentGoalBox.y + parentGoalBox.height).toBeLessThanOrEqual((await main.boundingBox())!.y)
    await page.screenshot({ path: testInfo.outputPath(`both-goals-${appearance}.png`), animations: 'disabled' })
    await page.setViewportSize({ width: 650, height: 900 })
    await expect(goal).toBeVisible()
    const compactGoal = (await goal.boundingBox())!
    const compactInput = (await input.boundingBox())!
    expect(compactGoal.y + compactGoal.height).toBeLessThanOrEqual(compactInput.y)
    expect(compactInput.y + compactInput.height).toBeLessThanOrEqual(900)
    await page.screenshot({ path: testInfo.outputPath(`compact-goal-${appearance}.png`), animations: 'disabled' })
    await page.getByRole('navigation', { name: 'Related sessions' }).getByRole('button', { name: 'Parent', exact: true }).click()
    await expect(parentGoal).toBeVisible()
    const compactParentGoal = (await parentGoal.boundingBox())!
    expect(compactParentGoal.y + compactParentGoal.height).toBeLessThanOrEqual((await main.boundingBox())!.y)
  })
}

test('closing preparation does not reopen the pane and request reconciliation is idempotent', async ({ page, workspaceRoot }) => {
  const parentId = await setup(page, workspaceRoot)
  const main = page.locator('.code-composer-shell')
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  let requestId = ''
  await page.route(`**/api/agents/${parentId}/subagent`, async route => { requestId = route.request().postDataJSON().requestId; await held; await route.continue() })
  await main.getByTestId('code-acp-composer-input').fill('/side'); await main.getByTestId('code-acp-composer-send').click()
  const pane = page.getByTestId('code-subagent-panel')
  await pane.getByTestId('code-subagent-preparation-input').fill('Draft retained while closed')
  await pane.getByRole('button', { name: 'Collapse related session' }).click()
  const response = page.waitForResponse(value => value.url().endsWith(`/agents/${parentId}/subagent`))
  release(); const child = await (await response).json() as { agentId: string }
  await expect(pane).toHaveCount(0)
  const reconciled = await page.request.post(`/farming/api/agents/${parentId}/subagent`, { data: { requestId } })
  expect((await reconciled.json()).agentId).toBe(child.agentId)
  await page.locator(`[data-testid="code-agent-row"][data-agent-id="${child.agentId}"]`).click()
  await expect(pane.getByTestId('code-acp-composer-input')).toHaveText('Draft retained while closed')
})

test('uncertain preparation keeps the draft and reconciles the same request after reload', async ({ page, workspaceRoot }) => {
  const parentId = await setup(page, workspaceRoot)
  const main = page.locator('.code-composer-shell')
  let firstRequestId = ''
  await page.route(`**/api/agents/${parentId}/subagent`, async route => {
    firstRequestId = route.request().postDataJSON().requestId
    await route.fulfill({ status: 409, json: { error: 'Creation outcome is unknown', uncertain: true } })
  }, { times: 1 })
  await main.getByTestId('code-acp-composer-input').fill('/side'); await main.getByTestId('code-acp-composer-send').click()
  const pane = page.getByTestId('code-subagent-panel')
  await expect(pane.getByRole('alert')).toContainText('Creation outcome is unknown')
  await pane.getByTestId('code-subagent-preparation-input').fill('Do not lose this question')
  await page.reload()
  let nextRequestId = ''
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  await page.route(`**/api/agents/${parentId}/subagent`, async route => { nextRequestId = route.request().postDataJSON().requestId; await held; await route.continue() })
  await main.getByTestId('code-acp-composer-input').fill('/side'); await main.getByTestId('code-acp-composer-send').click()
  try {
    await expect(pane.getByTestId('code-subagent-preparation-input')).toHaveText('Do not lose this question')
    await expect.poll(() => nextRequestId).toBe(firstRequestId)
  } finally { release() }
  await expect(pane.getByTestId('code-acp-composer-input')).toHaveText('Do not lose this question')
})

test('definite preparation rejection preserves the question and retries with a fresh identity', async ({ page, workspaceRoot }) => {
  const parentId = await setup(page, workspaceRoot)
  const main = page.locator('.code-composer-shell')
  let rejectedId = ''
  await page.route(`**/api/agents/${parentId}/subagent`, async route => {
    rejectedId = route.request().postDataJSON().requestId
    await route.fulfill({ status: 409, json: { error: 'Preparation rejected before creation', uncertain: false } })
  }, { times: 1 })
  await main.getByTestId('code-acp-composer-input').fill('/side'); await main.getByTestId('code-acp-composer-send').click()
  const pane = page.getByTestId('code-subagent-panel')
  await expect(pane.getByRole('alert')).toContainText('Preparation rejected before creation')
  await pane.getByTestId('code-subagent-preparation-input').fill('Keep this after rejection')
  const retry = page.waitForRequest(request => request.url().endsWith(`/agents/${parentId}/subagent`))
  await pane.getByRole('button', { name: 'Retry', exact: true }).click()
  expect((await retry).postDataJSON().requestId).not.toBe(rejectedId)
  await expect(pane.getByTestId('code-acp-composer-input')).toHaveText('Keep this after rejection')
})
