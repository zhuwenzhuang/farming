import fs from 'node:fs'
import path from 'node:path'
import { projectFilesWorkspaceId } from '../../src/lib/project-workspaces'
import { expect, openFarming, test } from './fixtures'

async function createControlAgent(page: import('@playwright/test').Page, workspace: string) {
  const response = await page.request.post('/farming/api/control/agents', {
    data: { command: 'bash', workspace },
  })
  expect(response.ok()).toBeTruthy()
  const data = await response.json() as { agentId?: string }
  expect(data.agentId).toBeTruthy()
  return data.agentId as string
}

async function projectAgentIds(project: import('@playwright/test').Locator) {
  return project.getByTestId('code-agent-row').evaluateAll(rows => rows
    .map(row => row.getAttribute('data-agent-id'))
    .filter((id): id is string => Boolean(id)))
}

async function orderedProjectIds(page: import('@playwright/test').Page, projectIds: string[]) {
  return page.getByTestId('code-project-title').evaluateAll((titles, expectedIds) => {
    const expected = new Set(expectedIds)
    return titles
      .map(title => title.getAttribute('data-project-id'))
      .filter((id): id is string => Boolean(id && expected.has(id)))
  }, projectIds)
}

async function mockPaginatedProjectSessions(page: import('@playwright/test').Page, projectDir: string, count = 6) {
  const sessionIds = Array.from({ length: count }, (_, index) => `019f0000-0000-7000-8000-${String(index).padStart(12, '0')}`)
  await page.route(/\/farming\/api\/agent-sessions(?:\?.*)?$/, async route => {
    const now = Date.now()
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        sessions: sessionIds.map((id, index) => ({
          provider: 'codex',
          providerName: 'Codex',
          capabilities: ['resume'],
          id,
          title: `Pagination session ${index + 1}`,
          cwd: projectDir,
          workspace: projectDir,
          updatedAt: new Date(now - index * 60_000).toISOString(),
          createdAt: new Date(now - (index + 60) * 60_000).toISOString(),
          archived: false,
          pinned: false,
          unread: false,
          projectless: false,
          source: 'codex',
        })),
        total: sessionIds.length,
      }),
    })
  })
  const membershipResponse = await page.request.post('/farming/api/main-page-agent-sessions', {
    data: {
      operation: 'add',
      sessionKeys: sessionIds.map(id => `agent-session:codex:${id}`),
    },
  })
  expect(membershipResponse.ok()).toBeTruthy()
}

test('keeps Agent pagination controls out of arrow-key Agent navigation', async ({ page, workspaceRoot }) => {
  const projectDir = path.join(workspaceRoot, 'agent-pagination-keyboard')
  fs.mkdirSync(projectDir, { recursive: true })

  await openFarming(page)
  for (let index = 0; index < 6; index += 1) {
    await createControlAgent(page, projectDir)
  }

  const project = page.getByTestId('code-project-group').filter({ hasText: path.basename(projectDir) })
  const showMoreAgents = project.getByTestId('code-agent-show-more')
  await expect(project.getByTestId('code-agent-row')).toHaveCount(5)
  await expect(showMoreAgents).toBeVisible()
  const activeAgent = page.locator('[data-testid="code-agent-row"].active')
  await expect(activeAgent).toHaveCount(1)
  const activeAgentId = await activeAgent.getAttribute('data-agent-id')

  await showMoreAgents.focus()
  await showMoreAgents.press('ArrowDown')

  await expect(showMoreAgents).toBeFocused()
  await expect(page.locator(`[data-testid="code-agent-row"][data-agent-id="${activeAgentId}"]`)).toHaveClass(/active/)
})

test('shows one progressive pagination action across Agents and sessions', async ({ page, workspaceRoot }) => {
  const projectDir = path.join(workspaceRoot, 'agent-pagination-labels')
  fs.mkdirSync(projectDir, { recursive: true })
  await mockPaginatedProjectSessions(page, projectDir)

  await openFarming(page)
  for (let index = 0; index < 6; index += 1) {
    await createControlAgent(page, projectDir)
  }

  const project = page.getByTestId('code-project-group').filter({ hasText: path.basename(projectDir) })
  const showMoreAgents = project.getByTestId('code-agent-show-more')
  const showMoreSessions = project.getByTestId('code-session-show-more')
  await expect(showMoreAgents).toBeVisible()
  await expect(showMoreSessions).toHaveCount(0)
  await expect(project.getByText('Show more', { exact: true })).toHaveCount(1)
  await expect(showMoreAgents).toHaveAttribute('aria-label', 'Show 1 more Agent')
  await expect(showMoreAgents.locator('.code-agent-name')).toHaveText('Show more')

  await showMoreAgents.click()
  await expect(showMoreAgents).toHaveCount(0)
  await expect(showMoreSessions).toBeVisible()
  await expect(project.getByText('Show more', { exact: true })).toHaveCount(1)
  await expect(showMoreSessions).toHaveAttribute('aria-label', 'Show 1 more Agent session')
  await expect(showMoreSessions.locator('.code-agent-name')).toHaveText('Show more')
})

