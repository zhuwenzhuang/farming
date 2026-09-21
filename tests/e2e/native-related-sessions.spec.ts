import fs from 'node:fs'
import path from 'node:path'
import { expect, openFarming, test } from './fixtures'

for (const width of [1440, 390]) {
  test(`native child detail preserves parent execution at ${width}px`, async ({ page, workspaceRoot }, testInfo) => {
    await page.setViewportSize({ width, height: 900 })
    const workspace = path.join(workspaceRoot, 'parser-review')
    fs.mkdirSync(workspace, { recursive: true })
    const response = await page.request.post('/farming/api/control/agents', {
      data: { command: 'codex', workspace, agentRuntimeMode: 'chat' },
    })
    expect(response.ok()).toBeTruthy()
    const { agentId } = await response.json() as { agentId: string }
    await page.request.post('/farming/api/settings', { data: { language: 'en' } })
    await openFarming(page)
    if (width < 600) await page.getByTestId('code-mobile-menu').click()
    await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
    const input = page.getByTestId('code-acp-composer-input')
    await expect(input).toBeEditable()
    await input.fill('Review parser edge cases (demo)')
    await page.getByTestId('code-acp-composer-send').click()
    const openSidebar = async () => { if (width < 600) await page.getByTestId('code-mobile-menu').click() }
    await openSidebar()
    await page.getByTestId('code-native-related-row').filter({ hasText: 'Parser reviewer' }).click()
    const panel = page.getByTestId('code-related-session-panel')
    await expect(panel).toBeVisible()
    await expect(panel).toContainText('Working')
    await expect(panel).toContainText('Review complete')
    await expect(panel.locator('.code-agent-transcript-answer strong')).toHaveText('Review complete')
    await expect(panel.locator('.code-agent-transcript-answer li')).toHaveCount(3)
    await expect(panel.locator('.code-agent-transcript-user')).toContainText('Review empty input')
    await expect(panel.locator('.code-agent-transcript-subagent')).toHaveCount(0)
    await expect(panel).not.toContainText('11 actions')
    await panel.getByTestId('code-agent-transcript-process-summary').click()
    await expect(panel).toContainText('I’ll inspect the parser')
    await expect(panel).toContainText('Ran a command')
    await expect(panel.getByRole('button', { name: /stop/i })).toHaveCount(0)
    for (const appearance of ['light', 'dark', 'paper']) {
      await page.locator('body').evaluate((body, value) => { body.dataset.appearance = value }, appearance)
      await page.evaluate(() => document.fonts.ready)
      // Equivalent Chat content must resolve to the same typography and colors,
      // not merely reference similarly named theme tokens.
      if (width >= 600) {
        for (const selector of ['.code-agent-transcript-user', '.code-agent-transcript-answer']) {
          const styles = (element: Element) => {
            const style = getComputedStyle(element)
            return [style.color, style.backgroundColor, style.fontSize, style.lineHeight]
          }
          expect(await panel.locator(selector).first().evaluate(styles)).toEqual(
            await page.getByTestId('code-agent-chat-view').locator(selector).first().evaluate(styles),
          )
        }
      }
      expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
      await page.screenshot({ path: testInfo.outputPath(`native-related-${width}-${appearance}.png`), animations: 'disabled' })
    }
    await panel.getByRole('button', { name: 'Collapse related session' }).click()
    await expect(panel).toHaveCount(0)
    await expect(page.getByTestId('code-agent-chat-view')).toContainText('Parent completed without interruption.')
    await page.getByTestId('code-agent-transcript-process-summary').click()
    await page.getByTestId('code-agent-transcript-collaboration-summary').click()
    await page.getByTestId('code-collaboration-open-details').click()
    await expect(panel).toContainText('Review complete')
    await panel.getByRole('button', { name: 'Collapse related session' }).click()

  })
}
