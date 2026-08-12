import fs from 'node:fs'
import path from 'node:path'
import { projectFilesWorkspaceId } from '../../src/lib/project-workspaces'
import { expect, openFarming, openNewAgentDialog, startAgentFromOpenDialog, test } from './fixtures'

test('hides the Desktop section when Computer Use is disabled', async ({ page, workspaceRoot }) => {
  const workspace = path.join(workspaceRoot, 'disabled-computer-extension')
  fs.mkdirSync(workspace, { recursive: true })
  const settingsResponse = await page.request.post('/farming/api/settings', {
    data: {
      browserExtensionEnabled: true,
      computerExtensionEnabled: false,
    },
  })
  expect(settingsResponse.ok()).toBeTruthy()

  await openFarming(page)
  await openNewAgentDialog(page)
  const agentId = await startAgentFromOpenDialog(page, 'bash', workspace)
  const browserResponse = await page.request.post('/farming/api/browsers', {
    data: {
      rootId: projectFilesWorkspaceId(workspace),
      agentId,
      name: 'Browser without Computer Use',
    },
  })
  expect(browserResponse.ok()).toBeTruthy()

  const agentRow = page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
  const resourcesToggle = agentRow.getByTestId('code-agent-resources-toggle')
  await agentRow.hover()
  await expect(resourcesToggle).toBeVisible()
  await resourcesToggle.click()
  const resourceSlot = page.locator(
    `[data-testid="code-agent-resource-slot"][data-agent-id="${agentId}"]`,
  )
  await expect(resourceSlot.getByTestId('farming-browser-section')).toBeVisible()
  await expect(resourceSlot.getByTestId('farming-computer-section')).toHaveCount(0)
})
