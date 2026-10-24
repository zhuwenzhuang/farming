import { expectValue, selectText } from './composer-test-input'
import fs from 'node:fs'
import path from 'node:path'
import type { Locator } from '@playwright/test'
import { expect, openFarming, terminalCheckpointOutput, test } from './fixtures'

const documentText = '# Migration review\n' + '检查迁移计划、权限与回滚路径。 Keep the entire source.\n'.repeat(180) + 'END_OF_PASTED_DOCUMENT'

async function paste(input: Locator, text = documentText, html = '') {
  return input.evaluate((element, value) => {
    const data = new DataTransfer()
    data.setData('text/plain', value.text)
    if (value.html) data.setData('text/html', value.html)
    return !element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  }, { text, html })
}

for (const mode of ['chat', 'terminal'] as const) {
  test(`${mode} long paste supports preview, restore, recovery and complete submission`, async ({ page, workspaceRoot }, testInfo) => {
    const workspace = path.join(workspaceRoot, `long-paste-${mode}`)
    fs.mkdirSync(workspace, { recursive: true })
    await page.request.post('/farming/api/settings', { data: { language: 'en' } })
    const response = await page.request.post('/farming/api/control/agents', {
      data: { command: 'codex', workspace, agentRuntimeMode: mode },
    })
    expect(response.ok()).toBeTruthy()
    const { agentId } = await response.json() as { agentId: string }
    const sent: string[] = []
    await page.routeWebSocket(/\/farming\/ws(?:\?|$)/, socket => {
      const server = socket.connectToServer()
      socket.onMessage(message => {
        const payload = JSON.parse(String(message)) as { type: string; text?: string }
        if (payload.type === 'composer-input' || payload.type === 'input') sent.push(JSON.stringify(payload))
        server.send(message)
      })
      server.onMessage(message => socket.send(message))
    })
    await openFarming(page)
    await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
    const input = page.getByTestId(mode === 'chat' ? 'code-acp-composer-input' : 'code-composer-input')
    const send = page.getByTestId(mode === 'chat' ? 'code-acp-composer-send' : 'code-composer-send')
    await expect(input).toBeEditable()
    await input.fill('Review this')
    if (mode === 'chat') {
      await selectText(input)
      expect(await paste(input, ' short text')).toBe(true)
      await expectValue(input, 'Review this short text')
      expect(await paste(input, 'x'.repeat(250_001), '<p>oversized</p>')).toBe(true)
      await expect(page.getByRole('alert')).toContainText('Pasted content is too large')
      await expectValue(input, 'Review this short text')
      await input.fill('Review this')
      await selectText(input)
      expect(await paste(input, documentText, `<pre>${documentText}</pre>`)).toBe(true)
      await expect(input.locator('pre code')).toHaveText(documentText)
      await expect(page.getByTestId('code-composer-pasted-text')).toHaveCount(0)
      expect(sent).toHaveLength(0)
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 844 })
        for (const appearance of ['light', 'dark', 'paper']) {
          await page.evaluate(value => { document.body.dataset.appearance = value; document.documentElement.dataset.appearance = value }, appearance)
          await expect(send).toBeInViewport()
          const bounds = await input.locator('..').boundingBox()
          expect(bounds!.x).toBeGreaterThanOrEqual(0)
          expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width)
          await page.screenshot({ path: testInfo.outputPath(`chat-${width}-${appearance}.png`), animations: 'disabled' })
        }
      }
      await page.reload()
      await expect(input.locator('pre code')).toHaveText(documentText)
      await send.click()
      await expectValue(input, '')
      await expect.poll(() => sent.length).toBe(1)
      expect(sent[0]).toContain(JSON.stringify(documentText).slice(1, -1))
      expect(sent[0]).toContain('"type":"composer-input"')
      expect(sent[0]).toContain('"type":"codeBlock"')
      await expect(page.getByTestId('code-user-document').locator('pre code')).toHaveText(documentText)
      return
    }
    expect(await paste(input, 'short text')).toBe(false)
    expect(await paste(input, 'x'.repeat(250_001))).toBe(true)
    await expect(page.getByText('Pasted text exceeds 250,000 characters. Split it into smaller documents before pasting.', { exact: true })).toBeVisible()
    await expect(input).toHaveValue('Review this')
    await expect(page.getByTestId('code-composer-pasted-text')).toHaveCount(0)
    await expect(page.getByText('Pasted text exceeds 250,000 characters. Split it into smaller documents before pasting.', { exact: true })).toBeHidden()
    expect(await paste(input)).toBe(true)
    await expect(input).toHaveValue('Review this')
    const cards = page.getByTestId('code-composer-pasted-text')
    await expect(cards).toHaveCount(1)
    expect(sent).toHaveLength(0)
    await cards.locator('summary').click()
    expect(await cards.locator('pre').textContent()).toBe(documentText)
    await cards.locator('summary').click()

    for (const [layout, viewport] of [
      ['desktop', { width: 1440, height: 900 }], ['compact', { width: 390, height: 844 }],
    ] as const) {
      await page.setViewportSize(viewport)
      for (const appearance of ['light', 'dark', 'paper']) {
        await page.evaluate(value => {
          document.body.dataset.appearance = value
          document.documentElement.dataset.appearance = value
        }, appearance)
        const restore = cards.getByRole('button', { name: 'Show in text field' })
        await expect(restore).toBeInViewport()
        await expect(send).toBeInViewport()
        const box = (await cards.boundingBox())!
        expect(box.x).toBeGreaterThanOrEqual(0)
        expect(box.x + box.width).toBeLessThanOrEqual(viewport.width)
        await page.screenshot({ path: testInfo.outputPath(`${mode}-${layout}-${appearance}.png`), animations: 'disabled' })
        await cards.locator('summary').click()
        await expect(cards.locator('pre')).toBeVisible()
        await page.screenshot({ path: testInfo.outputPath(`${mode}-${layout}-${appearance}-expanded.png`), animations: 'disabled' })
        await cards.locator('summary').click()
      }
    }
    await page.setViewportSize({ width: 1440, height: 900 })
    await cards.getByRole('button', { name: 'Show in text field' }).click()
    await expect(cards).toHaveCount(0)
    await expect(input).toHaveValue('Review this\n\n' + documentText)
    await input.fill('Review this')
    await paste(input)
    await paste(input)
    await expect(cards).toHaveCount(2)
    await cards.first().getByRole('button', { name: 'Remove # Migration review' }).click()
    await expect(cards).toHaveCount(1)
    await expect.poll(() => page.evaluate(() => localStorage.getItem('farming.code.agentComposerCheckpoint.v1'))).toContain('END_OF_PASTED_DOCUMENT')
    await page.reload()
    await expect(cards).toHaveCount(1)
    await expect(input).toHaveValue('Review this')
    await cards.locator('summary').click()
    expect(await cards.locator('pre').textContent()).toBe(documentText)
    await send.click()
    await expect(input).toHaveValue('')
    await expect(cards).toHaveCount(0)
    if (mode === 'terminal' && await page.getByTestId('code-pending-followup-send-next').count()) {
      await page.getByTestId('code-pending-followup-send-next').click()
    }
    await expect.poll(() => sent.length).toBe(1)
    expect(sent[0]).toContain('END_OF_PASTED_DOCUMENT')
    expect(sent[0]).toContain('reference material')
    expect(sent[0]).toContain(JSON.stringify(documentText).slice(1, -1))
    if (mode === 'terminal') await expect.poll(() => terminalCheckpointOutput(page, agentId)).toContain('END_OF_PASTED_DOCUMENT')
  })
}

