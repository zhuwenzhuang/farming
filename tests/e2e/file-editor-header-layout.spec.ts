import fs from 'node:fs'
import path from 'node:path'
import {
  expect,
  openFarming,
  openNewAgentDialog,
  PLAYWRIGHT_WORKSPACE_ROOT,
  startAgentFromOpenDialog,
  test,
} from './fixtures'

function colorAlpha(value: string) {
  const match = value.match(/rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\)/)
  return match ? Number(match[1]) : value === 'transparent' ? 0 : 1
}

test('uses one italic preview tab and pins it on double click', async ({ page }) => {
  const workspaceRoot = path.join(PLAYWRIGHT_WORKSPACE_ROOT, 'editor-preview-tabs')
  fs.rmSync(workspaceRoot, { recursive: true, force: true })
  fs.mkdirSync(workspaceRoot, { recursive: true })
  fs.writeFileSync(path.join(workspaceRoot, 'one.txt'), 'one\n')
  fs.writeFileSync(path.join(workspaceRoot, 'two.txt'), 'two\n')
  fs.writeFileSync(path.join(workspaceRoot, 'three.txt'), 'three\n')

  await openFarming(page)
  await openNewAgentDialog(page)
  await startAgentFromOpenDialog(page, 'bash', workspaceRoot)

  const project = page.getByTestId('code-project-group').filter({ hasText: path.basename(workspaceRoot) })
  await expect(project).toHaveCount(1, { timeout: 30_000 })
  const files = project.getByTestId('code-files-section')
  const filesTitle = files.locator('.code-files-title').first()
  if (await filesTitle.getAttribute('aria-expanded') !== 'true') await filesTitle.click()

  const editor = page.getByTestId('code-file-editor')
  const oneRow = files.locator('[data-testid="code-file-row"][data-file-path="one.txt"]')
  const twoRow = files.locator('[data-testid="code-file-row"][data-file-path="two.txt"]')
  const threeRow = files.locator('[data-testid="code-file-row"][data-file-path="three.txt"]')

  await oneRow.click()
  const oneTab = editor.getByRole('tab').filter({ hasText: 'one.txt' })
  await expect(oneTab).toHaveAttribute('data-preview', 'true')
  await expect(oneTab.locator('.code-file-editor-tab-name')).toHaveCSS('font-style', 'italic')

  await twoRow.click()
  const twoTab = editor.getByRole('tab').filter({ hasText: 'two.txt' })
  await expect(oneTab).toHaveCount(0)
  await expect(twoTab).toHaveAttribute('data-preview', 'true')

  await twoTab.dblclick()
  await expect(twoTab).not.toHaveAttribute('data-preview', 'true')
  await expect(twoTab.locator('.code-file-editor-tab-name')).toHaveCSS('font-style', 'normal')

  await threeRow.click()
  const threeTab = editor.getByRole('tab').filter({ hasText: 'three.txt' })
  await expect(twoTab).toHaveCount(1)
  await expect(threeTab).toHaveAttribute('data-preview', 'true')

  await threeRow.dblclick()
  await expect(threeTab).not.toHaveAttribute('data-preview', 'true')
  await expect(threeTab.locator('.code-file-editor-tab-name')).toHaveCSS('font-style', 'normal')
  await expect(editor.getByRole('tab')).toHaveCount(2)
})

