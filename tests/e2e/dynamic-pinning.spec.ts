import fs from 'node:fs'
import path from 'node:path'
import type { Locator, Page, TestInfo } from '@playwright/test'
import { expect, openFarming, test } from './fixtures'

const DYNAMIC_PIN_ACTIVITY_WINDOW_MS = 60 * 60 * 1000

async function createControlAgent(page: Page, workspace: string) {
  const response = await page.request.post('/farming/api/control/agents', {
    data: { command: 'bash', workspace },
  })
  expect(response.ok()).toBeTruthy()
  const body = await response.json() as { agentId?: string }
  if (!body.agentId) throw new Error('Control Agent creation returned no Agent ID')
  return body.agentId
}

async function renameAgent(page: Page, agentId: string, customTitle: string) {
  const response = await page.request.patch(`/farming/api/agents/${agentId}`, {
    data: { customTitle },
  })
  expect(response.ok()).toBeTruthy()
}

async function pinAgent(page: Page, agentId: string) {
  const response = await page.request.patch(`/farming/api/agents/${agentId}`, {
    data: { pinned: true },
  })
  expect(response.ok()).toBeTruthy()
}

async function updateAgentLiveState(page: Page, agentId: string, patch: Record<string, unknown>) {
  await page.evaluate(({ id, nextPatch }) => {
    if (!window.__farmingAgentActivityTest) throw new Error('Agent activity test hook is unavailable')
    window.__farmingAgentActivityTest.update(id, nextPatch)
  }, { id: agentId, nextPatch: patch })
  await page.clock.runFor(50)
}

async function agentIds(container: Locator) {
  return container.locator('[data-testid="code-agent-row"]').evaluateAll(rows => (
    rows.map(row => row.getAttribute('data-agent-id')).filter((id): id is string => Boolean(id))
  ))
}

async function saveSidebarScreenshot(page: Page, testInfo: TestInfo, name: string) {
  const screenshotPath = testInfo.outputPath('dynamic-pinning', name)
  fs.mkdirSync(path.dirname(screenshotPath), { recursive: true })
  await page.getByTestId('code-sidebar').screenshot({
    path: screenshotPath,
    animations: 'disabled',
  })
  return screenshotPath
}

test('does not render dynamic pinning controls without pinned Agents', async ({ page, workspaceRoot }, testInfo) => {
  await openFarming(page)

  await expect(page.getByText('No agents yet.')).toBeVisible()
  await expect(page.getByTestId('code-pinned-section')).toHaveCount(0)
  await expect(page.getByTestId('code-pinned-dynamic-toggle')).toHaveCount(0)
  await saveSidebarScreenshot(page, testInfo, 'light-empty-no-pinned.png')

  const workspace = path.join(workspaceRoot, 'dynamic-pinning-no-manual-pins')
  fs.mkdirSync(workspace, { recursive: true })
  const agentId = await createControlAgent(page, workspace)
  await expect(page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)).toBeVisible()
  await expect(page.getByTestId('code-pinned-section')).toHaveCount(0)
  await expect(page.getByTestId('code-pinned-dynamic-toggle')).toHaveCount(0)
  await saveSidebarScreenshot(page, testInfo, 'light-agent-without-pinned-section.png')
})

