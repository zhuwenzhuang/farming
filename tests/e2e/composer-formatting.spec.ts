import type { Locator } from '@playwright/test'
import { expect, openFarming, test } from './fixtures'

// Independent clipboard/Markdown expectations: never derive the oracle from the converter.
const formats = [
  { name: 'emphasis', text: '斜体说明 italic 🐱', html: '<em>斜体说明 italic 🐱</em>', markdown: '*斜体说明 italic 🐱*', tokens: ['emphasis'] },
  { name: 'quote', text: '保留引用第一行\nSecond quoted line', html: '<blockquote>保留引用第一行<br>Second quoted line</blockquote>', markdown: '> 保留引用第一行\n> Second quoted line', tokens: ['quote'] },
  { name: 'headings-inline', text: 'Migration 迁移\nImportant and careful with query docs', html: '<h2>Migration 迁移</h2><p><strong>Important</strong>&nbsp;and&nbsp;<em>careful</em> with <code>query</code> <a href="https://example.com/docs">docs</a></p>', markdown: '## Migration 迁移\n\n**Important** and *careful* with `query` [docs](<https://example.com/docs>)', tokens: ['section', 'strong', 'emphasis', 'code', 'link'] },
  { name: 'nested-lists', text: 'Parent\nChild 中文\nNext\nOrdered\nLast', html: '<ul><li>Parent<ul><li>Child 中文</li></ul></li><li>Next</li></ul><ol start="3"><li>Ordered</li><li>Last</li></ol>', markdown: '- Parent\n  - Child 中文\n- Next\n\n3. Ordered\n4. Last', tokens: ['bullet'] },
  { name: 'code', text: 'const title = "你好 🐱";\n\n\n\tconsole.log(title);', html: '<pre><code class="language-typescript">const title = &quot;你好 🐱&quot;;\n\n\n\tconsole.log(title);</code></pre>', markdown: '```typescript\nconst title = "你好 🐱";\n\n\n\tconsole.log(title);\n```\n', tokens: ['keyword', 'string'] },
  { name: 'mixed-wrap', text: 'Review\nRead carefully\nSELECT name FROM demo;\n检查中文与 emoji 🐱 的换行。This long sentence must wrap without shifting the caret or clipping the final characters.', html: '<h3>Review</h3><blockquote>Read <strong>carefully</strong></blockquote><pre data-language="sql">SELECT name FROM demo;</pre><p>检查中文与 emoji 🐱 的换行。This long sentence must wrap without shifting the caret or clipping the final characters.</p>', markdown: '### Review\n\n> Read **carefully**\n\n```sql\nSELECT name FROM demo;\n```\n\n检查中文与 emoji 🐱 的换行。This long sentence must wrap without shifting the caret or clipping the final characters.', tokens: ['section', 'quote', 'strong', 'keyword'] },
  { name: 'inline-code-styled', text: '.Index/.Entries', html: '<code style="font-family: monospace">.Index/.Entries</code>', markdown: '`.Index/.Entries`', tokens: ['code'] },
  { name: 'inline-code-fragment', text: 'lookup()', html: '<span style="font-family: Menlo">lookup()</span>', markdown: '`lookup()`', tokens: ['code'] },
  { name: 'selected-code-fragment', text: 'const value = 1;\nconsole.log(value);', html: '<span class="hljs-keyword">const</span> value = <span class="hljs-number">1</span>;\nconsole.log(value);', markdown: '```\nconst value = 1;\nconsole.log(value);\n```\n', tokens: ['keyword'] },
  { name: 'copied-code-toolbar', text: 'Example\nconst value = 1;\nKeep this text.', html: '<h2>Example</h2><div class="code-markdown-code-block"><div class="code-markdown-code-toolbar"><span>javascript</span><button>Copy code</button></div><pre><code class="language-javascript">const value = 1;</code></pre></div><p>Keep this <strong>text</strong>.</p>', markdown: '## Example\n\n```javascript\nconst value = 1;\n```\n\nKeep this **text**.', tokens: ['section', 'keyword', 'strong'] },
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
  test(`${mode} formatted clipboard visual matrix preserves readable structure`, async ({ page, workspaceRoot, isMobile }, testInfo) => {
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

    await test.step('clipboard boundaries preserve emphasis, code line breaks and word spacing', async () => {
      const text = 'Review important details and examples.\nconst label = "a  b";\n\tconsole.log(label);\nContinue here.'
      const html = '<p>Review<strong> important </strong>details and<em> examples</em>.</p><pre><code class="language-javascript">const label = &quot;a  b&quot;;<br>\tconsole.log(label);</code></pre><p>Continue here.</p>'
      const markdown = 'Review **important** details and *examples*.\n\n```javascript\nconst label = "a  b";\n\tconsole.log(label);\n```\n\nContinue here.'
      await input.fill('')
      expect(await paste(input, text, html)).toBe(true)
      await expect(input).toHaveValue(markdown)
      await expect(highlight.locator('.hljs-strong')).toHaveText('**important**')
      await expect(highlight.locator('.hljs-emphasis')).toHaveText('*examples*')
      await page.keyboard.insertText(' 继续输入')
      await expect(input).toHaveValue(markdown + ' 继续输入')
      expect((await highlight.locator('span').allTextContents()).some(value => value.includes('继续输入'))).toBe(false)

      for (const appearance of ['light', 'dark', 'paper']) {
        await page.evaluate(value => { document.body.dataset.appearance = value; document.documentElement.dataset.appearance = value }, appearance)
        await input.evaluate(element => { element.scrollTop = 0; element.blur() })
        await expect.poll(() => highlight.evaluate(element => element.scrollTop)).toBe(0)
        await input.screenshot({ path: testInfo.outputPath(`boundary-${mode}-${appearance}-top.png`), animations: 'disabled' })
        if (await input.evaluate(element => element.scrollHeight > element.clientHeight + 1)) {
          await input.evaluate(element => { element.scrollTop = element.scrollHeight })
          await expect.poll(() => highlight.evaluate(element => element.scrollTop)).toBe(await input.evaluate(element => element.scrollTop))
          await input.screenshot({ path: testInfo.outputPath(`boundary-${mode}-${appearance}-bottom.png`), animations: 'disabled' })
        }
      }
      for (const draft of ['```javascript\nREPLACE\n```', '~~~~javascript\nREPLACE\n~~~~', '```javascript\nREPLACE']) {
        await input.fill(draft)
        await input.evaluate(element => {
          const start = element.value.indexOf('REPLACE')
          element.setSelectionRange(start, start + 7)
        })
        expect(await paste(input, 'const value = 1;', '<pre><code class="language-javascript">const value = 1;</code></pre>')).toBe(false)
        await expect(input).toHaveValue(draft)
      }

      await input.fill('Keep draft')
      // Whitespace is not disposable: accepting this HTML would join two words.
      expect(await paste(input, 'one two', '<strong>onetwo</strong>')).toBe(false)
      await expect(input).toHaveValue('Keep draft')
      expect(await paste(input, 'Example\nconst label = "a  b";', '<p>Example</p><pre>const label = "a b";</pre>')).toBe(false)
      await expect(input).toHaveValue('Keep draft')
    })

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
        if (sample.name.includes('code')) expect((await highlight.locator('span').allTextContents()).some(text => text.includes(' END'))).toBe(false)
      })
    }

    await test.step('block paste into a sentence isolates both fences and preserves native undo', async () => {
      await input.fill('Before REPLACE after')
      // Begin from a persisted draft, independent of each engine's grouping
      // of programmatic fill with the preceding matrix edits.
      await expect.poll(() => page.evaluate(() => localStorage.getItem('farming.code.agentComposerCheckpoint.v1'))).toContain('Before REPLACE after')
      await page.reload()
      await expect(input).toHaveValue('Before REPLACE after')
      if (isMobile) await page.getByTestId('code-composer-editor-toggle').click()
      await input.focus()
      await input.evaluate(element => element.setSelectionRange(7, 14))
      expect(await paste(input, 'const value = 1;', '<pre><code class="language-javascript">const value = 1;</code></pre>')).toBe(true)
      await expect(input).toHaveValue('Before \n```javascript\nconst value = 1;\n```\n after')
      await page.keyboard.press('ControlOrMeta+z')
      await expect(input).toHaveValue('Before REPLACE after')
      await page.keyboard.press('ControlOrMeta+Shift+z')
      await expect(input).toHaveValue('Before \n```javascript\nconst value = 1;\n```\n after')
      await page.keyboard.insertText('继续说明')
      await expect(input).toHaveValue('Before \n```javascript\nconst value = 1;\n```\n继续说明 after')
      expect((await highlight.locator('span').allTextContents()).some(text => text.includes('继续说明'))).toBe(false)
    })

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