test('reveals Project sessions in progressive batches', {
  tag: ['@critical-behavior', '@behavior-CODE-SIDEBAR-SESSION-PAGINATION'],
}, async ({ page, workspaceRoot }) => {
  const projectDir = path.join(workspaceRoot, 'session-progressive-pagination')
  fs.mkdirSync(projectDir, { recursive: true })
  await mockPaginatedProjectSessions(page, projectDir, 26)

  await openFarming(page)
  const project = page.getByTestId('code-project-group').filter({ hasText: path.basename(projectDir) })
  const sessionRows = project.getByTestId('code-active-session-row')
  const showMore = project.getByTestId('code-session-show-more')
  const showLess = project.getByTestId('code-session-show-less')

  await expect(sessionRows).toHaveCount(5)
  await expect(showMore).toHaveAttribute('aria-label', 'Show 5 more Agent sessions')
  await expect(showMore.locator('.code-agent-age')).toHaveText('5')

  await showMore.click()
  await expect(sessionRows).toHaveCount(10)
  await expect(showMore).toHaveAttribute('aria-label', 'Show 10 more Agent sessions')
  await expect(showLess).toBeVisible()

  await showMore.click()
  await expect(sessionRows).toHaveCount(20)
  await expect(showMore).toHaveAttribute('aria-label', 'Show 6 more Agent sessions')

  await showMore.click()
  await expect(sessionRows).toHaveCount(26)
  await expect(showMore).toHaveCount(0)

  await showLess.click()
  await expect(sessionRows).toHaveCount(5)
})

test('reveals Project Agents in progressive batches', {
  tag: ['@critical-behavior', '@behavior-CODE-SIDEBAR-AGENT-PAGINATION'],
}, async ({ page, workspaceRoot }) => {
  const projectDir = path.join(workspaceRoot, 'agent-progressive-pagination')
  fs.mkdirSync(projectDir, { recursive: true })

  await openFarming(page)
  for (let offset = 0; offset < 21; offset += 5) {
    await Promise.all(Array.from({ length: Math.min(5, 21 - offset) }, () => (
      createControlAgent(page, projectDir)
    )))
  }

  const project = page.getByTestId('code-project-group').filter({ hasText: path.basename(projectDir) })
  const showMore = project.getByTestId('code-agent-show-more')
  const showLess = project.getByTestId('code-agent-show-less')

  await expect(project.getByTestId('code-agent-row')).toHaveCount(5)
  await expect(showMore).toHaveAttribute('aria-label', 'Show 5 more Agents')
  await expect(showMore.locator('.code-agent-age')).toHaveText('5')

  await showMore.click()
  await expect(project.getByTestId('code-agent-row')).toHaveCount(10)
  await expect(showMore).toHaveAttribute('aria-label', 'Show 10 more Agents')
  await expect(showMore.locator('.code-agent-age')).toHaveText('10')
  await expect(showLess).toBeVisible()

  await showMore.click()
  await expect(project.getByTestId('code-agent-row')).toHaveCount(20)
  await expect(showMore).toHaveAttribute('aria-label', 'Show 1 more Agent')
  await expect(showMore.locator('.code-agent-age')).toHaveText('1')

  await showMore.click()
  await expect(project.getByTestId('code-agent-row')).toHaveCount(21)
  await expect(showMore).toHaveCount(0)

  await showLess.click()
  await expect(project.getByTestId('code-agent-row')).toHaveCount(5)
  await expect(showMore).toHaveAttribute('aria-label', 'Show 5 more Agents')
})

test('keeps Agent pagination size stable while selecting rows', {
  tag: ['@critical-behavior', '@behavior-CODE-SIDEBAR-SELECTION-STABILITY'],
}, async ({ page, workspaceRoot }) => {
  const projectDir = path.join(workspaceRoot, 'agent-selection-stability')
  fs.mkdirSync(projectDir, { recursive: true })

  await openFarming(page)
  for (let index = 0; index < 6; index += 1) {
    await createControlAgent(page, projectDir)
  }

  const project = page.getByTestId('code-project-group').filter({ hasText: path.basename(projectDir) })
  const rows = project.getByTestId('code-agent-row')
  const showMore = project.getByTestId('code-agent-show-more')
  await expect(rows).toHaveCount(5)
  await expect(showMore).toHaveAttribute('aria-label', 'Show 1 more Agent')

  for (const index of [4, 2, 0, 4]) {
    await rows.nth(index).click()
    await expect(rows).toHaveCount(5)
    await expect(showMore).toHaveAttribute('aria-label', 'Show 1 more Agent')
  }
})

