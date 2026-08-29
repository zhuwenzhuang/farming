import fs from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import {
  expect,
  fileEditorPosition,
  interceptWorkspaceRequests,
  openFarming,
  test,
} from './fixtures'
import { projectFilesWorkspaceId } from '../../src/lib/project-workspaces'

async function createControlAgent(page: Page, workspace: string) {
  const response = await page.request.post('/farming/api/control/agents', {
    data: { command: 'bash', workspace },
  })
  const result = await response.json() as { agentId?: string; error?: string }
  expect(response.ok(), result.error || JSON.stringify(result)).toBeTruthy()
  expect(result.agentId).toBeTruthy()
  await mountProject(page, workspace)
  return result.agentId as string
}

async function mountProject(page: Page, workspace: string) {
  const response = await page.request.post('/farming/api/projects/mount', {
    data: { workspace },
  })
  expect(response.ok()).toBeTruthy()
}

async function mockSessionSearch(page: Page) {
  await page.route(/\/farming\/api\/agent-sessions\/search(?:\?.*)?$/, route => (
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ sessions: [] }) })
  ))
}

async function openGlobalSearch(page: Page, mobile = false) {
  if (mobile) {
    const sidebar = page.getByTestId('code-sidebar')
    if (await sidebar.evaluate(element => element.classList.contains('collapsed'))) {
      await page.getByTestId('code-mobile-menu').tap()
    }
    await expect(sidebar).not.toHaveClass(/collapsed/)
  }
  await page.getByTestId('code-nav-search').click()
  await expect(page.getByTestId('code-search-box')).toBeVisible()
  return page.getByTestId('code-search-box').locator('input')
}

function writeFixture(workspace: string, filePath: string, content: string) {
  const absolutePath = path.join(workspace, filePath)
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true })
  fs.writeFileSync(absolutePath, content)
  return absolutePath
}

