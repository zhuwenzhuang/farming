import { expect, openFarming, test } from './fixtures'

const longParagraph = 'The checkpoint reader compares upstream output with the persisted data for each partition. '.repeat(10)
const table = [
  '| Shuffle edge | Partition key | Parallelism | Writer checkpoint | Writer output | Reader total | Upstream read | Checkpoint read | Ratio |',
  '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ...Array.from({ length: 8 }, (_, i) => `| Stage ${i} → ${i + 1} | \`HASH(customer_link_id)\` | 1402 → 1402 | 2,353.56 GB | 2,353.56 GB | 2,353.56 GB | 2,353.56 GB | 0 GB | 0% |`),
].join('\n')
const answer = [
  '## Read-source comparison', '', table, '',
  ...Array.from({ length: 24 }, (_, i) => `### Section ${i + 1}\n\n${longParagraph}`),
  'END_OF_WIDE_LAYOUT_REVIEW',
].join('\n\n')

for (const appearance of ['light', 'dark', 'paper']) {
  test(`Chat width toggle preserves reading, layout and preference in ${appearance}`, async ({ page, workspaceRoot }, testInfo) => {
    await page.setViewportSize({ width: 1920, height: 1000 })
    await page.request.post('/farming/api/settings', { data: { appearance, language: 'en' } })
    const created = await page.request.post('/farming/api/control/agents', {
      data: { command: 'codex', workspace: workspaceRoot, agentRuntimeMode: 'chat' },
    })
    expect(created.ok()).toBeTruthy()
    const { agentId } = await created.json() as { agentId: string }
    const identity = await (await page.request.get(`/farming/api/agents/${agentId}/acp-transcript`)).json() as { sessionId: string; runtimeEpoch: string; toRevision: number }
    const revision = identity.toRevision + 1_000_000
    await page.route(new RegExp(`/farming/api/agents/${agentId}/acp-transcript(?:\\?.*)?$`), route => route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        version: 1, agentId, sessionId: identity.sessionId, runtimeEpoch: identity.runtimeEpoch,
        fromRevision: null, toRevision: revision, replace: true, settled: true, hasMoreBefore: false,
        transcript: { sessionId: identity.sessionId, provider: 'codex', revision, state: 'idle', entries: [
          { id: 'question', type: 'message', role: 'user', content: [{ type: 'text', text: 'Compare checkpoint sources across all stages.' }] },
          { id: 'answer', type: 'message', role: 'assistant', content: [{ type: 'text', text: answer }] },
        ] },
      }),
    }))
    await openFarming(page)
    const row = page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
    await row.click()
    const pane = page.locator('.code-agent-work-pane.active')
    const toggle = pane.getByTestId('code-chat-width-toggle')
    const scroll = pane.getByTestId('code-agent-transcript-scroll')
    const turn = scroll.locator('.code-agent-transcript-turn').first()
    await expect(scroll).toContainText('END_OF_WIDE_LAYOUT_REVIEW')
    await expect(toggle).toHaveAttribute('aria-pressed', 'false')
    await expect(pane.getByTestId('code-terminal-mode-toggle').locator('button').first()).toHaveAttribute('data-testid', 'code-chat-width-toggle')
    const regularWidth = await turn.evaluate(element => element.getBoundingClientRect().width)
    expect(regularWidth).toBe(980)
    const font = await turn.evaluate(element => getComputedStyle(element).fontSize)
    const input = page.locator('.code-composer-shell').getByTestId('code-acp-composer-input')
    await input.fill('Keep this draft')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-pressed', 'true')
    expect(await turn.evaluate(element => element.getBoundingClientRect().width)).toBeGreaterThan(regularWidth + 300)
    expect(await turn.evaluate(element => getComputedStyle(element).fontSize)).toBe(font)
    expect(await pane.locator('.code-agent-transcript-answer').evaluate(element => element.getBoundingClientRect().width)).toBeGreaterThan(regularWidth + 300)
    expect(await pane.locator('.code-agent-transcript-assistant.code-markdown-preview').evaluate(element => element.getBoundingClientRect().width)).toBeGreaterThan(regularWidth + 300)
    await expect(input).toHaveText('Keep this draft')
    await expect.poll(() => scroll.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThan(3)

    // Read in the middle of a long answer; reflow must retain this paragraph.
    const heading = scroll.getByRole('heading', { name: 'Section 12', exact: true })
    const paragraph = heading.locator('xpath=following-sibling::p[1]')
    await paragraph.evaluate(element => {
      const viewport = element.closest('.code-agent-transcript-scroll')!
      viewport.scrollTop += element.getBoundingClientRect().top - viewport.getBoundingClientRect().top + 12
    })
    await scroll.hover()
    await page.mouse.wheel(0, 1)
    const offset = () => paragraph.evaluate(element => element.getBoundingClientRect().top - element.closest('.code-agent-transcript-scroll')!.getBoundingClientRect().top)
    const before = await offset()
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-pressed', 'false')
    await expect.poll(async () => Math.abs((await offset()) - before)).toBeLessThan(3)
    await toggle.focus()
    await page.keyboard.press('Enter')
    await expect(toggle).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(async () => Math.abs((await offset()) - before)).toBeLessThan(3)
    const sticky = pane.getByTestId('code-agent-transcript-sticky-turn')
    if (await sticky.count()) {
      const right = (await sticky.boundingBox())!.x + (await sticky.boundingBox())!.width
      expect(right).toBeLessThan((await pane.getByTestId('code-terminal-mode-toggle').boundingBox())!.x)
    }
    await page.setViewportSize({ width: 1000, height: 1000 })
    await paragraph.evaluate(element => {
      const viewport = element.closest('.code-agent-transcript-scroll')!
      viewport.scrollTop += element.getBoundingClientRect().top - viewport.getBoundingClientRect().top + 12
    })
    await expect(sticky).toBeVisible()
    await expect.poll(async () => {
      const prompt = (await sticky.boundingBox())!
      return prompt.x + prompt.width - (await pane.getByTestId('code-terminal-mode-toggle').boundingBox())!.x
    }).toBeLessThan(0)
    await page.setViewportSize({ width: 1920, height: 1000 })
    await scroll.evaluate(element => { element.scrollTop = 0 })
    await expect(pane.locator('table')).toHaveCSS('table-layout', 'auto')
    await expect(pane.locator('table code').first()).toHaveCSS('white-space', 'nowrap')
    expect(await scroll.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
    const screenshot = await page.screenshot({ path: testInfo.outputPath(`wide-${appearance}.png`), animations: 'disabled' })
    expect(screenshot.readUInt32BE(16)).toBe(1920)
    expect(screenshot.readUInt32BE(20)).toBe(1000)

    if (appearance === 'light') {
      await input.fill('/side')
      await page.locator('.code-composer-shell').getByTestId('code-acp-composer-send').click()
      const side = page.getByTestId('code-subagent-panel')
      await expect(side).toBeVisible()
      await expect(side.locator('.code-agent-transcript')).toHaveClass(/wide-layout/)
      await toggle.click()
      await expect(side.locator('.code-agent-transcript')).not.toHaveClass(/wide-layout/)
      await toggle.click()
      await expect(side.locator('.code-agent-transcript')).toHaveClass(/wide-layout/)
      await side.getByRole('button', { name: 'Collapse related session' }).click()
      await expect(side).toBeHidden()
      await input.fill('Keep this draft')
    }
    const other = await page.request.post('/farming/api/control/agents', { data: { command: 'claude', workspace: workspaceRoot, agentRuntimeMode: 'chat' } })
    expect(other.ok()).toBeTruthy()
    const otherId = (await other.json() as { agentId: string }).agentId
    const otherRow = page.locator(`[data-testid="code-agent-row"][data-agent-id="${otherId}"]`)
    await otherRow.locator('.code-agent-name').click()
    await expect(otherRow).toHaveClass(/\bactive\b/)
    await expect(page.locator('.code-agent-work-pane.active').getByTestId('code-chat-width-toggle')).toHaveAttribute('aria-pressed', 'true')
    await row.locator('.code-agent-name').click()
    await expect(row).toHaveClass(/\bactive\b/)
    await page.reload()
    await expect(toggle).toHaveAttribute('aria-pressed', 'true')
    await expect(input).toHaveText('Keep this draft')
    const restoredSide = page.getByTestId('code-subagent-panel')
    if (await restoredSide.isVisible()) await restoredSide.getByRole('button', { name: 'Collapse related session' }).click()
    await scroll.evaluate(element => { element.scrollTop = 0 })
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(toggle).toBeHidden()
    if (await page.getByTestId('code-mobile-sidebar-backdrop').count()) await page.getByTestId('code-mobile-menu').click()
    await expect(page.getByTestId('code-mobile-sidebar-backdrop')).toHaveCount(0)
    expect(await scroll.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
    const tableViewport = pane.locator('.code-transcript-table-scroll').first()
    expect(await tableViewport.evaluate(element => element.scrollWidth)).toBeGreaterThan(await tableViewport.evaluate(element => element.clientWidth))
    await tableViewport.evaluate(element => { element.scrollLeft = element.scrollWidth })
    expect(await tableViewport.evaluate(element => element.scrollLeft)).toBeGreaterThan(0)
    await page.screenshot({ path: testInfo.outputPath(`compact-table-${appearance}.png`), animations: 'disabled' })
    await page.setViewportSize({ width: 1920, height: 1000 })
    await expect(toggle).toBeVisible()
    await expect(toggle).toHaveAttribute('aria-pressed', 'true')
    await toggle.click()
    await page.reload()
    await expect(toggle).toHaveAttribute('aria-pressed', 'false')
    if (appearance === 'light') {
      // A peer tab changes the same preference; current panes update together.
      await page.evaluate(() => {
        localStorage.setItem('farming.code.chatWideLayout.v1', 'true')
        window.dispatchEvent(new StorageEvent('storage', { key: 'farming.code.chatWideLayout.v1', newValue: 'true' }))
      })
      await expect(toggle).toHaveAttribute('aria-pressed', 'true')
      // Denied persistence must not prevent toggling in the current browser.
      await page.evaluate(() => {
        Storage.prototype.setItem = () => { throw new DOMException('Storage unavailable', 'SecurityError') }
      })
      await toggle.click()
      await expect(toggle).toHaveAttribute('aria-pressed', 'false')
      await toggle.click()
      await expect(toggle).toHaveAttribute('aria-pressed', 'true')
    }
  })
}
