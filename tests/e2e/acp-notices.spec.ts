import { expect, openFarming, test } from './fixtures'
import fs from 'node:fs/promises'
import path from 'node:path'

test('notice experience keeps a useful explanation and lets the user continue their draft', async ({ page, workspaceRoot }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const workspace = path.join(workspaceRoot, 'example-project')
  await fs.mkdir(workspace)
  const created = await page.request.post('/farming/api/control/agents', {
    data: { command: 'claude', workspace, agentRuntimeMode: 'chat' },
  })
  expect(created.ok()).toBeTruthy()
  const { agentId } = await created.json() as { agentId: string }
  try {
    await openFarming(page)
    await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
    const input = page.getByTestId('code-acp-composer-input')
    await input.fill('检查项目配置，看看有没有遗漏。')
    await page.getByTestId('code-acp-composer-send').click()
    const notice = page.getByTestId('code-acp-notice')
    await expect(notice).toContainText('本次检查将仅使用项目文件，不包含在线文档。')
    await expect(page.getByText('已检查项目配置，发现示例环境文件中缺少日志级别设置。可以补上 LOG_LEVEL=info，方便本地排查问题。', { exact: true })).toBeVisible()
    await input.fill('先补上日志级别设置')
    for (const appearance of ['light', 'dark', 'paper']) {
      await page.evaluate(value => {
        document.body.dataset.appearance = value
        document.documentElement.dataset.appearance = value
      }, appearance)
      const screenshot = await page.screenshot({ path: testInfo.outputPath(`notice-example-${appearance}.png`), animations: 'disabled' })
      expect([screenshot.readUInt32BE(16), screenshot.readUInt32BE(20)]).toEqual([1440, 900])
    }
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(notice).toBeInViewport()
    await expect(input).toBeInViewport()
    const mobile = await page.screenshot({ path: testInfo.outputPath('notice-example-mobile.png'), animations: 'disabled' })
    expect([mobile.readUInt32BE(16), mobile.readUInt32BE(20)]).toEqual([390, 844])
    await page.setViewportSize({ width: 1440, height: 900 })
    await notice.getByRole('button').focus()
    await page.keyboard.press('Enter')
    await expect(notice).toHaveCount(0)
    await expect(input).toBeFocused()
    await page.keyboard.type(', then show the diff')
    await expect(input).toHaveText('先补上日志级别设置, then show the diff')
    await page.reload()
    await expect(page.getByTestId('code-acp-notice')).toHaveCount(0)
  } finally {
    const removed = await page.request.delete(`/farming/api/control/agents/${agentId}?recordHistory=0`)
    expect(removed.ok()).toBeTruthy()
    await fs.rm(workspace, { recursive: true, force: true })
  }
})

