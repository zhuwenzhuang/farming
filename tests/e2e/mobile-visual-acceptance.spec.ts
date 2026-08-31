import fs from 'node:fs'
import path from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { expect, openFarming, test } from './fixtures'
import { createAcceptanceEvidence } from './acceptance-evidence'

const VIEWPORTS = [
  { name: '320x844', width: 320, height: 844 },
  { name: '390x844', width: 390, height: 844 },
  { name: '720x900', width: 720, height: 900 },
] as const
const APPEARANCES = ['light', 'dark', 'paper'] as const
const MOBILE_VISUAL_AUDIT_DIR = path.resolve(
  process.env.FARMING_MOBILE_VISUAL_AUDIT_DIR || '.tmp/mobile-visual-acceptance',
)

test.use({ hasTouch: true })

async function assertRawMobileTarget(
  locator: Locator,
  viewport: { width: number, height: number },
  minimum: { width: number, height: number },
) {
  await expect(locator).toBeVisible()
  const geometry = await locator.evaluate(element => {
    const rect = element.getBoundingClientRect()
    const hit = document.elementFromPoint(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
    )
    return {
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height,
      centerHits: Boolean(hit && (hit === element || element.contains(hit))),
    }
  })
  expect(geometry.width).toBeGreaterThanOrEqual(minimum.width)
  expect(geometry.height).toBeGreaterThanOrEqual(minimum.height)
  expect(geometry.left).toBeGreaterThanOrEqual(0)
  expect(geometry.top).toBeGreaterThanOrEqual(0)
  expect(geometry.right).toBeLessThanOrEqual(viewport.width)
  expect(geometry.bottom).toBeLessThanOrEqual(viewport.height)
  expect(geometry.centerHits).toBe(true)
}

async function createAgent(
  page: Page,
  command: string,
  workspace: string,
  title: string,
  agentRuntimeMode: 'terminal' | 'chat' = 'terminal',
) {
  const response = await page.request.post('/farming/api/control/agents', {
    data: { command, workspace, agentRuntimeMode },
  })
  expect(response.ok(), await response.text()).toBeTruthy()
  const body = await response.json() as { agentId?: string }
  if (!body.agentId) throw new Error('Control Agent creation returned no Agent ID')
  const renameResponse = await page.request.patch(`/farming/api/agents/${body.agentId}`, {
    data: { customTitle: title },
  })
  expect(renameResponse.ok(), await renameResponse.text()).toBeTruthy()
  return body.agentId
}

async function openSidebar(page: Page) {
  const sidebar = page.getByTestId('code-sidebar')
  if ((await sidebar.getAttribute('class'))?.includes('collapsed')) {
    await page.getByTestId('code-mobile-menu').click()
  }
  await expect(sidebar).toBeVisible()
  await expect(sidebar).not.toHaveClass(/collapsed/)
}

async function openAgent(page: Page, agentId: string) {
  await openSidebar(page)
  const row = page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
  await expect(row).toBeVisible({ timeout: 30_000 })
  await row.click()
  await expect(page.getByTestId('code-sidebar')).toHaveClass(/collapsed/)
}

async function menuGapAndViewport(
  page: Page,
  trigger: Locator,
  menu: Locator,
) {
  await expect(menu).toBeVisible()
  return menu.evaluate((element, triggerElement) => {
    const rect = element.getBoundingClientRect()
    const triggerRect = (triggerElement as HTMLElement).getBoundingClientRect()
    const viewport = window.visualViewport
    const viewportLeft = viewport?.offsetLeft ?? 0
    const viewportTop = viewport?.offsetTop ?? 0
    const viewportRight = viewportLeft + (viewport?.width ?? window.innerWidth)
    const viewportBottom = viewportTop + (viewport?.height ?? window.innerHeight)
    return {
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
      triggerLeft: triggerRect.left,
      triggerRight: triggerRect.right,
      triggerTop: triggerRect.top,
      viewportRight,
      gap: triggerRect.top - rect.bottom,
      fits: rect.left >= viewportLeft - 1
        && rect.right <= viewportRight + 1
        && rect.top >= viewportTop - 1
        && rect.bottom <= viewportBottom + 1,
    }
  }, await trigger.elementHandle())
}

