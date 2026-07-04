import fs from 'node:fs'
import path from 'node:path'
import {
  expect,
  getAgentIdFromRow,
  openFarming,
  openNewAgentDialog,
  terminalRows,
  test,
} from './fixtures'

async function createControlAgent(page: import('@playwright/test').Page, command: string, workspace: string) {
  const response = await page.request.post('/farming/api/control/agents', {
    data: { command, workspace },
  })
  expect(response.ok()).toBeTruthy()
  const data = await response.json() as { agentId?: string }
  expect(data.agentId).toBeTruthy()
  return data.agentId as string
}

function colorNumbers(value: string) {
  const numbers = value.match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? []
  if (numbers.length < 3) throw new Error(`Unable to parse color: ${value}`)
  return numbers
}

function relativeLuminance([red, green, blue]: number[]) {
  const channel = (value: number) => {
    const normalized = value / 255
    return normalized <= 0.03928
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(red ?? 0) + 0.7152 * channel(green ?? 0) + 0.0722 * channel(blue ?? 0)
}

async function expectDarkSurface(locator: import('@playwright/test').Locator, name: string) {
  const colors = await locator.evaluate(element => {
    const style = window.getComputedStyle(element)
    return {
      background: style.backgroundColor,
      color: style.color,
    }
  })
  const backgroundLum = relativeLuminance(colorNumbers(colors.background))
  const textLum = relativeLuminance(colorNumbers(colors.color))
  expect(backgroundLum, `${name} background should be dark (${colors.background})`).toBeLessThan(0.08)
  expect(textLum, `${name} text should be readable (${colors.color})`).toBeGreaterThan(0.35)
}

async function expectReadableDarkText(locator: import('@playwright/test').Locator, name: string) {
  const color = await locator.evaluate(element => window.getComputedStyle(element).color)
  const textLum = relativeLuminance(colorNumbers(color))
  expect(textLum, `${name} text should be readable in dark mode (${color})`).toBeGreaterThan(0.35)
}

async function expectReadableMutedDarkText(locator: import('@playwright/test').Locator, name: string) {
  const color = await locator.evaluate(element => window.getComputedStyle(element).color)
  const textLum = relativeLuminance(colorNumbers(color))
  expect(textLum, `${name} muted text should be readable in dark mode (${color})`).toBeGreaterThan(0.22)
}

async function expectDarkSeparator(locator: import('@playwright/test').Locator, name: string) {
  const borderTopColor = await locator.evaluate(element => window.getComputedStyle(element).borderTopColor)
  const borderLum = relativeLuminance(colorNumbers(borderTopColor))
  expect(borderLum, `${name} separator should stay dark (${borderTopColor})`).toBeLessThan(0.12)
}

async function chooseAppearance(page: import('@playwright/test').Page, appearance: 'Light' | 'Dark') {
  await page.getByTestId('code-sidebar-options').click()
  const optionsMenu = page.getByTestId('code-options-menu')
  await expect(optionsMenu).toBeVisible()
  await optionsMenu.getByRole('menuitemradio', { name: `Appearance: ${appearance}` }).click()
  await expect(page.locator('body')).toHaveAttribute('data-appearance', appearance.toLowerCase())
}

async function expectSurfaceBackground(
  locator: import('@playwright/test').Locator,
  name: string,
  appearance: 'light' | 'dark'
) {
  await expect(locator).toHaveCount(1)
  const luminanceExpectation = expect.poll(async () => {
    const color = await locator.evaluate(element => window.getComputedStyle(element).backgroundColor)
    return relativeLuminance(colorNumbers(color))
  }, { message: `${name} should repaint for ${appearance} mode`, timeout: 5_000 })
  if (appearance === 'dark') {
    await luminanceExpectation.toBeLessThan(0.08)
  } else {
    await luminanceExpectation.toBeGreaterThan(0.82)
  }
}

async function expectTerminalAppearance(page: import('@playwright/test').Page, agentId: string, appearance: 'light' | 'dark') {
  const terminalPane = page.locator(`[data-testid="code-terminal-pane"][data-agent-id="${agentId}"]`)
  await expect(terminalPane).toBeVisible()
  await expectSurfaceBackground(terminalPane.locator('.terminal-session-host .xterm-screen').first(), 'terminal screen', appearance)
  await expectSurfaceBackground(terminalPane.locator('.terminal-session-host .xterm-viewport').first(), 'terminal viewport', appearance)
}

async function expectMonacoAppearance(page: import('@playwright/test').Page, appearance: 'light' | 'dark') {
  await expect(page.getByTestId('code-file-editor')).toBeVisible()
  await expectSurfaceBackground(page.locator('.monaco-editor-background').first(), 'Monaco editor background', appearance)
}

async function expectActiveTurnSpinner(locator: import('@playwright/test').Locator) {
  await expect.poll(async () => locator.evaluate(element => {
    const style = window.getComputedStyle(element)
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return true
    return (
      style.backgroundColor === 'rgba(0, 0, 0, 0)'
      && style.borderTopColor !== style.borderRightColor
      && style.animationName.includes('code-agent-running-spin')
    )
  }), { message: 'active Codex row should keep the spinner ring visible in dark mode', timeout: 15_000 }).toBe(true)
}

async function saveScreenshot(testInfo: import('@playwright/test').TestInfo, name: string, target: import('@playwright/test').Page | import('@playwright/test').Locator) {
  const filePath = testInfo.outputPath('dark-mode', name)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  await target.screenshot({ path: filePath, animations: 'disabled' })
  return filePath
}

test.describe('Farming Code dark skin', () => {
  test('applies and verifies the dark Codex skin across core surfaces', async ({ page, workspaceRoot }, testInfo) => {
    const projectDir = path.join(workspaceRoot, 'dark-project')
    fs.mkdirSync(path.join(projectDir, 'src'), { recursive: true })
    fs.writeFileSync(path.join(projectDir, 'README.md'), '# Dark mode\n\nconsole palette check\n')
    fs.writeFileSync(path.join(projectDir, 'src', 'app.ts'), 'export const theme = "dark";\n')
    const historyWorkspace = path.join(workspaceRoot, 'dark-history')
    const secondaryHistoryWorkspace = path.join(workspaceRoot, 'dark-history-archive')
    const suggestionParent = path.join(workspaceRoot, 'dark-suggestions')
    const suggestedWorkspace = path.join(suggestionParent, 'alpha-workspace')
    fs.mkdirSync(historyWorkspace, { recursive: true })
    fs.mkdirSync(secondaryHistoryWorkspace, { recursive: true })
    fs.mkdirSync(suggestedWorkspace, { recursive: true })

    await openFarming(page)
    await expect(page.locator('body')).toHaveAttribute('data-appearance', 'light')
    await chooseAppearance(page, 'Dark')
    await expect.poll(async () => {
      const response = await page.request.get('/farming/api/settings')
      const body = await response.json()
      return body.settings?.appearance
    }).toBe('dark')

    const bashAgentId = await createControlAgent(page, 'bash', projectDir)
    await page.locator(`[data-testid="code-agent-row"][data-agent-id="${bashAgentId}"]`).click()
    await expect(page.locator(`[data-testid="code-terminal-pane"][data-agent-id="${bashAgentId}"]`)).toBeVisible()
    await expect.poll(async () => terminalRows(page, bashAgentId, 80).then(rows => rows.some(row => row.includes(path.basename(projectDir))))).toBe(true)
    await expectTerminalAppearance(page, bashAgentId, 'dark')
    await chooseAppearance(page, 'Light')
    await expectTerminalAppearance(page, bashAgentId, 'light')
    await chooseAppearance(page, 'Dark')
    await expectTerminalAppearance(page, bashAgentId, 'dark')

    await expectDarkSurface(page.locator('body'), 'body')
    await expectDarkSurface(page.getByTestId('code-sidebar'), 'sidebar')
    await expectDarkSurface(page.getByTestId('code-composer'), 'composer')
    await saveScreenshot(testInfo, 'desktop-shell.png', page)

    await page.getByTestId('code-sidebar-options').click()
    await expect(page.getByTestId('code-options-menu')).toBeVisible()
    await expectDarkSurface(page.getByTestId('code-options-menu'), 'options menu')
    await saveScreenshot(testInfo, 'options-menu.png', page.getByTestId('code-options-menu'))
    await page.keyboard.press('Escape')

    await openNewAgentDialog(page)
    await expect(page.getByTestId('input-dialog')).toBeVisible()
    await expectDarkSurface(page.getByTestId('input-dialog'), 'new agent dialog')
    await saveScreenshot(testInfo, 'new-agent-dialog.png', page.getByTestId('input-dialog'))
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('input-dialog')).toBeHidden()

    await page.request.post('/farming/api/settings', {
      data: {
        appearance: 'dark',
        workspaceHistory: [historyWorkspace, secondaryHistoryWorkspace],
      },
    })
    await openNewAgentDialog(page)
    await page.getByTestId('agent-option-bash').click()
    await expect(page.getByTestId('workspace-step')).toBeVisible()
    await expect(page.getByTestId('workflow-template-select')).toHaveCount(0)
    await expect(page.getByTestId('workspace-history')).toBeVisible()
    await expectDarkSurface(page.getByTestId('workspace-history'), 'workspace history')
    await expectReadableDarkText(page.getByTestId('workspace-history-item').first().locator('.workspace-history-path'), 'workspace history path')
    await expectDarkSeparator(page.getByTestId('workspace-history-item').nth(1), 'workspace history row')
    await page.getByTestId('workspace-input').fill(`${suggestionParent}${path.sep}alp`)
    await expect(page.getByTestId('workspace-path-suggestions')).toBeVisible()
    await expectDarkSurface(page.getByTestId('workspace-path-suggestions'), 'workspace path suggestions')
    await expectReadableDarkText(page.getByTestId('workspace-path-suggestion').first().locator('.workspace-path-suggestion-name'), 'workspace path suggestion name')
    await expectReadableMutedDarkText(page.getByTestId('workspace-path-suggestion').first().locator('.workspace-path-suggestion-path'), 'workspace path suggestion path')
    await saveScreenshot(testInfo, 'new-agent-workspace-step.png', page.getByTestId('input-dialog'))
    await page.getByTestId('input-dialog-close').click()
    await expect(page.getByTestId('input-dialog')).toBeHidden()

    const agentRow = page.locator(`[data-testid="code-agent-row"][data-agent-id="${bashAgentId}"]`)
    await agentRow.click({ button: 'right' })
    await expect(page.getByTestId('code-agent-context-menu')).toBeVisible()
    await expectDarkSurface(page.getByTestId('code-agent-context-menu'), 'agent context menu')
    await saveScreenshot(testInfo, 'agent-context-menu.png', page.getByTestId('code-agent-context-menu'))
    await page.keyboard.press('Escape')

    await page.getByTestId('code-nav-search').click()
    await expect(page.getByTestId('code-search-panel')).toBeVisible()
    await expectDarkSurface(page.getByTestId('code-side-view-panel'), 'search side view')
    const searchInput = page.getByTestId('code-search-box').locator('input')
    await searchInput.fill(path.basename(projectDir))
    await expect(page.getByTestId('code-search-result').first()).toBeVisible()
    await expectDarkSurface(page.getByTestId('code-search-result').first(), 'search result')
    await expectReadableDarkText(page.getByTestId('code-search-panel').locator('.code-search-panel-header h2'), 'search header')
    await saveScreenshot(testInfo, 'search-view.png', page.getByTestId('code-side-view-panel'))
    await page.getByTestId('code-search-result').first().click()
    await expect(page.getByTestId('code-search-panel')).toHaveCount(0)

    await page.getByTestId('code-nav-history').click()
    await expect(page.getByTestId('code-history-panel')).toBeVisible()
    await expectDarkSurface(page.getByTestId('code-side-view-panel'), 'history side view')
    await expectReadableDarkText(page.getByTestId('code-history-panel').locator('.code-history-panel-header h2'), 'history header')
    await expectReadableDarkText(page.getByTestId('code-history-panel').locator('.code-empty-workspace h2, .code-history-card h3').first(), 'history content')
    await saveScreenshot(testInfo, 'history-view.png', page.getByTestId('code-side-view-panel'))
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('code-history-panel')).toHaveCount(0)

    const filesSection = page.getByTestId('code-files-section').first()
    const filesTitle = filesSection.locator('.code-files-title').first()
    if (await filesTitle.getAttribute('aria-expanded') !== 'true') {
      await filesTitle.click()
    }
    await expect(filesSection.getByTestId('code-file-row').filter({ hasText: 'README.md' })).toBeVisible()
    await expectDarkSurface(filesSection, 'files section')
    await saveScreenshot(testInfo, 'files-section.png', filesSection)
    await filesSection.getByTestId('code-file-row').filter({ hasText: 'README.md' }).click()
    await expect(page.getByTestId('code-file-editor')).toBeVisible()
    await expectDarkSurface(page.getByTestId('code-file-editor'), 'file editor')
    await expectMonacoAppearance(page, 'dark')
    await chooseAppearance(page, 'Light')
    await expectMonacoAppearance(page, 'light')
    await chooseAppearance(page, 'Dark')
    await expectMonacoAppearance(page, 'dark')
    await saveScreenshot(testInfo, 'file-editor.png', page.getByTestId('code-file-editor'))

    const codexAgentId = await createControlAgent(page, 'codex', projectDir)
    const codexAgentRow = page.locator(`[data-testid="code-agent-row"][data-agent-id="${codexAgentId}"]`)
    await codexAgentRow.click()
    await getAgentIdFromRow(page)
    await expectActiveTurnSpinner(codexAgentRow.locator('.code-agent-dot').first())
    await page.getByTestId('code-composer').locator('textarea').fill('queued dark followup')
    await page.getByTestId('code-composer-send').click()
    await expect(page.getByTestId('code-pending-followup')).toBeVisible()
    await expectDarkSurface(page.getByTestId('code-pending-followup'), 'pending follow-up')
    await page.getByTestId('code-pending-followup-discard').click()
    await expect(page.getByTestId('code-pending-followup')).toBeHidden()
    await expect(page.getByTestId('code-composer-add')).toBeVisible()
    await page.getByTestId('code-composer-add').click()
    await expect(page.getByTestId('code-composer-plus-menu')).toBeVisible()
    await expectDarkSurface(page.getByTestId('code-composer-plus-menu'), 'composer plus menu')
    await saveScreenshot(testInfo, 'composer-plus-menu.png', page.getByTestId('code-composer-plus-menu'))
    await page.keyboard.press('Escape')

    await page.getByTestId('code-composer-approval').click()
    await expect(page.getByTestId('code-approval-menu')).toBeVisible()
    await expectDarkSurface(page.getByTestId('code-approval-menu'), 'approval menu')
    await saveScreenshot(testInfo, 'approval-menu.png', page.getByTestId('code-approval-menu'))
    await page.keyboard.press('Escape')

    await page.getByTestId('code-composer-model-picker').click()
    await expect(page.getByTestId('code-model-menu')).toBeVisible()
    await expectDarkSurface(page.getByTestId('code-model-menu'), 'model menu')
    await saveScreenshot(testInfo, 'model-menu.png', page.getByTestId('code-model-menu'))
    await page.keyboard.press('Escape')

    await page.setViewportSize({ width: 390, height: 844 })
    await expect(page.getByTestId('code-mobile-topbar')).toBeVisible()
    await expectDarkSurface(page.getByTestId('code-mobile-topbar'), 'mobile topbar')
    await saveScreenshot(testInfo, 'mobile-shell.png', page)
  })
})
