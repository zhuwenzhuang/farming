import fs from 'node:fs'
import path from 'node:path'
import type { Locator, Page, TestInfo } from '@playwright/test'
import { expect, openFarming, test } from './fixtures'
import { encodeProviderSessionKey } from '../../shared/provider-session-identity'

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

function screenshotColorPixelCount(screenshot: Buffer, cssColor: string) {
  const expected = parseRgb(cssColor)
  const image = ScreenshotPng.sync.read(screenshot)
  let matches = 0
  for (let offset = 0; offset < image.data.length; offset += 4) {
    if (
      Math.abs((image.data[offset] ?? 0) - (expected[0] ?? 0)) <= 1
      && Math.abs((image.data[offset + 1] ?? 0) - (expected[1] ?? 0)) <= 1
      && Math.abs((image.data[offset + 2] ?? 0) - (expected[2] ?? 0)) <= 1
    ) matches += 1
  }
  return matches
}

function screenshotColorRatio(screenshot: Buffer, cssColor: string) {
  const image = ScreenshotPng.sync.read(screenshot)
  return screenshotColorPixelCount(screenshot, cssColor) / (image.width * image.height)
}

function screenshotColorDifferenceRatio(screenshot: Buffer, cssColor: string, minimumChannelDistance: number) {
  const expected = parseRgb(cssColor)
  const image = ScreenshotPng.sync.read(screenshot)
  let matches = 0
  for (let offset = 0; offset < image.data.length; offset += 4) {
    if (
      Math.max(
        Math.abs((image.data[offset] ?? 0) - (expected[0] ?? 0)),
        Math.abs((image.data[offset + 1] ?? 0) - (expected[1] ?? 0)),
        Math.abs((image.data[offset + 2] ?? 0) - (expected[2] ?? 0)),
      ) >= minimumChannelDistance
    ) matches += 1
  }
  return matches / (image.width * image.height)
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

async function stableScreenshot(locator: Locator, maximumChangedRatio = 0.001) {
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
  expect(changedPixels / (firstImage.width * firstImage.height)).toBeLessThanOrEqual(maximumChangedRatio)
  return first
}

async function expectScreenshotRole(
  page: Page,
  screenshot: Buffer,
  role: string,
  minimumRatio: number,
  label: string,
) {
  const expectedColor = await resolvedColor(page, role)
  expect(screenshotColorRatio(screenshot, expectedColor), `${label} must visibly paint ${role}`).toBeGreaterThanOrEqual(minimumRatio)
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
    const sendGlyph = send.locator('svg')
    expect(await sendGlyph.evaluate(element => getComputedStyle(element).fill)).toBe(await resolvedColor(page, sendColorRole))
    const sendGlyphScreenshot = await stableScreenshot(sendGlyph)
    const sendBackground = await resolvedColor(page, sendBackgroundRole)
    expect(
      screenshotColorDifferenceRatio(sendGlyphScreenshot, sendBackground, 48),
      `${appearance} send glyph must visibly contrast with ${sendBackgroundRole}`,
    ).toBeGreaterThanOrEqual(0.05)
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

test('Light, Dark, and Paper Archive notices keep neutral action colors in every interaction state', async ({ page, workspaceRoot }, testInfo) => {
  const workspace = path.join(workspaceRoot, 'appearance-archive-toast')
  const appearances = ['light', 'dark', 'paper'] as const
  const sessions = appearances.map(appearance => ({
    provider: 'codex',
    providerName: 'Codex',
    providerHomeId: 'review',
    id: `appearance-archive-${appearance}`,
    title: `${appearance} Archive color review with a deliberately long Agent title`,
    workspace,
    updatedAt: '2026-01-01T00:00:00.000Z',
    archived: false,
    pinned: false,
    unread: false,
    projectless: false,
  }))
  fs.mkdirSync(workspace, { recursive: true })

  await page.route(/\/farming\/api\/agent-sessions(?:\?.*)?$/, route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ sessions, nextCursor: '', hasMore: false, total: sessions.length }),
  }))
  let mainPageSessionKeys = sessions.map(session => encodeProviderSessionKey(session.provider, session.id, session.providerHomeId))
  const membershipResponse = await page.request.post('/farming/api/main-page-agent-sessions', {
    data: { operation: 'add', sessionKeys: mainPageSessionKeys },
  })
  expect(membershipResponse.ok()).toBeTruthy()
  await page.route(/\/farming\/api\/agent-sessions\/codex\/[^/]+\/archive$/, route => {
    const sessionId = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-2) || '')
    mainPageSessionKeys = mainPageSessionKeys.filter(key => !key.includes(sessionId))
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ success: true, mainPageSessionKeys }),
    })
  })

  let notifyUnarchiveStarted: (() => void) | undefined
  let releaseUnarchive: (() => void) | undefined
  await page.route(/\/farming\/api\/agent-sessions\/codex\/[^/]+\/unarchive$/, async route => {
    notifyUnarchiveStarted?.()
    await new Promise<void>(resolve => { releaseUnarchive = resolve })
    await route.fulfill({
      contentType: 'application/json',
      status: 409,
      body: JSON.stringify({ error: 'Provider Undo failed' }),
    })
  })

  await page.setViewportSize({ width: 1280, height: 820 })
  await openFarming(page)

  for (const appearance of appearances) {
    await setAppearance(page, appearance)
    const session = sessions.find(candidate => candidate.id.endsWith(appearance))!
    const row = page.getByTestId('code-active-session-row').filter({ hasText: session.title })
    await row.hover()
    await row.getByTestId('code-agent-row-archive').click()

    const toast = page.getByTestId('code-archive-toast')
    const projectList = page.getByTestId('code-project-list')
    const undo = toast.getByTestId('code-archive-toast-undo')
    const view = toast.getByTestId('code-archive-toast-view')
    await expect(toast).toBeVisible()
    await expect(projectList).toBeFocused()
    await expect(projectList).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    await page.mouse.move(1200, 300)
    await expect(projectList).toHaveScreenshot(`archive-sidebar-focus-${appearance}.png`)
    await expect(toast).toHaveAttribute('role', 'status')
    expect(await background(toast)).toBe(await resolvedColor(page, '--code-bg-raised'))
    expect(await background(view)).toBe(await resolvedColor(page, '--code-bg-muted'))
    expect(await color(toast.locator('.code-archive-toast-session'))).toBe(await resolvedColor(page, '--code-text-muted'))

    const undoBackgroundRole = appearance === 'dark' ? '--code-text-muted' : '--code-emphasis'
    const undoColorRole = appearance === 'dark' ? '--code-bg-canvas' : '--code-text-on-emphasis'
    expect(await background(undo)).toBe(await resolvedColor(page, undoBackgroundRole))
    expect(await color(undo)).toBe(await resolvedColor(page, undoColorRole))
    const accent = await resolvedColor(page, '--code-accent')
    if (appearance === 'paper') {
      const accentChannels = parseRgb(accent)
      expect(Math.max(...accentChannels) - Math.min(...accentChannels)).toBeLessThan(16)
    } else {
      expect(await background(undo)).not.toBe(accent)
    }
    await attachScreenshot(testInfo, `archive-${appearance}-success`, await stableScreenshot(toast, 0.003))

    await undo.hover()
    const undoInteractiveBackgroundRole = appearance === 'dark' ? '--code-text' : '--code-emphasis-hover'
    expect(await background(undo)).toBe(await resolvedColor(page, undoInteractiveBackgroundRole))
    await attachScreenshot(testInfo, `archive-${appearance}-hover`, await stableScreenshot(toast, 0.003))

    await page.mouse.move(20, 300)
    await view.focus()
    await page.keyboard.press('Tab')
    await expect(undo).toBeFocused()
    expect(await background(undo)).toBe(await resolvedColor(page, undoInteractiveBackgroundRole))
    await attachScreenshot(testInfo, `archive-${appearance}-focus`, await stableScreenshot(toast, 0.003))

    const unarchiveStarted = new Promise<void>(resolve => { notifyUnarchiveStarted = resolve })
    await undo.click()
    await unarchiveStarted
    await expect(undo).toBeDisabled()
    await expect(view).toBeDisabled()
    await expect(toast.getByTestId('code-archive-toast-close')).toBeDisabled()
    await expect(undo).toHaveCSS('opacity', '0.55')
    expect(await background(undo)).toBe(await resolvedColor(page, undoBackgroundRole))
    await attachScreenshot(testInfo, `archive-${appearance}-disabled`, await stableScreenshot(toast, 0.003))

    releaseUnarchive?.()
    await expect(toast).toHaveAttribute('role', 'alert')
    await expect(toast).toContainText('Provider Undo failed')
    await expect(toast).toContainText(`Codex · ${session.title}`)
    expect(await color(toast.locator('.code-archive-toast-label.error'))).toBe(await resolvedColor(page, '--code-diff-removed'))
    await attachScreenshot(testInfo, `archive-${appearance}-error`, await stableScreenshot(toast, 0.003))
    await toast.getByTestId('code-archive-toast-close').click()
    await expect(toast).toHaveCount(0)
    notifyUnarchiveStarted = undefined
    releaseUnarchive = undefined
  }
})
