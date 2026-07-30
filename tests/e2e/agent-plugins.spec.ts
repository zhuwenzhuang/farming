import { expect, openFarming, test } from './fixtures'

test('Plugins treats each Agent Home as an independent ordered Agent configuration', async ({ page, workspaceRoot }) => {
  await openFarming(page)
  await page.request.post('/farming/api/settings', {
    data: {
      agentHomes: {
        codex: [
          {
            id: 'default',
            path: '~/.codex',
            order: 2,
            newAgentDefaults: { model: 'inherit', reasoning: 'inherit', fast: 'inherit' },
          },
          {
            id: 'work',
            path: `${workspaceRoot}/codex-work`,
            order: 0,
            newAgentDefaults: { model: 'inherit', reasoning: 'inherit', fast: 'inherit' },
          },
        ],
        claude: [{
          id: 'default',
          path: '~/.claude',
          order: 1,
          newAgentDefaults: { model: 'inherit', reasoning: 'inherit', fast: 'inherit' },
        }],
      },
    },
  })

  await page.getByTestId('code-nav-plugins').click()
  const panel = page.getByTestId('code-plugins-panel')
  const agentSections = panel.locator('.code-plugin-agent-section')
  await expect.poll(() => agentSections.evaluateAll(sections => (
    sections.map(section => section.getAttribute('data-testid')).slice(0, 3)
  ))).toEqual([
    'code-plugin-section-agent-codex-work',
    'code-plugin-section-agent-claude-default',
    'code-plugin-section-agent-codex-default',
  ])

  const openCode = panel.getByTestId('code-plugin-section-agent-opencode-default')
  await expect(openCode.getByLabel('Model')).toBeDisabled()
  await expect(openCode.getByLabel('Model').locator('option')).toHaveText([
    'Use Agent configuration from this Home',
  ])
  await expect(openCode.getByLabel('Reasoning').locator('option')).toHaveText([
    'Use Agent configuration from this Home',
  ])

  const work = panel.getByTestId('code-plugin-section-agent-codex-work')
  await expect(work.getByText('work', { exact: true })).toBeVisible()
  await expect(work.getByText(`${workspaceRoot}/codex-work`, { exact: true })).toBeVisible()
  await work.getByRole('button', { name: 'Move down', exact: true }).click()
  await expect.poll(() => agentSections.evaluateAll(sections => (
    sections.map(section => section.getAttribute('data-testid')).slice(0, 2)
  ))).toEqual([
    'code-plugin-section-agent-claude-default',
    'code-plugin-section-agent-codex-work',
  ])
  await work.getByLabel('Fast').selectOption('on')
  await expect.poll(async () => {
    const response = await page.request.get('/farming/api/settings')
    const body = await response.json()
    return body.settings.agentHomes.codex
      .find((home: { id: string }) => home.id === 'work')
      ?.newAgentDefaults.fast
  }).toBe('on')

  await panel.getByRole('button', { name: 'Add Agent', exact: true }).click()
  const form = panel.getByTestId('code-plugin-agent-form')
  await form.getByLabel('Agent provider').selectOption('codex')
  await form.getByLabel('Home path').fill(`${workspaceRoot}/codex-review`)
  await form.getByLabel('Home name').fill('review')
  await form.getByRole('button', { name: 'Save', exact: true }).click()
  const review = panel.getByTestId('code-plugin-section-agent-codex-review')
  await expect(review).toBeVisible()

  page.once('dialog', dialog => dialog.accept())
  await review.getByRole('button', { name: 'Remove', exact: true }).click()
  await expect(review).toHaveCount(0)
})