test('ACP notices remain plain live feedback across appearances, browsers and CRT', async ({ page, workspaceRoot }, testInfo) => {
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  const created = await page.request.post('/farming/api/control/agents', {
    data: { command: 'claude', workspace: workspaceRoot, agentRuntimeMode: 'chat' },
  })
  expect(created.ok()).toBeTruthy()
  const { agentId } = await created.json() as { agentId: string }
  const mirror = await page.context().newPage()
  const notices = page.getByTestId('code-acp-notice')
  const row = `[data-testid="code-agent-row"][data-agent-id="${agentId}"]`
  try {
    await openFarming(page)
    await page.locator(row).click()
    await page.getByTestId('code-acp-composer-input').fill('Inspect session notices')
    await page.getByTestId('code-acp-composer-send').click()
    await expect(notices).toHaveCount(4)
    await expect(page.getByText('Work completed with advisories.', { exact: true })).toBeVisible()
    await expect(page.getByTestId('code-acp-error')).toHaveCount(0)
    await expect(notices.first()).toContainText('**Plain text**, not Markdown.')
    await expect(notices.first()).toContainText('<em>Work continues.</em>')
    await expect(notices.locator('em, a')).toHaveCount(0)
    for (const appearance of ['light', 'dark', 'paper']) {
      await page.evaluate(value => {
        document.body.dataset.appearance = value
        document.documentElement.dataset.appearance = value
      }, appearance)
      const capture = await page.screenshot({ path: testInfo.outputPath(`notices-${appearance}.png`), animations: 'disabled' })
      expect([capture.readUInt32BE(16), capture.readUInt32BE(20)]).toEqual([1440, 900])
    }
    await notices.last().scrollIntoViewIfNeeded()
    await expect(notices.last()).toBeInViewport()
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(page.getByTestId('code-acp-composer-input')).toBeVisible()
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath('notices-mobile.png'), animations: 'disabled' })
    await page.setViewportSize({ width: 1440, height: 900 })
    await openFarming(mirror)
    await mirror.locator(row).click()
    await expect(mirror.getByTestId('code-acp-notice')).toHaveCount(4)
    const closeWarning = notices.filter({ hasText: 'Session advisory: warning' }).getByRole('button')
    await closeWarning.focus()
    await page.keyboard.press('Enter')
    await expect(notices).toHaveCount(3)
    await expect(mirror.getByTestId('code-acp-notice')).toHaveCount(3)
    await page.reload()
    await page.locator(row).click()
    await expect(notices).toHaveCount(3)
    const dismissUrl = '**/acp-notices/**'
    await page.route(dismissUrl, route => route.fulfill({ status: 503, json: { error: 'Fixture failure' } }))
    const errorNotice = notices.filter({ hasText: 'Session advisory: error' })
    await errorNotice.getByRole('button').click()
    await expect(errorNotice).toContainText(/Could not close|未能关闭/)
    await expect(notices).toHaveCount(3)
    await page.unroute(dismissUrl)
    await errorNotice.getByRole('button').click()
    await expect(notices).toHaveCount(2)
    await mirror.goto(`/farming/crt/?agent=${encodeURIComponent(agentId)}`, { waitUntil: 'domcontentloaded' })
    await expect(mirror.locator('.crt-session-notice')).toHaveCount(2)
    await mirror.getByRole('button', { name: 'Close: Session advisory: info', exact: true }).click()
    await expect(mirror.locator('.crt-session-notice')).toHaveCount(1)
    await expect(notices).toHaveCount(1)
    const crtCapture = await mirror.screenshot({ path: testInfo.outputPath('notices-crt.png'), animations: 'disabled' })
    const crtViewport = mirror.viewportSize()!
    expect([crtCapture.readUInt32BE(16), crtCapture.readUInt32BE(20)]).toEqual([crtViewport.width, crtViewport.height])
    const response = await page.request.get(`/farming/api/agents/${agentId}/acp-session`)
    const { session } = await response.json()
    expect(session.state).toBe('idle')
    expect(session.stopReason).toBe('end_turn')
    expect(session.notices).toHaveLength(1)
    expect(session.entries.some((entry: { type: string }) => entry.type === 'notice')).toBe(false)
    // Continuing the conversation replaces old feedback without requiring a close click.
    await page.getByTestId('code-acp-composer-input').fill('Inspect session notices')
    await expect(notices).toHaveCount(1)
    await page.getByTestId('code-acp-composer-send').click()
    await expect(notices).toHaveCount(4)
    await expect(mirror.locator('.crt-session-notice')).toHaveCount(4)
    const next = await (await page.request.get(`/farming/api/agents/${agentId}/acp-session`)).json()
    expect(next.session.notices.some((notice: { id: string }) => notice.id === session.notices[0].id)).toBe(false)
    await page.getByTestId('code-acp-composer-input').fill('Inspect repeated native replies')
    await page.getByTestId('code-acp-composer-send').click()
    await expect(notices).toHaveCount(0)
    await expect(mirror.locator('.crt-session-notice')).toHaveCount(0)
    await page.reload()
    await expect(page.getByTestId('code-acp-notice')).toHaveCount(0)
  } finally {
    await mirror.close()
    const removed = await page.request.delete(`/farming/api/control/agents/${agentId}?recordHistory=0`)
    expect(removed.ok()).toBeTruthy()
  }
})
