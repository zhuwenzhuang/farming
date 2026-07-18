import fs from 'node:fs'
import path from 'node:path'
import {
  expect,
  openFarming,
  openNewAgentDialog,
  selectAgent,
  test,
} from './fixtures'

test.describe('New Agent workspace directory creation', () => {
  test('asks before creating a missing workspace and starts there after confirmation', async ({ page, workspaceRoot }) => {
    const workspace = path.join(workspaceRoot, 'brand-new-project')
    await openFarming(page)
    await openNewAgentDialog(page)
    await selectAgent(page, 'bash')
    await page.getByTestId('workspace-input').fill(workspace)
    await page.getByTestId('workspace-start').click()

    const prompt = page.getByTestId('workspace-directory-prompt')
    await expect(prompt).toBeVisible()
    await expect(prompt).toContainText('Create this workspace?')
    await expect(prompt.locator('code')).toContainText(workspace)
    await expect(page.getByTestId('workspace-input')).toBeDisabled()
    await expect(page.getByTestId('workspace-directory-create')).toBeFocused()
    expect(fs.existsSync(workspace)).toBe(false)

    await page.getByTestId('workspace-directory-cancel').click()
    await expect(prompt).toBeHidden()
    await expect(page.getByTestId('workspace-input')).toBeEnabled()
    await expect(page.getByTestId('workspace-input')).toBeFocused()

    await page.getByTestId('workspace-start').click()
    await expect(prompt).toBeVisible()
    await page.getByTestId('workspace-directory-create').click()
    await expect(page.getByTestId('input-dialog')).toBeHidden({ timeout: 30_000 })
    expect(fs.statSync(workspace).isDirectory()).toBe(true)
    await expect(page.getByTestId('code-agent-row')).toHaveCount(1, { timeout: 30_000 })
  })

  test('shows a separate permission message and keeps the path recoverable', async ({ page, workspaceRoot }) => {
    const workspace = path.join(workspaceRoot, 'permission-denied-project')
    await page.route('**/farming/api/workspaces/prepare', async route => {
      const request = route.request().postDataJSON() as { create?: boolean }
      await route.fulfill({
        status: request.create ? 403 : 409,
        contentType: 'application/json',
        body: JSON.stringify(request.create ? {
          status: 'rejected',
          code: 'workspace-create-forbidden',
          workspace,
          message: 'permission denied',
        } : {
          status: 'missing',
          code: 'workspace-not-found',
          workspace,
          message: 'missing',
        }),
      })
    })

    await openFarming(page)
    await openNewAgentDialog(page)
    await selectAgent(page, 'bash')
    await page.getByTestId('workspace-input').fill(workspace)
    await page.getByTestId('workspace-start').click()
    await page.getByTestId('workspace-directory-create').click()

    const prompt = page.getByTestId('workspace-directory-prompt')
    await expect(prompt).toHaveClass(/error/)
    await expect(prompt).toContainText('Couldn’t create workspace')
    await expect(prompt).toContainText('does not have permission')
    await expect(prompt.locator('code')).toContainText(workspace)
    await page.getByTestId('workspace-directory-back').click()
    await expect(page.getByTestId('workspace-input')).toHaveValue(workspace)
    await expect(page.getByTestId('workspace-input')).toBeFocused()
  })

  test('keeps the confirmation readable in Code dark mode', async ({ page, workspaceRoot }) => {
    const workspace = path.join(workspaceRoot, 'dark-new-project')
    await page.request.post('/farming/api/settings', { data: { appearance: 'dark' } })
    await openFarming(page)
    await expect(page.locator('body')).toHaveAttribute('data-appearance', 'dark')
    await openNewAgentDialog(page)
    await selectAgent(page, 'bash')
    await page.getByTestId('workspace-input').fill(workspace)
    await page.getByTestId('workspace-start').click()

    const prompt = page.getByTestId('workspace-directory-prompt')
    await expect(prompt).toHaveCSS('background-color', 'rgb(22, 27, 34)')
    await expect(prompt).toHaveCSS('color', 'rgb(230, 237, 243)')
    await expect(prompt.locator('code')).toHaveCSS('background-color', 'rgb(28, 33, 41)')
    await expect(page.getByTestId('workspace-directory-create')).toHaveCSS('background-color', 'rgb(88, 166, 255)')
  })

  test('uses the same explicit confirmation flow in the CRT skin', async ({ page, workspaceRoot }) => {
    const workspace = path.join(workspaceRoot, 'crt-new-project')
    await openFarming(page)
    await expect.poll(async () => {
      const response = await page.request.get('/farming/api/control/agents')
      const payload = await response.json() as { mainAgentId?: string }
      return payload.mainAgentId || ''
    }, { timeout: 30_000 }).not.toBe('')

    await page.goto('/farming/crt/', { waitUntil: 'networkidle' })
    await page.keyboard.press('n')
    await expect(page.locator('#input-dialog')).toHaveClass(/active/)
    const bashOption = page.locator('#agent-list .agent-item[data-index="2"]')
    await expect(bashOption).toContainText('bash')
    await bashOption.click()
    await page.locator('#workspace-input').fill(workspace)
    await page.getByRole('button', { name: 'Start [Enter]', exact: true }).click()

    const prompt = page.locator('#workspace-directory-prompt')
    await expect(prompt).toBeVisible()
    await expect(prompt).toContainText('Create this workspace?')
    await expect(page.locator('#workspace-input')).toBeDisabled()
    await expect(page.locator('#workspace-directory-create')).toBeFocused()
    expect(fs.existsSync(workspace)).toBe(false)

    await page.locator('#workspace-directory-cancel').click()
    await expect(page.locator('#workspace-input')).toBeFocused()
    await page.getByRole('button', { name: 'Start [Enter]', exact: true }).click()
    await page.locator('#workspace-directory-create').click()
    await expect(page.locator('#input-dialog')).not.toHaveClass(/active/, { timeout: 30_000 })
    expect(fs.statSync(workspace).isDirectory()).toBe(true)
  })
})