// Use the browser's real clipboard export from rendered Chat, including computed
// styles and selection fragments that a hand-authored HTML fixture can miss.
test('native Chat copy and paste preserves inline, block and mixed selections', async ({ page, workspaceRoot, isMobile }, testInfo) => {
  test.skip(isMobile, 'Native clipboard keyboard roundtrip uses desktop Chromium')
  const response = await page.request.post('/farming/api/control/agents', {
    data: { command: 'codex', workspace: workspaceRoot, agentRuntimeMode: 'chat' },
  })
  expect(response.ok()).toBeTruthy()
  const { agentId } = await response.json() as { agentId: string }
  await openFarming(page)
  await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
  const input = page.getByTestId('code-acp-composer-input')
  const markdown = '## Example\n\nInspect `.Index/.Entries` carefully.\n\n```javascript\nconst value = 1;\nconsole.log(value);\n```\n\nKeep this **text**.'
  await input.fill('markdown image response\n' + markdown)
  await page.getByTestId('code-acp-composer-send').click()
  const answer = page.locator('.code-agent-transcript-assistant').last()
  await expect(answer.locator('pre code')).toContainText('console.log(value);')
  const highlight = page.getByTestId('code-composer-draft-highlight')
  for (const selection of ['inline', 'block', 'mixed', 'inside-code'] as const) {
    await input.fill(selection === 'inside-code' ? '```javascript\n\n```' : '')
    const source = selection === 'inline' ? answer.locator('p code') : selection === 'block' || selection === 'inside-code' ? answer.locator('pre code') : answer
    await input.blur()
    await source.evaluate(element => {
      const range = document.createRange()
      range.selectNodeContents(element)
      window.getSelection()!.removeAllRanges()
      window.getSelection()!.addRange(range)
    })
    await page.keyboard.press('ControlOrMeta+c')
    await input.focus()
    if (selection === 'inside-code') await input.evaluate(element => element.setSelectionRange(14, 14))
    await page.keyboard.press('ControlOrMeta+v')
    if (selection === 'inside-code') {
      await expect(input).toHaveValue('```javascript\nconst value = 1;\nconsole.log(value);\n```')
      await page.keyboard.insertText(' // continued')
      await expect(input).toHaveValue('```javascript\nconst value = 1;\nconsole.log(value); // continued\n```')
      continue
    }
    if (selection === 'inline') await expect(input).toHaveValue('`.Index/.Entries`')
    else {
      await expect(input).toHaveValue(/```[^\n]*\nconst value = 1;\nconsole.log\(value\);\n```/)
      await expect(highlight.locator('.hljs-keyword').first()).toBeAttached()
    }
    if (selection === 'mixed') {
      await expect(input).toHaveValue(/## Example/)
      await expect(input).toHaveValue(/Keep this \*\*text\*\*\./)
      await expect(input).not.toHaveValue(/Copy code/)
    }
    const pasted = await input.inputValue()
    await page.keyboard.insertText(' 继续说明')
    await expect(input).toHaveValue(pasted + ' 继续说明')
    expect((await highlight.locator('span').allTextContents()).some(text => text.includes('继续说明'))).toBe(false)
    for (const appearance of ['light', 'dark', 'paper']) {
      await page.evaluate(value => { document.body.dataset.appearance = value; document.documentElement.dataset.appearance = value }, appearance)
      await page.screenshot({ path: testInfo.outputPath(`native-${selection}-${appearance}.png`), animations: 'disabled' })
    }
  }
})
