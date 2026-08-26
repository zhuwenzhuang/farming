import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { expect, interceptWorkspaceRequests, openFarming, test } from './fixtures'

export const VISUAL_SCENARIOS = [
  'sidebar-agent-hover',
  'sidebar-agent-hover-dark',
  'sidebar-agent-hover-paper',
  'sidebar-project-hover',
  'sidebar-project-hover-dark',
  'sidebar-project-hover-paper',
  'queued-followups-wide',
  'queued-followups-wide-dark',
  'queued-followups-wide-paper',
  'queued-followups-narrow',
  'queued-followups-narrow-dark',
  'queued-followups-narrow-paper',
  'changes-diff',
  'plugins-dark',
  'appearance-editor-tabs-light',
  'appearance-editor-tabs-dark',
  'appearance-editor-tabs-paper',
  'appearance-chat-light',
  'appearance-chat-dark',
  'appearance-chat-paper',
  'appearance-light-settings',
  'appearance-light-search',
  'appearance-light-history',
  'appearance-light-plugins',
  'appearance-dark-settings',
  'appearance-dark-search',
  'appearance-dark-history',
  'appearance-dark-plugins',
  'appearance-paper-settings',
  'appearance-paper-search',
  'appearance-paper-history',
  'appearance-paper-plugins',
] as const

const outputDir = process.env.FARMING_VISUAL_OUTPUT_DIR
const visualRoot = path.join(os.tmpdir(), 'farming-visual-regression')

type ScreenshotOptions = {
  mask?: Locator[]
}

type Appearance = 'light' | 'dark' | 'paper'

async function setVisualAppearance(page: Page, appearance: Appearance) {
  await page.emulateMedia({
    colorScheme: appearance === 'dark' ? 'dark' : 'light',
    reducedMotion: 'reduce',
  })
  await page.evaluate((nextAppearance) => {
    document.documentElement.dataset.appearance = nextAppearance
    document.body.dataset.appearance = nextAppearance
  }, appearance)
  await expect(page.locator('body')).toHaveAttribute('data-appearance', appearance)
}

function themedScenario(
  base: 'sidebar-agent-hover' | 'sidebar-project-hover' | 'queued-followups-wide' | 'queued-followups-narrow',
  appearance: Appearance,
): typeof VISUAL_SCENARIOS[number] {
  return appearance === 'light' ? base : `${base}-${appearance}`
}

async function settleVisualState(page: Page) {
  await page.evaluate(async () => {
    await document.fonts.ready
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  })
}

async function captureScenario(page: Page, name: typeof VISUAL_SCENARIOS[number], options: ScreenshotOptions = {}) {
  if (!outputDir) throw new Error('FARMING_VISUAL_OUTPUT_DIR is required')
  fs.mkdirSync(outputDir, { recursive: true })
  if (!await page.locator('#farming-visual-stability-style').count()) {
    await page.addStyleTag({
      content: `
        * {
          animation: none !important;
          caret-color: transparent !important;
          scroll-behavior: auto !important;
          transition: none !important;
        }
        .code-agent-preview,
        .code-agent-row-age,
        .code-agent-transcript-steer-time,
        .code-pet-bubble,
        .code-plugin-error,
        .code-usage-summary,
        .xterm-cursor-layer {
          visibility: hidden !important;
        }
      `,
    }).then(style => style.evaluate((element) => { element.id = 'farming-visual-stability-style' }))
  }
  await settleVisualState(page)
  const screenshotOptions = {
    animations: 'disabled' as const,
    fullPage: false,
    mask: options.mask,
    maskColor: '#d9dde3',
    scale: 'css' as const,
  }
  await page.screenshot({ ...screenshotOptions, path: path.join(outputDir, `${name}.1.png`) })
  await settleVisualState(page)
  await page.screenshot({ ...screenshotOptions, path: path.join(outputDir, `${name}.2.png`) })
}

async function createAgent(page: Page, command: string, workspace: string, agentRuntimeMode?: 'chat' | 'terminal') {
  fs.mkdirSync(workspace, { recursive: true })
  const response = await page.request.post('/farming/api/control/agents', {
    data: { command, workspace, ...(agentRuntimeMode ? { agentRuntimeMode } : {}) },
  })
  expect(response.ok()).toBeTruthy()
  const body = await response.json() as { agentId?: string }
  expect(body.agentId).toBeTruthy()
  return body.agentId as string
}

