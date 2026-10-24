import { expectValue, selectText, selection } from './composer-test-input'
import type { Locator } from '@playwright/test'
import { expect, openFarming, terminalCheckpointOutput, test } from './fixtures'

// Native Ubuntu and the Playwright image have different fontconfig defaults.
// Both install these fonts; pin only the Linux WebKit visual fixture so wrapping
// and emoji coverage do not depend on the host's generic sans-serif preference.
test.beforeEach(async ({ page, browserName }) => {
  if (process.platform !== 'linux' || browserName !== 'webkit') return
  await page.addInitScript(() => {
    document.addEventListener('DOMContentLoaded', () => {
      const style = document.createElement('style')
      style.textContent = 'body.code-mode .code-composer textarea { font-family: "WenQuanYi Zen Hei", "Noto Color Emoji", sans-serif; }'
      document.head.append(style)
    }, { once: true })
  })
})

async function typography(input: Locator) {
  return input.evaluate(element => {
    const style = getComputedStyle(element)
    return { font: style.font, color: style.color, caret: style.caretColor, opacity: style.opacity }
  })
}

for (const appearance of ['light', 'dark', 'paper'] as const) {
  for (const mode of ['chat', 'terminal', 'side'] as const) {
    test(`${mode} plain-text operation chain in ${appearance}`, async ({ page, workspaceRoot, isMobile }, testInfo) => {
      test.skip(isMobile, 'Native clipboard roundtrip is exercised on desktop; compact editing has its own matrix')
      test.setTimeout(90_000)
      await page.request.post('/farming/api/settings', { data: { language: 'en', appearance } })
      const create = async (agentRuntimeMode: 'chat' | 'terminal') => {
        const response = await page.request.post('/farming/api/control/agents', {
          data: { command: 'codex', workspace: workspaceRoot, agentRuntimeMode },
        })
        expect(response.ok()).toBeTruthy()
        return (await response.json() as { agentId: string }).agentId
      }
      const sourceId = await create('chat')
      const otherId = await create(mode === 'terminal' ? 'terminal' : 'chat')
      const sent: Array<{ type: string; message?: string; inputParts?: Array<string | { type: string; text: string }> }> = []
      await page.routeWebSocket(/\/farming\/ws(?:\?|$)/, socket => {
        const server = socket.connectToServer()
        socket.onMessage(raw => {
          const payload = JSON.parse(String(raw)) as { type: string; message?: string; inputParts?: Array<string | { type: string; text: string }> }
          if (payload.type === 'composer-input' || payload.type === 'input') sent.push(payload)
          server.send(raw)
        })
        server.onMessage(raw => socket.send(raw))
      })
      await openFarming(page)
      const select = async (id: string) => { await page.locator(`[data-testid="code-agent-row"][data-agent-id="${id}"]`).click() }
      await select(sourceId)
      const main = page.locator('.code-composer-shell')
      const sourceInput = main.getByTestId('code-acp-composer-input')
      const copied = '你看下 docker_test 和非 docker_test 的区别'
      await sourceInput.fill('markdown image response\n你看下 **`docker_test`** 和非 docker_test 的区别\n\n```javascript\nconst value = 1;\n\tconsole.log(value);\n```')
      await main.getByTestId('code-acp-composer-send').click()
      const answer = page.locator('.code-agent-transcript-assistant').last()
      const source = answer.locator('p').filter({ hasText: copied }).first()
      await expect(source).toBeVisible()
      await expect(answer.locator('pre code')).toContainText('console.log(value);')
      await sourceInput.blur()
      await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
      await source.evaluate(element => {
        const range = document.createRange()
        range.selectNodeContents(element)
        window.getSelection()!.removeAllRanges()
        window.getSelection()!.addRange(range)
      })
      await page.keyboard.press('ControlOrMeta+c')
      await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(copied)
      if (mode === 'terminal') await select(otherId)
      if (mode === 'side') {
        await sourceInput.fill('/side')
        await main.getByTestId('code-acp-composer-send').click()
        await expect(page.getByTestId('code-subagent-panel')).toBeVisible()
        await sourceInput.fill('Keep parent draft')
      }
      const surface = mode === 'side' ? page.getByTestId('code-subagent-panel') : main
      const prefix = mode === 'terminal' ? 'code-composer' : 'code-acp-composer'
      const input = surface.getByTestId(`${prefix}-input`)
      await expect(input).toBeEditable()
      const editorMod = mode === 'terminal' ? 'ControlOrMeta' : await page.evaluate(() => /Mac|iP(hone|ad|od)/.test(navigator.platform) ? 'Meta' : 'Control')
      const before = await typography(input)
      expect(before.color).not.toBe('rgba(0, 0, 0, 0)')
      expect(before.opacity).toBe('1')
      sent.length = 0
      await input.focus()
      await page.keyboard.press('ControlOrMeta+v')
      await expectValue(input, copied)
      await expect(page.getByTestId('code-composer-draft-highlight')).toHaveCount(0)
      expect(await typography(input)).toEqual(before)

      // Replace in the middle, then exercise the browser's actual undo stack.
      const start = copied.indexOf('docker_test')
      const end = start + 'docker_test'.length
      await selectText(input, start, end)
      await page.keyboard.insertText('plain_value')
      const replaced = copied.slice(0, start) + 'plain_value' + copied.slice(end)
      await expectValue(input, replaced)
      await page.keyboard.press(`${editorMod}+z`)
      await expectValue(input, copied)
      await page.keyboard.press(`${editorMod}+Shift+z`)
      await expectValue(input, replaced)
      // Composition events exercise application arbitration, not an OS candidate UI.
      await input.dispatchEvent('compositionstart', { data: '' })
      await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true, keyCode: 229 })
      expect(sent).toHaveLength(0)
      await page.keyboard.insertText('中文确认')
      await input.dispatchEvent('compositionend', { data: '中文确认' })
      // A separate newline follows the documented 120 ms IME confirmation guard.
      await page.waitForTimeout(150)
      await selectText(input)
      await page.keyboard.press('Shift+Enter')
      const suffix = '**`docker_test`** remains literal 🐱\n' + '  const value = "中文";\n\tconsole.log(value);\n'.repeat(12) + 'END_OF_DRAFT'
      await page.keyboard.insertText(suffix)
      const caret = start + 'plain_value'.length
      const draft = replaced.slice(0, caret) + '中文确认' + replaced.slice(caret) + '\n' + suffix
      await expectValue(input, draft)
      expect(await typography(input)).toEqual(before)
      expect(sent).toHaveLength(0)
      await input.evaluate(element => { (element.closest('.code-rich-input') || element).scrollTop = 0 })
      await expect(input).toHaveScreenshot(`${mode}-${appearance}-plain-top.png`)
      await input.evaluate(element => { const owner = element.closest('.code-rich-input') || element; owner.scrollTop = owner.scrollHeight })
      expect(await input.evaluate(element => (element.closest('.code-rich-input') || element).scrollTop)).toBeGreaterThan(0)
      await expect(input).toHaveScreenshot(`${mode}-${appearance}-plain-bottom.png`)
      await surface.screenshot({ path: testInfo.outputPath(`${mode}-${appearance}-composed.png`), animations: 'disabled' })
      if (mode === 'side') await expectValue(sourceInput, 'Keep parent draft')
      // Persist and switch ownership before sending the same exact snapshot.
      await expect.poll(() => page.evaluate(() => localStorage.getItem('farming.code.agentComposerCheckpoint.v1'))).toContain('END_OF_DRAFT')
      await select(mode === 'terminal' ? sourceId : otherId)
      await select(mode === 'terminal' ? otherId : sourceId)
      if (mode === 'side') {
        const parentRow = page.locator(`[data-testid="code-agent-row"][data-agent-id="${sourceId}"]`)
        await parentRow.hover()
        const disclosure = parentRow.getByTestId('code-agent-row-related-visibility')
        await expect(disclosure).toBeVisible()
        if (await disclosure.getAttribute('aria-expanded') === 'false') await disclosure.click()
        await expect(disclosure).toHaveAttribute('aria-expanded', 'true')
        await page.locator('[data-testid="code-agent-row"].related-child').click()
      }
      await expectValue(input, draft)
      if (mode !== 'side') {
        await page.reload()
        await expectValue(input, draft)
      }
      await surface.getByTestId(`${prefix}-send`).click()
      await expectValue(input, '')
      if (mode === 'terminal' && await page.getByTestId('code-pending-followup-send-next').count()) await page.getByTestId('code-pending-followup-send-next').click()
      await expect.poll(() => sent.length).toBe(1)
      if (mode === 'terminal') {
        expect(sent[0].inputParts).toEqual([{ type: 'paste', text: draft }, '\r'])
        await expect.poll(() => terminalCheckpointOutput(page, otherId)).toContain('END_OF_DRAFT')
      } else expect(sent[0].message).toBe(draft)
      if (mode === 'side') await expectValue(sourceInput, 'Keep parent draft')
    })
  }
}

