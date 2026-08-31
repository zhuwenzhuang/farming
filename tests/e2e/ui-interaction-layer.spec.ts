import fs from 'node:fs'
import path from 'node:path'
import { expect, openFarming, test } from './fixtures'

for (const appearance of ['light', 'dark', 'paper'] as const) {
  test(`nested menu consumes Escape without closing its dialog in ${appearance}`, async ({ page }) => {
    await page.goto('/farming/review?fixture=1')
    const preferences = page.getByRole('button', { name: 'Diff preferences' })
    await preferences.click()
    const dialog = page.getByRole('dialog', { name: 'Diff Preferences' })
    await expect(dialog).toBeVisible()
    await page.evaluate(value => {
      document.documentElement.dataset.appearance = value
      document.body.dataset.appearance = value
    }, appearance)
    const context = dialog.getByRole('combobox', { name: 'Context', exact: true })
    await context.click()
    await expect(context).toHaveAttribute('aria-expanded', 'true')
    await expect(dialog.getByRole('option', { selected: true })).toBeFocused()
    await expect(dialog).toHaveScreenshot(`nested-interaction-${appearance}.png`)

    // One physical Escape closes the menu; holding it must not close parents.
    await page.keyboard.down('Escape')
    await expect(dialog).toBeVisible()
    await expect(context).toHaveAttribute('aria-expanded', 'false')
    await expect(context).toBeFocused()
    await page.keyboard.down('Escape')
    await expect(dialog).toBeVisible()
    await page.keyboard.up('Escape')

    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await expect(preferences).toBeFocused()
    await expect(page.locator('#root')).not.toHaveAttribute('inert', '')

    // Reopening after unmount must register one fresh owner, not a stale one.
    await preferences.click()
    await context.click()
    await page.keyboard.press('Escape')
    await expect(dialog).toBeVisible()
    await context.click()
    await context.click()
    await expect(context).toHaveAttribute('aria-expanded', 'false')
    await expect(dialog).toBeVisible()
  })
}

test('outside pointer transfers focus and dismisses only the top layer', async ({ page }) => {
  await page.goto('/farming/review?fixture=1')
  await page.getByRole('button', { name: 'Diff preferences' }).click()
  const dialog = page.getByRole('dialog', { name: 'Diff Preferences' })
  const whitespace = dialog.getByRole('combobox', { name: 'Ignore Whitespace' })
  await whitespace.click()
  const fontSize = dialog.getByRole('spinbutton', { name: 'Font size' })
  await fontSize.click()
  await expect(whitespace).toHaveAttribute('aria-expanded', 'false')
  await expect(fontSize).toBeFocused()
  await fontSize.fill('16')
  await expect(fontSize).toHaveValue('16')
  await expect(fontSize).toBeFocused()

  await whitespace.click()
  // The first backdrop press belongs to the menu, the next to the dialog.
  await page.locator('.review-preferences-backdrop').click({ position: { x: 4, y: 4 } })
  await expect(whitespace).toHaveAttribute('aria-expanded', 'false')
  await expect(dialog).toBeVisible()
  await page.locator('.review-preferences-backdrop').click({ position: { x: 4, y: 4 } })
  await expect(dialog).toBeHidden()
})

test('IME cancellation does not dismiss a menu or its parent dialog', async ({ page }) => {
  await page.goto('/farming/review?fixture=1')
  await page.getByRole('button', { name: 'Diff preferences' }).click()
  const dialog = page.getByRole('dialog', { name: 'Diff Preferences' })
  const context = dialog.getByRole('combobox', { name: 'Context', exact: true })
  await context.click()
  await dialog.getByRole('option', { selected: true }).dispatchEvent('keydown', {
    key: 'Escape', isComposing: true, bubbles: true, cancelable: true,
  })
  await expect(context).toHaveAttribute('aria-expanded', 'true')
  await expect(dialog).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(context).toHaveAttribute('aria-expanded', 'false')
  await expect(dialog).toBeVisible()
})

