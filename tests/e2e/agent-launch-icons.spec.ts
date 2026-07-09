import { expect, openFarming, openNewAgentDialog, startAgentFromOpenDialog, test } from './fixtures'

test.describe('agent launch icons', () => {
  test('shows provider icons in the New Agent dialog and project launch menu', async ({ page, workspaceRoot }) => {
    await openFarming(page)
    await openNewAgentDialog(page)

    for (const agentName of ['codex', 'claude', 'bash', 'zsh']) {
      await expect(page.getByTestId(`agent-option-${agentName}`).locator(`.agent-launch-icon-${agentName}`)).toBeVisible()
    }

    await startAgentFromOpenDialog(page, 'bash', workspaceRoot)
    const projectGroup = page.getByTestId('code-project-group').first()
    await projectGroup.hover()
    await projectGroup.getByTestId('code-project-new-agent').click({ force: true })
    const menu = page.getByTestId('code-project-new-agent-menu')
    await expect(menu).toBeVisible()
    for (const agentName of ['codex', 'claude', 'bash', 'zsh']) {
      await expect(page.getByTestId(`code-project-agent-launch-${agentName}`).locator(`.agent-launch-icon-${agentName}`)).toBeVisible()
    }
  })
})
