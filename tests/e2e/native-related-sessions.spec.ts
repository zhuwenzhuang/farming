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
    await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"] .code-agent-name`).click({ position: { x: 8, y: 8 } })
    const input = page.getByTestId('code-acp-composer-input')
    await expect(input).toBeEditable()
    await input.fill('Review parser edge cases (demo)')
    await page.getByTestId('code-acp-composer-send').click()
    const openSidebar = async () => { if (width < 600) await page.getByTestId('code-mobile-menu').click() }
    await openSidebar()
    await page.getByTestId('code-native-related-row').filter({ hasText: 'Parser reviewer' }).click()
    const panel = page.getByTestId('code-related-session-panel')
    await expect(panel).toBeVisible()
    await expect(panel).toContainText('In progress')
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
    await openSidebar()
    await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"] .code-agent-name`).click({ position: { x: 8, y: 8 } })
    await expect(panel).toBeVisible()
    await expect(panel).toContainText('Review complete')
    const headerIcon = panel.locator('.code-related-session-header .code-collaboration-agent-icon')
    await expect(headerIcon).toBeVisible()
    const quote = panel.getByRole('button', { name: 'Quote in parent chat', exact: true })
    await expect(quote).toBeVisible()
    expect(await quote.evaluate(element => element.scrollWidth <= element.clientWidth && element.scrollHeight <= element.clientHeight)).toBe(true)
    if (width >= 600) {
      const selectedChild = page.getByTestId('code-native-related-row').filter({ hasText: 'Parser reviewer' })
      await expect(selectedChild).toBeVisible()
      expect(await headerIcon.locator('svg').innerHTML()).toBe(
        await selectedChild.locator('.code-collaboration-agent-icon svg').innerHTML(),
      )
    }
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
    const activitySummary = page.locator('.code-agent-transcript-collaboration-event-description').filter({ hasText: 'checked' })
    await expect(activitySummary.locator('strong')).toHaveText('Review complete')
    await expect(activitySummary.locator('code')).toHaveText('parse()')
    await expect(activitySummary).not.toContainText('**')
    await expect(activitySummary).not.toContainText('`')
    await expect(page.getByTestId('code-collaboration-finished')).toHaveCount(0)
    await page.getByTestId('code-agent-transcript-collaboration-event').first().click()
    await page.getByTestId('code-collaboration-open-details').first().click()
    await expect(panel).toContainText('Review complete')
    await panel.getByRole('button', { name: 'Collapse related session' }).click()
    await openSidebar()
    const finishedRows = page.getByTestId('code-native-related-finished')
    await expect(finishedRows).toBeVisible()
    if (await finishedRows.getAttribute('open') === null) await finishedRows.locator('summary').click()
    const sidebarIcon = page.getByTestId('code-native-related-row').locator('.code-collaboration-agent-icon')
    const transcriptIcon = page.getByTestId('code-agent-transcript-collaboration-event').first().locator('.code-collaboration-agent-icon')
    await expect(sidebarIcon).toBeVisible()
    const row = page.getByTestId('code-native-related-row')
    await row.scrollIntoViewIfNeeded()
    const iconBox = await sidebarIcon.boundingBox()
    const rowBox = await row.boundingBox()
    const labelBox = await row.locator('.code-agent-name').boundingBox()
    const groupBox = await finishedRows.locator('summary').boundingBox()
    expect(iconBox!.x).toBeGreaterThan(rowBox!.x)
    expect(labelBox!.x).toBeGreaterThan(iconBox!.x + iconBox!.width)
    expect(rowBox!.x).toBe(groupBox!.x)
    expect(rowBox!.x + rowBox!.width).toBe(groupBox!.x + groupBox!.width)
    const parentLabel = await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"] .code-agent-name`).boundingBox()
    expect(labelBox!.x - parentLabel!.x).toBe(20)
    await sidebarIcon.evaluate(element => { (element as HTMLElement).style.display = 'none' })
    expect((await row.locator('.code-agent-name').boundingBox())!.x).toBe(labelBox!.x)
    await sidebarIcon.evaluate(element => { (element as HTMLElement).style.removeProperty('display') })

    for (const appearance of ['light', 'dark', 'paper']) {
      await page.locator('body').evaluate((body, value) => { body.dataset.appearance = value }, appearance)
      expect(await sidebarIcon.locator('svg').innerHTML()).toBe(await transcriptIcon.locator('svg').innerHTML())
      expect(await sidebarIcon.locator('svg').evaluate(element => getComputedStyle(element).color)).toBe(
        await transcriptIcon.locator('svg').evaluate(element => getComputedStyle(element).color),
      )
      await page.screenshot({ path: testInfo.outputPath(`native-sidebar-${width}-${appearance}.png`), animations: 'disabled' })
    }

    if (width < 600) {
      const parentRow = page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
      await expect(parentRow.getByTestId('code-agent-row-related-visibility')).toBeHidden()
      await parentRow.getByTestId('code-agent-row-more').click()
      await page.getByRole('menuitem', { name: 'Hide subagents', exact: true }).click()
      await expect(row).toBeHidden()
      await expect(page.getByTestId('code-agent-context-menu')).toBeHidden()
      await parentRow.getByTestId('code-agent-row-more').click()
      await page.getByRole('menuitem', { name: 'Show subagents', exact: true }).click()
      await expect(row).toBeVisible()
    }

  })
}