test('overlays right-side file actions on overflowing tabs and shows a seamless breadcrumb', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const workspaceRoot = path.join(PLAYWRIGHT_WORKSPACE_ROOT, 'editor-header-project')
  const docsDir = path.join(workspaceRoot, 'docs')
  fs.rmSync(workspaceRoot, { recursive: true, force: true })
  fs.mkdirSync(docsDir, { recursive: true })
  fs.writeFileSync(path.join(docsDir, 'report.md'), '# Report\n')
  fs.writeFileSync(path.join(docsDir, 'alpha.md'), '# Alpha\n')
  fs.writeFileSync(path.join(docsDir, 'beta.md'), '# Beta\n')

  await openFarming(page)
  await openNewAgentDialog(page)
  await startAgentFromOpenDialog(page, 'bash', workspaceRoot)

  const project = page.getByTestId('code-project-group').filter({ hasText: path.basename(workspaceRoot) })
  await expect(project).toHaveCount(1, { timeout: 30_000 })
  const projectTitle = project.getByTestId('code-project-title')
  const files = project.getByTestId('code-files-section')
  const filesTitle = files.locator('.code-files-title').first()
  if (await filesTitle.getAttribute('aria-expanded') !== 'true') await filesTitle.click()
  await expect(filesTitle).toHaveAttribute('aria-expanded', 'true')

  const docsRow = files.locator('[data-testid="code-file-row"][data-file-path="docs"]')
  await expect(docsRow).toBeVisible()
  await docsRow.click()
  const editor = page.getByTestId('code-file-editor')
  const pinMarkdownFile = async (filePath: string) => {
    const fileName = path.basename(filePath)
    await files.locator(`[data-testid="code-file-row"][data-file-path="${filePath}"]`).click()
    await expect(editor.getByRole('tab', { selected: true }).locator('.code-file-editor-tab-name')).toHaveText(fileName)
    const sourceToggle = editor.locator('.code-file-editor-action.source-preview')
    await sourceToggle.click()
    const monaco = editor.locator('.code-file-monaco')
    await expect(monaco).toBeVisible()
    const inserted = await page.evaluate(() => window.__farmingFileEditorTest?.insertText(' ') === true)
    expect(inserted).toBe(true)
    await expect(editor.getByRole('tab', { selected: true }).locator('.code-file-editor-dirty')).toBeVisible()
    await sourceToggle.click()
    await expect(editor.getByTestId('code-file-markdown-preview')).toBeVisible()
  }
  await pinMarkdownFile('docs/report.md')
  await pinMarkdownFile('docs/alpha.md')
  await pinMarkdownFile('docs/beta.md')

  const tabStrip = editor.locator('.code-file-editor-tab-strip')
  const tabNames = editor.locator('.code-file-editor-tab-name')
  await expect(tabNames).toHaveText(['report.md', 'alpha.md', 'beta.md'])
  const reportTab = editor.getByRole('tab', { name: /report\.md/ })
  const betaTab = editor.getByRole('tab', { name: /beta\.md/ })
  const betaBox = await betaTab.boundingBox()
  if (!betaBox) throw new Error('beta tab bounds are missing')
  await reportTab.dragTo(betaTab, {
    targetPosition: { x: Math.max(1, betaBox.width - 2), y: betaBox.height / 2 },
  })
  await expect(tabNames).toHaveText(['alpha.md', 'beta.md', 'report.md'])
  await expect(editor.getByRole('tab', { selected: true })).toContainText('beta.md')
  await reportTab.click()
  await expect(editor.getByRole('tab', { selected: true })).toContainText('report.md')
  const actions = editor.locator('.code-file-editor-actions')
  const breadcrumbBar = editor.locator('.code-file-editor-bar')
  await expect(breadcrumbBar).toHaveCount(0)

  await actions.locator('.diff').click()
  await expect(breadcrumbBar).toBeVisible()
  await actions.locator('.diff').click()
  await expect(breadcrumbBar).toHaveCount(0)

  await actions.locator('.markdown-split').click()
  await expect(breadcrumbBar).toBeVisible()
  await actions.locator('.markdown-split').click()
  await expect(breadcrumbBar).toHaveCount(0)

  const sourcePreview = actions.locator('.source-preview')
  await expect(sourcePreview).toHaveClass(/active/)
  await expect(sourcePreview).toHaveAttribute('aria-pressed', 'true')
  await sourcePreview.click()
  await expect(breadcrumbBar).toBeVisible()
  await expect(editor.locator('.code-file-monaco')).toBeVisible()
  await expect(sourcePreview).not.toHaveClass(/active/)
  await expect(sourcePreview).toHaveAttribute('aria-pressed', 'false')
  const wordWrap = actions.locator('.word-wrap')
  await wordWrap.click()
  await expect(wordWrap).toHaveClass(/active/)
  await expect(wordWrap).toHaveAttribute('aria-pressed', 'true')
  const breadcrumbs = editor.locator('.code-file-editor-breadcrumbs')
  await expect(actions).toHaveCount(1)
  await expect(actions).toBeVisible()
  await expect(breadcrumbs.locator('.code-file-editor-breadcrumb-name')).toHaveText([
    path.basename(workspaceRoot),
    'docs',
    'report.md',
  ])
  await expect(breadcrumbs.locator('.code-file-editor-breadcrumb-file-icon')).toBeVisible()

  const headerLayout = await editor.evaluate(element => {
    const header = element.querySelector<HTMLElement>('.code-file-editor-header')!
    const tabStrip = element.querySelector<HTMLElement>('.code-file-editor-tab-strip')!
    const actions = element.querySelector<HTMLElement>('.code-file-editor-actions')!
    const tabs = element.querySelector<HTMLElement>('.code-file-editor-tabs')!
    const activeTab = tabs.querySelector<HTMLElement>('.code-file-editor-tab.active')!
    const breadcrumbs = element.querySelector<HTMLElement>('.code-file-editor-breadcrumbs')!
    const breadcrumbBar = element.querySelector<HTMLElement>('.code-file-editor-bar')!
    const content = element.querySelector<HTMLElement>('.code-file-monaco')!
    for (let index = 0; index < 12; index += 1) {
      const overflowTab = activeTab.cloneNode(true) as HTMLElement
      overflowTab.classList.remove('active')
      overflowTab.setAttribute('aria-selected', 'false')
      overflowTab.querySelector<HTMLElement>('.code-file-editor-tab-name')!.textContent = `very-long-document-name-${index}.md`
      tabs.append(overflowTab)
    }
    tabs.append(activeTab)
    tabs.scrollLeft = tabs.scrollWidth
    const tabRect = tabStrip.getBoundingClientRect()
    const actionRect = actions.getBoundingClientRect()
    const tabsRect = tabs.getBoundingClientRect()
    const breadcrumbRect = breadcrumbs.getBoundingClientRect()
    const firstAction = actions.querySelector<HTMLElement>('.code-file-editor-action')!
    return {
      actionsInsideTabStrip: actions.parentElement === tabStrip,
      actionsAfterTabs: Boolean(tabs.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING),
      actionTop: actionRect.top,
      actionBottom: actionRect.bottom,
      actionLeft: actionRect.left,
      actionRight: actionRect.right,
      actionWidth: actionRect.width,
      tabsRight: tabsRect.right,
      tabsRightPadding: getComputedStyle(tabs).paddingRight,
      tabsOverflow: tabs.scrollWidth > tabs.clientWidth,
      tabTop: tabRect.top,
      tabBottom: tabRect.bottom,
      breadcrumbTop: breadcrumbRect.top,
      actionBorderWidth: getComputedStyle(firstAction).borderTopWidth,
      actionGap: getComputedStyle(actions).gap,
      agentToggleIsLast: actions.lastElementChild?.matches('[data-testid="code-resource-agent-toggle"]') === true,
      actionBackground: getComputedStyle(actions).backgroundColor,
      tabStripBackground: getComputedStyle(tabStrip).backgroundColor,
      tabStripBorderBottomWidth: getComputedStyle(tabStrip).borderBottomWidth,
      tabStripBorderColor: getComputedStyle(tabStrip).borderBottomColor,
      activeTabSeamColor: getComputedStyle(activeTab, '::after').backgroundColor,
      headerBorderBottomWidth: getComputedStyle(header).borderBottomWidth,
      breadcrumbBackground: getComputedStyle(breadcrumbBar).backgroundColor,
      contentBackground: getComputedStyle(content).backgroundColor,
    }
  })

  expect(headerLayout.actionsInsideTabStrip).toBe(true)
  expect(headerLayout.actionsAfterTabs).toBe(true)
  expect(headerLayout.actionTop).toBe(headerLayout.tabTop)
  expect(headerLayout.actionBottom).toBe(
    headerLayout.tabBottom - Number.parseFloat(headerLayout.tabStripBorderBottomWidth),
  )
  expect(headerLayout.actionLeft).toBeLessThan(headerLayout.tabsRight)
  expect(headerLayout.actionRight).toBeLessThanOrEqual(headerLayout.tabsRight)
  expect(Number.parseFloat(headerLayout.tabsRightPadding)).toBeGreaterThanOrEqual(headerLayout.actionWidth)
  expect(headerLayout.tabsOverflow).toBe(true)
  expect(headerLayout.breadcrumbTop).toBeGreaterThanOrEqual(headerLayout.tabBottom)
  expect(headerLayout.actionBorderWidth).toBe('0px')
  expect(headerLayout.actionGap).toBe('2px')
  expect(headerLayout.agentToggleIsLast).toBe(true)
  expect(headerLayout.actionBackground).toBe(headerLayout.tabStripBackground)
  expect(colorAlpha(headerLayout.activeTabSeamColor)).toBeLessThan(colorAlpha(headerLayout.tabStripBorderColor))
  expect(headerLayout.headerBorderBottomWidth).toBe('0px')
  expect(headerLayout.breadcrumbBackground).toBe(headerLayout.contentBackground)

  const darkBackgrounds = await page.evaluate(() => {
    document.body.dataset.appearance = 'dark'
    const breadcrumbBar = document.querySelector<HTMLElement>('.code-file-editor-bar')!
    const content = document.querySelector<HTMLElement>('.code-file-monaco')!
    return {
      breadcrumb: getComputedStyle(breadcrumbBar).backgroundColor,
      content: getComputedStyle(content).backgroundColor,
    }
  })
  expect(darkBackgrounds.breadcrumb).toBe(darkBackgrounds.content)

  const activeSelectionSurfaces = await page.evaluate(() => (
    ['light', 'dark', 'paper'] as const
  ).map(appearance => {
    document.body.dataset.appearance = appearance
    const activeTab = document.querySelector<HTMLElement>('.code-file-editor-tab.active')!
    const activeFileRow = document.querySelector<HTMLElement>('.code-file-row.active')!
    const activeAgentRow = document.querySelector<HTMLElement>('.code-agent-row.active')!
    return {
      appearance,
      activeAgentRowBackground: getComputedStyle(activeAgentRow).backgroundColor,
      activeAgentRowBorderRadius: getComputedStyle(activeAgentRow).borderRadius,
      activeTabBackground: getComputedStyle(activeTab).backgroundColor,
      activeFileRowBackground: getComputedStyle(activeFileRow).backgroundColor,
      activeFileRowBorderRadius: getComputedStyle(activeFileRow).borderRadius,
      activeFileRowEdgeContent: getComputedStyle(activeFileRow, '::after').content,
    }
  }))
  for (const selection of activeSelectionSurfaces) {
    expect(selection.activeAgentRowBackground, selection.appearance).toBe(selection.activeTabBackground)
    expect(selection.activeFileRowBackground, selection.appearance).toBe(selection.activeTabBackground)
    expect(selection.activeAgentRowBorderRadius, selection.appearance).toBe('8px')
    expect(selection.activeFileRowBorderRadius, selection.appearance).toBe('8px')
    expect(colorAlpha(selection.activeTabBackground), selection.appearance).toBe(1)
    expect(selection.activeFileRowEdgeContent, selection.appearance).toBe('none')
  }

  const inactiveFileRow = files.locator('[data-testid="code-file-row"][data-file-path="docs/alpha.md"]')
  const inactiveTab = editor.getByRole('tab', { name: /alpha\.md/ })
  for (const appearance of ['light', 'dark', 'paper'] as const) {
    await page.locator('body').evaluate((body, value) => { body.dataset.appearance = value }, appearance)
    const activeSurface = await editor.getByRole('tab', { selected: true }).evaluate(element => (
      getComputedStyle(element).backgroundColor
    ))
    await projectTitle.hover()
    await expect(projectTitle, `${appearance} Project hover`).toHaveCSS('background-color', activeSurface)
    await expect(projectTitle, `${appearance} Project radius`).toHaveCSS('border-radius', '8px')
    await inactiveFileRow.hover()
    await expect(inactiveFileRow, `${appearance} file hover`).toHaveCSS('background-color', activeSurface)
    await expect(inactiveFileRow, `${appearance} file radius`).toHaveCSS('border-radius', '8px')
    await inactiveTab.hover()
    await expect(inactiveTab, `${appearance} tab hover`).toHaveCSS('background-color', activeSurface)
  }
  await page.mouse.move(1000, 800)

  const compactActiveSelectionSurfaces = await page.evaluate(() => {
    document.body.classList.add('code-compact-layout')
    const surfaces = (['light', 'dark', 'paper'] as const).map(appearance => {
      document.body.dataset.appearance = appearance
      return {
        appearance,
        activeAgentRowBackground: getComputedStyle(document.querySelector<HTMLElement>('.code-agent-row.active')!).backgroundColor,
        activeAgentRowBorderRadius: getComputedStyle(document.querySelector<HTMLElement>('.code-agent-row.active')!).borderRadius,
        activeFileRowBackground: getComputedStyle(document.querySelector<HTMLElement>('.code-file-row.active')!).backgroundColor,
        activeFileRowBorderRadius: getComputedStyle(document.querySelector<HTMLElement>('.code-file-row.active')!).borderRadius,
        activeTabBackground: getComputedStyle(document.querySelector<HTMLElement>('.code-file-editor-tab.active')!).backgroundColor,
      }
    })
    document.body.classList.remove('code-compact-layout')
    return surfaces
  })
  for (const selection of compactActiveSelectionSurfaces) {
    expect(selection.activeAgentRowBackground, `${selection.appearance} compact`).toBe(selection.activeTabBackground)
    expect(selection.activeFileRowBackground, `${selection.appearance} compact`).toBe(selection.activeTabBackground)
    expect(selection.activeAgentRowBorderRadius, `${selection.appearance} compact`).toBe('8px')
    expect(selection.activeFileRowBorderRadius, `${selection.appearance} compact`).toBe('8px')
    expect(colorAlpha(selection.activeTabBackground), `${selection.appearance} compact`).toBe(1)
  }

  const paperHeader = await page.evaluate(() => {
    document.body.dataset.appearance = 'paper'
    const tabStrip = document.querySelector<HTMLElement>('.code-file-editor-tab-strip')!
    const tabs = document.querySelector<HTMLElement>('.code-file-editor-tabs')!
    const activeTab = document.querySelector<HTMLElement>('.code-file-editor-tab.active')!
    const inactiveTab = document.querySelector<HTMLElement>('.code-file-editor-tab:not(.active)')!
    const activeIcon = activeTab.querySelector<HTMLElement>('.code-file-editor-tab-icon')!
    const inactiveIcon = inactiveTab.querySelector<HTMLElement>('.code-file-editor-tab-icon')!
    const activeAction = document.querySelector<HTMLElement>('.code-file-editor-action.active')!
    const inactiveAction = document.querySelector<HTMLElement>('.code-file-editor-actions .code-file-editor-action:not(.active):not(:disabled)')!
    const breadcrumbBar = document.querySelector<HTMLElement>('.code-file-editor-bar')!
    const content = document.querySelector<HTMLElement>('.code-file-monaco')!
    const activeFileRow = document.querySelector<HTMLElement>('.code-file-row.active')!
    return {
      tabStripBackground: getComputedStyle(tabStrip).backgroundColor,
      tabsBackground: getComputedStyle(tabs).backgroundColor,
      activeTabBackground: getComputedStyle(activeTab).backgroundColor,
      activeTabColor: getComputedStyle(activeTab).color,
      activeIconColor: getComputedStyle(activeIcon).backgroundColor,
      inactiveTabBackground: getComputedStyle(inactiveTab).backgroundColor,
      inactiveTabColor: getComputedStyle(inactiveTab).color,
      inactiveIconColor: getComputedStyle(inactiveIcon).backgroundColor,
      activeActionBackground: getComputedStyle(activeAction).backgroundColor,
      inactiveActionBackground: getComputedStyle(inactiveAction).backgroundColor,
      activeTabBorderRadius: getComputedStyle(activeTab).borderRadius,
      activeTabBoxShadow: getComputedStyle(activeTab).boxShadow,
      activeTabSeamColor: getComputedStyle(activeTab, '::after').backgroundColor,
      activeFileRowBackground: getComputedStyle(activeFileRow).backgroundColor,
      activeFileRowEdgeContent: getComputedStyle(activeFileRow, '::after').content,
      breadcrumbBackground: getComputedStyle(breadcrumbBar).backgroundColor,
      contentBackground: getComputedStyle(content).backgroundColor,
    }
  })
  expect(paperHeader.tabStripBackground).toBe(paperHeader.contentBackground)
  expect(colorAlpha(paperHeader.tabsBackground)).toBe(0)
  expect(paperHeader.breadcrumbBackground).toBe(paperHeader.contentBackground)
  expect(colorAlpha(paperHeader.inactiveTabBackground)).toBe(0)
  expect(paperHeader.activeTabBackground).not.toBe(paperHeader.tabStripBackground)
  expect(paperHeader.activeFileRowBackground).toBe(paperHeader.activeTabBackground)
  expect(paperHeader.activeFileRowEdgeContent).toBe('none')
  expect(paperHeader.activeIconColor).toBe(paperHeader.activeTabColor)
  expect(paperHeader.inactiveIconColor).toBe(paperHeader.inactiveTabColor)
  expect(colorAlpha(paperHeader.inactiveActionBackground)).toBe(0)
  expect(colorAlpha(paperHeader.activeActionBackground)).toBeGreaterThan(0)
  expect(paperHeader.activeTabBorderRadius).toBe('0px')
  expect(paperHeader.activeTabBoxShadow).toBe('none')
  expect(colorAlpha(paperHeader.activeTabSeamColor)).toBe(0)
  const paperHeaderScreenshot = testInfo.outputPath('paper-file-editor-header.png')
  await editor.screenshot({ path: paperHeaderScreenshot })
  await testInfo.attach('paper-file-editor-header', {
    path: paperHeaderScreenshot,
    contentType: 'image/png',
  })
})