test('audits compact Composer and sidebar geometry across mobile widths and appearances', async ({ page, workspaceRoot }, testInfo) => {
  test.setTimeout(240_000)
  const evidence = createAcceptanceEvidence(MOBILE_VISUAL_AUDIT_DIR, {
    manifestFileName: 'manifest-mobile-visual-acceptance.json',
  })
  const workspace = path.join(workspaceRoot, 'mobile-visual-acceptance')
  const firstSearchWorkspace = path.join(workspaceRoot, 'visual-root-a', 'org', 'team', 'shared-project')
  const secondSearchWorkspace = path.join(workspaceRoot, 'visual-root-b', 'org', 'team', 'shared-project')
  const longSearchPath = 'src/mobile/a-very-long-directory-name/another-long-segment/VisualSearchTarget.ts'
  fs.mkdirSync(workspace, { recursive: true })
  fs.writeFileSync(path.join(workspace, 'README.md'), '# Mobile visual acceptance\n')
  fs.mkdirSync(path.dirname(path.join(firstSearchWorkspace, longSearchPath)), { recursive: true })
  fs.mkdirSync(path.dirname(path.join(secondSearchWorkspace, longSearchPath)), { recursive: true })
  fs.writeFileSync(path.join(firstSearchWorkspace, longSearchPath), 'VISUAL_SEARCH_FIRST\n')
  fs.writeFileSync(path.join(secondSearchWorkspace, longSearchPath), 'VISUAL_SEARCH_SECOND\n')

  const pinnedId = await createAgent(
    page,
    'codex --farming-fixture-idle-profile',
    workspace,
    'Pinned mobile Codex',
  )
  const ordinaryId = await createAgent(
    page,
    'codex --farming-fixture-idle-profile',
    workspace,
    'Ordinary mobile Codex',
  )
  const chatId = await createAgent(page, 'opencode', workspace, 'Mobile ACP Chat', 'chat')
  const mountResponse = await page.request.post('/farming/api/projects/mount', { data: { workspace } })
  expect(mountResponse.ok(), await mountResponse.text()).toBeTruthy()
  const pinResponse = await page.request.patch(`/farming/api/agents/${pinnedId}`, {
    data: { pinned: true },
  })
  expect(pinResponse.ok(), await pinResponse.text()).toBeTruthy()

  await page.route(/\/api\/usage(?:\?|$)/, async route => {
    const sampledAt = Date.now()
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        usage: {
          sampledAt,
          windowMs: 5 * 60 * 1000,
          providers: [{
            provider: 'codex',
            providerName: 'Codex',
            auth: { available: true, status: 'Logged in using ChatGPT', source: 'playwright' },
            quota: {
              available: true,
              source: 'playwright quota-only fixture',
              primary: { usedPercent: 35, windowMinutes: 5 * 60, resetsAt: sampledAt + 60 * 60_000 },
              secondary: { usedPercent: 72, windowMinutes: 7 * 24 * 60, resetsAt: sampledAt + 3 * 24 * 60 * 60_000 },
            },
            tokenUsage: {
              available: false,
              totalTokens: 0,
              tokensPerMinute: 0,
              windowMs: 5 * 60 * 1000,
              eventCount: 0,
              sampledAt,
              source: 'no local token history',
            },
          }],
          agentUsage: null,
          systemStats: null,
        },
      }),
    })
  })

  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'maxTouchPoints', { value: 5, configurable: true })
  })
  await openFarming(page)
  await expect(page.getByTestId('code-new-agent').locator('.code-nav-label')).toHaveText('New Agent')
  await expect(page.getByTestId('code-new-agent').locator('.code-nav-label')).toBeVisible()
  const violations: string[] = []

  for (const viewport of VIEWPORTS) {
    await page.setViewportSize(viewport)
    for (const appearance of APPEARANCES) {
      await page.locator('body').evaluate((body, nextAppearance) => {
        body.dataset.appearance = nextAppearance
      }, appearance)
      await expect(page.locator('body')).toHaveAttribute('data-appearance', appearance)
      await expect(page.locator('body')).toHaveClass(/code-compact-layout/)

      const sidebarViolationStart = violations.length
      await openSidebar(page)
      const newAgentAction = page.getByTestId('code-new-agent')
      await expect(newAgentAction).toHaveAccessibleName('New Agent')
      await expect(newAgentAction).toHaveCSS('width', '44px')
      await expect(newAgentAction).toHaveCSS('height', '44px')
      await expect(newAgentAction.locator('.code-nav-label')).toBeHidden()
      const topRowGeometry = await page.locator('.code-nav-top-row').evaluate(row => {
        const rowRect = row.getBoundingClientRect()
        const controls = [...row.querySelectorAll<HTMLElement>('button')]
          .map(control => {
            const rect = control.getBoundingClientRect()
            return { left: rect.left, right: rect.right, width: rect.width, height: rect.height }
          })
          .filter(control => control.width > 0 && control.height > 0)
          .sort((left, right) => left.left - right.left)
        return {
          row: { left: rowRect.left, right: rowRect.right, scrollWidth: row.scrollWidth, clientWidth: row.clientWidth },
          controls,
        }
      })
      expect(topRowGeometry.controls).toHaveLength(5)
      expect(topRowGeometry.row.scrollWidth).toBeLessThanOrEqual(topRowGeometry.row.clientWidth)
      topRowGeometry.controls.forEach((control, index) => {
        expect(control.width).toBeCloseTo(44, 3)
        expect(control.height).toBeCloseTo(44, 3)
        expect(control.left).toBeGreaterThanOrEqual(topRowGeometry.row.left - 0.01)
        expect(control.right).toBeLessThanOrEqual(topRowGeometry.row.right + 0.01)
        if (index > 0) {
          expect(control.left).toBeGreaterThanOrEqual(topRowGeometry.controls[index - 1]!.right - 0.01)
        }
      })
      const pinnedRow = page.getByTestId('code-pinned-section')
        .locator(`[data-testid="code-agent-row"][data-agent-id="${pinnedId}"]`)
      const ordinaryRow = page.locator(`[data-testid="code-agent-row"][data-agent-id="${ordinaryId}"]`)
      await expect(pinnedRow).toBeVisible()
      await expect(ordinaryRow).toBeVisible()
      const alignment = await page.evaluate(([pinnedSelector, ordinarySelector]) => {
        const metrics = (selector: string) => {
          const row = document.querySelector<HTMLElement>(selector)
          const icon = row?.querySelector<HTMLElement>('.code-agent-row-provider-icon')
          const name = row?.querySelector<HTMLElement>('.code-agent-name')
          if (!row || !icon || !name) throw new Error(`Missing Agent row geometry for ${selector}`)
          return {
            iconLeft: icon.getBoundingClientRect().left,
            nameLeft: name.getBoundingClientRect().left,
          }
        }
        return { pinned: metrics(pinnedSelector), ordinary: metrics(ordinarySelector) }
      }, [
        `[data-testid="code-pinned-section"] [data-testid="code-agent-row"][data-agent-id="${pinnedId}"]`,
        `[data-testid="code-agent-row"][data-agent-id="${ordinaryId}"]`,
      ])
      const pinnedIconDelta = Math.abs(alignment.pinned.iconLeft - alignment.ordinary.iconLeft)
      const pinnedNameDelta = Math.abs(alignment.pinned.nameLeft - alignment.ordinary.nameLeft)
      if (pinnedIconDelta > 1) {
        violations.push(`${viewport.name}/${appearance}: pinned provider icon delta ${pinnedIconDelta}px`)
      }
      if (pinnedNameDelta > 1) {
        violations.push(`${viewport.name}/${appearance}: pinned Agent name delta ${pinnedNameDelta}px`)
      }

      const machineHeight = await page.getByTestId('code-instance-name-edit').evaluate(element => (
        element.getBoundingClientRect().height
      ))
      expect(machineHeight).toBeLessThanOrEqual(28)

      const usageOpen = page.getByTestId('code-mobile-usage-open')
      await expect(usageOpen).toContainText('Weekly · 5h')
      await usageOpen.click()
      const quota = page.getByTestId('code-usage-mobile-quota')
      await expect(quota).toContainText('5h')
      await expect(quota).toContainText('Weekly')
      await evidence.capture({
        page,
        testInfo,
        screenshotName: `${viewport.name}-${appearance}-usage.png`,
        scenario: 'mobile usage dialog',
        settledAssertion: 'Usage dialog shows authoritative 5h and Weekly quota labels',
        theme: appearance,
        proofLocator: page.getByTestId('code-usage-detail-dialog'),
        expectedTestId: 'code-usage-detail-dialog',
      })
      await page.getByRole('button', { name: 'Close usage activity' }).click()
      await expect(page.getByTestId('code-usage-detail-dialog')).toHaveCount(0)
      await openSidebar(page)

      const files = page.getByTestId('code-files-section').filter({ has: page.getByRole('button', { name: /^Files$/ }) })
      const filesToggle = files.getByRole('button', { name: /^Files$/ })
      if (await filesToggle.getAttribute('aria-expanded') === 'false') await filesToggle.click()
      const project = files.locator('xpath=ancestor::section[contains(@class, "code-project-group")]')
      await expect(project.getByTestId('code-project-agent-compact')).toHaveCount(0)
      await expect(project.locator('[data-testid="code-agent-row"][data-agent-id]')).toHaveCount(2)
      if (violations.length === sidebarViolationStart) {
        await evidence.capture({
          page,
          testInfo,
          screenshotName: `${viewport.name}-${appearance}-sidebar.png`,
          scenario: 'mobile project sidebar',
          settledAssertion: 'Expanded sidebar shows aligned pinned and ordinary Agents plus the authoritative Project file section',
          theme: appearance,
          proofLocator: page.getByTestId('code-sidebar'),
          expectedTestId: 'code-sidebar',
        })
      }

      for (const searchWorkspace of [firstSearchWorkspace, secondSearchWorkspace]) {
        const response = await page.request.post('/farming/api/projects/mount', { data: { workspace: searchWorkspace } })
        expect(response.ok(), await response.text()).toBeTruthy()
      }
      await page.getByTestId('code-nav-search').click()
      const searchBox = page.getByTestId('code-search-box')
      const globalSearchInput = searchBox.getByRole('combobox')
      await globalSearchInput.fill(longSearchPath)
      const fileSearchResults = page.getByTestId('code-global-file-search-result')
      await expect(fileSearchResults).toHaveCount(2, { timeout: 30_000 })
      await expect(fileSearchResults.filter({ hasText: 'visual-root-a/org/team/shared-project' })).toBeVisible()
      await expect(fileSearchResults.filter({ hasText: 'visual-root-b/org/team/shared-project' })).toBeVisible()
      const clearSearch = searchBox.getByRole('button', { name: 'Clear search' })
      await assertRawMobileTarget(searchBox, viewport, { width: 44, height: 44 })
      await assertRawMobileTarget(clearSearch, viewport, { width: 44, height: 44 })
      for (const result of await fileSearchResults.all()) {
        await assertRawMobileTarget(result, viewport, { width: 44, height: 48 })
      }
      await clearSearch.tap()
      await expect(searchBox).toHaveCount(0)
      await openSidebar(page)
      await page.getByTestId('code-nav-search').tap()
      await expect(searchBox).toBeVisible()
      await expect(globalSearchInput).toHaveValue('')
      await globalSearchInput.fill(longSearchPath)
      await expect(fileSearchResults).toHaveCount(2, { timeout: 30_000 })
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2)).toBe(true)
      const assertFileSearchReady = async () => {
        await expect(page.locator('body')).toHaveAttribute('data-appearance', appearance)
        await expect(globalSearchInput).toHaveValue(longSearchPath)
        await expect(fileSearchResults).toHaveCount(2)
        await expect(fileSearchResults.filter({ hasText: 'visual-root-a/org/team/shared-project' })).toBeVisible()
        await expect(fileSearchResults.filter({ hasText: 'visual-root-b/org/team/shared-project' })).toBeVisible()
        await assertRawMobileTarget(searchBox, viewport, { width: 44, height: 44 })
        await assertRawMobileTarget(clearSearch, viewport, { width: 44, height: 44 })
        for (const result of await fileSearchResults.all()) {
          await assertRawMobileTarget(result, viewport, { width: 44, height: 48 })
        }
        await expect.poll(() => page.evaluate(() => (
          document.documentElement.scrollWidth <= window.innerWidth + 2
          && document.body.scrollWidth <= window.innerWidth + 2
        ))).toBe(true)
      }
      await evidence.capture({
        page,
        testInfo,
        screenshotName: `${viewport.name}-${appearance}-file-search.png`,
        scenario: 'mobile global file path search',
        settledAssertion: 'Global Search shows two touch-sized long-path results whose same-name Projects remain visibly distinguishable without viewport overflow',
        theme: appearance,
        assertReady: assertFileSearchReady,
        proofLocator: page.getByTestId('code-global-file-search-results'),
        expectedTestId: 'code-global-file-search-results',
        stableLocators: [
          searchBox,
          clearSearch,
          fileSearchResults.nth(0),
          fileSearchResults.nth(1),
        ],
      })
      for (const searchWorkspace of [firstSearchWorkspace, secondSearchWorkspace]) {
        const response = await page.request.post('/farming/api/projects/remove', { data: { workspace: searchWorkspace } })
        expect(response.ok(), await response.text()).toBeTruthy()
      }

      await openAgent(page, ordinaryId)
      const input = page.getByTestId('code-composer-input')
      await input.fill(`mobile ${viewport.name} ${appearance}`)
      await input.press('Enter')
      await expect(input).toHaveValue(`mobile ${viewport.name} ${appearance}\n`)
      await page.getByTestId('code-composer-send').click()
      await expect(input).toHaveValue('')

      const plusTrigger = page.getByTestId('code-composer-add')
      await plusTrigger.click()
      const plus = await menuGapAndViewport(page, plusTrigger, page.getByTestId('code-composer-plus-menu'))
      if (!plus.fits || plus.gap < 6 || plus.gap > 14) {
        violations.push(`${viewport.name}/${appearance}: plus menu ${JSON.stringify(plus)}`)
      }
      await evidence.capture({
        page,
        testInfo,
        screenshotName: `${viewport.name}-${appearance}-terminal-plus.png`,
        scenario: 'mobile Terminal add menu open',
        settledAssertion: 'Terminal add menu is visible, fully inside the visual viewport, and separated from the Composer',
        theme: appearance,
        proofLocator: page.getByTestId('code-composer-plus-menu'),
        expectedTestId: 'code-composer-plus-menu',
      })
      await page.keyboard.press('Escape')

      const approvalTrigger = page.getByTestId('code-composer-approval')
      await approvalTrigger.click()
      const approvalMenu = page.getByTestId('code-approval-menu')
      const approvalViolationStart = violations.length
      const approvalBounds = await menuGapAndViewport(page, approvalTrigger, approvalMenu)
      const approvalComposerGap = await page.getByTestId('code-composer').evaluate((element, menuElement) => (
        element.getBoundingClientRect().top - (menuElement as HTMLElement).getBoundingClientRect().bottom
      ), await approvalMenu.elementHandle())
      if (!approvalBounds.fits || approvalComposerGap < 6 || approvalComposerGap > 14) {
        violations.push(`${viewport.name}/${appearance}: approval menu ${JSON.stringify({ ...approvalBounds, composerGap: approvalComposerGap })}`)
      }
      const approval = await approvalMenu.evaluate(element => {
        const styleNumber = (selector: string, property: 'fontSize' | 'width' | 'height') => {
          const target = element.querySelector<HTMLElement>(selector)
          if (!target) throw new Error(`Missing approval element ${selector}`)
          return Number.parseFloat(getComputedStyle(target)[property])
        }
        const row = element.querySelector<HTMLElement>('.code-approval-option')
        if (!row) throw new Error('Missing approval row')
        return {
          headerFont: styleNumber('.code-approval-menu-header', 'fontSize'),
          titleFont: styleNumber('.code-approval-option-copy span', 'fontSize'),
          descriptionFont: styleNumber('.code-approval-option-copy small', 'fontSize'),
          iconSize: styleNumber('.code-approval-option-icon', 'width'),
          rowMinHeight: Number.parseFloat(getComputedStyle(row).minHeight),
          rowHeight: row.getBoundingClientRect().height,
        }
      })
      if (
        approval.headerFont !== 13
        || approval.titleFont !== 13
        || approval.descriptionFont !== 11
        || approval.iconSize !== 22
        || approval.rowMinHeight !== 36
        || approval.rowHeight < 52
      ) {
        violations.push(`${viewport.name}/${appearance}: approval metrics ${JSON.stringify(approval)}`)
      }
      if (violations.length === approvalViolationStart) {
        await evidence.capture({
          page,
          testInfo,
          screenshotName: `${viewport.name}-${appearance}-approval.png`,
          scenario: 'mobile approval menu open',
          settledAssertion: 'Approval menu is visible, unobscured, inside the visual viewport, and separated from the Composer',
          theme: appearance,
          proofLocator: approvalMenu,
          expectedTestId: 'code-approval-menu',
        })
      }
      await page.keyboard.press('Escape')

      const modelTrigger = page.getByTestId('code-composer-model-picker')
      await modelTrigger.click()
      const modelMenu = page.getByTestId('code-model-menu')
      await expect(modelMenu).toBeVisible()
      const modelViolationStart = violations.length
      const model = await menuGapAndViewport(page, modelTrigger, modelMenu)
      const modelPeers = await page.evaluate(() => {
        const rect = (testId: string) => {
          const value = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`)?.getBoundingClientRect()
          if (!value) throw new Error(`Missing ${testId} geometry`)
          return { left: value.left, right: value.right }
        }
        return {
          send: rect('code-composer-send'),
          composer: rect('code-composer'),
          visualViewportRight: (window.visualViewport?.offsetLeft ?? 0)
            + (window.visualViewport?.width ?? window.innerWidth),
        }
      })
      if (!model.fits || model.gap < 6 || model.gap > 14) {
        violations.push(`${viewport.name}/${appearance}: model menu ${JSON.stringify({ ...model, ...modelPeers })}`)
      }
      const modelOcclusion = await modelMenu.evaluate(element => {
        const rect = element.getBoundingClientRect()
        const topmost = document.elementFromPoint(rect.left + rect.width / 2, rect.top + 12)
        return {
          containsTopmost: topmost instanceof Node && element.contains(topmost),
          menuZIndex: getComputedStyle(element).zIndex,
          topmostClass: topmost instanceof Element ? topmost.getAttribute('class') : null,
          topmostTestId: topmost instanceof Element ? topmost.getAttribute('data-testid') : null,
          topmostTag: topmost instanceof Element ? topmost.tagName : null,
          topmostZIndex: topmost instanceof Element ? getComputedStyle(topmost).zIndex : null,
        }
      })
      if (!modelOcclusion.containsTopmost) {
        violations.push(`${viewport.name}/${appearance}: model menu occluded ${JSON.stringify(modelOcclusion)}`)
      }
      if (violations.length === modelViolationStart) {
        await evidence.capture({
          page,
          testInfo,
          screenshotName: `${viewport.name}-${appearance}-model.png`,
          scenario: 'mobile model menu open',
          settledAssertion: 'Model menu is visibly open, topmost, and fully inside the visual viewport',
          theme: appearance,
          proofLocator: modelMenu,
          expectedTestId: 'code-model-menu',
        })
      }
      await page.keyboard.press('Escape')

      await openAgent(page, chatId)
      const acpAdd = page.getByTestId('code-acp-composer-add')
      await expect(acpAdd).toBeVisible({ timeout: 30_000 })
      const acpModelTrigger = page.getByTestId('code-acp-model-picker')
      await expect(acpModelTrigger).toBeVisible()
      await acpModelTrigger.click()
      const acpModel = await menuGapAndViewport(
        page,
        acpModelTrigger,
        page.getByTestId('code-acp-model-menu'),
      )
      if (!acpModel.fits || acpModel.gap < 6 || acpModel.gap > 14) {
        violations.push(`${viewport.name}/${appearance}: ACP model menu ${JSON.stringify(acpModel)}`)
      }
      await evidence.capture({
        page,
        testInfo,
        screenshotName: `${viewport.name}-${appearance}-acp-model.png`,
        scenario: 'mobile Chat model menu open',
        settledAssertion: 'Chat model menu is visible and fully inside the visual viewport',
        theme: appearance,
        proofLocator: page.getByTestId('code-acp-model-menu'),
        expectedTestId: 'code-acp-model-menu',
      })
      await page.keyboard.press('Escape')
      await acpAdd.click()
      const acpMenu = page.getByTestId('code-acp-plus-menu')
      await expect(acpMenu).toBeVisible()
      await expect(acpMenu).not.toContainText(/logout/i)
      await expect(page.getByTestId('code-acp-logout')).toHaveCount(0)
      await evidence.capture({
        page,
        testInfo,
        screenshotName: `${viewport.name}-${appearance}-acp-plus.png`,
        scenario: 'mobile Chat add menu open',
        settledAssertion: 'Chat add menu is visible, contains no unrelated logout action, and stays inside the viewport',
        theme: appearance,
        proofLocator: acpMenu,
        expectedTestId: 'code-acp-plus-menu',
      })
      await page.keyboard.press('Escape')

    }
  }

  // A history-backed Chat has a different failure contract from a fresh Chat:
  // bounded read exhaustion must expose one touch-sized, read-only recovery
  // action. Capture that state in every appearance without replaying a Prompt.
  await page.setViewportSize({ width: 390, height: 844 })
  await openAgent(page, chatId)
  const historyInput = page.getByTestId('code-acp-composer-input')
  await historyInput.fill('markdown typography')
  await page.getByTestId('code-acp-composer-send').click()
  await expect(page.getByText('Typography baseline.', { exact: true })).toBeVisible({ timeout: 20_000 })
  await openAgent(page, ordinaryId)

  let allowHistoryRecovery = false
  await page.route(
    new RegExp(`/farming/api/agents/${chatId}/acp-transcript(?:\\?.*)?$`),
    async route => {
      if (!allowHistoryRecovery) {
        await route.abort('connectionreset')
        return
      }
      await route.continue()
    },
  )
  await page.reload()
  await openAgent(page, chatId)
  const historyError = page.getByTestId('code-agent-transcript-load-error')
  await expect(historyError).toContainText('This session’s Chat history could not be loaded.', {
    timeout: 10_000,
  })
  const retry = historyError.getByRole('button', { name: 'Retry' })
  await expect(retry).toBeVisible()
  expect(await retry.evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44)

  for (const appearance of APPEARANCES) {
    await page.locator('body').evaluate((body, nextAppearance) => {
      body.dataset.appearance = nextAppearance
    }, appearance)
    await evidence.capture({
      page,
      testInfo,
      screenshotName: `390x844-${appearance}-history-retry.png`,
      scenario: 'mobile Chat history read failure',
      settledAssertion: 'History-backed Chat shows one touch-sized read-only Retry action after bounded transcript read failure',
      theme: appearance,
      proofLocator: historyError,
      expectedTestId: 'code-agent-transcript-load-error',
    })
  }

  allowHistoryRecovery = true
  await retry.click()
  await expect(page.getByText('Typography baseline.', { exact: true })).toBeVisible({ timeout: 10_000 })
  await expect(historyError).toHaveCount(0)

  expect(violations).toEqual([])
})
