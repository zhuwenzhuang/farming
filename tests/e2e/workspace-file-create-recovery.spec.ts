import fs from 'node:fs'
import path from 'node:path'
import {
  expect,
  openFarming,
  openNewAgentDialog,
  PLAYWRIGHT_WORKSPACE_ROOT,
  selectAgent,
  test,
} from './fixtures'

test('converges uncertain file and directory creation from an authoritative parent reread', async ({ page }) => {
  const workspaceRoot = path.join(PLAYWRIGHT_WORKSPACE_ROOT, 'workspace-create-recovery')
  const parentPath = path.join(workspaceRoot, 'existing')
  fs.rmSync(workspaceRoot, { recursive: true, force: true })
  fs.mkdirSync(parentPath, { recursive: true })

  await openFarming(page)
  await openNewAgentDialog(page)
  await selectAgent(page, 'bash')
  await page.getByTestId('workspace-input').fill(workspaceRoot)
  await page.getByTestId('workspace-start').click()
  await expect(page.getByTestId('input-dialog')).toBeHidden({ timeout: 30_000 })

  const project = page.getByTestId('code-project-group').filter({ hasText: path.basename(workspaceRoot) })
  await expect(project).toHaveCount(1, { timeout: 30_000 })
  const files = project.getByTestId('code-files-section')
  const filesTitle = files.locator('.code-files-title').first()
  if (await filesTitle.getAttribute('aria-expanded') !== 'true') await filesTitle.click()
  await expect(filesTitle).toHaveAttribute('aria-expanded', 'true')

  const parentRow = files.locator('[data-testid="code-file-row"][data-file-path="existing"]')
  await expect(parentRow).toBeVisible()

  const uncertainNames = new Set(['recovered.txt', 'recovered-directory'])
  await page.route('**/farming/api/files/entry', async route => {
    const request = route.request()
    const body = request.method() === 'POST'
      ? request.postDataJSON() as { name?: string }
      : null
    if (!body?.name || !uncertainNames.has(body.name)) {
      await route.continue()
      return
    }
    const response = await route.fetch()
    expect(response.status()).toBe(201)
    uncertainNames.delete(body.name)
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'simulated response loss after create commit' }),
    })
  })

  await parentRow.click({ button: 'right' })
  await page.getByTestId('code-file-context-menu').getByRole('menuitem', { name: 'New File' }).click()
  const newFileInput = page.getByTestId('code-file-operation-input')
  await newFileInput.fill('recovered.txt')
  await newFileInput.press('Enter')

  await expect(page.getByTestId('code-file-operation-input')).toHaveCount(0)
  await expect(files.locator('[data-testid="code-file-row"][data-file-path="existing/recovered.txt"]')).toBeVisible()
  await expect(page.getByTestId('code-file-editor').getByRole('tab').filter({ hasText: 'recovered.txt' })).toHaveCount(1)
  expect(fs.statSync(path.join(parentPath, 'recovered.txt')).isFile()).toBe(true)

  await parentRow.click({ button: 'right' })
  await page.getByTestId('code-file-context-menu').getByRole('menuitem', { name: 'New Folder' }).click()
  const newFolderInput = page.getByTestId('code-file-operation-input')
  await newFolderInput.fill('recovered-directory')
  await newFolderInput.press('Enter')

  await expect(page.getByTestId('code-file-operation-input')).toHaveCount(0)
  await expect(files.locator('[data-testid="code-file-row"][data-file-path="existing/recovered-directory"]')).toBeVisible()
  expect(fs.statSync(path.join(parentPath, 'recovered-directory')).isDirectory()).toBe(true)
  expect(uncertainNames.size).toBe(0)
})
