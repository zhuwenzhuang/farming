import fs from 'node:fs'
import path from 'node:path'
import type { Locator, Page, TestInfo } from '@playwright/test'
import { expect, openFarming, test } from './fixtures'

async function createControlAgent(page: Page, workspace: string, title: string) {
  const response = await page.request.post('/farming/api/control/agents', {
    data: { command: 'bash', workspace },
  })
  expect(response.ok()).toBeTruthy()
  const body = await response.json() as { agentId?: string }
  if (!body.agentId) throw new Error('Control Agent creation returned no Agent ID')
  const renameResponse = await page.request.patch(`/farming/api/agents/${body.agentId}`, {
    data: { customTitle: title },
  })
  expect(renameResponse.ok()).toBeTruthy()
  return body.agentId
}

async function updateAgent(page: Page, agentId: string, patch: Record<string, unknown>) {
  const response = await page.request.patch(`/farming/api/agents/${agentId}`, { data: patch })
  expect(response.ok()).toBeTruthy()
  return response.json() as Promise<Record<string, unknown>>
}

function agentRow(page: Page, agentId: string) {
  return page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
}

async function visibleTrailingBoxes(row: Locator) {
  return row.locator([
    '.code-agent-dot',
    '[data-testid="code-agent-follow-up"]',
    '.code-agent-unread',
  ].join(', ')).evaluateAll(elements => elements
    .filter(element => element.getClientRects().length > 0)
    .map(element => {
      const rect = element.getBoundingClientRect()
      return { left: rect.left, right: rect.right }
    })
    .sort((left, right) => left.left - right.left))
}

async function attachSidebarScreenshot(page: Page, testInfo: TestInfo, name: string) {
  await testInfo.attach(name, {
    body: await page.getByTestId('code-sidebar').screenshot({ animations: 'disabled' }),
    contentType: 'image/png',
  })
}

async function attachContextMenuScreenshot(page: Page, testInfo: TestInfo, name: string) {
  const viewport = page.viewportSize()
  if (!viewport) throw new Error('Context menu screenshot requires a viewport')
  await testInfo.attach(name, {
    body: await page.screenshot({
      animations: 'disabled',
      clip: { x: 0, y: 0, width: Math.min(520, viewport.width), height: viewport.height },
    }),
    contentType: 'image/png',
  })
}

