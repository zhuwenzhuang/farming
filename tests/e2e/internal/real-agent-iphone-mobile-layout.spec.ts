import fs from 'node:fs'
import path from 'node:path'
import type { Page, TestInfo } from '@playwright/test'
import { expect, openFarming, test } from '../fixtures'

const IPHONE_VIEWPORT = { width: 390, height: 844 }
const AUDIT_DIR = path.join(process.cwd(), '.tmp', 'iphone-real-agent-audit')
const AUDIT_WORKSPACE = path.join(process.cwd(), '.tmp', 'real-agent-iphone-workspace')

type PublicAgent = {
  id: string
  command?: string
  runtimeBinding?: { kind?: string }
  status?: string
  acpState?: string
}

async function controlAgents(page: Page) {
  const response = await page.request.get('/farming/api/control/agents')
  expect(response.ok()).toBeTruthy()
  const body = await response.json() as { agents?: PublicAgent[] }
  return body.agents ?? []
}

async function waitForAgent(
  page: Page,
  agentId: string,
  predicate: (agent: PublicAgent) => boolean,
  timeout = 120_000,
) {
  await expect.poll(async () => {
    const current = (await controlAgents(page)).find(agent => agent.id === agentId)
    return Boolean(current && predicate(current))
  }, { timeout }).toBe(true)
}

async function createAgent(page: Page, command: string, runtime: 'terminal' | 'chat') {
  const response = await page.request.post('/farming/api/control/agents', {
    data: { command, workspace: AUDIT_WORKSPACE, agentRuntimeMode: runtime },
  })
  const body = await response.json() as { agentId?: string, error?: string }
  expect(response.ok(), body.error || `Failed to create real ${command} ${runtime} Agent`).toBeTruthy()
  expect(body.agentId).toBeTruthy()
  const agentId = body.agentId as string
  await waitForAgent(page, agentId, agent => (
    agent.status === 'running'
    && agent.runtimeBinding?.kind === (runtime === 'chat' ? 'acp' : 'terminal')
  ))
  return agentId
}

async function activateAgent(page: Page, agentId: string) {
  const row = page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
  await page.getByTestId('code-mobile-menu').click()
  await expect(row).toBeVisible({ timeout: 30_000 })
  await row.click()
  await expect(page.getByTestId('code-sidebar')).toHaveClass(/collapsed/)
}

async function waitForTerminal(page: Page, agentId: string) {
  await page.waitForFunction(id => Boolean(window.__farmingTerminalTest?.isReady(id)), agentId, { timeout: 60_000 })
  await expect.poll(async () => page.evaluate(
    id => window.__farmingTerminalTest?.getBufferDiagnostics(id)?.renderer ?? '',
    agentId,
  ), { timeout: 60_000 }).toBe('webgl')
  await expect(page.locator(`[data-testid="code-terminal-pane"][data-agent-id="${agentId}"]`)
    .getByTestId('code-terminal-status-card')).toHaveCount(0)
}

async function terminalRows(page: Page, agentId: string) {
  return page.evaluate(id => window.__farmingTerminalTest?.getRows(id, 10_000) ?? [], agentId)
}

function activeComposerInput(page: Page) {
  return page.locator('[data-testid="code-composer-input"]:visible, [data-testid="code-acp-composer-input"]:visible')
}

function activeComposerSend(page: Page) {
  return page.locator('[data-testid="code-composer-send"]:visible, [data-testid="code-acp-composer-send"]:visible')
}

async function sendComposerText(page: Page, text: string, useTap = true) {
  const input = activeComposerInput(page)
  if (useTap) await input.tap()
  else await input.click()
  await page.keyboard.insertText(text)
  await expect(input).toHaveValue(text)
  await page.keyboard.press('Enter')
  await expect(input).toHaveValue('')
}

async function sendLongComposerText(page: Page, text: string) {
  const input = activeComposerInput(page)
  const send = activeComposerSend(page)
  await input.tap()
  await input.fill(text)
  await expect(input).toHaveValue(text)
  await expect(send).toHaveAttribute('data-action', 'send', { timeout: 60_000 })
  expect(await send.evaluate(element => {
    const rect = element.getBoundingClientRect()
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
    return hit === element || element.contains(hit)
  })).toBe(true)
  await send.click()
  await expect(input).toHaveValue('')
}

async function waitForChatAnswer(page: Page, anchor: string, timeout = 180_000) {
  const answer = page.locator('.code-codex-transcript-assistant.code-markdown-preview')
    .filter({ hasText: anchor })
    .last()
  await expect(answer).toBeVisible({ timeout })
  await expect(activeComposerSend(page)).not.toHaveAttribute('data-action', 'interrupt', { timeout })
}

