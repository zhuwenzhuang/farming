import fs from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
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

test('projects recent attention into Pinned without turning it into a manual pin', async ({ page, workspaceRoot }) => {
  await page.clock.install()
  const workspace = path.join(workspaceRoot, 'dynamic-pinning')
  fs.mkdirSync(workspace, { recursive: true })
  const agentId = await createControlAgent(page, workspace)
  const unreadAgentId = await createControlAgent(page, workspace)
  await openFarming(page)

  const pinnedSection = page.getByTestId('code-pinned-section')
  const toggle = page.getByTestId('code-pinned-dynamic-toggle')
  const pinnedRow = pinnedSection.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
  const unreadPinnedRow = pinnedSection.locator(`[data-testid="code-agent-row"][data-agent-id="${unreadAgentId}"]`)
  const projectGroup = page.getByTestId('code-project-group').filter({ hasText: path.basename(workspace) })
  const projectRow = projectGroup.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)

  await expect(pinnedSection).toBeVisible()
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

  await page.evaluate(id => {
    window.__farmingAgentActivityTest?.update(id, {
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
  }, unreadAgentId)
  await expect(page.getByTestId('code-pinned-dynamic-unread')).toBeVisible()

  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await expect(page.getByTestId('code-pinned-dynamic-unread')).toBeVisible()
  await expect(projectRow).toBeVisible()

  await toggle.click()
  await expect(unreadPinnedRow).toBeVisible()
  await page.evaluate(id => {
    window.__farmingAgentActivityTest?.update(id, {
      readAttentionAt: Date.now(),
      unread: false,
    })
  }, unreadAgentId)
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
        exitedAt: oldActivityAt,
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
  await expect(pinnedRow).toBeVisible()

  await page.clock.fastForward(DYNAMIC_PIN_ACTIVITY_WINDOW_MS + 60_000)
  await expect(pinnedRow).toHaveCount(0)
  await expect(unreadPinnedRow).toBeVisible()
  await expect(projectRow).toBeVisible()
})
