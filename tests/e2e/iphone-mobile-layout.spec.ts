import fs from 'node:fs'
import path from 'node:path'
import type { Page, TestInfo } from '@playwright/test'
import { expect, interceptWorkspaceRequests, openFarming, terminalCheckpointOutput, test } from './fixtures'
import { createAcceptanceEvidence } from './acceptance-evidence'

const IPHONE_AUDIT_DIR = path.resolve(
  process.env.FARMING_IPHONE_MOBILE_AUDIT_DIR || '.tmp/iphone-mobile-layout-audit',
)
let iphoneEvidence: ReturnType<typeof createAcceptanceEvidence> | null = null

async function captureIphoneAudit(
  page: Page,
  testInfo: TestInfo,
  name: string,
  assertReady?: () => Promise<void>,
  settledAssertion = 'Scenario-specific assertions immediately before capture passed and the mobile main surface is visible',
) {
  iphoneEvidence ??= createAcceptanceEvidence(IPHONE_AUDIT_DIR, {
    manifestFileName: 'manifest-iphone-mobile-layout.json',
  })
  await iphoneEvidence.capture({
    page,
    testInfo,
    screenshotName: name,
    scenario: name.replace(/\.png$/i, ''),
    settledAssertion,
    assertReady,
    proofLocator: page.getByTestId('code-main'),
    expectedTestId: 'code-main',
    fullPage: true,
  })
}

type PublicControlAgent = {
  id: string
  runtimeBinding?: { kind?: string, state?: string }
}

async function controlAgents(page: Page) {
  const response = await page.request.get('/farming/api/control/agents')
  expect(response.ok()).toBeTruthy()
  const body = await response.json() as { agents?: PublicControlAgent[] }
  return body.agents ?? []
}

async function waitForAcpIdle(page: Page, agentId: string) {
  await expect.poll(async () => {
    const agent = (await controlAgents(page)).find(candidate => candidate.id === agentId)
    return agent?.runtimeBinding?.kind === 'acp' && agent.runtimeBinding.state === 'idle'
  }, {
    message: `Agent ${agentId} should have an authoritative idle ACP binding`,
    timeout: 30_000,
  }).toBe(true)
}

async function assertCenterHitTarget(locator: ReturnType<Page['locator']>) {
  await expect.poll(async () => locator.evaluate(element => {
    const rect = element.getBoundingClientRect()
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
    return rect.width > 0 && rect.height > 0 && Boolean(hit && (hit === element || element.contains(hit)))
  }), {
    message: 'Composer center should be the topmost touch target',
  }).toBe(true)
}

async function assertMobileDrawerClosed(page: Page) {
  const sidebar = page.getByTestId('code-sidebar')
  await expect(sidebar).toHaveClass(/collapsed/)
  await expect(page.getByTestId('code-mobile-sidebar-backdrop')).toHaveCount(0)
  await expect(page.locator('.code-context-menu:visible')).toHaveCount(0)

  const geometry = () => sidebar.evaluate(element => {
    const rect = element.getBoundingClientRect()
    const workspaceLeft = document.querySelector<HTMLElement>('[data-testid="code-workspace"]')
      ?.getBoundingClientRect().left ?? 0
    return {
      left: Math.round(rect.left * 10) / 10,
      right: Math.round(rect.right * 10) / 10,
      width: Math.round(rect.width * 10) / 10,
      transform: getComputedStyle(element).transform,
      runningAnimations: element.getAnimations().filter(animation => animation.playState === 'running').length,
      closed: rect.right <= workspaceLeft - 1,
    }
  })
  await expect.poll(async () => {
    const current = await geometry()
    return current.closed && current.runningAnimations === 0
  }, {
    message: 'Mobile sidebar should finish translating outside the viewport',
  }).toBe(true)
  const before = await geometry()
  await page.evaluate(() => new Promise<void>(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  }))
  expect(await geometry()).toEqual(before)
}

async function activateMobileAgent(page: Page, agentId: string) {
  const row = page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
  await page.getByTestId('code-mobile-menu').tap()
  await expect(row).toBeVisible({ timeout: 30_000 })
  await row.locator('.code-agent-row-copy').tap()
  const activePane = page.locator(`[data-testid="code-agent-work-pane"][data-agent-id="${agentId}"]`)
  await expect(activePane).toHaveClass(/active/)
  await expect(activePane).toBeVisible()
  await assertMobileDrawerClosed(page)
  const input = page.getByTestId('code-acp-composer-input')
  await expect(input).toBeVisible({ timeout: 30_000 })
  await assertCenterHitTarget(input)
}

async function createControlAgent(
  page: import('@playwright/test').Page,
  command: string,
  workspace: string,
  agentRuntimeMode: 'terminal' | 'chat' = 'terminal',
) {
  const response = await page.request.post('/farming/api/control/agents', {
    data: { command, workspace, agentRuntimeMode },
  })
  expect(response.ok()).toBeTruthy()
  const data = await response.json() as { agentId?: string }
  expect(data.agentId).toBeTruthy()
  return data.agentId as string
}

