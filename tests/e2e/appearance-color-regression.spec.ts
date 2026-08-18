import fs from 'node:fs'
import path from 'node:path'
import type { Locator, Page, TestInfo } from '@playwright/test'
import { expect, openFarming, test } from './fixtures'

type Appearance = 'light' | 'dark'

async function createAgent(page: Page, command: 'bash' | 'claude', workspace: string, chat = false) {
  const response = await page.request.post('/farming/api/control/agents', {
    data: {
      command,
      workspace,
      ...(chat ? { agentRuntimeMode: 'chat' } : {}),
    },
  })
  expect(response.ok()).toBeTruthy()
  const payload = await response.json() as { agentId?: string }
  expect(payload.agentId).toBeTruthy()
  return payload.agentId as string
}

async function setAppearance(page: Page, appearance: Appearance) {
  await page.locator('body').evaluate((body, nextAppearance) => {
    body.dataset.appearance = nextAppearance
  }, appearance)
}

async function resolvedColor(page: Page, role: string) {
  return page.evaluate(cssRole => {
    const probe = document.createElement('span')
    probe.style.color = `var(${cssRole})`
    document.body.append(probe)
    const color = getComputedStyle(probe).color
    probe.remove()
    return color
  }, role)
}

async function background(locator: Locator) {
  return locator.evaluate(element => getComputedStyle(element).backgroundColor)
}

async function color(locator: Locator) {
  return locator.evaluate(element => getComputedStyle(element).color)
}

async function capture(page: Page, testInfo: TestInfo, name: string) {
  const screenshotPath = testInfo.outputPath(`${name}.png`)
  await page.screenshot({ path: screenshotPath, animations: 'disabled' })
  await testInfo.attach(name, { path: screenshotPath, contentType: 'image/png' })
}

test('Light and Dark editor tabs stay neutral and connect to the document canvas', async ({ page, workspaceRoot }, testInfo) => {
  const workspace = path.join(workspaceRoot, 'appearance-tab-colors')
  fs.mkdirSync(workspace, { recursive: true })
  for (const [name, content] of [
    ['meta_manager.cpp', 'int metadata = 1;\n'],
    ['FilterToPot.java', 'package com.aliyun.odps.lot.cbo.converter.pot;\n'],
    ['sleeper.cpp', 'void sleep_once() {}\n'],
    ['worker.cpp', 'void work_once() {}\n'],
    ['HashAggregateToPot.java', 'final class HashAggregateToPot {}\n'],
  ]) {
    fs.writeFileSync(path.join(workspace, name), content)
  }

  const agentId = await createAgent(page, 'bash', workspace)
  await page.setViewportSize({ width: 1440, height: 820 })
  await openFarming(page)
  await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()

  const project = page.getByTestId('code-project-group').filter({ hasText: path.basename(workspace) })
  const files = project.getByTestId('code-files-section')
  const filesTitle = files.locator('.code-files-title').first()
  if (await filesTitle.getAttribute('aria-expanded') !== 'true') await filesTitle.click()
  for (const name of ['meta_manager.cpp', 'FilterToPot.java', 'sleeper.cpp', 'worker.cpp', 'HashAggregateToPot.java']) {
    await files.locator(`[data-testid="code-file-row"][data-file-path="${name}"]`).dblclick()
  }

  const editor = page.getByTestId('code-file-editor')
  const activeTab = editor.getByRole('tab').filter({ hasText: 'HashAggregateToPot.java' })
  const inactiveTab = editor.getByRole('tab').filter({ hasText: 'FilterToPot.java' })
  await expect(activeTab).toHaveAttribute('aria-selected', 'true')
  await expect(editor.getByRole('tab')).toHaveCount(5)

  for (const appearance of ['light', 'dark'] as const) {
    await setAppearance(page, appearance)
    const activeSurface = await resolvedColor(page, '--code-file-editor-active-tab-surface')
    const stripSurface = await resolvedColor(page, '--code-file-editor-tab-strip-surface')
    expect(await background(activeTab)).toBe(activeSurface)
    expect(activeSurface).not.toBe(stripSurface)
    expect(await activeTab.evaluate(element => getComputedStyle(element, '::after').backgroundColor)).toBe(activeSurface)

    await inactiveTab.hover()
    expect(await background(inactiveTab)).toBe(activeSurface)
    await editor.getByTestId('code-file-editor-main').hover({ position: { x: 20, y: 120 } })
    await capture(page, testInfo, `editor-tabs-${appearance}`)
  }
})

test('Light and Dark Chat use neutral reading surfaces and semantic glyph colors', async ({ page, workspaceRoot }, testInfo) => {
  const workspace = path.join(workspaceRoot, 'appearance-chat-colors')
  fs.mkdirSync(workspace, { recursive: true })
  const agentId = await createAgent(page, 'claude', workspace, true)
  await page.setViewportSize({ width: 1280, height: 820 })
  await openFarming(page)
  await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()

  const input = page.getByTestId('code-acp-composer-input')
  await input.fill('markdown typography')
  await page.getByTestId('code-acp-composer-send').click()
  const answer = page.locator('.code-agent-transcript-assistant.code-markdown-preview').filter({ hasText: 'Typography baseline.' })
  await expect(answer).toBeVisible({ timeout: 15_000 })
  const pre = answer.locator('pre').first()
  const inlineCode = answer.locator('code').filter({ hasText: 'metadata' })
  const keyword = answer.locator('.hljs-keyword').first()
  const string = answer.locator('.hljs-string').first()

  for (const appearance of ['light', 'dark'] as const) {
    await setAppearance(page, appearance)
    expect(await background(pre)).toBe(await resolvedColor(page, '--code-code-bg'))
    expect(await background(inlineCode)).toBe(await resolvedColor(page, '--code-code-bg'))
    expect(await color(keyword)).toBe(await resolvedColor(page, '--code-syntax-keyword'))
    expect(await color(string)).toBe(await resolvedColor(page, '--code-syntax-string'))

    await input.fill('next request')
    const send = page.getByTestId('code-acp-composer-send')
    await answer.hover({ position: { x: 20, y: 20 } })
    const sendBackgroundRole = appearance === 'light' ? '--code-emphasis' : '--code-text-muted'
    const sendColorRole = appearance === 'light' ? '--code-text-on-emphasis' : '--code-bg-canvas'
    expect(await background(send)).toBe(await resolvedColor(page, sendBackgroundRole))
    expect(await color(send)).toBe(await resolvedColor(page, sendColorRole))
    await capture(page, testInfo, `chat-colors-${appearance}`)
    await input.fill('')

    await input.fill('live progress')
    await send.click()
    const liveTurn = page.locator('.code-agent-transcript-turn').filter({ hasText: 'live progress' }).last()
    const liveIcon = liveTurn.getByTestId('code-agent-transcript-live-activity-icon')
    await expect(liveIcon).toHaveAttribute('data-kind', 'running', { timeout: 10_000 })
    expect(await color(liveIcon)).toBe(await resolvedColor(page, '--code-success'))
    await expect(liveIcon).toHaveCount(0, { timeout: 10_000 })
  }
})
