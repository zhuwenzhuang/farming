import { expect, openFarming, openNewAgentDialog, startAgentFromOpenDialog, test } from './fixtures'

test.describe('agent launch icons', () => {
  test('shows provider icons in the New Agent dialog and project launch menu', async ({ page, workspaceRoot }) => {
    await page.route('**/api/executables', async route => {
      const response = await route.fetch()
      const payload = await response.json() as { agents: Array<Record<string, unknown>>; total: number }
      payload.agents.splice(2, 0, {
        name: 'qoder',
        command: 'qodercli',
        description: 'Qoder coding assistant',
        category: 'coding',
        supported: true,
        interactive: true,
      })
      payload.agents.splice(3, 0, {
        name: 'qwen',
        description: 'Qwen Code coding assistant',
        category: 'coding',
        supported: true,
        interactive: true,
      })
      payload.total = payload.agents.length
      await route.fulfill({ response, json: payload })
    })
    await openFarming(page)
    await openNewAgentDialog(page)

    for (const agentName of ['codex', 'claude', 'qoder', 'qwen', 'bash', 'zsh']) {
      await expect(page.getByTestId(`agent-option-${agentName}`).locator(`.agent-launch-icon-${agentName}`)).toBeVisible()
    }
    const launchOrder = await page.locator('[data-testid^="agent-option-"]').evaluateAll(options => (
      options.map(option => option.getAttribute('data-testid')?.replace('agent-option-', '') || '')
    ))
    expect(launchOrder.indexOf('qwen')).toBe(launchOrder.indexOf('qoder') + 1)
    const qwenDialogIcon = page.getByTestId('agent-option-qwen').locator('.agent-launch-icon-qwen')
    await expect(qwenDialogIcon.locator('image')).toHaveCount(0)
    await expect(qwenDialogIcon.locator('path')).toBeAttached()
    const qoderDialogIcon = page.getByTestId('agent-option-qoder').locator('.agent-launch-icon-qoder')
    await expect(qoderDialogIcon.locator('image')).toHaveCount(0)
    await expect(qoderDialogIcon.locator('path').first()).toBeAttached()
    await expect(qoderDialogIcon.locator('.agent-launch-icon-theme-light')).toBeVisible()
    await expect(qoderDialogIcon.locator('.agent-launch-icon-theme-dark')).toBeHidden()
    const zshDialogIcon = page.getByTestId('agent-option-zsh').locator('.agent-launch-icon-zsh')
    await expect(zshDialogIcon.locator('image')).toHaveCount(0)
    await expect(zshDialogIcon.locator('path').first()).toBeAttached()
    await expect(zshDialogIcon.locator('.agent-launch-icon-theme-light')).toBeVisible()
    await expect(zshDialogIcon.locator('.agent-launch-icon-theme-dark')).toBeHidden()
    await page.evaluate(() => document.body.setAttribute('data-appearance', 'dark'))
    await expect(qoderDialogIcon.locator('.agent-launch-icon-theme-light')).toBeHidden()
    await expect(qoderDialogIcon.locator('.agent-launch-icon-theme-dark')).toBeVisible()
    await expect(zshDialogIcon.locator('.agent-launch-icon-theme-light')).toBeHidden()
    await expect(zshDialogIcon.locator('.agent-launch-icon-theme-dark')).toBeVisible()
    await page.evaluate(() => document.body.setAttribute('data-appearance', 'light'))
    await page.getByTestId('agent-option-qwen').click()
    await expect(page.getByTestId('agent-runtime-mode')).toBeVisible()
    await page.getByRole('button', { name: 'Back' }).click()

    await startAgentFromOpenDialog(page, 'bash', workspaceRoot)
    const projectGroup = page.getByTestId('code-project-group').first()
    await projectGroup.hover()
    await projectGroup.getByTestId('code-project-new-agent').click({ force: true })
    const menu = page.getByTestId('code-project-new-agent-menu')
    await expect(menu).toBeVisible()
    for (const agentName of ['codex', 'claude', 'qoder', 'qwen', 'bash', 'zsh']) {
      await expect(page.getByTestId(`code-project-agent-launch-${agentName}`).locator(`.agent-launch-icon-${agentName}`)).toBeVisible()
    }
  })
})