async function assertCompactVisualBounds(page: Page) {
  const metrics = await page.evaluate(() => {
    const main = document.querySelector('[data-testid="code-main"]')?.getBoundingClientRect()
    const composer = Array.from(document.querySelectorAll<HTMLElement>('.code-composer'))
      .find(element => element.getBoundingClientRect().width > 0)
      ?.getBoundingClientRect()
    if (!main || !composer) throw new Error('Compact iPhone surface is incomplete')
    return {
      viewportWidth: window.innerWidth,
      bodyScrollWidth: document.body.scrollWidth,
      rootScrollWidth: document.documentElement.scrollWidth,
      mainLeft: Math.round(main.left),
      mainRight: Math.round(main.right),
      composerLeft: Math.round(composer.left),
      composerRight: Math.round(composer.right),
      composerBottom: Math.round(composer.bottom),
      viewportHeight: window.innerHeight,
    }
  })
  expect(metrics.viewportWidth).toBe(IPHONE_VIEWPORT.width)
  expect(metrics.bodyScrollWidth).toBeLessThanOrEqual(IPHONE_VIEWPORT.width + 1)
  expect(metrics.rootScrollWidth).toBeLessThanOrEqual(IPHONE_VIEWPORT.width + 1)
  expect(metrics.mainLeft).toBe(0)
  expect(metrics.mainRight).toBe(IPHONE_VIEWPORT.width)
  expect(metrics.composerLeft).toBeGreaterThanOrEqual(4)
  expect(metrics.composerRight).toBeLessThanOrEqual(IPHONE_VIEWPORT.width - 4)
  expect(metrics.composerBottom).toBeLessThanOrEqual(metrics.viewportHeight)
}

async function capture(page: Page, testInfo: TestInfo, name: string) {
  await assertCompactVisualBounds(page)
  await page.waitForTimeout(350)
  const screenshotPath = path.join(AUDIT_DIR, name)
  await page.screenshot({
    path: screenshotPath,
    fullPage: true,
    animations: 'disabled',
    scale: 'css',
  })
  await testInfo.attach(name, { path: screenshotPath, contentType: 'image/png' })
}

