import fs from 'node:fs'
import path from 'node:path'
import {
  expect,
  getAgentIdFromRow,
  getAgentRowIds,
  openFarming,
  openNewAgentDialog,
  selectAgent,
  startAgentFromOpenDialog,
  terminalRows,
  test,
} from './fixtures'

type ScenarioRunner = (name: string, fn: () => Promise<void>) => Promise<void>

async function createControlAgent(page: import('@playwright/test').Page, command: string, workspace: string) {
  const response = await page.request.post('/farming/api/control/agents', {
    data: { command, workspace },
  })
  expect(response.ok()).toBeTruthy()
  const data = await response.json() as { agentId?: string }
  expect(data.agentId).toBeTruthy()
  return data.agentId as string
}

async function selectAgentById(page: import('@playwright/test').Page, agentId: string) {
  const row = page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
  await expect(row).toBeVisible({ timeout: 30_000 })
  await row.click()
  await expect(row).toHaveClass(/active/)
}

async function expectNoDocumentOverflow(page: import('@playwright/test').Page) {
  await expect.poll(async () => page.evaluate(() => ({
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    overflowsX: document.documentElement.scrollWidth > window.innerWidth + 2,
    overflowsY: document.documentElement.scrollHeight > window.innerHeight + 2,
  }))).toEqual({
    scrollX: 0,
    scrollY: 0,
    overflowsX: false,
    overflowsY: false,
  })
}

async function expectNoInlineOverflow(locator: import('@playwright/test').Locator) {
  const metrics = await locator.evaluate(element => {
    const target = element as HTMLElement
    return {
      horizontal: target.scrollWidth <= target.clientWidth + 2,
      vertical: target.scrollHeight <= target.clientHeight + 2,
    }
  })
  expect(metrics.horizontal).toBe(true)
  expect(metrics.vertical).toBe(true)
}

async function expectMenuFitsViewport(page: import('@playwright/test').Page, testId: string) {
  const metrics = await page.getByTestId(testId).evaluate(element => {
    const rect = (element as HTMLElement).getBoundingClientRect()
    return {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      width: window.innerWidth,
      height: window.innerHeight,
    }
  })
  expect(metrics.left).toBeGreaterThanOrEqual(0)
  expect(metrics.top).toBeGreaterThanOrEqual(0)
  expect(metrics.right).toBeLessThanOrEqual(metrics.width + 1)
  expect(metrics.bottom).toBeLessThanOrEqual(metrics.height + 1)
}

async function revealMobileSidebar(page: import('@playwright/test').Page) {
  const workspace = page.getByTestId('code-workspace')
  if ((await workspace.getAttribute('class'))?.includes('sidebar-collapsed')) {
    await page.getByTestId('code-mobile-menu').click()
  }
  await expect(page.getByTestId('code-sidebar')).toBeVisible()
}

async function hideMobileSidebar(page: import('@playwright/test').Page) {
  const workspace = page.getByTestId('code-workspace')
  if ((await workspace.getAttribute('class'))?.includes('sidebar-collapsed')) return
  const sidebarBox = await page.getByTestId('code-sidebar').boundingBox()
  const backdropBox = await page.getByTestId('code-mobile-sidebar-backdrop').boundingBox()
  if (!sidebarBox || !backdropBox) throw new Error('Mobile sidebar or backdrop is missing')
  const backdropRight = backdropBox.x + backdropBox.width
  const sidebarRight = sidebarBox.x + sidebarBox.width
  await page.mouse.click(Math.min(backdropRight - 6, sidebarRight + 14), backdropBox.y + 80)
  await expect(workspace).toHaveClass(/sidebar-collapsed/)
}

async function startMobileAgentFromOpenDialog(page: import('@playwright/test').Page, name: string, workspace: string) {
  const previousPaneIds = new Set(await page.getByTestId('code-terminal-pane').evaluateAll(panes => panes
    .map(pane => pane.getAttribute('data-agent-id'))
    .filter((id): id is string => Boolean(id))))
  await selectAgent(page, name)
  await page.getByTestId('workspace-input').fill(workspace)
  await page.getByTestId('workspace-start').click()
  await expect(page.getByTestId('input-dialog')).toBeHidden({ timeout: 30_000 })
  await expect.poll(async () => {
    const ids = await page.getByTestId('code-terminal-pane').evaluateAll(panes => panes
      .map(pane => pane.getAttribute('data-agent-id'))
      .filter((id): id is string => Boolean(id)))
    return ids.find(id => !previousPaneIds.has(id)) ?? ''
  }, { timeout: 30_000 }).not.toBe('')
  const agentId = (await page.getByTestId('code-terminal-pane').evaluateAll(panes => panes
    .map(pane => pane.getAttribute('data-agent-id'))
    .filter((id): id is string => Boolean(id))))
    .find(id => !previousPaneIds.has(id))
  if (!agentId) throw new Error('New mobile terminal pane is missing after launch')
  await expect(page.locator(`[data-testid="code-terminal-pane"][data-agent-id="${agentId}"]`)).toBeVisible({ timeout: 30_000 })
  return agentId
}

async function terminalText(page: import('@playwright/test').Page, agentId: string) {
  return (await terminalRows(page, agentId, 40)).join('\n')
}

