import fs from 'node:fs'
import path from 'node:path'
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

test('keeps Agent messages unread while browsing associated files', async ({ page, workspaceRoot }) => {
  const projectDir = path.join(workspaceRoot, 'agent-read-state')
  fs.mkdirSync(projectDir, { recursive: true })
  fs.writeFileSync(path.join(projectDir, 'one.txt'), 'one\n')
  fs.writeFileSync(path.join(projectDir, 'two.txt'), 'two\n')

  await openFarming(page)
  const agentId = await createControlAgent(page, projectDir)
  const agentRow = page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
  await expect(agentRow).toBeVisible()

  const project = page.getByTestId('code-project-group').filter({ has: agentRow })
  const files = project.getByTestId('code-files-section')
  const filesTitle = files.locator('.code-files-title').first()
  if (await filesTitle.getAttribute('aria-expanded') !== 'true') {
    await filesTitle.click()
  }
  await files.locator('[data-testid="code-file-row"][data-file-path="one.txt"]').click()
  await expect(page.getByTestId('code-file-editor').getByRole('tab', { selected: true })).toContainText('one.txt')

  const unreadResponse = await page.request.patch(`/farming/api/agents/${agentId}`, {
    data: { unread: true },
  })
  expect(unreadResponse.ok()).toBeTruthy()
  await expect(agentRow).toHaveClass(/unread/)

  await files.locator('[data-testid="code-file-row"][data-file-path="two.txt"]').click()
  await expect(page.getByTestId('code-file-editor').getByRole('tab', { selected: true })).toContainText('two.txt')
  await expect(agentRow).toHaveClass(/unread/)
})
