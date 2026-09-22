import fs from 'node:fs'
import path from 'node:path'
import { expect, openFarming, test } from './fixtures'

for (const appearance of ['light', 'dark', 'paper']) {
  test(`Archive keeps selection and focus inside its Project (${appearance})`, async ({ page, workspaceRoot }, testInfo) => {
    await page.request.post('/farming/api/settings', { data: { appearance } })
    const workspace = path.join(workspaceRoot, 'selection-project')
    const otherWorkspace = path.join(workspaceRoot, 'other-project')
    const create = async (cwd: string) => {
      fs.mkdirSync(cwd, { recursive: true })
      const response = await page.request.post('/farming/api/control/agents', {
        data: { command: 'codex', workspace: cwd, agentRuntimeMode: 'chat' },
      })
      expect(response.ok()).toBeTruthy()
      return (await response.json() as { agentId: string }).agentId
    }
    const ids = [await create(workspace), await create(workspace), await create(workspace)]
    expect((await page.request.post('/farming/api/projects/mount', { data: { workspace } })).ok()).toBeTruthy()
    const other = await create(otherWorkspace)
    const background = await create(otherWorkspace)
    await page.addInitScript(() => {
      if (localStorage.getItem('farming.code.workspaceViewState.v1')) return
      localStorage.setItem('farming.code.workspaceViewState.v1', JSON.stringify({
        dynamicPinningEnabled: false, updatedAt: Date.now(),
      }))
    })
    await openFarming(page)
    const row = (id: string) => page.locator(`[data-testid="code-agent-row"][data-agent-id="${id}"]`)
    for (const id of [...ids, other, background]) await expect(row(id)).toBeVisible()
    const ordered = await page.getByTestId('code-agent-row').evaluateAll((rows, projectIds) => rows
      .map(element => (element as HTMLElement).dataset.agentId!)
      .filter(id => projectIds.includes(id)), ids)
    expect(ordered).toHaveLength(3)
    const pane = page.locator('[data-testid="code-agent-work-pane"]:visible')
    const open = async (id: string) => {
      await row(id).click()
      await expect(pane).toHaveAttribute('data-agent-id', id)
    }
    const archive = async (id: string) => {
      await row(id).hover()
      await row(id).getByTestId('code-agent-row-archive').click()
      await expect(row(id)).toHaveCount(0)
    }
    // Opening history deliberately differs from the sidebar's stable order.
    await open(ordered[2])
    await open(other)
    await open(ordered[0])
    await open(ordered[1])
    await archive(background)
    await expect(pane).toHaveAttribute('data-agent-id', ordered[1])
    if (appearance === 'light') {
      let rejectArchive: (() => void) | undefined
      const delayed = new Promise<void>(resolve => { rejectArchive = resolve })
      const routePath = `**/api/agents/${ordered[1]}`
      await page.route(routePath, async route => {
        if (route.request().method() !== 'PATCH' || route.request().postDataJSON()?.archived !== true) {
          await route.continue()
          return
        }
        await delayed
        await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'Archive rejected' }) })
      })
      try {
        await archive(ordered[1])
        await open(other)
      } finally {
        rejectArchive?.()
      }
      await expect(row(ordered[1])).toBeVisible()
      await expect(pane).toHaveAttribute('data-agent-id', other)
      await page.unroute(routePath)
      await open(ordered[1])
    }
    await archive(ordered[1])
    await expect(pane).toHaveAttribute('data-agent-id', ordered[2])
    await expect(row(ordered[2])).toBeFocused()
    await archive(ordered[2])
    await expect(pane).toHaveAttribute('data-agent-id', ordered[0])
    await expect(row(ordered[0])).toBeFocused()
    await archive(ordered[0])
    await expect(pane).toHaveCount(0)
    await expect(row(other)).toBeVisible()
    const projectTitle = page.getByTestId('code-project-title').filter({ hasText: 'selection-project' })
    await expect(projectTitle).toBeFocused()
    await expect(page.getByTestId('code-empty-home-new-agent')).toBeVisible()
    await testInfo.attach(`empty-project-${appearance}`, { body: await page.screenshot({ path: testInfo.outputPath(`empty-project-${appearance}.png`) }), contentType: 'image/png' })
    // A later authoritative update must not turn the intentional empty selection into global MRU.
    await page.request.patch(`/farming/api/agents/${other}`, { data: { customTitle: 'Other Project updated' } })
    await expect(row(other)).toContainText('Other Project updated')
    await expect(pane).toHaveCount(0)
    await page.reload()
    await expect(row(other)).toBeVisible()
    await expect(pane).toHaveCount(0)
    await page.getByTestId('code-empty-home-new-agent').click()
    await page.getByTestId('agent-option-codex').click()
    await expect(page.getByTestId('workspace-input')).toHaveValue(workspace)
    await page.getByTestId('input-dialog-close').click()
    await expect(page.getByTestId('input-dialog')).toBeHidden()
    const batch = [await create(workspace), await create(workspace)]
    await open(batch[0])
    await projectTitle.click({ button: 'right' })
    await page.getByTestId('code-project-context-menu').getByRole('menuitem', { name: 'Archive all chats', exact: true }).click()
    for (const id of batch) await expect(row(id)).toHaveCount(0)
    await expect(pane).toHaveCount(0)
    await expect(projectTitle).toBeFocused()
    await expect(row(other)).toBeVisible()
  })
}