test('side chat owns its pasted document separately from the parent draft', async ({ page, workspaceRoot }) => {
  const workspace = path.join(workspaceRoot, 'side-long-paste')
  fs.mkdirSync(workspace, { recursive: true })
  await page.request.post('/farming/api/settings', { data: { language: 'en' } })
  const response = await page.request.post('/farming/api/control/agents', { data: { command: 'codex', workspace, agentRuntimeMode: 'chat' } })
  const { agentId } = await response.json() as { agentId: string }
  await openFarming(page)
  await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
  const parent = page.locator('.code-composer-shell').getByTestId('code-acp-composer-input')
  await parent.fill('image attachment parent context')
  await page.getByTestId('code-acp-composer-send').click()
  await expect(page.getByTestId('code-agent-chat-view')).toContainText('Received 0 image.')
  await parent.fill('/side')
  await page.getByTestId('code-acp-composer-send').click()
  const pane = page.getByTestId('code-subagent-panel')
  await expect(pane).toBeVisible()
  await parent.fill('Keep parent draft')
  const child = pane.getByTestId('code-acp-composer-input')
  await child.fill('Review child document')
  await paste(child, documentText, `<pre><b>${documentText}</b></pre>`)
  const code = child.locator('pre code')
  await expect(code).toHaveText(documentText)
  await expect(pane.getByTestId('code-composer-pasted-text')).toHaveCount(0)
  await expect(parent).toHaveText('Keep parent draft')
  await child.fill('Review child document')
  await paste(child, documentText, `<pre><b>${documentText}</b></pre>`)
  await pane.getByTestId('code-acp-composer-send').click()
  await expect(child).toHaveText('')
  await expect(pane.locator('.code-agent-transcript-user').last()).toContainText('END_OF_PASTED_DOCUMENT')
  await expect(parent).toHaveText('Keep parent draft')
})