test.describe('additional Farming Code user scenarios', () => {
  test('covers 31 additional desktop user-facing UI scenarios', async ({ page, workspaceRoot }) => {
    const checked: string[] = []
    const scenario: ScenarioRunner = async (name, fn) => {
      await test.step(`${String(checked.length + 1).padStart(2, '0')} ${name}`, async () => {
        await fn()
        checked.push(name)
      })
    }

    const projectDir = path.join(workspaceRoot, 'desktop-project')
    const historyWorkspace = path.resolve('.tmp', `additional-history-${process.pid}`)
    const suggestionParent = path.join(workspaceRoot, 'workspace-picks')
    const suggestedWorkspace = path.join(suggestionParent, 'picked-project')
    fs.mkdirSync(projectDir, { recursive: true })
    fs.mkdirSync(historyWorkspace, { recursive: true })
    fs.mkdirSync(suggestedWorkspace, { recursive: true })
    fs.writeFileSync(path.join(projectDir, 'README.md'), '# Desktop scenario\n')
    const attachmentPath = path.join(workspaceRoot, 'context-note.txt')
    fs.writeFileSync(attachmentPath, 'attached context line\n')
    const longAttachmentPath = path.join(workspaceRoot, 'a-very-long-context-filename-that-should-stay-readable-in-the-composer.txt')
    fs.writeFileSync(longAttachmentPath, 'long attachment context\n')
    const imageAttachmentPath = path.join(workspaceRoot, 'tiny-context.png')
    fs.writeFileSync(imageAttachmentPath, Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lYt98QAAAABJRU5ErkJggg==',
      'base64',
    ))

    let installRequests = 0
    await page.route('**/farming/api/update/install', async route => {
      installRequests += 1
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          update: {
            current: { releaseVersion: '2.0.6', packageVersion: '2.0.6' },
            latest: { version: '2.0.7', assetName: 'farming-2.0.7.tar.gz' },
            available: true,
            installable: true,
            blockingAgents: [],
            state: { phase: 'installing' },
          },
        }),
      })
    })
    await page.route('**/farming/api/update', async route => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          update: {
            current: { releaseVersion: '2.0.6', packageVersion: '2.0.6' },
            latest: { version: '2.0.7', assetName: 'farming-2.0.7.tar.gz' },
            available: true,
            installable: true,
            blockingAgents: [],
            state: { phase: 'idle' },
          },
        }),
      })
    })

    await openFarming(page)
    let bashAgentId = ''
    let codexAgentId = ''

    await scenario('empty workspace is stable and does not scroll the page', async () => {
      await expect(page.getByTestId('code-empty-workspace')).toBeVisible()
      await expect(page.getByTestId('code-composer').locator('textarea')).toBeDisabled()
      await expectNoDocumentOverflow(page)
    })

    await scenario('start dialog opens from the empty state and closes with Escape', async () => {
      await page.getByTestId('code-empty-workspace').getByRole('button', { name: 'New Agent' }).click()
      await expect(page.getByTestId('input-dialog')).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(page.getByTestId('input-dialog')).toBeHidden()
    })

    await scenario('agent picker keeps keyboard focus and wraps between options', async () => {
      await openNewAgentDialog(page)
      await expect(page.getByTestId('agent-list-status')).toBeHidden({ timeout: 30_000 })
      await expect(page.getByTestId('agent-option-codex')).toBeFocused()
      await page.keyboard.press('End')
      await expect(page.getByTestId('agent-option-zsh')).toBeFocused()
      await page.keyboard.press('ArrowDown')
      await expect(page.getByTestId('agent-option-codex')).toBeFocused()
    })

    await scenario('workspace path suggestions can be accepted without changing page layout', async () => {
      await page.getByTestId('agent-option-bash').click()
      await expect(page.getByTestId('workspace-step')).toBeVisible()
      await page.getByTestId('workspace-input').fill(`${suggestionParent}${path.sep}pi`)
      await expect(page.getByTestId('workspace-path-suggestions')).toBeVisible()
      await page.getByTestId('workspace-input').press('Tab')
      await expect(page.getByTestId('workspace-input')).toHaveValue(`${suggestedWorkspace}${path.sep}`)
      await expectNoDocumentOverflow(page)
    })

    await scenario('Back returns to agent picker without losing dialog state', async () => {
      await page.getByTestId('workspace-back').click()
      await expect(page.getByTestId('agent-option-bash')).toBeVisible()
      await expect(page.getByTestId('workspace-step')).toHaveCount(0)
    })

    await scenario('starting bash from a fast typed workspace uses the typed value', async () => {
      await page.getByTestId('agent-option-bash').click()
      await page.getByTestId('workspace-input').fill(projectDir)
      await page.getByTestId('workspace-start').click()
      await expect(page.getByTestId('input-dialog')).toBeHidden({ timeout: 30_000 })
      const { agentId } = await getAgentIdFromRow(page)
      bashAgentId = agentId
      await expect.poll(async () => terminalText(page, agentId)).toContain(path.basename(projectDir))
    })

    await scenario('New Agent can pick an existing recent workspace history entry', async () => {
      await page.request.post('/farming/api/settings', {
        data: { workspaceHistory: [historyWorkspace] },
      })
      await openNewAgentDialog(page)
      await page.getByTestId('agent-option-bash').click()
      await expect(page.getByTestId('workspace-history')).toBeVisible()
      await expect(page.getByTestId('workspace-history')).toContainText(path.basename(historyWorkspace))
      await page.getByTestId('workspace-history-item').first().click()
      await expect(page.getByTestId('workspace-input')).toHaveValue(historyWorkspace)
      await page.getByTestId('input-dialog-close').click()
    })

    await scenario('creating a Codex agent in the same workspace keeps one readable project group', async () => {
      codexAgentId = await createControlAgent(page, 'codex', projectDir)
      await expect(page.locator(`[data-testid="code-agent-row"][data-agent-id="${codexAgentId}"]`)).toBeVisible({ timeout: 30_000 })
      const project = page.getByTestId('code-project-group').filter({ hasText: path.basename(projectDir) })
      await expect(project).toHaveCount(1)
      await expect(project.getByTestId('code-agent-row')).toHaveCount(2)
      await expectNoDocumentOverflow(page)
    })

    await scenario('project sidebar keeps agent rows, Open Editors, and Files as stable sections', async () => {
      const project = page.getByTestId('code-project-group').filter({ hasText: path.basename(projectDir) })
      const agentsSection = project.getByTestId('code-agents-section')
      const filesSection = project.getByTestId('code-files-section')
      await expect(agentsSection).toBeVisible()
      await expect(agentsSection.locator('.code-agents-header, .code-agents-title')).toHaveCount(0)
      await expect(agentsSection.locator(':scope > .code-agent-list')).toBeVisible()
      await expect(filesSection).toBeVisible()
      await expect(project.getByTestId('code-open-editors')).toHaveCount(0)

      const agentOrder = await project.getByTestId('code-agent-row').evaluateAll(rows =>
        rows.map(row => (row as HTMLElement).dataset.agentId || '')
      )
      await selectAgentById(page, codexAgentId)
      await selectAgentById(page, bashAgentId)
      await expect.poll(async () => project.getByTestId('code-agent-row').evaluateAll(rows =>
        rows.map(row => (row as HTMLElement).dataset.agentId || '')
      )).toEqual(agentOrder)

      const agentsBox = await agentsSection.boundingBox()
      const filesBox = await filesSection.boundingBox()
      if (!agentsBox || !filesBox) throw new Error('Project section boxes are missing')
      expect(filesBox.y).toBeGreaterThan(agentsBox.y)
      await expectNoDocumentOverflow(page)
    })

    await scenario('sidebar collapse and expand do not create body overflow', async () => {
      await page.getByTestId('code-sidebar-toggle').click()
      await expect(page.getByTestId('code-sidebar')).toHaveClass(/collapsed/)
      await expectNoDocumentOverflow(page)
      await page.getByTestId('code-sidebar-toggle').click()
      await expect(page.getByTestId('code-sidebar')).not.toHaveClass(/collapsed/)
      await expectNoDocumentOverflow(page)
    })

    await scenario('sidebar search filters the active project and clears cleanly', async () => {
      await page.getByTestId('code-nav-search').click()
      await expect(page.getByTestId('code-search-box')).toBeVisible()
      await expect(page.getByTestId('code-search-empty')).toBeVisible()
      await expect(page.getByTestId('code-search-panel').locator('.code-search-result')).toHaveCount(0)
      const searchInput = page.getByTestId('code-search-box').locator('input')
      await searchInput.fill(path.basename(projectDir))
      await expect(page.getByTestId('code-search-panel')).toBeVisible()
      await expect(page.getByTestId('code-search-result')).toHaveCount(2)
      await searchInput.fill('not-a-real-agent-name')
      await expect(page.getByTestId('code-empty-search')).toBeVisible()
      await page.getByTestId('code-search-box').getByRole('button', { name: 'Clear search' }).click()
      await expect(page.getByTestId('code-search-box')).toHaveCount(0)
    })

    await scenario('History view opens and keeps the composer disabled state coherent', async () => {
      await page.getByTestId('code-nav-history').click()
      await expect(page.getByTestId('code-history-panel')).toBeVisible()
      await expect(page.getByTestId('code-main')).toBeVisible()
      await expectNoDocumentOverflow(page)
    })

    await scenario('agent context menu focuses first action and Escape closes it', async () => {
      const row = page.getByTestId('code-agent-row').first()
      await row.click({ button: 'right' })
      const menu = page.getByTestId('code-agent-context-menu')
      await expect(menu).toBeVisible()
      await expect(menu.locator('button:not(:disabled)').first()).toBeFocused()
      await page.keyboard.press('Escape')
      await expect(menu).toHaveCount(0)
    })

    await scenario('rename dialog cancels without changing the row title', async () => {
      const row = page.getByTestId('code-agent-row').first()
      const before = ((await row.textContent()) ?? '').trim()
      await row.click({ button: 'right' })
      await page.getByRole('menuitem', { name: 'Rename Agent' }).click()
      await expect(page.getByTestId('code-rename-input')).toBeFocused()
      await page.getByTestId('code-rename-input').fill('temporary rename')
      await page.keyboard.press('Escape')
      await expect(page.getByTestId('code-rename-dialog')).toHaveCount(0)
      await expect(row).toContainText(before.split(/\s+/)[0] || 'bash')
    })

    await scenario('bash composer hides Codex-only controls and keeps send available', async () => {
      await selectAgentById(page, bashAgentId)
      await expect(page.getByTestId('code-composer-add')).toHaveCount(0)
      await expect(page.getByTestId('code-composer-approval')).toHaveCount(0)
      await expect(page.getByTestId('code-composer-model-picker')).toHaveCount(0)
      await expect(page.getByTestId('code-composer-send')).toBeVisible()
    })

    await scenario('text attachment appends readable context to the composer and can be sent', async () => {
      await selectAgentById(page, bashAgentId)
      const textarea = page.getByTestId('code-composer').locator('textarea')
      await page.getByTestId('code-composer-file-input').setInputFiles(attachmentPath)
      await expect(textarea).toContainText('attached context line')
      await textarea.fill('echo additional-desktop-context')
      await page.getByTestId('code-composer-send').click()
      await expect.poll(async () => terminalText(page, bashAgentId)).toContain('additional-desktop-context')
    })

    await scenario('upgrade badge is compact, blue, versioned, and keyboard-readable', async () => {
      const productMark = page.getByTestId('code-product-mark')
      await expect(productMark).toContainText('Farming Code')
      await expect(productMark).toContainText('DOGFOOD BETA · v2.0.6')
      await expect(productMark).toContainText('UPGRADE')
      await expect(productMark).toHaveClass(/upgrade/)
      await expect(productMark).toHaveAttribute('title', 'Upgrade to 2.0.7')
      await expectNoInlineOverflow(productMark)
    })

    await scenario('collapsed sidebar keeps product status as an icon-sized affordance', async () => {
      await page.getByTestId('code-sidebar-toggle').click()
      await expect(page.getByTestId('code-sidebar')).toHaveClass(/collapsed/)
      const metrics = await page.getByTestId('code-product-mark').evaluate(element => {
        const rect = (element as HTMLElement).getBoundingClientRect()
        const main = element.querySelector('.code-product-mark-main')
        return {
          width: rect.width,
          mainVisible: main ? getComputedStyle(main).display !== 'none' : false,
        }
      })
      expect(metrics.width).toBeLessThanOrEqual(56)
      expect(metrics.mainVisible).toBe(false)
      await page.getByTestId('code-sidebar-toggle').click()
    })

    await scenario('options menu uses concise visible language labels with full ARIA labels', async () => {
      await page.getByTestId('code-sidebar-options').click()
      const menu = page.getByTestId('code-options-menu')
      await expect(menu).toBeVisible()
      const english = menu.getByRole('menuitemradio', { name: 'Language: English' })
      const chinese = menu.getByRole('menuitemradio', { name: 'Language: 中文' })
      await expect(english).toContainText('English')
      await expect(english).not.toContainText('Language:')
      await expect(chinese).toContainText('中文')
      await expect(chinese).not.toContainText('Language:')
      await expectMenuFitsViewport(page, 'code-options-menu')
    })

    await scenario('switching language updates labels without leaving duplicate menus', async () => {
      await page.getByRole('menuitemradio', { name: 'Language: 中文' }).click()
      await expect(page.getByTestId('code-nav-search')).toContainText('搜索')
      await expect(page.getByTestId('code-options-menu')).toHaveCount(0)
      await page.getByTestId('code-sidebar-options').click()
      await page.getByRole('menuitemradio', { name: '语言：English' }).click()
      await expect(page.getByTestId('code-nav-search')).toContainText('Search')
      await expectNoDocumentOverflow(page)
    })

    await scenario('project collapse hides nested rows and expands back without layout drift', async () => {
      const project = page.getByTestId('code-project-group').filter({ hasText: path.basename(projectDir) })
      const title = project.getByTestId('code-project-title')
      await title.click()
      await expect(title).toHaveAttribute('aria-expanded', 'false')
      await expect(project.getByTestId('code-agent-row')).toHaveCount(0)
      await title.click()
      await expect(title).toHaveAttribute('aria-expanded', 'true')
      await expect(project.getByTestId('code-agent-row')).toHaveCount(2)
      await expectNoDocumentOverflow(page)
    })

    await scenario('agent context menu can copy the working directory and show one toast', async () => {
      await page.evaluate(() => {
        const target = window as unknown as { __additionalCopiedText?: string }
        target.__additionalCopiedText = ''
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: {
            writeText: async (text: string) => {
              target.__additionalCopiedText = text
            },
            readText: async () => target.__additionalCopiedText ?? '',
          },
        })
      })
      const row = page.locator(`[data-testid="code-agent-row"][data-agent-id="${bashAgentId}"]`)
      await row.click({ button: 'right' })
      await page.getByRole('menuitem', { name: /Copy working directory|复制工作目录/i }).click()
      await expect(page.getByTestId('code-copy-toast')).toHaveCount(1)
      await expect.poll(async () => page.evaluate(() => navigator.clipboard.readText())).toBe(projectDir)
    })

    await scenario('Codex composer controls fit in one concise toolbar row', async () => {
      await selectAgentById(page, codexAgentId)
      await expect(page.getByTestId('code-composer-add')).toBeVisible()
      await expect(page.getByTestId('code-composer-approval')).toBeVisible()
      await expect(page.getByTestId('code-composer-model-picker')).toBeVisible()
      await expectNoInlineOverflow(page.getByTestId('code-composer-toolbar'))
      await expectNoDocumentOverflow(page)
    })

    await scenario('approval menu has exactly one selected mode and closes with Escape', async () => {
      await page.getByTestId('code-composer-approval').click()
      const menu = page.getByTestId('code-approval-menu')
      await expect(menu).toBeVisible()
      await expect(menu.locator('[role="menuitemradio"][aria-checked="true"]')).toHaveCount(1)
      await expectMenuFitsViewport(page, 'code-approval-menu')
      await page.keyboard.press('Escape')
      await expect(menu).toHaveCount(0)
    })

    await scenario('model picker opens nested model choices inside the viewport', async () => {
      await page.getByTestId('code-composer-model-picker').click()
      await expect(page.getByTestId('code-model-menu')).toBeVisible()
      await expect(page.getByTestId('code-model-menu').locator('[role="menuitemradio"][aria-checked="true"]')).toHaveCount(1)
      await page.getByTestId('code-model-submenu-trigger').click()
      await expect(page.getByTestId('code-model-submenu')).toBeVisible()
      await expectMenuFitsViewport(page, 'code-model-submenu')
      await page.keyboard.press('Escape')
      await expect(page.getByTestId('code-model-menu')).toHaveCount(0)
    })

    await scenario('slash command filter inserts the selected Codex command once', async () => {
      const textarea = page.getByTestId('code-composer').locator('textarea')
      await textarea.fill('/st')
      await expect(page.getByTestId('code-slash-menu')).toBeVisible()
      await expect(page.getByTestId('code-slash-command-status')).toBeVisible()
      await page.getByTestId('code-slash-command-status').click()
      await expect(textarea).toHaveValue('/status ')
    })

    await scenario('Escape dismisses slash suggestions without clearing the draft', async () => {
      const textarea = page.getByTestId('code-composer').locator('textarea')
      await textarea.fill('/')
      await expect(page.getByTestId('code-slash-menu')).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(page.getByTestId('code-slash-menu')).toHaveCount(0)
      await expect(textarea).toHaveValue('/')
    })

    await scenario('long text attachment remains readable and does not overflow the composer', async () => {
      const textarea = page.getByTestId('code-composer').locator('textarea')
      await textarea.fill('')
      await page.getByTestId('code-composer-file-input').setInputFiles(longAttachmentPath)
      await expect(textarea).toContainText('long attachment context')
      await expectNoInlineOverflow(page.getByTestId('code-composer'))
    })

    await scenario('image attachment uses a compact chip and can be removed cleanly', async () => {
      await page.getByTestId('code-composer-file-input').setInputFiles(imageAttachmentPath)
      const attachment = page.getByTestId('code-composer-attachment')
      await expect(attachment).toBeVisible()
      await expectNoInlineOverflow(attachment)
      await attachment.getByRole('button', { name: /Remove / }).click()
      await expect(page.getByTestId('code-composer-attachment')).toHaveCount(0)
    })

    await scenario('multiline composer draft grows without covering the toolbar or shifting the page', async () => {
      const textarea = page.getByTestId('code-composer').locator('textarea')
      await textarea.fill(Array.from({ length: 8 }, (_, index) => `readability line ${index + 1}`).join('\n'))
      await expect(page.getByTestId('code-composer-toolbar')).toBeVisible()
      const height = await textarea.evaluate(element => (element as HTMLElement).getBoundingClientRect().height)
      expect(height).toBeLessThanOrEqual(220)
      await expectNoDocumentOverflow(page)
    })

    await scenario('clicking the upgrade badge calls the install endpoint once and stays in place', async () => {
      await page.getByTestId('code-product-mark').click()
      await expect.poll(() => installRequests).toBe(1)
      await expect(page.getByTestId('code-product-mark')).toContainText(/UPDATING|Updating/i)
      await expectNoDocumentOverflow(page)
    })

    expect(checked).toHaveLength(31)
    console.log(`additional desktop user scenarios executed ${checked.length} scenarios`)
  })

  test('covers 13 additional mobile user-facing UI scenarios', async ({ page, workspaceRoot }) => {
    const checked: string[] = []
    const scenario: ScenarioRunner = async (name, fn) => {
      await test.step(`${String(checked.length + 1).padStart(2, '0')} ${name}`, async () => {
        await fn()
        checked.push(name)
      })
    }

    const mobileWorkspace = path.join(workspaceRoot, 'mobile-ui-project')
    fs.mkdirSync(mobileWorkspace, { recursive: true })
    fs.writeFileSync(path.join(mobileWorkspace, 'README.md'), '# Mobile UI\n')
    let mobileAgentId = ''

    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'maxTouchPoints', { value: 1, configurable: true })

      class MockSpeechRecognition extends EventTarget {
        continuous = false
        interimResults = false
        lang = 'en-US'
        onresult: ((event: unknown) => void) | null = null
        onerror: (() => void) | null = null
        onend: (() => void) | null = null

        start() {
          ;(window as unknown as { __mobileMockSpeechRecognition?: MockSpeechRecognition }).__mobileMockSpeechRecognition = this
        }

        stop() {
          this.onend?.()
        }
      }

      ;(window as unknown as { SpeechRecognition?: typeof MockSpeechRecognition }).SpeechRecognition = MockSpeechRecognition
    })
    await page.setViewportSize({ width: 390, height: 844 })
    await openFarming(page)

    await scenario('mobile shell starts without document overflow', async () => {
      await expect(page.getByTestId('code-mobile-topbar')).toBeVisible()
      await expectNoDocumentOverflow(page)
    })

    await scenario('mobile options menu opens and closes without shifting the page', async () => {
      await page.getByTestId('code-mobile-more').click()
      await expect(page.getByTestId('code-options-menu')).toBeVisible()
      await expectNoDocumentOverflow(page)
      await page.keyboard.press('Escape')
      await expect(page.getByTestId('code-options-menu')).toHaveCount(0)
    })

    await scenario('mobile sidebar can be revealed and hidden predictably', async () => {
      await revealMobileSidebar(page)
      await expect(page.getByTestId('code-sidebar')).toBeVisible()
      await hideMobileSidebar(page)
      await expectNoDocumentOverflow(page)
    })

    await scenario('mobile can start a bash agent and focus the terminal at the top', async () => {
      await revealMobileSidebar(page)
      await openNewAgentDialog(page)
      mobileAgentId = await startMobileAgentFromOpenDialog(page, 'bash', mobileWorkspace)
      expect(mobileAgentId).toBeTruthy()
      await expect(page.locator(`[data-testid="code-terminal-pane"][data-agent-id="${mobileAgentId}"]`)).toBeVisible()
      await expect.poll(async () => {
        const rows = await terminalRows(page, mobileAgentId, 8)
        return rows.findIndex(row => row.trim().length > 0)
      }).toBeLessThanOrEqual(1)
      await expectNoDocumentOverflow(page)
    })

    await scenario('mobile project actions remain visible and launch below the project row', async () => {
      await revealMobileSidebar(page)
      const projectGroup = page.getByTestId('code-project-group').filter({
        has: page.locator(`[data-testid="code-agent-row"][data-agent-id="${mobileAgentId}"]`),
      }).first()
      const actions = projectGroup.locator('.code-project-title-actions')
      await expect(actions).toBeVisible()
      await expect.poll(async () => actions.evaluate(element => getComputedStyle(element as HTMLElement).opacity)).toBe('1')
      const contextButton = projectGroup.getByTestId('code-project-actions')
      await contextButton.click()
      const contextMenu = page.getByTestId('code-project-context-menu')
      await expect(contextMenu).toBeVisible()
      await expectMenuFitsViewport(page, 'code-project-context-menu')
      const contextButtonBox = await contextButton.boundingBox()
      const contextMenuBox = await contextMenu.boundingBox()
      if (!contextButtonBox || !contextMenuBox) throw new Error('Expected mobile project context menu geometry')
      expect(contextMenuBox.y).toBeGreaterThanOrEqual(contextButtonBox.y + contextButtonBox.height - 2)
      expect(Math.abs((contextMenuBox.x + contextMenuBox.width) - (contextButtonBox.x + contextButtonBox.width))).toBeLessThanOrEqual(2)
      await page.keyboard.press('Escape')
      await expect(contextMenu).toHaveCount(0)

      const launchButton = projectGroup.getByTestId('code-project-new-agent')
      await launchButton.click()
      const menu = page.getByTestId('code-project-new-agent-menu')
      await expect(menu).toBeVisible()
      await expectMenuFitsViewport(page, 'code-project-new-agent-menu')
      const launchButtonBox = await launchButton.boundingBox()
      const launchMenuBox = await menu.boundingBox()
      if (!launchButtonBox || !launchMenuBox) throw new Error('Expected mobile project launch menu geometry')
      expect(launchMenuBox.y).toBeGreaterThanOrEqual(launchButtonBox.y + launchButtonBox.height - 2)
      expect(Math.abs((launchMenuBox.x + launchMenuBox.width) - (launchButtonBox.x + launchButtonBox.width))).toBeLessThanOrEqual(2)
      await expect.poll(async () => menu.locator('button').evaluateAll(buttons => {
        const menuRect = buttons[0]?.closest('[data-testid="code-project-new-agent-menu"]')?.getBoundingClientRect()
        if (!menuRect) return 0
        return buttons.filter(button => {
          const rect = button.getBoundingClientRect()
          return rect.top < menuRect.top - 1 || rect.bottom > menuRect.bottom + 1
        }).length
      })).toBe(0)
      await page.keyboard.press('Escape')
      await expect(menu).toHaveCount(0)
      await hideMobileSidebar(page)
    })

    await scenario('mobile terminal accepts composer input after sidebar interaction', async () => {
      await hideMobileSidebar(page)
      const textarea = page.getByTestId('code-composer').locator('textarea')
      await textarea.fill('echo mobile-extra-scenario')
      const focusedComposerBox = await page.getByTestId('code-composer').evaluate(element => {
        const rect = (element as HTMLElement).getBoundingClientRect()
        return {
          bottomGap: window.innerHeight - rect.bottom,
          height: rect.height,
        }
      })
      expect(focusedComposerBox.height).toBeLessThanOrEqual(130)
      expect(focusedComposerBox.bottomGap).toBeLessThanOrEqual(24)
      const iosKeyboardComposerBox = await page.getByTestId('code-composer').evaluate(async element => {
        const root = document.documentElement
        document.body.classList.add('code-mode', 'code-mobile-touch', 'code-mobile-ios')
        element.classList.add('menu-open')
        root.style.setProperty('--app-visual-height', '420px')
        root.style.setProperty('--mobile-keyboard-offset', '520px')
        await new Promise(resolve => window.setTimeout(resolve, 220))
        const rect = (element as HTMLElement).getBoundingClientRect()
        const fakeVisualBottom = Number.parseFloat(root.style.getPropertyValue('--app-visual-height')) || 0
        return {
          bottomBeyondVisualViewport: rect.bottom - fakeVisualBottom,
          height: rect.height,
        }
      })
      expect(iosKeyboardComposerBox.height).toBeLessThanOrEqual(130)
      expect(iosKeyboardComposerBox.bottomBeyondVisualViewport).toBeGreaterThan(96)
      expect(iosKeyboardComposerBox.bottomBeyondVisualViewport).toBeLessThanOrEqual(140)
      await page.evaluate(() => {
        document.documentElement.style.setProperty('--app-visual-height', `${window.innerHeight}px`)
        document.documentElement.style.setProperty('--mobile-keyboard-offset', '0px')
        document.querySelector('[data-testid="code-composer"]')?.classList.remove('menu-open')
      })
      await expect.poll(async () => page.getByTestId('code-composer-send').evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgb(17, 17, 17)')
      await page.getByTestId('code-composer-send').click()
      await expect.poll(async () => terminalText(page, mobileAgentId)).toContain('mobile-extra-scenario')
      await expectNoDocumentOverflow(page)
    })

    await scenario('mobile composer keeps mic access and shows a recording bar', async () => {
      const textarea = page.getByTestId('code-composer').locator('textarea')
      await textarea.fill('')
      await expect(page.getByTestId('code-composer-mic')).toBeVisible()
      await page.getByTestId('code-composer-mic').click()
      const recording = page.getByTestId('code-composer-recording')
      await expect(recording).toBeVisible()
      await expect(recording.locator('.code-composer-recording-wave span')).toHaveCount(24)
      await expect(page.getByTestId('code-composer-send')).toBeVisible()
      await page.evaluate(() => {
        const instance = (window as unknown as {
          __mobileMockSpeechRecognition?: {
            onresult: ((event: unknown) => void) | null
            onend: (() => void) | null
          }
        }).__mobileMockSpeechRecognition
        instance?.onresult?.({
          resultIndex: 0,
          results: {
            length: 1,
            0: {
              isFinal: true,
              0: { transcript: 'mobile voice' },
            },
          },
        })
        instance?.onend?.()
      })
      await expect(recording).toHaveCount(0)
      await expect(textarea).toHaveValue('mobile voice')
      await textarea.fill('')
      await expectNoDocumentOverflow(page)
    })

    await scenario('mobile model and speed choices expand inside the picker panel', async () => {
      await revealMobileSidebar(page)
      await openNewAgentDialog(page)
      const codexAgentId = await startMobileAgentFromOpenDialog(page, 'codex', mobileWorkspace)
      await expect(page.locator(`[data-testid="code-terminal-pane"][data-agent-id="${codexAgentId}"]`)).toBeVisible()
      const composer = page.getByTestId('code-composer')
      const textarea = composer.locator('textarea')
      await textarea.evaluate(element => (element as HTMLTextAreaElement).blur())
      await expect(page.getByTestId('code-composer-model-picker')).toBeHidden()
      const collapsedComposerBox = await composer.evaluate(element => {
        const rect = (element as HTMLElement).getBoundingClientRect()
        return { height: rect.height }
      })
      expect(collapsedComposerBox.height).toBeLessThanOrEqual(72)
      await textarea.click()
      await expect(page.getByTestId('code-composer-model-picker')).toBeVisible()
      await page.getByTestId('code-composer-model-picker').click()
      const modelMenu = page.getByTestId('code-model-menu')
      await expect(modelMenu).toBeVisible()
      await expectMenuFitsViewport(page, 'code-model-menu')
      await page.getByTestId('code-model-submenu-trigger').click()
      await expect(page.getByTestId('code-model-submenu')).toBeVisible()
      await expectMenuFitsViewport(page, 'code-model-menu')
      await expect.poll(async () => page.getByTestId('code-model-submenu').evaluate(element => getComputedStyle(element as HTMLElement).position)).toBe('static')
      await page.getByTestId('code-speed-submenu-trigger').click()
      await expect(page.getByTestId('code-speed-submenu')).toBeVisible()
      await expectMenuFitsViewport(page, 'code-model-menu')
      await expect.poll(async () => page.getByTestId('code-speed-submenu').evaluate(element => getComputedStyle(element as HTMLElement).position)).toBe('static')
      await page.keyboard.press('Escape')
      await expect(modelMenu).toHaveCount(0)
    })

    await scenario('mobile Search and History views collapse the sidebar and preserve layout', async () => {
      await revealMobileSidebar(page)
      await page.getByTestId('code-nav-search').click()
      await expect(page.getByTestId('code-mobile-topbar')).toContainText('Search')
      await expect(page.getByTestId('code-workspace')).toHaveClass(/sidebar-collapsed/)
      await expectNoDocumentOverflow(page)
      await revealMobileSidebar(page)
      await page.getByTestId('code-nav-history').click()
      await expect(page.getByTestId('code-mobile-topbar')).toContainText('History')
      await expect(page.getByTestId('code-workspace')).toHaveClass(/sidebar-collapsed/)
      await expectNoDocumentOverflow(page)
    })

    await scenario('mobile New Agent dialog fits the viewport without nested page drift', async () => {
      await revealMobileSidebar(page)
      await openNewAgentDialog(page)
      await expect(page.getByTestId('input-dialog')).toBeVisible()
      await expectMenuFitsViewport(page, 'input-dialog')
      await page.keyboard.press('Escape')
      await expect(page.getByTestId('input-dialog')).toBeHidden()
      await expectNoDocumentOverflow(page)
    })

    await scenario('mobile search box accepts and clears a query without widening the shell', async () => {
      await revealMobileSidebar(page)
      await page.getByTestId('code-nav-search').click()
      await revealMobileSidebar(page)
      const searchInput = page.getByTestId('code-search-box').locator('input')
      await searchInput.fill('mobile-ui-project')
      await expect(page.getByTestId('code-search-box')).toBeVisible()
      await expectNoInlineOverflow(page.getByTestId('code-search-box'))
      await page.getByTestId('code-search-box').getByRole('button').click()
      await expect(page.getByTestId('code-search-box')).toHaveCount(0)
      await expectNoDocumentOverflow(page)
    })

    await scenario('mobile product mark remains readable in the revealed sidebar', async () => {
      await revealMobileSidebar(page)
      await expect(page.getByTestId('code-product-mark')).toContainText('Farming Code')
      await expectNoInlineOverflow(page.getByTestId('code-product-mark'))
      await expectNoDocumentOverflow(page)
    })

    await scenario('mobile options menu keeps language choices compact and inside the viewport', async () => {
      if (!((await page.getByTestId('code-workspace').getAttribute('class')) ?? '').includes('sidebar-collapsed')) {
        await page.mouse.click(382, 96)
        await expect(page.getByTestId('code-workspace')).toHaveClass(/sidebar-collapsed/)
      }
      await page.getByTestId('code-mobile-more').click()
      const menu = page.getByTestId('code-options-menu')
      await expect(menu).toBeVisible()
      await expect(menu.getByRole('menuitemradio', { name: 'Language: English' })).toContainText('English')
      await expectMenuFitsViewport(page, 'code-options-menu')
      await page.keyboard.press('Escape')
      await expect(menu).toHaveCount(0)
    })

    expect(checked).toHaveLength(13)
    console.log(`additional mobile user scenarios executed ${checked.length} scenarios`)
  })

  test('starts file-menu agents in the selected directory while keeping the project root', async ({ page, workspaceRoot }) => {
    const projectDir = path.join(workspaceRoot, 'file-menu-project')
    const launchDir = path.join(projectDir, 'packages')
    fs.mkdirSync(launchDir, { recursive: true })
    fs.writeFileSync(path.join(projectDir, 'README.md'), '# File menu project\n')
    fs.writeFileSync(path.join(launchDir, 'index.ts'), 'export const value = 1\n')

    await openFarming(page)
    await openNewAgentDialog(page)
    const rootAgentId = await startAgentFromOpenDialog(page, 'bash', projectDir)
    const projectGroup = page.getByTestId('code-project-group').filter({
      has: page.locator(`[data-testid="code-agent-row"][data-agent-id="${rootAgentId}"]`),
    })
    await expect(projectGroup).toHaveCount(1)

    const fileSection = projectGroup.getByTestId('code-files-section')
    const filesTitle = fileSection.locator('.code-files-title').first()
    if (await filesTitle.getAttribute('aria-expanded') !== 'true') {
      await filesTitle.click()
    }
    await expect(filesTitle).toHaveAttribute('aria-expanded', 'true')

    const directoryRow = fileSection.locator('[data-testid="code-file-row"][data-file-path="packages"]')
    await expect(directoryRow).toBeVisible()
    const beforeIds = new Set(await getAgentRowIds(page))
    await directoryRow.click({ button: 'right' })
    const fileContextMenu = page.getByTestId('code-file-context-menu')
    await expect(fileContextMenu).toBeVisible()
    await fileContextMenu.getByTestId('file-new-agent-submenu-trigger').hover()
    await expect(page.getByTestId('file-new-agent-submenu')).toBeVisible()
    await page.getByTestId('agent-launch-bash').click()

    await expect(fileContextMenu).toBeHidden({ timeout: 30_000 })
    await expect.poll(async () => {
      const ids = await getAgentRowIds(page)
      return ids.find(id => !beforeIds.has(id)) ?? ''
    }, { timeout: 30_000 }).not.toBe('')
    const launchedAgentId = (await getAgentRowIds(page)).find(id => !beforeIds.has(id))
    if (!launchedAgentId) {
      throw new Error('File-menu launched agent row is missing')
    }

    await expect(projectGroup.locator(`[data-testid="code-agent-row"][data-agent-id="${launchedAgentId}"]`)).toBeVisible()
    const controlResponse = await page.request.get('/farming/api/control/agents')
    expect(controlResponse.ok()).toBeTruthy()
    const controlState = await controlResponse.json() as {
      agents?: Array<{ id?: string; cwd?: string; projectWorkspace?: string }>
    }
    const launchedAgent = controlState.agents?.find(agent => agent.id === launchedAgentId)
    expect(launchedAgent?.cwd).toBe(launchDir)
    expect(launchedAgent?.projectWorkspace).toBe(projectDir)
  })
})
