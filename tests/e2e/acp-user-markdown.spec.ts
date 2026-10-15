import { expect, openFarming, test } from './fixtures'

for (const appearance of ['light', 'dark', 'paper']) {
  test(`sent user Markdown and Steer survive reload in ${appearance}`, async ({ page, workspaceRoot }, testInfo) => {
    const created = await page.request.post('/farming/api/control/agents', {
      data: { command: 'codex', workspace: workspaceRoot, agentRuntimeMode: 'chat' },
    })
    expect(created.ok()).toBeTruthy()
    const { agentId } = await created.json() as { agentId: string }
    await page.request.post('/farming/api/settings', { data: { appearance } })
    await page.setViewportSize({ width: 1280, height: 900 })
    await openFarming(page)
    await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
    const source = '**CDC / 周期任务** 这块是什么情况\n\n前文**“重点”**后文\n\n- 检查 `schedule`\n- 查看 [文档](https://example.com)\n\n| 项目 | 状态 |\n| --- | --- |\n| CDC | 待检查 |\n\n```js\nconst enabled = true\n```\n\n<script>window.markdownInjected = true</script>\n\nhold for steer without user echo'
    await page.getByTestId('code-acp-composer-input').fill(source)
    await page.getByTestId('code-acp-composer-send').click()
    await expect(page.getByText('Waiting for steering.', { exact: true })).toBeVisible()
    const message = page.locator('.code-agent-transcript-user-markdown').first()
    const check = async () => {
      await expect(message.locator('strong').first()).toHaveText('CDC / 周期任务')
      await expect(message.locator('strong').nth(1)).toHaveText('“重点”')
      await expect(message.locator('li')).toHaveCount(2)
      await expect(message.locator('a')).toHaveAttribute('href', 'https://example.com')
      await expect(message.locator('table td').first()).toHaveText('CDC')
      await expect(message.locator('pre code')).toContainText('const enabled = true')
      await expect(message.locator('script')).toHaveCount(0)
      expect(await page.evaluate(() => Object.hasOwn(window, 'markdownInjected'))).toBe(false)
    }
    await check()
    // Inspect the authoritative source: presentation must not rewrite the prompt.
    const transcript = await (await page.request.get(`/farming/api/agents/${agentId}/acp-transcript`)).text()
    expect(transcript).toContain(JSON.stringify(source).slice(1, -1))
    const steerText = '**补充检查**：保留 `CDC` 配置。'
    await page.getByTestId('code-acp-composer-input').fill(steerText)
    await page.getByTestId('code-acp-composer-send').click()
    const pendingSteer = page.getByTestId('code-acp-pending-followup-steer')
    if (await pendingSteer.count()) await pendingSteer.click()
    const steer = page.getByTestId('code-agent-transcript-steer')
    await expect(steer.locator('strong')).toHaveText('补充检查')
    await page.reload()
    await check()
    await expect(steer.locator('strong')).toHaveText('补充检查')
    await message.scrollIntoViewIfNeeded()
    const screenshot = await page.screenshot({ path: testInfo.outputPath(`user-markdown-${appearance}.png`), animations: 'disabled' })
    expect(screenshot.readUInt32BE(16)).toBe(1280)
    expect(screenshot.readUInt32BE(20)).toBe(900)
    await testInfo.attach(`user-markdown-${appearance}`, { body: screenshot, contentType: 'image/png' })
    await page.setViewportSize({ width: 390, height: 844 })
    const scroll = page.getByTestId('code-agent-transcript-scroll')
    await expect.poll(() => scroll.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  })
}