test('reveals the active Agent in the sidebar after an Agent jump', async ({ page, workspaceRoot }) => {
  const targetProjectDir = path.join(workspaceRoot, 'agent-jump-target')
  const scrolledProjectDir = path.join(workspaceRoot, 'agent-jump-scrolled-project')
  fs.mkdirSync(targetProjectDir, { recursive: true })
  fs.mkdirSync(scrolledProjectDir, { recursive: true })
  for (let index = 0; index < 80; index += 1) {
    fs.writeFileSync(path.join(scrolledProjectDir, `file-${String(index).padStart(2, '0')}.txt`), `${index}\n`)
  }

  await openFarming(page)
  const targetAgentId = await createControlAgent(page, targetProjectDir)
  const scrolledAgentId = await createControlAgent(page, scrolledProjectDir)

  const targetRow = page.locator(`[data-testid="code-agent-row"][data-agent-id="${targetAgentId}"]`)
  const scrolledAgentRow = page.locator(`[data-testid="code-agent-row"][data-agent-id="${scrolledAgentId}"]`)
  const scrolledProject = page.getByTestId('code-project-group').filter({ hasText: path.basename(scrolledProjectDir) })
  await scrolledAgentRow.click()
  await expect(scrolledAgentRow).toHaveClass(/active/)
  await scrolledProject.locator('.code-files-title').click()
  await expect(scrolledProject.getByTestId('code-file-row').last()).toBeVisible()
  await scrolledProject.getByTestId('code-file-row').last().evaluate(element => {
    element.scrollIntoView({ block: 'end' })
  })

  await expect.poll(() => targetRow.evaluate(element => {
    const scroller = element.closest<HTMLElement>('.code-project-list')
    if (!scroller) return true
    const rowRect = element.getBoundingClientRect()
    const scrollerRect = scroller.getBoundingClientRect()
    return rowRect.bottom > scrollerRect.top && rowRect.top < scrollerRect.bottom
  })).toBe(false)

  await targetRow.evaluate(element => (element as HTMLElement).click())
  await expect(targetRow).toHaveClass(/active/)
  await expect.poll(() => targetRow.evaluate(element => {
    const scroller = element.closest<HTMLElement>('.code-project-list')
    if (!scroller) return false
    const rowRect = element.getBoundingClientRect()
    const scrollerRect = scroller.getBoundingClientRect()
    return rowRect.bottom > scrollerRect.top && rowRect.top < scrollerRect.bottom
  })).toBe(true)
})

test('keeps the Project list anchored when selecting a visible Agent', async ({ page, workspaceRoot }) => {
  const projectDir = path.join(workspaceRoot, 'visible-agent-selection')
  fs.mkdirSync(projectDir, { recursive: true })
  for (let index = 0; index < 80; index += 1) {
    fs.writeFileSync(path.join(projectDir, `file-${String(index).padStart(2, '0')}.txt`), `${index}\n`)
  }

  await openFarming(page)
  const targetAgentId = await createControlAgent(page, projectDir)
  const activeAgentId = await createControlAgent(page, projectDir)
  const project = page.getByTestId('code-project-group').filter({ hasText: path.basename(projectDir) })
  const targetRow = page.locator(`[data-testid="code-agent-row"][data-agent-id="${targetAgentId}"]`)
  const activeRow = page.locator(`[data-testid="code-agent-row"][data-agent-id="${activeAgentId}"]`)
  const projectList = page.getByTestId('code-project-list')

  await activeRow.click()
  await expect(activeRow).toHaveClass(/active/)
  await project.locator('.code-files-title').click()
  const lastFileRow = project.getByTestId('code-file-row').last()
  await expect(lastFileRow).toBeVisible()
  await lastFileRow.evaluate(element => element.scrollIntoView({ block: 'end' }))
  await expect(targetRow).toBeVisible()

  const beforeScrollTop = await projectList.evaluate(element => element.scrollTop)
  expect(beforeScrollTop).toBeGreaterThan(0)
  await targetRow.click()
  await expect(targetRow).toHaveClass(/active/)
  await expect.poll(() => projectList.evaluate(element => element.scrollTop)).toBe(beforeScrollTop)
})