for (const mode of ['chat', 'terminal'] as const) {
  test(`${mode} formatted paste preserves source ink and native selection across appearances`, async ({ page, workspaceRoot }, testInfo) => {
    const workspace = path.join(workspaceRoot, `formatted-paste-${mode}`)
    fs.mkdirSync(workspace, { recursive: true })
    await page.request.post('/farming/api/settings', { data: { language: 'en' } })
    const response = await page.request.post('/farming/api/control/agents', { data: { command: 'codex', workspace, agentRuntimeMode: mode } })
    const { agentId } = await response.json() as { agentId: string }
    await openFarming(page)
    await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
    const input = page.getByTestId(mode === 'chat' ? 'code-acp-composer-input' : 'code-composer-input')
    await expect(input).toBeEditable()
    await input.fill('Review this code')
    const comments = '  // Preserve source indentation and formatting.\r\n'.repeat(30)
    const code = 'public static String message() {\r\n  return "Hello 🐱";\r\n' + comments + '}'
    const html = '<div class="code-markdown-code-toolbar"><span>java</span><button>Copy code</button></div><pre data-language="java" style="font-family: monospace; color: #eeeeee"><b style="color: #ab47bc">public static</b> String message() {\n  <span style="color: #ab47bc">return</span> <i style="color: #008800">&quot;Hello 🐱&quot;</i>;\n' + comments + '}</pre>'
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
    // External elements must never be mounted or loaded.
    const requests: string[] = []
    page.on('request', request => { if (request.url().includes('clipboard-probe.invalid')) requests.push(request.url()) })
    expect(await paste(input, code, html + '<img src="https://clipboard-probe.invalid/a" onerror="window.clipboardExecuted=true"><script>window.clipboardExecuted=true</script>')).toBe(true)
    const card = page.getByTestId('code-composer-pasted-text')
    if (mode === 'chat') {
      const literal = code.replace(/\r\n/g, '\n')
      await expect(card).toHaveCount(0)
      await expect(input.locator('pre code')).toHaveText(literal)
      await expect(input.locator('img,script,iframe')).toHaveCount(0)
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 844 })
        for (const appearance of ['light', 'dark', 'paper']) {
          await page.evaluate(value => { document.body.dataset.appearance = value; document.documentElement.dataset.appearance = value }, appearance)
          const content = input.locator('pre code')
          await expect(content).toHaveCSS('white-space', 'pre-wrap')
          await page.screenshot({ path: testInfo.outputPath(`formatted-chat-${width}-${appearance}.png`), animations: 'disabled' })
        }
      }
      expect(requests).toEqual([])
      expect(await page.evaluate(() => Reflect.get(window, 'clipboardExecuted'))).toBeUndefined()
      await page.reload()
      await expect(input.locator('pre code')).toHaveText(literal)
      await input.fill('Before REPLACE after')
      await selectText(input, 7, 14)
      expect(await paste(input, 'Important docs', '<strong>Important</strong> <a href="https://example.com/docs">docs</a>')).toBe(true)
      await expectValue(input, 'Before Important docs after')
      await expect(input.locator('strong')).toHaveText('Important')
      await expect(input.locator('a')).toHaveAttribute('href', 'https://example.com/docs')
      await page.reload()
      await expectValue(input, 'Before Important docs after')
      return
    }
    await expect(card).toHaveCount(1)
    await expect(input).toHaveValue('Review this code')
    await expect(card.locator('img,script,iframe,a')).toHaveCount(0)
    await expect(card.locator('.code-composer-quote-excerpt span').first()).toHaveCSS('font-weight', '700')
    for (const [layout, viewport] of [['desktop', { width: 1440, height: 900 }], ['compact', { width: 390, height: 844 }]] as const) {
      await page.setViewportSize(viewport)
      for (const appearance of ['light', 'dark', 'paper']) {
        await page.evaluate(value => { document.body.dataset.appearance = value; document.documentElement.dataset.appearance = value }, appearance)
        for (const expanded of [false, true]) {
          if (expanded) await card.locator('summary').click()
          const content = card.locator(expanded ? 'pre' : '.code-composer-quote-excerpt')
          await expect(content).toBeVisible()
          expect(await content.textContent()).toBe(code)
          await expect(content).toHaveCSS('user-select', 'text')
          // Drag over actual glyphs, rather than setting a synthetic DOM range.
          const firstToken = content.locator('span').first()
          await firstToken.hover()
          const box = (await firstToken.boundingBox())!
          await page.mouse.move(box.x + 1, box.y + box.height / 2)
          await page.mouse.down()
          await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 12 })
          await page.mouse.up()
          await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe('public static')
          if (layout === 'desktop' && appearance === 'light') {
            await page.keyboard.press('ControlOrMeta+c')
            await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('public static')
          }
          expect(await card.locator('details').evaluate(element => (element as HTMLDetailsElement).open)).toBe(expanded)
          await page.screenshot({ path: testInfo.outputPath(`formatted-${mode}-${layout}-${appearance}-${expanded ? 'expanded' : 'collapsed'}.png`), animations: 'disabled' })
          await page.evaluate(() => window.getSelection()?.removeAllRanges())
          if (expanded) await card.locator('summary').click()
        }
      }
    }
    expect(requests).toEqual([])
    expect(await page.evaluate(() => Reflect.get(window, 'clipboardExecuted'))).toBeUndefined()
    await expect.poll(() => page.evaluate(() => localStorage.getItem('farming.code.agentComposerCheckpoint.v1'))).toContain('textFormats')
    await page.reload()
    await expect(card.locator('.code-composer-quote-excerpt span').first()).toHaveCSS('font-weight', '700')
    await card.getByRole('button', { name: 'Show in text field' }).click()
    await expect(card).toHaveCount(0)
    // Native textarea value canonicalizes CRLF to LF.
    const restored = 'Review this code\n\n' + code.replace(/\r\n/g, '\n')
    await expect(input).toHaveValue(restored)
    await expect(page.getByTestId('code-composer-draft-highlight')).toHaveCount(0)
    for (const appearance of ['light', 'dark', 'paper']) {
      await page.evaluate(value => { document.body.dataset.appearance = value; document.documentElement.dataset.appearance = value }, appearance)
      await input.evaluate(element => { element.scrollTop = 25 })
      await page.screenshot({ path: testInfo.outputPath(`editor-${mode}-${appearance}.png`), animations: 'disabled' })
    }
    await expect.poll(() => page.evaluate(() => localStorage.getItem('farming.code.agentComposerCheckpoint.v1'))).toContain('Review this code')
    await page.reload()
    await expect(input).toHaveValue(restored)
    await expect(page.getByTestId('code-composer-draft-highlight')).toHaveCount(0)
    await input.fill('Before REPLACE after')
    await input.evaluate(element => element.setSelectionRange(7, 14))
    // Synthetic paste has no browser default insertion. It must be left native.
    expect(await paste(input, 'Important docs', '<strong>Important</strong> <a href="https://example.com/docs">docs</a>')).toBe(false)
    await expect(input).toHaveValue('Before REPLACE after')
    await input.evaluate(element => { element.dataset.plainPaste = 'true' })
    expect(await paste(input, code, html)).toBe(false)
    await expect(card).toHaveCount(0)
  })
}