for (const mode of ['chat', 'terminal'] as const) {
  test(`${mode} compact plain input and expansion preserve native editing in every appearance`, async ({ page, workspaceRoot, isMobile }) => {
    test.skip(!isMobile, 'Compact/expanded editing uses WebKit')
    await page.request.post('/farming/api/settings', { data: { language: 'en' } })
    const response = await page.request.post('/farming/api/control/agents', { data: { command: 'codex', workspace: workspaceRoot, agentRuntimeMode: mode } })
    const { agentId } = await response.json() as { agentId: string }
    await openFarming(page)
    await page.getByTestId('code-mobile-menu').click()
    await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
    const input = page.getByTestId(mode === 'chat' ? 'code-acp-composer-input' : 'code-composer-input')
    await expect(input).toBeEditable()
    const textarea = await input.elementHandle()
    const inputViewport = mode === 'chat' ? input.locator('..') : input
    const draft = '你看下**`docker_test`**和非docker_test 的区别\n' + '中文 🐱  code_value\n'.repeat(18)
    for (const appearance of ['light', 'dark', 'paper']) {
      await page.evaluate(value => { document.body.dataset.appearance = value; document.documentElement.dataset.appearance = value }, appearance)
      await input.fill('ordinary prose')
      const before = await typography(input)
      await input.fill(draft)
      expect(await typography(input)).toEqual(before)
      await expect(page.getByTestId('code-composer-draft-highlight')).toHaveCount(0)
      await input.focus()
      await selectText(input, 3, 14)
      await input.evaluate(element => { (element.closest('.code-rich-input') || element).scrollTop = 0 })
      await expect(input).toBeFocused()
      await expect.poll(() => selection(input)).toEqual([3, 14])
      await expect(inputViewport).toHaveScreenshot(`${mode}-${appearance}-compact-plain.png`)
      const toggle = page.getByTestId('code-composer-editor-toggle')
      await toggle.click()
      await expect(toggle).toHaveAttribute('aria-expanded', 'true')
      expect(await input.evaluate((element, original) => element === original, textarea)).toBe(true)
      expect(await selection(input)).toEqual([3, 14])
      await input.evaluate(element => { const owner = element.closest('.code-rich-input') || element; owner.scrollTop = owner.scrollHeight })
      await expect(inputViewport).toHaveScreenshot(`${mode}-${appearance}-expanded-plain.png`)
      await toggle.click()
      await expect(toggle).toHaveAttribute('aria-expanded', 'false')
      await expectValue(input, draft)
      await input.focus()
      await selectText(input)
      await page.keyboard.press('Enter')
      await expectValue(input, draft + '\n')
    }
  })
}