test('restores Project disclosure without letting late sidebar content hide the active Agent', async ({ page, workspaceRoot }) => {
  const rememberedProjectDir = path.join(workspaceRoot, 'remembered-project-view')
  const activeProjectDir = path.join(workspaceRoot, 'remembered-active-project')
  fs.mkdirSync(rememberedProjectDir, { recursive: true })
  fs.mkdirSync(activeProjectDir, { recursive: true })

  await openFarming(page)
  for (let index = 0; index < 6; index += 1) {
    await createControlAgent(page, rememberedProjectDir)
  }
  const activeAgentId = await createControlAgent(page, activeProjectDir)
  const rememberedProject = page.getByTestId('code-project-group').filter({
    has: page.getByTestId('code-project-title').filter({ hasText: path.basename(rememberedProjectDir) }),
  })
  const activeRow = page.locator(`[data-testid="code-agent-row"][data-agent-id="${activeAgentId}"]`)

  await rememberedProject.getByTestId('code-agent-show-more').click()
  await expect(rememberedProject.getByTestId('code-agent-row')).toHaveCount(6)
  await activeRow.click()
  await expect(activeRow).toHaveClass(/active/)

  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(rememberedProject.getByTestId('code-agent-row')).toHaveCount(6)
  await expect(activeRow).toHaveClass(/active/)
  await expect(activeRow).toBeInViewport()

  const agentVisibility = rememberedProject.getByTestId('code-project-agent-visibility')
  await rememberedProject.getByTestId('code-project-title').hover({ position: { x: 40, y: 10 } })
  await agentVisibility.click({ force: true })
  await expect(agentVisibility).toHaveAttribute('data-collapsed', 'true')
  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(agentVisibility).toHaveAttribute('data-collapsed', 'true')
  await expect(activeRow).toHaveClass(/active/)
  await expect(activeRow).toBeInViewport()

  await rememberedProject.getByTestId('code-project-title').click()
  await expect(rememberedProject).toHaveAttribute('data-collapsed', 'true')
  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(rememberedProject).toHaveAttribute('data-collapsed', 'true')
  await expect(activeRow).toHaveClass(/active/)
  await expect(activeRow).toBeInViewport()
})