test('projects recent attention into Pinned without turning it into a manual pin', async ({ page, workspaceRoot }, testInfo) => {
  await page.clock.install()
  const workspace = path.join(workspaceRoot, 'dynamic-pinning')
  fs.mkdirSync(workspace, { recursive: true })
  const agentId = await createControlAgent(page, workspace)
  const unreadAgentId = await createControlAgent(page, workspace)
  const anchorAgentId = await createControlAgent(page, workspace)
  await renameAgent(page, anchorAgentId, 'Manual Anchor')
  await pinAgent(page, anchorAgentId)
  await openFarming(page)

  const activeAgentId = await page.locator('[data-testid="code-agent-row"].active').getAttribute('data-agent-id')
  const unreadTargetId = activeAgentId === unreadAgentId ? agentId : unreadAgentId
  const recentTargetId = unreadTargetId === agentId ? unreadAgentId : agentId
  const pinnedSection = page.getByTestId('code-pinned-section')
  const toggle = page.getByTestId('code-pinned-dynamic-toggle')
  const pinnedRow = pinnedSection.locator(`[data-testid="code-agent-row"][data-agent-id="${recentTargetId}"]`)
  const unreadPinnedRow = pinnedSection.locator(`[data-testid="code-agent-row"][data-agent-id="${unreadTargetId}"]`)
  const projectGroup = page.getByTestId('code-project-group').filter({ hasText: path.basename(workspace) })
  const projectRow = projectGroup.locator(`[data-testid="code-agent-row"][data-agent-id="${recentTargetId}"]`)

  await expect(pinnedSection).toBeVisible()
  await expect(pinnedSection.getByTestId('code-pinned-dynamic-toggle')).toBeVisible()
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await expect(pinnedRow).toHaveCount(0)
  await expect(projectRow).toBeVisible()

  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await expect(pinnedRow).toBeVisible()
  await expect(projectRow).toHaveCount(0)
  await expect(pinnedRow.getByTestId('code-agent-row-age')).toBeVisible()
  await expect(pinnedRow.getByTestId('code-agent-row-age')).toHaveText('now')
  await expect(pinnedRow.getByTestId('code-agent-row-pin')).toHaveAttribute('aria-label', 'Pin Agent')

  await page.reload()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await expect(pinnedRow).toBeVisible()

  await updateAgentLiveState(page, unreadTargetId, {
    attentionUpdatedAt: Date.now(),
    unread: true,
    runtimeObservation: {
      kind: 'shell',
      phase: 'working',
      confidence: 'authoritative',
      source: 'structured-runtime',
      observerVersion: 'dynamic-pinning-test',
      observedAt: Date.now(),
    },
  })
  await expect(page.getByTestId('code-pinned-dynamic-unread')).toBeVisible()
  await saveSidebarScreenshot(page, testInfo, 'light-unread-and-recent.png')

  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await expect(page.getByTestId('code-pinned-dynamic-unread')).toBeVisible()
  await expect.poll(() => agentIds(pinnedSection)).toEqual([anchorAgentId])
  await expect(projectRow).toBeVisible()

  await toggle.click()
  await expect(unreadPinnedRow).toBeVisible()
  await page.evaluate(id => {
    window.__farmingAgentActivityTest?.update(id, {
      readAttentionAt: Date.now(),
      unread: false,
    })
  }, unreadTargetId)
  await page.clock.runFor(50)
  await expect(page.getByTestId('code-pinned-dynamic-unread')).toHaveCount(0)
  await unreadPinnedRow.hover()
  await unreadPinnedRow.getByTestId('code-agent-row-pin').click()
  await expect(unreadPinnedRow.getByTestId('code-agent-row-pin')).toHaveAttribute('aria-label', 'Unpin Agent')
  await pinnedRow.click()
  await expect(pinnedRow).toBeVisible()

  await page.evaluate(({ ids, oldActivityAt }) => {
    ids.forEach(id => {
      window.__farmingAgentActivityTest?.update(id, {
        attentionUpdatedAt: oldActivityAt,
        lastActivity: oldActivityAt,
        readAttentionAt: oldActivityAt,
        unread: false,
        runtimeObservation: {
          kind: 'shell',
          phase: 'idle',
          confidence: 'authoritative',
          source: 'structured-runtime',
          observerVersion: 'dynamic-pinning-test',
          observedAt: oldActivityAt,
        },
      })
    })
  }, {
    ids: [agentId, unreadAgentId],
    oldActivityAt: Date.now() - DYNAMIC_PIN_ACTIVITY_WINDOW_MS - 1,
  })
  await page.clock.runFor(50)
  await expect(pinnedRow).toBeVisible()

  await page.clock.fastForward(DYNAMIC_PIN_ACTIVITY_WINDOW_MS + 60_000)
  await expect(pinnedRow).toHaveCount(0)
  await expect(unreadPinnedRow).toBeVisible()
  await expect(projectRow).toBeVisible()
})