test.describe('iPhone mobile layout', () => {
  test('opens and toggles a sandboxed HTML preview inside the mobile file surface', async ({ page, workspaceRoot }, testInfo) => {
    test.skip(testInfo.project.name !== 'iphone-webkit', 'Runs only in the iPhone WebKit project')
    const projectDir = path.join(workspaceRoot, 'iphone-html-preview')
    fs.mkdirSync(path.join(projectDir, 'site'), { recursive: true })
    fs.writeFileSync(
      path.join(projectDir, 'site', 'index.html'),
      [
        '<!doctype html>',
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
        '<style>body { margin: 0; } h1 { color: rgb(12, 13, 14); }</style>',
        '<h1>Mobile HTML</h1><script>document.body.dataset.script = "ran"</script>',
      ].join('\n'),
    )

    await openFarming(page)
    await createControlAgent(page, 'bash', projectDir)
    await page.getByTestId('code-mobile-menu').click()
    const project = page.getByTestId('code-project-group').filter({ hasText: 'iphone-html-preview' })
    const files = project.getByTestId('code-files-section')
    const filesToggle = files.getByRole('button', { name: /^Files$/ })
    if (await filesToggle.getAttribute('aria-expanded') === 'false') await filesToggle.tap()
    const site = files.locator('[data-testid="code-file-row"][data-file-path="site"]')
    await site.tap()
    await files.locator('[data-testid="code-file-row"][data-file-path="site/index.html"]').tap()

    const iframe = page.getByTestId('code-file-html-preview')
    await expect(iframe).toBeVisible()
    const frame = page.frameLocator('[data-testid="code-file-html-preview"]')
    await expect(frame.locator('h1')).toHaveText('Mobile HTML')
    await expect.poll(() => frame.locator('h1').evaluate(element => getComputedStyle(element).color)).toBe('rgb(12, 13, 14)')
    await expect(frame.locator('body')).not.toHaveAttribute('data-script', 'ran')
    const previewMetrics = await iframe.evaluate(element => {
      const rect = element.getBoundingClientRect()
      const main = document.querySelector<HTMLElement>('[data-testid="code-main"]')?.getBoundingClientRect()
      return {
        width: rect.width,
        mainWidth: main?.width ?? 0,
        rightOverflow: main ? rect.right - main.right : 0,
      }
    })
    expect(previewMetrics.width).toBeGreaterThan(250)
    expect(previewMetrics.width).toBeLessThanOrEqual(previewMetrics.mainWidth + 1)
    expect(previewMetrics.rightOverflow).toBeLessThanOrEqual(1)

    const showSource = page.getByRole('button', { name: 'Show source' })
    const showSourceTarget = await showSource.evaluate(element => {
      const rect = element.getBoundingClientRect()
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
      return { width: rect.width, height: rect.height, centerHits: hit === element || element.contains(hit) }
    })
    expect(showSourceTarget.width).toBeGreaterThanOrEqual(44)
    expect(showSourceTarget.height).toBeGreaterThanOrEqual(44)
    expect(showSourceTarget.centerHits).toBe(true)
    await showSource.tap()
    await expect(page.getByTestId('code-file-monaco')).toBeVisible()
    const sourceActions = [
      page.getByTestId('code-file-editor-back'),
      page.getByRole('button', { name: 'Open preview' }),
    ]
    for (const action of sourceActions) {
      await expect(action).toBeVisible()
      const target = await action.evaluate(element => {
        const rect = element.getBoundingClientRect()
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
        return { width: rect.width, height: rect.height, centerHits: hit === element || element.contains(hit) }
      })
      expect(target.width).toBeGreaterThanOrEqual(44)
      expect(target.height).toBeGreaterThanOrEqual(44)
      expect(target.centerHits).toBe(true)
    }
    await sourceActions[1]!.tap()
    await expect(page.getByTestId('code-file-html-preview')).toBeVisible()
  })

  test('preserves a mobile editor draft and resolves an external save conflict through touch controls', async ({ page, workspaceRoot }, testInfo) => {
    test.skip(testInfo.project.name !== 'iphone-webkit', 'Runs only in the iPhone WebKit project')
    testInfo.setTimeout(120_000)
    await page.setViewportSize({ width: 320, height: 720 })
    const projectDir = path.join(workspaceRoot, 'iphone-file-save-conflict')
    const filePath = path.join(projectDir, 'editable.md')
    fs.mkdirSync(projectDir, { recursive: true })
    fs.writeFileSync(filePath, 'seed mobile text\n')
    const saves: Array<{ overwrite: boolean }> = []
    await interceptWorkspaceRequests(page, request => {
      if (request.operation === 'save-file' && request.path === 'editable.md') {
        saves.push({ overwrite: request.overwrite === true })
      }
    })

    await openFarming(page)
    await createControlAgent(page, 'bash', projectDir)
    await page.getByTestId('code-mobile-menu').tap()
    const project = page.getByTestId('code-project-group').filter({ hasText: 'iphone-file-save-conflict' })
    const files = project.getByTestId('code-files-section')
    const filesToggle = files.getByRole('button', { name: /^Files$/ })
    if (await filesToggle.getAttribute('aria-expanded') === 'false') await filesToggle.tap()
    await files.locator('[data-testid="code-file-row"][data-file-path="editable.md"]').tap()
    await page.getByRole('button', { name: 'Show Markdown source' }).tap()
    await expect(page.getByTestId('code-file-monaco')).toBeVisible()

    await page.evaluate(() => window.__farmingFileEditorTest?.insertText('SAVED_FROM_MOBILE\n'))
    const save = page.getByRole('button', { name: 'Save file' })
    const actionBar = page.locator('.code-file-editor-tab-strip > .code-file-editor-actions')
    const actionButtons = actionBar.getByRole('button')
    const actionCount = await actionButtons.count()
    expect(actionCount).toBeGreaterThanOrEqual(6)
    const overflow = await actionBar.evaluate(element => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }))
    expect(overflow.scrollWidth).toBeGreaterThan(overflow.clientWidth)
    for (const index of [...Array(actionCount).keys()].reverse()) {
      const action = actionButtons.nth(index)
      await action.evaluate(element => element.scrollIntoView({ block: 'nearest', inline: 'center' }))
      await expect.poll(() => action.evaluate(element => {
        const rect = element.getBoundingClientRect()
        const scroller = element.closest<HTMLElement>('.code-file-editor-actions')
        const scrollerRect = scroller?.getBoundingClientRect()
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
        return {
          width: rect.width,
          height: rect.height,
          centerInsideScroller: Boolean(
            scrollerRect
            && rect.left + rect.width / 2 >= scrollerRect.left
            && rect.left + rect.width / 2 <= scrollerRect.right
          ),
          centerHits: hit === element || element.contains(hit),
        }
      })).toEqual({
        width: 44,
        height: 44,
        centerInsideScroller: true,
        centerHits: true,
      })
    }
    await save.tap()
    await expect.poll(() => saves.length).toBe(1)
    await expect.poll(() => fs.readFileSync(filePath, 'utf8')).toContain('SAVED_FROM_MOBILE')

    await page.evaluate(() => window.__farmingFileEditorTest?.insertText('LOCAL_DRAFT_SURVIVES_RELOAD\n'))
    await expect.poll(() => page.evaluate(() => window.__farmingFileEditorTest?.getValue() ?? ''))
      .toContain('LOCAL_DRAFT_SURVIVES_RELOAD')
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: 'Show Markdown source' }).tap()
    await expect(page.getByTestId('code-file-monaco')).toBeVisible()
    await expect.poll(() => page.evaluate(() => window.__farmingFileEditorTest?.getValue() ?? ''))
      .toContain('LOCAL_DRAFT_SURVIVES_RELOAD')

    fs.writeFileSync(filePath, 'EXTERNAL_MOBILE_CHANGE\n')
    const changedOnDisk = page.getByTestId('code-file-editor').getByTitle('Changed on disk')
    const watcherDetectedConflict = await expect(changedOnDisk).toBeVisible({ timeout: 2_000 })
      .then(() => true, () => false)
    if (!watcherDetectedConflict) {
      await page.getByRole('button', { name: 'Save file' }).tap()
      await expect.poll(() => saves.length).toBe(2)
    }
    await expect(changedOnDisk).toBeVisible()
    await expect.poll(() => page.evaluate(() => window.__farmingFileEditorTest?.getValue() ?? ''))
      .toContain('LOCAL_DRAFT_SURVIVES_RELOAD')

    const conflictToolbar = await actionBar.evaluate(element => {
      element.scrollLeft = 0
      const scrollerRect = element.getBoundingClientRect()
      const buttons = [...element.querySelectorAll<HTMLElement>('button')].map(button => {
        const rect = button.getBoundingClientRect()
        return { left: rect.left, right: rect.right }
      })
      return {
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
        allButtonsInside: buttons.every(button => button.left >= scrollerRect.left && button.right <= scrollerRect.right),
      }
    })
    expect(conflictToolbar.scrollWidth).toBeLessThanOrEqual(conflictToolbar.clientWidth + 1)
    expect(conflictToolbar.allButtonsInside).toBe(true)

    const conflictActions = [
      page.getByRole('button', { name: 'Reload file' }),
      page.getByRole('button', { name: 'Overwrite changed file' }),
    ]
    for (const action of conflictActions) {
      const target = await action.evaluate(element => {
        const rect = element.getBoundingClientRect()
        const scrollerRect = element.closest<HTMLElement>('.code-file-editor-actions')?.getBoundingClientRect()
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
        return {
          width: rect.width,
          height: rect.height,
          fullyInsideScroller: Boolean(scrollerRect && rect.left >= scrollerRect.left && rect.right <= scrollerRect.right),
          centerHits: hit === element || element.contains(hit),
        }
      })
      expect(target.width).toBeGreaterThanOrEqual(44)
      expect(target.height).toBeGreaterThanOrEqual(44)
      expect(target.fullyInsideScroller).toBe(true)
      expect(target.centerHits).toBe(true)
    }
    for (const appearance of ['light', 'dark', 'paper'] as const) {
      await page.locator('body').evaluate((body, value) => {
        document.documentElement.dataset.appearance = value
        body.dataset.appearance = value
      }, appearance)
      const layout = await page.getByTestId('code-file-editor').evaluate(element => {
        const rect = element.getBoundingClientRect()
        return {
          left: rect.left,
          right: rect.right,
          documentWidth: document.documentElement.scrollWidth,
          viewportWidth: window.innerWidth,
        }
      })
      expect(layout.left).toBeGreaterThanOrEqual(0)
      expect(layout.right).toBeLessThanOrEqual(layout.viewportWidth + 1)
      expect(layout.documentWidth).toBe(layout.viewportWidth)
      await captureIphoneAudit(page, testInfo, `iphone-file-conflict-${appearance}.png`)
    }
    const savesBeforeOverwrite = saves.length
    await conflictActions[1]!.tap()
    await expect.poll(() => saves.length).toBe(savesBeforeOverwrite + 1)
    expect(saves[0]).toEqual({ overwrite: false })
    expect(saves.at(-1)).toEqual({ overwrite: true })
    await expect.poll(() => fs.readFileSync(filePath, 'utf8')).toContain('LOCAL_DRAFT_SURVIVES_RELOAD')
    await expect(page.getByTestId('code-file-editor').getByTitle('Changed on disk')).toHaveCount(0)
  })

  test('keeps a long ACP model label outside the iPhone send-button hit target', async ({ page, workspaceRoot }, testInfo) => {
    test.skip(testInfo.project.name !== 'iphone-webkit', 'Runs only in the iPhone WebKit project')
    const projectDir = path.join(workspaceRoot, 'iphone-long-model-label')
    fs.mkdirSync(projectDir, { recursive: true })
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'maxTouchPoints', { value: 5, configurable: true })
    })
    await openFarming(page)

    const agentId = await createControlAgent(page, 'opencode', projectDir, 'chat')
    await page.getByTestId('code-mobile-menu').click()
    await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
    const modelPicker = page.getByTestId('code-acp-model-picker')
    await expect(modelPicker).toBeVisible({ timeout: 30_000 })
    await modelPicker.locator('.code-composer-model-label.mobile').evaluate(element => {
      element.textContent = 'OpenCode Zen/Big Pickle'
    })

    const input = page.getByTestId('code-acp-composer-input')
    const send = page.getByTestId('code-acp-composer-send')
    await input.tap()
    await page.keyboard.insertText('LONG_MODEL_HIT_TARGET_OK')
    await expect(send).toHaveAttribute('data-action', 'send')
    expect(await send.evaluate(element => {
      const rect = element.getBoundingClientRect()
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
      return hit === element || element.contains(hit)
    })).toBe(true)
    const touchTargets = await page.evaluate(() => {
      const rect = (selector: string) => {
        const value = document.querySelector<HTMLElement>(selector)?.getBoundingClientRect()
        return value ? { width: value.width, height: value.height } : null
      }
      return {
        add: rect('[data-testid="code-acp-composer-add"]'),
        model: rect('[data-testid="code-acp-model-picker"]'),
        send: rect('[data-testid="code-acp-composer-send"]'),
      }
    })
    for (const target of Object.values(touchTargets)) {
      expect(target?.width).toBeGreaterThanOrEqual(44)
      expect(target?.height).toBeGreaterThanOrEqual(44)
    }
    await modelPicker.tap()
    const modelMenu = page.getByTestId('code-acp-model-menu')
    await expect(modelMenu).toBeVisible()
    const modelMenuBounds = await modelMenu.evaluate(element => {
      const rect = element.getBoundingClientRect()
      const viewport = window.visualViewport
      const left = viewport?.offsetLeft ?? 0
      const top = viewport?.offsetTop ?? 0
      return {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        viewportLeft: left,
        viewportRight: left + (viewport?.width ?? window.innerWidth),
        viewportTop: top,
        viewportBottom: top + (viewport?.height ?? window.innerHeight),
      }
    })
    expect(modelMenuBounds.left).toBeGreaterThanOrEqual(modelMenuBounds.viewportLeft - 1)
    expect(modelMenuBounds.right).toBeLessThanOrEqual(modelMenuBounds.viewportRight + 1)
    expect(modelMenuBounds.top).toBeGreaterThanOrEqual(modelMenuBounds.viewportTop - 1)
    expect(modelMenuBounds.bottom).toBeLessThanOrEqual(modelMenuBounds.viewportBottom + 1)
    await captureIphoneAudit(page, testInfo, 'iphone-webkit-long-model-label.png')
    await page.keyboard.press('Escape')
    await send.click()
    await expect(input).toHaveValue('')
  })

  test('keeps a real image attachment and its remove control inside the iPhone composer', async ({ page, workspaceRoot }, testInfo) => {
    test.skip(testInfo.project.name !== 'iphone-webkit', 'Runs only in the iPhone WebKit project')
    const projectDir = path.join(workspaceRoot, 'iphone-image-attachment')
    fs.mkdirSync(projectDir, { recursive: true })
    const imagePath = path.join(projectDir, 'attachment.png')
    fs.copyFileSync(path.resolve('public/farming-2/app-icon-v2-180.png'), imagePath)
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'maxTouchPoints', { value: 5, configurable: true })
    })
    await openFarming(page)

    const agentId = await createControlAgent(page, 'opencode', projectDir, 'chat')
    await page.getByTestId('code-mobile-menu').click()
    await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
    await expect(page.getByTestId('code-acp-composer-input')).toBeVisible({ timeout: 30_000 })
    await page.getByTestId('code-acp-composer-file-input').setInputFiles(imagePath)

    const composer = page.getByTestId('code-acp-composer')
    const attachment = page.getByTestId('code-composer-attachment')
    const remove = attachment.getByRole('button', { name: 'Remove attachment.png' })
    const toolbar = page.getByTestId('code-acp-composer-toolbar')
    await expect(composer).toHaveClass(/has-attachments/)
    await expect(attachment).toHaveClass(/image/)
    await expect(attachment).toHaveClass(/ready/, { timeout: 15_000 })
    await expect(attachment).not.toContainText('attachment.png')

    const geometry = await page.evaluate(() => {
      const composer = document.querySelector<HTMLElement>('[data-testid="code-acp-composer"]')?.getBoundingClientRect()
      const attachment = document.querySelector<HTMLElement>('[data-testid="code-composer-attachment"]')?.getBoundingClientRect()
      const remove = document.querySelector<HTMLElement>('[data-testid="code-composer-attachment"] button')?.getBoundingClientRect()
      const toolbar = document.querySelector<HTMLElement>('[data-testid="code-acp-composer-toolbar"]')?.getBoundingClientRect()
      if (!composer || !attachment || !remove || !toolbar) throw new Error('Attachment geometry is incomplete')
      const hit = document.elementFromPoint(remove.left + remove.width / 2, remove.top + remove.height / 2)
      return {
        composer: { top: composer.top, bottom: composer.bottom, height: composer.height },
        attachment: { top: attachment.top, bottom: attachment.bottom, height: attachment.height },
        toolbar: { top: toolbar.top, bottom: toolbar.bottom },
        remove: { width: remove.width, height: remove.height },
        removeIsHit: hit instanceof Element && Boolean(hit.closest('.code-composer-attachment-remove')),
        viewportHeight: window.innerHeight,
      }
    })
    expect(geometry.composer.height).toBeGreaterThanOrEqual(180)
    expect(geometry.composer.bottom).toBeLessThanOrEqual(geometry.viewportHeight)
    expect(geometry.attachment.top).toBeGreaterThanOrEqual(geometry.composer.top)
    expect(geometry.attachment.bottom).toBeLessThanOrEqual(geometry.toolbar.top)
    expect(geometry.toolbar.bottom).toBeLessThanOrEqual(geometry.composer.bottom)
    expect(geometry.remove.width).toBeGreaterThanOrEqual(44)
    expect(geometry.remove.height).toBeGreaterThanOrEqual(44)
    expect(geometry.removeIsHit).toBe(true)

    await captureIphoneAudit(page, testInfo, 'iphone-webkit-image-attachment.png')
    await remove.click()
    await expect(attachment).toHaveCount(0)
    await expect(composer).not.toHaveClass(/has-attachments/)
    await expect.poll(async () => composer.evaluate(element => element.getBoundingClientRect().height)).toBeLessThanOrEqual(118)
  })

  test('does not let ACP slash commands consume iPhone IME composition keys', async ({ page, workspaceRoot }, testInfo) => {
    test.skip(testInfo.project.name !== 'iphone-webkit', 'Runs only in the iPhone WebKit project')
    const projectDir = path.join(workspaceRoot, 'iphone-acp-ime')
    fs.mkdirSync(projectDir, { recursive: true })
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'maxTouchPoints', { value: 5, configurable: true })
    })
    await openFarming(page)

    const agentId = await createControlAgent(page, 'opencode', projectDir, 'chat')
    await page.getByTestId('code-mobile-menu').click()
    await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
    await expect(page.getByTestId('code-acp-model-picker')).toBeVisible({ timeout: 30_000 })
    const input = page.getByTestId('code-acp-composer-input')
    await input.tap()
    await input.fill('rich timeline')
    await page.keyboard.press('Enter')
    await expect(input).toHaveValue('rich timeline\n')
    await page.getByTestId('code-acp-composer-send').tap()
    await expect(page.getByText('Rich ACP timeline complete.', { exact: true })).toBeVisible({ timeout: 30_000 })
    await input.tap()
    await page.keyboard.insertText('/')
    await expect(page.getByTestId('code-acp-command-review')).toBeVisible({ timeout: 30_000 })

    await input.evaluate(element => {
      element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }))
      const composingEnter = new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        key: 'Enter',
        code: 'Enter',
        isComposing: true,
      })
      Object.defineProperty(composingEnter, 'keyCode', { value: 229 })
      element.dispatchEvent(composingEnter)
    })
    await expect(input).toHaveValue('/')
    await expect(page.getByTestId('code-acp-command-review')).toBeVisible()
    await captureIphoneAudit(page, testInfo, 'iphone-webkit-ime-slash-menu.png')

    await input.evaluate(element => {
      element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中' }))
      element.dispatchEvent(new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        key: 'Enter',
        code: 'Enter',
      }))
    })
    await expect(input).toHaveValue('/')
    await expect(page.getByTestId('code-acp-command-review')).toBeVisible()
  })

  test('taps send and stop through a complete running ACP turn on iPhone', async ({ page, workspaceRoot }, testInfo) => {
    test.skip(testInfo.project.name !== 'iphone-webkit', 'Runs only in the iPhone WebKit project')
    const projectDir = path.join(workspaceRoot, 'iphone-acp-interrupt')
    fs.mkdirSync(projectDir, { recursive: true })
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'maxTouchPoints', { value: 5, configurable: true })
    })
    await openFarming(page)

    const agentId = await createControlAgent(page, 'opencode', projectDir, 'chat')
    await activateMobileAgent(page, agentId)
    const input = page.getByTestId('code-acp-composer-input')
    const send = page.getByTestId('code-acp-composer-send')
    await expect(page.getByTestId('code-acp-model-picker')).toBeVisible({ timeout: 30_000 })
    await input.tap()
    await page.keyboard.insertText('mobile interrupt')
    await expect(send).toHaveAttribute('data-action', 'send')
    await expect(send).toHaveCSS('width', '44px')
    await expect(send).toHaveCSS('height', '44px')
    await send.tap()
    await expect(send).toHaveAttribute('data-action', 'interrupt', { timeout: 15_000 })
    const processSummary = page.getByTestId('code-agent-transcript-process-summary')
    await expect(processSummary).toBeVisible()
    await processSummary.tap()
    await expect(page.getByText('Mobile interrupt waiting.', { exact: true })).toBeVisible()
    await captureIphoneAudit(page, testInfo, 'iphone-webkit-acp-running.png')
    await send.tap()
    const assertStoppedReady = async () => {
      await expect(page.getByText('Mobile interrupt stopped.', { exact: true })).toBeVisible({ timeout: 15_000 })
      await expect(send).not.toHaveAttribute('data-action', 'interrupt')
      await waitForAcpIdle(page, agentId)
    }
    await assertStoppedReady()
    await captureIphoneAudit(
      page,
      testInfo,
      'iphone-webkit-acp-stopped.png',
      assertStoppedReady,
      'The stopped transcript text is visible and the authoritative ACP binding is idle',
    )
  })

  test('keeps every ACP permission action visible and tappable on iPhone', async ({ page, workspaceRoot }, testInfo) => {
    test.skip(testInfo.project.name !== 'iphone-webkit', 'Runs only in the iPhone WebKit project')
    const projectDir = path.join(workspaceRoot, 'iphone-acp-permission')
    fs.mkdirSync(projectDir, { recursive: true })
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'maxTouchPoints', { value: 5, configurable: true })
    })
    await openFarming(page)

    const agentId = await createControlAgent(page, 'opencode', projectDir, 'chat')
    await page.getByTestId('code-mobile-menu').tap()
    await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).tap()
    const input = page.getByTestId('code-acp-composer-input')
    await expect(input).toBeVisible({ timeout: 30_000 })
    await input.tap()
    await page.keyboard.insertText('unicode permission')
    await page.getByTestId('code-acp-composer-send').tap()

    const composer = page.getByTestId('code-acp-composer')
    const permission = page.getByTestId('code-acp-permission-request')
    const actions = permission.locator('.code-acp-request-actions')
    await expect(permission).toBeVisible({ timeout: 15_000 })
    await expect(actions.getByLabel('Permission scope')).toBeVisible()
    await expect(actions.getByRole('button', { name: /Approve|Allow/ })).toBeVisible()
    await expect(actions.getByRole('button', { name: 'Deny' })).toBeVisible()
    await expect(actions.getByRole('button', { name: 'Cancel' })).toBeVisible()

    const geometry = await page.evaluate(() => {
      const composer = document.querySelector<HTMLElement>('[data-testid="code-acp-composer"]')?.getBoundingClientRect()
      const permission = document.querySelector<HTMLElement>('[data-testid="code-acp-permission-request"]')?.getBoundingClientRect()
      const actions = document.querySelector<HTMLElement>('[data-testid="code-acp-permission-request"] .code-acp-request-actions')?.getBoundingClientRect()
      const scope = document.querySelector<HTMLElement>('[data-testid="code-acp-permission-request"] .code-acp-request-actions .code-select-trigger')
      const controls = [
        scope,
        ...document.querySelectorAll<HTMLElement>('[data-testid="code-acp-permission-request"] .code-acp-request-actions > button'),
      ].filter((control): control is HTMLElement => Boolean(control))
      if (!composer || !permission || !actions || controls.length !== 4) throw new Error('Permission action geometry is incomplete')
      return {
        documentWidth: document.documentElement.scrollWidth,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        composer: { left: composer.left, right: composer.right, top: composer.top, bottom: composer.bottom },
        permission: { left: permission.left, right: permission.right, top: permission.top, bottom: permission.bottom },
        actions: { left: actions.left, right: actions.right, top: actions.top, bottom: actions.bottom },
        controls: controls.map(control => {
          const rect = control.getBoundingClientRect()
          const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
          return {
            label: control.getAttribute('aria-label') || control.textContent?.trim() || control.tagName,
            left: rect.left,
            right: rect.right,
            top: rect.top,
            bottom: rect.bottom,
            width: rect.width,
            height: rect.height,
            centerHitsControl: hit === control || control.contains(hit),
          }
        }),
      }
    })
    expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.viewport.width + 1)
    expect(geometry.permission.left).toBeGreaterThanOrEqual(geometry.composer.left)
    expect(geometry.permission.right).toBeLessThanOrEqual(geometry.composer.right)
    expect(geometry.actions.left).toBeGreaterThanOrEqual(geometry.permission.left)
    expect(geometry.actions.right).toBeLessThanOrEqual(geometry.permission.right)
    expect(geometry.actions.top).toBeGreaterThanOrEqual(geometry.permission.top)
    expect(geometry.actions.bottom).toBeLessThanOrEqual(geometry.permission.bottom)
    for (const control of geometry.controls) {
      expect(control.width, `${control.label} width`).toBeGreaterThanOrEqual(44)
      expect(control.height, `${control.label} height`).toBeGreaterThanOrEqual(44)
      expect(control.left, `${control.label} left edge`).toBeGreaterThanOrEqual(geometry.permission.left)
      expect(control.right, `${control.label} right edge`).toBeLessThanOrEqual(geometry.permission.right)
      expect(control.top, `${control.label} top edge`).toBeGreaterThanOrEqual(geometry.permission.top)
      expect(control.bottom, `${control.label} bottom edge`).toBeLessThanOrEqual(geometry.permission.bottom)
      expect(control.centerHitsControl, `${control.label} center hit`).toBe(true)
    }

    await captureIphoneAudit(page, testInfo, 'iphone-webkit-acp-permission-request.png')
    await permission.evaluate(element => { element.scrollTop = element.scrollHeight })
    await expect(permission.getByTestId('code-acp-permission-risk')).toBeInViewport()
    await expect(actions.getByRole('button', { name: 'Cancel' })).toBeInViewport()
    expect(await actions.getByRole('button', { name: 'Cancel' }).evaluate(element => {
      const rect = element.getBoundingClientRect()
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
      return hit === element || element.contains(hit)
    })).toBe(true)
    await captureIphoneAudit(page, testInfo, 'iphone-webkit-acp-permission-risk.png')
    await actions.getByRole('button', { name: 'Cancel' }).tap()
    await expect(permission).toBeHidden()
  })

  test('switches Agents and closes the drawer through iPhone touch targets', async ({ page, workspaceRoot }, testInfo) => {
    test.skip(testInfo.project.name !== 'iphone-webkit', 'Runs only in the iPhone WebKit project')
    const projectDir = path.join(workspaceRoot, 'iphone-drawer-touch')
    fs.mkdirSync(projectDir, { recursive: true })
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'maxTouchPoints', { value: 5, configurable: true })
    })
    await openFarming(page)

    const firstAgentId = await createControlAgent(page, 'bash', projectDir)
    const secondAgentId = await createControlAgent(page, 'bash', projectDir)
    const menu = page.getByTestId('code-mobile-menu')
    await expect(menu).toHaveCSS('width', '44px')
    await expect(menu).toHaveCSS('height', '44px')
    await menu.tap()
    await page.locator(`[data-testid="code-agent-row"][data-agent-id="${firstAgentId}"]`).tap()
    await expect(page.locator(`[data-testid="code-terminal-pane"][data-agent-id="${firstAgentId}"]`)).toBeVisible({ timeout: 30_000 })
    await menu.tap()
    await page.locator(`[data-testid="code-agent-row"][data-agent-id="${secondAgentId}"]`).tap()
    await expect(page.locator(`[data-testid="code-terminal-pane"][data-agent-id="${secondAgentId}"]`)).toBeVisible({ timeout: 30_000 })
    await menu.tap()
    await expect(page.getByTestId('code-sidebar')).not.toHaveClass(/collapsed/)
    const more = page.locator(`[data-testid="code-agent-row"][data-agent-id="${secondAgentId}"]`).getByTestId('code-agent-row-more')
    await expect(more).toHaveCSS('width', '44px')
    await expect(more).toHaveCSS('height', '44px')
    const mobileUsage = page.getByTestId('code-mobile-usage-open')
    const assertDrawerReady = async () => {
      await expect(page.getByTestId('code-sidebar')).not.toHaveClass(/collapsed/)
      await expect(more).toBeVisible()
      await expect(mobileUsage).toBeVisible({ timeout: 30_000 })
      await expect(mobileUsage).toContainText('Usage')
      await expect(mobileUsage).toHaveCSS('min-height', '44px')
    }
    await assertDrawerReady()
    await captureIphoneAudit(
      page,
      testInfo,
      'iphone-webkit-agent-drawer.png',
      assertDrawerReady,
      'The open iPhone drawer includes two touch-switchable Agents and the loaded mobile Usage row',
    )
    await page.getByTestId('code-mobile-sidebar-backdrop').tap({ position: { x: 380, y: 400 } })
    await expect(page.getByTestId('code-sidebar')).toHaveClass(/collapsed/)
  })

  test('reloads an iPhone terminal and executes the next touch submission exactly once', async ({ page, workspaceRoot }, testInfo) => {
    test.skip(testInfo.project.name !== 'iphone-webkit', 'Runs only in the iPhone WebKit project')
    const projectDir = path.join(workspaceRoot, 'iphone-terminal-reload')
    fs.mkdirSync(projectDir, { recursive: true })
    const outputPath = path.join(projectDir, 'after-mobile-reload.txt')
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'maxTouchPoints', { value: 5, configurable: true })
    })
    await openFarming(page)

    const agentId = await createControlAgent(page, 'bash', projectDir)
    await page.getByTestId('code-mobile-menu').tap()
    await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).tap()
    await page.waitForFunction(id => Boolean(window.__farmingTerminalTest?.isReady(id)), agentId, { timeout: 30_000 })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.locator('body')).toHaveClass(/code-compact-layout/)
    await page.getByTestId('code-mobile-menu').tap()
    await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).tap()
    await page.waitForFunction(id => Boolean(window.__farmingTerminalTest?.isReady(id)), agentId, { timeout: 30_000 })

    const input = page.getByTestId('code-composer-input')
    const send = page.getByTestId('code-composer-send')
    await input.tap()
    await page.keyboard.insertText("printf 'MOBILE_RELOAD_ONCE\\n' >> after-mobile-reload.txt; printf 'MOBILE_RELOAD_UI_%s\\n' 'OK'")
    await send.tap()
    await expect.poll(() => fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : '', { timeout: 15_000 })
      .toBe('MOBILE_RELOAD_ONCE\n')
    await expect.poll(async () => {
      return terminalCheckpointOutput(page, agentId)
    }, { timeout: 15_000 }).toContain('MOBILE_RELOAD_UI_OK')
    await expect.poll(async () => page.evaluate(
      id => (window.__farmingTerminalTest?.getRows(id, 10_000) ?? []).join('\n'),
      agentId,
    ), { timeout: 15_000 }).toContain('MOBILE_RELOAD_UI_OK')
    await page.evaluate(async id => window.__farmingTerminalTest?.resumeLive(id), agentId)
    await captureIphoneAudit(page, testInfo, 'iphone-webkit-terminal-after-reload.png')
  })

  test('keeps the shared compact layout usable after iPhone landscape rotation', async ({ page, workspaceRoot }, testInfo) => {
    test.skip(testInfo.project.name !== 'iphone-webkit', 'Runs only in the iPhone WebKit project')
    const projectDir = path.join(workspaceRoot, 'iphone-landscape')
    fs.mkdirSync(projectDir, { recursive: true })
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'maxTouchPoints', { value: 5, configurable: true })
    })
    await openFarming(page)

    const agentId = await createControlAgent(page, 'bash', projectDir)
    await page.getByTestId('code-mobile-menu').tap()
    await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).tap()
    await expect(page.getByTestId('code-mobile-sidebar-backdrop')).toHaveCount(0)
    await page.setViewportSize({ width: 844, height: 390 })
    await expect(page.locator('body')).toHaveClass(/code-compact-layout/)
    await expect.poll(async () => page.evaluate(() => {
      const main = document.querySelector<HTMLElement>('[data-testid="code-main"]')?.getBoundingClientRect()
      return main ? { right: Math.round(main.right), viewportWidth: window.innerWidth } : null
    }), { timeout: 5_000 }).toEqual({ right: 844, viewportWidth: 844 })
    const geometry = await page.evaluate(() => {
      const composer = document.querySelector<HTMLElement>('[data-testid="code-composer"]')?.getBoundingClientRect()
      const main = document.querySelector<HTMLElement>('[data-testid="code-main"]')?.getBoundingClientRect()
      if (!composer || !main) throw new Error('Landscape compact layout is incomplete')
      return {
        bodyWidth: document.body.scrollWidth,
        main: { left: main.left, right: main.right },
        composer: { left: composer.left, right: composer.right, bottom: composer.bottom },
        viewport: { width: window.innerWidth, height: window.innerHeight },
      }
    })
    expect(geometry.bodyWidth).toBeLessThanOrEqual(geometry.viewport.width + 1)
    expect(geometry.main.left).toBe(0)
    expect(geometry.main.right).toBe(geometry.viewport.width)
    expect(geometry.composer.left).toBeGreaterThanOrEqual(4)
    expect(geometry.composer.right).toBeLessThanOrEqual(geometry.viewport.width - 4)
    expect(geometry.composer.bottom).toBeLessThanOrEqual(geometry.viewport.height)
    const input = page.getByTestId('code-composer-input')
    await input.tap()
    await page.keyboard.insertText('echo IPHONE_LANDSCAPE_OK')
    await page.getByTestId('code-composer-send').tap()
    await expect.poll(async () => {
      return terminalCheckpointOutput(page, agentId)
    }, { timeout: 30_000 }).toContain('IPHONE_LANDSCAPE_OK')
    await expect.poll(async () => page.evaluate(
      id => (window.__farmingTerminalTest?.getRows(id, 10_000) ?? []).join('\n'),
      agentId,
    ), { timeout: 15_000 }).toContain('IPHONE_LANDSCAPE_OK')
    await page.evaluate(async id => window.__farmingTerminalTest?.resumeLive(id), agentId)
    await captureIphoneAudit(page, testInfo, 'iphone-webkit-landscape.png')
  })

  test('uses the same compact structure at 390px for desktop and iPhone input modes', async ({ page, workspaceRoot }, testInfo) => {
    const projectDir = path.join(workspaceRoot, `compact-parity-${testInfo.project.name}`)
    fs.mkdirSync(projectDir, { recursive: true })
    await page.setViewportSize({ width: 390, height: 844 })

    if (testInfo.project.name === 'iphone-webkit') {
      await page.addInitScript(() => {
        Object.defineProperty(navigator, 'maxTouchPoints', { value: 5, configurable: true })
      })
    }

    await openFarming(page)
    const agentId = await createControlAgent(page, 'bash', projectDir)
    const agentRow = page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
    await page.getByTestId('code-mobile-menu').click()
    await expect(agentRow).toBeVisible({ timeout: 30_000 })
    await agentRow.click()
    await expect(page.getByTestId('code-sidebar')).toHaveClass(/collapsed/)
    await expect(page.locator(`[data-testid="code-terminal-pane"][data-agent-id="${agentId}"]`)).toBeVisible({ timeout: 30_000 })

    await expect(page.locator('body')).toHaveClass(/code-compact-layout/)
    await expect(page.getByTestId('code-mobile-menu')).toBeVisible()
    await expect(page.getByTestId('code-mobile-more')).toBeVisible()
    await expect(page.getByTestId('code-composer-input')).toHaveJSProperty('tagName', 'TEXTAREA')
    if (testInfo.project.name === 'iphone-webkit') {
      await expect(page.locator('body')).toHaveClass(/code-mobile-touch/)
    } else {
      await expect(page.locator('body')).not.toHaveClass(/code-mobile-touch/)
    }

    const geometry = await page.evaluate(() => {
      const main = document.querySelector('[data-testid="code-main"]')?.getBoundingClientRect()
      const topbar = document.querySelector('[data-testid="code-mobile-topbar"]')?.getBoundingClientRect()
      const composer = document.querySelector('[data-testid="code-composer"]')?.getBoundingClientRect()
      if (!main || !topbar || !composer) throw new Error('Compact layout geometry is incomplete')
      return {
        main: { left: Math.round(main.left), right: Math.round(main.right), width: Math.round(main.width) },
        topbar: { left: Math.round(topbar.left), right: Math.round(topbar.right), height: Math.round(topbar.height) },
        composer: { left: Math.round(composer.left), right: Math.round(composer.right), height: Math.round(composer.height) },
      }
    })
    expect(geometry.main).toEqual({ left: 0, right: 390, width: 390 })
    expect(geometry.topbar.left).toBe(0)
    expect(geometry.topbar.right).toBe(390)
    expect(geometry.composer.left).toBeGreaterThanOrEqual(4)
    expect(geometry.composer.right).toBeLessThanOrEqual(386)

    const input = page.getByTestId('code-composer-input')
    const composer = page.getByTestId('code-composer')
    const blankPoint = await composer.evaluate(element => {
      const rect = element.getBoundingClientRect()
      for (let y = rect.top + 4; y < rect.bottom - 4; y += 4) {
        for (let x = rect.left + 4; x < rect.right - 4; x += 4) {
          if (document.elementFromPoint(x, y) === element) return { x, y }
        }
      }
      return null
    })
    expect(blankPoint).not.toBeNull()
    await page.mouse.click(blankPoint!.x, blankPoint!.y)
    await expect(input).toBeFocused()
    const readyMarker = `COMPACT_PARITY_READY_${testInfo.project.name.replace(/\W+/g, '_')}`
    await input.click()
    await page.keyboard.insertText(`echo ${readyMarker}`)
    await expect(input).toHaveValue(`echo ${readyMarker}`)
    await page.keyboard.press('Enter')
    await expect(input).toHaveValue(`echo ${readyMarker}\n`)
    const sendButton = page.getByTestId('code-composer-send')
    if (testInfo.project.name === 'iphone-webkit') await sendButton.tap()
    else await sendButton.click()
    await expect(input).toHaveValue('')
    await expect.poll(async () => {
      return terminalCheckpointOutput(page, agentId)
    }, { timeout: 30_000 }).toContain(readyMarker)
    await page.evaluate(async id => window.__farmingTerminalTest?.resumeLive(id), agentId)

    await captureIphoneAudit(page, testInfo, `${testInfo.project.name}-390px-compact-parity.png`)
  })

  test('settles the standalone composer at its product-defined viewport gap', async ({ page, workspaceRoot }, testInfo) => {
    test.skip(testInfo.project.name !== 'iphone-webkit', 'Runs only in the iPhone WebKit project')
    const projectDir = path.join(workspaceRoot, 'iphone-standalone-composer')
    fs.mkdirSync(projectDir, { recursive: true })
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'maxTouchPoints', { value: 5, configurable: true })
    })
    await openFarming(page)

    const agentId = await createControlAgent(page, 'bash', projectDir)
    await page.getByTestId('code-mobile-menu').click()
    await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
    const composer = page.getByTestId('code-composer')
    await expect(composer).toBeVisible({ timeout: 30_000 })

    const readGap = () => composer.evaluate(element => {
      const main = element.closest('.code-main') as HTMLElement | null
      if (!main) throw new Error('Mobile main surface is missing')
      return main.getBoundingClientRect().bottom - (element as HTMLElement).getBoundingClientRect().bottom
    })
    const waitForStableGap = async () => {
      let previous: number | null = null
      let stableSamples = 0
      await expect.poll(async () => {
        const gap = await readGap()
        if (previous !== null && Math.abs(gap - previous) <= 0.1) stableSamples += 1
        else stableSamples = 0
        previous = gap
        return stableSamples
      }, { message: 'composer should finish its bottom-position transition' }).toBeGreaterThanOrEqual(2)
      return readGap()
    }

    const restingGap = await waitForStableGap()
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'standalone', { value: true, configurable: true })
      window.dispatchEvent(new Event('resize'))
    })
    await expect(page.locator('body')).toHaveClass(/code-mobile-standalone/)
    const standaloneGap = await waitForStableGap()

    expect(restingGap).toBeGreaterThanOrEqual(4)
    expect(restingGap).toBeLessThanOrEqual(32)
    expect(standaloneGap).toBeGreaterThanOrEqual(43)
    expect(standaloneGap).toBeLessThanOrEqual(45)
  })

  test('opens the mobile share sheet from a successful authenticated ticket response', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'iphone-webkit', 'Runs only in the iPhone WebKit project')
    const readOnlyUrl = 'https://share.example.test/farming?token=read-only'
    const fullAccessUrl = 'https://share.example.test/farming?token=full-control'
    let revokeCount = 0
    await page.route('**/api/share/qr-ticket**', route => {
      if (route.request().method() === 'DELETE') {
        revokeCount += 1
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ revoked: true }),
        })
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 'IPHONE-SHARE',
          expiresAt: Date.now() + 5 * 60 * 1000,
          ttlMs: 5 * 60 * 1000,
          shortPath: '/j/IPHONE-SHARE',
          shortUrl: 'https://share.example.test/j/IPHONE-SHARE',
          longUrl: readOnlyUrl,
          fullAccessUrl,
          shortUrlAccessMode: 'owner',
          longUrlAccessMode: 'read-only',
          tokenLabel: 'iphone share token',
        }),
      })
    })
    await openFarming(page)

    await page.getByTestId('code-mobile-more').click()
    const optionsMenu = page.getByTestId('code-options-menu')
    await expect(optionsMenu).toBeVisible()
    await page.evaluate(() => document.body.setAttribute('data-appearance', 'dark'))
    const shareMenuItem = optionsMenu.getByRole('menuitem', { name: /Share current page|分享当前页面/ })
    await expect(shareMenuItem).toHaveCSS('color', 'rgb(255, 255, 255)')
    const ticketResponsePromise = page.waitForResponse(response => (
      response.request().method() === 'POST' && response.url().includes('/api/share/qr-ticket')
    ))
    await shareMenuItem.click()
    expect((await ticketResponsePromise).status()).toBe(200)

    const mobileShareSheet = page.getByTestId('code-mobile-share-sheet')
    await expect(mobileShareSheet).toBeVisible()
    const mobileShareDialog = mobileShareSheet.getByRole('dialog')
    const closeShareButton = mobileShareDialog.getByRole('button', { name: /Cancel|取消/ })
    await expect(closeShareButton).toBeFocused()
    await expect(mobileShareSheet.getByRole('heading', { name: /Share page|分享页面/ })).toBeVisible()
    await expect(mobileShareSheet.getByRole('heading', { name: /Copy read-only share link|复制只读分享链接/ })).toBeVisible()
    await expect(mobileShareSheet.locator('.code-mobile-share-link').first()).toHaveText(readOnlyUrl)
    await expect(mobileShareSheet.getByTestId('code-mobile-share-qr')).toBeVisible()
    await expect(mobileShareSheet.locator('.code-share-qr-svg')).toBeVisible()
    await expect(mobileShareSheet.getByText(/full-control passphrase|完整控制口令/).first()).toBeVisible()
    const copyShareAction = mobileShareSheet.getByTestId('code-mobile-share-copy-action')
    await expect(copyShareAction).toBeVisible()
    await copyShareAction.click()
    await expect(copyShareAction).toHaveText(/Copied|已复制/)
    const fullControlAction = mobileShareSheet.getByTestId('code-mobile-share-full-control-action')
    await expect(fullControlAction).toBeVisible()
    for (const control of [closeShareButton, copyShareAction, fullControlAction]) {
      const touchTarget = await control.evaluate(element => {
        const rect = element.getBoundingClientRect()
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
        return {
          width: rect.width,
          height: rect.height,
          centerHitsControl: hit === element || element.contains(hit),
        }
      })
      expect(touchTarget.width).toBeGreaterThanOrEqual(44)
      expect(touchTarget.height).toBeGreaterThanOrEqual(44)
      expect(touchTarget.centerHitsControl).toBe(true)
    }
    await fullControlAction.click()
    await expect(fullControlAction).toHaveText(/Copied|已复制/)
    await expect(mobileShareSheet.getByRole('heading', { name: /Add to Home Screen|添加到主屏幕/ })).toBeVisible()
    await expect(mobileShareSheet.getByText(/system browser or Chrome|系统浏览器或 Chrome/)).toBeVisible()
    await expect(mobileShareSheet.getByText(/tap •••|点 •••/i)).toBeVisible()
    await expect(mobileShareSheet.locator('.code-mobile-install-step')).toHaveCount(2)
    await expect(mobileShareSheet.getByTestId('code-mobile-share-system-action')).toHaveCount(0)
    await expect(mobileShareSheet.locator('.code-mobile-share-sheet')).toHaveCSS('color', 'rgb(255, 255, 255)')
    await captureIphoneAudit(page, testInfo, 'iphone-webkit-share-owner.png')
    await page.keyboard.press('Escape')
    await expect(mobileShareSheet).toHaveCount(0)
    await expect.poll(() => revokeCount).toBe(1)
    await expect(page.getByTestId('code-mobile-more')).toBeFocused()
  })

  test('keeps delegated mobile sharing read-only and hides owner access', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'iphone-webkit', 'Runs only in the iPhone WebKit project')
    let revokeCount = 0
    await page.route('**/api/share/qr-ticket**', route => {
      if (route.request().method() === 'DELETE') {
        revokeCount += 1
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ revoked: true }) })
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 'IPHONE-READ-ONLY',
          expiresAt: Date.now() + 4 * 60 * 1000,
          ttlMs: 5 * 60 * 1000,
          shortPath: '/j/IPHONE-READ-ONLY',
          shortUrl: 'https://share.example.test/j/IPHONE-READ-ONLY',
          longUrl: 'https://share.example.test/farming?token=delegated-read-only',
          shortUrlAccessMode: 'read-only',
          longUrlAccessMode: 'read-only',
          tokenLabel: '',
        }),
      })
    })
    await openFarming(page)

    await page.getByTestId('code-mobile-more').click()
    await page.getByRole('menuitem', { name: /Share current page|分享当前页面/ }).click()
    const sheet = page.getByTestId('code-mobile-share-sheet')
    await expect(sheet).toBeVisible()
    await expect(sheet.getByText(/read-only link for this page|当前页面的只读链接/).first()).toBeVisible()
    await expect(sheet.getByTestId('code-mobile-share-qr')).toBeVisible()
    await expect(sheet.locator('.code-share-qr-svg')).toBeVisible()
    await expect(sheet.getByTestId('code-mobile-share-full-control-action')).toHaveCount(0)
    await expect(sheet.getByRole('heading', { name: /Copy full-control|复制完整控制/ })).toHaveCount(0)
    await captureIphoneAudit(page, testInfo, 'iphone-webkit-share-read-only.png')
    await page.keyboard.press('Escape')
    await expect(sheet).toHaveCount(0)
    await expect.poll(() => revokeCount).toBe(1)
  })

  test('keeps a production-sized Files tree steady while touch scrolling beside full Agent rows', async ({ page, workspaceRoot }, testInfo) => {
    test.skip(testInfo.project.name !== 'iphone-webkit', 'Runs only in the iPhone WebKit project')
    testInfo.setTimeout(120_000)
    const projectDir = path.join(workspaceRoot, 'iphone-large-files')
    fs.mkdirSync(projectDir, { recursive: true })
    for (let index = 0; index < 1_400; index += 1) {
      fs.writeFileSync(path.join(projectDir, `file-${String(index).padStart(4, '0')}.ts`), `export const value = ${index}\n`)
    }
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'maxTouchPoints', { value: 5, configurable: true })
    })
    await openFarming(page)
    await createControlAgent(page, 'bash', projectDir)
    await createControlAgent(page, 'bash', projectDir)
    await createControlAgent(page, 'bash', projectDir)
    await page.getByTestId('code-mobile-menu').tap()

    const project = page.getByTestId('code-project-group').filter({ hasText: 'iphone-large-files' })
    await expect(project.locator('[data-testid="code-agent-row"][data-agent-id]')).toHaveCount(3, { timeout: 30_000 })
    await expect(project.getByTestId('code-project-agent-strip')).toHaveCount(0)
    const files = project.getByTestId('code-files-section')
    const filesToggle = files.getByRole('button', { name: /^Files$/ })
    if (await filesToggle.getAttribute('aria-expanded') === 'false') await filesToggle.tap()
    await expect(files.locator('.code-file-tree-viewport')).toHaveAttribute('data-visible-row-count', '1400')
    await expect.poll(() => files.locator('[data-testid="code-file-row"]').count()).toBeLessThan(100)

    const expectVisibleFileRows = async (expectedHeight: number) => {
      await expect.poll(() => files.locator('[data-testid="code-file-row"]').evaluateAll(rows => {
        const sample = rows.slice(0, 8).map(row => row.getBoundingClientRect())
        return {
          heights: sample.map(rect => Math.round(rect.height)),
          steps: sample.slice(1).map((rect, index) => Math.round(rect.top - sample[index]!.top)),
        }
      })).toEqual({
        heights: Array(8).fill(expectedHeight),
        steps: Array(7).fill(expectedHeight),
      })
    }
    await expectVisibleFileRows(28)
    await page.setViewportSize({ width: 1024, height: 800 })
    await expectVisibleFileRows(24)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByTestId('code-mobile-menu').tap()
    await expect(project).toBeVisible()
    await expectVisibleFileRows(28)

    const scrollMetrics = await files.evaluate(async element => {
      const scroller = element.closest<HTMLElement>('.code-project-list')
      const viewport = element.querySelector<HTMLElement>('.code-file-tree-viewport')
      const treeWindow = element.querySelector<HTMLElement>('.code-file-tree-window')
      if (!scroller || !viewport || !treeWindow) throw new Error('Large Files viewport is incomplete')
      const nextFrame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
      scroller.scrollTop = Math.min(4_000, scroller.scrollHeight - scroller.clientHeight)
      await nextFrame()
      const samples: number[] = []
      const windowDrift: number[] = []
      const onScroll = () => {
        const viewportRect = viewport.getBoundingClientRect()
        const scrollerRect = scroller.getBoundingClientRect()
        const maxOffset = Math.max(0, viewport.offsetHeight - treeWindow.offsetHeight)
        const expectedOffset = Math.max(0, Math.min(maxOffset, scrollerRect.top - viewportRect.top))
        samples.push(scroller.scrollTop)
        windowDrift.push(Math.abs(treeWindow.getBoundingClientRect().top - (viewportRect.top + expectedOffset)))
      }
      scroller.addEventListener('scroll', onScroll)
      for (let step = 0; step < 13; step += 1) {
        scroller.scrollTop += 48
        await nextFrame()
      }
      scroller.removeEventListener('scroll', onScroll)
      const release = scroller.scrollTop
      await nextFrame()
      await nextFrame()
      return {
        maximum: scroller.scrollHeight - scroller.clientHeight,
        samples,
        release,
        settled: scroller.scrollTop,
        maxWindowDrift: Math.max(0, ...windowDrift),
      }
    })
    expect(scrollMetrics.maximum).toBeGreaterThan(30_000)
    expect(scrollMetrics.samples.length).toBeGreaterThanOrEqual(10)
    expect(scrollMetrics.samples.every((value, index, values) => index === 0 || value > values[index - 1]!)).toBe(true)
    expect(Math.abs(scrollMetrics.settled - scrollMetrics.release)).toBeLessThanOrEqual(1)
    expect(scrollMetrics.maxWindowDrift).toBeLessThanOrEqual(1)

    const actionTarget = await files.locator('[data-testid="code-file-row"]').evaluateAll(rows => {
      const scroller = rows[0]?.closest<HTMLElement>('.code-project-list')
      const filesHeader = rows[0]?.closest('[data-testid="code-files-section"]')
        ?.querySelector<HTMLElement>('.code-files-header')
      const lowerBound = scroller?.getBoundingClientRect().bottom ?? innerHeight
      const upperBound = filesHeader?.getBoundingClientRect().bottom ?? 0
      const visibleRows = rows.filter(row => {
        const rect = row.getBoundingClientRect()
        return rect.top >= upperBound && rect.bottom <= lowerBound
      })
      const row = visibleRows[Math.floor(visibleRows.length / 2)]
      const action = row?.querySelector<HTMLElement>('.code-file-row-actions')
      if (!row || !action) return null
      const rect = action.getBoundingClientRect()
      const x = rect.left + rect.width / 2
      const y = rect.top + rect.height / 2
      const hit = document.elementFromPoint(x, y)
      return {
        path: row.getAttribute('data-file-path') || '',
        rowHeight: row.getBoundingClientRect().height,
        width: rect.width,
        height: rect.height,
        x,
        y,
        hitWithinAction: hit === action || action.contains(hit),
        hitTag: hit?.tagName || '',
        hitClass: hit instanceof HTMLElement ? hit.className : '',
      }
    })
    expect(actionTarget?.path).toBeTruthy()
    expect(actionTarget?.rowHeight).toBe(28)
    expect(actionTarget?.width).toBe(28)
    expect(actionTarget?.height).toBe(28)
    expect(actionTarget?.hitWithinAction, JSON.stringify(actionTarget)).toBe(true)
    await page.touchscreen.tap(actionTarget!.x, actionTarget!.y)
    const menu = page.getByTestId('code-file-context-menu')
    await expect(menu).toBeVisible()
    const menuBounds = await menu.evaluate(element => {
      const rect = element.getBoundingClientRect()
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: innerWidth, height: innerHeight }
    })
    expect(menuBounds.left).toBeGreaterThanOrEqual(7)
    expect(menuBounds.right).toBeLessThanOrEqual(menuBounds.width - 7)
    expect(menuBounds.top).toBeGreaterThanOrEqual(7)
    expect(menuBounds.bottom).toBeLessThanOrEqual(menuBounds.height - 7)
    await captureIphoneAudit(page, testInfo, 'iphone-webkit-large-files-menu.png')
  })

  test('completes file creation, rename, and deletion through compact touch actions', async ({ page, workspaceRoot }, testInfo) => {
    test.skip(testInfo.project.name !== 'iphone-webkit', 'Runs only in the iPhone WebKit project')
    testInfo.setTimeout(120_000)
    const projectDir = path.join(workspaceRoot, 'iphone-file-actions')
    fs.mkdirSync(projectDir, { recursive: true })
    fs.writeFileSync(path.join(projectDir, 'README.md'), '# Touch file operations\n')
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'maxTouchPoints', { value: 5, configurable: true })
      const copiedTexts: string[] = []
      ;(window as typeof window & { __mobileCopiedTexts?: string[] }).__mobileCopiedTexts = copiedTexts
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async (text: string) => { copiedTexts.push(text) } },
      })
    })
    let shareTicketPosts = 0
    let shareTicketDeletes = 0
    let lastShareTarget: Record<string, unknown> | null = null
    await page.route('**/api/share/qr-ticket**', route => {
      if (route.request().method() === 'DELETE') {
        shareTicketDeletes += 1
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ revoked: true }) })
      }
      shareTicketPosts += 1
      lastShareTarget = (route.request().postDataJSON() as { target?: Record<string, unknown> }).target ?? null
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 'FILE-MENU-SHARE',
          expiresAt: Date.now() + 5 * 60 * 1000,
          ttlMs: 5 * 60 * 1000,
          shortPath: '/j/FILE-MENU-SHARE',
          shortUrl: 'https://share.example.test/j/FILE-MENU-SHARE',
          longUrl: 'https://share.example.test/farming?token=file-menu-read-only',
          shortUrlAccessMode: 'owner',
          longUrlAccessMode: 'read-only',
          tokenLabel: 'file menu token',
          fullAccessUrl: 'https://share.example.test/farming?token=file-menu-owner',
        }),
      })
    })

    await openFarming(page)
    await createControlAgent(page, 'bash', projectDir)
    page.setDefaultTimeout(10_000)
    await page.getByTestId('code-mobile-menu').tap()
    const project = page.getByTestId('code-project-group').filter({ hasText: 'iphone-file-actions' })
    const files = project.getByTestId('code-files-section')
    const filesToggle = files.getByRole('button', { name: /^Files$/ })
    if (await filesToggle.getAttribute('aria-expanded') === 'false') await filesToggle.tap()

    const readmeRow = files.locator('[data-testid="code-file-row"][data-file-path="README.md"]')
    await readmeRow.getByRole('button', { name: /File actions for README\.md|README\.md 的文件操作/ }).tap()
    const menu = page.getByTestId('code-file-context-menu')
    const menuBounds = await menu.evaluate(element => {
      const rect = element.getBoundingClientRect()
      const visualViewport = window.visualViewport
      return {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        viewportLeft: visualViewport?.offsetLeft ?? 0,
        viewportRight: (visualViewport?.offsetLeft ?? 0) + (visualViewport?.width ?? window.innerWidth),
        viewportTop: visualViewport?.offsetTop ?? 0,
        viewportBottom: (visualViewport?.offsetTop ?? 0) + (visualViewport?.height ?? window.innerHeight),
      }
    })
    expect(menuBounds.left).toBeGreaterThanOrEqual(menuBounds.viewportLeft + 7)
    expect(menuBounds.right).toBeLessThanOrEqual(menuBounds.viewportRight - 7)
    expect(menuBounds.top).toBeGreaterThanOrEqual(menuBounds.viewportTop + 7)
    expect(menuBounds.bottom).toBeLessThanOrEqual(menuBounds.viewportBottom - 7)

    const agentCountBeforeLaunch = await page.locator('[data-testid="code-agent-row"][data-agent-id]').count()
    await menu.getByTestId('file-new-agent-submenu-trigger').tap()
    const agentSubmenu = page.getByTestId('file-new-agent-submenu')
    await expect(agentSubmenu).toBeVisible()
    await expect(page.getByTestId('input-dialog')).toHaveCount(0)
    const submenuBounds = await agentSubmenu.evaluate(element => {
      const rect = element.getBoundingClientRect()
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: window.innerWidth, height: window.innerHeight }
    })
    expect(submenuBounds.left).toBeGreaterThanOrEqual(8)
    expect(submenuBounds.right).toBeLessThanOrEqual(submenuBounds.width - 8)
    expect(submenuBounds.top).toBeGreaterThanOrEqual(8)
    expect(submenuBounds.bottom).toBeLessThanOrEqual(submenuBounds.height - 8)
    await agentSubmenu.getByTestId('agent-launch-bash').tap()
    await expect(menu).toBeHidden()
    await expect.poll(() => page.locator('[data-testid="code-agent-row"][data-agent-id]').count()).toBeGreaterThan(agentCountBeforeLaunch)
    if (await page.getByTestId('code-sidebar').getAttribute('class').then(value => value?.includes('collapsed'))) {
      await page.getByTestId('code-mobile-menu').tap()
    }

    await readmeRow.getByRole('button', { name: /File actions for README\.md|README\.md 的文件操作/ }).tap()
    await menu.getByRole('menuitem', { name: /Refresh|刷新/ }).tap()
    await expect(menu).toBeHidden()
    await expect(files.locator('[role="tree"]')).toBeFocused()
    await expect(readmeRow).toHaveClass(/\bfocused\b/)
    await expect(readmeRow).toHaveClass(/\bselected\b/)

    await readmeRow.getByRole('button', { name: /File actions for README\.md|README\.md 的文件操作/ }).tap()
    await menu.getByRole('menuitem', { name: /Copy Relative Path|复制相对路径/ }).tap()
    await expect(menu).toBeHidden()
    await expect.poll(() => page.evaluate(() => (
      (window as typeof window & { __mobileCopiedTexts?: string[] }).__mobileCopiedTexts?.at(-1) || ''
    ))).toBe('README.md')

    await readmeRow.getByRole('button', { name: /File actions for README\.md|README\.md 的文件操作/ }).tap()
    await menu.getByRole('menuitem', { name: /Copy Share URL|拷贝分享 URL/ }).tap()
    await expect(menu).toBeHidden()
    await expect.poll(() => shareTicketPosts).toBe(1)
    expect(lastShareTarget).toMatchObject({ kind: 'file', filePath: 'README.md' })
    await expect.poll(() => shareTicketDeletes).toBe(1)
    await expect.poll(() => page.evaluate(() => (
      (window as typeof window & { __mobileCopiedTexts?: string[] }).__mobileCopiedTexts?.at(-1) || ''
    ))).toBe('https://share.example.test/farming?token=file-menu-read-only')

    await readmeRow.getByRole('button', { name: /File actions for README\.md|README\.md 的文件操作/ }).tap()
    await menu.getByRole('menuitem', { name: /New File|新建文件/ }).tap()
    const createDialog = page.getByTestId('code-file-operation-dialog')
    const createInput = createDialog.getByTestId('code-file-operation-input')
    await createInput.fill('touch-created.txt')
    await captureIphoneAudit(page, testInfo, 'file-create-dialog.png')
    await createDialog.getByRole('button', { name: /Save|保存/ }).tap()
    await expect.poll(() => fs.existsSync(path.join(projectDir, 'touch-created.txt'))).toBe(true)
    await expect(createDialog).toHaveCount(0)

    await expect(page.getByTestId('code-mobile-back')).toBeVisible()
    await page.getByTestId('code-mobile-back').tap()
    const mobileMenu = page.getByTestId('code-mobile-menu')
    await expect(mobileMenu).toBeVisible()
    await expect(page.getByTestId('code-sidebar')).toHaveClass(/collapsed/)
    await mobileMenu.click()
    await expect(page.getByTestId('code-sidebar')).not.toHaveClass(/collapsed/)
    const createdRow = files.locator('[data-testid="code-file-row"][data-file-path="touch-created.txt"]')
    await expect(createdRow).toBeVisible()
    await createdRow.getByRole('button', { name: /File actions for touch-created\.txt|touch-created\.txt 的文件操作/ }).tap()
    await menu.getByRole('menuitem', { name: /Rename|重命名/ }).tap()
    const renameInput = createdRow.getByTestId('code-file-operation-input')
    await expect(renameInput).toBeFocused()
    await renameInput.fill('touch-renamed.txt')
    await expect(renameInput).toHaveValue('touch-renamed.txt')
    await captureIphoneAudit(page, testInfo, 'file-rename-inline.png')
    await renameInput.press('Enter')
    const renamedRow = files.locator('[data-testid="code-file-row"][data-file-path="touch-renamed.txt"]')
    await expect(renamedRow).toBeVisible()
    expect(fs.existsSync(path.join(projectDir, 'touch-created.txt'))).toBe(false)
    expect(fs.existsSync(path.join(projectDir, 'touch-renamed.txt'))).toBe(true)

    await expect.poll(() => renamedRow.evaluate(element => {
      const testWindow = window as Window & {
        __farmingStableTouchRow?: { element: Element | null; samples: number }
      }
      const previous = testWindow.__farmingStableTouchRow
      const samples = previous?.element === element ? previous.samples + 1 : 1
      testWindow.__farmingStableTouchRow = { element, samples }
      return samples
    }), { message: 'renamed touch row should settle after the authoritative tree refresh' }).toBeGreaterThanOrEqual(3)
    await renamedRow.getByRole('button', { name: /File actions for touch-renamed\.txt|touch-renamed\.txt 的文件操作/ }).tap({ timeout: 10_000 })
    await menu.getByRole('menuitem', { name: /Delete|删除/ }).tap()
    const deleteDialog = page.getByTestId('code-file-operation-dialog')
    await expect(deleteDialog).toContainText('touch-renamed.txt')
    await captureIphoneAudit(page, testInfo, 'file-delete-confirmation.png')
    await deleteDialog.getByRole('button', { name: /Delete|删除/ }).tap()
    await expect(renamedRow).toHaveCount(0)
    expect(fs.existsSync(path.join(projectDir, 'touch-renamed.txt'))).toBe(false)

    await readmeRow.getByRole('button', { name: /File actions for README\.md|README\.md 的文件操作/ }).tap()
    await menu.getByRole('menuitem', { name: /New Folder|新建文件夹/ }).tap()
    const folderCreateDialog = page.getByTestId('code-file-operation-dialog')
    await folderCreateDialog.getByTestId('code-file-operation-input').fill('touch-folder')
    await folderCreateDialog.getByRole('button', { name: /Save|保存/ }).tap()
    const folderRow = files.locator('[data-testid="code-file-row"][data-file-path="touch-folder"]')
    await expect(folderRow).toBeVisible()
    expect(fs.existsSync(path.join(projectDir, 'touch-folder'))).toBe(true)

    await folderRow.getByRole('button', { name: /File actions for touch-folder|touch-folder 的文件操作/ }).tap()
    await menu.getByRole('menuitem', { name: /Rename|重命名/ }).tap()
    const folderRenameInput = folderRow.getByTestId('code-file-operation-input')
    await expect(folderRenameInput).toBeFocused()
    await folderRenameInput.fill('touch-folder-renamed')
    await captureIphoneAudit(page, testInfo, 'folder-rename-inline.png')
    await folderRenameInput.press('Enter')
    const renamedFolderRow = files.locator('[data-testid="code-file-row"][data-file-path="touch-folder-renamed"]')
    await expect(renamedFolderRow).toBeVisible()
    expect(fs.existsSync(path.join(projectDir, 'touch-folder'))).toBe(false)
    expect(fs.existsSync(path.join(projectDir, 'touch-folder-renamed'))).toBe(true)

    await renamedFolderRow.getByRole('button', { name: /File actions for touch-folder-renamed|touch-folder-renamed 的文件操作/ }).tap()
    await menu.getByRole('menuitem', { name: /Delete|删除/ }).tap()
    await expect(deleteDialog).toContainText('touch-folder-renamed')
    await deleteDialog.getByRole('button', { name: /Delete|删除/ }).tap()
    await expect(renamedFolderRow).toHaveCount(0)
    expect(fs.existsSync(path.join(projectDir, 'touch-folder-renamed'))).toBe(false)
  })

  test('keeps one outer Files scroll surface during continuous mobile scroll', async ({ page, workspaceRoot }, testInfo) => {
    test.skip(testInfo.project.name !== 'iphone-webkit', 'Runs only in the iPhone WebKit project')
    const projectDir = path.join(workspaceRoot, 'iphone-large-file-tree')
    const largeDir = path.join(projectDir, 'odps_src')
    fs.mkdirSync(largeDir, { recursive: true })
    for (let index = 0; index < 180; index += 1) {
      fs.writeFileSync(path.join(largeDir, `mobile-file-${String(index).padStart(3, '0')}.sql`), `select ${index};\n`)
    }
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'maxTouchPoints', { value: 5, configurable: true })
    })
    await openFarming(page)
    await createControlAgent(page, 'bash', projectDir)
    await page.getByTestId('code-mobile-menu').tap()
    const files = page.getByTestId('code-project-group').filter({ hasText: 'iphone-large-file-tree' }).getByTestId('code-files-section')
    const filesToggle = files.getByRole('button', { name: /^Files$/ })
    if (await filesToggle.getAttribute('aria-expanded') === 'false') await filesToggle.tap()
    await files.locator('[data-testid="code-file-row"][data-file-path="odps_src"]').tap()
    await expect(files.locator('[data-testid="code-file-row"][data-file-path="odps_src/mobile-file-000.sql"]')).toBeVisible()

    const samples = await files.locator('.code-file-tree-viewport').evaluate(async viewportElement => {
      const viewport = viewportElement as HTMLElement
      const scroller = viewport.closest('.code-project-list') as HTMLElement | null
      const treeWindow = viewport.querySelector('.code-file-tree-window') as HTMLElement | null
      const tree = viewport.querySelector('.code-file-tree') as HTMLElement | null
      if (!scroller || !treeWindow || !tree) throw new Error('Large file tree scroll surfaces are incomplete')
      const outerScrollTop = scroller.scrollTop
      const target = Math.min(scroller.scrollHeight - scroller.clientHeight, outerScrollTop + 1_600)
      scroller.scrollTo({ top: target, behavior: 'smooth' })
      const frames: Array<{
        innerActual: number
        innerOverflow: string
        outerDelta: number
        outerOverflow: string
        windowPosition: string
        windowTopDelta: number
      }> = []
      for (let frame = 0; frame < 36; frame += 1) {
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
        const scrollerRect = scroller.getBoundingClientRect()
        const windowRect = treeWindow.getBoundingClientRect()
        frames.push({
          innerActual: tree.scrollTop,
          innerOverflow: getComputedStyle(tree).overflowY,
          outerDelta: Math.abs(scroller.scrollTop - outerScrollTop),
          outerOverflow: getComputedStyle(scroller).overflowY,
          windowPosition: getComputedStyle(treeWindow).position,
          windowTopDelta: Math.abs(windowRect.top - scrollerRect.top),
        })
      }
      return frames
    })
    expect(samples.some(sample => sample.outerDelta > 400)).toBe(true)
    expect(samples.some(sample => sample.innerActual > 400)).toBe(true)
    expect(samples.every(sample => sample.innerOverflow === 'hidden')).toBe(true)
    expect(samples.every(sample => sample.outerOverflow === 'auto')).toBe(true)
    expect(samples.every(sample => sample.windowPosition === 'absolute')).toBe(true)
    const activeSamples = samples.filter(sample => sample.outerDelta > 200)
    expect(activeSamples.length).toBeGreaterThan(0)
    expect(Math.max(...activeSamples.map(sample => sample.windowTopDelta))).toBeLessThanOrEqual(1)
    await captureIphoneAudit(page, testInfo, 'iphone-webkit-large-file-tree-scroll.png')
  })

  test('keeps composer, mic, and terminal surfaces usable under iPhone WebKit emulation', async ({ page, workspaceRoot }, testInfo) => {
    test.skip(testInfo.project.name !== 'iphone-webkit', 'Runs only in the iPhone WebKit project')

    const projectDir = path.join(workspaceRoot, 'iphone-layout')
    fs.mkdirSync(projectDir, { recursive: true })
    fs.writeFileSync(path.join(projectDir, 'README.md'), [
      '# iPhone layout',
      '',
      'This file exercises the mobile Markdown reading surface.',
      '',
      ...Array.from({ length: 32 }, (_, index) => `- Mobile reading line ${String(index + 1).padStart(2, '0')}`),
      '',
    ].join('\n'))
    fs.mkdirSync(path.join(projectDir, 'src'), { recursive: true })
    fs.writeFileSync(path.join(projectDir, 'src', 'mobile-app.ts'), 'export const app = true\n')
    fs.writeFileSync(path.join(projectDir, 'src', 'mobile-view.ts'), 'export const mobile = true\n')

    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'maxTouchPoints', { value: 5, configurable: true })
      delete (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition
      delete (window as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition
    })

    await openFarming(page)
    const userAgent = await page.evaluate(() => navigator.userAgent)
    expect(userAgent).toContain('iPhone')

    const agentId = await createControlAgent(page, 'bash', projectDir)
    await createControlAgent(page, 'bash', projectDir)
    await createControlAgent(page, 'bash', projectDir)
    await page.getByTestId('code-mobile-menu').click()
    const productMark = page.getByTestId('code-product-mark')
    await expect(productMark.locator('.code-product-logo')).toBeVisible()
    await productMark.click()
    const brandDialog = page.getByTestId('code-brand-dialog')
    await expect(brandDialog).toBeVisible()
    await expect(brandDialog.getByRole('link', { name: 'GitHub' })).toHaveAttribute('href', 'https://github.com/zhuwenzhuang/farming')
    const brandMetrics = await brandDialog.locator('.code-brand-dialog').evaluate(element => {
      const rect = element.getBoundingClientRect()
      const logo = element.querySelector('.code-brand-logo')?.getBoundingClientRect()
      return {
        width: rect.width,
        bottomGap: window.innerHeight - rect.bottom,
        viewportWidth: window.innerWidth,
        logoWidth: logo?.width ?? 0,
      }
    })
    expect(brandMetrics.width).toBeLessThanOrEqual(brandMetrics.viewportWidth - 16)
    expect(brandMetrics.bottomGap).toBeLessThanOrEqual(10)
    expect(brandMetrics.logoWidth).toBeGreaterThanOrEqual(80)
    await brandDialog.getByRole('button', { name: 'Cancel' }).click()
    const agentRow = page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
    await expect(agentRow).toBeVisible({ timeout: 30_000 })
    await agentRow.click()

    const terminalPane = page.locator(`[data-testid="code-terminal-pane"][data-agent-id="${agentId}"]`)
    await expect(terminalPane).toBeVisible({ timeout: 30_000 })

    const touchScrollMetrics = await page.evaluate(async id => {
      const fixture = Array.from({ length: 180 }, (_, index) => `iphone-touch-line-${index}`).join('\r\n')
      await window.__farmingTerminalTest?.writeFixture(id, `${fixture}\r\n`)
      const host = document.querySelector(`.terminal-session-host[data-agent-id="${CSS.escape(id)}"]`)
      const surface = host?.querySelector('.xterm-screen')
      if (!(surface instanceof HTMLElement)) throw new Error('iPhone terminal touch surface is missing')
      const rect = surface.getBoundingClientRect()
      const x = rect.left + rect.width / 2
      const startY = rect.top + rect.height * 0.42
      const dispatch = (type: string, pointerId: number, y: number) => surface.dispatchEvent(new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        pointerId,
        pointerType: 'touch',
        isPrimary: true,
        clientX: x,
        clientY: y,
      }))

      dispatch('pointerdown', 181, startY)
      for (let step = 1; step <= 6; step += 1) {
        // Preserve real touch-event cadence so the momentum calculation sees a velocity.
        await new Promise(resolve => window.setTimeout(resolve, 12))
        dispatch('pointermove', 181, startY + step * 16)
      }
      dispatch('pointerup', 181, startY + 96)
      const afterRelease = window.__farmingTerminalTest?.getViewport(id)
      // This is the product momentum interval, not a UI readiness delay.
      await new Promise(resolve => window.setTimeout(resolve, 220))
      const afterMomentum = window.__farmingTerminalTest?.getViewport(id)

      dispatch('pointerdown', 182, startY)
      dispatch('pointermove', 182, startY + 3_000)
      const beforeEdge = window.__farmingTerminalTest?.getViewport(id)
      dispatch('pointermove', 182, startY + 3_044)
      const afterEdge = window.__farmingTerminalTest?.getViewport(id)
      const edgeTransform = surface.style.transform
      dispatch('pointerup', 182, startY + 3_044)
      // Wait for the bounded momentum animation to finish before asserting its final transform.
      await new Promise(resolve => window.setTimeout(resolve, 300))
      return {
        afterRelease,
        afterMomentum,
        beforeEdge,
        afterEdge,
        edgeTransform,
        settledTransform: surface.style.transform,
        pageScrollY: window.scrollY,
      }
    }, agentId)
    expect(touchScrollMetrics.afterRelease?.viewportY ?? 0).toBeGreaterThan(0)
    expect(touchScrollMetrics.afterMomentum?.viewportY ?? 0).toBeGreaterThan(touchScrollMetrics.afterRelease?.viewportY ?? 0)
    expect(touchScrollMetrics.afterEdge?.viewportY).toBe(touchScrollMetrics.beforeEdge?.viewportY)
    expect(touchScrollMetrics.edgeTransform).toContain('translate3d')
    expect(touchScrollMetrics.settledTransform).toBe('')
    expect(touchScrollMetrics.pageScrollY).toBe(0)

    const terminalBackgrounds = await terminalPane.evaluate(element => {
      const pane = element as HTMLElement
      const container = pane.querySelector('[data-testid="code-terminal-container"]') as HTMLElement | null
      const screen = pane.querySelector('.xterm-screen') as HTMLElement | null
      const viewport = pane.querySelector('.xterm-viewport') as HTMLElement | null
      return {
        pane: getComputedStyle(pane).backgroundColor,
        container: container ? getComputedStyle(container).backgroundColor : '',
        screen: screen ? getComputedStyle(screen).backgroundColor : '',
        viewport: viewport ? getComputedStyle(viewport).backgroundColor : '',
      }
    })
    expect(terminalBackgrounds).toEqual({
      pane: 'rgb(255, 255, 255)',
      container: 'rgb(255, 255, 255)',
      screen: 'rgb(255, 255, 255)',
      viewport: 'rgb(255, 255, 255)',
    })

    const composer = page.getByTestId('code-composer')
    const composerInput = page.getByTestId('code-composer-input')
    expect(await composerInput.evaluate(element => element.tagName)).toBe('TEXTAREA')
    await expect(composerInput).toHaveAttribute('placeholder', 'Type a shell command')
    await expect(composerInput).toHaveAttribute('name', 'farming-chat-message')
    await expect(composerInput).toHaveAttribute('inputmode', 'text')
    await expect(composerInput).toHaveAttribute('autocomplete', 'off')
    expect(await composerInput.evaluate(element => element.getAttribute('role'))).toBeNull()
    await composerInput.tap()
    await expect(composerInput).toBeFocused()
    const tapInputMarker = `IPHONE_TAP_INPUT_${Date.now()}`
    await page.keyboard.insertText(`echo ${tapInputMarker}`)
    await expect(composerInput).toHaveValue(`echo ${tapInputMarker}`)
    await expect(page.getByTestId('code-composer-send')).toBeEnabled()
    await page.keyboard.press('Enter')
    await expect(composerInput).toHaveValue(`echo ${tapInputMarker}\n`)
    await page.getByTestId('code-composer-send').tap()
    await expect(composerInput).toHaveValue('')
    await expect.poll(async () => {
      return terminalCheckpointOutput(page, agentId)
    }).toContain(tapInputMarker)

    const keyboardMetrics = await composer.evaluate(async element => {
      const root = document.documentElement
      document.body.classList.add('code-mode', 'code-compact-layout', 'code-mobile-touch', 'code-mobile-ios')
      document.body.classList.add('code-mobile-keyboard-active')
      root.style.setProperty('--app-visual-height', '430px')
      root.style.setProperty('--app-visual-offset-top', '0px')
      root.style.setProperty('--app-visual-offset-left', '0px')
      root.style.setProperty('--mobile-keyboard-offset', '520px')
      await new Promise<void>(resolve => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      })
      const rect = (element as HTMLElement).getBoundingClientRect()
      const visualBottom = Number.parseFloat(root.style.getPropertyValue('--app-visual-height')) || 0
      return {
        composerHeight: rect.height,
        composerBottomBeyondVisualViewport: rect.bottom - visualBottom,
        visualViewportBottomGap: visualBottom - rect.bottom,
      }
    })
    expect(keyboardMetrics.composerHeight).toBeLessThanOrEqual(130)
    expect(keyboardMetrics.composerBottomBeyondVisualViewport).toBeLessThanOrEqual(0)
    expect(keyboardMetrics.visualViewportBottomGap).toBeGreaterThanOrEqual(0)
    expect(keyboardMetrics.visualViewportBottomGap).toBeLessThanOrEqual(32)

    await page.evaluate(() => {
      const root = document.documentElement
      const visualViewport = window.visualViewport
      root.style.setProperty('--app-visual-height', `${Math.round(visualViewport?.height ?? window.innerHeight)}px`)
      root.style.setProperty('--app-visual-offset-top', `${Math.round(visualViewport?.offsetTop ?? 0)}px`)
      root.style.setProperty('--app-visual-offset-left', `${Math.round(visualViewport?.offsetLeft ?? 0)}px`)
      root.style.setProperty('--mobile-keyboard-offset', '0px')
      document.body.classList.remove('code-mobile-keyboard-active')
    })

    const restingComposerMetrics = await composer.evaluate(element => {
      const composerRect = (element as HTMLElement).getBoundingClientRect()
      const main = document.querySelector('[data-testid="code-main"]') as HTMLElement | null
      if (!main) throw new Error('Mobile main surface is missing')
      const mainRect = main.getBoundingClientRect()
      return {
        bottomGap: Math.round(mainRect.bottom - composerRect.bottom),
        leftGap: Math.round(composerRect.left - mainRect.left),
        rightGap: Math.round(mainRect.right - composerRect.right),
        overflowRight: Math.round(composerRect.right - mainRect.right),
      }
    })
    expect(restingComposerMetrics.bottomGap).toBeGreaterThanOrEqual(4)
    expect(restingComposerMetrics.bottomGap).toBeLessThanOrEqual(32)
    expect(Math.abs(restingComposerMetrics.leftGap - restingComposerMetrics.rightGap)).toBeLessThanOrEqual(2)
    expect(restingComposerMetrics.overflowRight).toBeLessThanOrEqual(0)

    const mic = page.getByTestId('code-composer-mic')
    await expect(mic).toHaveCount(0)
    await expect(page.getByTestId('code-composer-dictation-hint')).toHaveCount(0)
    await expect(page.getByTestId('code-composer-recording')).toHaveCount(0)

    // Switching attention back to the main surface must dismiss the mobile
    // keyboard focus; tapping the composer again should restore it cleanly.
    await terminalPane.tap({ position: { x: 24, y: 24 } })
    await expect(composerInput).not.toBeFocused()
    await composerInput.tap()
    await expect(composerInput).toBeFocused()

    await page.getByTestId('code-mobile-menu').click()
    const activeAgentRow = page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
    const providerIcon = activeAgentRow.locator('.code-agent-row-provider-icon')
    await expect(providerIcon).toBeVisible()
    const agentRowLayout = await activeAgentRow.evaluate(element => {
      const row = (element as HTMLElement).getBoundingClientRect()
      const copy = element.querySelector('.code-agent-row-copy')?.getBoundingClientRect()
      const icon = element.querySelector('.code-agent-row-provider-icon')?.getBoundingClientRect()
      const providerIcon = element.querySelector('.code-agent-row-provider-icon .agent-launch-icon')?.getBoundingClientRect()
      const title = element.querySelector('.code-agent-name')
      return {
        copyInset: copy ? Math.round(copy.left - row.left) : -1,
        iconRight: icon?.right ?? Number.POSITIVE_INFINITY,
        copyLeft: copy?.left ?? Number.NEGATIVE_INFINITY,
        providerIconSize: providerIcon ? Math.round(providerIcon.width) : 0,
        titleFontSize: title ? Number.parseFloat(getComputedStyle(title).fontSize) : -1,
      }
    })
    expect(agentRowLayout.copyInset).toBe(27)
    expect(agentRowLayout.iconRight).toBeLessThanOrEqual(agentRowLayout.copyLeft)
    expect(agentRowLayout.providerIconSize).toBe(agentRowLayout.titleFontSize)
    await page.getByTestId('code-sidebar-options').click()
    const settingsPanel = page.getByTestId('code-settings-panel')
    await expect(settingsPanel).toBeVisible()
    await expect(page.getByTestId('code-mobile-share-sheet')).toHaveCount(0)
    await expect.poll(async () => {
      return settingsPanel.locator('.code-settings-panel').evaluate(element => {
        const rect = (element as HTMLElement).getBoundingClientRect()
        return Math.abs(Math.round(rect.left)) <= 1 && Math.round(rect.width) < window.innerWidth
      })
    }, {
      message: 'settings drawer should finish its entrance animation flush with the viewport edge',
      timeout: 5_000,
    }).toBe(true)
    await settingsPanel.getByRole('button', { name: /Back to navigation|返回导航/ }).click()
    await expect(settingsPanel).toHaveCount(0)
    await expect(page.getByTestId('code-sidebar')).toBeVisible()
    await page.getByTestId('code-mobile-sidebar-backdrop').dispatchEvent('pointerdown', {
      pointerType: 'touch',
      isPrimary: true,
    })

    await page.getByTestId('code-mobile-menu').click()
    const filesSection = page.getByTestId('code-files-section').first()
    const filesToggle = filesSection.getByRole('button', { name: /^Files$/ })
    if (await filesToggle.getAttribute('aria-expanded') === 'false') {
      await filesToggle.click()
    }
    const projectGroup = filesSection.locator('xpath=ancestor::section[contains(@class, "code-project-group")]')
    await expect(projectGroup.getByTestId('code-project-agent-strip')).toHaveCount(0)
    await expect(projectGroup.getByTestId('code-project-agent-compact')).toHaveCount(0)
    await expect(projectGroup.locator('[data-testid="code-agent-row"][data-agent-id]')).toHaveCount(3)
    const mobileReadmeRow = filesSection.locator('[data-testid="code-file-row"][data-file-path="README.md"]')
    await expect(mobileReadmeRow).toBeVisible()
    const mobileFileActions = mobileReadmeRow.getByRole('button', { name: /File actions for README\.md|README\.md 的文件操作/ })
    await expect(mobileFileActions).toBeVisible()
    await mobileFileActions.tap()
    const mobileFileMenu = page.getByTestId('code-file-context-menu')
    await expect(mobileFileMenu).toBeVisible()
    await expect(mobileFileMenu.getByRole('menuitem', { name: /New File|新建文件/ })).toBeVisible()
    await expect(mobileFileMenu.getByRole('menuitem', { name: /Rename|重命名/ })).toBeVisible()
    await expect(mobileFileMenu.getByRole('menuitem', { name: /Delete|删除/ })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(mobileFileMenu).toBeHidden()
    const fileSearch = filesSection.getByPlaceholder('Search or path:line')
    const mobileSidebarBackdrop = page.getByTestId('code-mobile-sidebar-backdrop')
    const sidebarScrollBeforeSearchFocus = await page.getByTestId('code-project-list').evaluate(element => element.scrollTop)
    await fileSearch.tap()
    await expect(fileSearch).toBeFocused()
    await expect(page.getByTestId('code-sidebar')).toBeVisible()
    expect(await page.getByTestId('code-project-list').evaluate(element => element.scrollTop)).toBe(sidebarScrollBeforeSearchFocus)
    await mobileSidebarBackdrop.dispatchEvent('click')
    await expect(page.getByTestId('code-sidebar')).toBeVisible()
    await expect(fileSearch).toBeVisible()
    await fileSearch.fill('mobile')
    const touchSearchResults = page.getByTestId('code-file-search-results')
    await expect(touchSearchResults.getByRole('option').nth(1)).toBeVisible()
    const activeOptionBeforeTouchMove = await fileSearch.getAttribute('aria-activedescendant')
    await touchSearchResults.getByRole('option').nth(1).dispatchEvent('pointermove', {
      pointerType: 'touch',
      isPrimary: true,
    })
    await expect(fileSearch).toHaveAttribute('aria-activedescendant', activeOptionBeforeTouchMove || '')
    await fileSearch.fill('README.md')
    const fileSearchResults = page.getByTestId('code-file-search-results')
    await expect(fileSearchResults).toBeVisible()
    const fileSearchLayout = await fileSearchResults.evaluate(element => {
      const rect = (element as HTMLElement).getBoundingClientRect()
      const sidebar = document.querySelector('[data-testid="code-sidebar"]') as HTMLElement | null
      const sidebarRect = sidebar?.getBoundingClientRect()
      const visualViewport = window.visualViewport
      return {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        sidebarLeft: sidebarRect?.left ?? 0,
        sidebarRight: sidebarRect?.right ?? window.innerWidth,
        viewportTop: visualViewport?.offsetTop ?? 0,
        viewportBottom: (visualViewport?.offsetTop ?? 0) + (visualViewport?.height ?? window.innerHeight),
      }
    })
    expect(fileSearchLayout.left).toBeGreaterThanOrEqual(fileSearchLayout.sidebarLeft)
    expect(fileSearchLayout.right).toBeLessThanOrEqual(fileSearchLayout.sidebarRight)
    expect(fileSearchLayout.top).toBeGreaterThanOrEqual(fileSearchLayout.viewportTop)
    expect(fileSearchLayout.bottom).toBeLessThanOrEqual(fileSearchLayout.viewportBottom + 1)
    await fileSearchResults.getByRole('option', { name: /README\.md/ }).click()
    await expect(page.getByTestId('code-file-editor')).toBeVisible()
    await expect(page.locator('.code-file-preview-panel.markdown')).toBeVisible()

    const markdownReadingMetrics = await page.locator('.code-file-preview-panel.markdown').evaluate(element => {
      const panel = element as HTMLElement
      const article = panel.querySelector('.code-markdown-preview') as HTMLElement | null
      const main = document.querySelector('[data-testid="code-main"]') as HTMLElement | null
      if (!article || !main) throw new Error('Markdown reading layout is missing required elements')
      const panelRect = panel.getBoundingClientRect()
      const mainRect = main.getBoundingClientRect()
      return {
        articlePaddingBottom: Number.parseFloat(getComputedStyle(article).paddingBottom),
        mainPaddingBottom: Number.parseFloat(getComputedStyle(main).paddingBottom),
        panelBottomGap: Math.round(mainRect.bottom - panelRect.bottom),
        scrollable: panel.scrollHeight > panel.clientHeight + 4,
      }
    })
    expect(markdownReadingMetrics.mainPaddingBottom).toBe(0)
    expect(markdownReadingMetrics.panelBottomGap).toBeLessThanOrEqual(2)
    expect(markdownReadingMetrics.articlePaddingBottom).toBeLessThanOrEqual(40)
    expect(markdownReadingMetrics.scrollable).toBe(true)

    await page.getByTestId('code-mobile-back').click()
    await expect(terminalPane).toBeVisible()
    await expect(page.getByTestId('code-mobile-menu')).toBeVisible()
  })
})
