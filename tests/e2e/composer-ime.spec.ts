import { expect, openFarming, test } from './fixtures'
import { expectValue, selectText } from './composer-test-input'

for (const appearance of ['light', 'dark', 'paper']) {
  for (const mode of ['main', 'side']) {
    test(`unfinished IME deletion and confirmation retain composition in ${mode} Chat (${appearance})`, async ({ page, workspaceRoot, browserName }, testInfo) => {
      test.skip(browserName !== 'chromium', 'Native composition protocol injection requires Chromium CDP')
      await page.request.post('/farming/api/settings', { data: { appearance, language: 'en' } })
      const created = await page.request.post('/farming/api/control/agents', { data: { command: 'codex', workspace: workspaceRoot, agentRuntimeMode: 'chat' } })
      const { agentId } = await created.json() as { agentId: string }
      await openFarming(page)
      await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
      const main = page.locator('.code-composer-shell')
      if (mode === 'side') {
        await main.getByTestId('code-acp-composer-input').fill('/side')
        await main.getByTestId('code-acp-composer-send').click()
        await expect(page.getByTestId('code-subagent-panel')).toBeVisible()
        await main.getByTestId('code-acp-composer-input').fill('Keep parent draft')
      }
      const surface = mode === 'side' ? page.getByTestId('code-subagent-panel') : main
      const input = surface.getByTestId('code-acp-composer-input')
      const modifier = await page.evaluate(() => /Mac|iP(hone|ad|od)/.test(navigator.platform) ? 'Meta' : 'Control')
      const cdp = await page.context().newCDPSession(page)
      // Exercise browser composition, not just synthetic compositionstart + insertText.
      const compose = async (text: string) => {
        await cdp.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length })
        // Allow React's echo and scheduled caret reveal to run between IME edits.
        await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
      }
      try {
        for (const format of ['paragraph', 'list', 'code']) {
          await input.fill('')
          await input.focus()
          await input.evaluate((element, kind) => {
            const data = new DataTransfer()
            data.setData('text/plain', '前🐱 原文 后🧪')
            data.setData('text/html', kind === 'list' ? '<ul><li><p><strong>前🐱 原文 后🧪</strong></p></li></ul>' : kind === 'code' ? '<pre><code>前🐱 原文 后🧪</code></pre>' : '<p>前🐱 原文 后🧪</p>')
            element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
          }, format)
          await selectText(input, '前🐱 '.length, '前🐱 原文'.length)
          for (const spelling of ['s', 'sh', 'shu', "shu'f", "shu'fa", "shu'f", 'shu', 'sh']) {
            await compose(spelling)
            await expectValue(input, `前🐱 ${spelling} 后🧪`)
          }
          await cdp.send('Input.insertText', { text: '书法' })
          await expectValue(input, '前🐱 书法 后🧪')
          if (format === 'list') await expect(input.locator('li strong')).toHaveText('前🐱 书法 后🧪')
          if (format === 'code') await expect(input.locator('pre code')).toHaveText('前🐱 书法 后🧪')
          await page.keyboard.press(`${modifier}+z`)
          await expectValue(input, '前🐱 原文 后🧪')
          await page.keyboard.press(`${modifier}+Shift+z`)
          await expectValue(input, '前🐱 书法 后🧪')
          // Ordinary deletion resumes after confirmation and does not split emoji.
          await selectText(input)
          await page.keyboard.press('Backspace')
          await expectValue(input, '前🐱 书法 后')
          await input.fill('')
          for (const spelling of ['s', 'sh', 'shu', "shu'f", "shu'fa", "shu'f", 'shu', 'sh', 's', '']) {
            await compose(spelling)
            await expectValue(input, spelling)
          }
          await compose('shu')
          await cdp.send('Input.insertText', { text: '书' })
          await expectValue(input, '书')
        }
        if (mode === 'side') await expectValue(main.getByTestId('code-acp-composer-input'), 'Keep parent draft')
        await surface.locator('.code-composer').screenshot({ path: testInfo.outputPath(`ime-${mode}-${appearance}.png`), animations: 'disabled' })
      } finally {
        await cdp.detach()
      }
    })
  }
}
