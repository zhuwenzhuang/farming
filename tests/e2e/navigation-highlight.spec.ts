import fs from 'node:fs'
import path from 'node:path'
import type { Locator } from '@playwright/test'
import { projectFilesWorkspaceId } from '../../src/lib/project-workspaces'
import type { BrowserResource } from '../../extensions/browser/frontend/types'
import type { ComputerResource } from '../../extensions/computer/frontend/types'
import { expect, openFarming, test } from './fixtures'

for (const appearance of ['light', 'dark', 'paper'] as const) {
  test(`navigation highlight ownership and menu return in ${appearance}`, async ({ page, workspaceRoot, isMobile }, testInfo) => {
    page.setDefaultTimeout(10_000)
    const activate = async (target: Locator) => {
      if (isMobile) await target.tap()
      else await target.click()
    }
    const workspace = path.join(workspaceRoot, 'sample-highlight-project')
    fs.mkdirSync(workspace, { recursive: true })
    fs.writeFileSync(path.join(workspace, 'sample.txt'), 'Sample file\n')
    for (const name of ['Sample Alpha', 'Sample Beta']) {
      const response = await page.request.post('/farming/api/control/agents', { data: { command: name.endsWith('Alpha') ? 'codex' : 'bash', workspace } })
      expect(response.ok(), await response.text()).toBeTruthy()
      const { agentId } = await response.json() as { agentId: string }
      for (const data of [{ customTitle: name }, { pinned: true }]) {
        const update = await page.request.patch(`/farming/api/agents/${agentId}`, { data })
        expect(update.ok(), await update.text()).toBeTruthy()
      }
    }
    await openFarming(page)
    await page.evaluate(value => {
      document.documentElement.dataset.appearance = value
      document.body.dataset.appearance = value
    }, appearance)
    const sidebar = page.getByTestId('code-sidebar')
    const drawer = async () => {
      if (await sidebar.evaluate(el => el.classList.contains('collapsed'))) {
        await activate(page.getByTestId('code-mobile-menu'))
      }
    }
    const rows = page.getByTestId('code-agent-row')
    const alpha = rows.filter({ hasText: 'Sample Alpha' })
    const beta = rows.filter({ hasText: 'Sample Beta' })
    await drawer()
    await activate(alpha)
    await drawer()
    await expect(alpha).toHaveAttribute('aria-current', 'page')
    await expect(sidebar.locator('.code-agent-row.active')).toHaveCount(1)
    await activate(page.getByTestId('code-nav-search'))
    await page.getByTestId('code-search-box').locator('input').fill('Sample')
    const results = page.getByTestId('code-search-result')
    await expect(results).toHaveCount(2)
    await expect(page.locator('[data-testid="code-search-result"].active')).toHaveCount(1)
    // Activate the non-candidate using the pointer, not the Search cursor.
    const current = await results.evaluateAll(elements => elements.find(el => el.classList.contains('active'))?.textContent || '')
    const targetName = current.includes('Alpha') ? 'Sample Beta' : 'Sample Alpha'
    const target = targetName.includes('Beta') ? beta : alpha
    await activate(results.filter({ hasText: targetName }))
    await drawer()
    await expect(target).toHaveAttribute('aria-current', 'page')
    await expect(sidebar.locator('.code-agent-row.active')).toHaveCount(1)
    await expect(sidebar.locator('.search-selected')).toHaveCount(0)
    // The primary row and its trailing menu do not share transient state.
    const project = page.getByTestId('code-project-group').filter({ hasText: 'sample-highlight-project' })
    const title = project.getByTestId('code-project-title')
    if (!isMobile) await title.hover()
    const more = project.getByTestId('code-project-actions')
    await activate(more)
    await expect(more).toHaveAttribute('aria-expanded', 'true')
    await expect(page.getByTestId('code-project-context-menu')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(more).toHaveAttribute('aria-expanded', 'false')
    await expect(more).toBeFocused()
    await expect(sidebar.locator('.code-agent-row.active')).toHaveCount(1)
    const files = project.getByTestId('code-files-section')
    const filesTitle = files.locator('.code-files-title')
    if (await filesTitle.getAttribute('aria-expanded') !== 'true') await activate(filesTitle)
    await activate(files.locator('[data-testid="code-file-row"][data-file-path="sample.txt"]'))
    await expect(page.getByTestId('code-file-editor')).toBeVisible()
    if (!isMobile) await drawer()
    await expect(sidebar.locator('.code-agent-row.active')).toHaveCount(0)
    await expect(project.locator('.code-file-row.active')).toHaveCount(1)
    if (isMobile) {
      await page.getByTestId('code-mobile-back').tap()
      await drawer()
    }
    await activate(beta)
    await drawer()
    await expect(beta).toHaveAttribute('aria-current', 'page')
    await expect(project.locator('.code-file-row.active')).toHaveCount(0)
    // Pinned row surfaces must remain entirely inside the scroll viewport,
    // including provider icons and both leading corners.
    await activate(alpha)
    await drawer()
    await expect(alpha).toHaveAttribute('aria-current', 'page')
    if (isMobile) await expect.poll(() => sidebar.evaluate(el => Math.round(el.getBoundingClientRect().x))).toBe(0)
    const listBox = await page.getByTestId('code-project-list').boundingBox()
    const rowBox = await alpha.boundingBox()
    expect(rowBox!.x).toBeGreaterThanOrEqual(listBox!.x)
    expect(rowBox!.x + rowBox!.width).toBeLessThanOrEqual(listBox!.x + listBox!.width)
    if (!isMobile) await page.mouse.move(1000, 100)
    await sidebar.screenshot({ path: testInfo.outputPath(`highlight-${appearance}-${isMobile ? 'touch' : 'mouse'}.png`), animations: 'disabled' })
    await activate(page.getByTestId('code-nav-history'))
    await drawer()
    await expect(sidebar.locator('.code-agent-row.active')).toHaveCount(0)
  })
}

for (const appearance of ['light', 'dark', 'paper'] as const) {
  test(`resource highlight belongs to the visible Viewer in ${appearance}`, async ({ page, workspaceRoot, isMobile }, testInfo) => {
    page.setDefaultTimeout(10_000)
    const activate = async (target: Locator) => {
      if (isMobile) await target.tap()
      else await target.click()
    }
    const created = await page.request.post('/farming/api/control/agents', { data: { command: 'bash', workspace: workspaceRoot } })
    expect(created.ok()).toBeTruthy()
    const { agentId } = await created.json() as { agentId: string }
    const common = { ownerAgentId: agentId, projectRootId: projectFilesWorkspaceId(workspaceRoot), workspace: workspaceRoot, status: 'stopped' as const, generation: 0, revision: 1, collectionRevision: 1, error: '', createdAt: 1, updatedAt: 1 }
    const browser: BrowserResource = { ...common, id: 'highlight-browser', name: 'Sample Browser', url: 'about:blank', title: '', browserKind: 'chrome' }
    const computer: ComputerResource = { ...common, id: 'highlight-computer', name: 'Sample Desktop', controlOwner: 'agent', controlEpoch: 0, needsObserve: false, containerId: '', containerName: '', viewerPort: 0, sessionId: '' }
    // Real navigation/components; deterministic inventory, no external runtime.
    await page.routeWebSocket(/\/farming\/ws(?:\?|$)/, socket => {
      const server = socket.connectToServer()
      server.onMessage(payload => {
        const message = JSON.parse(String(payload)) as { type?: string }
        const resource = message.type === 'browser-resource-snapshot' ? browser : message.type === 'computer-resource-snapshot' ? computer : null
        socket.send(resource ? JSON.stringify({ type: message.type, snapshot: { collectionRevision: 1, resources: [resource] } }) : payload)
      })
    })
    for (const [kind, resource] of [['browsers', browser], ['computers', computer]] as const) {
      await page.route(`**/api/${kind}`, route => route.fulfill({ json: { collectionRevision: 1, resources: [resource] } }))
      await page.route(`**/api/${kind}/${resource.id}`, route => route.fulfill({ json: resource }))
      await page.route(`**/api/${kind}/capability`, route => route.fulfill({ json: { available: true, enabled: true, browser: { kind: 'chrome', path: '/mock/chrome' }, dockerAvailable: true, imageReady: true } }))
    }
    await page.addInitScript(id => localStorage.setItem('farming.code.agentResourcesExpanded.v1', JSON.stringify([id])), agentId)
    await openFarming(page)
    await page.evaluate(theme => { document.body.dataset.appearance = theme; document.documentElement.dataset.appearance = theme }, appearance)
    const sidebar = page.getByTestId('code-sidebar')
    const drawer = async () => {
      if (await sidebar.evaluate(el => el.classList.contains('collapsed'))) await activate(page.getByTestId('code-mobile-menu'))
    }
    await drawer()
    const agent = sidebar.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
    await activate(agent)
    await drawer()
    const browserRow = page.getByTestId('farming-browser-row')
    const computerRow = page.getByTestId('farming-computer-row')
    await expect(browserRow).toBeVisible()
    await expect(computerRow).toBeVisible()
    // Wait for the selected Terminal to finish mounting, then enter real
    // keyboard modality before focusing an independent Resource action.
    await expect.poll(() => page.evaluate(id => window.__farmingTerminalTest?.isReady(id), agentId)).toBe(true)
    await page.keyboard.press('Tab')
    // Keyboard operation of a trailing action must not activate its parent row.
    await browserRow.getByRole('button', { name: 'Rename Tab', exact: true }).press('Enter')
    await expect(browserRow.getByRole('textbox')).toBeVisible()
    await expect(agent).toHaveAttribute('aria-current', 'page')
    await browserRow.getByRole('textbox').press('Escape')
    await drawer()
    await computerRow.getByRole('button', { name: 'More', exact: true }).press('Enter')
    await expect(page.locator('.farming-computer-more-menu')).toBeVisible()
    await expect(agent).toHaveAttribute('aria-current', 'page')
    await page.keyboard.press('Escape')
    for (const row of [browserRow, computerRow]) {
      await activate(row.locator('.code-sidebar-resource-name'))
      await drawer()
      await expect(row).toHaveAttribute('aria-current', 'page')
      await expect(sidebar.locator('.code-agent-row.active')).toHaveCount(0)
      await expect(sidebar.locator('.code-sidebar-resource-row.active')).toHaveCount(1)
    }
    await sidebar.screenshot({ path: testInfo.outputPath(`resources-${appearance}-${isMobile ? 'touch' : 'mouse'}.png`), animations: 'disabled' })
    await activate(agent)
    await drawer()
    await expect(agent).toHaveAttribute('aria-current', 'page')
    await expect(sidebar.locator('.code-sidebar-resource-row.active')).toHaveCount(0)
  })
}
