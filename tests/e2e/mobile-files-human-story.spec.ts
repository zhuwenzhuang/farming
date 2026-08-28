import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { Locator, Page, TestInfo } from '@playwright/test'
import {
  expect,
  fileEditorPosition,
  openFarming,
  test,
} from './fixtures'

const TOUCH_PROJECTS = new Set(['iphone-human-webkit', 'android-human-chromium'])

function git(root: string, ...args: string[]) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
}

function commitFile(root: string, filePath: string, content: string, subject: string) {
  const absolutePath = path.join(root, filePath)
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true })
  fs.writeFileSync(absolutePath, content)
  git(root, 'add', filePath)
  git(root, 'commit', '-m', subject)
  return git(root, 'rev-parse', 'HEAD')
}

function requireTouchProject(testInfo: TestInfo) {
  test.skip(!TOUCH_PROJECTS.has(testInfo.project.name), 'Runs only in the mobile touch projects')
}

async function createControlAgent(page: Page, workspace: string) {
  const response = await page.request.post('/farming/api/control/agents', {
    data: { command: 'bash', workspace },
  })
  expect(response.ok()).toBeTruthy()
  const body = await response.json() as { agentId?: string }
  expect(body.agentId).toBeTruthy()
  return body.agentId as string
}

async function revealMobileSidebar(page: Page) {
  const workspace = page.getByTestId('code-workspace')
  if ((await workspace.getAttribute('class'))?.includes('sidebar-collapsed')) {
    const mobileMenu = page.getByTestId('code-mobile-menu')
    if (!await mobileMenu.isVisible()) {
      const mobileBack = page.getByTestId('code-mobile-back')
      await expect(mobileBack).toBeVisible()
      await mobileBack.tap()
      await expect(mobileMenu).toBeVisible()
    }
    await mobileMenu.tap()
  }
  await expect(page.getByTestId('code-sidebar')).toBeVisible()
}

async function projectFiles(page: Page, projectName: string) {
  await revealMobileSidebar(page)
  const project = page.getByTestId('code-project-group').filter({ hasText: projectName })
  await expect(project).toBeVisible({ timeout: 30_000 })
  const files = project.getByTestId('code-files-section')
  const toggle = files.getByRole('button', { name: 'Files', exact: true })
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.tap()
  return files
}

async function openRootFile(page: Page, projectName: string, filePath: string) {
  const files = await projectFiles(page, projectName)
  const row = files.locator(`[data-testid="code-file-row"][data-file-path="${filePath}"]`)
  await expect(row).toBeVisible()
  await row.tap()
  await expect(page.getByTestId('code-workspace')).toHaveClass(/sidebar-collapsed/)
  const activeTab = page.getByTestId('code-file-editor').getByRole('tab', { selected: true })
  await expect(activeTab).toHaveAttribute('title', filePath)
}

async function expectNoDocumentOverflow(page: Page) {
  await expect.poll(() => page.evaluate(() => ({
    innerWidth: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }))).toEqual(await page.evaluate(() => ({
    innerWidth: window.innerWidth,
    scrollWidth: window.innerWidth,
  })))
}

async function expectSurfaceInsideMain(surface: Locator) {
  const bounds = await surface.evaluate(element => {
    const rect = element.getBoundingClientRect()
    const main = document.querySelector<HTMLElement>('[data-testid="code-main"]')?.getBoundingClientRect()
    const viewport = window.visualViewport
    return {
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
      mainLeft: main?.left ?? 0,
      mainRight: main?.right ?? window.innerWidth,
      viewportTop: viewport?.offsetTop ?? 0,
      viewportBottom: (viewport?.offsetTop ?? 0) + (viewport?.height ?? window.innerHeight),
    }
  })
  expect(bounds.left).toBeGreaterThanOrEqual(bounds.mainLeft - 1)
  expect(bounds.right).toBeLessThanOrEqual(bounds.mainRight + 1)
  expect(bounds.top).toBeGreaterThanOrEqual(bounds.viewportTop - 1)
  expect(bounds.bottom).toBeLessThanOrEqual(bounds.viewportBottom + 1)
}

