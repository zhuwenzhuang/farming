import fs from 'node:fs'
import path from 'node:path'
import { expect, openFarming, openNewAgentDialog, startAgentFromOpenDialog, test } from './fixtures'

type MockComputer = {
  id: string
  ownerAgentId: string
  projectRootId: string
  workspace: string
  name: string
  status: 'running'
  generation: number
  revision: number
  collectionRevision: number
  controlOwner: 'agent' | 'human'
  controlEpoch: number
  needsObserve: boolean
  containerId: string
  containerName: string
  viewerPort: number
  sessionId: string
  error: string
  createdAt: number
  updatedAt: number
}

test('shows an Agent-owned Computer only when present and switches Viewer control epochs', async ({
  page,
  workspaceRoot,
}) => {
  const workspace = path.join(workspaceRoot, 'agent-owned-computer-project')
  fs.mkdirSync(workspace, { recursive: true })
  let resource: MockComputer | null = null

  await page.route('**/api/computers/capability', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      available: true,
      enabled: false,
      dockerAvailable: true,
      imageReady: true,
      image: 'trycua/xfce-cua@sha256:test',
      imageDigest: 'sha256:test',
      driverVersion: '0.12.4',
      compatibilityMode: false,
      error: '',
    }),
  }))
  await page.route('**/api/computers', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      collectionRevision: resource?.collectionRevision ?? 1,
      resources: resource ? [resource] : [],
    }),
  }))
  await page.route('**/api/computers/*/viewer-config', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      password: 'viewer-test-password',
      viewOnly: resource?.controlOwner !== 'human',
      generation: resource?.generation ?? 1,
      controlEpoch: resource?.controlEpoch ?? 1,
    }),
  }))
  await page.route('**/api/computers/*/control', async route => {
    if (!resource) throw new Error('Control route requires the mock Computer')
    const body = route.request().postDataJSON() as { owner?: 'agent' | 'human' }
    resource = {
      ...resource,
      controlOwner: body.owner === 'human' ? 'human' : 'agent',
      controlEpoch: resource.controlEpoch + 1,
      revision: resource.revision + 1,
      collectionRevision: resource.collectionRevision + 1,
    }
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(resource),
    })
  })
  await page.route('**/api/computers/*/viewer/vnc.html*', route => route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><title>Mock Computer desktop</title><main>Mock Computer desktop</main>',
  }))

  await openFarming(page)
  await openNewAgentDialog(page)
  const agentId = await startAgentFromOpenDialog(page, 'bash', workspace)
  const agentRow = page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
  await expect(agentRow.getByTestId('code-agent-resources-toggle')).toHaveCount(0)
  await expect(agentRow).not.toContainText('0')

  await page.getByTestId('code-nav-plugins').click()
  const computerPlugin = page.getByTestId('code-plugin-computer')
  await expect(computerPlugin.getByRole('heading', { name: 'Computer', exact: true })).toBeVisible()
  await expect(computerPlugin.getByText('Disabled', { exact: true })).toBeVisible()
  await expect(computerPlugin.getByRole('button', { name: 'Enable' })).toBeEnabled()

  const now = Date.now()
  resource = {
    id: 'computer_frontend_test',
    ownerAgentId: agentId,
    projectRootId: 'root_frontend_test',
    workspace,
    name: 'Agent Computer',
    status: 'running',
    generation: 1,
    revision: 1,
    collectionRevision: 2,
    controlOwner: 'agent',
    controlEpoch: 1,
    needsObserve: false,
    containerId: 'container_frontend_test',
    containerName: 'farming-computer-frontend-test',
    viewerPort: 6901,
    sessionId: 'computer_frontend_test-g1',
    error: '',
    createdAt: now,
    updatedAt: now,
  }
  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(page.getByTestId('app-shell')).toBeVisible()

  const refreshedAgentRow = page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
  const resourcesToggle = refreshedAgentRow.getByTestId('code-agent-resources-toggle')
  await refreshedAgentRow.hover()
  await expect(resourcesToggle).toBeVisible()
  await resourcesToggle.click()
  const resourceSlot = page.locator(
    `[data-testid="code-agent-resource-slot"][data-agent-id="${agentId}"]`,
  )
  const computerSection = resourceSlot.getByTestId('farming-computer-section')
  await expect(computerSection).toBeVisible()
  const computerRow = computerSection.getByTestId('farming-computer-row')
  const computerActions = computerRow.locator('.farming-computer-actions')
  const computerCopy = computerRow.locator('.farming-computer-copy')
  await expect(computerRow).toContainText('Agent Computer')
  await expect(computerActions).toHaveCSS('opacity', '0')
  const computerCopyBoxBeforeHover = await computerCopy.boundingBox()
  await computerRow.hover()
  await expect(computerActions).toHaveCSS('opacity', '1')
  const computerCopyBoxAfterHover = await computerCopy.boundingBox()
  if (!computerCopyBoxBeforeHover || !computerCopyBoxAfterHover) {
    throw new Error('Computer row copy must have measurable bounds')
  }
  expect(Math.abs(computerCopyBoxAfterHover.width - computerCopyBoxBeforeHover.width)).toBeLessThan(1)

  await computerRow.click()
  const viewer = page.getByTestId('farming-computer-viewer')
  await expect(viewer).toBeVisible()
  const frame = viewer.locator('iframe')
  await expect(frame).toHaveAttribute('src', /view_only=1/)
  await viewer.getByRole('button', { name: 'Take control' }).click()
  await expect(viewer.getByRole('button', { name: 'Return to Agent' })).toBeVisible()
  await expect(frame).toHaveAttribute('src', /view_only=0/)
  await viewer.getByRole('button', { name: 'Return to Agent' }).click()
  await expect(viewer.getByRole('button', { name: 'Take control' })).toBeVisible()
  await expect(frame).toHaveAttribute('src', /view_only=1/)
})