test.describe('global file path search', () => {
  test('keeps duplicate paths distinct and opens exact relative, absolute, and line targets', async ({ page, workspaceRoot }, testInfo) => {
    test.skip(testInfo.project.name === 'iphone-webkit', 'desktop result composition is covered by Chromium')
    const firstWorkspace = path.join(workspaceRoot, 'first-root', 'org', 'team', 'shared-project')
    const secondWorkspace = path.join(workspaceRoot, 'second-root', 'org', 'team', 'shared-project')
    const firstPath = 'src/SharedTarget.ts'
    const secondPath = 'src/SharedTarget.ts'
    const stalePath = 'src/features/mobile/deep/StaleTarget.ts'
    const openedStalePath = 'src/features/mobile/deep/OpenedStaleTarget.ts'
    const firstAbsolutePath = writeFixture(firstWorkspace, firstPath, 'first line\nFIRST_PROJECT_TARGET\nthird line\n')
    writeFixture(secondWorkspace, secondPath, 'SECOND_PROJECT_TARGET\n')
    const staleAbsolutePath = writeFixture(firstWorkspace, stalePath, 'STALE_PROJECT_TARGET\n')
    const openedStaleAbsolutePath = writeFixture(firstWorkspace, openedStalePath, 'OPENED_STALE_PROJECT_TARGET\n')

    await mockSessionSearch(page)
    await openFarming(page)
    const firstAgentId = await createControlAgent(page, firstWorkspace)
    await mountProject(page, secondWorkspace)
    const sourceAgent = page.locator(`[data-testid="code-agent-row"][data-agent-id="${firstAgentId}"]`)
    await expect(sourceAgent).toBeVisible({ timeout: 30_000 })
    await sourceAgent.click()

    const searchInput = await openGlobalSearch(page)
    await searchInput.fill('SharedTarget.ts')
    const results = page.getByTestId('code-global-file-search-result')
    await expect(results).toHaveCount(2, { timeout: 30_000 })
    const firstResult = results.filter({ hasText: 'first-root/org/team/shared-project' })
    const secondResult = results.filter({ hasText: 'second-root/org/team/shared-project' })
    await expect(firstResult).toContainText(firstPath)
    await expect(secondResult).toContainText(secondPath)
    await expect(firstResult).toHaveAttribute('aria-label', new RegExp(`${firstWorkspace.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*${firstPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
    const combobox = page.getByRole('combobox', { name: 'Search projects, agents, or files' })
    await expect(combobox).toHaveAttribute('aria-controls', 'code-global-search-results')
    await expect(results.nth(0)).toHaveAttribute('aria-selected', 'true')
    await combobox.press('ArrowDown')
    await expect(results.nth(1)).toHaveAttribute('aria-selected', 'true')
    await combobox.evaluate(element => {
      for (const key of ['Enter', 'Escape']) {
        const event = new KeyboardEvent('keydown', {
          bubbles: true,
          cancelable: true,
          key,
          isComposing: true,
        })
        Object.defineProperty(event, 'keyCode', { value: 229 })
        element.dispatchEvent(event)
      }
    })
    await expect(page.getByTestId('code-search-panel')).toBeVisible()
    await expect(page.getByTestId('code-file-editor')).toHaveCount(0)
    await expect(results).toHaveCount(2)

    await secondResult.click()
    await expect(page.getByTestId('code-file-editor')).toBeVisible()
    await expect(page.getByTestId('code-file-editor').getByRole('tab', { selected: true })).toContainText('SharedTarget.ts')
    await expect(page.locator('.monaco-editor .view-lines')).toContainText('SECOND_PROJECT_TARGET')

    const absoluteSearchInput = await openGlobalSearch(page)
    await absoluteSearchInput.fill(`${firstAbsolutePath}:2:3`)
    await expect(results).toHaveCount(1, { timeout: 30_000 })
    await expect(results.first()).toContainText(firstPath)
    await absoluteSearchInput.press('Enter')
    await expect(page.locator('.monaco-editor .view-lines')).toContainText('FIRST_PROJECT_TARGET')
    await expect.poll(() => fileEditorPosition(page)).toEqual({ lineNumber: 2, column: 3 })

    const hashJumpSearchInput = await openGlobalSearch(page)
    await hashJumpSearchInput.fill(`${firstPath}#L3C2`)
    await expect(results).toHaveCount(2, { timeout: 30_000 })
    await results.filter({ hasText: 'first-root/org/team/shared-project' }).click()
    await expect.poll(() => fileEditorPosition(page)).toEqual({ lineNumber: 3, column: 2 })

    const openedStaleSearchInput = await openGlobalSearch(page)
    await openedStaleSearchInput.fill(openedStalePath)
    await expect(results).toHaveCount(1, { timeout: 30_000 })
    await results.first().click()
    await expect(page.getByTestId('code-file-editor').getByRole('tab', { selected: true })).toContainText('OpenedStaleTarget.ts')
    const reopenedStaleSearchInput = await openGlobalSearch(page)
    await reopenedStaleSearchInput.fill(openedStalePath)
    await expect(results).toHaveCount(1, { timeout: 30_000 })
    fs.unlinkSync(openedStaleAbsolutePath)
    await results.first().click()
    await expect(page.getByTestId('code-search-panel')).toBeVisible()
    await expect(page.getByTestId('code-global-file-open-error')).toContainText(openedStalePath)

    const staleSearchInput = page.getByTestId('code-search-box').locator('input')
    await staleSearchInput.fill(stalePath)
    await expect(results).toHaveCount(1, { timeout: 30_000 })
    fs.unlinkSync(staleAbsolutePath)
    await results.first().click()
    await expect(page.getByTestId('code-search-panel')).toBeVisible()
    await expect(page.getByTestId('code-global-file-open-error')).toContainText(stalePath)
    await expect(page.getByTestId('code-file-editor')).toHaveCount(0)

    await staleSearchInput.fill('/outside/farming/NotMounted.ts')
    await expect(results).toHaveCount(0, { timeout: 30_000 })
    await expect(page.getByTestId('code-empty-search')).toBeVisible()
    await expect(staleSearchInput).toHaveAttribute('maxlength', '4096')
    const cleanupResponse = await page.request.delete(`/farming/api/control/agents/${firstAgentId}`)
    expect(cleanupResponse.ok()).toBeTruthy()
  })

  test('keeps completed Project results when another Project times out', async ({ page, workspaceRoot }, testInfo) => {
    test.skip(testInfo.project.name === 'iphone-webkit', 'desktop timeout composition is covered by Chromium')
    const fastWorkspace = path.join(workspaceRoot, 'global-search-fast-project')
    const slowWorkspace = path.join(workspaceRoot, 'global-search-slow-project')
    const filePath = 'src/PartialTarget.ts'
    writeFixture(fastWorkspace, filePath, 'FAST_PROJECT_TARGET\n')
    writeFixture(slowWorkspace, filePath, 'SLOW_PROJECT_TARGET\n')
    const slowRootId = projectFilesWorkspaceId(slowWorkspace)
    let releaseSlowResult!: () => void
    const slowResultReleased = new Promise<void>(resolve => { releaseSlowResult = resolve })
    let slowSearchStarted!: () => void
    const slowSearchStart = new Promise<void>(resolve => { slowSearchStarted = resolve })

    await interceptWorkspaceRequests(page, request => {
      if (
        request.operation !== 'search'
        || request.scope !== 'file-path'
        || request.rootId !== slowRootId
        || request.query !== filePath
      ) return undefined
      return {
        onResult: async message => {
          slowSearchStarted()
          await slowResultReleased
          return message
        },
      }
    })
    await mockSessionSearch(page)
    await openFarming(page)
    const agentId = await createControlAgent(page, fastWorkspace)
    await mountProject(page, slowWorkspace)

    const searchInput = await openGlobalSearch(page)
    await searchInput.fill(filePath)
    await slowSearchStart
    const result = page.getByTestId('code-global-file-search-result')
    await expect(result).toHaveCount(1, { timeout: 8_000 })
    await expect(result).toContainText(path.basename(fastWorkspace))
    const partialStatus = page.getByTestId('code-global-file-search-partial')
    await expect(partialStatus).toBeVisible({ timeout: 8_000 })
    await expect(page.getByRole('listbox').getByTestId('code-global-file-search-partial')).toHaveCount(0)
    await expect(page.getByRole('listbox').getByRole('button', { name: 'Retry' })).toHaveCount(0)
    releaseSlowResult()

    const cleanupResponse = await page.request.delete(`/farming/api/control/agents/${agentId}`)
    expect(cleanupResponse.ok()).toBeTruthy()
  })

  test('shows an all-failed state and retries the current query', async ({ page, workspaceRoot }, testInfo) => {
    test.skip(testInfo.project.name === 'iphone-webkit', 'desktop retry composition is covered by Chromium')
    const workspace = path.join(workspaceRoot, 'global-search-retry-project')
    const filePath = 'src/RetryTarget.ts'
    writeFixture(workspace, filePath, 'RETRY_TARGET\n')
    let searchRequestCount = 0
    let releaseFirstResult!: () => void
    const firstResultReleased = new Promise<void>(resolve => { releaseFirstResult = resolve })

    await interceptWorkspaceRequests(page, request => {
      if (
        request.operation !== 'search'
        || request.scope !== 'file-path'
        || request.query !== filePath
      ) return undefined
      searchRequestCount += 1
      if (searchRequestCount !== 1) return undefined
      return {
        onResult: async message => {
          await firstResultReleased
          return message
        },
      }
    })
    await mockSessionSearch(page)
    await openFarming(page)
    const agentId = await createControlAgent(page, workspace)

    const searchInput = await openGlobalSearch(page)
    await searchInput.fill(filePath)
    const failed = page.getByTestId('code-global-file-search-error')
    await expect(failed).toBeVisible({ timeout: 8_000 })
    await failed.getByRole('button', { name: 'Retry' }).click()
    const result = page.getByTestId('code-global-file-search-result')
    await expect(result).toHaveCount(1, { timeout: 8_000 })
    await expect(result).toContainText(filePath)
    expect(searchRequestCount).toBe(2)
    releaseFirstResult()

    const cleanupResponse = await page.request.delete(`/farming/api/control/agents/${agentId}`)
    expect(cleanupResponse.ok()).toBeTruthy()
  })

  test('bounds queued slow Projects with the global search deadline', async ({ page, workspaceRoot }, testInfo) => {
    test.skip(testInfo.project.name === 'iphone-webkit', 'desktop deadline composition is covered by Chromium')
    const sourceWorkspace = path.join(workspaceRoot, 'global-search-deadline-source')
    fs.mkdirSync(sourceWorkspace, { recursive: true })
    const query = 'DeadlineTarget.ts'
    let searchRequestCount = 0
    let releaseResults!: () => void
    const resultsReleased = new Promise<void>(resolve => { releaseResults = resolve })

    await interceptWorkspaceRequests(page, request => {
      if (
        request.operation !== 'search'
        || request.scope !== 'file-path'
        || request.query !== query
      ) return undefined
      searchRequestCount += 1
      return {
        onResult: async message => {
          await resultsReleased
          return message
        },
      }
    })
    await mockSessionSearch(page)
    await openFarming(page)
    const agentId = await createControlAgent(page, sourceWorkspace)
    for (let index = 0; index < 12; index += 1) {
      const workspace = path.join(workspaceRoot, `global-search-deadline-${String(index).padStart(2, '0')}`)
      fs.mkdirSync(workspace, { recursive: true })
      await mountProject(page, workspace)
    }
    await expect(page.locator('[data-testid="code-project-title"]')).toHaveCount(13, { timeout: 30_000 })

    const searchInput = await openGlobalSearch(page)
    const startedAt = Date.now()
    await searchInput.fill(query)
    const failed = page.getByTestId('code-global-file-search-error')
    await expect(failed).toBeVisible({ timeout: 11_000 })
    await expect(page.getByTestId('code-global-file-search-incomplete')).toBeVisible()
    const elapsed = Date.now() - startedAt
    expect(elapsed).toBeGreaterThanOrEqual(7_500)
    expect(elapsed).toBeLessThan(10_500)
    expect(searchRequestCount).toBe(13)
    releaseResults()

    const cleanupResponse = await page.request.delete(`/farming/api/control/agents/${agentId}`)
    expect(cleanupResponse.ok()).toBeTruthy()
  })

  test('keeps grouped option semantics and scrolls keyboard selection into view', async ({ page, workspaceRoot }, testInfo) => {
    test.skip(testInfo.project.name === 'iphone-webkit', 'desktop keyboard navigation is covered by Chromium')
    await page.setViewportSize({ width: 1_024, height: 480 })
    const workspace = path.join(workspaceRoot, 'global-search-keyboard-project')
    for (let index = 0; index < 16; index += 1) {
      writeFixture(workspace, `src/keyboard/KeyboardTarget-${String(index).padStart(2, '0')}.ts`, `TARGET_${index}\n`)
    }

    await mockSessionSearch(page)
    await openFarming(page)
    const agentId = await createControlAgent(page, workspace)
    const searchInput = await openGlobalSearch(page)
    await searchInput.fill('KeyboardTarget')
    const listbox = page.getByRole('listbox')
    const fileGroup = listbox.getByRole('group', { name: 'Files' })
    const results = fileGroup.getByRole('option')
    await expect(results).toHaveCount(16, { timeout: 8_000 })
    await expect(listbox.locator(':scope > [role="group"]')).toHaveCount(1)
    await expect(listbox.locator(':scope > [role="option"]')).toHaveCount(0)
    const searchView = page.locator('.code-search-view')
    await expect.poll(async () => {
      const lastBox = await results.nth(15).boundingBox()
      const viewBox = await searchView.boundingBox()
      return Boolean(lastBox && viewBox && lastBox.y + lastBox.height > viewBox.y + viewBox.height + 1)
    }).toBe(true)

    for (let index = 1; index < 16; index += 1) await searchInput.press('ArrowDown')
    const selected = results.nth(15)
    await expect(selected).toHaveAttribute('aria-selected', 'true')
    await expect.poll(async () => {
      const resultBox = await selected.boundingBox()
      const viewBox = await searchView.boundingBox()
      return Boolean(
        resultBox
        && viewBox
        && resultBox.y >= viewBox.y - 1
        && resultBox.y + resultBox.height <= viewBox.y + viewBox.height + 1
      )
    }).toBe(true)

    const cleanupResponse = await page.request.delete(`/farming/api/control/agents/${agentId}`)
    expect(cleanupResponse.ok()).toBeTruthy()
  })

  test('does not let a cancelled older file query replace the current results', async ({ page, workspaceRoot }, testInfo) => {
    test.skip(testInfo.project.name === 'iphone-webkit', 'desktop cancellation composition is covered by Chromium')
    const workspace = path.join(workspaceRoot, 'global-search-cancel-project')
    writeFixture(workspace, 'src/OlderTarget.ts', 'OLDER_TARGET\n')
    writeFixture(workspace, 'src/NewerTarget.ts', 'NEWER_TARGET\n')
    let releaseOlderResult!: () => void
    const olderResultReleased = new Promise<void>(resolve => { releaseOlderResult = resolve })
    let olderSearchStarted!: () => void
    const olderSearchStart = new Promise<void>(resolve => { olderSearchStarted = resolve })

    await interceptWorkspaceRequests(page, request => {
      if (
        request.operation !== 'search'
        || request.scope !== 'file-path'
        || request.query !== 'OlderTarget.ts'
      ) return undefined
      return {
        onResult: async message => {
          olderSearchStarted()
          await olderResultReleased
          return message
        },
      }
    })
    await mockSessionSearch(page)
    await openFarming(page)
    const agentId = await createControlAgent(page, workspace)

    const searchInput = await openGlobalSearch(page)
    await searchInput.fill('OlderTarget.ts')
    await olderSearchStart
    await searchInput.fill('NewerTarget.ts')
    const result = page.getByTestId('code-global-file-search-result')
    await expect(result).toHaveCount(1, { timeout: 8_000 })
    await expect(result).toContainText('NewerTarget.ts')
    releaseOlderResult()
    await page.waitForTimeout(300)
    await expect(result).toHaveCount(1)
    await expect(result).toContainText('NewerTarget.ts')
    await expect(result).not.toContainText('OlderTarget.ts')

    const cleanupResponse = await page.request.delete(`/farming/api/control/agents/${agentId}`)
    expect(cleanupResponse.ok()).toBeTruthy()
  })

  test('cancels a pending file open when the query changes', async ({ page, workspaceRoot }, testInfo) => {
    test.skip(testInfo.project.name === 'iphone-webkit', 'desktop delayed-open transaction is covered by Chromium')
    const workspace = path.join(workspaceRoot, 'global-search-cancel-open-project')
    const slowPath = 'src/SlowOpenTarget.ts'
    writeFixture(workspace, slowPath, 'SLOW_OPEN_TARGET\n')
    writeFixture(workspace, 'src/CurrentTarget.ts', 'CURRENT_TARGET\n')
    let releaseRead!: () => void
    const readReleased = new Promise<void>(resolve => { releaseRead = resolve })
    let markReadStarted!: () => void
    const readStarted = new Promise<void>(resolve => { markReadStarted = resolve })
    let readRequestCount = 0

    await interceptWorkspaceRequests(page, request => {
      if (request.operation !== 'read-file' || request.path !== slowPath) return undefined
      readRequestCount += 1
      return {
        onResult: async message => {
          markReadStarted()
          await readReleased
          return message
        },
      }
    })
    await mockSessionSearch(page)
    await openFarming(page)
    const agentId = await createControlAgent(page, workspace)

    const searchInput = await openGlobalSearch(page)
    await searchInput.fill(slowPath)
    const result = page.getByTestId('code-global-file-search-result')
    await expect(result).toHaveCount(1, { timeout: 8_000 })
    await result.click()
    await readStarted
    await expect(result).toHaveAttribute('aria-busy', 'true')
    await expect(result).toBeDisabled()
    await expect(result).toContainText('Opening file')
    await searchInput.focus()
    await searchInput.press('Enter')
    await page.waitForTimeout(250)
    expect(readRequestCount).toBe(1)
    await searchInput.fill('CurrentTarget.ts')
    await expect(result).toContainText('CurrentTarget.ts', { timeout: 8_000 })
    releaseRead()
    await page.waitForTimeout(300)
    await expect(page.getByTestId('code-search-panel')).toBeVisible()
    await expect(page.getByTestId('code-file-editor')).toHaveCount(0)
    await expect(page.getByTestId('code-global-file-open-error')).toHaveCount(0)

    const cleanupResponse = await page.request.delete(`/farming/api/control/agents/${agentId}`)
    expect(cleanupResponse.ok()).toBeTruthy()
  })

  test('fails an old result instead of remounting a removed Project', async ({ page, workspaceRoot }, testInfo) => {
    test.skip(testInfo.project.name === 'iphone-webkit', 'desktop remove-during-open transaction is covered by Chromium')
    const sourceWorkspace = path.join(workspaceRoot, 'global-search-remove-source')
    const targetWorkspace = path.join(workspaceRoot, 'global-search-remove-target')
    const filePath = 'src/RemovedProjectTarget.ts'
    fs.mkdirSync(sourceWorkspace, { recursive: true })
    writeFixture(targetWorkspace, filePath, 'REMOVED_PROJECT_TARGET\n')
    let releaseRead!: () => void
    const readReleased = new Promise<void>(resolve => { releaseRead = resolve })
    let markReadStarted!: () => void
    const readStarted = new Promise<void>(resolve => { markReadStarted = resolve })

    await interceptWorkspaceRequests(page, request => {
      if (request.operation !== 'read-file' || request.path !== filePath) return undefined
      return {
        onResult: async message => {
          markReadStarted()
          await readReleased
          return message
        },
      }
    })
    await mockSessionSearch(page)
    await openFarming(page)
    const agentId = await createControlAgent(page, sourceWorkspace)
    await mountProject(page, targetWorkspace)
    let repeatedMountCount = 0
    page.on('request', request => {
      if (!new URL(request.url()).pathname.endsWith('/api/projects/mount')) return
      const body = request.postDataJSON() as { workspace?: string } | null
      if (body?.workspace === targetWorkspace) repeatedMountCount += 1
    })

    const searchInput = await openGlobalSearch(page)
    await searchInput.fill(filePath)
    const result = page.getByTestId('code-global-file-search-result')
    await expect(result).toHaveCount(1, { timeout: 8_000 })
    await result.click()
    await readStarted
    const removeResponse = await page.request.post('/farming/api/projects/remove', {
      data: { workspace: targetWorkspace },
    })
    expect(removeResponse.ok()).toBeTruthy()
    await expect(result).toHaveCount(0, { timeout: 8_000 })
    await expect(page.getByTestId('code-global-file-open-error')).toContainText(filePath)
    releaseRead()
    await page.waitForTimeout(300)
    await expect(page.getByTestId('code-file-editor')).toHaveCount(0)
    expect(repeatedMountCount).toBe(0)

    const cleanupResponse = await page.request.delete(`/farming/api/control/agents/${agentId}`)
    expect(cleanupResponse.ok()).toBeTruthy()
  })

  test('finds an absolute path in a mounted Project beyond the first 32 roots', async ({ page, workspaceRoot }, testInfo) => {
    test.skip(testInfo.project.name === 'iphone-webkit', 'large mounted-Project routing is covered by Chromium')
    const sourceWorkspace = path.join(workspaceRoot, 'global-search-many-source')
    fs.mkdirSync(sourceWorkspace, { recursive: true })
    const targetWorkspace = path.join(workspaceRoot, 'global-search-many-target')
    const filePath = 'src/BeyondThirtyTwo.ts'
    const absolutePath = writeFixture(targetWorkspace, filePath, 'BEYOND_THIRTY_TWO\n')

    await mockSessionSearch(page)
    await openFarming(page)
    const agentId = await createControlAgent(page, sourceWorkspace)
    await mountProject(page, targetWorkspace)
    for (let index = 0; index < 32; index += 1) {
      const fillerWorkspace = path.join(workspaceRoot, `global-search-many-filler-${String(index).padStart(2, '0')}`)
      fs.mkdirSync(fillerWorkspace, { recursive: true })
      await mountProject(page, fillerWorkspace)
    }
    const settingsResponse = await page.request.get('/farming/api/settings')
    const settingsBody = await settingsResponse.json() as { settings?: { projectWorkspaces?: string[] } }
    expect(settingsBody.settings?.projectWorkspaces?.indexOf(targetWorkspace) ?? -1).toBeGreaterThan(31)

    const searchInput = await openGlobalSearch(page)
    await searchInput.fill(absolutePath)
    const result = page.getByTestId('code-global-file-search-result')
    await expect(result).toHaveCount(1, { timeout: 8_000 })
    await expect(result).toContainText(path.basename(targetWorkspace))
    await expect(result).toContainText(filePath)
    await searchInput.fill('BeyondThirtyTwo.ts')
    await expect(result).toHaveCount(1, { timeout: 8_000 })
    await expect(result).toContainText(path.basename(targetWorkspace))

    const cleanupResponse = await page.request.delete(`/farming/api/control/agents/${agentId}`)
    expect(cleanupResponse.ok()).toBeTruthy()
  })
})

test.describe('mobile global file path search', () => {
  test.use({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 390, height: 844 },
  })

  test('opens a long path from a touch-sized result and returns to the source Agent', async ({ page, workspaceRoot }) => {
    const sourceWorkspace = path.join(workspaceRoot, 'global-search-mobile-source')
    const firstWorkspace = path.join(workspaceRoot, 'mobile-root-a', 'org', 'team', 'shared-project')
    const secondWorkspace = path.join(workspaceRoot, 'mobile-root-b', 'org', 'team', 'shared-project')
    const filePath = 'src/mobile/a-very-long-directory-name/another-long-segment/TouchTarget.ts'
    fs.mkdirSync(sourceWorkspace, { recursive: true })
    writeFixture(firstWorkspace, filePath, 'MOBILE_GLOBAL_SEARCH_TARGET_FIRST\n')
    writeFixture(secondWorkspace, filePath, 'MOBILE_GLOBAL_SEARCH_TARGET_SECOND\n')

    await mockSessionSearch(page)
    await openFarming(page)
    const agentId = await createControlAgent(page, sourceWorkspace)
    await mountProject(page, firstWorkspace)
    await mountProject(page, secondWorkspace)
    const sourceAgent = page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
    await page.getByTestId('code-mobile-menu').tap()
    await expect(sourceAgent).toBeVisible({ timeout: 30_000 })
    await sourceAgent.locator('.code-agent-row-copy').tap()

    const searchInput = await openGlobalSearch(page, true)
    await searchInput.fill(`${filePath}#L1C5`)
    const results = page.getByTestId('code-global-file-search-result')
    await expect(results).toHaveCount(2, { timeout: 30_000 })
    const firstResult = results.filter({ hasText: 'mobile-root-a/org/team/shared-project' })
    const result = results.filter({ hasText: 'mobile-root-b/org/team/shared-project' })
    await expect(firstResult).toBeVisible()
    await expect(result).toBeVisible()
    const box = await result.boundingBox()
    expect(box).not.toBeNull()
    expect(box!.height).toBeGreaterThanOrEqual(48)
    expect(box!.x).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width).toBeLessThanOrEqual(390)
    await expect(result).toHaveAttribute('title', `${path.basename(secondWorkspace)} · ${secondWorkspace} · ${filePath}`)
    await result.tap()

    await expect(page.getByTestId('code-search-box')).toHaveCount(0)
    await expect(page.getByTestId('code-workspace')).toHaveClass(/sidebar-collapsed/)
    await expect(page.getByTestId('code-file-editor')).toBeVisible()
    await expect(page.getByTestId('code-file-editor').getByRole('tab', { selected: true })).toContainText('TouchTarget.ts')
    await expect(page.locator('.monaco-editor .view-lines')).toContainText('MOBILE_GLOBAL_SEARCH_TARGET_SECOND')
    await expect.poll(() => fileEditorPosition(page)).toEqual({ lineNumber: 1, column: 5 })
    await expect.poll(async () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2)).toBe(true)

    await expect(page.getByTestId('code-mobile-back')).toBeVisible()
    await page.getByTestId('code-mobile-back').tap()
    const sourcePane = page.locator(`[data-testid="code-agent-work-pane"][data-agent-id="${agentId}"]`)
    await expect(sourcePane).toHaveClass(/active/)
    await expect(sourcePane).toBeVisible()
    const cleanupResponse = await page.request.delete(`/farming/api/control/agents/${agentId}`)
    expect(cleanupResponse.ok()).toBeTruthy()
  })

  test('returns to a still-running Main Agent after opening a Project file', async ({ page, workspaceRoot }) => {
    await page.setViewportSize({ width: 1_024, height: 844 })
    const workspace = path.join(workspaceRoot, 'global-search-mobile-main-source')
    const filePath = 'src/mobile/MainSourceTarget.ts'
    writeFixture(workspace, filePath, 'MAIN_SOURCE_TARGET\n')

    await mockSessionSearch(page)
    await openFarming(page)
    await mountProject(page, workspace)
    let mainAgentId = ''
    await expect.poll(async () => {
      const response = await page.request.get('/farming/api/control/agents')
      const payload = await response.json() as { mainAgentId?: string }
      mainAgentId = payload.mainAgentId ?? ''
      return mainAgentId
    }, { timeout: 30_000 }).not.toBe('')

    const usageToggle = page.getByTestId('code-usage-toggle')
    if (await usageToggle.getAttribute('aria-expanded') !== 'true') await usageToggle.tap()
    await page.getByTestId('code-main-agent-open').tap()
    const mainPane = page.locator(`[data-testid="code-agent-work-pane"][data-agent-id="${mainAgentId}"]`)
    await expect(mainPane).toHaveClass(/active/)
    await expect(mainPane).toBeVisible()
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(page.locator('body')).toHaveClass(/code-mobile-touch/)

    const searchInput = await openGlobalSearch(page, true)
    await searchInput.fill(filePath)
    const result = page.getByTestId('code-global-file-search-result')
    await expect(result).toHaveCount(1, { timeout: 8_000 })
    await result.tap()
    await expect(page.getByTestId('code-file-editor')).toBeVisible()
    await page.getByTestId('code-mobile-back').tap()
    await expect(mainPane).toHaveClass(/active/)
    await expect(mainPane).toBeVisible()
  })
})
