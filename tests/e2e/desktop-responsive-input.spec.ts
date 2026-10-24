import fs from 'node:fs'
import path from 'node:path'
import { expect, openFarming, test } from './fixtures'
import { expectValue, selectText, selection } from './composer-test-input'

for (const runtime of ['chat', 'terminal'] as const) {
  test(`desktop ${runtime} keeps input semantics on narrow load and resize`, async ({ page, workspaceRoot }, testInfo) => {
    // A touchscreen attached to a mouse-driven desktop must not select phone input.
    await page.addInitScript(() => Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 5 }))
    await page.setViewportSize({ width: 390, height: 844 })
    const response = await page.request.post('/farming/api/control/agents', {
      data: { command: runtime === 'chat' ? 'codex' : 'bash', workspace: workspaceRoot, agentRuntimeMode: runtime },
    })
    expect(response.ok()).toBeTruthy()
    const { agentId } = await response.json() as { agentId: string }
    const sent: string[] = []
    await page.routeWebSocket(/\/farming\/ws(?:\?|$)/, socket => {
      const server = socket.connectToServer()
      socket.onMessage(raw => {
        const message = JSON.parse(String(raw)) as { type: string; agentId?: string }
        if ((message.type === 'composer-input' || message.type === 'input') && message.agentId === agentId) sent.push(String(raw))
        server.send(raw)
      })
      server.onMessage(raw => socket.send(raw))
    })
    await openFarming(page)
    await page.getByTestId('code-mobile-menu').click()
    await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
    const prefix = runtime === 'chat' ? 'code-acp-composer' : 'code-composer'
    const input = page.getByTestId(`${prefix}-input`)
    await expect(input).toBeEditable()
    const original = await input.elementHandle()
    try {
      for (const width of [390, 900, 767, 768, 390]) {
        await input.fill('Preserve draft and selection')
        await selectText(input, 3, 8)
        await page.setViewportSize({ width, height: 844 })
        await expectValue(input, 'Preserve draft and selection')
        expect(await selection(input)).toEqual([3, 8])
        expect(await original?.evaluate(element => element.isConnected)).toBe(true)
        await expect(input).toHaveAttribute('enterkeyhint', 'send')
        const before = sent.length
        await input.fill('First line')
        await input.press('End')
        await input.press('Shift+Enter')
        await expectValue(input, 'First line\n')
        await input.dispatchEvent('compositionstart', { data: '' })
        await input.dispatchEvent('keydown', { key: 'Enter', isComposing: true, keyCode: 229 })
        await input.dispatchEvent('compositionend', { data: '' })
        await expectValue(input, 'First line\n')
        expect(sent).toHaveLength(before)
        // The subsequent submit is independent of the IME confirmation guard.
        await page.waitForTimeout(150)
        await input.fill(runtime === 'chat' ? `image attachment responsive input ${width}` : `printf 'RESPONSIVE_${width}\\n'`)
        await input.press('Enter')
        await expectValue(input, '')
        await expect.poll(() => sent.length).toBe(before + 1)
      }
      await page.getByTestId('code-mobile-menu').click()
      await page.getByTestId('code-sidebar-pin-toggle').click()
      await page.keyboard.press('Escape')
      await expect(page.getByTestId('code-workspace')).toHaveClass(/pinned-sidebar-rail/)
      const expectComposerWithinMain = async () => {
        await expect.poll(async () => page.getByTestId(`${prefix}-send`).evaluate(element => {
          const send = element.getBoundingClientRect()
          const composer = element.closest('.code-composer')!.getBoundingClientRect()
          const main = element.closest('.code-main')!.getBoundingClientRect()
          return composer.left >= main.left && composer.right <= main.right + 1
            && send.left >= composer.left && send.right <= composer.right + 1
        })).toBe(true)
      }
      const toggle = page.getByTestId('code-composer-editor-toggle')
      for (const appearance of ['light', 'dark', 'paper']) {
        await page.evaluate(value => {
          document.body.dataset.appearance = value
          document.documentElement.dataset.appearance = value
        }, appearance)
        await input.fill('Narrow desktop draft')
        await expectComposerWithinMain()
        await toggle.click()
        await expect(toggle).toHaveAttribute('aria-expanded', 'true')
        await expectComposerWithinMain()
        await expect(input).toHaveAttribute('enterkeyhint', 'send')
        await page.screenshot({ path: testInfo.outputPath(`${runtime}-${appearance}-expanded.png`), animations: 'disabled' })
        await input.fill(runtime === 'chat' ? 'image attachment expanded desktop input' : "printf 'EXPANDED_DESKTOP\\n'")
        const before = sent.length
        await input.press('Enter')
        await expectValue(input, '')
        await expect.poll(() => sent.length).toBe(before + 1)
        await expect(toggle).toHaveAttribute('aria-expanded', 'false')
      }
      const session = await page.context().newCDPSession(page)
      try {
        await session.send('Emulation.setTouchEmulationEnabled', { enabled: true })
        await expect(input).toHaveAttribute('enterkeyhint', 'enter')
        const before = sent.length
        for (const width of [390, 1280]) {
          await page.setViewportSize({ width, height: 844 })
          await input.fill('Touch draft')
          await input.press('End')
          await input.press('Enter')
          await expectValue(input, 'Touch draft\n')
          await expect(input).toHaveAttribute('enterkeyhint', 'enter')
          expect(sent).toHaveLength(before)
        }
        await session.send('Emulation.setTouchEmulationEnabled', { enabled: false })
        await expect(input).toHaveAttribute('enterkeyhint', 'send')
        await expectValue(input, 'Touch draft\n')
      } finally {
        await session.detach()
      }
    } finally {
      await original?.dispose()
    }
  })
}

