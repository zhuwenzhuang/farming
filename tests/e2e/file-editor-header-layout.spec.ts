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

test('overlays right-side file actions on overflowing tabs and shows a seamless breadcrumb', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const workspaceRoot = path.join(PLAYWRIGHT_WORKSPACE_ROOT, 'editor-header-project')
  const docsDir = path.join(workspaceRoot, 'docs')
  fs.rmSync(workspaceRoot, { recursive: true, force: true })
  fs.mkdirSync(docsDir, { recursive: true })
  fs.writeFileSync(path.join(docsDir, 'report.md'), '# Report\n')

  await openFarming(page)
  await openNewAgentDialog(page)
  await startAgentFromOpenDialog(page, 'bash', workspaceRoot)

  const project = page.getByTestId('code-project-group').filter({ hasText: path.basename(workspaceRoot) })
  await expect(project).toHaveCount(1, { timeout: 30_000 })
  const files = project.getByTestId('code-files-section')
  const filesTitle = files.locator('.code-files-title').first()
  if (await filesTitle.getAttribute('aria-expanded') !== 'true') await filesTitle.click()
  await expect(filesTitle).toHaveAttribute('aria-expanded', 'true')

  const docsRow = files.locator('[data-testid="code-file-row"][data-file-path="docs"]')
  await expect(docsRow).toBeVisible()
  await docsRow.click()
  await files.locator('[data-testid="code-file-row"][data-file-path="docs/report.md"]').click()

  const editor = page.getByTestId('code-file-editor')
  const tabStrip = editor.locator('.code-file-editor-tab-strip')
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

  await actions.locator('.source-preview').click()
  await expect(breadcrumbBar).toBeVisible()
  await expect(editor.locator('.code-file-monaco')).toBeVisible()
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
    const activeTab = tabs.querySelector<HTMLElement>('.code-file-editor-tab')!
    const breadcrumbs = element.querySelector<HTMLElement>('.code-file-editor-breadcrumbs')!
    const breadcrumbBar = element.querySelector<HTMLElement>('.code-file-editor-bar')!
    const content = element.querySelector<HTMLElement>('.code-file-monaco')!
    for (let index = 0; index < 12; index += 1) {
      const overflowTab = activeTab.cloneNode(true) as HTMLElement
      overflowTab.querySelector<HTMLElement>('.code-file-editor-tab-name')!.textContent = `very-long-document-name-${index}.md`
      tabs.append(overflowTab)
    }
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
      tabsRight: tabsRect.right,
      tabsOverflow: tabs.scrollWidth > tabs.clientWidth,
      tabTop: tabRect.top,
      tabBottom: tabRect.bottom,
      breadcrumbTop: breadcrumbRect.top,
      actionBorderWidth: getComputedStyle(firstAction).borderTopWidth,
      actionGap: getComputedStyle(actions).gap,
      actionBackground: getComputedStyle(actions).backgroundColor,
      tabStripBackground: getComputedStyle(tabStrip).backgroundColor,
      headerBorderBottomWidth: getComputedStyle(header).borderBottomWidth,
      breadcrumbBackground: getComputedStyle(breadcrumbBar).backgroundColor,
      contentBackground: getComputedStyle(content).backgroundColor,
    }
  })

  expect(headerLayout.actionsInsideTabStrip).toBe(true)
  expect(headerLayout.actionsAfterTabs).toBe(true)
  expect(headerLayout.actionTop).toBeGreaterThanOrEqual(headerLayout.tabTop)
  expect(headerLayout.actionBottom).toBeLessThanOrEqual(headerLayout.tabBottom)
  expect(headerLayout.actionLeft).toBeLessThan(headerLayout.tabsRight)
  expect(headerLayout.actionRight).toBeLessThanOrEqual(headerLayout.tabsRight)
  expect(headerLayout.tabsOverflow).toBe(true)
  expect(headerLayout.breadcrumbTop).toBeGreaterThanOrEqual(headerLayout.tabBottom)
  expect(headerLayout.actionBorderWidth).toBe('0px')
  expect(headerLayout.actionGap).toBe('2px')
  expect(headerLayout.actionBackground).toBe(headerLayout.tabStripBackground)
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
})