async function setAgentTitle(page: Page, agentId: string, customTitle: string) {
  const response = await page.request.patch(`/farming/api/agents/${agentId}`, {
    data: { customTitle },
  })
  expect(response.ok()).toBeTruthy()
}

async function openAgent(page: Page, agentId: string) {
  const row = page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
  await expect(row).toBeVisible({ timeout: 30_000 })
  await row.click()
  return row
}

async function waitForSteer(page: Page, agentId: string) {
  await expect.poll(async () => {
    const response = await page.request.get('/farming/api/control/agents')
    const body = await response.json() as {
      agents?: Array<{ id?: string; providerCapabilities?: { supportsSteer?: boolean } }>
    }
    return body.agents?.find(agent => agent.id === agentId)?.providerCapabilities?.supportsSteer
  }, { timeout: 30_000 }).toBe(true)
}

function visualUpdateStatus() {
  return {
    method: 'npm',
    current: { releaseVersion: '2.2.49', packageVersion: '2.2.49', type: 'npm' },
    latest: { version: '2.2.49', assetName: '2.2.49', blockedReason: '' },
    selected: { version: '2.2.49', assetName: '2.2.49', blockedReason: '' },
    versions: [{ version: '2.2.49', assetName: '2.2.49', available: false, installable: true }],
    available: false,
    installable: true,
    state: { phase: 'idle', version: '2.2.49', previousVersion: '2.2.49' },
  }
}

function visualHistorySession() {
  return {
    provider: 'codex',
    providerName: 'Codex',
    providerHomeId: 'default',
    id: 'visual-history-session',
    title: 'Theme history review',
    workspace: path.join(visualRoot, 'appearance-workspace'),
    updatedAt: '2026-08-01T12:00:00.000Z',
    createdAt: '2026-08-01T11:00:00.000Z',
    archived: false,
    pinned: false,
    unread: false,
    projectless: false,
    model: 'gpt-5.6-sol',
    effort: 'high',
    source: 'codex',
  }
}