test('marks, counts, persists, deduplicates, and unmarks Agents', async ({ page, workspaceRoot }, testInfo) => {
  const workspace = path.join(workspaceRoot, 'agent-follow-up')
  fs.mkdirSync(workspace, { recursive: true })
  const quickToggleId = await createControlAgent(page, workspace, 'Quick toggle')
  const pinnedId = await createControlAgent(page, workspace, 'Pinned unread follow-up')
  const ordinaryId = await createControlAgent(page, workspace, 'Ordinary Agent')

  const quickState = await updateAgent(page, quickToggleId, { followUp: true })
  expect(quickState.followUp).toBe(true)
  const pinnedState = await updateAgent(page, pinnedId, {
    followUp: true,
    pinned: true,
    unread: true,
  })
  expect(pinnedState.followUp).toBe(true)

  await openFarming(page)

  const project = page.getByTestId('code-project-group').filter({ hasText: path.basename(workspace) })
  const quickRow = agentRow(page, quickToggleId)
  const pinnedRow = agentRow(page, pinnedId)
  const ordinaryRow = agentRow(page, ordinaryId)

  await expect(page.getByTestId('code-follow-up-filter')).toHaveCount(0)
  await expect(project).toHaveAttribute('data-project-follow-up-count', '2')
  await expect(project.getByTestId('code-project-follow-up-count')).toHaveText('2')
  await expect(quickRow.getByTestId('code-agent-follow-up')).toBeVisible()
  await expect(quickRow.getByTestId('code-agent-follow-up').locator('path')).toHaveAttribute(
    'd',
    'M3 2.25a.75.75 0 0 1 1.5 0v.5h7.3c.68 0 1.05.8.6 1.3L10.7 6l1.7 1.95c.45.5.08 1.3-.6 1.3H4.5v4.5a.75.75 0 0 1-1.5 0V2.25Z',
  )
  await expect(pinnedRow.getByTestId('code-agent-follow-up')).toBeVisible()
  await expect(ordinaryRow.getByTestId('code-agent-follow-up')).toHaveCount(0)
  await expect(agentRow(page, pinnedId)).toHaveCount(1)

  await ordinaryRow.click()
  await expect(ordinaryRow).toHaveClass(/active/)
  await page.evaluate(id => {
    window.__farmingAgentActivityTest?.update(id, { unread: true })
  }, pinnedId)
  await expect(pinnedRow).toHaveClass(/unread/)
  const trailingBoxes = await visibleTrailingBoxes(pinnedRow)
  expect(trailingBoxes.length).toBeGreaterThanOrEqual(2)
  for (let index = 1; index < trailingBoxes.length; index += 1) {
    expect(trailingBoxes[index].left).toBeGreaterThanOrEqual(trailingBoxes[index - 1].right - 0.5)
  }

  await ordinaryRow.hover()
  const quickButton = ordinaryRow.getByTestId('code-agent-row-follow-up')
  await expect(quickButton).toHaveAttribute('aria-label', 'Mark')
  await quickButton.click()
  await expect(ordinaryRow.getByTestId('code-agent-follow-up')).toBeVisible()
  await expect(project).toHaveAttribute('data-project-follow-up-count', '3')
  await attachSidebarScreenshot(page, testInfo, 'follow-up-light-hover.png')

  await page.reload({ waitUntil: 'domcontentloaded' })
  for (const agentId of [quickToggleId, pinnedId, ordinaryId]) {
    await expect(agentRow(page, agentId)).toHaveCount(1)
  }
  await expect(agentRow(page, ordinaryId).getByTestId('code-agent-follow-up')).toBeVisible()

  const reloadedOrdinaryRow = agentRow(page, ordinaryId)
  await reloadedOrdinaryRow.hover()
  await reloadedOrdinaryRow.getByTestId('code-agent-row-follow-up').click()
  await expect(reloadedOrdinaryRow.getByTestId('code-agent-follow-up')).toHaveCount(0)
  await expect(project).toHaveAttribute('data-project-follow-up-count', '2')

  const reloadedQuickRow = agentRow(page, quickToggleId)
  await reloadedQuickRow.click({ button: 'right' })
  const menu = page.getByTestId('code-agent-context-menu')
  await expect(menu).toBeVisible()
  expect(await menu.getByRole('menuitem').evaluateAll(items => (
    items.slice(0, 5).map(item => item.textContent?.trim())
  ))).toEqual(['Pin Agent', 'Rename Agent', 'Archive', 'Mark as unread', 'Unmark'])
  await attachContextMenuScreenshot(page, testInfo, 'follow-up-light-context-menu.png')
  await menu.getByRole('menuitem', { name: 'Unmark', exact: true }).click()
  await expect(reloadedQuickRow.getByTestId('code-agent-follow-up')).toHaveCount(0)
  await expect(project).toHaveAttribute('data-project-follow-up-count', '1')

  const reloadedPinnedRow = agentRow(page, pinnedId)
  await reloadedPinnedRow.hover()
  await reloadedPinnedRow.getByTestId('code-agent-row-follow-up').click()
  await expect(reloadedPinnedRow.getByTestId('code-agent-follow-up')).toHaveCount(0)
  await expect(project).toHaveAttribute('data-project-follow-up-count', '0')
})

test('renders the dark simultaneous state in Code and keeps CRT free of follow-up UI', async ({ page, workspaceRoot }, testInfo) => {
  const appearanceResponse = await page.request.post('/farming/api/settings', {
    data: { appearance: 'dark' },
  })
  expect(appearanceResponse.ok()).toBeTruthy()
  const workspace = path.join(workspaceRoot, 'agent-follow-up-dark')
  fs.mkdirSync(workspace, { recursive: true })
  const agentId = await createControlAgent(page, workspace, 'Dark follow-up')
  const activeAgentId = await createControlAgent(page, workspace, 'Current Agent')
  await updateAgent(page, agentId, { followUp: true, pinned: true, unread: true })

  await openFarming(page)
  await expect(page.locator('body')).toHaveAttribute('data-appearance', 'dark')
  await agentRow(page, activeAgentId).click()
  await expect(agentRow(page, activeAgentId)).toHaveClass(/active/)
  await page.evaluate(id => {
    window.__farmingAgentActivityTest?.update(id, { unread: true })
  }, agentId)
  const row = agentRow(page, agentId)
  await expect(row).toHaveClass(/follow-up/)
  await expect(row).toHaveClass(/pinned/)
  await expect(row).toHaveClass(/unread/)
  await row.hover()
  await expect(row.getByTestId('code-agent-row-follow-up')).toHaveAttribute('aria-pressed', 'true')
  await attachSidebarScreenshot(page, testInfo, 'follow-up-dark-simultaneous-hover.png')

  await page.goto(`/farming/crt/?agent=${encodeURIComponent(agentId)}`, { waitUntil: 'domcontentloaded' })
  await expect(page.locator('#farming-crt')).toBeVisible()
  await expect(page.locator('[data-testid*="follow-up"], .code-agent-follow-up')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /follow up|待跟进/i })).toHaveCount(0)
  await expect(page.getByText(/follow up|待跟进/i)).toHaveCount(0)
})
