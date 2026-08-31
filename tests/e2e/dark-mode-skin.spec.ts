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

async function expectReadableDarkGlyph(locator: import('@playwright/test').Locator, name: string) {
  const paints = await locator.evaluate(element => {
    const nodes = [element, ...element.querySelectorAll('*')]
    return nodes.flatMap(node => {
      const style = window.getComputedStyle(node)
      return [style.fill, style.stroke].filter(value => value !== 'none' && value !== 'rgba(0, 0, 0, 0)')
    })
  })
  const hasReadablePaint = paints.some(paint => relativeLuminance(colorNumbers(paint)) > 0.22)
  expect(hasReadablePaint, `${name} should use a readable dark-mode paint (${paints.join(', ')})`).toBe(true)
}

async function expectDarkSeparator(locator: import('@playwright/test').Locator, name: string) {
  const borderTopColor = await locator.evaluate(element => window.getComputedStyle(element).borderTopColor)
  const borderLum = relativeLuminance(colorNumbers(borderTopColor))
  expect(borderLum, `${name} separator should stay dark (${borderTopColor})`).toBeLessThan(0.12)
}

async function expectPageTitleStyle(locator: import('@playwright/test').Locator) {
  await expect(locator).toHaveCSS('font-size', '18px')
  await expect(locator).toHaveCSS('font-weight', '600')
  await expect(locator).toHaveCSS('line-height', '24px')
}

async function chooseAppearance(page: import('@playwright/test').Page, appearance: 'Light' | 'Dark' | 'Paper') {
  await page.getByTestId('code-sidebar-options').click()
  const settingsPanel = page.getByTestId('code-settings-panel')
  await expect(settingsPanel).toBeVisible()
  await settingsPanel.getByRole('group', { name: 'Appearance' }).getByRole('button', { name: appearance, exact: true }).click()
  await expect(page.locator('body')).toHaveAttribute('data-appearance', appearance.toLowerCase())
  await settingsPanel.getByRole('button', { name: 'Close' }).click()
}