test.describe('PR visual regression capture', () => {
  test.skip(!outputDir, 'Run through the visual comparison workflow or set FARMING_VISUAL_OUTPUT_DIR')

  test.beforeEach(async ({ page }) => {
    fs.rmSync(visualRoot, { recursive: true, force: true })
    fs.mkdirSync(visualRoot, { recursive: true })
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  })

  test('captures stable sidebar hover states', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    const alphaWorkspace = path.join(visualRoot, 'atlas-control-plane')
    const betaWorkspace = path.join(visualRoot, 'northstar-api')
    const alphaAgentId = await createAgent(page, 'bash', alphaWorkspace, 'terminal')
    const betaAgentId = await createAgent(page, 'bash', betaWorkspace, 'terminal')
    await setAgentTitle(page, alphaAgentId, 'Checkpoint recovery audit')
    await setAgentTitle(page, betaAgentId, 'Pagination boundary tests')

    await openFarming(page)
    const alphaRow = await openAgent(page, alphaAgentId)
    const mainMask = page.getByTestId('code-main')
    await alphaRow.hover()
    await expect(alphaRow.getByTestId('code-agent-row-archive')).toBeVisible()
    for (const appearance of ['light', 'dark', 'paper'] as const) {
      await setVisualAppearance(page, appearance)
      await captureScenario(page, themedScenario('sidebar-agent-hover', appearance), { mask: [mainMask] })
    }

    const alphaProject = page.getByTestId('code-project-group').filter({ has: alphaRow })
    const alphaTitle = alphaProject.getByTestId('code-project-title')
    await alphaTitle.hover()
    await expect(alphaProject.getByTestId('code-project-actions')).toBeVisible()
    for (const appearance of ['light', 'dark', 'paper'] as const) {
      await setVisualAppearance(page, appearance)
      await captureScenario(page, themedScenario('sidebar-project-hover', appearance), { mask: [mainMask] })
    }

    await expect(page.locator(`[data-testid="code-agent-row"][data-agent-id="${betaAgentId}"]`)).toBeVisible()
  })

  test('captures queued follow-ups above wide and narrow composers', async ({ page }) => {
    const workspace = path.join(visualRoot, 'composer-queue')
    const agentId = await createAgent(page, 'codex', workspace, 'chat')
    await setAgentTitle(page, agentId, 'Visual review queue')

    await page.setViewportSize({ width: 1280, height: 720 })
    await openFarming(page)
    await openAgent(page, agentId)
    await waitForSteer(page, agentId)
    const input = page.getByTestId('code-acp-composer-input')
    await input.fill('hold for two steers delayed')
    await page.getByTestId('code-acp-composer-send').click()
    await expect(page.getByTestId('code-acp-composer-send')).toHaveAttribute('data-action', 'interrupt')
    await input.fill('Review the spacing, colors, and duplicate controls first.')
    await page.getByTestId('code-acp-composer-send').click()
    await input.fill('Then verify the narrow layout before reporting.')
    await page.getByTestId('code-acp-composer-send').click()
    await expect(page.getByTestId('code-acp-pending-followup-row')).toHaveCount(2)
    const transcript = page.getByTestId('code-agent-transcript-scroll')
    for (const appearance of ['light', 'dark', 'paper'] as const) {
      await setVisualAppearance(page, appearance)
      await captureScenario(page, themedScenario('queued-followups-wide', appearance), { mask: [transcript] })
    }

    await page.setViewportSize({ width: 390, height: 844 })
    await expect(page.locator('body')).toHaveClass(/code-compact-layout/)
    await expect(page.getByTestId('code-acp-pending-followup-row')).toHaveCount(2)
    for (const appearance of ['light', 'dark', 'paper'] as const) {
      await setVisualAppearance(page, appearance)
      await captureScenario(page, themedScenario('queued-followups-narrow', appearance), { mask: [transcript] })
    }
  })

  test('captures Changes hierarchy with its diff open', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    const workspace = path.join(visualRoot, 'review-workspace')
    const nestedDirectory = path.join(workspace, 'src', 'components')
    fs.mkdirSync(nestedDirectory, { recursive: true })
    fs.writeFileSync(path.join(workspace, 'README.md'), '# Review workspace\n')
    fs.writeFileSync(path.join(nestedDirectory, 'QueuePanel.tsx'), 'export const label = "before"\n')
    execFileSync('git', ['init', '-q'], { cwd: workspace })
    fs.mkdirSync(path.join(workspace, '.git', 'empty-hooks'), { recursive: true })
    execFileSync('git', ['config', 'core.hooksPath', '.git/empty-hooks'], { cwd: workspace })
    execFileSync('git', ['add', '.'], { cwd: workspace })
    execFileSync('git', [
      '-c', 'user.name=Visual Fixture',
      '-c', 'user.email=visual@example.invalid',
      'commit', '-qm', 'Seed visual fixture',
    ], { cwd: workspace, env: { ...process.env, GIT_COMMITTER_DATE: '2026-07-30T09:00:00Z' } })
    fs.writeFileSync(path.join(nestedDirectory, 'QueuePanel.tsx'), [
      'export const label = "after"',
      'export const queuedMessages = 2',
      '',
    ].join('\n'))
    fs.writeFileSync(path.join(workspace, 'notes.txt'), 'Anonymous review notes\n')
    const agentId = await createAgent(page, 'bash', workspace, 'terminal')
    await setAgentTitle(page, agentId, 'Review workspace changes')

    let diffPayload: {
      patch?: string
      originalContent?: string
      modifiedContent?: string
    } | null = null
    await interceptWorkspaceRequests(page, request => {
      if (request.operation !== 'diff') return
      return {
        onResult(message) {
          if (message.ok) diffPayload = message.result as typeof diffPayload
          return message
        },
      }
    })

    await openFarming(page)
    const row = await openAgent(page, agentId)
    const project = page.getByTestId('code-project-group').filter({ has: row })
    const filesSection = project.getByTestId('code-files-section')
    const filesTitle = filesSection.locator('.code-files-title').first()
    if (await filesTitle.getAttribute('aria-expanded') !== 'true') await filesTitle.click()
    const changesSection = filesSection.getByTestId('code-file-changes-section')
    const trackedGroup = changesSection.getByTestId('code-file-change-tracked-group')
    const trackedToggle = trackedGroup.getByRole('button', { name: /Changes/ })
    await expect(trackedToggle).toBeVisible({ timeout: 30_000 })
    await trackedToggle.click()
    const componentsDirectory = trackedGroup.locator('[data-testid="code-file-change-directory-row"][data-file-path="src/components"]')
    await expect(componentsDirectory).toBeVisible()
    await componentsDirectory.click()
    const changedFile = trackedGroup.locator('[data-testid="code-file-change-row"][data-file-path="src/components/QueuePanel.tsx"]')
    await changedFile.click()
    await expect.poll(() => diffPayload).not.toBeNull()
    expect(diffPayload?.patch).toContain('queuedMessages')
    expect(diffPayload?.originalContent).toContain('label = "before"')
    expect(diffPayload?.modifiedContent).toContain('label = "after"')
    await expect(page.getByTestId('code-file-diff-view')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('code-file-diff-monaco')).toBeVisible()
    await captureScenario(page, 'changes-diff')
  })

  test('captures Plugins in the saved dark appearance', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    const codexHome = path.join(visualRoot, 'agent-homes', 'codex-review')
    fs.mkdirSync(codexHome, { recursive: true })
    const settingsResponse = await page.request.post('/farming/api/settings', {
      data: {
        appearance: 'dark',
        agentHomes: {
          codex: [{
            id: 'review',
            path: codexHome,
            order: 0,
            newAgentDefaults: { model: 'inherit', reasoning: 'inherit', fast: 'inherit' },
          }],
        },
      },
    })
    expect(settingsResponse.ok()).toBeTruthy()
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
    await openFarming(page)
    await page.getByTestId('code-nav-plugins').click()
    const panel = page.getByTestId('code-plugins-panel')
    await expect(panel).toBeVisible({ timeout: 30_000 })
    const browserSource = panel.getByLabel('Browser source')
    const desktopTarget = panel.locator('.code-plugin-desktop-target')
    await expect(browserSource).toBeVisible()
    await expect(desktopTarget).toBeVisible()
    await expect(page.locator('body')).toHaveAttribute('data-appearance', 'dark')
    await expect(panel.getByText('Checking...', { exact: true })).toHaveCount(0, { timeout: 30_000 })
    await panel.getByTestId('code-plugin-tab-homes').click()
    await expect(panel.getByText('Loading Agent extensions...', { exact: true })).toHaveCount(0, { timeout: 30_000 })
    await expect(panel.getByTestId('code-plugin-section-agent-codex-review')).toBeVisible()
    await panel.getByTestId('code-plugin-tab-farming').click()
    await captureScenario(page, 'plugins-dark')
  })

  test('captures editor tabs and Chat colors in Light, Dark, and Paper', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 820 })
    const editorWorkspace = path.join(visualRoot, 'appearance-editor-colors')
    fs.mkdirSync(editorWorkspace, { recursive: true })
    for (const [name, content] of [
      ['meta_manager.cpp', 'int metadata = 1;\n'],
      ['FilterToPot.java', 'package com.aliyun.odps.lot.cbo.converter.pot;\n'],
      ['sleeper.cpp', 'void sleep_once() {}\n'],
      ['worker.cpp', 'void work_once() {}\n'],
      ['operator_profile.osql', 'set odps.sql.planner.mode=lot;\n'],
    ]) {
      fs.writeFileSync(path.join(editorWorkspace, name), content)
    }
    const editorAgentId = await createAgent(page, 'bash', editorWorkspace, 'terminal')
    await setAgentTitle(page, editorAgentId, 'Appearance editor colors')
    await openFarming(page)
    const editorRow = await openAgent(page, editorAgentId)
    const project = page.getByTestId('code-project-group').filter({ has: editorRow })
    const files = project.getByTestId('code-files-section')
    const filesTitle = files.locator('.code-files-title').first()
    if (await filesTitle.getAttribute('aria-expanded') !== 'true') await filesTitle.click()
    for (const name of ['meta_manager.cpp', 'FilterToPot.java', 'sleeper.cpp', 'worker.cpp', 'operator_profile.osql']) {
      await files.locator(`[data-testid="code-file-row"][data-file-path="${name}"]`).dblclick()
    }
    await expect(page.getByTestId('code-file-editor').getByRole('tab').filter({ hasText: 'operator_profile.osql' })).toHaveAttribute('aria-selected', 'true')
    for (const appearance of ['light', 'dark', 'paper'] as const) {
      await setVisualAppearance(page, appearance)
      await captureScenario(page, `appearance-editor-tabs-${appearance}`)
    }

    const chatWorkspace = path.join(visualRoot, 'appearance-chat-colors')
    const chatAgentId = await createAgent(page, 'claude', chatWorkspace, 'chat')
    await setAgentTitle(page, chatAgentId, 'Appearance Chat colors')
    await openAgent(page, chatAgentId)
    const input = page.getByTestId('code-acp-composer-input')
    await input.fill('markdown typography')
    await page.getByTestId('code-acp-composer-send').click()
    await expect(
      page.locator('.code-agent-transcript-assistant.code-markdown-preview').filter({ hasText: 'Typography baseline.' }),
    ).toBeVisible({ timeout: 15_000 })
    await input.fill('next request')
    for (const appearance of ['light', 'dark', 'paper'] as const) {
      await setVisualAppearance(page, appearance)
      await captureScenario(page, `appearance-chat-${appearance}`)
    }
  })

  test('captures every primary side view in Light, Dark, and Paper', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    const workspace = path.join(visualRoot, 'appearance-workspace')
    const codexHome = path.join(visualRoot, 'appearance-agent-home')
    fs.mkdirSync(codexHome, { recursive: true })
    const agentId = await createAgent(page, 'bash', workspace, 'terminal')
    await setAgentTitle(page, agentId, 'Theme review Agent')
    await page.route(/\/farming\/api\/agent-sessions(?:\?.*)?$/, route => route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        sessions: [visualHistorySession()],
        nextCursor: '',
        hasMore: false,
        total: 1,
      }),
    }))
    await page.route(/\/farming\/api\/update(?:\?.*)?$/, route => route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ update: visualUpdateStatus() }),
    }))

    const homeSettings = {
      codex: [{
        id: 'appearance-review',
        path: codexHome,
        order: 0,
        newAgentDefaults: { model: 'inherit', reasoning: 'inherit', fast: 'inherit' },
      }],
    }
    for (const appearance of ['light', 'dark', 'paper'] as const) {
      const response = await page.request.post('/farming/api/settings', {
        data: { appearance, agentHomes: homeSettings },
      })
      expect(response.ok()).toBeTruthy()
      await page.emulateMedia({
        colorScheme: appearance === 'dark' ? 'dark' : 'light',
        reducedMotion: 'reduce',
      })
      if (page.url() === 'about:blank') await openFarming(page)
      else await page.reload({ waitUntil: 'domcontentloaded' })
      await expect(page.locator('body')).toHaveAttribute('data-appearance', appearance)
      await expect(page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)).toBeVisible()

      await page.getByTestId('code-sidebar-options').click()
      const settings = page.getByTestId('code-settings-panel')
      await expect(settings).toBeVisible()
      await expect(settings.getByTestId('code-settings-update-card')).toContainText('2.2.49')
      await expect(
        settings.getByTestId('code-settings-follow-up-behavior').getByRole('button', { name: 'Queue' }),
      ).toBeEnabled({ timeout: 30_000 })
      const reminderInterval = settings.getByRole('spinbutton', { name: 'Custom reminder interval in minutes' })
      await expect(reminderInterval).toHaveCSS('width', '88px')
      await captureScenario(page, `appearance-${appearance}-settings`)
      await settings.getByRole('button', { name: 'Close', exact: true }).click()

      await page.getByTestId('code-nav-search').click()
      const search = page.getByTestId('code-search-panel')
      await search.getByRole('searchbox').fill('Theme review Agent')
      await expect(search.getByTestId('code-search-result')).toContainText('Theme review Agent')
      await captureScenario(page, `appearance-${appearance}-search`)

      await page.getByTestId('code-nav-history').click()
      const history = page.getByTestId('code-history-panel')
      await expect(history).toContainText('Theme history review')
      await captureScenario(page, `appearance-${appearance}-history`)

      await page.getByTestId('code-nav-plugins').click()
      const plugins = page.getByTestId('code-plugins-panel')
      await expect(plugins.getByText('Checking...', { exact: true })).toHaveCount(0, { timeout: 30_000 })
      await expect(plugins.getByText('Discovering...', { exact: true })).toHaveCount(0, { timeout: 30_000 })
      await expect(plugins.getByTestId('code-plugin-section-farming')).toBeVisible()
      await expect(plugins.getByTestId('code-plugin-shared-config-configure')).toBeEnabled({ timeout: 30_000 })
      await captureScenario(page, `appearance-${appearance}-plugins`)
    }
  })
})
