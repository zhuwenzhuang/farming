import path from 'node:path'
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import type { Locator, Page } from '@playwright/test'
import {
  expect,
  expectTerminalCanvasToHaveInk,
  getAgentIdFromRow,
  openFarming,
  openNewAgentDialog,
  scrollTerminalToLine,
  startAgentFromOpenDialog,
  terminalRows,
  terminalViewport,
  test,
  writeTerminalFixture,
  writeTerminalRaw,
  writeTerminalRawAndSampleViewport,
} from './fixtures'

type MockAgentSession = {
  provider?: string
  providerName?: string
  capabilities?: string[]
  [key: string]: unknown
}

const packageVersion = (JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8')) as { version: string }).version

function activeFileTabName(page: Page) {
  return page.getByTestId('code-file-editor').getByRole('tab', { selected: true }).locator('.code-file-editor-tab-name')
}

async function modifierClick(page: Page, agentId: string, x: number, y: number) {
  await page.evaluate(({ id, clientX, clientY }) => {
    const target = document.querySelector(
      `[data-testid="code-terminal-pane"][data-agent-id="${CSS.escape(id)}"] .terminal-session-host`,
    )
    if (!(target instanceof HTMLElement)) throw new Error('Modifier-click target is missing')
    const eventOptions = {
      bubbles: true,
      cancelable: true,
      button: 0,
      buttons: 0,
      clientX,
      clientY,
      ctrlKey: true,
    }
    target.dispatchEvent(new MouseEvent('mouseup', eventOptions))
  }, { id: agentId, clientX: x, clientY: y })
}

async function createControlAgent(page: Page, command: string, workspace: string) {
  const response = await page.request.post('/farming/api/control/agents', {
    data: { command, workspace },
  })
  expect(response.ok()).toBeTruthy()
  const data = await response.json() as { agentId?: string }
  expect(data.agentId).toBeTruthy()
  return data.agentId as string
}

async function expectCompactVersionLabel(productMark: Locator, mode: 'light' | 'dark') {
  const productMarkBadge = productMark.locator('.code-product-mark-badge')
  await expect(productMark).toHaveCSS('border-top-width', '0px')
  await expect(productMarkBadge).toHaveCSS('border-top-width', '0px')
  const metrics = await productMark.evaluate(element => {
    const main = Array.from(element.querySelectorAll<HTMLElement>('.code-product-mark-main'))
      .find(candidate => getComputedStyle(candidate).display !== 'none') ?? null
    const badge = element.querySelector('.code-product-mark-badge') as HTMLElement | null
    if (!main || !badge) {
      return null
    }
    const markStyle = getComputedStyle(element)
    const badgeStyle = getComputedStyle(badge)
    const mainRect = main.getBoundingClientRect()
    const badgeRect = badge.getBoundingClientRect()
    return {
      markBackground: markStyle.backgroundColor,
      badgeBackground: badgeStyle.backgroundColor,
      badgeBorderRadius: Number.parseFloat(badgeStyle.borderTopLeftRadius),
      badgeHeight: badgeRect.height,
      badgeDisplay: badgeStyle.display,
      mainRight: mainRect.x + mainRect.width,
      badgeX: badgeRect.x,
    }
  })
  if (!metrics) {
    throw new Error(`Product mark metrics are missing in ${mode} mode`)
  }
  expect(metrics.markBackground, `${mode} product mark should not draw the outer ring`).toBe('rgba(0, 0, 0, 0)')
  expect(metrics.badgeBackground, `${mode} version should stay borderless`).toBe('rgba(0, 0, 0, 0)')
  expect(metrics.badgeBorderRadius, `${mode} version should not use a pill`).toBe(0)
  expect(metrics.badgeHeight, `${mode} version should stay compact`).toBeLessThanOrEqual(16)
  expect(metrics.badgeDisplay, `${mode} version should be visible`).not.toBe('none')
  expect(metrics.badgeX, `${mode} version should sit to the right of the title`).toBeGreaterThan(metrics.mainRight - 1)
}

async function expectCollapsedProductMarkIsIconOnly(productMark: Locator) {
  const metrics = await productMark.evaluate(element => {
    const main = element.querySelector('.code-product-mark-main') as HTMLElement | null
    const badge = element.querySelector('.code-product-mark-badge') as HTMLElement | null
    const logo = element.querySelector('.code-product-logo') as HTMLElement | null
    const markStyle = getComputedStyle(element)
    const rect = element.getBoundingClientRect()
    return {
      width: rect.width,
      markBorderWidth: markStyle.borderTopWidth,
      markBackground: markStyle.backgroundColor,
      mainDisplay: main ? getComputedStyle(main).display : null,
      badgeDisplay: badge ? getComputedStyle(badge).display : null,
      logoDisplay: logo ? getComputedStyle(logo).display : null,
      logoWidth: logo?.getBoundingClientRect().width ?? 0,
    }
  })
  expect(metrics.width).toBeLessThanOrEqual(56)
  expect(metrics.markBorderWidth).toBe('0px')
  expect(metrics.markBackground).toBe('rgba(0, 0, 0, 0)')
  expect(metrics.mainDisplay).toBe('none')
  expect(metrics.badgeDisplay).toBe('none')
  expect(metrics.logoDisplay).not.toBe('none')
  expect(metrics.logoWidth).toBeGreaterThanOrEqual(24)
}

async function mockCodexSessions(page: Page, sessions: MockAgentSession[] = []) {
  const agentSessions = sessions.map(session => {
    const provider = typeof session.provider === 'string' ? session.provider : 'codex'
    return {
      ...session,
      provider,
      providerName: typeof session.providerName === 'string'
        ? session.providerName
        : (provider === 'claude' ? 'Claude' : 'Codex'),
      capabilities: Array.isArray(session.capabilities)
        ? session.capabilities
        : (provider === 'claude' ? ['resume', 'fork'] : ['resume']),
    }
  })
  const codexSessions = agentSessions
    .filter(session => session.provider === 'codex')
    .map(({ provider: _provider, providerName: _providerName, capabilities: _capabilities, ...session }) => session)
  await page.route(/\/farming\/api\/codex\/sessions(?:\?.*)?$/, async route => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ sessions: codexSessions }),
    })
  })
  await page.route(/\/farming\/api\/agent-sessions(?:\?.*)?$/, async route => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ sessions: agentSessions }),
    })
  })
}

