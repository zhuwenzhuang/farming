import fs from 'node:fs'
import path from 'node:path'
import { expect, openFarming, test } from './fixtures'

const themes = ['light', 'dark', 'paper'] as const

test('composer context and command menus keep semantic icons and compact geometry across appearances', async ({ page, workspaceRoot }, testInfo) => {
  const workspace = path.join(workspaceRoot, 'composer-context-and-commands')
  fs.mkdirSync(workspace, { recursive: true })
  fs.writeFileSync(path.join(workspace, 'context.txt'), 'Visible context fixture\n')
  const response = await page.request.post('/farming/api/control/agents', {
    data: { command: 'codex', workspace, agentRuntimeMode: 'chat' },
  })
  expect(response.ok()).toBeTruthy()
  const { agentId } = await response.json() as { agentId: string }
  await openFarming(page)
  await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
  const composer = page.getByTestId('code-acp-composer')
  const input = composer.getByTestId('code-acp-composer-input')

  for (const [layout, viewport] of [
    ['desktop', { width: 1280, height: 800 }],
    ['compact', { width: 390, height: 844 }],
  ] as const) {
    await page.setViewportSize(viewport)
    for (const theme of themes) {
      await page.emulateMedia({ colorScheme: theme === 'dark' ? 'dark' : 'light', reducedMotion: 'reduce' })
      await page.evaluate(value => {
        document.documentElement.dataset.appearance = value
        document.body.dataset.appearance = value
      }, theme)
      const capture = async (state: string) => {
        await page.mouse.move(0, 0)
        const name = `${layout}-${theme}-${state}`
        const output = testInfo.outputPath(`${name}.png`)
        await page.screenshot({ path: output, animations: 'disabled' })
        await testInfo.attach(name, { path: output, contentType: 'image/png' })
      }

      await input.fill('/')
      const commands = page.getByTestId('code-acp-command-menu')
      await expect(commands).toBeVisible()
      await expect(commands.locator('.code-slash-command-skill').first()).toBeVisible()
      await expect(commands.locator('[role="option"]').first().locator('svg')).toBeVisible()
      await capture('commands')

      await input.fill('Check @con')
      const files = page.getByTestId('code-composer-context-menu')
      await expect(files.getByTestId('code-composer-context-option').filter({ hasText: 'context.txt' })).toBeVisible()
      await expect(files.getByTestId('code-composer-context-option').filter({ hasText: 'context.txt' }).locator('svg')).toBeVisible()
      await capture('files')
      await input.press('Enter')
      await expect(input).toHaveValue('Check context.txt')
      const chip = page.getByTestId('code-composer-context-chip')
      await expect(chip).toContainText('context.txt')
      await capture('reference')
      await chip.locator('.code-composer-attachment-remove').click()
      await input.fill('')
    }
  }
})

test('ACP chat stages a file reference and displays semantic command icons before explicit send', async ({ page, workspaceRoot }) => {
  const workspace = path.join(workspaceRoot, 'composer-acp-context')
  fs.mkdirSync(workspace, { recursive: true })
  fs.writeFileSync(path.join(workspace, 'context.txt'), 'ACP context fixture\n')
  const response = await page.request.post('/farming/api/control/agents', {
    data: { command: 'codex', workspace, agentRuntimeMode: 'chat' },
  })
  expect(response.ok()).toBeTruthy()
  const { agentId } = await response.json() as { agentId: string }
  await openFarming(page)
  await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
  const input = page.getByTestId('code-acp-composer-input')
  await input.fill('/')
  const commandMenu = page.getByTestId('code-acp-command-menu')
  await expect(commandMenu).toBeVisible()
  await expect(commandMenu.locator('[role="option"]').first().locator('svg')).toBeVisible()
  await input.fill('Check @con')
  const files = page.getByTestId('code-composer-context-menu')
  await expect(files.getByTestId('code-composer-context-option').filter({ hasText: 'context.txt' })).toBeVisible()
  await input.press('Enter')
  await expect(page.getByTestId('code-composer-context-chip')).toContainText('context.txt')
  await expect(input).toHaveValue('Check context.txt')
  await page.getByTestId('code-acp-composer-send').click()
  await expect(input).toHaveValue('')
  await expect(page.locator('.code-agent-transcript-user').filter({ hasText: 'Referenced context:' })).toContainText('context.txt')
})