test('keeps every current attention state pinned while recent idle work expires', async ({ page, workspaceRoot }, testInfo) => {
  await page.clock.install()
  const workspace = path.join(workspaceRoot, 'dynamic-pinning-attention')
  fs.mkdirSync(workspace, { recursive: true })
  const ids = {
    working: await createControlAgent(page, workspace),
    waiting: await createControlAgent(page, workspace),
    pending: await createControlAgent(page, workspace),
    unread: await createControlAgent(page, workspace),
    completed: await createControlAgent(page, workspace),
  }
  const anchorId = await createControlAgent(page, workspace)
  await Promise.all([
    renameAgent(page, ids.working, 'Working Agent'),
    renameAgent(page, ids.waiting, 'Waiting Agent'),
    renameAgent(page, ids.pending, 'Pending Agent'),
    renameAgent(page, ids.unread, 'Unread Agent'),
    renameAgent(page, ids.completed, 'Completed Agent'),
    renameAgent(page, anchorId, 'Manual Anchor'),
  ])
  await pinAgent(page, anchorId)
  await openFarming(page)
  const anchorRow = page.locator(`[data-testid="code-agent-row"][data-agent-id="${anchorId}"]`)
  await anchorRow.click()
  await expect(anchorRow).toHaveClass(/active/)

  const oldActivityAt = Date.now() - DYNAMIC_PIN_ACTIVITY_WINDOW_MS - 1
  const idleObservation = {
    kind: 'shell',
    phase: 'idle',
    confidence: 'authoritative',
    source: 'structured-runtime',
    observerVersion: 'dynamic-pinning-matrix-test',
    observedAt: oldActivityAt,
  }
  const commonOldState = {
    attentionUpdatedAt: oldActivityAt,
    lastActivity: oldActivityAt,
    readAttentionAt: oldActivityAt,
    status: 'running',
    unread: false,
  }
  const setCurrentAttentionStates = async () => {
    await updateAgentLiveState(page, ids.working, {
      ...commonOldState,
      runtimeObservation: { ...idleObservation, phase: 'working' },
    })
    await updateAgentLiveState(page, ids.waiting, {
      ...commonOldState,
      runtimeObservation: { ...idleObservation, phase: 'waiting' },
    })
    await updateAgentLiveState(page, ids.pending, {
      ...commonOldState,
      status: 'pending',
      runtimeObservation: { ...idleObservation, phase: 'starting' },
    })
    await updateAgentLiveState(page, ids.unread, {
      ...commonOldState,
      unread: true,
      runtimeObservation: idleObservation,
    })
  }
  await setCurrentAttentionStates()
  await updateAgentLiveState(page, ids.completed, {
    ...commonOldState,
    lastActivity: Date.now(),
    runtimeObservation: { ...idleObservation, observedAt: Date.now() },
  })

  const pinnedSection = page.getByTestId('code-pinned-section')
  await pinnedSection.getByTestId('code-pinned-dynamic-toggle').click()
  for (const agentId of Object.values(ids)) {
    const row = pinnedSection.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
    await expect(row).toBeVisible()
    await expect(row.getByTestId('code-agent-row-age')).toHaveText('now')
  }
  await expect(page.getByTestId('code-pinned-dynamic-unread')).toBeVisible()
  const completedRow = pinnedSection.locator(`[data-testid="code-agent-row"][data-agent-id="${ids.completed}"]`)
  await expect(completedRow.locator('.code-agent-dot')).toHaveCount(0)
  await saveSidebarScreenshot(page, testInfo, 'light-attention-state-matrix.png')

  await page.clock.fastForward(DYNAMIC_PIN_ACTIVITY_WINDOW_MS + 60_000)
  await setCurrentAttentionStates()
  await expect(pinnedSection.locator(`[data-testid="code-agent-row"][data-agent-id="${ids.completed}"]`)).toHaveCount(0)
  for (const agentId of [ids.working, ids.waiting, ids.pending, ids.unread]) {
    await expect(pinnedSection.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)).toBeVisible()
  }

  const expiredAt = Date.now() - DYNAMIC_PIN_ACTIVITY_WINDOW_MS - 1
  for (const agentId of [ids.working, ids.waiting, ids.pending, ids.unread]) {
    await updateAgentLiveState(page, agentId, {
      attentionUpdatedAt: expiredAt,
      lastActivity: expiredAt,
      readAttentionAt: expiredAt,
      status: 'running',
      unread: false,
      runtimeObservation: { ...idleObservation, observedAt: expiredAt },
    })
  }
  await expect.poll(() => agentIds(pinnedSection)).toEqual([anchorId])
  await expect(pinnedSection).toBeVisible()
  await expect(page.getByTestId('code-pinned-dynamic-unread')).toHaveCount(0)
})

