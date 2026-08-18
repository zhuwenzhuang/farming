import fs from 'node:fs'
import path from 'node:path'
import type { Locator, Page, TestInfo } from '@playwright/test'
import { expect, openFarming, test } from './fixtures'

const { PNG: ScreenshotPng } = require('playwright-core/lib/utilsBundle') as {
  PNG: {
    sync: {
      read: (buffer: Buffer) => { width: number; height: number; data: Uint8Array }
    }
  }
}

type Appearance = 'light' | 'dark' | 'paper'

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
  await page.emulateMedia({
    colorScheme: appearance === 'dark' ? 'dark' : 'light',
    reducedMotion: 'reduce',
  })
  await page.evaluate(nextAppearance => {
    document.documentElement.dataset.appearance = nextAppearance
    document.body.dataset.appearance = nextAppearance
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

function parseRgb(value: string) {
  const channels = value.match(/[\d.]+/g)?.slice(0, 3).map(Number)
  if (!channels || channels.length !== 3) throw new Error(`Expected an RGB color, received ${value}`)
  return channels
}

function screenshotColorPixelCount(screenshot: Buffer, cssColor: string, channelTolerance = 1) {
  const expected = parseRgb(cssColor)
  const image = ScreenshotPng.sync.read(screenshot)
  let matches = 0
  for (let offset = 0; offset < image.data.length; offset += 4) {
    if (
      Math.abs((image.data[offset] ?? 0) - (expected[0] ?? 0)) <= channelTolerance
      && Math.abs((image.data[offset + 1] ?? 0) - (expected[1] ?? 0)) <= channelTolerance
      && Math.abs((image.data[offset + 2] ?? 0) - (expected[2] ?? 0)) <= channelTolerance
    ) matches += 1
  }
  return matches
}

function screenshotColorRatio(screenshot: Buffer, cssColor: string, channelTolerance = 1) {
  const image = ScreenshotPng.sync.read(screenshot)
  return screenshotColorPixelCount(screenshot, cssColor, channelTolerance) / (image.width * image.height)
}

function screenshotChromaticRatio(screenshot: Buffer) {
  const image = ScreenshotPng.sync.read(screenshot)
  let chromaticPixels = 0
  for (let offset = 0; offset < image.data.length; offset += 4) {
    const channels = [image.data[offset] ?? 0, image.data[offset + 1] ?? 0, image.data[offset + 2] ?? 0]
    if (Math.max(...channels) - Math.min(...channels) >= 24) chromaticPixels += 1
  }
  return chromaticPixels / (image.width * image.height)
}

async function stableScreenshot(locator: Locator) {
  const options = { animations: 'disabled' as const, caret: 'hide' as const, scale: 'css' as const }
  const first = await locator.screenshot(options)
  const second = await locator.screenshot(options)
  const firstImage = ScreenshotPng.sync.read(first)
  const secondImage = ScreenshotPng.sync.read(second)
  expect({ width: secondImage.width, height: secondImage.height }).toEqual({
    width: firstImage.width,
    height: firstImage.height,
  })
  let changedPixels = 0
  for (let offset = 0; offset < firstImage.data.length; offset += 4) {
    if (
      Math.abs((firstImage.data[offset] ?? 0) - (secondImage.data[offset] ?? 0)) > 1
      || Math.abs((firstImage.data[offset + 1] ?? 0) - (secondImage.data[offset + 1] ?? 0)) > 1
      || Math.abs((firstImage.data[offset + 2] ?? 0) - (secondImage.data[offset + 2] ?? 0)) > 1
    ) changedPixels += 1
  }
  expect(changedPixels / (firstImage.width * firstImage.height)).toBeLessThanOrEqual(0.001)
  return first
}

async function expectScreenshotRole(
  page: Page,
  screenshot: Buffer,
  role: string,
  minimumRatio: number,
  label: string,
  channelTolerance = 1,
) {
  const expectedColor = await resolvedColor(page, role)
  expect(screenshotColorRatio(screenshot, expectedColor, channelTolerance), `${label} must visibly paint ${role}`).toBeGreaterThanOrEqual(minimumRatio)
}

async function expectScreenshotTextRole(page: Page, screenshot: Buffer, role: string, label: string) {
  const expectedColor = await resolvedColor(page, role)
  expect(screenshotColorPixelCount(screenshot, expectedColor), `${label} must visibly paint ${role}`).toBeGreaterThan(0)
}

async function attachScreenshot(testInfo: TestInfo, name: string, screenshot: Buffer) {
  await testInfo.attach(name, { body: screenshot, contentType: 'image/png' })
}

test('Light, Dark, and Paper editor tabs keep their surfaces and file-icon colors', async ({ page, workspaceRoot }, testInfo) => {
  const workspace = path.join(workspaceRoot, 'appearance-tab-colors')
  fs.mkdirSync(workspace, { recursive: true })
  for (const [name, content] of [
    ['meta_manager.cpp', 'int metadata = 1;\n'],
    ['FilterToPot.java', 'package com.aliyun.odps.lot.cbo.converter.pot;\n'],
    ['sleeper.cpp', 'void sleep_once() {}\n'],
    ['worker.cpp', 'void work_once() {}\n'],
    ['operator_profile.osql', 'set odps.sql.planner.mode=lot;\n'],
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
  for (const name of ['meta_manager.cpp', 'FilterToPot.java', 'sleeper.cpp', 'worker.cpp', 'operator_profile.osql']) {
    await files.locator(`[data-testid="code-file-row"][data-file-path="${name}"]`).dblclick()
    const openedTab = page.getByTestId('code-file-editor').getByRole('tab').filter({ hasText: name })
    await expect(openedTab).toHaveAttribute('aria-selected', 'true')
    await expect(openedTab).not.toHaveAttribute('data-preview', 'true')
  }

  const editor = page.getByTestId('code-file-editor')
  const activeTab = editor.getByRole('tab').filter({ hasText: 'operator_profile.osql' })
  const inactiveTab = editor.getByRole('tab').filter({ hasText: 'FilterToPot.java' })
  const activeTabIcon = activeTab.locator('.code-file-editor-tab-icon')
  await expect(activeTab).toHaveAttribute('aria-selected', 'true')
  await expect(editor.getByRole('tab')).toHaveCount(5)
  await expect.poll(() => activeTabIcon.evaluate(element => (
    element instanceof HTMLImageElement && element.complete && element.naturalWidth > 0
  ))).toBe(true)
  await expect(activeTabIcon).toHaveAttribute('draggable', 'false')

  for (const appearance of ['light', 'dark', 'paper'] as const) {
    await setAppearance(page, appearance)
    const activeSurface = await resolvedColor(page, '--code-file-editor-active-tab-surface')
    const stripSurface = await resolvedColor(page, '--code-file-editor-tab-strip-surface')
    expect(await background(activeTab)).toBe(activeSurface)
    expect(activeSurface).not.toBe(stripSurface)
    const activeSeam = await activeTab.evaluate(element => getComputedStyle(element, '::after').backgroundColor)
    if (appearance === 'paper') expect(activeSeam).toBe('rgba(0, 0, 0, 0)')
    else expect(activeSeam).toBe(activeSurface)

    await inactiveTab.hover()
    expect(await background(inactiveTab)).toBe(activeSurface)
    await editor.getByTestId('code-file-editor-main').hover({ position: { x: 20, y: 120 } })
    const activeTabScreenshot = await stableScreenshot(activeTab)
    await expectScreenshotRole(page, activeTabScreenshot, '--code-file-editor-active-tab-surface', 0.55, `${appearance} active tab`)
    const activeTabIconScreenshot = await stableScreenshot(activeTabIcon)
    expect(screenshotChromaticRatio(activeTabIconScreenshot), `${appearance} file icon must retain chroma`).toBeGreaterThanOrEqual(0.08)
    expect(screenshotColorRatio(activeTabIconScreenshot, 'rgb(255, 106, 0)'), `${appearance} .osql icon must retain its orange paint`).toBeGreaterThanOrEqual(0.04)
    const headerScreenshot = await stableScreenshot(editor.locator('.code-file-editor-header'))
    await expectScreenshotRole(page, headerScreenshot, '--code-file-editor-active-tab-surface', 0.04, `${appearance} editor header`)
    await expectScreenshotRole(page, headerScreenshot, '--code-file-editor-tab-strip-surface', 0.12, `${appearance} editor header`)
    await attachScreenshot(testInfo, `editor-tabs-${appearance}`, headerScreenshot)
  }
})

test('Light, Dark, and Paper Chat use neutral reading surfaces and semantic glyph colors', async ({ page, workspaceRoot }, testInfo) => {
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

  for (const appearance of ['light', 'dark', 'paper'] as const) {
    await setAppearance(page, appearance)
    expect(await background(pre)).toBe(await resolvedColor(page, '--code-code-bg'))
    expect(await background(inlineCode)).toBe(await resolvedColor(page, '--code-code-bg'))
    expect(await color(keyword)).toBe(await resolvedColor(page, '--code-syntax-keyword'))
    expect(await color(string)).toBe(await resolvedColor(page, '--code-syntax-string'))
    const preScreenshot = await stableScreenshot(pre)
    await expectScreenshotRole(page, preScreenshot, '--code-code-bg', 0.55, `${appearance} code block`)
    const inlineCodeScreenshot = await stableScreenshot(inlineCode)
    await expectScreenshotRole(page, inlineCodeScreenshot, '--code-code-bg', 0.35, `${appearance} inline code`)
    const keywordScreenshot = await stableScreenshot(keyword)
    await expectScreenshotTextRole(page, keywordScreenshot, '--code-syntax-keyword', `${appearance} keyword`)
    const stringScreenshot = await stableScreenshot(string)
    await expectScreenshotTextRole(page, stringScreenshot, '--code-syntax-string', `${appearance} string`)

    await input.fill('next request')
    const send = page.getByTestId('code-acp-composer-send')
    await answer.hover({ position: { x: 20, y: 20 } })
    const sendBackgroundRole = appearance === 'dark' ? '--code-text-muted' : '--code-emphasis'
    const sendColorRole = appearance === 'dark' ? '--code-bg-canvas' : '--code-text-on-emphasis'
    expect(await background(send)).toBe(await resolvedColor(page, sendBackgroundRole))
    expect(await color(send)).toBe(await resolvedColor(page, sendColorRole))
    const sendScreenshot = await stableScreenshot(send)
    await expectScreenshotRole(page, sendScreenshot, sendBackgroundRole, 0.55, `${appearance} send button`)
    // Chromium antialiases this 15px SVG without retaining a pixel at the exact source color.
    await expectScreenshotRole(page, sendScreenshot, sendColorRole, 0.0008, `${appearance} send glyph`, 12)
    const answerScreenshot = await stableScreenshot(answer)
    await expectScreenshotRole(page, answerScreenshot, '--code-code-bg', 0.03, `${appearance} Chat answer`)
    await attachScreenshot(testInfo, `chat-colors-${appearance}`, answerScreenshot)
    await input.fill('')

    await input.fill('live progress')
    await send.click()
    const liveTurn = page.locator('.code-agent-transcript-turn').filter({ hasText: 'live progress' }).last()
    const liveIcon = liveTurn.getByTestId('code-agent-transcript-live-activity-icon')
    await expect(liveIcon).toHaveAttribute('data-kind', 'running', { timeout: 10_000 })
    expect(await color(liveIcon)).toBe(await resolvedColor(page, '--code-success'))
    const liveIconScreenshot = await stableScreenshot(liveIcon)
    await expectScreenshotRole(page, liveIconScreenshot, '--code-success', 0.01, `${appearance} running icon`)
    await expect(liveIcon).toHaveCount(0, { timeout: 10_000 })
  }
})
