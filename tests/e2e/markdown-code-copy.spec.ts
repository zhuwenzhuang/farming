import fs from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { expect, openFarming, test } from './fixtures'

const source = '{\n  "services": {\n    "local-api": {\n      "endpoint": "127.0.0.1:31004"\n    },\n    "storage": {}\n  }\n}\n'
const markdown = `## Runtime configuration\n\nThe active configuration is [guide.md](guide.md):\n\n\`\`\`json\n${source}\`\`\`\n\nThe local API uses a fixed address; storage discovers its assigned port.\n\n\`\`\`\n  keep indentation\n\nlast line\n\`\`\`\n`

declare global {
  interface Window {
    __codeCopyTest: { writes: string[]; mode: 'success' | 'failure' | 'pending'; finish?: () => void }
  }
}

async function openCopyFixture(page: Page, workspaceRoot: string) {
  const workspace = path.join(workspaceRoot, 'code-copy-demo')
  fs.mkdirSync(workspace, { recursive: true })
  fs.writeFileSync(path.join(workspace, 'guide.md'), markdown)
  await page.addInitScript(() => {
    window.__codeCopyTest = { writes: [], mode: 'success' }
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async (text: string) => {
        const state = window.__codeCopyTest
        state.writes.push(text)
        if (state.mode === 'failure') throw new Error('Clipboard permission denied')
        if (state.mode === 'pending') await new Promise<void>(resolve => { state.finish = resolve })
      },
    } })
    document.execCommand = () => false
  })
  const response = await page.request.post('/farming/api/control/agents', {
    data: { command: 'claude', workspace, agentRuntimeMode: 'chat' },
  })
  expect(response.ok()).toBeTruthy()
  const { agentId } = await response.json() as { agentId: string }
  await openFarming(page)
  if (await page.getByTestId('code-mobile-menu').isVisible()) await page.getByTestId('code-mobile-menu').click()
  await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
  await page.getByTestId('code-acp-composer-input').fill(`markdown image response\n${markdown}`)
  await page.getByTestId('code-acp-composer-send').click()
  const answer = page.locator('.code-agent-transcript-assistant').last()
  await expect(answer.locator('.code-markdown-code-block')).toHaveCount(2)
  return answer
}

test('copies code in Chat and file previews across appearances @iphone-human', async ({ page, workspaceRoot, isMobile }, testInfo) => {
  const answer = await openCopyFixture(page, workspaceRoot)
  const chatBlock = answer.locator('.code-markdown-code-block').first()
  const chatButton = chatBlock.getByRole('button')
  await chatBlock.scrollIntoViewIfNeeded()
  await page.mouse.move(0, 0)
  await expect(chatButton).toHaveCSS('opacity', isMobile ? '1' : '0')
  const chatMetrics = await chatButton.evaluate(element => {
    const style = getComputedStyle(element)
    const icon = getComputedStyle(element.querySelector('svg')!)
    return [style.height, style.fontFamily, style.fontSize, style.lineHeight, style.borderRadius, icon.width, icon.height]
  })
  const before = await chatBlock.locator('pre').boundingBox()
  if (!isMobile) {
    await chatBlock.hover()
    await expect(chatButton).toHaveCSS('opacity', '1')
    expect(await chatBlock.locator('pre').boundingBox()).toEqual(before)
  }
  await chatButton.click()
  await expect(chatButton).toHaveAttribute('aria-label', 'Copied')
  expect(await page.evaluate(() => window.__codeCopyTest.writes)).toEqual([source])
  await page.mouse.move(0, 0)
  await expect(chatButton).toHaveCSS('opacity', '1')
  await expect(chatBlock).toHaveAttribute('data-copy-state', 'idle')
  if (!isMobile) {
    await chatButton.blur()
    await expect(chatButton).toHaveCSS('opacity', '0')
    await chatButton.focus()
    await expect(chatButton).toHaveCSS('opacity', '1')
    await page.keyboard.press('Enter')
    await expect(chatBlock).toHaveAttribute('data-copy-state', 'copied')
    await expect(chatBlock).toHaveAttribute('data-copy-state', 'idle')
    await chatButton.blur()
  }
  for (const appearance of ['light', 'dark', 'paper']) {
    await page.locator('body').evaluate((body, value) => { body.dataset.appearance = value }, appearance)
    await page.mouse.move(0, 0)
    await answer.screenshot({ path: testInfo.outputPath(`chat-${appearance}-rest.png`), animations: 'disabled' })
    if (!isMobile) await chatBlock.hover()
    await answer.screenshot({ path: testInfo.outputPath(`chat-${appearance}-copy.png`), animations: 'disabled' })
  }
  const plain = answer.locator('.code-markdown-code-block').last()
  if (!isMobile) await plain.hover()
  await plain.getByRole('button').click()
  expect(await page.evaluate(() => window.__codeCopyTest.writes.at(-1))).toBe('  keep indentation\n\nlast line\n')

  // Open the actual file viewer from the answer, including on initial mobile load.
  await answer.getByRole('link', { name: 'guide.md' }).click()
  const preview = page.getByTestId('code-file-markdown-preview')
  await expect(preview).toBeVisible()
  const fileBlock = preview.locator('.code-markdown-code-block').first()
  await fileBlock.scrollIntoViewIfNeeded()
  await page.mouse.move(0, 0)
  await expect(fileBlock.getByRole('button')).toHaveCSS('opacity', isMobile ? '1' : '0')
  const fileMetrics = await fileBlock.getByRole('button').evaluate(element => {
    const style = getComputedStyle(element)
    const icon = getComputedStyle(element.querySelector('svg')!)
    return [style.height, style.fontFamily, style.fontSize, style.lineHeight, style.borderRadius, icon.width, icon.height]
  })
  expect(fileMetrics).toEqual(chatMetrics)
  expect(fileMetrics[0]).toBe(isMobile ? '44px' : '30px')
  expect(fileMetrics[2]).toBe('12px')
  expect(fileMetrics[5]).toBe('16px')
  if (!isMobile) await fileBlock.hover()
  await fileBlock.getByRole('button').click()
  expect(await page.evaluate(() => window.__codeCopyTest.writes.at(-1))).toBe(source)
  await expect(fileBlock).toHaveAttribute('data-copy-state', 'copied')
  await expect(fileBlock).toHaveAttribute('data-copy-state', 'idle')
  for (const appearance of ['light', 'dark', 'paper']) {
    await page.locator('body').evaluate((body, value) => { body.dataset.appearance = value }, appearance)
    if (!isMobile) await fileBlock.hover()
    await preview.screenshot({ path: testInfo.outputPath(`file-${appearance}-copy.png`), animations: 'disabled' })
    const overflow = await fileBlock.evaluate(element => element.scrollWidth > element.clientWidth)
    expect(overflow).toBe(false)
  }
})

