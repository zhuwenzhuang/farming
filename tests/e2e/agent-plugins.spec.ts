import fs from 'node:fs'
import path from 'node:path'
import { expect, openFarming, test } from './fixtures'
import { selectCodeOption } from './code-select'

test('Plugins treats each Agent Home as an independent ordered Agent configuration', async ({ page, workspaceRoot }) => {
  await openFarming(page)
  const claudeDefaultHome = path.join(workspaceRoot, 'claude-default')
  const claudeWorkHome = path.join(workspaceRoot, 'claude-work')
  const codexWorkHome = path.join(workspaceRoot, 'codex-work')
  fs.mkdirSync(claudeDefaultHome, { recursive: true })
  fs.mkdirSync(claudeWorkHome, { recursive: true })
  fs.mkdirSync(codexWorkHome, { recursive: true })
  fs.writeFileSync(path.join(codexWorkHome, 'config.toml'), [
    'model = "gpt-5.6-sol"',
    'model_reasoning_effort = "high"',
    'service_tier = "priority"',
  ].join('\n'))
  fs.writeFileSync(path.join(claudeDefaultHome, 'settings.json'), JSON.stringify({
    env: { ANTHROPIC_MODEL: 'claude-default-only' },
  }))
  fs.writeFileSync(path.join(claudeWorkHome, 'settings.json'), JSON.stringify({
    env: { ANTHROPIC_MODEL: 'claude-work-only' },
  }))
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
            path: codexWorkHome,
            order: 0,
            newAgentDefaults: { model: 'inherit', reasoning: 'inherit', fast: 'inherit' },
          },
        ],
        claude: [
          {
            id: 'default',
            path: claudeDefaultHome,
            order: 1,
            newAgentDefaults: { model: 'inherit', reasoning: 'inherit', fast: 'inherit' },
          },
          {
            id: 'work',
            path: claudeWorkHome,
            order: 3,
            newAgentDefaults: { model: 'inherit', reasoning: 'inherit', fast: 'inherit' },
          },
        ],
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
  await expect(openCode.getByText(/Inherited from|was not found/)).toBeVisible()
  await expect(openCode.getByRole('combobox')).toHaveCount(0)
  await expect(panel.locator('.code-plugin-kind-section[open]')).toHaveCount(0)

  const claudeDefault = panel.getByTestId('code-plugin-section-agent-claude-default')
  const claudeWork = panel.getByTestId('code-plugin-section-agent-claude-work')
  await expect(claudeDefault.locator('.code-plugin-agent-configuration')).toContainText('Model: claude-default-only')
  await expect(claudeWork.locator('.code-plugin-agent-configuration')).toContainText('Model: claude-work-only')
  await expect(claudeDefault.getByRole('combobox')).toHaveCount(0)
  await expect(claudeWork.getByRole('combobox')).toHaveCount(0)

  const work = panel.getByTestId('code-plugin-section-agent-codex-work')
  await expect(work.getByText('work', { exact: true })).toBeVisible()
  await expect(work.getByText(codexWorkHome, { exact: true })).toBeVisible()
  await expect(work.locator('.code-plugin-agent-configuration')).toContainText('Model: gpt-5.6-sol')
  await expect(work.locator('.code-plugin-agent-configuration')).toContainText('Reasoning: high')
  await expect(work.locator('.code-plugin-agent-configuration')).toContainText('Service tier: priority')
  await expect(panel.locator('.code-plugins-panel-header h2')).toHaveCSS('font-size', '18px')
  await expect(panel.locator('.code-plugin-agent-sections-header h3')).toHaveCSS('font-size', '14px')
  await expect(work.locator('.code-plugin-agent-identity h3 > span')).toHaveCSS('font-size', '13px')
  await expect(work.locator('.code-plugin-agent-identity h3 > small')).toHaveCSS('font-size', '13px')
  await expect(work.locator('.code-plugin-agent-identity p code')).toHaveCSS('font-size', '14px')
  await expect(work.locator('.code-plugin-agent-configuration strong')).toHaveCSS('font-size', '14px')
  await expect(work.locator('.code-plugin-kind-section > summary span')).toHaveCSS('font-size', '13px')
  await page.locator('body').evaluate(body => { body.dataset.appearance = 'dark' })
  await expect(work.locator('.code-plugin-agent-configuration strong')).toHaveCSS('color', 'rgb(216, 216, 216)')
  await page.locator('body').evaluate(body => { body.dataset.appearance = 'light' })
  await work.getByRole('button', { name: 'Move down', exact: true }).click()
  await expect.poll(() => agentSections.evaluateAll(sections => (
    sections.map(section => section.getAttribute('data-testid')).slice(0, 2)
  ))).toEqual([
    'code-plugin-section-agent-claude-default',
    'code-plugin-section-agent-codex-work',
  ])
  await work.getByRole('button', { name: 'Edit configuration', exact: true }).click()
  await expect(page.getByTestId('code-file-editor')).toBeVisible()
  await expect(page.getByTestId('code-file-editor').getByRole('tab', { selected: true })).toContainText('config.toml')
  await page.getByTestId('code-nav-plugins').click()

  await panel.getByRole('button', { name: 'Add Agent', exact: true }).click()
  const form = panel.getByTestId('code-plugin-agent-form')
  await selectCodeOption(form.getByLabel('Agent provider'), 'codex')
  await form.getByLabel('Home path').fill(`${workspaceRoot}/codex-work`)
  await form.getByLabel('Home name').fill('duplicate-work')
  const duplicateResponse = page.waitForResponse(response => (
    response.url().endsWith('/farming/api/settings')
    && response.request().method() === 'POST'
  ))
  await form.getByRole('button', { name: 'Save', exact: true }).click()
  expect((await duplicateResponse).status()).toBe(409)
  await expect(panel.locator('.code-plugin-agent-form + .code-plugin-error')).toContainText('same Home path')
  const codexReviewHome = path.join(workspaceRoot, 'codex-review')
  await form.getByLabel('Home path').fill(codexReviewHome)
  await form.getByLabel('Home name').fill('review')
  await form.getByRole('button', { name: 'Save', exact: true }).click()
  const review = panel.getByTestId('code-plugin-section-agent-codex-review')
  await expect(review).toBeVisible()

  await review.getByRole('button', { name: 'Edit configuration', exact: true }).click()
  await expect(page.getByTestId('code-file-editor').getByRole('tab', { selected: true })).toContainText('config.toml')
  await page.getByTestId('code-file-monaco').click()
  await page.evaluate(() => {
    const editor = window.__farmingFileEditorTest
    if (!editor?.focus() || !editor.insertText('model = "gpt-5.6-terra"\n')) {
      throw new Error('Failed to edit a new Agent Home configuration')
    }
  })
  await page.getByRole('button', { name: 'Save file' }).click()
  const reviewConfigFile = path.join(codexReviewHome, 'config.toml')
  await expect.poll(() => fs.existsSync(reviewConfigFile) ? fs.readFileSync(reviewConfigFile, 'utf8') : '').toContain('gpt-5.6-terra')
  await page.getByTestId('code-nav-plugins').click()

  page.once('dialog', dialog => dialog.accept())
  await review.getByRole('button', { name: 'Remove', exact: true }).click()
  await expect(review).toHaveCount(0)
})
