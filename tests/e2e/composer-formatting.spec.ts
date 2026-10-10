import type { Locator } from '@playwright/test'
import { expect, openFarming, test } from './fixtures'

// Independent clipboard/Markdown expectations: never derive the oracle from the converter.
const formats = [
  { name: 'emphasis', text: '斜体说明 italic 🐱', html: '<em>斜体说明 italic 🐱</em>', markdown: '*斜体说明 italic 🐱*', tokens: ['emphasis'] },
  { name: 'quote', text: '保留引用第一行\nSecond quoted line', html: '<blockquote>保留引用第一行<br>Second quoted line</blockquote>', markdown: '> 保留引用第一行\n> Second quoted line', tokens: ['quote'] },
  { name: 'headings-inline', text: 'Migration 迁移\nImportant and careful with query docs', html: '<h2>Migration 迁移</h2><p><strong>Important</strong> and <em>careful</em> with <code>query</code> <a href="https://example.com/docs">docs</a></p>', markdown: '## Migration 迁移\n\n**Important** and *careful* with ` query ` [docs](<https://example.com/docs>)', tokens: ['section', 'strong', 'emphasis', 'code', 'link'] },
  { name: 'nested-lists', text: 'Parent\nChild 中文\nNext\nOrdered\nLast', html: '<ul><li>Parent<ul><li>Child 中文</li></ul></li><li>Next</li></ul><ol start="3"><li>Ordered</li><li>Last</li></ol>', markdown: '- Parent\n  - Child 中文\n- Next\n\n3. Ordered\n4. Last', tokens: ['bullet'] },
  { name: 'code', text: 'const title = "你好 🐱";\n\n\n\tconsole.log(title);', html: '<pre><code class="language-typescript">const title = &quot;你好 🐱&quot;;\n\n\n\tconsole.log(title);</code></pre>', markdown: '```typescript\nconst title = "你好 🐱";\n\n\n\tconsole.log(title);\n```', tokens: ['keyword', 'string'] },
  { name: 'mixed-wrap', text: 'Review\nRead carefully\nSELECT name FROM demo;\n检查中文与 emoji 🐱 的换行。This long sentence must wrap without shifting the caret or clipping the final characters.', html: '<h3>Review</h3><blockquote>Read <strong>carefully</strong></blockquote><pre data-language="sql">SELECT name FROM demo;</pre><p>检查中文与 emoji 🐱 的换行。This long sentence must wrap without shifting the caret or clipping the final characters.</p>', markdown: '### Review\n\n> Read **carefully**\n\n```sql\nSELECT name FROM demo;\n```\n\n检查中文与 emoji 🐱 的换行。This long sentence must wrap without shifting the caret or clipping the final characters.', tokens: ['section', 'quote', 'strong', 'keyword'] },
] as const

async function paste(input: Locator, text: string, html: string) {
  return input.evaluate((element, data) => {
    const clipboard = new DataTransfer()
    clipboard.setData('text/plain', data.text)
    clipboard.setData('text/html', data.html)
    return !element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: clipboard, bubbles: true, cancelable: true }))
  }, { text, html })
}