test('bounds pending copy, exposes failures, and ignores stale completions', async ({ page, workspaceRoot, isMobile }) => {
  test.skip(isMobile, 'Clipboard lifecycle is shared across layouts')
  const answer = await openCopyFixture(page, workspaceRoot)
  const block = answer.locator('.code-markdown-code-block').first()
  const button = block.getByRole('button')
  await block.hover()
  await page.evaluate(() => { window.__codeCopyTest.mode = 'failure' })
  await button.click()
  await expect(block).toHaveAttribute('data-copy-state', 'failed')
  await page.mouse.move(0, 0)
  await expect(button).toHaveCSS('opacity', '1')
  await page.evaluate(() => { window.__codeCopyTest.mode = 'pending' })
  await button.click()
  await expect(button).toBeDisabled()
  await expect(block).toHaveAttribute('data-copy-state', 'copying')
  await expect(block).toHaveAttribute('data-copy-state', 'uncertain', { timeout: 7000 })
  await page.evaluate(() => { window.__codeCopyTest.mode = 'success' })
  await button.click()
  await expect(block).toHaveAttribute('data-copy-state', 'copied')
  await page.evaluate(() => { window.__codeCopyTest.finish?.() })
  await expect(block).toHaveAttribute('data-copy-state', 'copied')
  expect(await page.evaluate(() => window.__codeCopyTest.writes)).toEqual([source, source, source])
})


test('copies a streaming snapshot while later content continues to arrive', async ({ page, workspaceRoot, isMobile }) => {
  test.skip(isMobile, 'Streaming ownership is shared across layouts')
  await openCopyFixture(page, workspaceRoot)
  await page.getByTestId('code-acp-composer-input').fill('streaming code copy')
  await page.getByTestId('code-acp-composer-send').click()
  const answer = page.locator('.code-agent-transcript-assistant').filter({ hasText: '"ready": false' })
  const block = answer.locator('.code-markdown-code-block')
  const gate = path.join(workspaceRoot, 'code-copy-demo', '.code-copy-finish')
  try {
    await expect(block.locator('pre')).toContainText('"ready": false')
    await page.evaluate(() => { window.__codeCopyTest.mode = 'pending' })
    await block.hover()
    await block.getByRole('button').click()
    await expect(block).toHaveAttribute('data-copy-state', 'copying')
    expect(await page.evaluate(() => window.__codeCopyTest.writes.at(-1))).toBe('{\n  "ready": false\n')
    fs.writeFileSync(gate, 'finish')
    await expect(block.locator('pre')).toContainText('"complete": true')
    await page.evaluate(() => { window.__codeCopyTest.finish?.() })
    await expect(block).toHaveAttribute('data-copy-state', 'copiedCurrent')
    await page.evaluate(() => { window.__codeCopyTest.mode = 'success' })
    await block.getByRole('button').click()
    await expect(block).toHaveAttribute('data-copy-state', 'copied')
    expect(await page.evaluate(() => window.__codeCopyTest.writes.at(-1))).toBe('{\n  "ready": false,\n  "complete": true\n}\n')
  } finally {
    fs.writeFileSync(gate, 'finish')
  }
})