test('keeps the Files header below a resized sticky Agent section without ResizeObserver', async ({ page, workspaceRoot }, testInfo) => {
  const projectDir = path.join(workspaceRoot, 'agent-sticky-height-sync')
  fs.mkdirSync(projectDir, { recursive: true })
  for (let index = 0; index < 40; index += 1) {
    fs.writeFileSync(path.join(projectDir, `file-${index}.txt`), `${index}\n`)
  }
  const followingProjectDir = path.join(workspaceRoot, 'agent-sticky-height-following-project')
  fs.mkdirSync(followingProjectDir, { recursive: true })
  for (let index = 0; index < 40; index += 1) {
    fs.writeFileSync(path.join(followingProjectDir, `file-${index}.txt`), `${index}\n`)
  }
  await createControlAgent(page, followingProjectDir)
  await createControlAgent(page, projectDir)
  await page.addInitScript(() => {
    class DisabledResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    Object.defineProperty(window, 'ResizeObserver', {
      configurable: true,
      value: DisabledResizeObserver,
    })
  })

  await openFarming(page)
  const projects = page.getByTestId('code-project-group')
  await expect(projects).toHaveCount(2)
  const project = projects.first()
  const followingProject = projects.nth(1)
  const filesTitle = project.locator('.code-files-title')
  await filesTitle.click()
  await expect(project.getByTestId('code-file-row').first()).toBeVisible()
  const followingFilesTitle = followingProject.locator('.code-files-title')
  await followingFilesTitle.click()
  await expect(followingProject.getByTestId('code-file-row').first()).toBeVisible()

  await createControlAgent(page, projectDir)
  await createControlAgent(page, followingProjectDir)
  await expect(project.getByTestId('code-agent-row')).toHaveCount(2)
  await project.getByTestId('code-agent-row').first().click()
  await expect(project.getByTestId('code-agent-row').first()).toHaveClass(/active/)
  const filesHeader = project.locator('.code-files-header')
  await filesHeader.evaluate(element => element.scrollIntoView({ block: 'start' }))

  const layout = await project.evaluate(element => {
    const agents = element.querySelector<HTMLElement>('[data-testid="code-agents-section"]')
    const files = element.querySelector<HTMLElement>('.code-files-header')
    if (!agents || !files) return null
    const agentsRect = agents.getBoundingClientRect()
    const filesRect = files.getBoundingClientRect()
    const agentsStyle = getComputedStyle(agents)
    const visibleAgentsHeight = agentsRect.height - Number.parseFloat(agentsStyle.paddingBottom || '0')
    return {
      agentsHeight: visibleAgentsHeight,
      agentsBottom: agentsRect.top + visibleAgentsHeight,
      filesTop: filesRect.top,
      stickyHeight: Number.parseFloat(getComputedStyle(element).getPropertyValue('--code-agents-sticky-height')),
    }
  })
  expect(layout).not.toBeNull()
  expect(layout!.stickyHeight).toBeGreaterThanOrEqual(layout!.agentsHeight - 1)
  expect(layout!.filesTop).toBeGreaterThanOrEqual(layout!.agentsBottom - 1)

  for (const appearance of ['light', 'dark', 'paper'] as const) {
    await page.locator('body').evaluate((body, value) => {
      body.dataset.appearance = value
    }, appearance)
    await project.evaluate(async element => {
      const scroller = element.closest<HTMLElement>('.code-project-list')
      const files = element.querySelector<HTMLElement>('.code-files-header')
      if (!scroller || !files) return
      const style = getComputedStyle(element)
      const stickyStackHeight = Number.parseFloat(style.getPropertyValue('--code-project-sticky-height'))
        + Number.parseFloat(style.getPropertyValue('--code-agents-sticky-height'))
        + files.getBoundingClientRect().height
      const desiredGroupBottom = scroller.getBoundingClientRect().top + stickyStackHeight - 8
      scroller.scrollTop += element.getBoundingClientRect().bottom - desiredGroupBottom
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
    })
    await page.mouse.move(1000, 100)
    if (appearance === 'paper') {
      const rowStates = await project.evaluate(element => {
        const active = element.querySelector<HTMLElement>('.code-agent-row.active')
        const inactive = element.querySelector<HTMLElement>('.code-agent-row:not(.active)')
        if (!active || !inactive) return null
        return {
          active: getComputedStyle(active).backgroundColor,
          inactive: getComputedStyle(inactive).backgroundColor,
        }
      })
      expect(rowStates).not.toBeNull()
      expect(rowStates!.inactive).toBe('rgba(0, 0, 0, 0)')
      expect(rowStates!.active).not.toBe(rowStates!.inactive)
    }
    const screenshotPath = testInfo.outputPath(`sidebar-sticky-release-${appearance}.png`)
    await page.getByTestId('code-sidebar').screenshot({ path: screenshotPath })
    await testInfo.attach(`sidebar-sticky-release-${appearance}`, {
      path: screenshotPath,
      contentType: 'image/png',
    })
  }

  const releaseMotion = await project.evaluate(async element => {
    const scroller = element.closest<HTMLElement>('.code-project-list')
    const projectRow = element.querySelector<HTMLElement>('.code-project-row')
    const agents = element.querySelector<HTMLElement>('[data-testid="code-agents-section"]')
    const files = element.querySelector<HTMLElement>('.code-files-header')
    if (!scroller || !projectRow || !agents || !files) return null

    const projectHeight = Number.parseFloat(
      getComputedStyle(element).getPropertyValue('--code-project-sticky-height')
    )
    const agentsHeight = Number.parseFloat(
      getComputedStyle(element).getPropertyValue('--code-agents-sticky-height')
    )
    const stickyStackHeight = projectHeight + agentsHeight + files.getBoundingClientRect().height
    const desiredGroupBottom = scroller.getBoundingClientRect().top + stickyStackHeight - 8
    scroller.scrollTop += element.getBoundingClientRect().bottom - desiredGroupBottom
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))

    const before = [projectRow, agents, files].map(row => row.getBoundingClientRect().top)
    scroller.scrollTop += 12
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
    const after = [projectRow, agents, files].map(row => row.getBoundingClientRect().top)
    return after.map((top, index) => Math.round(top - before[index]!))
  })
  expect(releaseMotion).toEqual([-12, -12, -12])
})

test('keeps the active Agent snapshot pseudo inert until drag insertion', async ({ page, workspaceRoot }) => {
  const projectDir = path.join(workspaceRoot, 'active-agent-pseudo')
  fs.mkdirSync(projectDir, { recursive: true })

  await openFarming(page)
  const sourceAgentId = await createControlAgent(page, projectDir)
  const targetAgentId = await createControlAgent(page, projectDir)
  const project = page.getByTestId('code-project-group').filter({ hasText: path.basename(projectDir) })
  const sourceRow = project.locator(`[data-testid="code-agent-row"][data-agent-id="${sourceAgentId}"]`)
  const targetRow = project.locator(`[data-testid="code-agent-row"][data-agent-id="${targetAgentId}"]`)

  await targetRow.click()
  await expect(targetRow).toHaveClass(/active/)
  await expect.poll(() => targetRow.evaluate(element => {
    const before = getComputedStyle(element, '::before')
    return {
      backgroundColor: before.backgroundColor,
      content: before.content,
    }
  })).toEqual({
    backgroundColor: 'rgba(0, 0, 0, 0)',
    content: 'none',
  })

  const dataTransfer = await page.evaluateHandle(() => new DataTransfer())
  const targetBox = await targetRow.boundingBox()
  expect(targetBox).toBeTruthy()
  await sourceRow.dispatchEvent('dragstart', { dataTransfer })
  await targetRow.dispatchEvent('dragover', {
    dataTransfer,
    clientY: targetBox!.y + 1,
  })
  await expect.poll(() => targetRow.evaluate(element => (
    ['rgb(9, 105, 218)', 'rgb(88, 166, 255)'].includes(
      getComputedStyle(element, '::before').backgroundColor,
    )
  ))).toBe(true)
  await sourceRow.dispatchEvent('dragend', { dataTransfer })
})