test('wizard and portal dialogs own Escape above the background search', async ({ page, workspaceRoot }) => {
  const settings = await page.request.post('/farming/api/settings', {
    data: { agentHomes: { codex: [
      { id: 'default', path: path.join(workspaceRoot, 'default-home') },
      { id: 'work', path: path.join(workspaceRoot, 'work-home') },
    ] } },
  })
  expect(settings.ok()).toBeTruthy()
  const response = await page.request.post('/farming/api/control/agents', {
    data: { command: 'bash', workspace: workspaceRoot },
  })
  expect(response.ok()).toBeTruthy()
  await page.route('**/api/agent-sessions/search?**', route => route.fulfill({ json: { sessions: [] } }))
  await openFarming(page)
  await page.getByTestId('code-nav-search').click()
  const search = page.getByTestId('code-search-box').locator('input')
  await search.fill('sql-insight')

  // New Agent intentionally navigates to Projects; Escape still advances only
  // one wizard layer at a time, including the nested Home menu.
  const newAgent = page.getByTestId('code-new-agent')
  await newAgent.focus()
  await newAgent.press('Enter')
  const wizard = page.getByTestId('input-dialog')
  await expect(wizard).toBeVisible()
  await expect(search).toBeHidden()
  await page.getByTestId('agent-option-codex').click()
  const workspace = page.getByTestId('workspace-step')
  await expect(workspace).toBeVisible()
  const home = page.getByTestId('agent-home-select')
  await home.click()
  await expect(page.getByTestId('agent-home-menu')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('agent-home-menu')).toBeHidden()
  await expect(home).toBeFocused()
  await expect(workspace).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(workspace).toBeHidden()
  await expect(wizard).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(wizard).toBeHidden()

  await page.getByTestId('code-nav-search').click()
  await search.fill('sql-insight')

  // These portal dialogs leave the underlying view open, including when their
  // triggers are activated by keyboard without an outside pointer event.
  for (const [triggerId, dialogId] of [
    ['code-sidebar-focus-toggle', 'code-app-mode-dialog'],
    ['code-product-mark', 'code-brand-dialog'],
    ['code-instance-name-edit', 'code-instance-name-dialog'],
  ]) {
    const trigger = page.getByTestId(triggerId)
    await trigger.focus()
    await trigger.press('Enter')
    const dialog = page.getByTestId(dialogId)
    await expect(dialog).toBeVisible()
    await expect(page.locator('#root')).toHaveAttribute('inert', '')
    await page.keyboard.press('Tab')
    expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true)
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await expect(trigger).toBeFocused()
    await expect(page.locator('#root')).not.toHaveAttribute('inert', '')
    await expect(search).toHaveValue('sql-insight')
  }
  await page.keyboard.press('Escape')
  await expect(search).toBeHidden()
})

test('editor tab menu closes on outside pointer and restores its tab on Escape', async ({ page, workspaceRoot }) => {
  fs.writeFileSync(path.join(workspaceRoot, 'notes.txt'), 'Interaction fixture\n')
  const response = await page.request.post('/farming/api/control/agents', {
    data: { command: 'bash', workspace: workspaceRoot },
  })
  expect(response.ok()).toBeTruthy()
  await openFarming(page)
  const project = page.getByTestId('code-project-group').filter({ hasText: path.basename(workspaceRoot) })
  const filesTitle = project.locator('.code-files-title').first()
  if (await filesTitle.getAttribute('aria-expanded') !== 'true') await filesTitle.click()
  await project.locator('[data-testid="code-file-row"][data-file-path="notes.txt"]').click()
  const tab = page.getByTestId('code-file-editor').getByRole('tab', { selected: true })
  await expect(tab).toContainText('notes.txt')
  const menu = page.getByTestId('code-file-tab-context-menu')
  await tab.click({ button: 'right' })
  await expect(menu).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(menu).toBeHidden()
  await expect(tab).toBeFocused()
  await tab.click({ button: 'right' })
  await expect(menu).toBeVisible()
  await page.getByTestId('code-nav-search').click()
  await expect(menu).toBeHidden()
  const search = page.getByTestId('code-search-box').locator('input')
  await expect(search).toBeFocused()
  await search.fill('sql-insight')
  await expect(search).toHaveValue('sql-insight')
  await expect(search).toBeFocused()
})
