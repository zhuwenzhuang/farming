import fs from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { expect, openFarming, test } from './fixtures'

async function createAcpAgent(page: Page, workspace: string) {
  const response = await page.request.post('/farming/api/control/agents', {
    data: { command: 'claude', workspace, agentRuntimeMode: 'chat' },
  })
  expect(response.ok()).toBeTruthy()
  const payload = await response.json() as { agentId?: string }
  expect(payload.agentId).toBeTruthy()
  return payload.agentId as string
}

async function openCrtAcpAgent(page: Page, workspace: string) {
  await openFarming(page)
  await expect.poll(async () => {
    const response = await page.request.get('/farming/api/control/agents')
    const payload = await response.json() as { mainAgentId?: string | null }
    return payload.mainAgentId || ''
  }, { timeout: 30_000 }).not.toBe('')
  const agentId = await createAcpAgent(page, workspace)
  await page.goto(`/farming/crt/?agent=${encodeURIComponent(agentId)}`, { waitUntil: 'domcontentloaded' })
  const input = page.locator('#crt-structured-input')
  await expect(input).toBeFocused({ timeout: 30_000 })
  return input
}

test('renders CRT Agent replies as safe GFM while keeping user messages literal', async ({ page, workspaceRoot }) => {
  const workspace = path.join(workspaceRoot, 'crt-markdown')
  fs.mkdirSync(workspace, { recursive: true })
  const input = await openCrtAcpAgent(page, workspace)
  await input.fill('markdown typography **literal request**')
  await input.press('Enter')

  const transcript = page.locator('.crt-structured-transcript')
  const userMessage = transcript.locator('.crt-structured-message.user').filter({ hasText: '**literal request**' })
  const answer = transcript.locator('.crt-structured-message.assistant.crt-markdown').filter({ hasText: 'Typography baseline.' })
  await expect(answer).toBeVisible({ timeout: 20_000 })
  await expect(page.locator('.crt-structured-error')).toHaveCount(0)
  await expect(userMessage.locator('strong')).toHaveCount(0)
  await expect(userMessage).toContainText('**literal request**')

  await expect(answer.locator('pre code')).toContainText("const primary = 'code content'")
  await expect(answer.locator('pre code .hljs-keyword').first()).toHaveText('const')
  await expect(answer.locator('table th')).toHaveText(['Column', 'Value'])
  await expect(answer.locator('table td')).toHaveText(['Readability', 'Primary'])
  await expect(answer.locator('blockquote')).toContainText('Quoted reading content.')
  await expect(answer.locator('code').filter({ hasText: 'metadata' })).toBeVisible()
  await expect(answer).toHaveCSS('font-size', '14px')
  await expect(answer).toHaveCSS('line-height', '20px')
  await expect(answer.getByRole('heading', { level: 2, name: 'Readability heading' })).toHaveCSS('font-size', '18px')
  await expect(input).toHaveCSS('font-size', '14px')
  await expect(page.locator('#crt-structured-composer-status')).toHaveCSS('font-size', '12px')

  const safeLink = answer.getByRole('link', { name: 'Safe docs' })
  await expect(safeLink).toHaveAttribute('href', 'https://example.com')
  await expect(safeLink).toHaveAttribute('target', '_blank')
  await expect(safeLink).toHaveAttribute('rel', 'noreferrer noopener')
  const unsafeLink = answer.getByRole('link', { name: 'unsafe' })
  await expect(unsafeLink).not.toHaveAttribute('href', /javascript:/i)
  expect(await page.evaluate(() => (window as typeof window & { __crtMarkdownUnsafe?: boolean }).__crtMarkdownUnsafe)).toBeUndefined()

  const colors = await answer.evaluate(element => {
    const pre = element.querySelector<HTMLElement>('pre')
    const keyword = element.querySelector<HTMLElement>('.hljs-keyword')
    if (!pre || !keyword) throw new Error('Syntax highlighting fixture is incomplete')
    return {
      answer: getComputedStyle(element).color,
      keyword: getComputedStyle(keyword).color,
      pre: getComputedStyle(pre).color,
    }
  })
  expect(colors.keyword).not.toBe(colors.pre)
  expect(colors.keyword).not.toBe(colors.answer)
})

test('renders KaTeX and lazily loaded Mermaid with a bounded diagram error state', async ({ page, workspaceRoot }) => {
  const workspace = path.join(workspaceRoot, 'crt-math-mermaid')
  fs.mkdirSync(workspace, { recursive: true })
  const input = await openCrtAcpAgent(page, workspace)
  expect(await page.evaluate(() => Boolean((window as typeof window & { FarmingCrtMermaid?: unknown }).FarmingCrtMermaid))).toBe(false)

  const mermaidRuntimeResponse = page.waitForResponse(response => (
    response.url().endsWith('/farming/crt/crt-mermaid-renderer.js') && response.status() === 200
  ))
  await input.fill('crt math mermaid')
  await input.press('Enter')
  await mermaidRuntimeResponse

  const answer = page.locator('.crt-structured-message.assistant.crt-markdown')
    .filter({ hasText: 'Formula and diagram baseline.' })
  await expect(answer).toBeVisible({ timeout: 20_000 })
  await expect(answer.locator('.katex').first()).toBeVisible()
  await expect(answer.locator('.katex-display')).toBeVisible()
  await expect(answer.locator('annotation[encoding="application/x-tex"]')).toHaveText([
    'E = mc^2',
    String.raw`\int_0^1 x^2\,dx = \frac{1}{3}`,
  ])
  const mermaidFigure = answer.locator('.crt-markdown-mermaid')
  await expect(mermaidFigure.locator('svg')).toBeVisible({ timeout: 20_000 })
  await expect(mermaidFigure).toContainText('Plan')
  await expect(mermaidFigure).toContainText('Build')
  await expect(mermaidFigure.locator('[href^="javascript:"]')).toHaveCount(0)
  expect(await page.evaluate(() => Boolean((window as typeof window & { FarmingCrtMermaid?: unknown }).FarmingCrtMermaid))).toBe(true)

  const formulaFont = await answer.locator('.katex').first().evaluate(element => getComputedStyle(element).fontFamily)
  expect(formulaFont).toContain('KaTeX_Main')
  await page.evaluate(() => document.fonts.load('16px KaTeX_Main'))
  expect(await page.evaluate(() => document.fonts.check('16px KaTeX_Main'))).toBe(true)

  await input.fill('crt invalid mermaid')
  await input.press('Enter')
  const invalidAnswer = page.locator('.crt-structured-message.assistant.crt-markdown')
    .filter({ hasText: 'Invalid diagram baseline.' })
  const errorFigure = invalidAnswer.locator('.crt-markdown-mermaid.error')
  await expect(errorFigure).toBeVisible({ timeout: 20_000 })
  await expect(errorFigure.locator('figcaption')).toHaveText('DIAGRAM ERROR')
  await expect(errorFigure.locator('code.language-mermaid')).toContainText('this is not a diagram')
  await expect(page.locator('.crt-structured-error')).toHaveCount(0)
})