async function openEditorContextMenu(page: Page, lineNumber: number) {
  await expect.poll(() => page.evaluate((line) => (
    window.__farmingFileEditorTest?.revealLine(line, 1) === true
  ), lineNumber)).toBe(true)
  await expect.poll(() => fileEditorPosition(page)).toEqual({ lineNumber, column: 1 })
  const monaco = page.getByTestId('code-file-monaco')
  const box = await monaco.boundingBox()
  if (!box) throw new Error('Mobile Monaco surface has no measurable bounds')
  const position = { x: 42, y: 20 + ((lineNumber - 1) * 18) }
  await page.touchscreen.tap(box.x + position.x, box.y + position.y)
  // Playwright has no portable touch long-press API. Right-click the same
  // gutter point to exercise the native contextmenu bridge after real touch.
  await monaco.click({ button: 'right', position })
  const menu = page.getByTestId('code-editor-context-menu')
  await expect(menu).toBeVisible()
  await expectSurfaceInsideMain(menu)
  return menu
}

test.describe('mobile Files production journeys', () => {
  test('opens image, PDF, binary, and oversized text viewers through touch', {
    tag: '@iphone-human',
  }, async ({ page, workspaceRoot }, testInfo) => {
    requireTouchProject(testInfo)
    test.setTimeout(120_000)
    const workspace = path.join(workspaceRoot, 'mobile-viewer-types')
    fs.mkdirSync(workspace, { recursive: true })
    fs.writeFileSync(path.join(workspace, 'preview.png'), Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgF/2l2fLwAAAABJRU5ErkJggg==',
      'base64',
    ))
    fs.writeFileSync(path.join(workspace, 'preview.pdf'), Buffer.from(
      '%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n',
    ))
    fs.writeFileSync(path.join(workspace, 'binary.bin'), Buffer.from([0, 1, 2, 3, 0]))
    fs.writeFileSync(path.join(workspace, 'report.log'), 'large text line\n'.repeat(160_000))

    const rawPaths: string[] = []
    page.on('request', request => {
      const url = new URL(request.url())
      if (url.pathname.endsWith('/api/files/raw')) rawPaths.push(url.searchParams.get('path') ?? '')
    })

    await openFarming(page)
    await createControlAgent(page, workspace)

    const imageResponse = page.waitForResponse(response => {
      const url = new URL(response.url())
      return url.pathname.endsWith('/api/files/raw') && url.searchParams.get('path') === 'preview.png'
    })
    await openRootFile(page, 'mobile-viewer-types', 'preview.png')
    expect((await imageResponse).headers()['content-type']).toContain('image/png')
    const image = page.getByTestId('code-file-image-preview')
    await expect(image).toHaveJSProperty('naturalWidth', 1)
    await expectSurfaceInsideMain(page.getByTestId('code-file-preview-panel'))
    await expectNoDocumentOverflow(page)

    const pdfResponse = page.waitForResponse(response => {
      const url = new URL(response.url())
      return url.pathname.endsWith('/api/files/raw') && url.searchParams.get('path') === 'preview.pdf'
    })
    await openRootFile(page, 'mobile-viewer-types', 'preview.pdf')
    const loadedPdf = await pdfResponse
    expect(loadedPdf.ok()).toBe(true)
    expect(loadedPdf.headers()['content-type']).toContain('application/pdf')
    const pdf = page.getByTestId('code-file-pdf-preview')
    await expect(pdf).toBeVisible()
    await expectSurfaceInsideMain(page.getByTestId('code-file-preview-panel'))

    await openRootFile(page, 'mobile-viewer-types', 'binary.bin')
    await expect(page.getByTestId('code-file-metadata-preview-icon')).toBeVisible()
    expect(rawPaths).not.toContain('binary.bin')

    await openRootFile(page, 'mobile-viewer-types', 'report.log')
    const editor = page.getByTestId('code-file-editor')
    await expect(editor.getByTestId('code-file-large-text-alert')).toHaveText(
      'This large file is shown completely in read-only mode.',
    )
    await expect(editor.getByTestId('code-file-monaco')).toBeVisible()
    await expect.poll(() => page.evaluate(() => {
      if (!window.__farmingFileEditorTest?.revealLine(150_000)) return 0
      return window.__farmingFileEditorTest.getPosition()?.lineNumber ?? 0
    }), { timeout: 5_000 }).toBe(150_000)
    const renderedLines = await editor.locator('.code-file-monaco').locator('.view-line').count()
    expect(renderedLines).toBeGreaterThan(0)
    expect(renderedLines).toBeLessThan(100)
    await expectSurfaceInsideMain(editor)
    await expectNoDocumentOverflow(page)
  })

  test('uses touch to inspect Git History, Review, and both line-change modes', {
    tag: '@iphone-human',
  }, async ({ page, workspaceRoot }, testInfo) => {
    requireTouchProject(testInfo)
    test.setTimeout(120_000)
    const workspace = path.join(workspaceRoot, 'mobile-git-inspection')
    fs.mkdirSync(path.join(workspace, '.empty-hooks'), { recursive: true })
    git(workspace, 'init', '--quiet')
    git(workspace, 'branch', '-m', 'main')
    git(workspace, 'config', 'core.hooksPath', '.empty-hooks')
    git(workspace, 'config', 'user.email', 'mobile-files@example.test')
    git(workspace, 'config', 'user.name', 'Mobile Files')
    commitFile(workspace, 'src/App.tsx', 'first line\n', 'first app line')
    const head = commitFile(workspace, 'src/App.tsx', 'first line\nsecond line\n', 'second app line')
    fs.writeFileSync(path.join(workspace, 'src/App.tsx'), 'working first\nsecond line\n')

    await openFarming(page)
    await createControlAgent(page, workspace)
    const files = await projectFiles(page, 'mobile-git-inspection')
    const history = files.getByTestId('code-git-history-section')
    const historyToggle = history.getByRole('button', { name: 'History', exact: true })
    await expect(historyToggle).toBeVisible()
    if (await historyToggle.getAttribute('aria-expanded') !== 'true') await historyToggle.tap()

    const headEntry = history.locator(`[data-commit-id="${head}"]`)
    await expect(headEntry).toBeVisible()
    await expect(headEntry).toContainText('second app line')
    await headEntry.getByRole('button', { expanded: false }).tap()
    const details = headEntry.getByTestId('code-git-history-details')
    await expect(details.getByRole('button', { name: /src\/App\.tsx/ })).toBeVisible()
    await expectNoDocumentOverflow(page)

    const reviewButton = details.getByRole('button', { name: 'Review commit', exact: true })
    const [reviewPage] = await Promise.all([
      page.waitForEvent('popup'),
      reviewButton.tap(),
    ])
    await reviewPage.waitForURL(/\/farming\/review\?/)
    await expect(reviewPage.getByTestId('review-page')).toBeVisible()
    await expect(reviewPage.locator('[data-file-path="src/App.tsx"]')).toBeVisible()
    await expectNoDocumentOverflow(reviewPage)
    await reviewPage.close()

    const reopenedFiles = await projectFiles(page, 'mobile-git-inspection')
    const search = reopenedFiles.getByPlaceholder('Search or path:line')
    await search.tap()
    await search.fill('src/App.tsx:2')
    const results = page.getByTestId('code-file-search-results')
    await expect(results).toBeVisible()
    await results.getByRole('option').first().tap()
    await expect(page.getByTestId('code-file-monaco')).toBeVisible()
    await expect.poll(() => fileEditorPosition(page)).toEqual({ lineNumber: 2, column: 1 })

    let menu = await openEditorContextMenu(page, 2)
    const previousRevision = menu.getByRole('menuitem', { name: 'Open Line Changes with Previous Revision' })
    await expect(previousRevision, `mobile gutter menu: ${(await menu.getByRole('menuitem').allTextContents()).join(' | ')}`).toBeVisible()
    await previousRevision.tap()
    const lineChanges = page.getByTestId('code-file-line-changes-panel')
    await expect(lineChanges).toBeVisible()
    await expect(lineChanges).toContainText('second app line')
    await expect(lineChanges.locator('.code-file-line-changes-patch')).toContainText('+second line')
    await expectSurfaceInsideMain(lineChanges)
    await lineChanges.getByRole('button', { name: 'Close line changes' }).tap()

    menu = await openEditorContextMenu(page, 1)
    const workingFile = menu.getByRole('menuitem', { name: 'Open Line Changes with Working File' })
    await expect(workingFile, `mobile gutter menu: ${(await menu.getByRole('menuitem').allTextContents()).join(' | ')}`).toBeVisible()
    await workingFile.tap()
    await expect(lineChanges).toBeVisible()
    await expect(lineChanges.locator('.code-file-line-changes-patch')).toContainText('-first line')
    await expect(lineChanges.locator('.code-file-line-changes-patch')).toContainText('+working first')
    await expectSurfaceInsideMain(lineChanges)
    await expectNoDocumentOverflow(page)
  })
})