test('keeps persistent project and pinned Agent order', async ({ page, workspaceRoot }) => {
  const projectDir = path.join(workspaceRoot, 'agent-ordering')
  fs.mkdirSync(projectDir, { recursive: true })

  const enableBrowserResponse = await page.request.post('/farming/api/settings', {
    data: { browserExtensionEnabled: true },
  })
  expect(enableBrowserResponse.ok()).toBeTruthy()
  await openFarming(page)
  const firstAgentId = await createControlAgent(page, projectDir)
  const secondAgentId = await createControlAgent(page, projectDir)
  const thirdAgentId = await createControlAgent(page, projectDir)
  const project = page.getByTestId('code-project-group').filter({ hasText: path.basename(projectDir) })

  await expect(project).toBeVisible()
  await expect.poll(() => projectAgentIds(project)).toEqual([
    thirdAgentId,
    secondAgentId,
    firstAgentId,
  ])

  const sourceRow = project.locator(`[data-testid="code-agent-row"][data-agent-id="${firstAgentId}"]`)
  const targetRow = project.locator(`[data-testid="code-agent-row"][data-agent-id="${thirdAgentId}"]`)
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer())
  const targetBox = await targetRow.boundingBox()
  expect(targetBox).toBeTruthy()
  await sourceRow.dispatchEvent('dragstart', { dataTransfer })
  await targetRow.dispatchEvent('dragover', {
    dataTransfer,
    clientY: targetBox!.y + 1,
  })
  await expect.poll(() => targetRow.evaluate(element => (
    ['rgb(9, 105, 218)', 'rgb(88, 166, 255)'].includes(
      getComputedStyle(element, '::before').backgroundColor,
    )
  ))).toBe(true)
  await sourceRow.dispatchEvent('dragend', { dataTransfer })
  await targetRow.click()
  await expect(targetRow).toHaveClass(/active/)
  await sourceRow.dragTo(targetRow, { targetPosition: { x: 80, y: 2 } })
  await expect.poll(() => projectAgentIds(project)).toEqual([
    firstAgentId,
    thirdAgentId,
    secondAgentId,
  ])
  await expect(targetRow).toHaveClass(/active/)
  await expect(sourceRow).not.toHaveClass(/active/)

  await sourceRow.click()
  await expect(sourceRow).toHaveClass(/active/)

  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect.poll(() => projectAgentIds(project)).toEqual([
    firstAgentId,
    thirdAgentId,
    secondAgentId,
  ])

  for (const agentId of [secondAgentId, firstAgentId]) {
    const response = await page.request.patch(`/farming/api/agents/${agentId}`, {
      data: { pinned: true },
    })
    expect(response.ok()).toBeTruthy()
  }
  const pinned = page.getByTestId('code-pinned-section')
  await expect.poll(() => projectAgentIds(pinned)).toEqual([secondAgentId, firstAgentId])
  await expect(pinned).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await expect(pinned.getByTestId('code-pinned-title')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await expect(pinned.locator('[draggable="true"]')).toHaveCount(2)
  await pinned
    .locator(`[data-testid="code-agent-row"][data-agent-id="${firstAgentId}"]`)
    .dragTo(
      pinned.locator(`[data-testid="code-agent-row"][data-agent-id="${secondAgentId}"]`),
      { targetPosition: { x: 80, y: 2 } },
    )
  await expect.poll(() => projectAgentIds(pinned)).toEqual([firstAgentId, secondAgentId])
  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect.poll(() => projectAgentIds(pinned)).toEqual([firstAgentId, secondAgentId])

  for (const agentId of [firstAgentId, secondAgentId]) {
    const response = await page.request.patch(`/farming/api/agents/${agentId}`, {
      data: { pinned: false },
    })
    expect(response.ok()).toBeTruthy()
  }
  await expect.poll(() => projectAgentIds(project)).toEqual([
    firstAgentId,
    thirdAgentId,
    secondAgentId,
  ])

  await createControlAgent(page, projectDir)
  await createControlAgent(page, projectDir)
  const newestAgentId = await createControlAgent(page, projectDir)
  await expect(project.getByTestId('code-agent-row')).toHaveCount(5)
  await expect(project.getByTestId('code-agent-show-more')).toBeVisible()
  const density = await project.evaluate(element => {
    const list = element.querySelector<HTMLElement>('.code-agents-section > .code-agent-list')
    const files = element.querySelector<HTMLElement>('[data-testid="code-files-section"]')
    const rows = list
      ? Array.from(list.querySelectorAll<HTMLElement>(':scope > [data-testid="code-agent-row"]'))
      : []
    const showMore = list?.querySelector<HTMLElement>(':scope > .code-agent-list-controls [data-testid="code-agent-show-more"]')
    if (!list || !files || rows.length < 2 || !showMore) throw new Error('Project density fixtures are incomplete')
    const rowRects = rows.map(row => row.getBoundingClientRect())
    const showMoreRect = showMore.getBoundingClientRect()
    const filesRect = files.getBoundingClientRect()
    return {
      rowHeights: rowRects.map(rect => rect.height),
      rowSteps: rowRects.slice(1).map((rect, index) => rect.top - rowRects[index].top),
      agentToControlGap: showMoreRect.top - rowRects.at(-1)!.bottom,
      controlToNextSectionGap: filesRect.top - showMoreRect.bottom,
      showMoreHeight: showMoreRect.height,
    }
  })
  expect(density.rowHeights).toEqual([28, 28, 28, 28, 28])
  expect(density.rowSteps).toEqual([28, 28, 28, 28])
  expect(density.showMoreHeight).toBe(28)
  expect(density.agentToControlGap).toBe(0)
  expect(density.controlToNextSectionGap).toBeLessThanOrEqual(2)
  await sourceRow.dragTo(
    project.locator(`[data-testid="code-agent-row"][data-agent-id="${newestAgentId}"]`),
    { targetPosition: { x: 80, y: 2 } },
  )
  await expect(project.getByTestId('code-agent-row')).toHaveCount(5)
  await expect(project.getByTestId('code-agent-show-more')).toBeVisible()
  await expect(project.getByTestId('code-agent-show-less')).toHaveCount(0)

  const newestRow = project.locator(`[data-testid="code-agent-row"][data-agent-id="${newestAgentId}"]`)
  await newestRow.click()
  await expect(newestRow).toHaveClass(/active/)
  const endReorderResponse = page.waitForResponse(response => (
    response.request().method() === 'POST'
    && response.url().includes(`/farming/api/agents/${firstAgentId}/reorder`)
  ))
  await sourceRow.dragTo(project.getByTestId('code-agent-show-more'))
  expect((await endReorderResponse).ok()).toBeTruthy()
  await expect(project.getByTestId('code-agent-row')).toHaveCount(5)
  await expect(project.getByTestId('code-agent-show-more')).toBeVisible()
  await expect(sourceRow).toHaveCount(0)

  const movedAgentTitle = 'Moved pagination Agent'
  const renameResponse = await page.request.patch(`/farming/api/agents/${firstAgentId}`, {
    data: { customTitle: movedAgentTitle },
  })
  expect(renameResponse.ok()).toBeTruthy()
  await page.getByTestId('code-nav-search').click()
  await page.getByTestId('code-search-box').locator('input').fill(movedAgentTitle)
  await expect(project.locator(`[data-testid="code-agent-row"][data-agent-id="${firstAgentId}"]`)).toBeVisible()
  await page.keyboard.press('Escape')

  await project.getByTestId('code-agent-show-more').click()
  await expect(project.getByTestId('code-agent-row')).toHaveCount(6)
  const expandedIds = await projectAgentIds(project)
  expect(expandedIds[expandedIds.length - 1]).toBe(firstAgentId)
})

