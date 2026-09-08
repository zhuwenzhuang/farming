import fs from 'node:fs'
import path from 'node:path'
import { expect, openFarming, test } from './fixtures'

const longDraft = `你来做一个长任务
1.先clone velox到本地reference目录下，然后和我们runtime的实现比对优劣。注意这个比对必须是用实际测试比对的，有针对实际数据处理的性能数字并且和cpu与内存细化等硬件细化指标做量化分析。
2.然后请下载tpcds构造10TB数据的代码库，现在我们的10tb测试会用partitioned hash join。之前有反馈这种hash join算法会有较多随机内存访问，导致内存带宽打满。请你仔细分析并基于构造的数据复现，比如catalog sales 和returns的 partitioned hash join。复现性能问题后，再看看velox在这上面的效果，与我们的对比，找到我们的优化空间，并实际验证有效。
这个是个较长的研究和验证改进任务，请不要中途停下来，遇到问题想办法解决，直到达成目标，或证明目标无法达成。
8:57`

test.use({ hasTouch: true, viewport: { width: 390, height: 844 } })

for (const runtime of ['chat', 'terminal'] as const) {
  test(`mobile ${runtime} long input scrolls and expands without replacing its draft`, async ({ page, workspaceRoot, browserName }, testInfo) => {
    const workspace = path.join(workspaceRoot, 'join-research')
    fs.mkdirSync(workspace, { recursive: true })
    const response = await page.request.post('/farming/api/control/agents', {
      data: { command: runtime === 'chat' ? 'codex' : 'bash', workspace, agentRuntimeMode: runtime },
    })
    expect(response.ok()).toBeTruthy()
    const { agentId } = await response.json() as { agentId: string }
    await page.request.post('/farming/api/settings', { data: { language: 'zh' } })
    await openFarming(page)
    await page.getByTestId('code-mobile-menu').click()
    await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
    const prefix = runtime === 'chat' ? 'code-acp-composer' : 'code-composer'
    const input = page.getByTestId(`${prefix}-input`)
    const composer = page.getByTestId(prefix)
    const toggle = page.getByTestId('code-composer-editor-toggle')
    await expect(input).toBeEditable()
    if (runtime === 'terminal') {
      await expect.poll(() => page.evaluate(id => ({
        ready: window.__farmingTerminalTest?.isReady(id) ?? false,
        error: document.querySelector('[data-testid="code-terminal-status-card"]')?.getAttribute('title') ?? null,
      }), agentId)).toEqual({ ready: true, error: null })
      await expect(page.getByTestId('code-terminal-status-card')).toHaveCount(0)
    }
    if (runtime === 'chat') {
      // Exercise the real composer over a completed turn, including embedded HTML.
      await input.fill('workspace inline visualization')
      await page.getByTestId(`${prefix}-send`).click()
      await expect(page.getByTestId('code-agent-transcript-inline-visualization')).toBeVisible()
      await expect(input).toHaveValue('')
    }
    await input.fill('简短任务')
    const shortHeight = await input.evaluate(element => element.clientHeight)
    await input.fill(longDraft)
    await expect.poll(() => input.evaluate(element => element.clientHeight)).toBeGreaterThan(shortHeight + 60)
    await expect(input).toHaveAttribute('enterkeyhint', 'enter')
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await input.evaluate(element => { element.scrollTop = 0 })
    const box = await input.boundingBox()
    if (!box) throw new Error('Composer has no visible bounds')
    if (browserName === 'chromium') {
      const cdp = await page.context().newCDPSession(page)
      try {
        const x = box.x + box.width / 2
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: box.y + box.height - 10 }] })
        for (let step = 1; step <= 6; step++) {
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: box.y + box.height - 10 - step * 16 }] })
        }
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
        await expect.poll(() => input.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
        // Stop native fling before preparing a deterministic screenshot position.
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: box.y + 20 }] })
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] })
      } finally { await cdp.detach() }
    } else {
      await input.evaluate(element => { element.scrollTop = 100 })
      await expect.poll(() => input.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
    }
    // Keep selection in the same DOM textarea through presentation changes.
    const original = await input.elementHandle()
    await input.evaluate(element => { element.setSelectionRange(25, 38); element.scrollTop = 0 })
    for (const appearance of ['light', 'dark', 'paper'] as const) {
      await page.locator('body').evaluate((body, value) => { body.dataset.appearance = value }, appearance)
      await expect(input).toHaveValue(longDraft)
      await page.evaluate(() => document.fonts.ready)
      await input.press('Control+Home')
      await input.evaluate(element => { element.setSelectionRange(0, 0); element.scrollTop = 0 })
      await expect.poll(() => input.evaluate(element => element.scrollTop)).toBe(0)
      await page.screenshot({ path: testInfo.outputPath(`mobile-${runtime}-${appearance}-compact.png`), animations: 'disabled', caret: 'hide' })
      await input.evaluate(element => { element.setSelectionRange(25, 38) })
      await toggle.click()
      await expect(toggle).toHaveAttribute('aria-expanded', 'true')
      await expect(composer).toHaveClass(/editor-expanded/)
      expect(await original?.evaluate(element => element === document.querySelector(`[data-testid="${element.dataset.testid}"]`))).toBe(true)
      expect(await input.evaluate(element => [element.selectionStart, element.selectionEnd])).toEqual([25, 38])
      await expect.poll(() => input.evaluate(element => element.clientHeight)).toBeGreaterThan(500)
      await input.evaluate(element => { element.setSelectionRange(0, 0); element.scrollTop = 0 })
      await page.screenshot({ path: testInfo.outputPath(`mobile-${runtime}-${appearance}-expanded.png`), animations: 'disabled', caret: 'hide' })
      // Reduced visible height models keyboard space without drawing a fake keyboard.
      await page.setViewportSize({ width: 390, height: 480 })
      await expect.poll(async () => {
        const visible = await composer.boundingBox()
        return Boolean(visible && visible.y >= 0 && visible.y + visible.height <= 481)
      }).toBe(true)
      await expect(page.getByTestId(`${prefix}-send`)).toBeInViewport()
      await page.setViewportSize({ width: 390, height: 844 })
      await toggle.click()
      await expect(toggle).toHaveAttribute('aria-expanded', 'false')
      await expect(input).toHaveValue(longDraft)
    }
    await original?.dispose()
    await toggle.click()
    if (runtime === 'chat') {
      await page.getByTestId('code-acp-composer-file-input').setInputFiles(path.resolve('public/farming-2/app-icon-v2-180.png'))
      const attachment = page.getByTestId('code-composer-attachment')
      await expect(attachment).toHaveClass(/ready/)
      await expect(attachment).toBeInViewport()
      await page.getByTestId('code-acp-composer-add').click()
      await expect(page.getByTestId('code-acp-plus-menu')).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(page.getByTestId('code-acp-plus-menu')).toHaveCount(0)
      await expect(toggle).toHaveAttribute('aria-expanded', 'true')
      await toggle.click()
      await expect(attachment).toBeInViewport()
      await expect(page.getByTestId(`${prefix}-send`)).toBeInViewport()
      expect(await input.evaluate(element => element.clientHeight)).toBeLessThanOrEqual(66)
      await attachment.getByRole('button').click()
      await expect(attachment).toHaveCount(0)
      await expect(input).toHaveValue(longDraft)
      await toggle.click()
    }
    await input.fill('可继续编辑')
    await input.press('End')
    await input.press('Enter')
    await expect(input).toHaveValue('可继续编辑\n')
    await input.dispatchEvent('keydown', { key: 'Escape', isComposing: true })
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await input.press('Escape')
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await toggle.click()
    await page.setViewportSize({ width: 1280, height: 844 })
    await expect(composer).not.toHaveClass(/editor-expanded/)
    await expect(toggle).toHaveCount(0)
    await expect(input).toHaveValue('可继续编辑\n')
    if (runtime === 'chat') {
      // Expansion must yield to an authoritative permission request.
      await page.setViewportSize({ width: 390, height: 844 })
      await input.fill('request approval')
      await toggle.click()
      await page.getByTestId(`${prefix}-send`).click()
      await expect(page.getByTestId('code-acp-permission-request')).toBeVisible()
      await expect(composer).not.toHaveClass(/editor-expanded/)
      await expect(toggle).toHaveCount(0)
    }
  })
}