async function expectSurfaceBackground(
  locator: import('@playwright/test').Locator,
  name: string,
  appearance: 'light' | 'dark' | 'paper'
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

async function expectStickySurface(locator: import('@playwright/test').Locator, name: string, expected: string) {
  await expect.poll(() => locator.evaluate((element, color) => (
    window.getComputedStyle(element).backgroundImage.includes(color)
  ), expected), { message: `${name} sticky surface should resolve to ${expected}` }).toBe(true)
}

async function expectProjectRowSurface(page: import('@playwright/test').Page, expected: string) {
  await expectStickySurface(page.locator('.code-project-row').first(), 'project row', expected)
}

async function expectProviderIconInsideAgentRow(row: import('@playwright/test').Locator) {
  const icon = row.locator('.code-agent-row-provider-icon')
  await expect(icon).toBeVisible()
  await expect.poll(async () => {
    const [rowBox, iconBox] = await Promise.all([row.boundingBox(), icon.boundingBox()])
    if (!rowBox || !iconBox) return false
    return iconBox.x >= rowBox.x
      && iconBox.y >= rowBox.y
      && iconBox.x + iconBox.width <= rowBox.x + rowBox.width
      && iconBox.y + iconBox.height <= rowBox.y + rowBox.height
  }, { message: 'provider icon should be contained by the Agent selection surface' }).toBe(true)
}

async function expectTerminalAppearance(page: import('@playwright/test').Page, agentId: string, appearance: 'light' | 'dark' | 'paper') {
  const terminalPane = page.locator(`[data-testid="code-terminal-pane"][data-agent-id="${agentId}"]`)
  await expect(terminalPane).toBeVisible()
  await expectSurfaceBackground(terminalPane.locator('.terminal-session-host .xterm-screen').first(), 'terminal screen', appearance)
  await expectSurfaceBackground(terminalPane.locator('.terminal-session-host .xterm-viewport').first(), 'terminal viewport', appearance)
}

async function expectMonacoAppearance(page: import('@playwright/test').Page, appearance: 'light' | 'dark' | 'paper') {
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

test.describe('Farming Code appearance skins', () => {
  test('paints the saved dark appearance before application modules execute', async ({ page }) => {
    const settingsResponse = await page.request.post('/farming/api/settings', {
      data: { appearance: 'dark' },
    })
    expect(settingsResponse.ok()).toBeTruthy()

    let releaseModules = () => {}
    const modulesReleased = new Promise<void>(resolve => {
      releaseModules = resolve
    })
    await page.route(/\/farming\/assets\/.*\.js(?:\?.*)?$/, async route => {
      await modulesReleased
      await route.continue()
    })

    try {
      await page.goto('/farming/', { waitUntil: 'commit' })
      await page.waitForFunction(() => (
        document.documentElement.dataset.appearance === 'dark'
        && document.body !== null
      ))
      const firstPaint = await page.evaluate(() => ({
        appearance: document.documentElement.dataset.appearance,
        preference: document.documentElement.dataset.appearancePreference,
        background: getComputedStyle(document.body).backgroundColor,
        colorScheme: document.querySelector<HTMLMetaElement>('meta[name="color-scheme"]')?.content,
        themeColor: document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.content,
      }))
      expect(firstPaint).toEqual({
        appearance: 'dark',
        preference: 'dark',
        background: 'rgb(24, 24, 24)',
        colorScheme: 'dark',
        themeColor: '#181818',
      })
    } finally {
      releaseModules()
    }
    await page.waitForLoadState('domcontentloaded')
  })

  test('keeps the server-injected dark appearance while settings hydrate', async ({ page }) => {
    const settingsResponse = await page.request.post('/farming/api/settings', {
      data: { appearance: 'dark' },
    })
    expect(settingsResponse.ok()).toBeTruthy()

    let releaseSettings = () => {}
    const settingsReleased = new Promise<void>(resolve => {
      releaseSettings = resolve
    })
    await page.route(/\/farming\/api\/settings(?:\?.*)?$/, async route => {
      if (route.request().method() === 'GET') {
        await settingsReleased
      }
      await route.continue()
    })

    try {
      await page.goto('/farming/')
      await expect(page.getByTestId('app-shell')).toBeVisible()
      await expect(page.locator('body')).toHaveAttribute('data-appearance', 'dark')
      await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(24, 24, 24)')
      await expect(page.getByTestId('app-shell')).toHaveCSS('background-color', 'rgb(24, 24, 24)')
      await expect(page.locator('meta[name="color-scheme"]')).toHaveAttribute('content', 'dark')
    } finally {
      releaseSettings()
    }
  })

  test('applies Paper across the browser canvas, workbench, settings, and terminal', async ({ page, workspaceRoot }, testInfo) => {
    const projectDir = path.join(workspaceRoot, 'paper-project')
    fs.mkdirSync(projectDir, { recursive: true })

    const settingsResponse = await page.request.post('/farming/api/settings', {
      data: { appearance: 'paper' },
    })
    expect(settingsResponse.ok()).toBeTruthy()

    await openFarming(page)
    await expect(page.locator('html')).toHaveAttribute('data-appearance', 'paper')
    await expect(page.locator('body')).toHaveAttribute('data-appearance', 'paper')
    await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(249, 248, 244)')
    await expect(page.getByTestId('app-shell')).toHaveCSS('background-color', 'rgb(249, 248, 244)')
    await expect(page.getByTestId('code-sidebar')).toHaveCSS('background-color', 'rgb(249, 248, 244)')
    await expect(page.locator('.code-sidebar-resizer')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    await expect(page.locator('meta[name="color-scheme"]')).toHaveAttribute('content', 'light')
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#f9f8f4')

    await page.getByTestId('code-nav-search').click()
    const searchBox = page.getByTestId('code-search-box')
    await expect(searchBox.locator('input')).toBeFocused()
    await expect(searchBox).toHaveCSS('background-color', 'rgb(239, 237, 231)')
    await expect(searchBox).toHaveCSS('border-color', 'rgba(0, 0, 0, 0)')
    await expect(searchBox).toHaveCSS('box-shadow', 'none')
    await page.getByTestId('code-search-back').click()

    await page.getByTestId('code-sidebar-options').click()
    const settingsPanel = page.getByTestId('code-settings-panel')
    const appearanceGroup = settingsPanel.getByRole('group', { name: 'Appearance' })
    await expect(appearanceGroup.getByRole('button', { name: 'Paper', exact: true })).toHaveClass(/active/)
    await expect(settingsPanel.locator('.code-settings-inline-choice')).toHaveCount(2)
    const appearanceSwatches = settingsPanel.locator('.code-settings-appearance-swatch')
    await expect(appearanceSwatches).toHaveCount(4)
    await expect(appearanceSwatches.nth(1)).toHaveCSS('background-color', 'rgb(255, 255, 255)')
    await expect(appearanceSwatches.nth(2)).toHaveCSS('background-color', 'rgb(24, 24, 24)')
    await expect(appearanceSwatches.nth(3)).toHaveCSS('background-color', 'rgb(249, 248, 244)')
    const settingsCard = settingsPanel.locator('.code-settings-card').first()
    for (const side of ['top', 'right', 'bottom', 'left'] as const) {
      await expect(settingsCard).toHaveCSS(`border-${side}-color`, 'rgba(0, 0, 0, 0)')
    }
    await expect(settingsCard).toHaveCSS('background-color', 'rgb(239, 237, 231)')
    await expect(settingsPanel.locator('.code-settings-segmented').first()).toHaveCSS('border-color', 'rgba(0, 0, 0, 0)')
    await expect(settingsPanel.locator('.code-settings-section + .code-settings-section').first()).toHaveCSS('border-top-color', 'rgba(0, 0, 0, 0)')
    await settingsPanel.getByRole('button', { name: 'Close' }).click()

    await openNewAgentDialog(page)
    await page.getByTestId('agent-option-bash').click()
    const workspaceInput = page.getByTestId('workspace-input')
    await expect(workspaceInput).toBeVisible()
    await expect(page.getByTestId('input-dialog')).toHaveCSS('background-color', 'rgb(249, 248, 244)')
    await expect(workspaceInput).toHaveCSS('background-color', 'rgb(255, 254, 250)')
    await expect(workspaceInput).toHaveCSS('border-color', 'rgba(0, 0, 0, 0)')
    await expect(workspaceInput).toHaveCSS('border-style', 'solid')
    await expect(workspaceInput).toHaveCSS('border-radius', '8px')
    await workspaceInput.focus()
    await expect(workspaceInput).toHaveCSS('border-color', 'rgba(0, 0, 0, 0)')
    await expect(workspaceInput).toHaveCSS('box-shadow', 'none')
    await expect(workspaceInput).toHaveCSS('outline-style', 'none')
    await page.getByTestId('input-dialog-close').click()

    const agentId = await createControlAgent(page, 'bash', projectDir)
    await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
    await expectProjectRowSurface(page, 'rgb(249, 248, 244)')
    await expectTerminalAppearance(page, agentId, 'paper')
    await chooseAppearance(page, 'Light')
    await expectProjectRowSurface(page, 'rgb(244, 245, 242)')
    await expectTerminalAppearance(page, agentId, 'light')
    await chooseAppearance(page, 'Paper')
    await expectProjectRowSurface(page, 'rgb(249, 248, 244)')
    await expectTerminalAppearance(page, agentId, 'paper')

    await page.setViewportSize({ width: 390, height: 844 })
    await page.evaluate(() => document.body.classList.add('code-compact-layout', 'code-mobile-touch'))
    const paperMobileTopbar = page.getByTestId('code-mobile-topbar')
    await expect(paperMobileTopbar).toBeVisible()
    await expect(paperMobileTopbar).toHaveCSS('background-color', 'rgb(239, 237, 231)')
    await expect(page.getByTestId('code-mobile-menu')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    await expect(page.getByTestId('code-mobile-more')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    await saveScreenshot(testInfo, 'paper-mobile-workspace.png', page)
    await page.getByTestId('code-mobile-menu').click()
    await expect(page.getByTestId('code-sidebar')).toHaveCSS('background-color', 'rgb(239, 237, 231)')
    await expectProjectRowSurface(page, 'rgb(239, 237, 231)')
    await expect(page.getByTestId('code-agents-section').first()).toHaveCSS('background-color', 'rgb(239, 237, 231)')
    // Opening the sidebar leaves the pointer over the control that replaces
    // the mobile menu. Move it onto inert sidebar space before checking idle
    // surfaces so the assertion does not confuse the shared hover surface
    // with an idle navigation state.
    await page.mouse.move(380, 820)
    const focusedSidebarToggle = page.getByTestId('code-sidebar-toggle')
    await expect(focusedSidebarToggle).toBeFocused()
    await expect(focusedSidebarToggle).toHaveCSS('background-color', 'rgba(82, 75, 60, 0.055)')
    const paperAgentRow = page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
    const paperProjectGroup = page.getByTestId('code-project-group').filter({ has: paperAgentRow })
    for (const idleNavigationControl of [
      page.getByTestId('code-new-agent'),
      page.getByTestId('code-nav-search'),
      page.getByTestId('code-nav-history'),
      page.getByTestId('code-nav-plugins'),
      page.getByTestId('code-sidebar-options'),
    ]) {
      await expect(idleNavigationControl).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    }
    await expect(paperAgentRow).toHaveCSS('background-color', 'rgb(230, 229, 225)')
    await expectProviderIconInsideAgentRow(paperAgentRow)
    await expect(paperProjectGroup.locator('.code-files-header')).toHaveCSS('background-color', 'rgb(239, 237, 231)')
    await saveScreenshot(testInfo, 'paper-mobile-shell.png', page)
  })

  test('applies and verifies the dark Codex skin across core surfaces', async ({ page, workspaceRoot }, testInfo) => {
    const projectDir = path.join(workspaceRoot, 'dark-project')
    fs.mkdirSync(path.join(projectDir, 'src'), { recursive: true })
    fs.writeFileSync(path.join(projectDir, 'README.md'), '# Dark mode\n\nconsole palette check\n')
    fs.writeFileSync(path.join(projectDir, 'src', 'app.ts'), 'export const theme = "dark";\n')
    const historyWorkspace = process.cwd()
    const secondaryHistoryWorkspace = path.dirname(process.cwd())
    const suggestionParent = path.join(workspaceRoot, 'dark-suggestions')
    const suggestedWorkspace = path.join(suggestionParent, 'alpha-workspace')
    fs.mkdirSync(suggestedWorkspace, { recursive: true })
    await page.route('**/api/agent-extensions', route => route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        agents: [{
          id: 'codex',
          name: 'codex',
          description: 'Codex CLI',
          discoverySupported: true,
          homes: [{
            id: 'default',
            extensions: [{
              id: '$dark-surface',
              command: '$dark-surface',
              name: 'Dark surface fixture',
              description: 'Deterministic appearance fixture.',
              kind: 'skill',
              scope: 'Personal',
            }, {
              id: '$dark-surface-secondary',
              command: '$dark-surface-secondary',
              name: 'Secondary dark surface fixture',
              description: 'Keeps list separators deterministic.',
              kind: 'skill',
              scope: 'Personal',
            }],
          }],
        }],
      }),
    }))

    await openFarming(page)
    await expect(page.locator('body')).toHaveAttribute('data-appearance', 'light')
    await page.getByTestId('code-sidebar-options').click()
    const lightAppearanceGroup = page.getByTestId('code-settings-panel').getByRole('group', { name: 'Appearance' })
    await expect(lightAppearanceGroup.getByRole('button', { name: 'Dark', exact: true }))
      .toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    await page.getByTestId('code-settings-panel').getByRole('button', { name: 'Close' }).click()
    await chooseAppearance(page, 'Dark')
    await expect.poll(async () => {
      const response = await page.request.get('/farming/api/settings')
      const body = await response.json()
      return body.settings?.appearance
    }).toBe('dark')

    const bashAgentId = await createControlAgent(page, 'bash', projectDir)
    await page.locator(`[data-testid="code-agent-row"][data-agent-id="${bashAgentId}"]`).click()
    await expect(page.locator(`[data-testid="code-terminal-pane"][data-agent-id="${bashAgentId}"]`)).toBeVisible()
    await expect.poll(async () => terminalRows(page, bashAgentId, 80).then(rows => rows.join('').includes(path.basename(projectDir)))).toBe(true)
    await expectTerminalAppearance(page, bashAgentId, 'dark')
    await chooseAppearance(page, 'Light')
    await expectTerminalAppearance(page, bashAgentId, 'light')
    await chooseAppearance(page, 'Dark')
    await expectTerminalAppearance(page, bashAgentId, 'dark')

    await expectDarkSurface(page.locator('body'), 'body')
    await expectDarkSurface(page.getByTestId('code-sidebar'), 'sidebar')
    await expect(page.getByTestId('code-main')).toHaveCSS('background-color', 'rgb(24, 24, 24)')
    await expect(page.getByTestId('code-sidebar')).toHaveCSS('background-color', 'rgb(32, 32, 32)')
    await expectProjectRowSurface(page, 'rgb(32, 32, 32)')
    await expect(page.getByTestId('code-sidebar-resizer')).toHaveCSS('background-color', 'rgb(42, 42, 42)')
    await expectReadableMutedDarkText(page.getByTestId('code-new-agent'), 'new Agent action')
    await expectStickySurface(page.getByTestId('code-agents-section').first(), 'Agent section', 'rgb(32, 32, 32)')
    const projectList = page.getByTestId('code-project-list')
    await expect.poll(() => projectList.evaluate(element => (
      getComputedStyle(element, '::-webkit-scrollbar-thumb').backgroundColor
    ))).toBe('rgba(0, 0, 0, 0)')
    await projectList.hover()
    await expect.poll(() => projectList.evaluate(element => (
      getComputedStyle(element, '::-webkit-scrollbar-thumb').backgroundColor
    ))).toBe('rgba(139, 148, 158, 0.44)')
    await page.getByTestId('code-main').hover({ position: { x: 20, y: 20 } })
    await expect.poll(() => projectList.evaluate(element => (
      getComputedStyle(element, '::-webkit-scrollbar-thumb').backgroundColor
    ))).toBe('rgba(0, 0, 0, 0)')
    await expectDarkSurface(page.getByTestId('code-composer'), 'composer')
    await saveScreenshot(testInfo, 'desktop-shell.png', page)
    await chooseAppearance(page, 'Light')
    await saveScreenshot(testInfo, 'light-desktop-shell.png', page)
    await chooseAppearance(page, 'Dark')

    await page.getByTestId('code-sidebar-options').click()
    const settingsPanel = page.getByTestId('code-settings-panel')
    await expect(settingsPanel).toBeVisible()
    await expectDarkSurface(page.locator('.code-settings-panel'), 'settings panel')
    await expectReadableDarkText(settingsPanel.locator('.code-settings-row-copy strong').first(), 'settings row label')
    await expectReadableMutedDarkText(settingsPanel.locator('.code-settings-search-timeout-row output'), 'search timeout value')
    await expectReadableMutedDarkText(settingsPanel.locator('.code-settings-row-copy small').first(), 'settings row hint')
    await expectReadableDarkGlyph(settingsPanel.locator('.code-settings-inline-label svg').first(), 'appearance glyph')
    await expectDarkSeparator(settingsPanel.locator('.code-settings-section + .code-settings-section').first(), 'settings section')
    await saveScreenshot(testInfo, 'options-menu.png', page.locator('.code-settings-panel'))
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
    await chooseAppearance(page, 'Paper')
    await agentRow.click({ button: 'right' })
    await expect(page.getByTestId('code-agent-context-menu')).toHaveCSS('background-color', 'rgb(239, 237, 231)')
    await page.keyboard.press('Escape')
    await chooseAppearance(page, 'Dark')

    await page.getByTestId('code-nav-search').click()
    await expect(page.getByTestId('code-search-panel')).toBeVisible()
    await expectDarkSurface(page.getByTestId('code-side-view-panel'), 'search side view')
    const searchBox = page.getByTestId('code-search-box')
    const searchInput = searchBox.locator('input')
    await searchInput.fill(path.basename(projectDir))
    await expect(searchInput).toBeFocused()
    await expect(searchBox).toHaveCSS('border-color', 'rgba(0, 0, 0, 0)')
    await expect(searchBox).toHaveCSS('box-shadow', 'none')
    await expect(page.getByTestId('code-search-result').first()).toBeVisible()
    await expectDarkSurface(page.getByTestId('code-search-result').first(), 'search result')
    const searchTitle = page.getByTestId('code-search-panel').locator('.code-search-panel-header h2')
    await expectReadableDarkText(searchTitle, 'search header')
    await expectPageTitleStyle(searchTitle)
    await saveScreenshot(testInfo, 'search-view.png', page.getByTestId('code-side-view-panel'))
    await page.getByTestId('code-search-result').first().click()
    await expect(page.getByTestId('code-search-panel')).toHaveCount(0)

    await page.getByTestId('code-nav-history').click()
    await expect(page.getByTestId('code-history-panel')).toBeVisible()
    await expectDarkSurface(page.getByTestId('code-side-view-panel'), 'history side view')
    const historyTitle = page.getByTestId('code-history-panel').locator('.code-history-panel-header h2')
    await expectReadableDarkText(historyTitle, 'history header')
    await expectPageTitleStyle(historyTitle)
    await expectReadableDarkText(page.getByTestId('code-history-panel').locator('.code-empty-workspace h2, .code-history-card-title').first(), 'history content')
    await saveScreenshot(testInfo, 'history-view.png', page.getByTestId('code-side-view-panel'))
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('code-history-panel')).toHaveCount(0)

    await page.getByTestId('code-nav-plugins').click()
    await expect(page.getByTestId('code-plugins-panel')).toBeVisible()
    const pluginsTitle = page.getByTestId('code-plugins-panel').locator('.code-plugins-panel-header h2')
    await expectReadableDarkText(pluginsTitle, 'plugins header')
    await expectPageTitleStyle(pluginsTitle)
    await expect(page.locator('.code-plugin-desktop-target').first()).toHaveCSS('background-color', 'rgb(34, 34, 34)')
    await expect(page.locator('.code-plugin-desktop-target').first()).toHaveCSS('border-color', 'rgb(56, 56, 56)')
    await page.getByTestId('code-plugin-tab-extensions').click()
    await expect(page.locator('.code-plugin-extension-kind-tabs')).toHaveCSS('background-color', 'rgb(34, 34, 34)')
    await expect(page.locator('.code-plugin-extension-list')).toHaveCSS('border-width', '0px')
    await expect(page.locator('.code-plugin-extension').first()).toHaveCSS('border-bottom-width', '0px')
    await page.locator('.code-plugin-extension').first().click()
    const pluginDetailDialog = page.getByTestId('code-plugin-detail-dialog')
    await expect(pluginDetailDialog).toHaveCSS('background-color', 'rgb(48, 48, 48)')
    await expect(pluginDetailDialog).toHaveCSS('border-width', '0px')
    await pluginDetailDialog.getByRole('button').first().click()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('code-plugins-panel')).toHaveCount(0)

    const filesSection = page.getByTestId('code-files-section').first()
    const filesTitle = filesSection.locator('.code-files-title').first()
    if (await filesTitle.getAttribute('aria-expanded') !== 'true') {
      await filesTitle.click()
    }
    await expect(filesSection.getByTestId('code-file-row').filter({ hasText: 'README.md' })).toBeVisible()
    await expectDarkSurface(filesSection, 'files section')
    await expect(filesSection.locator('.code-git-history-header')).toHaveCSS('background-color', 'rgb(32, 32, 32)')
    const gitHistoryTitle = filesSection.locator('.code-git-history-title')
    await gitHistoryTitle.hover()
    await expectReadableDarkText(gitHistoryTitle, 'Git history title on hover')
    await gitHistoryTitle.focus()
    await expectReadableDarkText(gitHistoryTitle, 'Git history title on focus')
    await saveScreenshot(testInfo, 'files-section.png', filesSection)
    await filesSection.getByTestId('code-file-row').filter({ hasText: 'README.md' }).click()
    await expect(page.getByTestId('code-file-editor')).toBeVisible()
    await expectDarkSurface(page.getByTestId('code-file-editor'), 'file editor')
    await expect(page.getByTestId('code-file-editor-statusbar')).toHaveCount(0)
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

    await expect(page.getByTestId('code-composer-add')).toBeVisible()
    const composerPlusMenu = page.getByTestId('code-composer-plus-menu')
    await expect(async () => {
      if (await composerPlusMenu.isVisible()) await page.keyboard.press('Escape')
      await expect(composerPlusMenu).toHaveCount(0)
      await page.getByTestId('code-composer-add').click()
      await expect(composerPlusMenu).toBeVisible({ timeout: 1_000 })
      await expectDarkSurface(composerPlusMenu, 'composer plus menu')
      await saveScreenshot(testInfo, 'composer-plus-menu.png', composerPlusMenu)
    }).toPass({ timeout: 30_000 })
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

    await page.getByTestId('code-composer').locator('textarea').fill('queued dark followup')
    await page.getByTestId('code-composer-send').click()
    await expect(page.getByTestId('code-pending-followup')).toBeVisible()
    await expectDarkSurface(page.getByTestId('code-pending-followup'), 'pending follow-up')
    await page.getByTestId('code-pending-followup-discard').click()
    await expect(page.getByTestId('code-pending-followup')).toBeHidden()

    await page.setViewportSize({ width: 390, height: 844 })
    await expect.poll(() => page.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
      layoutWidth: document.documentElement.clientWidth,
    }))).toEqual({ width: 390, height: 844, layoutWidth: 390 })
    await page.evaluate(() => document.body.classList.add('code-compact-layout', 'code-mobile-touch'))
    await expect(page.getByTestId('code-mobile-topbar')).toBeVisible()
    await expectDarkSurface(page.getByTestId('code-mobile-topbar'), 'mobile topbar')
    await expect(page.getByTestId('code-mobile-topbar')).toHaveCSS('background-color', 'rgb(34, 34, 34)')
    await expect(page.getByTestId('code-mobile-menu')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    await expect(page.getByTestId('code-mobile-more')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    await page.getByTestId('code-mobile-menu').click()
    await expect(page.getByTestId('code-sidebar')).toHaveCSS('background-color', 'rgb(34, 34, 34)')
    await expectProjectRowSurface(page, 'rgb(34, 34, 34)')
    await expect(page.locator('.code-files-header').first()).toHaveCSS('background-color', 'rgb(34, 34, 34)')
    await saveScreenshot(testInfo, 'mobile-shell.png', page)
  })
})
