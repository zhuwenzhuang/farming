import fs from 'node:fs'
import path from 'node:path'
import { expect, openFarming, openNewAgentDialog, startAgentFromOpenDialog, test } from './fixtures'

type MockComputer = {
  id: string
  ownerAgentId: string
  projectRootId: string
  workspace: string
  name: string
  status: 'running' | 'stopped'
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

test('shows an Agent-owned Desktop only when present and switches Viewer control epochs', async ({
  page,
  workspaceRoot,
}, testInfo) => {
  const workspace = path.join(workspaceRoot, 'agent-owned-computer-project')
  fs.mkdirSync(workspace, { recursive: true })
  let resource: MockComputer | null = null
  let deleteShouldFail = true
  let deleteRequests = 0
  let browserCapabilityRequests = 0
  let computerCapabilityRequests = 0

  await page.route('**/api/browsers/capability', async route => {
    browserCapabilityRequests += 1
    await route.continue()
  })

  await page.route('**/api/computers/capability', async route => {
    computerCapabilityRequests += 1
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        available: true,
        enabled: true,
        dockerAvailable: true,
        imageReady: true,
        image: 'trycua/xfce-cua@sha256:test',
        imageDigest: 'sha256:test',
        driverVersion: '0.12.4',
        compatibilityMode: false,
        error: '',
      }),
    })
  })
  await page.route('**/api/computers', async route => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON() as { agentId?: string }
      const now = Date.now()
      resource = {
        id: 'computer_frontend_test',
        ownerAgentId: body.agentId || '',
        projectRootId: 'root_frontend_test',
        workspace,
        name: 'Agent Computer',
        status: 'stopped',
        generation: 0,
        revision: 1,
        collectionRevision: 2,
        controlOwner: 'agent',
        controlEpoch: 0,
        needsObserve: false,
        containerId: '',
        containerName: 'farming-computer-frontend-test',
        viewerPort: 0,
        sessionId: '',
        error: '',
        createdAt: now,
        updatedAt: now,
      }
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(resource) })
      return
    }
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        collectionRevision: resource?.collectionRevision ?? 1,
        resources: resource ? [resource] : [],
      }),
    })
  })
  await page.route('**/api/computers/*/start', async route => {
    if (!resource) throw new Error('Start route requires the mock Computer')
    resource = {
      ...resource,
      status: 'running',
      generation: resource.generation + 1,
      revision: resource.revision + 1,
      collectionRevision: resource.collectionRevision + 1,
      controlEpoch: 1,
      viewerPort: 6901,
      sessionId: 'computer_frontend_test-g1',
      updatedAt: Date.now(),
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(resource) })
  })
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
  await page.route('**/api/computers/computer_frontend_test', async route => {
    if (route.request().method() !== 'DELETE') {
      await route.continue()
      return
    }
    deleteRequests += 1
    if (deleteShouldFail) {
      await route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Stop the Browsers using this Desktop first' }),
      })
      return
    }
    const collectionRevision = (resource?.collectionRevision ?? 2) + 1
    resource = null
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ id: 'computer_frontend_test', collectionRevision }),
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
  await expect(page.locator(`[data-testid="code-agent-resource-slot"][data-agent-id="${agentId}"]`).getByTestId('farming-computer-section')).toHaveCount(0)
  await agentRow.click({ button: 'right' })
  const createDesktopMenuItem = page.getByRole('menuitem', { name: 'Create Isolated Desktop' })
  await expect(createDesktopMenuItem).toBeVisible()
  await expect(createDesktopMenuItem.locator('.code-context-menu-icon.trailing')).toHaveCount(1)
  const desktopMenuScreenshot = testInfo.outputPath('agent-desktop-menu.png')
  await page.locator('.code-context-menu').screenshot({ path: desktopMenuScreenshot })
  await testInfo.attach('agent-desktop-menu', {
    path: desktopMenuScreenshot,
    contentType: 'image/png',
  })
  await page.keyboard.press('Escape')

  await expect.poll(() => browserCapabilityRequests).toBeGreaterThan(0)
  await expect.poll(() => computerCapabilityRequests).toBeGreaterThan(0)
  const browserRequestsBeforePlugins = browserCapabilityRequests
  const computerRequestsBeforePlugins = computerCapabilityRequests

  await page.getByTestId('code-nav-plugins').click()
  await expect.poll(() => browserCapabilityRequests).toBeGreaterThan(browserRequestsBeforePlugins)
  await expect.poll(() => computerCapabilityRequests).toBeGreaterThan(computerRequestsBeforePlugins)
  const computerPlugin = page.getByTestId('code-plugin-computer')
  await expect(computerPlugin.getByRole('heading', { name: 'Computer Use', exact: true })).toBeVisible()
  await expect(computerPlugin.locator('.code-plugin-card-icon svg')).toHaveCount(1)
  const computerPluginScreenshot = testInfo.outputPath('computer-use-plugin.png')
  await computerPlugin.screenshot({ path: computerPluginScreenshot })
  await testInfo.attach('computer-use-plugin', {
    path: computerPluginScreenshot,
    contentType: 'image/png',
  })
  await expect(computerPlugin.getByText('Desktops', { exact: true })).toBeVisible()
  await expect(computerPlugin.getByText('Isolated Desktop', { exact: true })).toBeVisible()
  await expect(computerPlugin.getByText('Enabled', { exact: true })).toBeVisible()
  await expect(computerPlugin.getByRole('button', { name: 'Disable' })).toBeEnabled()

  await page.getByRole('button', { name: 'Back to workspace' }).click()
  const refreshedAgentRow = page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
  await refreshedAgentRow.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Create Isolated Desktop' }).click()
  const resourcesToggle = refreshedAgentRow.getByTestId('code-agent-resources-toggle')
  await refreshedAgentRow.hover()
  const agentDetailResources = page.getByTestId('code-agent-hover-preview-resources')
  await expect(agentDetailResources).toBeVisible()
  await expect(agentDetailResources.getByTestId('code-agent-hover-preview-desktop-count')).toHaveText('1')
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
  await expect(computerRow).toHaveClass(/code-sidebar-resource-row/)
  await expect(computerRow).toHaveCSS('border-radius', '8px')
  await expect(computerRow).toHaveCSS('min-height', '32px')
  await expect(computerRow).toContainText('Agent Computer')
  const computerStatus = computerRow.locator('.farming-computer-resource-icon.running')
  await expect(computerStatus).toHaveCount(1)
  await expect(computerStatus).toHaveCSS('color', 'rgb(31, 157, 85)')
  await expect(computerRow.locator('.farming-computer-status')).toHaveCount(0)
  await expect(computerActions).toHaveCSS('opacity', '0')
  const computerCopyBoxBeforeHover = await computerCopy.boundingBox()
  await computerRow.hover()
  await expect(computerActions).toHaveCSS('opacity', '1')
  await expect(computerActions.getByRole('button')).toHaveCount(2)
  await expect(computerActions.getByRole('button').first()).toHaveCSS('width', '22px')
  await expect(computerActions.getByRole('button').first()).toHaveCSS('border-radius', '6px')
  await expect(computerActions.getByRole('button', { name: 'Stop Desktop' })).toBeVisible()
  const moreDesktopActions = computerActions.getByRole('button', { name: 'More' })
  await moreDesktopActions.click()
  const desktopMenu = computerRow.getByRole('menu')
  await expect(desktopMenu.getByRole('menuitem', { name: 'Rename Desktop' })).toBeVisible()
  const deleteDesktop = desktopMenu.getByRole('menuitem', { name: 'Delete Desktop' })
  page.once('dialog', dialog => dialog.accept())
  await deleteDesktop.click()
  await expect.poll(() => deleteRequests).toBe(1)
  await expect(computerRow).toContainText('Stop the Browsers using this Desktop first')
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
  await expect(frame).toHaveAttribute('src', /compression=0/)
  await viewer.getByRole('button', { name: 'Take control' }).click()
  await expect(viewer.getByRole('button', { name: 'Return to Agent' })).toBeVisible()
  await expect(frame).toHaveAttribute('src', /view_only=0/)
  await viewer.getByRole('button', { name: 'Return to Agent' }).click()
  await expect(viewer.getByRole('button', { name: 'Take control' })).toBeVisible()
  await expect(frame).toHaveAttribute('src', /view_only=1/)

  await viewer.getByRole('button', { name: 'Back to Agent' }).click()
  deleteShouldFail = false
  await computerRow.hover()
  await moreDesktopActions.click()
  page.once('dialog', dialog => dialog.accept())
  await computerRow.getByRole('menuitem', { name: 'Delete Desktop' }).click()
  await expect.poll(() => deleteRequests).toBe(2)
  await expect(computerSection.getByTestId('farming-computer-row')).toHaveCount(0)
})
