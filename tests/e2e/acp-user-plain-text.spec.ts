import { expect, openFarming, test } from './fixtures'

for (const appearance of ['light', 'dark', 'paper']) {
  test(`sent literal input and Steer survive paste, copy and reload in ${appearance}`, async ({ page, workspaceRoot }, testInfo) => {
    const created = await page.request.post('/farming/api/control/agents', {
      data: { command: 'codex', workspace: workspaceRoot, agentRuntimeMode: 'chat' },
    })
    expect(created.ok()).toBeTruthy()
    const { agentId } = await created.json() as { agentId: string }
    await page.request.post('/farming/api/settings', { data: { appearance } })
    await page.setViewportSize({ width: 1280, height: 900 })
    await openFarming(page)
    await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
    const source = [
      '# 1. 设置 CLI Token',
      "export EXAMPLE_TOKEN='example-placeholder'",
      '# 2. 克隆源码',
      'git clone https://example.com/demo.git',
      'cd demo',
      '',
      '  # 保留缩进',
      '\tprintf "hello"',
      '**重点** `literal` [文档](https://example.com)',
      '- item',
      '| name | value |',
      '| --- | --- |',
      '| demo | 1 |',
      '```sh',
      './build sql',
      '```',
      '<script>window.markdownInjected = true</script>',
      'hold for steer without user echo',
    ].join('\n')
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
    await page.evaluate(text => navigator.clipboard.writeText(text), source)
    const input = page.getByTestId('code-acp-composer-input')
    await input.focus()
    await page.keyboard.press('ControlOrMeta+v')
    await expect.poll(() => input.innerText()).toBe(source)
    await page.getByTestId('code-acp-composer-send').click()
    await expect(page.getByText('Waiting for steering.', { exact: true })).toBeVisible()
    const message = page.getByTestId('code-user-document').first()
    const check = async () => {
      await expect.poll(() => message.innerText()).toBe(source)
      expect(await message.innerText()).toBe(source)
      await expect(message.locator('h1, strong, li, a, table, pre, script')).toHaveCount(0)
      await expect(message).toHaveCSS('white-space', 'pre-wrap')
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
    const answer = page.locator('.code-agent-transcript-answer').last()
    await expect(answer).toContainText('Steer accepted:')
    await expect(answer.locator('strong')).toHaveText('补充检查')
    const process = page.getByTestId('code-agent-transcript-process-summary')
    await expect(process).toHaveAttribute('aria-expanded', 'false')
    await process.click()
    const steer = page.getByTestId('code-agent-transcript-steer')
    await expect(steer.getByTestId('code-user-document')).toHaveText(steerText)
    await page.reload()
    await check()
    await expect(process).toBeVisible()
    if (await process.getAttribute('aria-expanded') === 'false') await process.click()
    await expect(steer.getByTestId('code-user-document')).toHaveText(steerText)
    await input.blur()
    await message.evaluate(element => {
      const range = document.createRange()
      range.selectNodeContents(element)
      window.getSelection()!.removeAllRanges()
      window.getSelection()!.addRange(range)
    })
    await page.keyboard.press('ControlOrMeta+c')
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(source)
    await page.evaluate(() => window.getSelection()!.removeAllRanges())
    await message.scrollIntoViewIfNeeded()
    const screenshot = await page.screenshot({ path: testInfo.outputPath(`user-plain-text-${appearance}.png`), animations: 'disabled' })
    expect(screenshot.readUInt32BE(16)).toBe(1280)
    expect(screenshot.readUInt32BE(20)).toBe(900)
    await testInfo.attach(`user-plain-text-${appearance}`, { body: screenshot, contentType: 'image/png' })
    await page.setViewportSize({ width: 390, height: 844 })
    const scroll = page.getByTestId('code-agent-transcript-scroll')
    await expect.poll(() => scroll.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    await message.scrollIntoViewIfNeeded()
    await check()
    await page.screenshot({ path: testInfo.outputPath(`user-plain-text-${appearance}-compact.png`), animations: 'disabled' })
  })
}
