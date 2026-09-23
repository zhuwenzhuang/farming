import fs from 'node:fs'
import path from 'node:path'
import { expect, openFarming, test } from './fixtures'

test('captures multiple native Agents with independent states', async ({ page, workspaceRoot }, testInfo) => {
  await page.setViewportSize({ width: 1600, height: 1000 })
  const workspace = path.join(workspaceRoot, 'parser-workspace')
  fs.mkdirSync(workspace, { recursive: true })
  await page.request.post('/farming/api/settings', { data: { language: 'zh' } })
  const response = await page.request.post('/farming/api/control/agents', {
    data: { command: 'codex', workspace, agentRuntimeMode: 'chat' },
  })
  expect(response.ok()).toBeTruthy()
  const { agentId } = await response.json() as { agentId: string }
  await openFarming(page)
  await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
  const input = page.getByTestId('code-acp-composer-input')
  await expect(input).toBeEditable()
  await input.fill('请并行检查解析器变更、权限边界和集成测试（状态演示）')
  await page.getByTestId('code-acp-composer-send').click()
  await expect(page.getByTestId('code-agent-chat-view')).toContainText('已分配六项并行检查。')
  const rows = page.getByTestId('code-native-related-row')
  const scenarios = [
    { name: '实现检查', status: '进行中', appearance: 'light', file: '01-running-light.png' },
    { name: '安全审查', status: '等待批准', appearance: 'light', file: '02-permission-light.png' },
    { name: '需求澄清', status: '等待输入', appearance: 'dark', file: '03-input-dark.png' },
    { name: '解析器审查', status: '已完成', appearance: 'dark', file: '04-completed-dark.png' },
    { name: '集成测试', status: '失败', appearance: 'paper', file: '05-failed-paper.png' },
    { name: '迁移检查', status: '已暂停', appearance: 'paper', file: '06-interrupted-paper.png' },
  ]
  const finished = page.getByTestId('code-native-related-finished')
  await expect(finished).toBeVisible()
  await finished.locator('summary').click()
  const parentRow = page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
  await expect(page.locator('.code-agent-row[role="status"]')).toHaveCount(0)
  for (const scenario of scenarios) {
    await page.locator('body').evaluate((body, appearance) => { body.dataset.appearance = appearance }, scenario.appearance)
    const row = rows.filter({ hasText: scenario.name })
    await expect(row).toBeVisible()
    await expect(row).toHaveAttribute('aria-label', new RegExp(scenario.status))
    await row.click()
    const panel = page.getByTestId('code-related-session-panel')
    await expect(panel).toBeVisible()
    await expect(panel.locator('.code-related-session-header')).toContainText(scenario.name)
    await expect(panel.locator('.code-agent-transcript-subagent-status')).toHaveText(scenario.status)
    await expect(rows).toHaveCount(6)
    await expect(panel.locator('.code-collaboration-agent-icon').first()).toBeVisible()
    await page.mouse.move(1500, 970)
    await page.evaluate(() => document.fonts.ready)
    const parentBox = (await parentRow.boundingBox())!
    const parentLabel = (await parentRow.locator('.code-agent-name').boundingBox())!
    const groupBox = (await finished.locator('summary').boundingBox())!
    const groupLabel = (await finished.locator('summary .code-agent-name').boundingBox())!
    expect(groupBox.x).toBe(parentBox.x)
    expect(groupLabel.x - parentLabel.x).toBe(20)
    for (const childRow of await rows.all()) {
      const box = (await childRow.boundingBox())!
      const icon = (await childRow.locator('.code-collaboration-agent-icon').boundingBox())!
      const label = (await childRow.locator('.code-agent-name').boundingBox())!
      expect(box.x).toBe(parentBox.x)
      expect(box.x + box.width).toBe(parentBox.x + parentBox.width)
      expect(icon.x).toBeGreaterThanOrEqual(box.x)
      expect(label.x - parentLabel.x).toBe(20)
      expect(label.x - icon.x - icon.width).toBe(7)
      expect(icon.y).toBeGreaterThanOrEqual(box.y)
      expect(icon.y + icon.height).toBeLessThanOrEqual(box.y + box.height)
    }
    // An icon must not shift its own label or any following sibling, including
    // children inside the finished group and the selected child promoted out of it.
    const labelPositions = () => rows.locator('.code-agent-name').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().x))
    const before = await labelPositions()
    await rows.locator('.code-collaboration-agent-icon').first().evaluate(element => { (element as HTMLElement).style.display = 'none' })
    expect(await labelPositions()).toEqual(before)
    await rows.locator('.code-collaboration-agent-icon').first().evaluate(element => { (element as HTMLElement).style.removeProperty('display') })
    expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    const png = await page.screenshot({ path: testInfo.outputPath(scenario.file), animations: 'disabled' })
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1600, 1000])
    if (['01-running-light.png', '03-input-dark.png', '05-failed-paper.png'].includes(scenario.file)) {
      const sidebar = page.getByTestId('code-project-group').filter({ hasText: 'parser-workspace' })
      await expect(sidebar).toBeVisible()
      await sidebar.screenshot({ path: testInfo.outputPath(`sidebar-${scenario.appearance}.png`), animations: 'disabled' })
      const eye = parentRow.getByTestId('code-agent-row-related-visibility')
      const actions = parentRow.locator('.code-agent-row-actions')
      await expect(actions).toHaveCSS('opacity', '0')
      await parentRow.hover()
      await expect(actions).toHaveCSS('opacity', '1')
      await expect(eye).toHaveAttribute('aria-expanded', 'true')
      await expect(eye).toHaveAccessibleName('隐藏子 Agent')
      await sidebar.screenshot({ path: testInfo.outputPath(`eye-expanded-${scenario.appearance}.png`), animations: 'disabled' })
      await eye.click()
      await expect(eye).toHaveAttribute('aria-expanded', 'false')
      await expect(eye).toHaveAccessibleName('显示子 Agent')
      await expect(page.getByTestId('code-native-related-row').filter({ visible: true })).toHaveCount(0)
      await expect(finished).toBeHidden()
      await expect(panel).toBeVisible()
      await expect(panel.locator('.code-related-session-header')).toContainText(scenario.name)
      await sidebar.screenshot({ path: testInfo.outputPath(`eye-collapsed-${scenario.appearance}.png`), animations: 'disabled' })
      // Returning to the parent and remounting its rows must not expand children.
      await parentRow.locator('.code-agent-name').click({ position: { x: 8, y: 8 } })
      await expect(eye).toHaveAttribute('aria-expanded', 'false')
      const projectTitle = sidebar.getByTestId('code-project-title')
      await projectTitle.click()
      await expect(parentRow).toBeHidden()
      await projectTitle.click()
      await expect(eye).toHaveAttribute('aria-expanded', 'false')
      await page.mouse.move(1500, 970)
      await page.keyboard.press('Tab')
      await eye.focus()
      await expect(actions).toHaveCSS('opacity', '1')
      await page.keyboard.press('Enter')
      await expect(eye).toHaveAttribute('aria-expanded', 'true')
      await expect(rows.filter({ hasText: scenario.name })).toBeVisible()
      await rows.filter({ hasText: scenario.name }).click()
      // Reopen the finished group after its DOM was deliberately remounted.
      if (await finished.getAttribute('open') === null) await finished.locator('summary').click()
    }
  }
})