test.describe('display-backed agent flows', () => {
  test('shows a compact product version without raw git suffixes', async ({ page }) => {
    await mockCodexSessions(page)

    await openFarming(page)
    const productMark = page.getByTestId('code-product-mark')
    await expect(productMark).toContainText('Farming Code')
    await expect(productMark).toContainText(`v${packageVersion}`)
    await expect(productMark).not.toContainText('DOGFOOD')
    await expect(productMark).not.toContainText('g25c4faf4')
    await expect(productMark).not.toContainText('dirty')
    await expect(productMark).toHaveAttribute('title', 'Farming Code')
    await expect(productMark).not.toContainText('UPGRADE')
    await expect(productMark).not.toHaveClass(/upgrade/)
    await expectCompactVersionLabel(productMark, 'light')
    const productMarkMainBox = await productMark.locator('.code-product-mark-main:visible').boundingBox()
    const productMarkMetaBox = await productMark.locator('.code-product-mark-badge').boundingBox()
    if (!productMarkMainBox || !productMarkMetaBox) {
      throw new Error('Product mark layout boxes are missing')
    }
    const mainCenterY = productMarkMainBox.y + productMarkMainBox.height / 2
    const metaCenterY = productMarkMetaBox.y + productMarkMetaBox.height / 2
    expect(Math.abs(mainCenterY - metaCenterY)).toBeLessThanOrEqual(3)
    expect(productMarkMetaBox.x).toBeGreaterThan(productMarkMainBox.x + productMarkMainBox.width - 1)

    await productMark.click()
    const brandDialog = page.getByTestId('code-brand-dialog')
    await expect(brandDialog).toBeVisible()
    await expect(brandDialog.getByRole('heading', { name: 'Farming Code' })).toBeVisible()
    await expect(brandDialog).toContainText(`v${packageVersion}`)
    await expect(brandDialog).toContainText('Farming Code began with a simple idea')
    await expect(brandDialog.getByRole('link', { name: 'GitHub' })).toHaveAttribute('href', 'https://github.com/zhuwenzhuang/farming')
    await expect(brandDialog).not.toContainText('https://github.com/zhuwenzhuang/farming')
    await page.evaluate(() => document.body.setAttribute('data-appearance', 'dark'))
    await expect(page.locator('body')).toHaveAttribute('data-appearance', 'dark')
    await expect(brandDialog.locator('.code-brand-dialog')).toHaveCSS('color', 'rgb(230, 237, 243)')
    await brandDialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(brandDialog).toHaveCount(0)
    await expectCompactVersionLabel(productMark, 'dark')
    await page.getByTestId('code-sidebar-toggle').click()
    await expect(page.getByTestId('code-sidebar')).toHaveClass(/collapsed/)
    await expectCollapsedProductMarkIsIconOnly(productMark)
  })

  test('keeps the start dialog readable while agent discovery is loading', async ({ page }) => {
    await mockCodexSessions(page)
    let releaseExecutables: (() => void) | null = null
    const executablesBlocked = new Promise<void>(resolve => {
      releaseExecutables = resolve
    })

    await page.route('**/farming/api/executables', async route => {
      await executablesBlocked
      await route.continue()
    })

    await page.goto('/farming/', { waitUntil: 'domcontentloaded' })
    await expect(page.getByTestId('app-shell')).toBeVisible()
    await expect(page.getByTestId('input-dialog')).toBeHidden()
    await page.getByTestId('code-new-agent').click()
    await expect(page.getByTestId('input-dialog')).toBeVisible()
    await expect(page.getByTestId('agent-list-status')).toBeVisible()
    await expect(page.getByTestId('agent-option-bash')).toBeHidden()

    releaseExecutables?.()
    await expect(page.getByTestId('agent-option-codex')).toContainText('Codex')
    await expect(page.getByTestId('agent-option-codex')).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await expect(page.getByTestId('agent-option-claude')).toBeFocused()
    await page.keyboard.press('End')
    await expect(page.getByTestId('agent-option-zsh')).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await expect(page.getByTestId('agent-option-codex')).toBeFocused()
    await page.keyboard.press('ArrowUp')
    await expect(page.getByTestId('agent-option-zsh')).toBeFocused()
    await page.keyboard.press('Home')
    await expect(page.getByTestId('agent-option-codex')).toBeFocused()
    await expect(page.getByTestId('agent-option-claude')).toContainText('Claude Code')
    await expect(page.getByTestId('agent-option-bash')).toBeVisible()
    await expect(page.getByTestId('agent-option-zsh')).toContainText('zsh')
    await expect(page.getByTestId('agent-option-qwen')).toHaveCount(0)
    await expect(page.getByTestId('agent-list-status')).toBeHidden()
  })

  test('keeps an in-progress Search query focused when the first agent loads', async ({ page, workspaceRoot }) => {
    await mockCodexSessions(page)
    await openFarming(page)
    await expect(page.getByTestId('code-empty-workspace')).toBeVisible()

    await page.getByTestId('code-nav-search').click()
    const searchInput = page.getByTestId('code-search-box').locator('input')
    await searchInput.fill('partially typed search')
    await expect(searchInput).toBeFocused()

    const agentId = await createControlAgent(page, 'bash', workspaceRoot)
    await expect(page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('code-search-panel')).toBeVisible()
    await expect(searchInput).toHaveValue('partially typed search')
    await expect(searchInput).toBeFocused()
  })

  test('keeps an in-progress History query focused when the first agent loads', async ({ page, workspaceRoot }) => {
    await mockCodexSessions(page)
    await openFarming(page)
    await expect(page.getByTestId('code-empty-workspace')).toBeVisible()

    await page.getByTestId('code-nav-history').click()
    const historyInput = page.getByTestId('code-history-search-box').locator('input')
    await historyInput.fill('partially typed history')
    await expect(historyInput).toBeFocused()

    const agentId = await createControlAgent(page, 'bash', workspaceRoot)
    await expect(page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('code-history-panel')).toBeVisible()
    await expect(historyInput).toHaveValue('partially typed history')
    await expect(historyInput).toBeFocused()
  })

  test('searches older provider History and renders one clear control', async ({ page, workspaceRoot }) => {
    await mockCodexSessions(page)
    let searchRequests = 0
    await page.route(/\/farming\/api\/agent-sessions\/search\?.*$/, async route => {
      searchRequests += 1
      const query = new URL(route.request().url()).searchParams.get('q')
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          sessions: query === '上下游联动替代表测试'
            ? [{
                provider: 'codex',
                providerName: 'Codex',
                capabilities: ['resume'],
                id: '019f0000-0000-7000-8000-000000000220',
                title: '上下游联动替代表测试',
                cwd: workspaceRoot,
                workspace: workspaceRoot,
                updatedAt: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString(),
                createdAt: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString(),
                archived: false,
                pinned: false,
                unread: false,
                projectless: false,
                model: 'gpt-5.5',
                effort: 'high',
                source: 'codex',
              }]
            : [],
        }),
      })
    })

    await openFarming(page)
    await page.getByTestId('code-nav-history').click()
    const searchBox = page.getByTestId('code-history-search-box')
    const historyInput = searchBox.locator('input')
    await expect(historyInput).toHaveAttribute('type', 'text')
    await expect(historyInput).toHaveAttribute('role', 'searchbox')
    await expect(historyInput).toHaveAttribute('inputmode', 'search')
    await historyInput.fill('上下游联动替代表测试')

    await expect.poll(() => searchRequests).toBeGreaterThan(0)
    await expect(page.getByTestId('code-session-history-card').filter({ hasText: '上下游联动替代表测试' })).toHaveCount(1)
    await expect(searchBox.getByRole('button')).toHaveCount(1)
    await expect(searchBox.getByRole('button', { name: 'Clear search' })).toBeVisible()
    await searchBox.getByRole('button', { name: 'Clear search' }).click()
    await expect(historyInput).toHaveValue('')
  })

  test('reopens the last closed editor tab with the VS Code shortcut', async ({ page, workspaceRoot }) => {
    await mockCodexSessions(page)
    const projectDir = path.join(workspaceRoot, 'reopen-editor-tab')
    fs.mkdirSync(projectDir, { recursive: true })
    fs.writeFileSync(path.join(projectDir, 'one.txt'), 'one\n')
    const agentId = await createControlAgent(page, 'bash', projectDir)

    await openFarming(page)
    const projectGroup = page.getByTestId('code-project-group').filter({ has: page.locator(`[data-agent-id="${agentId}"]`) })
    await expect(projectGroup).toBeVisible({ timeout: 30_000 })
    const filesSection = projectGroup.getByTestId('code-files-section')
    const filesTitle = filesSection.locator('.code-files-title').first()
    if (await filesTitle.getAttribute('aria-expanded') !== 'true') {
      await filesTitle.click()
    }
    await expect(filesTitle).toHaveAttribute('aria-expanded', 'true')

    const oneRow = filesSection.locator('[data-testid="code-file-row"][data-file-path="one.txt"]')
    await expect(oneRow).toBeVisible()
    await oneRow.click()
    await expect(page.getByTestId('code-file-editor')).toBeVisible()
    await expect(activeFileTabName(page)).toHaveText('one.txt')

    await page.getByRole('button', { name: 'Close one.txt' }).click()
    await expect(page.getByTestId('code-terminal-grid')).toBeVisible()
    await expect(page.getByTestId('code-file-editor')).toHaveCount(0)

    await page.keyboard.press('Control+Shift+T')
    await expect(page.getByTestId('code-file-editor')).toBeVisible()
    await expect(activeFileTabName(page)).toHaveText('one.txt')
  })

  test('does not select file tree labels when they are double-clicked', async ({ page, workspaceRoot }) => {
    await mockCodexSessions(page)
    const projectDir = path.join(workspaceRoot, 'file-tree-selection')
    fs.mkdirSync(path.join(projectDir, 'folder'), { recursive: true })
    fs.writeFileSync(path.join(projectDir, 'one.txt'), 'one\n')
    fs.writeFileSync(path.join(projectDir, 'folder', 'nested.txt'), 'nested\n')
    const agentId = await createControlAgent(page, 'bash', projectDir)

    await openFarming(page)
    const project = page.getByTestId('code-project-group').filter({
      has: page.locator(`[data-agent-id="${agentId}"]`),
    })
    await expect(project).toBeVisible({ timeout: 30_000 })
    const filesSection = project.getByTestId('code-files-section')
    const filesTitle = filesSection.locator('.code-files-title').first()
    if (await filesTitle.getAttribute('aria-expanded') !== 'true') {
      await filesTitle.click()
    }

    const directoryRow = filesSection.locator('[data-testid="code-file-row"][data-file-path="folder"]')
    await expect(directoryRow).toBeVisible()
    await page.evaluate(() => window.getSelection()?.removeAllRanges())
    await directoryRow.locator('.code-file-name').dblclick({ position: { x: 5, y: 5 } })
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? '')).toBe('')

    const fileRow = filesSection.locator('[data-testid="code-file-row"][data-file-path="one.txt"]')
    await page.evaluate(() => window.getSelection()?.removeAllRanges())
    await fileRow.locator('.code-file-name').dblclick({ position: { x: 5, y: 5 } })
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? '')).toBe('')
    await expect(activeFileTabName(page)).toHaveText('one.txt')
  })

  test('opens project changes into the editor diff surface', async ({ page, workspaceRoot }) => {
    await mockCodexSessions(page)
    const projectDir = path.join(workspaceRoot, 'project-changes')
    fs.mkdirSync(projectDir, { recursive: true })
    const changedFilePath = path.join(projectDir, 'review-target.txt')
    fs.writeFileSync(changedFilePath, 'before\n')
    execFileSync('git', ['init'], { cwd: projectDir })
    execFileSync('git', ['config', 'user.name', 'Farming E2E'], { cwd: projectDir })
    execFileSync('git', ['config', 'user.email', 'farming-e2e@example.com'], { cwd: projectDir })
    execFileSync('git', ['add', 'review-target.txt'], { cwd: projectDir })
    execFileSync('git', ['commit', '-m', 'seed review target'], { cwd: projectDir })
    fs.writeFileSync(changedFilePath, 'before\nafter\n')
    fs.mkdirSync(path.join(projectDir, 'scratch'), { recursive: true })
    fs.writeFileSync(path.join(projectDir, 'scratch/scratch.log'), 'temporary\n')
    fs.mkdirSync(path.join(projectDir, 'delete-dir'), { recursive: true })
    fs.writeFileSync(path.join(projectDir, 'delete-dir/original.txt'), 'original\n')
    const playbackDir = path.join(projectDir, 'demo-app/packages/viewer/playback_json')
    fs.mkdirSync(playbackDir, { recursive: true })
    execFileSync('git', ['init'], { cwd: playbackDir, stdio: 'ignore' })
    fs.mkdirSync(path.join(playbackDir, '.empty-hooks'), { recursive: true })
    execFileSync('git', ['config', 'core.hooksPath', '.empty-hooks'], { cwd: playbackDir })
    execFileSync('git', ['config', 'user.name', 'Nested Repo'], { cwd: playbackDir })
    execFileSync('git', ['config', 'user.email', 'nested@example.com'], { cwd: playbackDir })
    fs.writeFileSync(path.join(playbackDir, 'README.md'), 'nested repo\n')
    execFileSync('git', ['add', 'README.md'], { cwd: playbackDir })
    execFileSync('git', ['commit', '-m', 'nested repo'], { cwd: playbackDir, stdio: 'ignore' })
    const agentId = await createControlAgent(page, 'bash', projectDir)

    await openFarming(page)
    const projectGroup = page.getByTestId('code-project-group').filter({ has: page.locator(`[data-agent-id="${agentId}"]`) })
    await expect(projectGroup).toBeVisible({ timeout: 30_000 })
    const filesSection = projectGroup.getByTestId('code-files-section')
    const filesTitle = filesSection.locator('.code-files-title').first()
    if (await filesTitle.getAttribute('aria-expanded') !== 'true') {
      await filesTitle.click()
    }
    await expect(filesTitle).toHaveAttribute('aria-expanded', 'true')
    const changesSection = filesSection.getByTestId('code-file-changes-section')
    await expect(changesSection).toBeVisible({ timeout: 30_000 })
    const trackedGroup = changesSection.getByTestId('code-file-change-tracked-group')
    await expect(trackedGroup).toBeVisible()
    const changesTitle = trackedGroup.getByRole('button', { name: /Changes/ })
    await expect(changesTitle).toContainText('Changes')
    await expect(changesTitle).toHaveAttribute('aria-expanded', 'false')
    const untrackedGroup = changesSection.getByTestId('code-file-change-untracked-group')
    await expect(untrackedGroup).toBeVisible()
    await expect(untrackedGroup.getByRole('button', { name: /Untracked/ })).toHaveAttribute('aria-expanded', 'false')
    await expect(changesSection.getByTestId('code-file-change-row').filter({ hasText: 'scratch.log' })).toHaveCount(0)
    await expect(changesSection.getByRole('button', { name: 'Refresh changes' })).toHaveCount(0)
    const trackedReviewPromise = page.waitForEvent('popup')
    await trackedGroup.getByRole('button', { name: 'Review', exact: true }).click()
    const trackedReview = await trackedReviewPromise
    await expect.poll(() => new URL(trackedReview.url()).searchParams.get('scope')).toBe('tracked')
    await expect(changesTitle).toHaveAttribute('aria-expanded', 'false')
    await trackedReview.close()
    const untrackedReviewPromise = page.waitForEvent('popup')
    await untrackedGroup.getByRole('button', { name: 'Review', exact: true }).click()
    const untrackedReview = await untrackedReviewPromise
    await expect.poll(() => new URL(untrackedReview.url()).searchParams.get('scope')).toBe('untracked')
    expect(new URL(untrackedReview.url()).searchParams.get('modifiedWithinDays')).toBe('3')
    await untrackedReview.close()
    await changesTitle.click()
    await expect(changesTitle).toHaveAttribute('aria-expanded', 'true')
    const changeRow = changesSection.getByTestId('code-file-change-row').filter({ hasText: 'review-target.txt' })
    await expect(changeRow).toBeVisible()
    await expect(changeRow.locator('.code-file-change-status')).toHaveText('M')
    await expect(changeRow).toBeVisible()
    await changeRow.click()
    await expect(page.getByTestId('code-file-editor')).toBeVisible()
    await expect(activeFileTabName(page)).toHaveText('review-target.txt')
    await expect(page.getByTestId('code-file-diff-view')).toBeVisible()
    await expect(page.getByTestId('code-file-diff-monaco')).toBeVisible()
    await expect(changeRow).toHaveClass(/active/)
    const untrackedTitle = untrackedGroup.getByRole('button', { name: /Untracked/ })
    const untrackedRefresh = page.waitForResponse(response => response.url().includes('/api/files/changes'))
    await untrackedTitle.click()
    await expect(untrackedTitle).toHaveAttribute('aria-expanded', 'true')
    await untrackedRefresh
    fs.writeFileSync(path.join(projectDir, 'watched-later.txt'), 'created after Files opened\n')
    await page.waitForTimeout(500)
    await expect(untrackedGroup.getByTestId('code-file-change-row').filter({ hasText: 'watched-later.txt' })).toHaveCount(0)
    const filesRefreshButton = filesSection.getByTestId('code-files-refresh')
    const trackedCount = trackedGroup.getByTestId('code-file-changes-tracked-count')
    const untrackedCount = untrackedGroup.getByTestId('code-file-changes-untracked-count')
    await expect(filesRefreshButton).toHaveAttribute('data-refresh-status', 'idle')
    await filesRefreshButton.click()
    await expect(filesRefreshButton).toHaveAttribute('data-refresh-status', 'refreshing')
    await expect(filesRefreshButton).toBeDisabled()
    await expect(filesRefreshButton).toHaveAccessibleName('Refreshing files…')
    await expect(trackedCount).toHaveAttribute('data-refresh-state', 'refreshing')
    await expect(untrackedCount).toHaveAttribute('data-refresh-state', 'refreshing')
    await expect(untrackedGroup.getByTestId('code-file-change-row').filter({ hasText: 'watched-later.txt' })).toBeVisible({ timeout: 30_000 })
    await expect(filesRefreshButton).toHaveAttribute('data-refresh-status', 'success')
    await expect(filesRefreshButton).toBeEnabled()
    await expect(filesRefreshButton).toHaveAccessibleName('Files refreshed')
    await expect(trackedCount).toHaveAttribute('data-refresh-state', 'refreshed')
    await expect(untrackedCount).toHaveAttribute('data-refresh-state', 'refreshed')
    await expect(filesRefreshButton).toHaveAttribute('data-refresh-status', 'idle', { timeout: 3_000 })
    await page.route('**/api/files/changes?**', async route => {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Changes temporarily unavailable' }),
      })
    }, { times: 1 })
    await filesRefreshButton.click()
    await expect(filesRefreshButton).toHaveAttribute('data-refresh-status', 'refreshing')
    await expect(trackedCount).toHaveAttribute('data-refresh-state', 'refreshing')
    await expect(untrackedCount).toHaveAttribute('data-refresh-state', 'refreshing')
    await expect(filesRefreshButton).toHaveAttribute('data-refresh-status', 'error')
    await expect(filesRefreshButton).toBeEnabled()
    await expect(filesRefreshButton).toHaveAccessibleName('Files refresh failed')
    await expect(trackedCount).toHaveAttribute('data-refresh-state', 'stale')
    await expect(untrackedCount).toHaveAttribute('data-refresh-state', 'stale')
    const compactDirectory = untrackedGroup.getByTestId('code-file-change-directory-row').filter({ hasText: 'demo-app/packages/viewer' })
    await expect(compactDirectory).toBeVisible()
    await compactDirectory.click()
    const playbackDirectory = untrackedGroup.getByTestId('code-file-change-directory-row').filter({ hasText: 'playback_json' })
    await expect(playbackDirectory).toBeVisible()
    await expect(playbackDirectory).toHaveAttribute('data-file-type', 'directory')
    await expect(untrackedGroup.getByTestId('code-file-change-row').filter({ hasText: 'playback_json' })).toHaveCount(0)
    const scratchDirectory = untrackedGroup.getByTestId('code-file-change-directory-row').filter({ hasText: 'scratch' })
    await expect(scratchDirectory).toBeVisible()
    await expect(changesSection.getByTestId('code-file-change-row').filter({ hasText: 'scratch.log' })).toHaveCount(0)
    await scratchDirectory.click()
    const untrackedRow = untrackedGroup.getByTestId('code-file-change-row').filter({ hasText: 'scratch.log' })
    await expect(untrackedRow).toBeVisible()
    await untrackedRow.click()
    await expect(activeFileTabName(page)).toHaveText('scratch.log')
    await expect(page.getByTestId('code-file-diff-view')).toHaveCount(0)
    await expect.poll(async () => page.evaluate(() => window.__farmingFileEditorTest?.getValue() ?? '')).toBe('temporary\n')

    fs.writeFileSync(path.join(projectDir, 'scratch/scratch.log'), 'external clean refresh\n')
    await filesRefreshButton.click()
    await expect(filesRefreshButton).toHaveAttribute('data-refresh-status', 'success')
    await expect.poll(async () => page.evaluate(() => window.__farmingFileEditorTest?.getValue() ?? '')).toBe('external clean refresh\n')
    await expect(filesRefreshButton).toHaveAttribute('data-refresh-status', 'idle', { timeout: 3_000 })

    await page.evaluate(() => window.__farmingFileEditorTest?.insertText('local draft'))
    await expect.poll(async () => page.evaluate(() => window.__farmingFileEditorTest?.getValue() ?? '')).toContain('local draft')
    fs.writeFileSync(path.join(projectDir, 'scratch/scratch.log'), 'external conflicting refresh\n')
    await filesRefreshButton.click()
    await expect(filesRefreshButton).toHaveAttribute('data-refresh-status', 'success')
    await expect.poll(async () => page.evaluate(() => window.__farmingFileEditorTest?.getValue() ?? '')).toContain('local draft')
    await expect(page.getByTestId('code-file-editor').getByTitle('Changed on disk')).toBeVisible()
    await expect(filesRefreshButton).toHaveAttribute('data-refresh-status', 'idle', { timeout: 3_000 })

    const deleteDirectoryRow = filesSection.locator('[data-testid="code-file-row"][data-file-path="delete-dir"]')
    await expect(deleteDirectoryRow).toBeVisible()
    await deleteDirectoryRow.click()
    const addedDeepFileRow = filesSection.locator('[data-testid="code-file-row"][data-file-path="delete-dir/added-later.txt"]')
    fs.writeFileSync(path.join(projectDir, 'delete-dir/added-later.txt'), 'added later\n')
    await expect(addedDeepFileRow).toHaveCount(0)
    await filesRefreshButton.click()
    await expect(filesRefreshButton).toHaveAttribute('data-refresh-status', 'success')
    await expect(addedDeepFileRow).toBeVisible()
    await expect(filesRefreshButton).toHaveAttribute('data-refresh-status', 'idle', { timeout: 3_000 })

    fs.rmSync(path.join(projectDir, 'delete-dir'), { recursive: true, force: true })
    await filesRefreshButton.click()
    await expect(filesRefreshButton).toHaveAttribute('data-refresh-status', 'success')
    await expect(deleteDirectoryRow).toHaveCount(0)
  })

  test('keeps project agents expanded even when files crowd the sidebar', async ({ page, workspaceRoot }) => {
    await mockCodexSessions(page)
    const projectDir = path.join(workspaceRoot, 'compact-project-agents')
    fs.mkdirSync(projectDir, { recursive: true })
    fs.writeFileSync(path.join(projectDir, 'README.md'), 'compact agents\n')
    const agentIds = []
    for (let index = 0; index < 6; index += 1) {
      agentIds.push(await createControlAgent(page, 'bash', projectDir))
    }

    await openFarming(page)
    const projectGroupWithAgent = page.getByTestId('code-project-group').filter({ has: page.locator(`[data-agent-id="${agentIds[0]}"]`) })
    await expect(projectGroupWithAgent).toBeVisible({ timeout: 30_000 })
    const projectId = await projectGroupWithAgent.getByTestId('code-project-title').getAttribute('data-project-id')
    expect(projectId).toBeTruthy()
    const projectGroup = page.getByTestId('code-project-group').filter({
      has: page.locator(`[data-testid="code-project-title"][data-project-id="${projectId}"]`),
    })
    await expect(projectGroup).toBeVisible({ timeout: 30_000 })
    await expect(projectGroup.getByTestId('code-project-agent-strip')).toHaveCount(0)
    await expect(projectGroup.getByTestId('code-agent-row')).toHaveCount(5)
    const showMoreAgents = projectGroup.getByTestId('code-agent-show-more')
    const agentListToggle = projectGroup.getByTestId('code-agent-list-toggle')
    await expect(showMoreAgents).toBeVisible()
    await expect(showMoreAgents.locator('.code-agent-age')).toHaveText('1')
    await expect(agentListToggle).toHaveText('Collapse all')
    await expect(agentListToggle).toHaveAttribute('data-collapsed', 'false')
    const agentListControls = projectGroup.getByTestId('code-agent-list-controls')
    await expect(agentListControls).toHaveClass(/has-range-toggle/)
    const showMoreBox = await showMoreAgents.boundingBox()
    const agentListToggleBox = await agentListToggle.boundingBox()
    expect(showMoreBox).not.toBeNull()
    expect(agentListToggleBox).not.toBeNull()
    expect(Math.abs(agentListToggleBox!.y - showMoreBox!.y)).toBeLessThanOrEqual(1)
    expect(agentListToggleBox!.x).toBeGreaterThan(showMoreBox!.x)
    await showMoreAgents.click()
    await expect(projectGroup.getByTestId('code-agent-row')).toHaveCount(6)
    const showLessAgents = projectGroup.getByTestId('code-agent-show-less')
    await expect(showLessAgents).toBeVisible()
    const showLessBox = await showLessAgents.boundingBox()
    const expandedAgentListToggleBox = await agentListToggle.boundingBox()
    expect(showLessBox).not.toBeNull()
    expect(expandedAgentListToggleBox).not.toBeNull()
    expect(Math.abs(expandedAgentListToggleBox!.y - showLessBox!.y)).toBeLessThanOrEqual(1)
    await showLessAgents.click()
    await expect(projectGroup.getByTestId('code-agent-row')).toHaveCount(5)
    await expect(showMoreAgents).toBeVisible()
    await agentListToggle.click()
    await expect(projectGroup.getByTestId('code-agent-row')).toHaveCount(0)
    await expect(showMoreAgents).toHaveCount(0)
    await expect(agentListToggle.locator('.code-agent-name')).toHaveText('Show agents')
    await expect(agentListToggle.locator('.code-agent-list-count')).toHaveText('6')
    await expect(agentListToggle).toHaveAttribute('data-collapsed', 'true')
    await expect(agentListToggle).toBeFocused()
    await expect(projectGroup.locator('.code-files-title').first()).toBeVisible()
    await agentListToggle.click()
    await expect(projectGroup.getByTestId('code-agent-row')).toHaveCount(5)
    await expect(showMoreAgents).toBeVisible()
    await expect(agentListToggle).toBeFocused()
    await showMoreAgents.click()
    await expect(projectGroup.getByTestId('code-agent-row')).toHaveCount(6)
    await expect(projectGroup.getByTestId('code-agent-show-less')).toBeVisible()

    const filesTitle = projectGroup.locator('.code-files-title').first()
    await expect(filesTitle).toHaveAttribute('aria-expanded', 'false')
    await filesTitle.click()
    await expect(filesTitle).toHaveAttribute('aria-expanded', 'true')
    await projectGroup.getByTestId('code-files-section').evaluate(node => {
      ;(node as HTMLElement).style.minHeight = '380px'
    })
    await expect(projectGroup.getByTestId('code-project-agent-strip')).toHaveCount(0)
    await expect(projectGroup.getByTestId('code-agent-row')).toHaveCount(6)
    const selectedAgentRow = projectGroup.getByTestId('code-agent-row').nth(2)
    const selectedAgentId = await selectedAgentRow.getAttribute('data-agent-id')
    expect(selectedAgentId).toBeTruthy()
    expect(agentIds).toContain(selectedAgentId)
    await selectedAgentRow.click()
    await expect(page.locator(`[data-testid="code-terminal-pane"][data-agent-id="${selectedAgentId}"]`)).toBeVisible()
  })

  test('keeps previous Main Agent resume out of the normal New Agent flow', async ({ page }) => {
    const mainSessionId = '019f1111-2222-7333-8444-555555555555'
    const mainWorkspace = path.join(process.env.HOME || '/home/farming-user', '.farming')
    await mockCodexSessions(page, [{
      id: mainSessionId,
      title: 'Previous Main Agent',
      cwd: mainWorkspace,
      workspace: mainWorkspace,
      updatedAt: new Date().toISOString(),
      createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      archived: true,
      pinned: false,
      unread: false,
      projectless: false,
      model: 'gpt-5.5',
      effort: 'xhigh',
      source: 'codex',
    }])

    let resumeRequest: { asMain?: boolean } | null = null
    let resumedSessionId = ''
    await page.route(/\/farming\/api\/agent-sessions\/codex\/[^/]+\/resume$/, async route => {
      const match = route.request().url().match(/\/agent-sessions\/codex\/([^/]+)\/resume$/)
      resumedSessionId = match ? decodeURIComponent(match[1]) : ''
      resumeRequest = route.request().postDataJSON() as { asMain?: boolean }
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ agentId: 'resumed-main-agent' }),
      })
    })

    await openFarming(page)
    await expect(page.getByTestId('input-dialog')).toBeHidden()
    await openNewAgentDialog(page)
    await expect(page.getByTestId('input-dialog')).toBeVisible()
    await expect(page.getByTestId('main-agent-resume-toggle')).toHaveCount(0)
    await expect(page.getByTestId('main-agent-resume-option')).toHaveCount(0)
    await expect(page.getByTestId('agent-option-codex')).toBeFocused()

    await page.getByTestId('agent-option-codex').click()
    await expect(page.getByTestId('workspace-step')).toBeVisible()
    expect(resumedSessionId).toBe('')
    expect(resumeRequest).toBeNull()
  })

  test('persists every Project until Remove and mounts sibling worktrees from the Git list', async ({ page, workspaceRoot }) => {
    const repo = path.join(workspaceRoot, 'base-repo')
    const linkedWorkspace = path.join(workspaceRoot, 'linked-project')
    fs.mkdirSync(repo, { recursive: true })
    fs.writeFileSync(path.join(repo, 'README.md'), '# linked worktree\n')
    execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore' })
    execFileSync('git', ['config', 'user.email', 'farming-e2e@example.test'], { cwd: repo })
    execFileSync('git', ['config', 'user.name', 'Farming E2E'], { cwd: repo })
    execFileSync('git', ['add', 'README.md'], { cwd: repo, stdio: 'ignore' })
    execFileSync('git', ['commit', '-m', 'seed linked worktree'], { cwd: repo, stdio: 'ignore' })
    execFileSync('git', ['worktree', 'add', '-b', 'feature/topic', linkedWorkspace], { cwd: repo, stdio: 'ignore' })

    await openFarming(page)
    await openNewAgentDialog(page)
    const agentId = await startAgentFromOpenDialog(page, 'bash', linkedWorkspace)
    const project = page.getByTestId('code-project-group').filter({ hasText: 'linked-project' })
    await expect(project).toHaveCount(1)
    await expect(project.locator('.code-project-worktree')).toContainText('feature/topic', { timeout: 30_000 })
    await expect(project.locator('.code-project-worktree-count')).toHaveText('2')
    await project.getByTestId('code-project-worktree').click()
    const worktreeMenu = page.getByTestId('code-project-worktree-menu')
    await expect(worktreeMenu).toBeVisible()
    await expect(worktreeMenu.locator('.code-worktree-row')).toHaveCount(2)
    await expect(worktreeMenu.locator('.code-worktree-row[data-current="true"]')).toContainText('feature/topic')
    await expect(worktreeMenu.locator('.code-worktree-row[data-main="true"] .code-worktree-row-path')).toContainText('base-repo')
    await worktreeMenu.locator('.code-worktree-row[data-main="true"]').click()

    const mainProject = page.getByTestId('code-project-group').filter({ hasText: 'base-repo' })
    await expect(mainProject).toHaveCount(1)
    await mainProject.getByTestId('code-project-actions').click()
    const mainProjectRemove = page.getByTestId('code-project-context-menu').getByRole('menuitem', { name: 'Remove Project' })
    await expect(mainProjectRemove.locator('svg')).toHaveCount(1)
    await expect(mainProjectRemove).not.toHaveClass(/danger/)
    await mainProjectRemove.click()
    await expect(mainProject).toHaveCount(0)

    const files = project.getByTestId('code-files-section')
    const filesTitle = files.locator('.code-files-title').first()
    await filesTitle.click()
    const readme = files.locator('[data-testid="code-file-row"][data-file-path="README.md"]')
    await expect(readme).toBeVisible()
    await readme.click()
    await expect(activeFileTabName(page)).toHaveText('README.md')

    const deleteResponse = await page.request.delete(`/farming/api/control/agents/${agentId}`)
    expect(deleteResponse.ok()).toBeTruthy()
    await expect(project.getByTestId('code-agent-row')).toHaveCount(0)
    await expect(project).toHaveCount(1)
    await expect(project.getByTestId('code-open-editors')).toBeVisible()

    await page.getByTestId('code-file-editor').getByRole('button', { name: 'Close README.md' }).click()
    await expect(project).toHaveCount(1)

    await project.getByTestId('code-project-actions').click()
    const projectMenu = page.getByTestId('code-project-context-menu')
    await expect(projectMenu.getByRole('menuitem', { name: 'Remove Project' })).toBeEnabled()
    await projectMenu.getByRole('menuitem', { name: 'Remove Project' }).click()
    await expect(project).toHaveCount(0)

    const permanentWorkspace = path.join(workspaceRoot, 'base-repo-farming-fork-20260718-140000')
    execFileSync('git', ['worktree', 'add', permanentWorkspace, 'HEAD'], { cwd: repo, stdio: 'ignore' })
    await openNewAgentDialog(page)
    await startAgentFromOpenDialog(page, 'bash', permanentWorkspace)
    const permanentProject = page.getByTestId('code-project-group').filter({ hasText: 'base-repo-farming-fork-20260718-140000' })
    await expect(permanentProject).toHaveCount(1)
    await permanentProject.getByTestId('code-project-actions').click()
    const permanentDelete = page.getByTestId('code-project-context-menu').getByRole('menuitem', { name: 'Permanently Delete Worktree' })
    await expect(permanentDelete).toHaveClass(/danger/)
    await expect(permanentDelete.locator('svg')).toHaveCount(1)
    await permanentDelete.click()
    await expect(page.getByTestId('code-delete-worktree-dialog')).toBeVisible()
    await page.getByTestId('code-delete-worktree-dialog').getByRole('button', { name: 'Cancel' }).click()
    await expect(page.getByTestId('code-delete-worktree-dialog')).toBeHidden()

    await permanentProject.getByTestId('code-project-actions').click()
    await page.getByTestId('code-project-context-menu').getByRole('menuitem', { name: 'Permanently Delete Worktree' }).click()
    await page.getByTestId('code-delete-worktree-dialog').getByRole('button', { name: 'Permanently Delete' }).click()
    await expect(permanentProject).toHaveCount(0)
    expect(fs.existsSync(permanentWorkspace)).toBeFalsy()
  })

  test('keeps project files as a collapsible project-level section', async ({ page }) => {
    await mockCodexSessions(page)
    const shortWorkspaceRoot = path.join('/tmp', `farming-files-${process.pid}`)
    fs.rmSync(shortWorkspaceRoot, { recursive: true, force: true })
    const childWorkspace = path.join(shortWorkspaceRoot, 'child-files')
    const deepInnerWorkspace = path.join(childWorkspace, 'deep', 'nested', 'inner')
    const requestDedupeWorkspace = path.join(childWorkspace, 'request-dedupe')
    const directorySearchWorkspace = path.join(childWorkspace, 'poem')
    const nestedDirectorySearchWorkspace = path.join(childWorkspace, 'reference', 'poem')
    fs.mkdirSync(deepInnerWorkspace, { recursive: true })
    fs.mkdirSync(requestDedupeWorkspace, { recursive: true })
    fs.mkdirSync(directorySearchWorkspace, { recursive: true })
    fs.mkdirSync(nestedDirectorySearchWorkspace, { recursive: true })
    const readmePath = path.join(childWorkspace, 'README.md')
    fs.writeFileSync(
      readmePath,
      [
        '# Child files',
        'plain context line',
        'search-target-omega',
        'jump-target-line',
        '',
      ].join('\n'),
    )
    fs.writeFileSync(path.join(childWorkspace, 'rename-me.txt'), 'rename me\n')
    fs.writeFileSync(path.join(childWorkspace, 'delete-me.txt'), 'delete me\n')
    fs.writeFileSync(path.join(childWorkspace, 'query.sql'), 'select 1;\n')
    fs.writeFileSync(path.join(childWorkspace, 'analysis.ipynb'), '{}\n')
    fs.writeFileSync(path.join(childWorkspace, 'binary.bin'), Buffer.from([0, 1, 2, 3, 0]))
    fs.writeFileSync(path.join(childWorkspace, 'large.log'), `${'large text line\n'.repeat(80_000)}`)
    fs.writeFileSync(path.join(requestDedupeWorkspace, 'first.txt'), 'first\n')
    fs.writeFileSync(path.join(requestDedupeWorkspace, 'second.txt'), 'second\n')
    fs.writeFileSync(path.join(directorySearchWorkspace, 'collection.zip'), 'zip payload\n')
    fs.writeFileSync(path.join(childWorkspace, 'reference', 'notes.txt'), 'reference notes\n')
    fs.writeFileSync(path.join(nestedDirectorySearchWorkspace, 'hidden.txt'), 'hidden poem\n')
    fs.writeFileSync(path.join(childWorkspace, 'preview.png'), Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgF/2l2fLwAAAABJRU5ErkJggg==',
      'base64',
    ))
    fs.writeFileSync(
      path.join(childWorkspace, 'icon.svg'),
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="12"/></svg>\n',
    )
    execFileSync('git', ['init'], { cwd: childWorkspace, stdio: 'ignore' })
    execFileSync('git', ['config', 'user.email', 'farming-e2e@example.test'], { cwd: childWorkspace })
    execFileSync('git', ['config', 'user.name', 'Farming E2E'], { cwd: childWorkspace })
    execFileSync('git', ['add', 'README.md'], { cwd: childWorkspace, stdio: 'ignore' })
    execFileSync('git', ['commit', '-m', 'Seed README blame'], { cwd: childWorkspace, stdio: 'ignore' })
    fs.writeFileSync(
      path.join(deepInnerWorkspace, 'blame-multi.py'),
      ['print("alpha")', 'print("beta")', ''].join('\n'),
    )
    execFileSync('git', ['add', 'deep/nested/inner/blame-multi.py'], { cwd: childWorkspace, stdio: 'ignore' })
    execFileSync('git', ['commit', '-m', 'Seed multi blame'], { cwd: childWorkspace, stdio: 'ignore' })
    fs.writeFileSync(
      path.join(deepInnerWorkspace, 'blame-multi.py'),
      ['print("alpha")', 'print("gamma")', ''].join('\n'),
    )
    execFileSync('git', ['add', 'deep/nested/inner/blame-multi.py'], { cwd: childWorkspace, stdio: 'ignore' })
    execFileSync('git', ['commit', '-m', 'Change multi blame line'], { cwd: childWorkspace, stdio: 'ignore' })
    for (let index = 0; index < 40; index += 1) {
      fs.writeFileSync(
        path.join(deepInnerWorkspace, `file-${String(index).padStart(2, '0')}.txt`),
        `deep file ${index}\n`,
      )
    }

    await openFarming(page)
    await expect(page.getByTestId('code-agent-row')).toHaveCount(0)

    await openNewAgentDialog(page)
    await startAgentFromOpenDialog(page, 'bash', childWorkspace)

    const projectGroups = page.getByTestId('code-project-group')
    const mainProject = projectGroups.filter({ hasText: 'Main Agent' })
    const childProject = projectGroups.filter({ hasText: 'child-files' })
    await expect(mainProject).toHaveCount(0)
    await expect(childProject).toHaveCount(1, { timeout: 30_000 })
    const childFiles = childProject.getByTestId('code-files-section')
    await expect(childFiles).toHaveCount(1)
    const childProjectTitle = childProject.getByTestId('code-project-title')
    const childAgentRow = childProject.getByTestId('code-agent-row')
    const childAgentId = await childAgentRow.getAttribute('data-agent-id')
    if (!childAgentId) {
      throw new Error('Child agent row is missing data-agent-id')
    }
    const currentChildAgentItem = () => childProject.locator(`[data-testid="code-agent-row"][data-agent-id="${childAgentId}"], [data-testid="code-project-agent-compact"][data-agent-id="${childAgentId}"]`)
    const filesTitle = childFiles.locator('.code-files-title').first()
    const childProjectTitleText = childProjectTitle.locator('.code-project-title-name')
    const filesTitleText = filesTitle.locator('span:last-child')
    const projectTitleBox = await childProjectTitle.boundingBox()
    const projectTitleTextBox = await childProjectTitleText.boundingBox()
    const agentRowBox = await childAgentRow.boundingBox()
    const filesSectionBox = await childFiles.boundingBox()
    const filesTitleBox = await filesTitle.boundingBox()
    const filesTitleTextBox = await filesTitleText.boundingBox()
    if (!projectTitleBox || !projectTitleTextBox || !agentRowBox || !filesSectionBox || !filesTitleBox || !filesTitleTextBox) {
      throw new Error('Project files layout boxes are missing')
	    }
	    expect(filesSectionBox.x).toBeGreaterThan(projectTitleBox.x)
	    expect(filesSectionBox.x).toBeLessThanOrEqual(agentRowBox.x)
	    expect(filesTitleBox.x).toBeGreaterThan(projectTitleBox.x)
    expect(filesTitleTextBox.x).toBeGreaterThan(projectTitleTextBox.x + 4)

    await expect(filesTitle).toHaveAttribute('aria-expanded', 'false')
    await expect(childProject.getByTestId('code-open-editors')).toHaveCount(0)
    await expect(childFiles.getByPlaceholder('Search or path:line')).toHaveCount(0)
    await expect(childFiles.getByTestId('code-file-row')).toHaveCount(0)

    await writeTerminalFixture(page, childAgentId, '$ npm test\r\nREADME.md:4:1 failed\r\n$ ')
    const pathRows = await terminalRows(page, childAgentId)
    const terminalPathRow = pathRows.findIndex(row => row.includes('README.md:4:1'))
    const terminalPathCol = terminalPathRow >= 0 ? pathRows[terminalPathRow].indexOf('README.md') + 2 : -1
    if (terminalPathRow < 0 || terminalPathCol < 0) {
      throw new Error(`Terminal path fixture row is missing: ${JSON.stringify(pathRows)}`)
    }
    const terminalPathCell = await page.evaluate(({ agentId, col, row }) => {
      return window.__farmingTerminalTest?.getCellCenter(agentId, col, row) ?? null
    }, { agentId: childAgentId, col: terminalPathCol, row: terminalPathRow })
    if (!terminalPathCell) {
      throw new Error('Terminal path fixture cell is missing')
    }
    await expect.poll(async () => page.evaluate(({ agentId, col, row }) => (
      window.__farmingTerminalTest?.getPathAtCell(agentId, col, row)?.path ?? null
    ), { agentId: childAgentId, col: terminalPathCol, row: terminalPathRow })).toBe('README.md')
    await page.mouse.click(terminalPathCell.x, terminalPathCell.y)
    await expect(page.getByTestId('code-file-editor')).toBeVisible()
    await expect(activeFileTabName(page)).toHaveText('README.md')
    await expect(page.getByTestId('code-file-editor').getByRole('tab').filter({ hasText: 'README.md' })).toHaveCount(1)
    await expect(page.getByTestId('code-file-editor-statusbar')).toContainText('Ln 4, Col 1')
    const openEditors = childProject.getByTestId('code-open-editors')
    await expect(openEditors).toBeVisible()
    const openEditorsTitle = openEditors.locator('.code-open-editors-title')
    await expect(openEditorsTitle).toHaveAttribute('aria-expanded', 'false')
    await expect(openEditors.getByTestId('code-open-editor-row')).toHaveCount(0)
    const openEditorsBox = await openEditors.boundingBox()
    const filesSectionBoxAfterOpen = await childFiles.boundingBox()
    if (!openEditorsBox || !filesSectionBoxAfterOpen) {
      throw new Error('Open Editors layout boxes are missing')
    }
    expect(openEditorsBox.y).toBeGreaterThan(agentRowBox.y)
    expect(filesSectionBoxAfterOpen.y).toBeGreaterThan(openEditorsBox.y)
    await openEditorsTitle.click()
    await expect(openEditorsTitle).toHaveAttribute('aria-expanded', 'true')
    const readmeOpenEditorRow = openEditors.getByTestId('code-open-editor-row').filter({ hasText: 'README.md' })
	    await expect(readmeOpenEditorRow).toBeVisible()
	    await page.getByTestId('code-file-editor-back').click()
	    await expect(page.getByTestId('code-terminal-grid')).toBeVisible()
	    const projectScrollTopBeforeOpenEditorSelect = await childProject.evaluate(element => {
	      const scroller = element.closest('.code-project-list') as HTMLElement | null
	      return scroller?.scrollTop ?? 0
	    })
	    await readmeOpenEditorRow.getByRole('button').first().click()
	    await expect(page.getByTestId('code-file-editor')).toBeVisible()
	    await expect(activeFileTabName(page)).toHaveText('README.md')
	    await expect(openEditorsTitle).toHaveAttribute('aria-expanded', 'true')
	    const projectScrollTopAfterOpenEditorSelect = await childProject.evaluate(element => {
	      const scroller = element.closest('.code-project-list') as HTMLElement | null
	      return scroller?.scrollTop ?? 0
	    })
	    expect(Math.abs(projectScrollTopAfterOpenEditorSelect - projectScrollTopBeforeOpenEditorSelect)).toBeLessThanOrEqual(4)

	    await page.getByTestId('code-file-editor-back').click()
    await expect(page.getByTestId('code-terminal-grid')).toBeVisible()
    const absoluteReadmePath = path.join(childWorkspace, 'README.md')
    await writeTerminalFixture(page, childAgentId, `$ eslint\r\n${absoluteReadmePath}:3:1 failed\r\n$ `)
    const absolutePathRows = await terminalRows(page, childAgentId)
    const absolutePathHit = absolutePathRows
      .map((row, rowIndex) => {
        const match = /[A-Za-z.]*md:3:1/.exec(row)
        return match ? { row: rowIndex, col: match.index + Math.min(2, Math.max(0, match[0].length - 1)) } : null
      })
      .find((hit): hit is { row: number; col: number } => Boolean(hit))
    if (!absolutePathHit) {
      throw new Error(`Absolute terminal path fixture row is missing: ${JSON.stringify(absolutePathRows)}`)
    }
    const absolutePathCell = await page.evaluate(({ agentId, col, row }) => {
      return window.__farmingTerminalTest?.getCellCenter(agentId, col, row) ?? null
    }, { agentId: childAgentId, col: absolutePathHit.col, row: absolutePathHit.row })
    if (!absolutePathCell) {
      throw new Error('Absolute terminal path fixture cell is missing')
    }
    await expect.poll(async () => page.evaluate(({ agentId, col, row }) => (
      window.__farmingTerminalTest?.getPathAtCell(agentId, col, row)?.path ?? null
    ), { agentId: childAgentId, col: absolutePathHit.col, row: absolutePathHit.row })).toContain('README.md')
    await page.mouse.click(absolutePathCell.x, absolutePathCell.y)
    await expect(page.getByTestId('code-file-editor')).toBeVisible()
    await expect(activeFileTabName(page)).toHaveText('README.md')
    await expect(page.getByTestId('code-file-editor').getByRole('tab').filter({ hasText: 'README.md' })).toHaveCount(1)
    await expect(page.getByTestId('code-file-editor-statusbar')).toContainText('Ln 3, Col 1')

    await page.getByTestId('code-file-editor-back').click()
    await expect(page.getByTestId('code-terminal-grid')).toBeVisible()
    const reviewUrl = 'https://code.example.test/maxcompute/odps_src/codereview/28643213'
    await page.evaluate(() => {
      ;(window as any).__originalOpenForTerminalUrlTest = window.open
      ;(window as any).__openedTerminalUrls = []
      window.open = ((url?: string | URL) => {
        ;(window as any).__openedTerminalUrls.push(String(url ?? ''))
        return null
      }) as typeof window.open
    })
    await writeTerminalFixture(page, childAgentId, `$ echo link\r\n(${reviewUrl})\r\n$ `)
    const findParsedReviewUrlHit = async () => {
      const reviewRows = await terminalRows(page, childAgentId)
      for (let rowIndex = 0; rowIndex < reviewRows.length; rowIndex += 1) {
        const row = reviewRows[rowIndex] || ''
        for (const fragment of ['https://', 'code.example.test', 'odps_src', 'codereview/28643213']) {
          const col = row.indexOf(fragment)
          if (col < 0) continue
          const parsed = await page.evaluate(({ id, x, y }) => {
            return window.__farmingTerminalTest?.getUrlAtCell(id, x, y) ?? null
          }, { id: childAgentId, x: col + Math.min(2, fragment.length - 1), y: rowIndex })
          if (parsed === reviewUrl) {
            return { row: rowIndex, col: col + Math.min(2, fragment.length - 1) }
          }
        }
      }
      return null
    }
    await expect.poll(async () => Boolean(await findParsedReviewUrlHit())).toBe(true)
    const reviewHit = await findParsedReviewUrlHit()
    if (!reviewHit) {
      const reviewRows = await terminalRows(page, childAgentId)
      throw new Error(`Terminal URL fixture row is missing: ${JSON.stringify(reviewRows)}`)
    }
    const reviewUrlCell = await page.evaluate(({ agentId, col, row }) => {
      return window.__farmingTerminalTest?.getCellCenter(agentId, col, row) ?? null
    }, { agentId: childAgentId, col: reviewHit.col, row: reviewHit.row })
    if (!reviewUrlCell) {
      throw new Error('Terminal URL fixture cell is missing')
    }
    await page.waitForTimeout(300)
    await page.mouse.move(reviewUrlCell.x, reviewUrlCell.y)
    await expect.poll(() => page.evaluate(
      id => window.__farmingTerminalTest?.getBufferDiagnostics(id)?.renderer,
      childAgentId,
    )).toBe('webgl')
    await page.mouse.click(reviewUrlCell.x, reviewUrlCell.y)
    await expect.poll(async () => page.evaluate(() => (window as any).__openedTerminalUrls ?? [])).toHaveLength(0)
    await modifierClick(page, childAgentId, reviewUrlCell.x, reviewUrlCell.y)
    await expect.poll(async () => page.evaluate(() => (window as any).__openedTerminalUrls ?? [])).toContain(reviewUrl)
    await page.evaluate(() => {
      window.open = (window as any).__originalOpenForTerminalUrlTest
    })
    await expect(page.getByTestId('code-terminal-grid')).toBeVisible()

    if (await filesTitle.getAttribute('aria-expanded') !== 'true') {
      await filesTitle.click()
    }
    await expect(filesTitle).toHaveAttribute('aria-expanded', 'true')
    const fileSearchInput = childFiles.getByPlaceholder('Search or path:line')
    const fileTreeRequests: string[] = []
    page.on('request', request => {
      const url = request.url()
      if (!url.includes('/api/files/tree')) return
      fileTreeRequests.push(new URL(url).searchParams.get('path') ?? '')
    })
    const requestDedupeRow = childFiles.locator('[data-testid="code-file-row"][data-file-path="request-dedupe"]')
    await expect(requestDedupeRow).toBeVisible()
    await requestDedupeRow.click()
    await expect(requestDedupeRow).toHaveAttribute('aria-expanded', 'true')
    await expect(childFiles.locator('[data-testid="code-file-row"][data-file-path="request-dedupe/first.txt"]')).toBeVisible()
    await requestDedupeRow.evaluate(row => {
      const directoryRow = row as HTMLElement
      directoryRow.click()
      directoryRow.click()
    })
    await expect(requestDedupeRow).toHaveAttribute('aria-expanded', 'true')
    await page.waitForTimeout(100)
    expect(fileTreeRequests.filter(requestPath => requestPath === 'request-dedupe')).toHaveLength(1)
    await fileSearchInput.fill('poem')
    const folderSearchResults = childFiles.getByTestId('code-file-search-results')
    const poemDirectoryResult = folderSearchResults.locator('.code-file-search-result[title="poem"]')
    await expect(poemDirectoryResult).toBeVisible()
    await expect(poemDirectoryResult).toContainText('Folder')
    await expect(folderSearchResults.locator('.code-file-search-result[title="poem/collection.zip:1"]')).toHaveCount(0)
    await poemDirectoryResult.click()
    await expect(fileSearchInput).toHaveValue('')
    const poemRow = childFiles.locator('[data-testid="code-file-row"][data-file-path="poem"]')
    await expect(poemRow).toBeVisible()
    await expect(poemRow).toHaveAttribute('aria-expanded', 'true')
    await expect(childFiles.locator('[data-testid="code-file-row"][data-file-path="poem/collection.zip"]')).toBeVisible()
    await fileSearchInput.fill('reference/poem')
    const nestedPoemDirectoryResult = folderSearchResults.locator('.code-file-search-result[title="reference/poem"]')
    await expect(nestedPoemDirectoryResult).toBeVisible()
    await expect(nestedPoemDirectoryResult).toContainText('Folder')
    await nestedPoemDirectoryResult.click()
    await expect(fileSearchInput).toHaveValue('')
    const referenceRow = childFiles.locator('[data-testid="code-file-row"][data-file-path="reference"]')
    await expect(referenceRow).toBeVisible()
    await expect(referenceRow).toHaveAttribute('aria-expanded', 'true')
    const nestedPoemRow = childFiles.locator('[data-testid="code-file-row"][data-file-path="reference/poem"]')
    await expect(nestedPoemRow).toBeVisible()
    await expect(nestedPoemRow).toHaveAttribute('aria-expanded', 'true')
    await expect(childFiles.locator('[data-testid="code-file-row"][data-file-path="reference/poem/hidden.txt"]')).toBeVisible()
    await expect(page.getByTestId('code-terminal-grid')).toBeVisible()
    await expect(page.getByTestId('code-file-editor').getByRole('tab').filter({ hasText: 'collection.zip' })).toHaveCount(0)
    await nestedPoemRow.click()
    await expect(nestedPoemRow).toHaveAttribute('aria-expanded', 'false')
    await expect(childFiles.locator('[data-testid="code-file-row"][data-file-path="reference/poem/hidden.txt"]')).toHaveCount(0)
    await writeTerminalFixture(page, childAgentId, '$ ls reference/poem\r\nreference/poem\r\n$ ')
    const directoryPathRows = await terminalRows(page, childAgentId)
    const directoryPathRow = directoryPathRows.findIndex(row => row.includes('reference/poem'))
    const directoryPathCol = directoryPathRow >= 0 ? directoryPathRows[directoryPathRow].indexOf('reference/poem') + 2 : -1
    if (directoryPathRow < 0 || directoryPathCol < 0) {
      throw new Error(`Terminal directory path fixture row is missing: ${JSON.stringify(directoryPathRows)}`)
    }
    const directoryPathCell = await page.evaluate(({ agentId, col, row }) => {
      return window.__farmingTerminalTest?.getCellCenter(agentId, col, row) ?? null
    }, { agentId: childAgentId, col: directoryPathCol, row: directoryPathRow })
    if (!directoryPathCell) {
      throw new Error('Terminal directory path fixture cell is missing')
    }
    await expect.poll(async () => page.evaluate(({ agentId, col, row }) => (
      window.__farmingTerminalTest?.getPathAtCell(agentId, col, row)?.path ?? null
    ), { agentId: childAgentId, col: directoryPathCol, row: directoryPathRow })).toBe('reference/poem')
    await page.mouse.click(directoryPathCell.x, directoryPathCell.y)
    await expect(page.getByTestId('code-terminal-grid')).toBeVisible()
    await expect(page.getByTestId('code-file-editor').getByRole('tab').filter({ hasText: 'hidden.txt' })).toHaveCount(0)
    await expect(nestedPoemRow).toBeVisible()
    await expect(nestedPoemRow).toHaveAttribute('aria-expanded', 'true')
    await expect(childFiles.locator('[data-testid="code-file-row"][data-file-path="reference/poem/hidden.txt"]')).toBeVisible()
    const deepRow = childFiles.locator('[data-testid="code-file-row"][data-file-path="deep"]')
    const fileTree = childFiles.locator('.code-file-tree')
    await expect(deepRow).toBeVisible()
    await expect(deepRow.locator('.code-file-name')).toHaveText('deep')
    const sqlIconSrc = await childFiles
      .locator('[data-testid="code-file-row"][data-file-path="query.sql"] .code-file-type-icon.file')
      .getAttribute('src')
    const notebookIconSrc = await childFiles
      .locator('[data-testid="code-file-row"][data-file-path="analysis.ipynb"] .code-file-type-icon.file')
      .getAttribute('src')
    expect(sqlIconSrc).toContain('/vendor/material-icons/database.svg')
    expect(notebookIconSrc).toContain('/vendor/material-icons/jupyter.svg')
    const previewRow = childFiles.locator('[data-testid="code-file-row"][data-file-path="preview.png"]')
    await previewRow.dblclick()
    await expect(activeFileTabName(page)).toHaveText('preview.png')
    await expect(page.getByTestId('code-file-preview-panel')).toBeVisible()
    await expect(page.getByTestId('code-file-image-preview')).toHaveAttribute('src', /\/api\/files\/raw\?.*path=preview\.png/)
    await expect(page.getByTestId('code-file-editor-statusbar')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Open File Diff' })).toHaveCount(0)
    const svgRow = childFiles.locator('[data-testid="code-file-row"][data-file-path="icon.svg"]')
    await svgRow.dblclick()
    await expect(activeFileTabName(page)).toHaveText('icon.svg')
    await expect(page.getByTestId('code-file-preview-panel')).toBeVisible()
    await expect(page.getByTestId('code-file-image-preview')).toHaveAttribute('src', /\/api\/files\/raw\?.*path=icon\.svg/)
    await page.getByRole('button', { name: 'Show source' }).click()
    await expect(page.getByTestId('code-file-monaco')).toBeVisible()
    await expect(page.getByTestId('code-file-editor-statusbar')).toBeVisible()
    await page.getByRole('button', { name: 'Open preview' }).click()
    await expect(page.getByTestId('code-file-preview-panel')).toBeVisible()
    await expect(page.getByTestId('code-file-image-preview')).toHaveAttribute('src', /\/api\/files\/raw\?.*path=icon\.svg/)
    await expect(page.getByTestId('code-file-editor-statusbar')).toHaveCount(0)
    await page.getByRole('button', { name: 'Show source' }).click()
    await expect(page.getByTestId('code-file-monaco')).toBeVisible()
    await expect(page.getByTestId('code-file-editor-statusbar')).toBeVisible()
    const binaryRow = childFiles.locator('[data-testid="code-file-row"][data-file-path="binary.bin"]')
    await binaryRow.dblclick()
    await expect(activeFileTabName(page)).toHaveText('binary.bin')
    await expect(page.getByTestId('code-file-preview-panel')).toBeVisible()
    await expect(page.getByTestId('code-file-metadata-preview-icon')).toBeVisible()
    await expect(childFiles.getByTestId('code-file-open-error')).toHaveCount(0)
    await expect(page.getByTestId('code-file-editor-statusbar')).toHaveCount(0)
    const largeRow = childFiles.locator('[data-testid="code-file-row"][data-file-path="large.log"]')
    await largeRow.dblclick()
    await expect(activeFileTabName(page)).toHaveText('large.log')
    await expect(page.getByTestId('code-file-preview-panel')).toHaveCount(0)
    await expect(page.getByTestId('code-file-monaco')).toBeVisible()
    await expect.poll(async () => page.evaluate(() => window.__farmingFileEditorTest?.getValue() ?? '')).toContain('large text line')
    await expect(childFiles.getByTestId('code-file-open-error')).toHaveCount(0)
    await expect(page.getByTestId('code-file-editor-statusbar')).toContainText('Ln 1, Col 1')
    await expect.poll(async () => childFiles.locator('.code-file-tree-viewport').evaluate(viewport => {
      const tree = viewport.querySelector<HTMLElement>('.code-file-tree')
      if (!tree) return false
      const rowCount = viewport.querySelectorAll('[data-testid="code-file-row"]').length
      const treeStyle = getComputedStyle(tree)
      const viewportStyle = getComputedStyle(viewport)
      return rowCount > 0 &&
        treeStyle.overflowY === 'visible' &&
        viewportStyle.overflowY === 'visible' &&
        tree.scrollHeight <= tree.clientHeight + 1 &&
        viewport.scrollHeight <= viewport.clientHeight + 1 &&
        Math.abs(tree.clientHeight - rowCount * 24) <= 4 &&
        Math.abs(viewport.clientHeight - rowCount * 24) <= 4
    })).toBe(true)
    fs.writeFileSync(
      path.join(deepInnerWorkspace, 'file-00.txt'),
      `deep file watch ${Date.now()}\n`,
    )

    await currentChildAgentItem().focus()
    await page.keyboard.press('Control+P')
    await expect(fileSearchInput).toBeFocused()
    await fileSearchInput.fill('search-target-omega')
    await page.keyboard.press('Escape')
    await expect(fileSearchInput).toHaveValue('')
    await expect.poll(async () => childFiles.locator('.code-file-tree-viewport').evaluate(element => element.contains(document.activeElement))).toBe(true)
    await page.keyboard.press('Control+P')
    await expect(fileSearchInput).toBeVisible()
    await fileSearchInput.click()
    await fileSearchInput.fill('README.md:4')
    await expect(fileSearchInput).toHaveValue('README.md:4')
    const readmeJumpResult = childFiles.locator('.code-file-search-result.jump')
    await expect(readmeJumpResult).toBeVisible()
    await readmeJumpResult.click()
    await expect(page.getByTestId('code-file-editor')).toBeVisible()
    await expect(activeFileTabName(page)).toHaveText('README.md')
    await expect(page.getByRole('button', { name: 'Show Markdown source' })).toBeVisible()
    await page.getByRole('button', { name: 'Show Markdown source' }).click()
    await expect(page.getByTestId('code-file-monaco')).toBeVisible()
    await expect(page.getByTestId('code-file-editor-statusbar')).toContainText('Ln 4, Col 1')
    await page.getByTestId('code-file-monaco').click()
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+P' : 'Control+P')
    await expect(fileSearchInput).toBeFocused()
    await expect(page.getByTestId('code-file-blame-panel')).toHaveCount(0)
    const editorContextMenu = page.getByTestId('code-editor-context-menu')
    await page.getByTestId('code-file-monaco').click({ button: 'right', position: { x: 42, y: 38 } })
    await expect(editorContextMenu).toBeVisible()
    await editorContextMenu.getByRole('menuitem', { name: 'Annotate with Blame' }).click()
    const inlineBlame = page.locator('.code-file-inline-blame')
    await expect(inlineBlame).toHaveCount(4)
    await expect(inlineBlame.nth(0)).toContainText('Farming E2E')
    await inlineBlame.nth(0).click()
    const blameDetail = page.getByTestId('code-file-blame-detail')
    await expect(blameDetail).toContainText('Seed README blame')
    await expect(blameDetail.getByRole('link', { name: 'Farming E2E' })).toBeVisible()
    await expect(blameDetail.getByRole('button', { name: 'Close blame details' })).toBeVisible()
    await expect(page.getByTestId('code-file-editor-statusbar')).not.toContainText('Seed README blame')
    await page.evaluate(() => {
      const ok = window.__farmingFileEditorTest?.insertText('\nlocal unsaved edit')
      if (!ok) throw new Error('Failed to dirty README.md before conflict save')
    })
    await expect.poll(async () => page.evaluate(() => window.__farmingFileEditorTest?.getValue() ?? ''))
      .toContain('local unsaved edit')
    fs.writeFileSync(
      path.join(childWorkspace, 'README.md'),
      [
        '# Child files',
        'plain context line',
        'search-target-omega',
        'jump-target-line',
        'blame reload refresh marker',
        '',
      ].join('\n'),
    )
    const changedTime = new Date(Date.now() + 2000)
    fs.utimesSync(readmePath, changedTime, changedTime)
    await expect(page.getByRole('button', { name: 'Save file' })).toBeVisible()
    await page.getByRole('button', { name: 'Save file' }).click()
    await expect(page.getByRole('button', { name: 'Reload file' })).toBeVisible()
    await page.getByRole('button', { name: 'Reload file' }).click()
    await expect(page.getByRole('button', { name: 'Reload file' })).toHaveCount(0)
    await expect(page.locator('.code-file-inline-blame.uncommitted')).toBeVisible()
    await page.getByTestId('code-file-monaco').click({ button: 'right', position: { x: 42, y: 38 } })
    await expect(editorContextMenu).toBeVisible()
    await editorContextMenu.getByRole('menuitem', { name: 'Hide Blame' }).click()
    await expect(page.locator('.code-file-inline-blame')).toHaveCount(0)

    await fileSearchInput.fill('deep/nested/inner/blame-multi.py:1')
    await fileSearchInput.press('Enter')
    await expect(page.getByTestId('code-file-editor')).toBeVisible()
    await expect(activeFileTabName(page)).toHaveText('blame-multi.py')
    await expect(page.getByTestId('code-file-editor-statusbar')).toContainText('Ln 1, Col 1')
    await page.getByTestId('code-file-monaco').click({ button: 'right', position: { x: 42, y: 38 } })
    await expect(editorContextMenu).toBeVisible()
    await editorContextMenu.getByRole('menuitem', { name: 'Annotate with Blame' }).click()
    const multiInlineBlame = page.locator('.code-file-inline-blame')
    await expect(multiInlineBlame).toHaveCount(2)
    await expect(multiInlineBlame.nth(0)).toContainText('Farming E2E')
    await expect(multiInlineBlame.nth(1)).toContainText('Farming E2E')
    await multiInlineBlame.nth(1).click()
    await expect(blameDetail).toContainText('Change multi blame line')
    await expect(page.getByTestId('code-file-editor-statusbar')).toContainText('Ln 2, Col 1')
    await expect(page.getByTestId('code-file-editor-statusbar')).not.toContainText('Change multi blame line')
    await page.getByTestId('code-file-monaco').click({ button: 'right', position: { x: 42, y: 38 } })
    await expect(editorContextMenu).toBeVisible()
    await editorContextMenu.getByRole('menuitem', { name: 'Hide Blame' }).click()
    await expect(page.locator('.code-file-inline-blame')).toHaveCount(0)

    await fileSearchInput.fill('search-target-omega')
    const searchResult = childFiles.locator('.code-file-search-result[title="README.md:3"]')
    await expect(searchResult).toBeVisible()
    await searchResult.click()
    await expect(page.getByTestId('code-file-editor-statusbar')).toContainText('Ln 3, Col 1')
    const shortcutSaveMarker = `shortcut-save-${Date.now()}`
    await page.getByTestId('code-file-monaco').click({ position: { x: 80, y: 130 } })
    await page.evaluate((marker) => {
      const editor = window.__farmingFileEditorTest
      if (!editor?.focus() || !editor.insertText(`\n${marker}`)) {
        throw new Error('Failed to insert Monaco test text')
      }
    }, shortcutSaveMarker)
    await expect.poll(async () => page.evaluate(() => window.__farmingFileEditorTest?.getValue() ?? '')).toContain(shortcutSaveMarker)
    await expect(page.getByRole('button', { name: 'Open File Diff' })).toBeVisible()
    await expect(page.getByTestId('code-file-diff-view')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Save file' })).toBeVisible()
    await page.getByTestId('code-file-monaco').click({ button: 'right', position: { x: 220, y: 130 } })
    await expect(editorContextMenu).toBeVisible()
    await expect(editorContextMenu.getByRole('menuitem', { name: 'Cut' })).toBeVisible()
    await expect(editorContextMenu.getByRole('menuitem', { name: 'Copy' })).toBeVisible()
    await expect(editorContextMenu.getByRole('menuitem', { name: 'Paste' })).toBeVisible()
    await expect(editorContextMenu.getByRole('menuitem', { name: 'Select All' })).toBeVisible()
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Save file' }).click()
    await expect(page.getByRole('button', { name: 'Save file' })).toHaveCount(0)
    await expect.poll(() => fs.readFileSync(path.join(childWorkspace, 'README.md'), 'utf8')).toContain(shortcutSaveMarker)
    await page.evaluate(() => {
      if (!window.__farmingFileEditorTest?.undo()) {
        throw new Error('Failed to trigger Monaco undo after save')
      }
    })
    await expect.poll(async () => page.evaluate((marker) => {
      return window.__farmingFileEditorTest?.getValue().includes(marker) ?? true
    }, shortcutSaveMarker)).toBe(false)
    await expect(page.getByRole('button', { name: 'Save file' })).toBeVisible()
    await page.getByRole('button', { name: 'Save file' }).click()
    await expect(page.getByRole('button', { name: 'Save file' })).toHaveCount(0)
    await expect.poll(() => fs.readFileSync(path.join(childWorkspace, 'README.md'), 'utf8')).not.toContain(shortcutSaveMarker)
    await page.getByRole('button', { name: 'Open File Diff' }).click()
    await expect(page.getByTestId('code-file-diff-view')).toBeVisible()
    await expect(page.getByTestId('code-file-diff-monaco')).toBeVisible()
    await page.getByTestId('code-file-diff-view').getByRole('button', { name: 'Close diff' }).click()
    await expect(page.getByTestId('code-file-diff-view')).toHaveCount(0)
    await filesTitle.click()
    await expect(filesTitle).toHaveAttribute('aria-expanded', 'false')
    await filesTitle.click()
    await expect(filesTitle).toHaveAttribute('aria-expanded', 'true')
    const readmeRow = childFiles.locator('[data-testid="code-file-row"][data-file-path="README.md"]')
    await expect(readmeRow).toBeVisible()
    await expect(readmeRow).toHaveClass(/active/)
    const queryRow = childFiles.locator('[data-testid="code-file-row"][data-file-path="query.sql"]')
    const transientDeleteRow = childFiles.locator('[data-testid="code-file-row"][data-file-path="delete-me.txt"]')
    await queryRow.click()
    await expect(activeFileTabName(page)).toHaveText('query.sql')
    await expect(page.getByTestId('code-file-editor').getByRole('tab').filter({ hasText: 'query.sql' })).toHaveCount(1)
    await page.getByTestId('code-file-editor').getByRole('button', { name: 'Close query.sql' }).click()
    await expect(page.getByTestId('code-file-editor').getByRole('tab').filter({ hasText: 'query.sql' })).toHaveCount(0)
    await page.keyboard.press('Control+Shift+T')
    await expect(activeFileTabName(page)).toHaveText('query.sql')
    await expect(page.getByTestId('code-file-editor').getByRole('tab').filter({ hasText: 'query.sql' })).toHaveCount(1)
    await transientDeleteRow.click()
    await expect(activeFileTabName(page)).toHaveText('delete-me.txt')
    await expect(page.getByTestId('code-file-editor').getByRole('tab').filter({ hasText: 'query.sql' })).toHaveCount(0)
    await expect(page.getByTestId('code-file-editor').getByRole('tab').filter({ hasText: 'README.md' })).toHaveCount(1)

    await fileSearchInput.fill('')
    await fileTree.evaluate(element => {
      element.scrollTop = 0
      element.dispatchEvent(new Event('scroll', { bubbles: true }))
    })
    const loadedDeepRow = childFiles.locator('[data-testid="code-file-row"][data-file-path="deep/nested/inner"]')
    await expect(loadedDeepRow).toBeVisible()
    await expect(loadedDeepRow.locator('.code-file-name')).toHaveText('deep/nested/inner')
    await loadedDeepRow.click({ button: 'right' })
    await expect(page.getByTestId('code-file-context-menu')).toBeVisible()
    await expect(page.getByTestId('code-file-context-menu').getByRole('menuitem', { name: 'New File' })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('code-file-context-menu')).toBeHidden()
    await loadedDeepRow.click({ button: 'right' })
    await page.getByTestId('code-file-context-menu').getByRole('menuitem', { name: 'Rename' }).click()
    await expect(page.getByTestId('code-file-operation-dialog')).toHaveCount(0)
    await expect(loadedDeepRow.getByTestId('code-file-inline-operation')).toBeVisible()
    const deepOperationInput = loadedDeepRow.getByTestId('code-file-operation-input')
    await deepOperationInput.click()
    await expect(deepOperationInput).toBeFocused()
    await deepOperationInput.press('Escape')
    await expect(loadedDeepRow.getByTestId('code-file-inline-operation')).toHaveCount(0)
    await expect(loadedDeepRow).toHaveClass(/selected/)
    await expect(childFiles.locator('[role="tree"]')).toBeFocused()
    await page.keyboard.press('Control+P')
    await expect(fileSearchInput).toBeFocused()
    await fileSearchInput.fill('file-')
    const readFileSearchSelection = async () => childFiles.getByTestId('code-file-search-results').evaluate(container => {
      const rows = Array.from(container.querySelectorAll<HTMLElement>('.code-file-search-result'))
      const titles = rows.map(row => row.getAttribute('title') || row.textContent?.trim() || '')
      const activeRow = container.querySelector<HTMLElement>('.code-file-search-result.active')
      const activeTitle = activeRow?.getAttribute('title') || activeRow?.textContent?.trim() || ''
      return {
        activeIndex: titles.indexOf(activeTitle),
        titles,
      }
    })
    await expect.poll(async () => {
      const selection = await readFileSearchSelection()
      return selection.titles.length >= 3 &&
        selection.activeIndex >= 0 &&
        selection.activeIndex < selection.titles.length - 1
    }).toBe(true)
    const initialFileSearchSelection = await readFileSearchSelection()
    await fileSearchInput.press('ArrowDown')
    await expect.poll(async () => (await readFileSearchSelection()).activeIndex).toBe(initialFileSearchSelection.activeIndex + 1)
    await fileSearchInput.press('ArrowUp')
    await expect.poll(async () => (await readFileSearchSelection()).activeIndex).toBe(initialFileSearchSelection.activeIndex)
    await fileSearchInput.fill('')
    await fileSearchInput.fill('rename-me.txt:1')
    await expect(childFiles.locator('.code-file-search-result').filter({ hasText: 'rename-me.txt' }).first()).toBeVisible()
    await fileSearchInput.press('Enter')
    await expect(activeFileTabName(page)).toHaveText('rename-me.txt')
    const renameRow = childFiles.locator('[data-testid="code-file-row"][data-file-path="rename-me.txt"]')
    await expect(renameRow).toBeVisible()
    await renameRow.click({ button: 'right' })
    await page.getByTestId('code-file-context-menu').getByRole('menuitem', { name: 'Rename' }).click()
    await expect(page.getByTestId('code-file-operation-dialog')).toHaveCount(0)
    await expect(renameRow.getByTestId('code-file-inline-operation')).toBeVisible()
    const renameInput = renameRow.getByTestId('code-file-operation-input')
    await renameInput.click()
    await expect(renameInput).toBeFocused()
    await renameInput.fill('renamed-by-ui.txt')
    await renameInput.press('Enter')
    await expect(page.getByTestId('code-file-operation-dialog')).toHaveCount(0)
    const renamedRow = childFiles.locator('[data-testid="code-file-row"][data-file-path="renamed-by-ui.txt"]')
    await expect(renamedRow).toBeVisible()
    await expect(renamedRow).toHaveClass(/active/)
    await renamedRow.click({ button: 'right' })
    await page.getByTestId('code-file-context-menu').getByRole('menuitem', { name: 'New File' }).click()
    const newFileInput = page.getByTestId('code-file-operation-input')
    await expect(newFileInput).toHaveAttribute('autocomplete', 'off')
    await newFileInput.press('Escape')
    await expect(page.getByTestId('code-file-operation-dialog')).toHaveCount(0)
    const deleteRow = childFiles.locator('[data-testid="code-file-row"][data-file-path="delete-me.txt"]')
    await expect(deleteRow).toBeVisible()
    await deleteRow.click({ button: 'right' })
    await page.getByTestId('code-file-context-menu').getByRole('menuitem', { name: 'Delete' }).click()
    const deleteDialog = page.getByTestId('code-file-operation-dialog')
    await expect(deleteDialog).toBeVisible()
    await expect(deleteDialog).toContainText('delete-me.txt')
    await deleteDialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(deleteRow).toBeVisible()
    expect(fs.existsSync(path.join(childWorkspace, 'delete-me.txt'))).toBe(true)
    await deleteRow.click({ button: 'right' })
    await page.getByTestId('code-file-context-menu').getByRole('menuitem', { name: 'Delete' }).click()
    await page.getByTestId('code-file-operation-dialog').getByRole('button', { name: 'Delete' }).click()
    await expect(page.getByTestId('code-file-operation-dialog')).toHaveCount(0)
    await expect(deleteRow).toHaveCount(0)
    await expect.poll(() => fs.existsSync(path.join(childWorkspace, 'delete-me.txt'))).toBe(false)
    await fileSearchInput.fill('deep/nested/inner/file-00.txt:1')
    await fileSearchInput.press('Enter')
    const compactDeepRow = childFiles.locator('[data-testid="code-file-row"][data-file-path="deep/nested/inner"]')
    await expect(compactDeepRow).toBeVisible()
    await expect(compactDeepRow.locator('.code-file-name')).toHaveText('deep/nested/inner')
    const file00Row = childFiles.locator('[data-testid="code-file-row"][data-file-path="deep/nested/inner/file-00.txt"]')
    const file01Row = childFiles.locator('[data-testid="code-file-row"][data-file-path="deep/nested/inner/file-01.txt"]')
    await expect(file00Row).toBeVisible()
    await expect(file00Row).toHaveClass(/selected/)
    await file00Row.click()
    await expect(file00Row).toHaveClass(/selected/)
    await expect.poll(async () => childFiles.locator('[role="tree"]').evaluate(tree => (
      tree === document.activeElement || tree.contains(document.activeElement)
    ))).toBe(true)
    await page.keyboard.press('ArrowDown')
    await expect(file01Row).toHaveClass(/selected/)
    await page.keyboard.press('F2')
    await expect(file01Row.getByTestId('code-file-inline-operation')).toBeVisible()
    await expect(file00Row.getByTestId('code-file-inline-operation')).toHaveCount(0)
    await file01Row.getByTestId('code-file-operation-input').press('Escape')
    await expect(file01Row.getByTestId('code-file-inline-operation')).toHaveCount(0)
    await expect.poll(async () => childFiles.locator('[role="tree"]').evaluate(tree => (
      tree === document.activeElement || tree.contains(document.activeElement)
    ))).toBe(true)
    const visibleFileRows = childFiles.locator('[data-testid="code-file-row"]')
    await page.keyboard.press('Home')
    await expect(visibleFileRows.first()).toHaveClass(/selected/)
    await page.keyboard.press('End')
    await expect(visibleFileRows.last()).toHaveClass(/selected/)
    await page.keyboard.press('Home')
    await expect(compactDeepRow).toHaveClass(/selected/)
    await file00Row.click()
    await expect(file00Row).toHaveClass(/selected/)
    await expect.poll(async () => childFiles.locator('[role="tree"]').evaluate(tree => (
      tree === document.activeElement || tree.contains(document.activeElement)
    ))).toBe(true)
    await page.keyboard.press('PageDown')
    const selectedFileTreePath = () => visibleFileRows.evaluateAll(rows => (
      rows.find(row => row.classList.contains('selected'))?.getAttribute('data-file-path') ?? ''
    ))
    await expect.poll(selectedFileTreePath).toMatch(/^deep\/nested\/inner\/file-(?!00)\d\d\.txt$/)
    const pageDownSelectedPath = await selectedFileTreePath()
    expect(pageDownSelectedPath).toMatch(/^deep\/nested\/inner\/file-\d\d\.txt$/)
    await page.keyboard.press('PageUp')
    await expect(file00Row).toHaveClass(/selected/)

    if (await compactDeepRow.getAttribute('aria-expanded') !== 'true') {
      await compactDeepRow.click()
    }
    await expect(compactDeepRow).toHaveAttribute('aria-expanded', 'true')
    await compactDeepRow.click()
    await expect(compactDeepRow).toHaveAttribute('aria-expanded', 'false')
    await expect.poll(async () => childFiles.locator('.code-file-tree-viewport').evaluate(viewport => {
      const tree = viewport.querySelector<HTMLElement>('.code-file-tree')
      const rows = Array.from(viewport.querySelectorAll<HTMLElement>('[data-testid="code-file-row"]'))
      const lastRow = rows.at(-1)
      if (!tree || !lastRow || rows.length === 0) return false
      const viewportBox = viewport.getBoundingClientRect()
      const lastRowBox = lastRow.getBoundingClientRect()
      return Math.abs(tree.clientHeight - rows.length * 24) <= 4 &&
        Math.abs(viewport.clientHeight - rows.length * 24) <= 4 &&
        Math.abs(viewportBox.bottom - lastRowBox.bottom) <= 4
    })).toBe(true)
    await compactDeepRow.click()
    await expect(compactDeepRow).toHaveAttribute('aria-expanded', 'true')
    await expect.poll(async () => fileTree.evaluate(element => {
      const rowCount = element.querySelectorAll('[data-testid="code-file-row"]').length
      const style = getComputedStyle(element)
      return rowCount > 0 &&
        style.overflowY === 'visible' &&
        element.scrollHeight <= element.clientHeight + 1 &&
        Math.abs(element.clientHeight - rowCount * 24) <= 4
    })).toBe(true)
    await expect.poll(async () => page.getByTestId('code-project-list').evaluate((projectList, targetPath) => {
      const target = projectList
        .querySelector<HTMLElement>(`[data-testid="code-file-row"][data-file-path="${targetPath}"]`)
      if (!target) return false
      const projectListBox = projectList.getBoundingClientRect()
      const targetBox = target.getBoundingClientRect()
      projectList.scrollTop += targetBox.top - projectListBox.top
      projectList.dispatchEvent(new Event('scroll', { bubbles: true }))
      const nextTargetBox = target.getBoundingClientRect()
      return nextTargetBox.top >= projectListBox.top - 1 && nextTargetBox.bottom <= projectListBox.bottom + 1
    }, 'deep/nested/inner/file-30.txt')).toBe(true)
    await fileSearchInput.fill('deep/nested/inner/file-35.txt:1')
    await fileSearchInput.press('Enter')
    await expect(activeFileTabName(page)).toHaveText('file-35.txt')
    await expect(page.getByTestId('code-file-editor-statusbar')).toContainText('Ln 1, Col 1')
    const deepActiveRow = childFiles.locator('[data-testid="code-file-row"].active[data-file-path="deep/nested/inner/file-35.txt"]')
    await expect(deepActiveRow).toBeVisible()
    await expect.poll(async () => page.getByTestId('code-project-list').evaluate((projectList, filePath) => {
      const activeRow = Array.from(projectList.querySelectorAll<HTMLElement>('[data-testid="code-file-row"].active'))
        .find(row => row.dataset.filePath === filePath)
      if (!activeRow) return false
      const viewportBox = projectList.getBoundingClientRect()
      const rowBox = activeRow.getBoundingClientRect()
      return rowBox.top >= viewportBox.top - 1 && rowBox.bottom <= viewportBox.bottom + 1
    }, 'deep/nested/inner/file-35.txt')).toBe(true)

    for (let index = 0; index < 9; index += 1) {
      const fileName = `file-${String(index).padStart(2, '0')}.txt`
      await fileSearchInput.fill(`deep/nested/inner/${fileName}:1`)
      await fileSearchInput.press('Enter')
      await expect(activeFileTabName(page)).toHaveText(fileName)
    }
    await expect.poll(async () => childProject.getByTestId('code-open-editors').evaluate(section => {
      const list = section.querySelector<HTMLElement>('.code-open-editors-list')
      const activeRow = section.querySelector<HTMLElement>('[data-testid="code-open-editor-row"].active')
      const projectList = section.closest('.code-project-list') as HTMLElement | null
      const filesHeader = section.closest('.code-project-group')?.querySelector<HTMLElement>('.code-files-header')
      if (!list || !activeRow || !projectList || !filesHeader) return null
      const row = list.querySelector<HTMLElement>('[data-testid="code-open-editor-row"]')
      if (!row) return null
      const listBox = list.getBoundingClientRect()
      const activeBox = activeRow.getBoundingClientRect()
      const sectionBox = section.getBoundingClientRect()
      const projectListBox = projectList.getBoundingClientRect()
      const filesHeaderBox = filesHeader.getBoundingClientRect()
      return {
        activeVisible: activeBox.top >= listBox.top - 1 && activeBox.bottom <= listBox.bottom + 1,
        filesHeaderBelowOpenEditors: filesHeaderBox.top >= sectionBox.bottom - 2,
        listIsCapped: list.clientHeight <= row.getBoundingClientRect().height * 7 + 1,
        projectKeepsOpenEditors: sectionBox.top >= projectListBox.top - 1 && sectionBox.bottom <= projectListBox.bottom + 1,
        rowCount: list.querySelectorAll('[data-testid="code-open-editor-row"]').length,
        scrollable: list.scrollHeight > list.clientHeight + 1,
        visibleCount: section.dataset.visibleEditorCount,
      }
    })).toMatchObject({
      activeVisible: true,
      filesHeaderBelowOpenEditors: true,
      listIsCapped: true,
      projectKeepsOpenEditors: true,
      scrollable: true,
      visibleCount: '7',
    })
    await expect.poll(async () => childProject.getByTestId('code-open-editors').locator('.code-open-editors-list').evaluate(list => (
      list.querySelectorAll('[data-testid="code-open-editor-row"]').length
    ))).toBeGreaterThanOrEqual(8)
  })

  test('shows incomplete state when project file search stops early', async ({ page }) => {
    await mockCodexSessions(page)
    const workspaceRoot = path.join('/tmp', `farming-search-truncated-${process.pid}`)
    fs.rmSync(workspaceRoot, { recursive: true, force: true })
    fs.mkdirSync(workspaceRoot, { recursive: true })
    fs.writeFileSync(path.join(workspaceRoot, 'README.md'), '# Search truncated\n')

    await page.route('**/api/files/search?**', async route => {
      const url = new URL(route.request().url())
      if (url.searchParams.get('q') === 'huge-no-match') {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            results: {
              query: 'huge-no-match',
              path: '.',
              matches: [],
              truncated: true,
            },
          }),
        })
        return
      }
      await route.continue()
    })

    await openFarming(page)
    await openNewAgentDialog(page)
    await startAgentFromOpenDialog(page, 'bash', workspaceRoot)

    const project = page.getByTestId('code-project-group').filter({ hasText: path.basename(workspaceRoot) })
    await expect(project).toHaveCount(1, { timeout: 30_000 })
    const files = project.getByTestId('code-files-section')
    const filesTitle = files.locator('.code-files-title').first()
    await filesTitle.click()
    await expect(filesTitle).toHaveAttribute('aria-expanded', 'true')

    await files.getByPlaceholder('Search or path:line').fill('huge-no-match')
    const results = files.getByTestId('code-file-search-results')
    await expect(results).toContainText('No matches')
    await expect(results).toContainText('Search stopped early')
  })

  test('keeps editor scroll and undo stack after saving', async ({ page }) => {
    await mockCodexSessions(page)
    const workspaceRoot = path.join('/tmp', `farming-editor-save-identity-${process.pid}`)
    fs.rmSync(workspaceRoot, { recursive: true, force: true })
    fs.mkdirSync(workspaceRoot, { recursive: true })
    const readmePath = path.join(workspaceRoot, 'README.md')
    fs.writeFileSync(readmePath, Array.from({ length: 160 }, (_value, index) => `line ${String(index + 1).padStart(3, '0')}`).join('\n') + '\n')
    execFileSync('git', ['init'], { cwd: workspaceRoot, stdio: 'ignore' })
    execFileSync('git', ['config', 'user.email', 'farming-e2e@example.test'], { cwd: workspaceRoot })
    execFileSync('git', ['config', 'user.name', 'Farming E2E'], { cwd: workspaceRoot })
    execFileSync('git', ['add', 'README.md'], { cwd: workspaceRoot, stdio: 'ignore' })
    execFileSync('git', ['commit', '-m', 'seed readme'], { cwd: workspaceRoot, stdio: 'ignore' })

    await openFarming(page)
    await openNewAgentDialog(page)
    await startAgentFromOpenDialog(page, 'bash', workspaceRoot)

    const project = page.getByTestId('code-project-group').filter({ hasText: path.basename(workspaceRoot) })
    await expect(project).toHaveCount(1, { timeout: 30_000 })
    const files = project.getByTestId('code-files-section')
    const filesTitle = files.locator('.code-files-title').first()
    await filesTitle.click()
    await expect(filesTitle).toHaveAttribute('aria-expanded', 'true')
    await files.locator('[data-testid="code-file-row"][data-file-path="README.md"]').click()
    await expect(activeFileTabName(page)).toHaveText('README.md')
    await expect(page.getByRole('button', { name: 'Show Markdown source' })).toBeVisible()
    await page.getByRole('button', { name: 'Show Markdown source' }).click()
    await expect(page.getByTestId('code-file-monaco')).toBeVisible()

    const saveMarker = `save-undo-scroll-${Date.now()}`
    await page.evaluate((marker) => {
      const editor = window.__farmingFileEditorTest
      if (!editor?.revealLine(120) || !editor.insertText(`${marker}\n`)) {
        throw new Error('Failed to edit README before save identity regression')
      }
    }, saveMarker)
    const scrollBeforeSave = await page.evaluate(() => window.__farmingFileEditorTest?.getScrollTop() ?? 0)
    expect(scrollBeforeSave).toBeGreaterThan(0)
    await expect(page.getByRole('button', { name: 'Save file' })).toBeVisible()
    await page.getByRole('button', { name: 'Save file' }).click()
    await expect(page.getByRole('button', { name: 'Save file' })).toHaveCount(0)
    await expect.poll(() => fs.readFileSync(readmePath, 'utf8')).toContain(saveMarker)
    await expect.poll(async () => page.evaluate(() => window.__farmingFileEditorTest?.getScrollTop() ?? 0)).toBeGreaterThan(0)
    await page.evaluate(() => {
      if (!window.__farmingFileEditorTest?.undo()) {
        throw new Error('Failed to undo after saving README')
      }
    })
    await expect.poll(async () => page.evaluate((marker) => (
      window.__farmingFileEditorTest?.getValue().includes(marker) ?? true
    ), saveMarker)).toBe(false)
    await expect(page.getByRole('button', { name: 'Save file' })).toBeVisible()
    await page.getByRole('button', { name: 'Save file' }).click()
    await expect(page.getByRole('button', { name: 'Save file' })).toHaveCount(0)
    await expect.poll(() => fs.readFileSync(readmePath, 'utf8')).not.toContain(saveMarker)
  })

  test('opens editor line changes from the gutter context menu', async ({ page }) => {
    await mockCodexSessions(page)
    const workspaceRoot = path.join('/tmp', `farming-line-changes-${process.pid}`)
    const srcDir = path.join(workspaceRoot, 'src')
    fs.rmSync(workspaceRoot, { recursive: true, force: true })
    fs.mkdirSync(srcDir, { recursive: true })
    const appPath = path.join(srcDir, 'App.tsx')
    fs.writeFileSync(appPath, 'first line\n')
    execFileSync('git', ['init'], { cwd: workspaceRoot, stdio: 'ignore' })
    execFileSync('git', ['config', 'user.email', 'farming-e2e@example.test'], { cwd: workspaceRoot })
    execFileSync('git', ['config', 'user.name', 'Farming E2E'], { cwd: workspaceRoot })
    execFileSync('git', ['add', 'src/App.tsx'], { cwd: workspaceRoot, stdio: 'ignore' })
    execFileSync('git', ['commit', '-m', 'first app line'], { cwd: workspaceRoot, stdio: 'ignore' })
    fs.writeFileSync(appPath, 'first line\nsecond line\n')
    execFileSync('git', ['add', 'src/App.tsx'], { cwd: workspaceRoot, stdio: 'ignore' })
    execFileSync('git', ['commit', '-m', 'second app line'], { cwd: workspaceRoot, stdio: 'ignore' })
    fs.writeFileSync(appPath, 'working first\nsecond line\n')

    await openFarming(page)
    await openNewAgentDialog(page)
    await startAgentFromOpenDialog(page, 'bash', workspaceRoot)

    const project = page.getByTestId('code-project-group').filter({ hasText: path.basename(workspaceRoot) })
    await expect(project).toHaveCount(1, { timeout: 30_000 })
    const files = project.getByTestId('code-files-section')
    const filesTitle = files.locator('.code-files-title').first()
    await filesTitle.click()
    await expect(filesTitle).toHaveAttribute('aria-expanded', 'true')

    const fileSearchInput = files.getByPlaceholder('Search or path:line')
    await fileSearchInput.fill('src/App.tsx:2')
    await files.locator('.code-file-search-result.jump').first().click()
    await expect(page.getByTestId('code-file-editor')).toBeVisible()
    await expect(activeFileTabName(page)).toHaveText('App.tsx')
    await expect(page.getByTestId('code-file-editor-statusbar')).toContainText('Ln 2, Col 1')

    const editorContextMenu = page.getByTestId('code-editor-context-menu')
    await page.getByTestId('code-file-monaco').click({ button: 'right', position: { x: 42, y: 38 } })
    await expect(editorContextMenu).toBeVisible()
    await editorContextMenu.getByRole('menuitem', { name: 'Open Line Changes with Previous Revision' }).click()
    const lineChangesPanel = page.getByTestId('code-file-line-changes-panel')
    await expect(lineChangesPanel).toBeVisible()
    await expect(lineChangesPanel).toContainText('Open Line Changes with Previous Revision')
    await expect(lineChangesPanel).toContainText('second app line')
    await expect(lineChangesPanel.locator('.code-file-line-changes-patch')).toContainText('+second line')
    await lineChangesPanel.getByRole('button', { name: 'Close line changes' }).click()
    await expect(lineChangesPanel).toHaveCount(0)

    await fileSearchInput.fill('src/App.tsx:1')
    await files.locator('.code-file-search-result.jump').first().click()
    await expect(page.getByTestId('code-file-editor-statusbar')).toContainText('Ln 1, Col 1')
    await page.getByTestId('code-file-monaco').click({ button: 'right', position: { x: 42, y: 20 } })
    await expect(editorContextMenu).toBeVisible()
    await editorContextMenu.getByRole('menuitem', { name: 'Open Line Changes with Working File' }).click()
    await expect(lineChangesPanel).toBeVisible()
    await expect(lineChangesPanel).toContainText('Open Line Changes with Working File')
    await expect(lineChangesPanel.locator('.code-file-line-changes-patch')).toContainText('-first line')
    await expect(lineChangesPanel.locator('.code-file-line-changes-patch')).toContainText('+working first')
  })

  test('repaints terminal output after reloading an existing session', async ({ page }) => {
    const reloadWorkspace = path.resolve('.tmp', `farming-reload-${process.pid}`)
    fs.rmSync(reloadWorkspace, { recursive: true, force: true })
    fs.mkdirSync(reloadWorkspace, { recursive: true })

    await openFarming(page)
    await openNewAgentDialog(page)
    await startAgentFromOpenDialog(page, 'bash', reloadWorkspace)
    await expect(page.getByTestId('code-agent-row')).toHaveCount(1, { timeout: 30_000 })
    const { agentId } = await getAgentIdFromRow(page)
    await expectTerminalCanvasToHaveInk(page, agentId)

    await page.reload({ waitUntil: 'networkidle' })
    await expect(page.getByTestId('app-shell')).toBeVisible()
    const { agentId: reloadedAgentId } = await getAgentIdFromRow(page)
    expect(reloadedAgentId).toBe(agentId)
    await expectTerminalCanvasToHaveInk(page, reloadedAgentId)
  })

  test('keeps terminal scrollback pinned while live output arrives', async ({ page }) => {
    const scrollWorkspace = path.resolve('.tmp', `farming-scroll-${process.pid}`)
    fs.rmSync(scrollWorkspace, { recursive: true, force: true })
    fs.mkdirSync(scrollWorkspace, { recursive: true })

    await openFarming(page)
    await openNewAgentDialog(page)
    await startAgentFromOpenDialog(page, 'bash', scrollWorkspace)
    await expect(page.getByTestId('code-agent-row')).toHaveCount(1, { timeout: 30_000 })
    const { agentId } = await getAgentIdFromRow(page)
    await expectTerminalCanvasToHaveInk(page, agentId)

    const scrollbackFixture = `${Array.from({ length: 120 }, (_, index) => `scroll-lock-line-${String(index).padStart(3, '0')}`).join('\r\n')}\r\n$ `
    await writeTerminalFixture(page, agentId, scrollbackFixture)
    await scrollTerminalToLine(page, agentId, 0)
    const pausedViewport = await terminalViewport(page, agentId)
    expect(pausedViewport.scrollbackLength).toBeGreaterThan(0)
    expect(pausedViewport.following).toBe(false)
    await expect(page.getByTestId('code-terminal-jump-bottom')).toBeVisible()

    const sample = await writeTerminalRawAndSampleViewport(page, agentId, '\r\nnew output while user is reading older terminal text\r\n$ ')
    expect(sample.before).toBe(pausedViewport.viewportY)
    expect(sample.during).toBeGreaterThan(0)
    expect(sample.after).toBeGreaterThanOrEqual(pausedViewport.viewportY)
    expect(sample.following).toBe(false)
    expect(sample.hasUnreadOutput).toBe(true)
    await expect(page.getByTestId('code-terminal-jump-bottom')).toBeVisible()
  })

  test('resumes an others Codex session from mouse search result click', async ({ page }) => {
    await mockCodexSessions(page, [{
      id: '019f0000-0000-7000-8000-000000000106',
      title: 'Farming others',
      cwd: '',
      workspace: '',
      updatedAt: new Date().toISOString(),
      createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      archived: false,
      pinned: false,
      unread: false,
      projectless: true,
      model: 'gpt-5.5',
      effort: 'xhigh',
      source: 'codex',
    }])

    let resumedCodexSessionId = ''
    await page.route(/\/farming\/api\/(?:codex\/sessions|agent-sessions\/codex)\/[^/]+\/resume$/, async route => {
      const match = route.request().url().match(/\/(?:codex\/sessions|agent-sessions\/codex)\/([^/]+)\/resume$/)
      resumedCodexSessionId = match ? decodeURIComponent(match[1]) : ''
      await route.fulfill({
        contentType: 'application/json',
        status: 201,
        body: JSON.stringify({ agentId: 'farming-others-agent' }),
      })
    })

    await openFarming(page)
    await page.getByRole('button', { name: /Search/ }).click()
    await expect(page.getByTestId('code-search-panel')).toBeVisible()
    await page.getByTestId('code-search-box').locator('input').fill('Farming others')
    await expect(page.getByTestId('code-session-search-result')).toHaveCount(1)
    await page.getByTestId('code-session-search-result').first().click()
    await expect.poll(async () => resumedCodexSessionId).toBe('019f0000-0000-7000-8000-000000000106')
    await expect(page.getByTestId('code-search-box')).toBeHidden()
    await expect(page.getByTestId('code-active-session-row').filter({ hasText: 'Farming others' })).toHaveCount(1)
  })

  test('covers desktop and mobile flows with real rendered surfaces', async ({ page, workspaceRoot }) => {
    test.setTimeout(180_000)

    const mainWorkspace = path.join(workspaceRoot, 'farming-playwright-main')
    const childWorkspace = path.join(workspaceRoot, 'farming-playwright-child')
    const deepCodexCwd = path.join(childWorkspace, 'deep', 'task')
    const childWorkspaceDisplay = childWorkspace
    const deepCodexCwdDisplay = deepCodexCwd
    fs.rmSync(mainWorkspace, { recursive: true, force: true })
    fs.rmSync(childWorkspace, { recursive: true, force: true })
    fs.mkdirSync(mainWorkspace, { recursive: true })
    fs.mkdirSync(childWorkspace, { recursive: true })
    fs.mkdirSync(deepCodexCwd, { recursive: true })
    fs.writeFileSync(path.join(childWorkspace, 'README.md'), '# Farming Playwright child workspace\n')
    execFileSync('git', ['init'], { cwd: childWorkspace, stdio: 'ignore' })
    execFileSync('git', ['config', 'user.email', 'farming-e2e@example.test'], { cwd: childWorkspace })
    execFileSync('git', ['config', 'user.name', 'Farming E2E'], { cwd: childWorkspace })
    execFileSync('git', ['add', 'README.md'], { cwd: childWorkspace, stdio: 'ignore' })
    execFileSync('git', ['commit', '-m', 'seed child workspace'], { cwd: childWorkspace, stdio: 'ignore' })
    await page.addInitScript(() => {
      class MockSpeechRecognition extends EventTarget {
        continuous = false
        interimResults = false
        lang = 'en-US'
        onresult: ((event: unknown) => void) | null = null
        onerror: (() => void) | null = null
        onend: (() => void) | null = null

        start() {
          ;(window as unknown as { __mockSpeechRecognition?: MockSpeechRecognition }).__mockSpeechRecognition = this
        }

        stop() {
          this.onend?.()
        }
      }

      ;(window as unknown as { SpeechRecognition?: typeof MockSpeechRecognition }).SpeechRecognition = MockSpeechRecognition
    })

    await mockCodexSessions(page, [{
      id: '019f0000-0000-7000-8000-000000000099',
      title: 'Deep Codex Session',
      cwd: deepCodexCwd,
      workspace: childWorkspace,
      updatedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      archived: false,
      pinned: true,
      unread: false,
      projectless: false,
      model: 'gpt-5.5',
      effort: 'xhigh',
      source: 'codex',
    }, {
      provider: 'claude',
      providerName: 'Claude',
      capabilities: ['resume', 'fork'],
      id: '11111111-2222-4333-8444-555555555555',
      title: 'Pinned Claude Session',
      cwd: deepCodexCwd,
      workspace: childWorkspace,
      updatedAt: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
      createdAt: new Date(Date.now() - 62 * 60 * 1000).toISOString(),
      archived: false,
      pinned: true,
      unread: false,
      projectless: false,
      model: 'sonnet',
      effort: '',
      source: 'claude',
    }, {
      id: '019f0000-0000-7000-8000-000000000102',
      title: 'Visible Codex Session 1',
      cwd: deepCodexCwd,
      workspace: childWorkspace,
      updatedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      createdAt: new Date(Date.now() - 65 * 60 * 1000).toISOString(),
      archived: false,
      pinned: false,
      unread: false,
      projectless: false,
      model: 'gpt-5.5',
      effort: 'xhigh',
      source: 'codex',
    }, {
      id: '019f0000-0000-7000-8000-000000000103',
      title: 'Visible Codex Session 2',
      cwd: deepCodexCwd,
      workspace: childWorkspace,
      updatedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      createdAt: new Date(Date.now() - 70 * 60 * 1000).toISOString(),
      archived: false,
      pinned: false,
      unread: false,
      projectless: false,
      model: 'gpt-5.5',
      effort: 'xhigh',
      source: 'codex',
    }, {
      id: '019f0000-0000-7000-8000-000000000104',
      title: 'Visible Codex Session 3',
      cwd: deepCodexCwd,
      workspace: childWorkspace,
      updatedAt: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
      createdAt: new Date(Date.now() - 75 * 60 * 1000).toISOString(),
      archived: false,
      pinned: false,
      unread: false,
      projectless: false,
      model: 'gpt-5.5',
      effort: 'xhigh',
      source: 'codex',
    }, {
      id: '019f0000-0000-7000-8000-000000000105',
      title: 'Hidden Codex Session',
      cwd: deepCodexCwd,
      workspace: childWorkspace,
      updatedAt: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
      createdAt: new Date(Date.now() - 80 * 60 * 1000).toISOString(),
      archived: false,
      pinned: false,
      unread: false,
      projectless: false,
      model: 'gpt-5.5',
      effort: 'xhigh',
      source: 'codex',
    }, {
      id: '019f0000-0000-7000-8000-000000000101',
      title: 'Plain Codex Session',
      cwd: deepCodexCwd,
      workspace: childWorkspace,
      updatedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      createdAt: new Date(Date.now() - 90 * 60 * 1000).toISOString(),
      archived: false,
      pinned: false,
      unread: false,
      projectless: false,
      model: 'gpt-5.5',
      effort: 'xhigh',
      source: 'codex',
    }, {
      provider: 'claude',
      providerName: 'Claude',
      capabilities: ['resume', 'fork'],
      id: '11111111-2222-4333-8444-666666666666',
      title: 'Plain Claude Session',
      cwd: deepCodexCwd,
      workspace: childWorkspace,
      updatedAt: new Date(Date.now() - 35 * 60 * 1000).toISOString(),
      createdAt: new Date(Date.now() - 95 * 60 * 1000).toISOString(),
      archived: false,
      pinned: false,
      unread: false,
      projectless: false,
      model: 'sonnet',
      effort: '',
      source: 'claude',
    }, {
      id: '019f0000-0000-7000-8000-000000000100',
      title: 'Archived Codex Session',
      cwd: deepCodexCwd,
      workspace: childWorkspace,
      updatedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      archived: true,
      pinned: false,
      unread: false,
      projectless: false,
      model: 'gpt-5.5',
      effort: 'xhigh',
      source: 'codex',
    }])
    await page.route('**/api/agent-sessions/search?**', async route => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ sessions: [] }),
      })
    })
    let resumedCodexSessionId = ''
    let resumedCodexAgentId = 'resumed-code-agent'
    let resumedClaudeSessionId = ''
    await page.route(/\/farming\/api\/(?:codex\/sessions|agent-sessions\/codex)\/[^/]+\/resume$/, async route => {
      const match = route.request().url().match(/\/(?:codex\/sessions|agent-sessions\/codex)\/([^/]+)\/resume$/)
      resumedCodexSessionId = match ? decodeURIComponent(match[1]) : ''
      await route.fulfill({
        contentType: 'application/json',
        status: 201,
        body: JSON.stringify({ agentId: resumedCodexAgentId }),
      })
    })
    await page.route(/\/farming\/api\/agent-sessions\/claude\/[^/]+\/resume$/, async route => {
      const match = route.request().url().match(/\/agent-sessions\/claude\/([^/]+)\/resume$/)
      resumedClaudeSessionId = match ? decodeURIComponent(match[1]) : ''
      await route.fulfill({
        contentType: 'application/json',
        status: 201,
        body: JSON.stringify({ agentId: resumedCodexAgentId }),
      })
    })

    await page.request.post('/farming/api/settings', {
      data: {
        mainPageSessionKeys: ['agent-session:codex:019f0000-0000-7000-8000-000000000099'],
      },
    })

    await openFarming(page)
    await openNewAgentDialog(page)
    await expect(page.getByTestId('input-dialog')).toBeVisible()
    await expect(page.getByTestId('workspace-input')).toHaveCount(0)
    await expect(page.getByTestId('agent-option-codex')).toContainText('Codex')
    await expect(page.getByTestId('agent-option-claude')).toContainText('Claude Code')
    await expect(page.getByTestId('agent-option-bash')).toContainText('bash')
    await expect(page.getByTestId('agent-option-zsh')).toContainText('zsh')
    await expect(page.getByTestId('agent-option-qwen')).toHaveCount(0)
    if (process.platform === 'darwin') {
      await expect(page.getByTestId('input-dialog')).toHaveScreenshot('desktop-main-agent-list-dialog.png')
    }
    await startAgentFromOpenDialog(page, 'bash', mainWorkspace)
    await expect(page.getByTestId('code-agent-row')).toHaveCount(1, { timeout: 30_000 })
    const { agentId: visibleMainAgentId } = await getAgentIdFromRow(page)
    await expectTerminalCanvasToHaveInk(page, visibleMainAgentId)

    await expect(page.locator('.code-project-add')).toHaveCount(0)
    const initialPrimaryProjectGroup = page.getByTestId('code-project-group').filter({ has: page.locator(`[data-agent-id="${visibleMainAgentId}"]`) })
    await expect(initialPrimaryProjectGroup).toHaveCount(1)
    const firstProjectTitle = initialPrimaryProjectGroup.getByTestId('code-project-title')
    await expect(firstProjectTitle).toContainText(path.basename(mainWorkspace))
    const mainSearchTerm = ((await firstProjectTitle.locator('span').last().textContent()) ?? '').trim()
    expect(mainSearchTerm).toBeTruthy()
    await firstProjectTitle.click({ button: 'right' })
    let projectContextMenu = page.getByTestId('code-project-context-menu')
    await expect(projectContextMenu).toBeVisible()
    if (process.platform === 'darwin') {
      await expect(projectContextMenu).toHaveScreenshot('desktop-project-context-menu.png')
    }
    await expect(projectContextMenu.getByRole('menuitem', { name: 'Rename project' })).toBeVisible()
    await expect(projectContextMenu.getByRole('menuitem', { name: 'Archive chats' })).toBeVisible()
    await expect(projectContextMenu.getByRole('menuitem', { name: 'Archive chats' })).toBeEnabled()
    await expect(projectContextMenu.getByRole('menuitem', { name: 'Open First Agent' })).toHaveCount(0)
    await expect(projectContextMenu.getByRole('menuitem', { name: 'Collapse Project' })).toHaveCount(0)
    await expect(projectContextMenu.getByRole('menuitem', { name: 'Rename project' })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(projectContextMenu).toBeHidden()
    await expect(firstProjectTitle).toBeFocused()
    await page.keyboard.press('Shift+F10')
    projectContextMenu = page.getByTestId('code-project-context-menu')
    await expect(projectContextMenu).toBeVisible()
    await expect(projectContextMenu.getByRole('menuitem', { name: 'Rename project' })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(projectContextMenu).toBeHidden()
    await expect(firstProjectTitle).toBeFocused()
    await firstProjectTitle.click({ button: 'right' })
    projectContextMenu = page.getByTestId('code-project-context-menu')
    await expect(projectContextMenu.getByRole('menuitem', { name: 'Rename project' })).toBeFocused()
    await page.keyboard.press('/')
    await expect(page.getByTestId('code-search-panel')).toBeHidden()
    await expect(projectContextMenu).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(projectContextMenu).toBeHidden()
    await expect(page.getByTestId('code-terminal-grid')).toBeVisible()
    const firstProjectNewAgent = initialPrimaryProjectGroup.getByTestId('code-project-new-agent')
    await expect(firstProjectNewAgent).toBeVisible()
    await firstProjectNewAgent.click()
    await expect(page.getByTestId('code-project-new-agent-menu').getByRole('menuitem', { name: 'bash' })).toBeVisible()
    await expect(page.getByTestId('code-project-agent-launch-codex').locator('.agent-launch-icon-codex')).toBeVisible()
    await expect(page.getByTestId('code-project-agent-launch-claude').locator('.agent-launch-icon-claude')).toBeVisible()
    await expect(page.getByTestId('code-project-agent-launch-bash').locator('.agent-launch-icon-bash')).toBeVisible()
    await expect(page.getByTestId('code-project-agent-launch-zsh').locator('.agent-launch-icon-zsh')).toBeVisible()
    await page.keyboard.press('Escape')

    await openNewAgentDialog(page)
    await page.getByTestId('agent-option-bash').click()
    const invalidWorkspace = path.join(workspaceRoot, 'missing')
    await page.getByTestId('workspace-input').fill(invalidWorkspace)
    await page.getByTestId('workspace-start').click()
    await expect(page.getByTestId('workspace-directory-prompt')).toContainText('Create this workspace?')
    await expect(page.getByTestId('input-dialog')).toBeVisible()
    await expect(page.getByTestId('workspace-input')).toHaveValue(invalidWorkspace)
    expect(fs.existsSync(invalidWorkspace)).toBe(false)
    await page.getByTestId('workspace-directory-cancel').click()
    await page.getByTestId('workspace-back').click()

    await startAgentFromOpenDialog(page, 'bash', childWorkspace)
    const rows = page.getByTestId('code-agent-row')
    await expect(rows).toHaveCount(2, { timeout: 30_000 })
    const primaryAgentId = visibleMainAgentId
    const primaryRow = page.locator(`[data-testid="code-agent-row"][data-agent-id="${primaryAgentId}"]`)
    const activeStartedRows = page.locator('[data-testid="code-agent-row"].active')
    await expect(activeStartedRows).toHaveCount(1)
    const childAgentId = await activeStartedRows.first().getAttribute('data-agent-id')
    if (!childAgentId) throw new Error('Child agent row is missing data-agent-id')
    expect(childAgentId).not.toBe(primaryAgentId)
    const childStartedRow = page.locator(`[data-testid="code-agent-row"][data-agent-id="${childAgentId}"]`)
    resumedCodexAgentId = childAgentId
    const desktopProjectGroups = page.getByTestId('code-project-group')
    const primaryProjectGroup = desktopProjectGroups.filter({ has: page.locator(`[data-agent-id="${primaryAgentId}"]`) })
    const childProjectGroup = desktopProjectGroups.filter({ has: page.locator(`[data-agent-id="${childAgentId}"]`) })
    await expect(primaryProjectGroup).toHaveCount(1)
    await expect(childProjectGroup).toHaveCount(1)
    await expect(primaryProjectGroup.getByTestId('code-files-section')).toHaveCount(1)
    await expect(childProjectGroup.getByTestId('code-files-section')).toHaveCount(1)
    const desktopChildFilesTitle = childProjectGroup.locator('.code-files-title').first()
    await expect(desktopChildFilesTitle).toHaveAttribute('aria-expanded', 'false')
    await desktopChildFilesTitle.click()
    await expect(desktopChildFilesTitle).toHaveAttribute('aria-expanded', 'true')
    await expect(childProjectGroup.getByTestId('code-file-row').filter({ hasText: 'deep' })).toBeVisible()
    const activeCodexSessionRows = page.getByTestId('code-active-session-row').filter({ hasText: 'Deep Codex Session' })
    const pinnedCodexSessionRows = page.getByTestId('code-pinned-section').getByTestId('code-active-session-row').filter({ hasText: 'Deep Codex Session' })
    await expect(activeCodexSessionRows).toHaveCount(1)
    await expect(pinnedCodexSessionRows).toHaveCount(1)
    const pinnedTitle = page.getByTestId('code-pinned-title')
    await expect(pinnedTitle).toHaveAttribute('aria-expanded', 'true')
    await pinnedTitle.click()
    await expect(pinnedTitle).toHaveAttribute('aria-expanded', 'false')
    await expect(page.getByTestId('code-pinned-section').getByTestId('code-active-session-row')).toHaveCount(0)
    await pinnedTitle.click()
    await expect(pinnedTitle).toHaveAttribute('aria-expanded', 'true')
    await expect(pinnedCodexSessionRows).toHaveCount(1)
    await expect(page.getByTestId('code-active-session-row').filter({ hasText: 'Pinned Claude Session' })).toHaveCount(0)
    await expect(page.getByTestId('code-active-session-row').filter({ hasText: 'Visible Codex Session' })).toHaveCount(0)
    await expect(page.getByTestId('code-active-session-row').filter({ hasText: 'Plain Codex Session' })).toHaveCount(0)
    await expect(page.getByTestId('code-active-session-row').filter({ hasText: 'Plain Claude Session' })).toHaveCount(0)
    await expect(childProjectGroup.getByTestId('code-active-session-row')).toHaveCount(0)
    await expect(childProjectGroup.getByTestId('code-active-session-row').filter({ hasText: 'Hidden Codex Session' })).toHaveCount(0)
    const sessionShowMore = childProjectGroup.getByTestId('code-session-show-more')
    await expect(sessionShowMore).toHaveCount(0)
    await expect(childProjectGroup.getByTestId('code-session-show-less')).toHaveCount(0)
    const activeCodexSessionRow = activeCodexSessionRows.first()
    await expect(activeCodexSessionRow.locator('.code-agent-pin')).toHaveCount(0)
    await activeCodexSessionRow.hover()
    const agentPreview = page.getByTestId('code-agent-hover-preview')
    await expect(agentPreview).toBeVisible()
    await expect(agentPreview).toContainText('Deep Codex Session')
    await expect(agentPreview).toContainText(path.basename(childWorkspace))
    await page.mouse.move(900, 500)
    await expect(page.getByTestId('code-agent-hover-preview')).toHaveCount(0)
    await activeCodexSessionRow.focus()
    await expect(page.getByTestId('code-agent-hover-preview')).toHaveCount(0)
    await activeCodexSessionRow.hover()
    await expect(agentPreview).toBeVisible()
    await activeCodexSessionRow.click({ button: 'right' })
    const codexSessionContextMenu = page.getByTestId('code-session-context-menu')
    await expect(codexSessionContextMenu).toBeVisible()
    await expect(codexSessionContextMenu.getByRole('menuitem', { name: 'Open Session' })).toBeFocused()
    await expect(codexSessionContextMenu.getByRole('menuitem', { name: 'Unpin chat' })).toBeVisible()
    await expect(codexSessionContextMenu.getByRole('menuitem', { name: 'Archive' })).toBeVisible()
    await expect(codexSessionContextMenu.getByRole('menuitem', { name: 'Copy working directory' })).toBeVisible()
    await expect(codexSessionContextMenu.getByRole('menuitem', { name: 'Kill Agent' })).toHaveCount(0)
    await expect(codexSessionContextMenu.getByRole('menuitem', { name: 'Rename Agent' })).toHaveCount(0)
    await expect(codexSessionContextMenu.getByRole('menuitem', { name: 'Pin Agent' })).toHaveCount(0)
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(page.url()).origin })
    await codexSessionContextMenu.getByRole('menuitem', { name: 'Copy working directory' }).click()
    await expect(codexSessionContextMenu).toBeHidden()
    await expect(page.getByTestId('code-copy-toast')).toContainText('Copied working directory')
    await expect(activeCodexSessionRow).toBeFocused()
    await expect.poll(async () => page.evaluate(() => navigator.clipboard.readText())).toBe(deepCodexCwd)
    await activeCodexSessionRow.focus()
    await page.keyboard.press('Shift+F10')
    await expect(codexSessionContextMenu).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(codexSessionContextMenu).toBeHidden()
    await expect(activeCodexSessionRow).toBeFocused()
    await expect(primaryRow.locator('kbd')).toHaveCount(0)
    await expect(childStartedRow.locator('kbd')).toHaveCount(0)
    await primaryRow.click()
    await writeTerminalFixture(
      page,
      primaryAgentId,
      '\u001b[1;37m[\u001b[m\u001b[1;32mfarming\u001b[m\u001b[1;33m@\u001b[m\u001b[1;35mdevbox\u001b[m \u001b[4m/home/farming-user\u001b[m\u001b[1;37m]\u001b[m\r\n$ '
    )
    await expect.poll(async () => (await terminalRows(page, primaryAgentId)).join('\n'))
      .toContain('[farming@devbox /home/farming-user]')
    await childStartedRow.click()
    await expect(childStartedRow).toHaveClass(/active/)

    await childStartedRow.dispatchEvent('keydown', { key: 'ArrowUp', code: 'ArrowUp' })
    await expect(primaryRow).toHaveClass(/active/)
    await expect(primaryRow).toBeFocused()
    await primaryRow.dispatchEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown' })
    await expect(childStartedRow).toHaveClass(/active/)
    resumedCodexSessionId = ''
    await childStartedRow.dispatchEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown' })
    await expect.poll(async () => resumedCodexSessionId).toBe('019f0000-0000-7000-8000-000000000099')
    await childStartedRow.click()

    await page.getByRole('button', { name: /Search/ }).click()
    await expect(page.getByTestId('code-search-panel')).toBeVisible()
    await expect(page.getByTestId('code-search-empty')).toHaveCount(0)
    await expect(page.getByTestId('code-search-panel').locator('.code-search-result')).toHaveCount(0)
    await page.getByTestId('code-search-box').locator('input').fill(mainSearchTerm)
    await page.getByTestId('code-new-agent').click()
    await expect(page.getByTestId('input-dialog')).toBeVisible()
    await expect(page.getByTestId('input-dialog')).toHaveAttribute('role', 'dialog')
    await page.getByTestId('input-dialog-close').focus()
    await page.keyboard.press('Shift+Tab')
    await expect.poll(async () => page.evaluate(() => {
      const activeElement = document.activeElement
      return activeElement instanceof HTMLElement
        ? activeElement.closest('[data-testid="input-dialog"]')?.getAttribute('data-testid') ?? null
        : null
    })).toBe('input-dialog')
    await page.keyboard.press('/')
    await expect(page.getByTestId('input-dialog')).toBeVisible()
    await expect(page.getByTestId('code-search-box')).toBeHidden()
    await page.getByTestId('input-dialog-close').click()
    await expect(page.getByTestId('input-dialog')).toBeHidden()
    await expect(page.getByTestId('code-terminal-grid')).toBeVisible()
    await expect(page.getByTestId('code-search-box')).toBeHidden()
    await expect(page.getByTestId('code-nav-search')).not.toHaveClass(/active/)
    await expect(page.getByTestId('code-new-agent')).toBeFocused()

    await page.getByRole('button', { name: /Search/ }).click()
    await expect(page.getByTestId('code-search-panel')).toBeVisible()
    await page.getByTestId('code-search-box').locator('input').fill(mainSearchTerm)
    await page.getByTestId('code-search-box').getByRole('button', { name: 'Clear search' }).click()
    await expect(page.getByTestId('code-terminal-grid')).toBeVisible()
    await expect(page.getByTestId('code-search-box')).toBeHidden()
    await expect(childStartedRow).toBeFocused()

    await page.getByRole('button', { name: /Search/ }).click()
    await expect(page.getByTestId('code-search-panel')).toBeVisible()
    await page.getByTestId('code-search-box').locator('input').fill(mainSearchTerm)
    await page.getByTestId('code-search-box').getByRole('button', { name: 'Clear search' }).click()
    await expect(page.getByTestId('code-terminal-grid')).toBeVisible()
    await expect(page.getByTestId('code-search-box')).toBeHidden()
    await expect(page.getByTestId('code-nav-search')).not.toHaveClass(/active/)

    await page.getByRole('button', { name: /Search/ }).click()
    await expect(page.getByTestId('code-search-panel')).toBeVisible()
    await page.getByTestId('code-search-box').locator('input').fill('child')
    await expect(page.getByTestId('code-project-group')).toHaveCount(2)
    await expect(page.getByTestId('code-project-group').first()).toContainText('child')
    await expect(page.getByTestId('code-project-group').filter({ hasText: 'farming-playwright-main' })).toHaveCount(1)
    await expect(page.getByTestId('code-search-result')).toHaveCount(1)
    await expect(page.getByTestId('code-search-panel')).toContainText('child')
    await expect(page.getByTestId('code-agent-row').first()).toHaveClass(/search-selected/)
    await page.getByTestId('code-search-result').click()
    await expect(page.getByTestId('code-search-box')).toBeHidden()
    await expect(childStartedRow).toHaveClass(/active/)
    await expect(page.getByTestId('code-project-group')).toHaveCount(2)

    await page.getByRole('button', { name: /Search/ }).click()
    await expect(page.getByTestId('code-search-panel')).toBeVisible()
    await page.getByTestId('code-search-box').locator('input').fill('Deep Codex')
    await expect(page.getByTestId('code-session-search-result')).toHaveCount(1)
    await expect(page.getByTestId('code-session-search-result').first()).toHaveClass(/active/)
    await page.getByTestId('code-search-box').locator('input').press('Enter')
    await expect.poll(async () => resumedCodexSessionId).toBe('019f0000-0000-7000-8000-000000000099')
    await expect(page.getByTestId('code-search-box')).toBeHidden()

    resumedCodexSessionId = ''
    await page.getByRole('button', { name: /Search/ }).click()
    await expect(page.getByTestId('code-search-panel')).toBeVisible()
    await page.getByTestId('code-search-box').locator('input').fill('Plain Codex')
    await expect(page.getByTestId('code-session-search-result')).toHaveCount(1)
    await expect(page.getByTestId('code-session-search-result').first()).toHaveClass(/active/)
    await page.getByTestId('code-search-box').locator('input').press('Enter')
    await expect.poll(async () => resumedCodexSessionId).toBe('019f0000-0000-7000-8000-000000000101')
    await expect(page.getByTestId('code-search-box')).toBeHidden()
    await expect(page.getByTestId('code-active-session-row').filter({ hasText: 'Plain Codex Session' })).toHaveCount(1)

    resumedClaudeSessionId = ''
    await page.getByRole('button', { name: /Search/ }).click()
    await expect(page.getByTestId('code-search-panel')).toBeVisible()
    await page.getByTestId('code-search-box').locator('input').fill('Plain Claude')
    await expect(page.getByTestId('code-session-search-result')).toHaveCount(1)
    await expect(page.getByTestId('code-session-search-result').first()).toHaveClass(/active/)
    await page.getByTestId('code-search-box').locator('input').press('Enter')
    await expect.poll(async () => resumedClaudeSessionId).toBe('11111111-2222-4333-8444-666666666666')
    await expect(page.getByTestId('code-search-box')).toBeHidden()
    await expect(page.getByTestId('code-active-session-row').filter({ hasText: 'Plain Claude Session' })).toHaveCount(1)

    await page.getByRole('button', { name: /Search/ }).click()
    await expect(page.getByTestId('code-search-panel')).toBeVisible()
    await page.getByTestId('code-search-box').locator('input').fill(mainSearchTerm)
    await page.getByTestId('code-search-box').locator('input').dispatchEvent('keydown', {
      key: ',',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    })
    await expect(page.getByTestId('settings-panel')).toHaveCount(0)
    await expect(page.getByTestId('code-search-panel')).toBeVisible()
    await expect(page.getByTestId('code-search-box')).toBeVisible()
    await expect(page.getByTestId('code-nav-search')).toHaveClass(/active/)
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('code-terminal-grid')).toBeVisible()

    await page.getByRole('button', { name: /Search/ }).click()
    await page.getByTestId('code-search-box').locator('input').fill(mainSearchTerm)
    await expect(page.getByTestId('code-search-panel')).toContainText(mainSearchTerm)
    await page.getByTestId('code-search-box').locator('input').press('Enter')
    await expect(page.getByTestId('code-search-box')).toBeHidden()
    await expect(page.getByTestId('code-terminal-grid')).toBeVisible()
    await expect(page.getByTestId('code-terminal-pane')).toHaveCount(1)
    await expect(primaryRow).toHaveClass(/active/)

    await page.getByTestId('code-nav-history').click()
    await expect(page.getByTestId('code-history-panel')).toBeVisible()
    const historyHeader = page.locator('.code-history-panel-header')
    const historySearchInput = page.getByTestId('code-history-search-box').locator('input')
    await expect(historyHeader.getByTestId('code-history-search-box')).toBeVisible()
    const archivedCodexSessionCard = page.getByTestId('code-session-history-card').filter({ hasText: 'Archived Codex Session' })
    await expect(archivedCodexSessionCard).toHaveCount(1)
    await expect(archivedCodexSessionCard.first()).toContainText(childWorkspaceDisplay)
    await expect(archivedCodexSessionCard.first()).not.toContainText(deepCodexCwdDisplay)
    await expect(archivedCodexSessionCard.first()).not.toContainText('resume codex:019f00...000100')
    await expect(page.getByTestId('code-session-history-card').filter({ hasText: 'Deep Codex Session' })).toHaveCount(0)
    await expect(page.getByTestId('code-session-history-card').filter({ hasText: 'Plain Codex Session' })).toHaveCount(0)
    await expect(page.getByTestId('code-session-history-card').filter({ hasText: 'Pinned Claude Session' })).toHaveCount(1)
    await historySearchInput.fill('archived codex')
    await expect(archivedCodexSessionCard).toHaveCount(1)
    await expect(page.getByTestId('code-session-history-card').filter({ hasText: 'Pinned Claude Session' })).toHaveCount(0)
    await historySearchInput.fill('not-a-real-history-agent')
    await expect(page.getByTestId('code-empty-history-search')).toBeVisible()
    await page.getByTestId('code-history-search-box').getByRole('button', { name: 'Clear search' }).click()
    await expect(archivedCodexSessionCard).toHaveCount(1)
    await expect(page.getByTestId('code-session-history-card').filter({ hasText: 'Pinned Claude Session' })).toHaveCount(1)
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('code-terminal-grid')).toBeVisible()
    await expect(primaryRow).toBeFocused()

    await expect(page.getByTestId('code-nav-settings')).toHaveCount(0)
    await expect(page.getByTestId('settings-panel')).toHaveCount(0)
    await expect(page.getByTestId('code-terminal-grid')).toBeVisible()
    await expect(primaryRow).toBeFocused()
    if (await page.getByTestId('code-composer-approval').count() > 0) {
      await expect(page.getByTestId('code-composer-approval')).toBeVisible()
      const composerControlBoxes = await Promise.all([
        page.getByTestId('code-composer-add'),
        page.getByTestId('code-composer-approval'),
        page.getByTestId('code-composer-model-picker'),
        page.getByTestId('code-composer-mic'),
        page.getByTestId('code-composer-send'),
      ].map(async locator => {
        const box = await locator.boundingBox()
        if (!box) throw new Error('Composer control is not visible')
        return box
      }))
      const composerControlCenters = composerControlBoxes.map(box => box.y + box.height / 2)
      expect(Math.max(...composerControlCenters) - Math.min(...composerControlCenters)).toBeLessThanOrEqual(3)
      const composerToolbarBox = await page.getByTestId('code-composer-toolbar').boundingBox()
      if (!composerToolbarBox) throw new Error('Composer toolbar is not visible')
      expect(composerToolbarBox.height).toBeLessThanOrEqual(38)
      expect((await page.getByTestId('code-composer-model-picker').boundingBox())?.width ?? 999).toBeLessThanOrEqual(190)
      await page.getByTestId('code-composer-approval').click()
      const approvalMenu = page.getByTestId('code-approval-menu')
      await expect(approvalMenu.getByText('How should this agent handle permissions?')).toBeVisible()
      const approvalMenuBox = await approvalMenu.boundingBox()
      if (!approvalMenuBox) throw new Error('Approval menu is not visible')
      expect(approvalMenuBox.width).toBeLessThanOrEqual(560)
      expect(approvalMenuBox.height).toBeLessThanOrEqual(270)
      await expect.poll(async () => page.evaluate(() => {
        const menu = document.querySelector('[data-testid="code-approval-menu"]')
        if (!(menu instanceof HTMLElement)) return false
        const rect = menu.getBoundingClientRect()
        const topmost = document.elementFromPoint(rect.left + 24, rect.top + 24)
        return topmost instanceof Node && menu.contains(topmost)
      })).toBe(true)
      const approvalMenuImage = await page.screenshot({
        animations: 'disabled',
        clip: {
          x: approvalMenuBox.x,
          y: approvalMenuBox.y,
          width: approvalMenuBox.width,
          height: approvalMenuBox.height,
        },
      })
      expect(approvalMenuImage).toMatchSnapshot('desktop-composer-approval-menu.png')
      await approvalMenu.getByRole('menuitemradio', { name: /Ask for approval/ }).click()
      await expect(page.getByTestId('code-composer').locator('textarea')).toBeFocused()
      await expect(page.getByTestId('code-composer-approval')).toContainText('Ask for approval')
      await expect.poll(async () => {
        const response = await page.request.get('/farming/api/settings')
        const data = await response.json()
        return data.settings?.codexApprovalMode
      }).toBe('ask')
      await page.getByTestId('code-composer-approval').click()
      await page.getByTestId('code-approval-menu').getByRole('menuitemradio', { name: /Approve for me/ }).click()
      await expect(page.getByTestId('code-composer').locator('textarea')).toBeFocused()
      await expect.poll(async () => {
        const response = await page.request.get('/farming/api/settings')
        const data = await response.json()
        return data.settings?.codexApprovalMode
      }).toBe('approve')
      await expect(page.getByTestId('code-composer-model-picker')).toBeVisible()
      await page.getByTestId('code-composer-model-picker').click()
      await expect(page.getByTestId('code-model-menu')).toBeVisible()
      if (process.platform === 'darwin') {
        await expect(page.getByTestId('code-model-menu')).toHaveScreenshot('desktop-composer-model-menu.png')
      }
      const modelTriggerBox = await page.getByTestId('code-model-submenu-trigger').boundingBox()
      if (!modelTriggerBox) throw new Error('Model submenu trigger is not visible')
      await page.getByTestId('code-model-submenu-trigger').click()
      await expect(page.getByTestId('code-model-submenu')).toBeVisible()
      const modelSubmenuBox = await page.getByTestId('code-model-submenu').boundingBox()
      if (!modelSubmenuBox) throw new Error('Model submenu is not visible')
      expect(Math.abs((modelSubmenuBox.y + modelSubmenuBox.height) - (modelTriggerBox.y + modelTriggerBox.height))).toBeLessThanOrEqual(4)
      expect(modelSubmenuBox.y).toBeLessThan(modelTriggerBox.y)
      if (process.platform === 'darwin') {
        await expect(page.getByTestId('code-model-submenu')).toHaveScreenshot('desktop-composer-gpt-menu.png')
      }
      await page.getByTestId('code-model-submenu').getByRole('menuitemradio').first().click()
      await expect(page.getByTestId('code-composer').locator('textarea')).toBeFocused()
      await page.getByTestId('code-composer-model-picker').click()
      await expect(page.getByTestId('code-model-menu')).toBeVisible()
      await page.getByTestId('code-model-menu').getByRole('menuitemradio', { name: /^High$/ }).click()
      await expect(page.getByTestId('code-composer').locator('textarea')).toBeFocused()
      await page.getByTestId('code-composer-model-picker').click()
      await expect(page.getByTestId('code-model-menu')).toBeVisible()
      await page.getByTestId('code-speed-submenu-trigger').click()
      await expect(page.getByTestId('code-speed-submenu')).toBeVisible()
      if (process.platform === 'darwin') {
        await expect(page.getByTestId('code-speed-submenu')).toHaveScreenshot('desktop-composer-speed-menu.png')
      }
      const defaultSpeedOption = page.getByTestId('code-speed-submenu').getByRole('menuitemradio', { name: /^Default$/ })
      await expect(defaultSpeedOption).toBeFocused()
      await defaultSpeedOption.press('ArrowDown')
      await expect(page.getByTestId('code-speed-submenu').getByRole('menuitemradio', { name: /^Fast$/ })).toBeFocused()
      await page.keyboard.press('Enter')
      await expect(page.getByTestId('code-composer').locator('textarea')).toBeFocused()
      await expect(page.getByTestId('code-composer-model-picker').locator('.code-composer-speed-active')).toHaveCount(1)
      await expect.poll(async () => {
        const response = await page.request.get('/farming/api/settings')
        const data = await response.json()
        return {
          model: data.settings?.codexModel,
          effort: data.settings?.codexReasoningEffort,
          serviceTier: data.settings?.codexServiceTier,
          preset: data.settings?.codexModelPreset,
        }
      }).toEqual({
        model: 'gpt-5.5',
        effort: 'high',
        serviceTier: 'priority',
        preset: 'gpt-5.5:high',
      })
      await page.getByTestId('code-composer-approval').click()
      await expect(page.getByTestId('code-approval-menu')).toBeVisible()
      await page.keyboard.press('End')
      await expect(page.getByTestId('code-approval-menu').getByRole('menuitemradio', { name: /Custom/ })).toBeFocused()
      await page.keyboard.press('Tab')
      await expect(page.getByTestId('code-approval-menu')).toBeHidden()
      await expect(page.getByTestId('code-composer-model-picker')).toBeFocused()
      await page.getByTestId('code-composer-approval').click()
      await expect(page.getByTestId('code-approval-menu')).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(page.getByTestId('code-approval-menu')).toBeHidden()
      await expect(page.getByTestId('code-composer').locator('textarea')).toBeFocused()
      await page.keyboard.type('approval escaped')
      await expect(page.getByTestId('code-composer').locator('textarea')).toHaveValue('approval escaped')
      await page.getByTestId('code-composer').locator('textarea').fill('')
      await page.getByTestId('code-composer-model-picker').click()
      await expect(page.getByTestId('code-model-menu')).toBeVisible()
      await page.keyboard.press('End')
      await expect(page.getByTestId('code-speed-submenu-trigger')).toBeFocused()
      await page.keyboard.press('Tab')
      await expect(page.getByTestId('code-model-menu')).toBeHidden()
      await expect(page.getByTestId('code-composer-mic')).toBeFocused()
      await page.getByTestId('code-composer-model-picker').click()
      await expect(page.getByTestId('code-model-menu')).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(page.getByTestId('code-model-menu')).toBeHidden()
      await expect(page.getByTestId('code-composer').locator('textarea')).toBeFocused()
      await page.keyboard.type('model escaped')
      await expect(page.getByTestId('code-composer').locator('textarea')).toHaveValue('model escaped')
      await page.getByTestId('code-composer').locator('textarea').fill('')
      await page.keyboard.type('array[0] / literal')
      await expect(page.getByTestId('code-composer').locator('textarea')).toHaveValue('array[0] / literal')
      await expect(page.getByTestId('code-search-panel')).toBeHidden()
      await page.getByTestId('code-composer').locator('textarea').fill('')
      await page.getByTestId('code-composer-add').click()
      await expect(page.getByTestId('code-composer-plus-menu')).toBeVisible()
      if (process.platform === 'darwin') {
        await expect(page.getByTestId('code-composer-plus-menu')).toHaveScreenshot('desktop-composer-plus-menu.png')
      }
      await expect(page.getByTestId('code-composer-attach-file')).toBeFocused()
      const fileChooserPromise = page.waitForEvent('filechooser')
      await page.getByTestId('code-composer-attach-file').click()
      const fileChooser = await fileChooserPromise
      await fileChooser.setFiles({
        name: 'note.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('attached note'),
      })
      await expect(page.getByTestId('code-composer').locator('textarea')).toHaveValue(/Attached file: note\.txt[\s\S]*attached note/)
      await expect(page.getByTestId('code-composer').locator('textarea')).toBeFocused()
      await page.getByTestId('code-composer-file-input').dispatchEvent('cancel')
      await expect(page.getByTestId('code-composer').locator('textarea')).toBeFocused()
      await page.getByTestId('code-composer').locator('textarea').fill('')
      await page.getByTestId('code-composer-add').click()
      await expect(page.getByTestId('code-composer-attach-file')).toBeFocused()
      await page.keyboard.press('Escape')
      await expect(page.getByTestId('code-composer-plus-menu')).toBeHidden()
      await expect(page.getByTestId('code-composer').locator('textarea')).toBeFocused()
      await page.keyboard.type('after escape')
      await expect(page.getByTestId('code-composer').locator('textarea')).toHaveValue('after escape')
      await page.getByTestId('code-composer').locator('textarea').fill('')
      await page.getByTestId('code-composer-add').click()
      await expect(page.getByTestId('code-composer-plus-menu')).toBeVisible()
      await expect(page.getByTestId('code-composer-attach-file')).toBeFocused()
      await page.keyboard.press('Tab')
      await expect(page.getByTestId('code-composer-goal-mode')).toBeFocused()
      await expect(page.getByTestId('code-composer-plus-menu')).toBeVisible()
      await page.keyboard.press('Tab')
      await expect(page.getByTestId('code-composer-plan-mode')).toBeFocused()
      await page.keyboard.press('Tab')
      await expect(page.getByTestId('code-composer-plus-menu')).toBeHidden()
      await expect(page.getByTestId('code-composer-approval')).toBeFocused()
      await page.getByTestId('code-composer-add').click()
      await expect(page.getByTestId('code-composer-plus-menu')).toBeVisible()
      await expect(page.getByTestId('code-composer-attach-file')).toBeFocused()
      await page.keyboard.press('n')
      await expect(page.getByTestId('input-dialog')).toBeHidden()
      await expect(page.getByTestId('code-composer-plus-menu')).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(page.getByTestId('code-composer-plus-menu')).toBeHidden()
      await expect(page.getByTestId('code-composer').locator('textarea')).toBeFocused()
      await page.getByTestId('code-composer').locator('textarea').fill('single line')
      const singleLineComposerHeight = await page.getByTestId('code-composer').locator('textarea').evaluate(element => element.getBoundingClientRect().height)
      await page.getByTestId('code-composer').locator('textarea').fill('one\ntwo\nthree\nfour')
      await expect.poll(async () => (
        page.getByTestId('code-composer').locator('textarea').evaluate(element => element.getBoundingClientRect().height)
      )).toBeGreaterThan(singleLineComposerHeight + 20)
      await page.getByTestId('code-composer').locator('textarea').fill('')
      await expect.poll(async () => (
        page.getByTestId('code-composer').locator('textarea').evaluate(element => element.getBoundingClientRect().height)
      )).toBeLessThan(singleLineComposerHeight + 10)
      await page.getByTestId('code-composer').locator('textarea').fill('modifier enter')
      await page.keyboard.press('Control+Enter')
      await expect(page.getByTestId('code-composer').locator('textarea')).toHaveValue(/modifier enter/)
      await page.getByTestId('code-composer').locator('textarea').fill('')
      await page.keyboard.type('line one')
      await page.keyboard.press('Shift+Enter')
      await page.keyboard.type('line two')
      await expect(page.getByTestId('code-composer').locator('textarea')).toHaveValue('line one\nline two')
      await page.getByTestId('code-composer').locator('textarea').fill('')
      await page.getByTestId('code-composer-add').click()
      await expect(page.getByTestId('code-composer-attach-file')).toBeFocused()
      await page.keyboard.press('ArrowDown')
      await expect(page.getByTestId('code-composer-goal-mode')).toBeFocused()
      await page.keyboard.press('ArrowDown')
      await expect(page.getByTestId('code-composer-plan-mode')).toBeFocused()
      await page.keyboard.press('Enter')
      await expect(page.getByTestId('code-composer-mode-chip')).toHaveText(/Plan/)
      await expect(page.getByTestId('code-composer').locator('textarea')).toHaveAttribute('placeholder', 'Describe what should be planned first')
      await expect(page.getByTestId('code-composer').locator('textarea')).toBeFocused()
      await page.keyboard.type('plan this next')
      await expect(page.getByTestId('code-composer').locator('textarea')).toHaveValue('plan this next')
      await page.getByTestId('code-composer').locator('textarea').fill('')
      await page.getByTestId('code-composer-mode-chip').click()
      await expect(page.getByTestId('code-composer').locator('textarea')).toBeFocused()
      await page.getByTestId('code-composer-add').click()
      await page.getByTestId('code-composer-goal-mode').click()
      await expect(page.getByTestId('code-composer-mode-chip')).toHaveText(/Goal/)
      await expect(page.getByTestId('code-composer').locator('textarea')).toBeFocused()
      await page.getByTestId('code-composer-mode-chip').click()
      await expect(page.getByTestId('code-composer').locator('textarea')).toBeFocused()
      await page.getByTestId('code-composer-mic').click()
      await page.evaluate(() => {
        const instance = (window as unknown as {
          __mockSpeechRecognition?: {
            onresult: ((event: unknown) => void) | null
            onend: (() => void) | null
          }
        }).__mockSpeechRecognition
        instance?.onresult?.({
          resultIndex: 0,
          results: {
            length: 1,
            0: {
              isFinal: true,
              0: { transcript: 'voice message' },
            },
          },
        })
        instance?.onend?.()
      })
      await expect(page.getByTestId('code-composer').locator('textarea')).toHaveValue('voice message')
      await expect(page.getByTestId('code-composer').locator('textarea')).toBeFocused()
      await page.getByTestId('code-composer').locator('textarea').fill('')
    }
    await page.getByTestId('code-terminal-pane').first().click()
    await page.keyboard.press('Control+,')
    await expect(page.getByTestId('settings-panel')).toHaveCount(0)
    await expect(page.getByTestId('code-terminal-grid')).toBeVisible()
    await page.getByTestId('code-nav-search').dispatchEvent('keydown', {
      key: 's',
      bubbles: true,
      cancelable: true,
    })
    await expect(page.getByTestId('settings-panel')).toBeHidden()
    await expect(page.getByTestId('code-terminal-grid')).toBeVisible()

    const sidebarExpandedBox = await page.getByTestId('code-sidebar').boundingBox()
    if (!sidebarExpandedBox) throw new Error('Sidebar is missing before collapse')
    await page.getByTestId('code-sidebar-toggle').click()
    await expect(page.getByTestId('code-workspace')).toHaveClass(/sidebar-collapsed/)
    await expect(page.getByTestId('code-project-list')).toBeHidden()
    await expect(page.getByTestId('code-terminal-grid')).toBeVisible()
    await expect(page.getByTestId('code-nav-search')).toHaveCount(0)
    await expect(page.getByTestId('code-nav-history')).toHaveCount(0)
    await expect.poll(async () => (await page.getByTestId('code-sidebar').boundingBox())?.width ?? 0).toBeLessThanOrEqual(52)
    const collapsedAgentRailMetrics = await page.getByTestId('code-agent-rail-item').first().evaluate(element => {
      const rect = (element as HTMLElement).getBoundingClientRect()
      const label = element.querySelector<HTMLElement>('.code-agent-rail-label')
      return { width: rect.width, height: rect.height, fontSize: label ? getComputedStyle(label).fontSize : '' }
    })
    expect(collapsedAgentRailMetrics.width).toBe(42)
    expect(collapsedAgentRailMetrics.height).toBe(42)
    expect(collapsedAgentRailMetrics.fontSize).toBe('12px')
    await page.getByTestId('code-sidebar-toggle').click()
    await expect(page.getByTestId('code-workspace')).not.toHaveClass(/sidebar-collapsed/)
    await expect(page.getByTestId('code-project-list')).toBeVisible()
    await expect.poll(async () => (await page.getByTestId('code-sidebar').boundingBox())?.width ?? 0).toBeGreaterThan(sidebarExpandedBox.width - 5)

    const childProjectTitle = page.getByTestId('code-project-title').filter({ hasText: 'child' })
    await childProjectTitle.click()
    await expect(page.getByTestId('code-agent-row')).toHaveCount(1)
    await childProjectTitle.click()
    await expect(page.getByTestId('code-agent-row')).toHaveCount(2)
    await childProjectTitle.click({ button: 'right' })
    const childProjectMenu = page.getByTestId('code-project-context-menu')
    await expect(childProjectMenu.getByRole('menuitem')).toHaveCount(3)
    await expect(childProjectMenu.getByRole('menuitem', { name: 'Rename project' })).toBeVisible()
    await expect(childProjectMenu.getByRole('menuitem', { name: 'Archive chats' })).toBeVisible()
    await expect(childProjectMenu.getByRole('menuitem', { name: 'Remove Project' })).toBeDisabled()
    await page.keyboard.press('Escape')
    await expect(childProjectMenu).toBeHidden()
    await expect(childProjectTitle).toBeVisible()

    const agentId = childAgentId
    const childRow = page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
    await childRow.click()
    await page.getByTestId('code-new-agent').click()
    await expect(page.getByTestId('input-dialog')).toBeVisible()
    await page.getByTestId('agent-option-bash').click()
    await expect(page.getByTestId('workspace-input')).toHaveValue(childWorkspace)
    await page.getByTestId('input-dialog-close').click()
    await expect(page.getByTestId('input-dialog')).toBeHidden()
    const desktopClickMarker = `desktop-click-${Date.now()}`
    await page.getByTestId('code-composer').locator('textarea').fill(`echo ${desktopClickMarker}`)
    await page.getByTestId('code-composer-send').click()
    await expect(page.getByTestId('code-composer').locator('textarea')).toHaveValue('')
    await expect.poll(async () => {
      const response = await page.request.get(`/farming/api/agents/${agentId}/session-view`)
      const data = await response.json()
      return [
        data.session?.output,
        data.session?.renderOutput,
        data.session?.previewText,
      ].filter(Boolean).join('\n')
    }).toContain(desktopClickMarker)
    const desktopChildMarker = `desktop-child-${Date.now()}`
    const desktopComposerInput = page.getByTestId('code-composer').locator('textarea')
    await expect(page.getByTestId('input-dialog')).toBeHidden()
    await desktopComposerInput.click()
    await desktopComposerInput.fill(`echo ${desktopChildMarker}`)
    await desktopComposerInput.press('Enter')
    await expect(desktopComposerInput).toHaveValue('')
    await expect.poll(async () => {
      const response = await page.request.get(`/farming/api/agents/${agentId}/session-view`)
      const data = await response.json()
      return [
        data.session?.output,
        data.session?.renderOutput,
        data.session?.previewText,
      ].filter(Boolean).join('\n')
    }).toContain(desktopChildMarker)
    await primaryRow.click()
    const desktopMainMarker = `desktop-main-${Date.now()}`
    await page.getByTestId('code-composer').locator('textarea').fill(`echo ${desktopMainMarker}`)
    await page.getByTestId('code-composer').locator('textarea').press('Enter')
    await expect.poll(async () => {
      const response = await page.request.get(`/farming/api/agents/${primaryAgentId}/session-view`)
      const data = await response.json()
      return [
        data.session?.output,
        data.session?.renderOutput,
        data.session?.previewText,
      ].filter(Boolean).join('\n')
    }).toContain(desktopMainMarker)
    await childRow.click()
    const terminalHostForAgent = (id: string) => page.locator(`[data-testid="code-terminal-pane"][data-agent-id="${id}"] .terminal-session-host[data-agent-id="${id}"]`)
    let terminalHost = terminalHostForAgent(agentId)
    await expect(terminalHost).toBeVisible({ timeout: 20_000 })
    await terminalHost.dispatchEvent('keydown', { key: '0', bubbles: true, cancelable: true })
    await expect(childRow).toHaveClass(/active/)
    await terminalHost.dispatchEvent('keydown', { key: '0', ctrlKey: true, bubbles: true, cancelable: true })
    await expect(childRow).toHaveClass(/active/)
    await primaryRow.click()
    await expect(primaryRow).toHaveClass(/active/)
    terminalHost = terminalHostForAgent(primaryAgentId)
    await expect(terminalHost).toBeVisible({ timeout: 20_000 })
    await terminalHost.dispatchEvent('keydown', { key: '1', ctrlKey: true, bubbles: true, cancelable: true })
    await expect(primaryRow).toHaveClass(/active/)
    await childRow.click()
    await expect(childRow).toHaveClass(/active/)
    terminalHost = terminalHostForAgent(agentId)
    await expect(terminalHost).toBeVisible({ timeout: 20_000 })
    await terminalHost.dispatchEvent('keydown', { key: '/', bubbles: true, cancelable: true })
    await expect(page.getByTestId('code-search-panel')).toBeHidden()
    await terminalHost.dispatchEvent('keydown', { key: '[', bubbles: true, cancelable: true })
    await expect(childRow).toHaveClass(/active/)
    await page.getByTestId('code-project-list').focus()
    await page.keyboard.press('[')
    await expect(childRow).toHaveClass(/active/)
    const projectList = page.getByTestId('code-project-list')
    for (const modifier of ['ctrlKey', 'metaKey', 'altKey', 'shiftKey'] as const) {
      await projectList.dispatchEvent('keydown', {
        key: '/',
        [modifier]: true,
        bubbles: true,
        cancelable: true,
      })
      await expect(page.getByTestId('code-search-panel')).toBeHidden()
    }
    await projectList.dispatchEvent('keydown', { key: '/', bubbles: true, cancelable: true })
    await expect(page.getByTestId('code-search-panel')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('code-terminal-grid')).toBeVisible()
    await terminalHost.dispatchEvent('keydown', { key: '[', metaKey: true, bubbles: true, cancelable: true })
    await expect(childRow).toHaveClass(/active/)
    await primaryRow.click()
    await expect(primaryRow).toHaveClass(/active/)
    terminalHost = terminalHostForAgent(primaryAgentId)
    await expect(terminalHost).toBeVisible({ timeout: 20_000 })
    await terminalHost.dispatchEvent('keydown', { key: ']', metaKey: true, bubbles: true, cancelable: true })
    await expect(primaryRow).toHaveClass(/active/)
    await childRow.click()
    await expect(childRow).toHaveClass(/active/)
    terminalHost = terminalHostForAgent(agentId)
    await expect(terminalHost).toBeVisible({ timeout: 20_000 })
    await terminalHost.dispatchEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true, cancelable: true })
    await expect(page.getByTestId('code-workspace')).not.toHaveClass(/sidebar-collapsed/)
    await terminalHost.dispatchEvent('keydown', { key: ',', ctrlKey: true, bubbles: true, cancelable: true })
    await expect(page.getByTestId('settings-panel')).toHaveCount(0)
    await expect(page.getByTestId('code-terminal-grid')).toBeVisible()
    if (process.platform === 'darwin') {
      await expect(page.getByTestId('code-main')).toHaveScreenshot('desktop-shell-with-agent-card.png', {
        mask: [
          page.locator('.code-terminal-container'),
        ],
      })
    }

    const childFileSection = childProjectGroup.getByTestId('code-files-section')
    const filesTitle = childFileSection.locator('.code-files-title').first()
    if (await filesTitle.getAttribute('aria-expanded') !== 'true') {
      await filesTitle.click()
    }
    await expect(filesTitle).toHaveAttribute('aria-expanded', 'true')
    await filesTitle.click()
    await expect(filesTitle).toHaveAttribute('aria-expanded', 'false')
    await expect(childFileSection.getByPlaceholder('Search or path:line')).toHaveCount(0)
    await expect(childFileSection.getByTestId('code-file-row')).toHaveCount(0)
    await filesTitle.click()
    await expect(filesTitle).toHaveAttribute('aria-expanded', 'true')
    const childDirectoryRow = childFileSection.locator('[data-testid="code-file-row"][data-file-path="deep"]')
    await expect(childDirectoryRow).toBeVisible()
    await childDirectoryRow.click({ button: 'right' })
    const fileContextMenu = page.getByTestId('code-file-context-menu')
    await expect(fileContextMenu).toBeVisible()
    await expect(fileContextMenu.getByRole('menuitem', { name: 'New File' })).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await expect(fileContextMenu.getByRole('menuitem', { name: 'New Folder' })).toBeFocused()
    await page.keyboard.press('End')
    await expect(fileContextMenu.getByRole('menuitem', { name: 'Delete' })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(fileContextMenu).toBeHidden()
    await expect(childDirectoryRow).toHaveClass(/selected/)
    await expect(childFileSection.locator('[role="tree"]')).toBeFocused()

    await expect(page.locator('.code-thread-tab')).toHaveCount(0)
    await expect(page.locator('.code-terminal-actions')).toHaveCount(0)
    await expect(page.getByTestId('code-terminal-maximize')).toHaveCount(0)
    await expect(page.getByTestId('code-terminal-pane')).toHaveCount(1)

    if (await page.getByTestId('input-dialog').isVisible().catch(() => false)) {
      await page.getByTestId('input-dialog-close').click()
      await expect(page.getByTestId('input-dialog')).toBeHidden()
    }
    if (!(await childRow.isVisible().catch(() => false))) {
      await childProjectTitle.click()
    }
    await expect(childRow).toBeVisible()
    await childRow.dispatchEvent('keydown', {
      key: 'ContextMenu',
      bubbles: true,
      cancelable: true,
    })
    const agentContextMenu = page.getByTestId('code-agent-context-menu')
    await expect(agentContextMenu).toBeVisible()
    await expect(agentContextMenu.getByRole('menuitem', { name: 'Pin Agent' })).toBeFocused()
    if (process.platform === 'darwin') {
      await expect(agentContextMenu).toHaveScreenshot('desktop-agent-context-menu.png')
    }
    const agentMenuBox = await agentContextMenu.boundingBox()
    if (!agentMenuBox) throw new Error('Agent context menu is not visible')
    expect(agentMenuBox.width).toBeLessThanOrEqual(224)
    expect(agentMenuBox.height).toBeLessThanOrEqual(340)
    await expect(page.getByRole('menuitem', { name: 'Open Terminal' })).toHaveCount(0)
    await expect(page.getByRole('menuitem', { name: 'Pin Agent' })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: 'Rename Agent' })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: 'New Agent in Project' })).toHaveCount(0)
    await expect(page.getByRole('menuitem', { name: 'Copy working directory' })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: 'Copy session ID' })).toHaveCount(0)
    await expect(page.getByRole('menuitem', { name: 'Copy deeplink' })).toHaveCount(0)
    await expect(page.getByRole('menuitem', { name: 'Fork into same worktree' })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: 'Fork into new worktree' })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: 'Open in new window' })).toHaveCount(0)
    await expect(page.getByRole('menuitem', { name: 'Close Terminal' })).toHaveCount(0)
    await expect(page.getByRole('menuitem', { name: 'Archive' })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: 'Kill Agent' })).toHaveCount(0)
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(page.url()).origin })
    await page.getByRole('menuitem', { name: 'Copy working directory' }).click()
    await expect(page.getByTestId('code-agent-context-menu')).toBeHidden()
    await expect(page.getByTestId('code-copy-toast')).toContainText('Copied working directory')
    await expect.poll(async () => page.evaluate(() => navigator.clipboard.readText())).toBe(childWorkspace)
    await childRow.click({ button: 'right' })
    await expect(page.getByTestId('code-agent-context-menu')).toBeVisible()
    await page.keyboard.press('Tab')
    await expect(page.getByTestId('code-agent-context-menu')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('code-agent-context-menu')).toBeHidden()
    await childRow.click({ button: 'right' })
    await expect(page.getByTestId('code-agent-context-menu')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('code-agent-context-menu')).toBeHidden()
    await childRow.dispatchEvent('keydown', {
      key: 'ContextMenu',
      bubbles: true,
      cancelable: true,
    })
    await expect(page.getByTestId('code-agent-context-menu')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('code-agent-context-menu')).toBeHidden()
    await childRow.click({ button: 'right' })
    await expect(page.getByTestId('code-agent-context-menu')).toBeVisible()
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('n')
    await expect(page.getByTestId('input-dialog')).toBeHidden()
    await expect(page.getByTestId('code-agent-context-menu')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('code-agent-context-menu')).toBeHidden()

    await childRow.click()
    await expect(page.getByTestId('code-terminal-pane')).toHaveCount(1)
    await expect(childRow).toHaveClass(/active/)
    const childRowBox = await childRow.boundingBox()
    if (!childRowBox) throw new Error('Child row is not visible for context menu')
    await childRow.dispatchEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      button: 2,
      clientX: childRowBox.x + 16,
      clientY: childRowBox.y + 16,
    })
    await expect(page.getByTestId('code-agent-context-menu')).toBeVisible()
    await expect(page.getByRole('menuitem', { name: 'Close Terminal' })).toHaveCount(0)
    await expect(page.getByRole('menuitem', { name: 'Archive' })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: 'Kill Agent' })).toHaveCount(0)
    await expect(page.getByTestId('input-dialog')).toBeHidden()
    await page.keyboard.press('/')
    await expect(page.getByTestId('code-agent-context-menu')).toBeVisible()
    await expect(page.getByTestId('code-search-panel')).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('code-agent-context-menu')).toBeHidden()
    await expect(childRow).toBeFocused()
    await expect(childRow).toBeVisible()
    await childRow.click()
    await expect(childRow).toHaveClass(/active/)
    await expect(page.getByTestId('code-terminal-container').locator('.terminal-session-host').last()).toBeVisible({ timeout: 20_000 })
    await writeTerminalFixture(page, agentId, '$ echo farming-playwright\nfarming-playwright\n$ ')
    await expect.poll(async () => (await terminalRows(page, agentId)).join('\n')).toContain('farming-playwright')
    const desktopTerminalPane = page.getByTestId('code-terminal-pane').last()
    if (process.platform === 'darwin') {
      await expect(desktopTerminalPane).toHaveScreenshot('desktop-session-modal-terminal.png', {
        mask: [
          desktopTerminalPane.locator('.code-terminal-container'),
        ],
      })
    }

    const scrollbackFixture = `${Array.from({ length: 120 }, (_, index) => `scroll-lock-line-${String(index).padStart(3, '0')}`).join('\r\n')}\r\n$ `
    await writeTerminalFixture(page, agentId, scrollbackFixture)
    await scrollTerminalToLine(page, agentId, 0)
    const pausedViewport = await terminalViewport(page, agentId)
    expect(pausedViewport.scrollbackLength).toBeGreaterThan(0)
    expect(pausedViewport.following).toBe(false)
    await expect(page.getByTestId('code-terminal-jump-bottom')).toBeVisible()
    const pausedWriteSample = await writeTerminalRawAndSampleViewport(page, agentId, '\r\nnew output while user is reading older terminal text\r\n$ ')
    expect(pausedWriteSample.during).toBeGreaterThan(0)
    expect(pausedWriteSample.after).toBeGreaterThanOrEqual(pausedViewport.viewportY)
    const stillPausedViewport = await terminalViewport(page, agentId)
    expect(stillPausedViewport.viewportY).toBeGreaterThanOrEqual(pausedViewport.viewportY)
    expect(stillPausedViewport.following).toBe(false)
    expect(stillPausedViewport.hasUnreadOutput).toBe(true)
    await expect(page.getByTestId('code-terminal-jump-bottom')).toBeVisible()
    await page.getByTestId('code-terminal-jump-bottom').click()
    await expect(page.getByTestId('code-terminal-jump-bottom')).toBeHidden()
    await expect.poll(async () => terminalViewport(page, agentId))
      .toMatchObject({ following: true, hasUnreadOutput: false })

    const sidebarBeforeResize = await page.getByTestId('code-sidebar').boundingBox()
    const resizerBox = await page.getByTestId('code-sidebar-resizer').boundingBox()
    if (!sidebarBeforeResize || !resizerBox) throw new Error('Sidebar resize handles are missing')
    await page.mouse.move(resizerBox.x + resizerBox.width / 2, resizerBox.y + resizerBox.height / 2)
    await page.mouse.down()
    await page.mouse.move(sidebarBeforeResize.x + sidebarBeforeResize.width + 90, resizerBox.y + resizerBox.height / 2)
    await page.mouse.up()
    await expect.poll(async () => (await page.getByTestId('code-sidebar').boundingBox())?.width ?? 0).toBeGreaterThan(sidebarBeforeResize.width + 40)

    const openCollapsedNavigation = async () => {
      if (!((await page.getByTestId('code-workspace').getAttribute('class'))?.includes('sidebar-collapsed'))) return
      const mobileMenu = page.getByTestId('code-mobile-menu')
      if (await mobileMenu.isVisible().catch(() => false)) {
        await mobileMenu.click()
        return
      }
      await page.getByTestId('code-sidebar-toggle').click()
    }

    await page.setViewportSize({ width: 390, height: 844 })
    await page.reload({ waitUntil: 'networkidle' })
    await expect(page.getByTestId('app-shell')).toBeVisible()
    await openCollapsedNavigation()
    const mobileProjectGroups = page.getByTestId('code-project-group')
    const mobilePrimaryProjectGroup = mobileProjectGroups.filter({ has: page.locator(`[data-agent-id="${primaryAgentId}"]`) })
    const mobileChildProjectGroup = mobileProjectGroups.filter({ has: page.locator(`[data-agent-id="${childAgentId}"]`) })
    const mobileRow = page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
    await expect(mobileRow).toBeVisible()
    await mobileRow.click()
    await openCollapsedNavigation()
	    await expect(mobilePrimaryProjectGroup.getByTestId('code-project-title')).toContainText(path.basename(mainWorkspace))
	    await expect(mobilePrimaryProjectGroup.getByTestId('code-files-section')).toHaveCount(1)
	    await expect(mobileChildProjectGroup.getByTestId('code-files-section')).toHaveCount(1)
    if (await page.getByTestId('code-composer-approval').count() > 0) {
      const mobileApprovalLabelDisplay = await page.getByTestId('code-composer-approval').evaluate(element => {
        const label = element.querySelector('.code-composer-approval-label')
        return label instanceof HTMLElement ? getComputedStyle(label).display : ''
      })
      expect(mobileApprovalLabelDisplay).toBe('none')
    }
	    if (await page.getByTestId('code-composer-model-picker').count() > 0) {
      const mobileModelVisibleText = await page.getByTestId('code-composer-model-picker').evaluate(element => (element as HTMLElement).innerText)
      expect(mobileModelVisibleText).not.toContain('GPT-')
	      const mobileModelTextFits = await page.getByTestId('code-composer-model-picker').evaluate(element => (
	        Array.from(element.querySelectorAll('span:not(.code-chevron)')).every(span => span.scrollWidth <= span.clientWidth + 1)
	      ))
	      expect(mobileModelTextFits).toBe(true)
	    }
	    if (process.platform === 'darwin') {
	      await expect(page.getByTestId('code-sidebar')).toHaveScreenshot('mobile-shell-with-vertical-sidebar.png')
	    }
	    await expect(mobileRow).toBeVisible()
	    await mobileRow.click()
	    await writeTerminalFixture(page, agentId, '$ mobile viewport\nready\n$ ')
    if (process.platform === 'darwin') {
      await expect(page.locator(`[data-testid="code-terminal-pane"][data-agent-id="${agentId}"]`)).toHaveScreenshot('mobile-session-modal-terminal.png', {
        mask: [
          page.locator(`[data-testid="code-terminal-pane"][data-agent-id="${agentId}"] .code-terminal-container`),
        ],
      })
    }
    const mobileMarker = `mobile-flow-${Date.now()}`
    const mobileComposerInput = page.getByTestId('code-composer-input')
    await mobileComposerInput.fill(`echo ${mobileMarker}`)
    await mobileComposerInput.press('Enter')
    await expect.poll(async () => mobileComposerInput.evaluate(element => element.textContent || '')).toBe('')
    await expect.poll(async () => {
      const response = await page.request.get(`/farming/api/agents/${agentId}/session-view`)
      const data = await response.json()
      return [
        data.session?.output,
        data.session?.renderOutput,
        data.session?.previewText,
      ].filter(Boolean).join('\n')
    }).toContain(mobileMarker)

    const revealMobileSidebar = async () => {
      if ((await page.getByTestId('code-workspace').getAttribute('class'))?.includes('sidebar-collapsed')) {
        await page.getByTestId('code-mobile-menu').click()
      }
      await expect(mobileRow).toBeVisible()
    }

    await revealMobileSidebar()
	    await mobileRow.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Rename Agent' }).click()
    await expect(page.getByTestId('code-rename-dialog')).toBeVisible()
    await expect(page.getByTestId('code-rename-input')).toBeFocused()
    await page.keyboard.press('Shift+Tab')
    await expect(page.getByTestId('code-rename-dialog').getByRole('button', { name: 'Save' })).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(page.getByTestId('code-rename-input')).toBeFocused()
    await page.getByTestId('code-rename-input').fill('Renamed Child Agent')
    await page.getByTestId('code-rename-input').press('Enter')
    await expect(page.getByTestId('code-rename-dialog')).toBeHidden()
	    await expect(mobileRow).toBeFocused()
	    await expect(mobileRow).toContainText('Renamed Child Agent')

    await page.evaluate(() => {
      const target = window as unknown as { __copiedText?: string }
      target.__copiedText = ''
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async (text: string) => {
            target.__copiedText = text
          },
        },
      })
    })
    await revealMobileSidebar()
	    await mobileRow.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Copy working directory' }).click()
    await expect.poll(async () => page.evaluate(() => (window as unknown as { __copiedText?: string }).__copiedText)).toBe(childWorkspace)
    await expect(page.getByTestId('code-copy-toast')).toHaveText('Copied working directory')
	    await expect(mobileRow).toBeFocused()

	    await revealMobileSidebar()
	    await mobileRow.click({ button: 'right' })
	    const markAsRead = page.getByRole('menuitem', { name: 'Mark as read' })
	    if (await markAsRead.isVisible().catch(() => false)) {
	      await markAsRead.click()
	      await revealMobileSidebar()
	      await mobileRow.click({ button: 'right' })
	    }
	    await page.getByRole('menuitem', { name: 'Mark as unread' }).click()
	    await expect(mobileRow).toBeFocused()
	    await revealMobileSidebar()
	    await mobileRow.click({ button: 'right' })
	    await page.getByRole('menuitem', { name: 'Pin Agent' }).click()
	    await expect(mobileRow).toHaveClass(/pinned/)
	    await expect(mobileRow).toBeFocused()
	    await revealMobileSidebar()
	    await mobileRow.click({ button: 'right' })
	    await expect(page.getByRole('menuitem', { name: 'Unpin Agent' })).toBeVisible()
	    await page.keyboard.press('Escape')
	    await expect(mobileRow).toBeFocused()
	    await page.keyboard.press('Shift+F10')
    const mobileAgentMenu = page.getByTestId('code-agent-context-menu')
    await expect(mobileAgentMenu).toBeVisible()
    await expect(mobileAgentMenu.getByRole('menuitem', { name: 'Archive' })).toBeVisible()
    await expect(mobileAgentMenu.getByRole('menuitem', { name: 'Unpin Agent' })).toBeFocused()
	    await mobileAgentMenu.getByRole('menuitem', { name: 'Archive' }).click()
	    await expect(mobileRow).toBeHidden()
	    await expect(primaryRow).toBeFocused()

	    await page.getByTestId('code-nav-history').click()
    await expect(page.getByTestId('code-history-agents')).toBeVisible()
    const archivedRunCard = page.getByTestId('code-archived-run-card').filter({ hasText: 'Renamed Child Agent' })
    await expect(archivedRunCard).toHaveCount(0)
	    await expect(mobileRow).toBeHidden()
  })
})
