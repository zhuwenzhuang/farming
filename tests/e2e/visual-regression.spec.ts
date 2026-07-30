import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { expect, openFarming, test } from './fixtures'

export const VISUAL_SCENARIOS = [
  'sidebar-agent-hover',
  'sidebar-project-hover',
  'queued-followups-wide',
  'queued-followups-narrow',
  'changes-diff',
  'plugins-dark',
] as const

const outputDir = process.env.FARMING_VISUAL_OUTPUT_DIR
const visualRoot = path.join(os.tmpdir(), 'farming-visual-regression')

type ScreenshotOptions = {
  mask?: Locator[]
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
    await captureScenario(page, 'sidebar-agent-hover', { mask: [mainMask] })

    const alphaProject = page.getByTestId('code-project-group').filter({ has: alphaRow })
    const alphaTitle = alphaProject.getByTestId('code-project-title')
    await alphaTitle.hover()
    await expect(alphaProject.getByTestId('code-project-actions')).toBeVisible()
    await captureScenario(page, 'sidebar-project-hover', { mask: [mainMask] })

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
    await captureScenario(page, 'queued-followups-wide', { mask: [transcript] })

    await page.setViewportSize({ width: 390, height: 844 })
    await expect(page.locator('body')).toHaveClass(/code-compact-layout/)
    await expect(page.getByTestId('code-acp-pending-followup-row')).toHaveCount(2)
    await captureScenario(page, 'queued-followups-narrow', { mask: [transcript] })
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
    const [inputBackground, targetBackground] = await Promise.all([
      browserSource.evaluate(element => getComputedStyle(element).backgroundColor),
      desktopTarget.evaluate(element => getComputedStyle(element).backgroundColor),
    ])
    expect(targetBackground).toBe(inputBackground)
    await expect(panel.getByText('Checking...', { exact: true })).toHaveCount(0, { timeout: 30_000 })
    await expect(panel.getByText('Loading Agent extensions...', { exact: true })).toHaveCount(0, { timeout: 30_000 })
    await expect(panel.getByTestId('code-plugin-section-agent-codex-review')).toBeVisible()
    await captureScenario(page, 'plugins-dark', { mask: [panel.getByTestId('code-plugin-agent-sections')] })
  })
})