test('reorders Projects persistently within the sidebar', async ({ page, workspaceRoot }) => {
  const projectA = path.join(workspaceRoot, 'project-order-a')
  const projectB = path.join(workspaceRoot, 'project-order-b')
  const projectC = path.join(workspaceRoot, 'project-order-c')
  const projectIds = [projectA, projectB, projectC]
  projectIds.forEach(project => fs.mkdirSync(project, { recursive: true }))

  await openFarming(page)
  for (const project of projectIds) {
    const response = await page.request.post('/farming/api/projects/mount', {
      data: { workspace: project },
    })
    expect(response.ok()).toBeTruthy()
  }
  await createControlAgent(page, projectA)
  await createControlAgent(page, projectB)
  await createControlAgent(page, projectC)

  await expect.poll(() => orderedProjectIds(page, projectIds)).toEqual([
    projectC,
    projectB,
    projectA,
  ])

  const sourceTitle = page.locator(`[data-testid="code-project-title"][data-project-id="${projectA}"]`)
  const targetTitle = page.locator(`[data-testid="code-project-title"][data-project-id="${projectC}"]`)
  await sourceTitle.dragTo(targetTitle, { targetPosition: { x: 80, y: 2 } })
  await expect.poll(() => orderedProjectIds(page, projectIds)).toEqual([
    projectA,
    projectC,
    projectB,
  ])

  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect.poll(() => orderedProjectIds(page, projectIds)).toEqual([
    projectA,
    projectC,
    projectB,
  ])
})