test('file word-wrap preference survives narrow load, resize and toggling', async ({ page, workspaceRoot }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const source = 'A long editable line with spaces. '.repeat(12)
  fs.writeFileSync(path.join(workspaceRoot, 'wrapping.txt'), source)
  const response = await page.request.post('/farming/api/control/agents', {
    data: { command: 'bash', workspace: workspaceRoot },
  })
  expect(response.ok()).toBeTruthy()
  await openFarming(page)
  await page.getByTestId('code-mobile-menu').click()
  const files = page.getByTestId('code-files-section')
  const title = files.locator('.code-files-title')
  if (await title.getAttribute('aria-expanded') !== 'true') await title.click()
  await files.locator('[data-file-path="wrapping.txt"]').click()
  const editor = page.getByTestId('code-file-editor')
  const lines = editor.locator('.view-lines .view-line')
  const more = page.getByTestId('code-file-editor-more')
  const wrapMenu = page.getByRole('menuitemcheckbox', { name: /word wrap/i })
  await expect(lines).toHaveCount(1)
  for (const appearance of ['light', 'dark', 'paper']) {
    await page.evaluate(value => {
      document.body.dataset.appearance = value
      document.documentElement.dataset.appearance = value
    }, appearance)
    await more.click()
    await expect(wrapMenu).toHaveAttribute('aria-checked', 'false')
    await wrapMenu.click()
    await expect.poll(() => lines.count()).toBeGreaterThan(1)
    await page.screenshot({ path: testInfo.outputPath(`wrap-on-${appearance}.png`), animations: 'disabled' })
    await more.click()
    await expect(wrapMenu).toHaveAttribute('aria-checked', 'true')
    await wrapMenu.click()
    await expect(lines).toHaveCount(1)
    await page.screenshot({ path: testInfo.outputPath(`wrap-off-${appearance}.png`), animations: 'disabled' })
  }
  for (const width of [900, 767, 768, 390]) {
    await page.setViewportSize({ width, height: 844 })
    await expect(lines).toHaveCount(1)
    expect(await page.evaluate(() => window.__farmingFileEditorTest?.getValue())).toBe(source)
  }
})
