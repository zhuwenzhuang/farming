import fs from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { expect, openFarming, test } from './fixtures'

async function createAcpAgent(page: Page, workspace: string) {
  const response = await page.request.post('/farming/api/control/agents', {
    data: { command: 'claude', workspace, agentRuntimeMode: 'chat' },
  })
  expect(response.ok()).toBeTruthy()
  const payload = await response.json() as { agentId?: string }
  expect(payload.agentId).toBeTruthy()
  return payload.agentId as string
}

test('History search closes consistently with Escape', async ({ page }) => {
  await openFarming(page)
  await page.getByTestId('code-nav-history').click()

  const search = page.getByTestId('code-history-search-box').getByRole('searchbox')
  await search.fill('resume')
  await search.press('Escape')

  await expect(page.getByTestId('code-history-panel')).toHaveCount(0)
  await expect(page.getByTestId('code-terminal-grid')).toBeVisible()
})

test('ACP composer menus close with Escape and restore input focus', async ({ page, workspaceRoot }) => {
  const workspace = path.join(workspaceRoot, 'computer-use-acp-menu')
  fs.mkdirSync(workspace, { recursive: true })
  const agentId = await createAcpAgent(page, workspace)

  await page.route(/\/farming\/api\/agents\/[^/]+\/acp-session(?:\?includeEntries=0)?$/, async route => {
    await route.fulfill({ json: {
      session: {
        provider: 'claude',
        sessionId: 'computer-use-menu-session',
        state: 'ready',
        error: '',
        stopReason: '',
        availableCommands: [],
        currentModeId: '',
        modes: null,
        configOptions: [
          {
            id: 'model',
            name: 'Model',
            type: 'select',
            currentValue: 'gpt-5.6-sol',
            options: [{ value: 'gpt-5.6-sol', name: 'GPT-5.6-Sol' }],
          },
          {
            id: 'reasoning',
            name: 'Reasoning',
            type: 'select',
            currentValue: 'high',
            options: [{ value: 'high', name: 'High' }],
          },
        ],
        usage: null,
      },
    } })
  })

  await openFarming(page)
  await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
  await page.getByTestId('code-acp-model-picker').click()
  await expect(page.getByTestId('code-acp-model-menu')).toBeVisible()

  await page.keyboard.press('Escape')

  await expect(page.getByTestId('code-acp-model-menu')).toHaveCount(0)
  await expect(page.getByTestId('code-acp-composer-input')).toBeFocused()
})

test('expanded Usage panel collapses with Escape', async ({ page }) => {
  await openFarming(page)
  const toggle = page.getByTestId('code-usage-toggle')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')

  await toggle.press('Escape')

  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
})