test('keeps Project Files on workspace identity while its source Agent changes', async ({ page, workspaceRoot }) => {
  const projectDir = path.join(workspaceRoot, 'stable-project-files')
  fs.mkdirSync(projectDir, { recursive: true })
  fs.writeFileSync(path.join(projectDir, 'one.txt'), 'one\n')
  fs.writeFileSync(path.join(projectDir, 'two.txt'), 'two\n')
  const filesRequestRootIds: string[] = []
  page.on('websocket', socket => {
    socket.on('framesent', ({ payload }) => {
      try {
        const message = JSON.parse(String(payload)) as {
          type?: string
          request?: { rootId?: string }
        }
        if (message.type === 'workspace-request' && message.request?.rootId) {
          filesRequestRootIds.push(message.request.rootId)
        }
      } catch {
        // Ignore terminal and other non-JSON websocket frames.
      }
    })
  })
  const expectedFilesId = projectFilesWorkspaceId(projectDir)

  await openFarming(page)
  const firstAgentId = await createControlAgent(page, projectDir)
  const secondAgentId = await createControlAgent(page, projectDir)
  const project = page.getByTestId('code-project-group').filter({
    has: page.locator(`[data-testid="code-agent-row"][data-agent-id="${firstAgentId}"]`),
  })
  await expect(project).toBeVisible()
  await expect.poll(() => projectAgentIds(project)).toEqual([secondAgentId, firstAgentId])

  const files = project.getByTestId('code-files-section')
  const filesTitle = files.locator('.code-files-title').first()
  if (await filesTitle.getAttribute('aria-expanded') !== 'true') {
    await filesTitle.click()
  }
  const oneRow = page.locator('[data-testid="code-file-row"][data-file-path="one.txt"]')
  const twoRow = page.locator('[data-testid="code-file-row"][data-file-path="two.txt"]')
  await expect(oneRow).toBeVisible()
  await expect.poll(() => filesRequestRootIds.includes(expectedFilesId)).toBe(true)
  expect(filesRequestRootIds).not.toContain(firstAgentId)
  expect(filesRequestRootIds).not.toContain(secondAgentId)

  let oneRowBox: Awaited<ReturnType<typeof oneRow.boundingBox>> = null
  await expect.poll(async () => {
    oneRowBox = await oneRow.boundingBox()
    return Boolean(oneRowBox)
  }).toBe(true)
  await page.mouse.move(oneRowBox!.x + oneRowBox!.width / 2, oneRowBox!.y + oneRowBox!.height / 2)
  await page.mouse.down()

  const reorderResponse = await page.request.post(`/farming/api/agents/${firstAgentId}/reorder`, {
    data: { beforeAgentId: '', afterAgentId: secondAgentId },
  })
  expect(reorderResponse.ok()).toBeTruthy()
  await expect.poll(() => projectAgentIds(project)).toEqual([firstAgentId, secondAgentId])
  await page.mouse.up()
  await expect(page.getByTestId('code-file-editor').getByRole('tab', { selected: true })).toContainText('one.txt')

  const deleteResponse = await page.request.delete(`/farming/api/control/agents/${secondAgentId}`)
  expect(deleteResponse.ok()).toBeTruthy()
  await expect(page.locator(`[data-testid="code-agent-row"][data-agent-id="${secondAgentId}"]`)).toHaveCount(0)
  await expect(twoRow).toBeVisible()
  await twoRow.click()
  await expect(page.getByTestId('code-file-editor').getByRole('tab', { selected: true })).toContainText('two.txt')
  await expect.poll(() => filesRequestRootIds.includes(expectedFilesId)).toBe(true)
  expect(filesRequestRootIds).not.toContain(firstAgentId)
  expect(filesRequestRootIds).not.toContain(secondAgentId)
  await page.getByTestId('code-file-editor-back').click()
  await expect(project.locator(`[data-testid="code-agent-row"][data-agent-id="${firstAgentId}"]`)).toHaveClass(/active/)
})