test.describe('real Agent iPhone visual audit', () => {
  test.beforeAll(() => {
    if (process.env.FARMING_REAL_AGENT_IPHONE_AUDIT !== '1') {
      throw new Error('Set FARMING_REAL_AGENT_IPHONE_AUDIT=1 to run the real iPhone Agent audit')
    }
    if (process.env.FARMING_E2E_REAL_CODEX !== '1') {
      throw new Error('The real iPhone Agent audit cannot run with fake executables')
    }
    fs.mkdirSync(AUDIT_DIR, { recursive: true })
    fs.rmSync(AUDIT_WORKSPACE, { recursive: true, force: true })
    fs.mkdirSync(AUDIT_WORKSPACE, { recursive: true })
    fs.writeFileSync(path.join(AUDIT_WORKSPACE, 'README.md'), '# Real Agent iPhone visual audit\n')
    fs.writeFileSync(
      path.join(AUDIT_WORKSPACE, 'attachment.png'),
      Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=', 'base64'),
    )
  })

  test.afterAll(() => {
    fs.rmSync(AUDIT_WORKSPACE, { recursive: true, force: true })
  })

  test('captures terminal and Chat states from real bash, Codex, and OpenCode Agents', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'iphone-webkit', 'Runs only in the iPhone WebKit project')
    test.setTimeout(12 * 60_000)
    await page.setViewportSize(IPHONE_VIEWPORT)
    await openFarming(page)
    await expect(page.locator('body')).toHaveClass(/code-compact-layout/)
    await expect(page.locator('body')).toHaveClass(/code-mobile-touch/)

    const bashAgentId = await createAgent(page, 'bash', 'terminal')
    await activateAgent(page, bashAgentId)
    await waitForTerminal(page, bashAgentId)
    await capture(page, testInfo, '01-bash-terminal-idle-light.png')

    const bashShort = 'IPHONE_BASH_SHORT_OK'
    await sendComposerText(page, "printf 'IPHONE_BASH_SHORT_%s\\n' 'OK'")
    await expect.poll(async () => (await terminalRows(page, bashAgentId)).join('\n')).toContain(bashShort)
    await capture(page, testInfo, '02-bash-terminal-short-light.png')

    const bashDenseEnd = 'IPHONE_BASH_DENSE_END'
    await sendLongComposerText(page, "for i in $(seq -w 1 36); do echo IPHONE_BASH_LINE_$i; done; printf '中文终端正常\\nIPHONE_BASH_DENSE_%s\\n' 'END'")
    await expect.poll(async () => (await terminalRows(page, bashAgentId)).join('\n')).toContain(bashDenseEnd)
    await capture(page, testInfo, '03-bash-terminal-dense-light.png')

    const bashDraft = "printf 'draft line one'\nprintf 'draft line two 中文'"
    const bashInput = activeComposerInput(page)
    await bashInput.tap()
    await bashInput.fill(bashDraft)
    await expect(bashInput).toBeFocused()
    await capture(page, testInfo, '04-bash-terminal-focused-draft-light.png')
    await bashInput.fill('')

    const codexAgentId = await createAgent(page, 'codex', 'chat')
    await activateAgent(page, codexAgentId)
    await expect(page.getByTestId('code-codex-transcript')).toBeVisible({ timeout: 60_000 })
    await expect(page.getByTestId('code-codex-transcript').getByRole('status')).toContainText('No conversation yet.')
    await capture(page, testInfo, '05-codex-chat-empty-light.png')

    const codexShort = 'IPHONE_CODEX_SHORT_OK'
    await sendComposerText(page, `Do not use tools. Reply with only ${codexShort}.`)
    await waitForChatAnswer(page, codexShort)
    await capture(page, testInfo, '06-codex-chat-short-light.png')

    const codexDenseEnd = 'IPHONE_CODEX_DENSE_END'
    const codexDensePrompt = `Do not use tools or inspect files. Return only Markdown. Start with # iPhone Codex Audit. Include one short paragraph, a three-item bullet list, a two-row table, one fenced JSON block, the line 中文聊天正常, then 60 separate lines CODEX_MOBILE_LINE_01 through CODEX_MOBILE_LINE_60. Do not abbreviate or combine lines. End with ${codexDenseEnd}.`
    await sendLongComposerText(page, codexDensePrompt)
    await expect(activeComposerSend(page)).toHaveAttribute('data-action', 'interrupt', { timeout: 60_000 })
    await capture(page, testInfo, '07-codex-chat-running-light.png')
    await waitForChatAnswer(page, codexDenseEnd, 240_000)
    await page.evaluate(() => document.body.setAttribute('data-appearance', 'dark'))
    await capture(page, testInfo, '08-codex-chat-dense-dark.png')

    const openCodeAgentId = await createAgent(page, 'opencode', 'chat')
    await activateAgent(page, openCodeAgentId)
    await expect(page.getByTestId('code-codex-transcript')).toBeVisible({ timeout: 60_000 })
    await expect(page.getByTestId('code-codex-transcript').getByRole('status')).toContainText('No conversation yet.')
    await capture(page, testInfo, '09-opencode-chat-empty-dark.png')

    await page.getByTestId('code-acp-composer-file-input').setInputFiles(path.join(AUDIT_WORKSPACE, 'attachment.png'))
    const attachment = page.getByTestId('code-composer-attachment')
    const removeAttachment = attachment.getByRole('button', { name: 'Remove attachment.png' })
    await expect(attachment).toHaveClass(/image/)
    await expect(attachment).toHaveClass(/ready/, { timeout: 15_000 })
    expect(await removeAttachment.evaluate(element => {
      const rect = element.getBoundingClientRect()
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
      return hit === element || element.contains(hit)
    })).toBe(true)
    await capture(page, testInfo, '10-opencode-chat-image-attachment-dark.png')
    await removeAttachment.tap()
    await expect(attachment).toHaveCount(0)

    const openCodeShort = 'IPHONE_OPENCODE_SHORT_OK'
    await sendComposerText(page, `Do not use tools. Reply with only ${openCodeShort}.`)
    await waitForChatAnswer(page, openCodeShort)
    await capture(page, testInfo, '11-opencode-chat-short-dark.png')

    const openCodeDenseEnd = 'IPHONE_OPENCODE_DENSE_END'
    const openCodeDensePrompt = `Do not use tools or inspect files. Print 36 separate lines OPENCODE_MOBILE_LINE_01 through OPENCODE_MOBILE_LINE_36, then print 中文显示正常, and finish with ${openCodeDenseEnd}. Do not abbreviate or combine lines.`
    await sendLongComposerText(page, openCodeDensePrompt)
    await waitForChatAnswer(page, openCodeDenseEnd, 240_000)
    await capture(page, testInfo, '12-opencode-chat-dense-dark.png')

    await page.getByTestId('code-mobile-menu').click()
    await expect(page.getByTestId('code-sidebar')).not.toHaveClass(/collapsed/)
    await expect(page.locator('[data-testid="code-agent-row"][data-agent-id]')).toHaveCount(3)
    await capture(page, testInfo, '13-multi-agent-drawer-dark.png')
  })
})
