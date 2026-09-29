import fs from 'node:fs'
import path from 'node:path'
import { expect, openFarming, test } from './fixtures'

test('selection actions track visible text and quote context stays separate from the draft', async ({ page, workspaceRoot }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const workspace = path.join(workspaceRoot, 'quote-review')
  fs.mkdirSync(workspace, { recursive: true })
  await page.request.post('/farming/api/settings', { data: { language: 'en' } })
  const response = await page.request.post('/farming/api/control/agents', {
    data: { command: 'codex', workspace, agentRuntimeMode: 'chat' },
  })
  expect(response.ok()).toBeTruthy()
  const { agentId } = await response.json() as { agentId: string }
  await openFarming(page)
  await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
  const input = page.getByTestId('code-acp-composer-input')
  await input.fill('scroll stability')
  await page.getByTestId('code-acp-composer-send').click()
  await expect(page.getByText('Streaming tail 6:', { exact: false })).toBeVisible()
  await input.fill('Keep my question')
  const paragraph = page.locator('.code-agent-transcript-answer p').filter({ hasText: 'Reading paragraph 20:' })
  await paragraph.scrollIntoViewIfNeeded()
  const select = async () => {
    await paragraph.evaluate(element => {
      const range = document.createRange()
      range.selectNodeContents(element)
      window.getSelection()?.removeAllRanges()
      window.getSelection()?.addRange(range)
      document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
    })
  }
  await select()
  const toolbar = page.getByTestId('code-agent-transcript-selection-actions')
  const scroll = page.getByTestId('code-agent-transcript-scroll')
  await expect(toolbar).toBeVisible()
  const before = (await toolbar.boundingBox())!
  await scroll.evaluate(element => { element.scrollTop += 45 })
  await expect.poll(async () => Math.round((await toolbar.boundingBox())!.y - before.y)).toBe(-45)
  const selectedScrollTop = await scroll.evaluate(element => element.scrollTop)
  await scroll.evaluate(element => { element.scrollTop = element.scrollHeight })
  await expect(toolbar).toBeHidden()
  await scroll.evaluate((element, top) => { element.scrollTop = top }, selectedScrollTop)
  await expect(toolbar).toBeVisible()
  for (const appearance of ['light', 'dark', 'paper']) {
    await page.evaluate(value => {
      document.body.dataset.appearance = value
      document.documentElement.dataset.appearance = value
    }, appearance)
    expect(await toolbar.evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe(
      await scroll.evaluate(element => getComputedStyle(element).backgroundColor),
    )
    await page.screenshot({ path: testInfo.outputPath(`quote-toolbar-${appearance}.png`), animations: 'disabled' })
  }
  await page.setViewportSize({ width: 1250, height: 900 })
  await expect(toolbar).toBeVisible()
  const bounds = (await scroll.boundingBox())!
  const positioned = (await toolbar.boundingBox())!
  expect(positioned.x).toBeGreaterThanOrEqual(bounds.x)
  expect(positioned.x + positioned.width).toBeLessThanOrEqual(bounds.x + bounds.width)
  await toolbar.getByRole('button', { name: 'Quote in chat', exact: true }).click()
  await expect(input).toHaveValue('Keep my question')
  const quote = page.getByTestId('code-composer-quote')
  await expect(quote).toContainText('Reading paragraph 20:')
  await quote.locator('summary').click()
  await expect(quote.locator('pre')).toBeVisible()
  for (const appearance of ['light', 'dark', 'paper']) {
    await page.evaluate(value => { document.body.dataset.appearance = value }, appearance)
    await page.screenshot({ path: testInfo.outputPath(`quote-composer-${appearance}.png`), animations: 'disabled' })
  }
  await quote.getByRole('button', { name: 'Remove Quoted text' }).click()
  await expect(quote).toHaveCount(0)
  await expect(input).toHaveValue('Keep my question')
  await paragraph.scrollIntoViewIfNeeded()
  await select()
  await toolbar.getByRole('button', { name: 'Quote in chat', exact: true }).click()
  await page.getByTestId('code-acp-composer-send').click()
  await expect(input).toHaveValue('')
  await expect(quote).toHaveCount(0)
  const user = page.locator('.code-agent-transcript-user').last()
  await expect(user).toContainText('Keep my question')
  await expect(user).toContainText('Reading paragraph 20:')
})