for (const mode of ['chat', 'terminal'] as const) {
  test(`${mode} formatted clipboard visual matrix preserves readable structure`, async ({ page, workspaceRoot, isMobile }) => {
    test.setTimeout(120_000)
    await page.request.post('/farming/api/settings', { data: { language: 'en' } })
    const response = await page.request.post('/farming/api/control/agents', {
      data: { command: mode === 'chat' ? 'codex' : 'bash', workspace: workspaceRoot, agentRuntimeMode: mode },
    })
    expect(response.ok()).toBeTruthy()
    const { agentId } = await response.json() as { agentId: string }
    await openFarming(page)
    if (isMobile) await page.getByTestId('code-mobile-menu').click()
    await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
    const prefix = mode === 'chat' ? 'code-acp-composer' : 'code-composer'
    const input = page.getByTestId(`${prefix}-input`)
    const highlight = page.getByTestId('code-composer-draft-highlight')
    await expect(input).toBeEditable()
    if (isMobile) await page.getByTestId('code-composer-editor-toggle').click()
    await page.evaluate(() => document.fonts.ready)

    for (const sample of formats) {
      await test.step(sample.name, async () => {
        await input.fill('')
        expect(await paste(input, sample.text, sample.html)).toBe(true)
        await expect(input).toHaveValue(sample.markdown)
        await expect(highlight).toBeVisible()
        expect(await highlight.textContent()).toBe(sample.markdown + '\n')
        for (const token of sample.tokens) await expect(highlight.locator(`.hljs-${token}`).first()).toBeAttached()
        await expect(highlight).toHaveAttribute('aria-hidden', 'true')
        await expect(highlight).toHaveCSS('pointer-events', 'none')
        // Color decoration must never change glyph metrics or native hit testing.
        expect(await highlight.locator('span').evaluateAll(spans => spans.every(span => {
          const token = getComputedStyle(span), base = getComputedStyle(span.closest('pre')!)
          return token.font === base.font && token.letterSpacing === base.letterSpacing
        }))).toBe(true)
        for (const appearance of ['light', 'dark', 'paper']) {
          await page.evaluate(value => { document.body.dataset.appearance = value; document.documentElement.dataset.appearance = value }, appearance)
          await input.evaluate(element => { element.setSelectionRange(0, 0); element.scrollTop = 0; element.blur() })
          await expect.poll(() => highlight.evaluate(element => element.scrollTop)).toBe(0)
          await expect(input).toHaveScreenshot(`${mode}-${sample.name}-${appearance}-top.png`, { maxDiffPixels: 20 })
          const overflow = await input.evaluate(element => element.scrollHeight > element.clientHeight + 1)
          if (overflow) {
            await input.evaluate(element => { element.scrollTop = element.scrollHeight })
            await expect.poll(() => highlight.evaluate(element => element.scrollTop)).toBe(await input.evaluate(element => element.scrollTop))
            await expect(input).toHaveScreenshot(`${mode}-${sample.name}-${appearance}-bottom.png`, { maxDiffPixels: 20 })
          }
          if (isMobile) {
            const toggle = page.getByTestId('code-composer-editor-toggle')
            await toggle.click()
            await expect(toggle).toHaveAttribute('aria-expanded', 'false')
            await input.evaluate(element => { element.scrollTop = 0; element.blur() })
            await expect.poll(() => highlight.evaluate(element => element.scrollTop)).toBe(0)
            await expect(input).toHaveScreenshot(`${mode}-${sample.name}-${appearance}-compact.png`, { maxDiffPixels: 20 })
            await toggle.click()
            await expect(toggle).toHaveAttribute('aria-expanded', 'true')
          }
          const bounds = (await input.boundingBox())!
          expect(bounds.width).toBeGreaterThan(250)
          expect(bounds.x).toBeGreaterThanOrEqual(0)
          expect(bounds.x + bounds.width).toBeLessThanOrEqual(page.viewportSize()!.width)
        }
        // The rendered string and editable string remain identical after a real edit.
        await input.focus()
        await input.evaluate(element => element.setSelectionRange(element.value.length, element.value.length))
        await page.keyboard.insertText(' END')
        await expect(input).toHaveValue(sample.markdown + ' END')
        expect(await highlight.textContent()).toBe(sample.markdown + ' END\n')
      })
    }

    await test.step('unsupported table retains original row and column separators', async () => {
      await input.fill('Keep draft')
      expect(await paste(input, 'Name\tValue\nA\tB', '<table><tr><th><b>Name</b></th><th>Value</th></tr><tr><td>A</td><td>B</td></tr></table>')).toBe(false)
      await expect(input).toHaveValue('Keep draft')
      const rows = Array.from({ length: 80 }, (_, index) => `item ${index}\t保留单元格 ${index}`)
      const text = 'Name\tValue\n' + rows.join('\n')
      const html = '<table><tr><th><b>Name</b></th><th>Value</th></tr>' + rows.map(row => '<tr>' + row.split('\t').map(cell => `<td>${cell}</td>`).join('') + '</tr>').join('') + '</table>'
      await input.fill('')
      expect(await paste(input, text, html)).toBe(true)
      const card = page.getByTestId('code-composer-pasted-text')
      await expect(card).toHaveCount(1)
      await card.getByRole('button', { name: 'Show in text field' }).click()
      await expect(input).toHaveValue(text)
      await expect(highlight).toHaveCount(0)
      // Restoring text schedules a focus retry. Move focus to an existing
      // outside control so that retry preserves this explicit focus choice.
      await page.getByTestId(isMobile ? 'code-mobile-menu' : 'code-sidebar-toggle').focus()
      for (const appearance of ['light', 'dark', 'paper']) {
        await page.evaluate(value => { document.body.dataset.appearance = value; document.documentElement.dataset.appearance = value }, appearance)
        await input.evaluate(element => { element.scrollTop = 0; element.blur() })
        await expect(input).toHaveScreenshot(`${mode}-table-${appearance}.png`, { maxDiffPixels: 20 })
      }
    })
  })
}