test('keeps manual order stable, deduplicates rows, and renders the dark narrow state', async ({ page, workspaceRoot }, testInfo) => {
  await page.clock.install()
  const appearanceResponse = await page.request.post('/farming/api/settings', {
    data: { appearance: 'dark' },
  })
  expect(appearanceResponse.ok()).toBeTruthy()
  const workspace = path.join(workspaceRoot, 'dynamic-pinning-order')
  fs.mkdirSync(workspace, { recursive: true })
  const firstDynamicId = await createControlAgent(page, workspace)
  const manualId = await createControlAgent(page, workspace)
  const secondDynamicId = await createControlAgent(page, workspace)
  await Promise.all([
    renameAgent(page, firstDynamicId, 'Dynamic First'),
    renameAgent(page, manualId, 'Manual Pin'),
    renameAgent(page, secondDynamicId, 'Dynamic Second'),
  ])
  const pinResponse = await page.request.patch(`/farming/api/agents/${manualId}`, {
    data: { pinned: true },
  })
  expect(pinResponse.ok()).toBeTruthy()
  await openFarming(page)
  await expect(page.locator('body')).toHaveAttribute('data-appearance', 'dark')

  const pinnedSection = page.getByTestId('code-pinned-section')
  const projectGroup = page.getByTestId('code-project-group').filter({ hasText: path.basename(workspace) })
  const manualRow = pinnedSection.locator(`[data-testid="code-agent-row"][data-agent-id="${manualId}"]`)
  const dynamicOrder = await agentIds(projectGroup)
  expect(dynamicOrder).toHaveLength(2)
  expect(new Set(dynamicOrder)).toEqual(new Set([firstDynamicId, secondDynamicId]))
  await expect(manualRow.getByTestId('code-agent-row-age')).toBeHidden()

  const toggle = page.getByTestId('code-pinned-dynamic-toggle')
  await toggle.click()
  await expect.poll(() => agentIds(pinnedSection)).toEqual([manualId, ...dynamicOrder])
  await expect(manualRow).toHaveAttribute('draggable', 'true')
  await expect(manualRow.getByTestId('code-agent-row-age')).toBeVisible()
  for (const agentId of dynamicOrder) {
    const row = pinnedSection.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
    await expect(row).not.toHaveAttribute('draggable', 'true')
  }
  for (const agentId of [manualId, ...dynamicOrder]) {
    await expect(page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)).toHaveCount(1)
  }

  const activeAgentId = await page.locator('[data-testid="code-agent-row"].active').getAttribute('data-agent-id')
  const unreadDynamicId = dynamicOrder.find(agentId => agentId !== activeAgentId) ?? dynamicOrder[0]
  const remainingDynamicId = dynamicOrder.find(agentId => agentId !== unreadDynamicId) ?? dynamicOrder[0]
  await updateAgentLiveState(page, unreadDynamicId, { unread: true })
  await expect(page.getByTestId('code-pinned-dynamic-unread')).toBeVisible()
  await saveSidebarScreenshot(page, testInfo, 'dark-manual-and-dynamic-order.png')
  await manualRow.hover()
  await expect(manualRow.getByTestId('code-agent-row-age')).toBeHidden()
  await expect(manualRow.getByTestId('code-agent-row-pin')).toBeVisible()
  await saveSidebarScreenshot(page, testInfo, 'dark-hover-actions.png')

  await toggle.click()
  await expect(page.getByTestId('code-pinned-dynamic-unread')).toBeVisible()
  await expect.poll(() => agentIds(pinnedSection)).toEqual([manualId])
  await expect.poll(() => agentIds(projectGroup)).toEqual(dynamicOrder)

  await toggle.click()
  await manualRow.hover()
  await manualRow.getByTestId('code-agent-row-pin').click()
  await expect(manualRow.getByTestId('code-agent-row-pin')).toHaveAttribute('aria-label', 'Pin Agent')
  await expect(manualRow).not.toHaveAttribute('draggable', 'true')
  await expect(manualRow).toBeVisible()

  const archivedRow = pinnedSection.locator(`[data-testid="code-agent-row"][data-agent-id="${unreadDynamicId}"]`)
  await archivedRow.hover()
  await archivedRow.getByTestId('code-agent-row-archive').click()
  await expect(page.locator(`[data-testid="code-agent-row"][data-agent-id="${unreadDynamicId}"]`)).toHaveCount(0)
  await expect(page.getByTestId('code-pinned-dynamic-unread')).toHaveCount(0)

  await toggle.click()
  await expect(pinnedSection.getByTestId('code-agent-row')).toHaveCount(0)
  await expect.poll(() => agentIds(projectGroup)).toHaveLength(2)
  expect(new Set(await agentIds(projectGroup))).toEqual(new Set([manualId, remainingDynamicId]))
})
