import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { Locator, Page } from '@playwright/test'
import {
  expect,
  openFarming,
  openNewAgentDialog,
  startAgentFromOpenDialog,
  test,
} from './fixtures'

const TARGET_FILE = [
  'odps-sql',
  'odps-optimizer',
  'odps-optimizer-cbo',
  'src',
  'main',
  'java',
  'com',
  'aliyun',
  'odps',
  'lot',
  'cbo',
  'plan',
  'splitting',
  'impl',
  'meta',
  'AbstractVectorIndexDataClient.java',
].join('/')

async function stickyHierarchyMatchesFirstUncoveredRow(section: Locator) {
  return section.evaluate(element => {
    const stack = element.querySelector<HTMLElement>('[data-testid="code-file-sticky-stack"]')
    const scroller = element.closest<HTMLElement>('.code-project-list')
    const rows = Array.from(element.querySelectorAll<HTMLElement>('[data-testid="code-file-row"][data-file-path]'))
    if (!stack || !scroller || rows.length === 0) return false

    const stackBottom = stack.getBoundingClientRect().bottom
    const scrollerBottom = scroller.getBoundingClientRect().bottom
    const firstUncoveredRow = rows.find(row => {
      const rect = row.getBoundingClientRect()
      return rect.top >= stackBottom - 1 && rect.top < scrollerBottom
    })
    const firstUncoveredPath = firstUncoveredRow?.dataset.filePath
    if (!firstUncoveredPath) return false

    const rowTopByPath = new Map(rows.map(row => [
      row.dataset.filePath || '',
      row.getBoundingClientRect().top,
    ]))
    const segments = firstUncoveredPath.split('/').filter(Boolean)
    const expectedStickyPaths: string[] = []
    for (let index = 1; index < segments.length; index += 1) {
      const ancestorPath = segments.slice(0, index).join('/')
      const ancestorTop = rowTopByPath.get(ancestorPath)
      if (typeof ancestorTop === 'number' && ancestorTop < stackBottom) {
        expectedStickyPaths.push(ancestorPath)
      }
    }
    const actualStickyRows = Array.from(stack.querySelectorAll<HTMLElement>('.code-file-sticky-row'))
    if (actualStickyRows.length !== 1 || expectedStickyPaths.length === 0) return false

    const stickyRow = actualStickyRows[0]
    const expectedTarget = expectedStickyPaths[expectedStickyPaths.length - 1]
    if (stickyRow.getAttribute('title') !== expectedTarget) return false
    if (stickyRow.style.getPropertyValue('--file-depth') !== '0') return false

    const expectedLabelSegments = expectedStickyPaths.map(path => (
      rows.find(row => row.dataset.filePath === path)
        ?.querySelector<HTMLElement>('.code-file-name')
        ?.textContent
        ?.trim() ?? ''
    )).filter(Boolean).join('/').split('/').filter(Boolean)
    const expectedLabel = expectedLabelSegments.length > 3
      ? [expectedLabelSegments[0], '…', ...expectedLabelSegments.slice(-2)].join('/')
      : expectedLabelSegments.join('/')
    const actualLabel = stickyRow.querySelector<HTMLElement>('.code-file-name')?.textContent?.trim() ?? ''
    return actualLabel === expectedLabel
  })
}

async function scrollFileRowIntoStickyRange(row: Locator) {
  await row.evaluate(element => {
    const scroller = element.closest<HTMLElement>('.code-project-list')
    if (!scroller) return
    const desiredTop = scroller.getBoundingClientRect().top + scroller.clientHeight * 0.55
    scroller.scrollTop += element.getBoundingClientRect().top - desiredTop
  })
}

async function settleLayout(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  }))
}

async function stickyContextClearsPinnedAgents(section: Locator) {
  return section.evaluate(element => {
    const project = element.closest<HTMLElement>('.code-project-group')
    const agents = project?.querySelector<HTMLElement>('.code-agents-section')
    const sticky = element.querySelector<HTMLElement>('[data-testid="code-file-sticky-stack"]')
    if (!project || !agents || !sticky) return false
    const publishedHeight = Number.parseFloat(
      getComputedStyle(project).getPropertyValue('--code-agents-sticky-height')
    )
    return Math.round(publishedHeight) === Math.ceil(agents.getBoundingClientRect().height)
      && sticky.getBoundingClientRect().top >= agents.getBoundingClientRect().bottom - 1
  })
}

async function sidebarRowPalette(section: Locator) {
  return section.evaluate(element => {
    const project = element.closest<HTMLElement>('.code-project-group')
    const projectTitle = project?.querySelector<HTMLElement>('.code-project-title')
    const header = element.querySelector<HTMLElement>('.code-files-header')
    const fileRow = element.querySelector<HTMLElement>('.code-file-row.directory:not(.code-file-sticky-row):not(.ignored)')
    const activeFileRow = element.querySelector<HTMLElement>('.code-file-row.active')
    const stickyRow = element.querySelector<HTMLElement>('.code-file-sticky-row')
    const openEditor = project?.querySelector<HTMLElement>('.code-open-editor-main')
    if (!projectTitle || !header || !fileRow || !activeFileRow || !stickyRow || !openEditor) return null
    return {
      projectTitle: getComputedStyle(projectTitle).color,
      filesHeader: getComputedStyle(header).color,
      fileRow: getComputedStyle(fileRow).color,
      activeFileBackground: getComputedStyle(activeFileRow).backgroundColor,
      stickyRow: getComputedStyle(stickyRow).color,
      openEditor: getComputedStyle(openEditor).color,
    }
  })
}

function createProductionShapedJavaTree(workspace: string) {
  const cbo = path.join(
    workspace,
    'odps-sql',
    'odps-optimizer',
    'odps-optimizer-cbo',
    'src',
    'main',
    'java',
    'com',
    'aliyun',
    'odps',
    'lot',
    'cbo',
  )
  const plan = path.join(cbo, 'plan')
  const splitting = path.join(plan, 'splitting')
  const impl = path.join(splitting, 'impl')
  const meta = path.join(impl, 'meta')

  fs.mkdirSync(meta, { recursive: true })
  for (const sibling of ['pangu', 'vpc']) {
    fs.mkdirSync(path.join(impl, sibling), { recursive: true })
  }
  for (const sibling of [
    'converter',
    'cost',
    'exec',
    'expr',
    'freeride',
    'hint',
    'irc',
    'log',
    'planner',
    'profiling',
    'progressive',
    'provenance',
    'rel',
    'rex',
    'rules',
    'spool',
    'trait',
    'type',
    'udf',
    'utils',
    'validator',
    'visitor',
  ]) {
    fs.mkdirSync(path.join(cbo, sibling), { recursive: true })
  }
  for (const sibling of ['cache', 'resultcache']) {
    fs.mkdirSync(path.join(plan, sibling), { recursive: true })
  }
  fs.mkdirSync(path.join(workspace, 'odps-sql', 'odps-optimizer', 'odps-optimizer-rule'), { recursive: true })
  fs.mkdirSync(path.join(workspace, 'odps-sql', 'odps-optimizer', 'odps-optimizer-cbo', 'src', 'test'), { recursive: true })
  fs.mkdirSync(path.join(workspace, 'odps-sql', 'odps-optimizer', 'odps-optimizer-cbo', 'src', 'main', 'resources'), { recursive: true })
  fs.mkdirSync(path.join(workspace, 'odps-sql', 'odps-optimizer', 'odps-optimizer-cbo', 'src', 'main', 'java', 'org'), { recursive: true })

  fs.writeFileSync(path.join(workspace, 'README.md'), '# file tree hierarchy fixture\n')
  fs.writeFileSync(path.join(cbo, 'CboOptimizer.java'), 'class CboOptimizer {}\n')
  fs.writeFileSync(path.join(plan, 'NativeCommonTableReader.java'), 'class NativeCommonTableReader {}\n')
  fs.writeFileSync(path.join(splitting, 'SplittingUtils.java'), 'class SplittingUtils {}\n')
  for (const fileName of [
    'AbstractVectorIndexDataClient.java',
    'AnnIndexScanDataClient.java',
    'ExpandingMetaClient.java',
    'MetaCacheClient.java',
    'MetaClient.java',
    'VectorIndexRebuildDataClient.java',
  ]) {
    fs.writeFileSync(path.join(meta, fileName), `class ${fileName.replace(/\.java$/, '')} {}\n`)
  }
}

test('preserves every visible directory level across sticky scroll, collapse, refresh, and reload', async ({ page, workspaceRoot }) => {
  const workspace = path.join(workspaceRoot, 'deep-java-tree')
  createProductionShapedJavaTree(workspace)

  await openFarming(page)
  await openNewAgentDialog(page)
  await startAgentFromOpenDialog(page, 'bash', workspace)

  const files = page.getByTestId('code-files-section')
  const filesTitle = files.getByRole('button', { name: 'Files', exact: true })
  if (await filesTitle.getAttribute('aria-expanded') !== 'true') await filesTitle.click()
  const search = files.getByPlaceholder('Search or path:line')
  await search.fill(`${TARGET_FILE}:1`)
  await search.press('Enter')

  const target = files.locator(`[data-testid="code-file-row"][data-file-path="${TARGET_FILE}"]`)
  await expect(target).toBeVisible()
  await scrollFileRowIntoStickyRange(target)
  await expect.poll(() => stickyHierarchyMatchesFirstUncoveredRow(files)).toBe(true)
  await expect.poll(() => stickyContextClearsPinnedAgents(files)).toBe(true)
  const implPath = TARGET_FILE.slice(0, TARGET_FILE.indexOf('/meta/'))
  await expect(files.locator(`[data-file-path="${implPath}/meta"]`)).toHaveCount(1)
  await expect(files.locator(`[data-file-path="${implPath}/pangu"]`)).toHaveCount(1)
  await expect(files.locator(`[data-file-path="${implPath}/vpc"]`)).toHaveCount(1)
  await expect(files.getByTestId('code-file-sticky-stack').locator('.code-file-sticky-row')).toHaveCount(1)
  const openEditors = page.getByTestId('code-open-editors')
  const openEditorsTitle = openEditors.locator('.code-open-editors-title')
  if (await openEditorsTitle.getAttribute('aria-expanded') !== 'true') await openEditorsTitle.click()
  await expect.poll(() => sidebarRowPalette(files)).toEqual({
    projectTitle: 'rgb(87, 96, 106)',
    filesHeader: 'rgb(87, 96, 106)',
    fileRow: 'rgb(87, 96, 106)',
    activeFileBackground: 'rgba(31, 35, 40, 0.055)',
    stickyRow: 'rgb(87, 96, 106)',
    openEditor: 'rgb(87, 96, 106)',
  })

  const metaPath = TARGET_FILE.slice(0, TARGET_FILE.lastIndexOf('/'))
  const meta = files.locator(`[data-testid="code-file-row"][data-file-path="${metaPath}"]`)
  await expect(meta).toHaveAttribute('aria-expanded', 'true')
  await meta.click()
  await expect(meta).toHaveAttribute('aria-expanded', 'false')
  await expect(target).toHaveCount(0)
  await meta.click()
  await expect(meta).toHaveAttribute('aria-expanded', 'true')
  await expect(target).toBeVisible()

  await files.locator('.code-files-header').hover()
  await files.getByTestId('code-files-refresh').click()
  await scrollFileRowIntoStickyRange(target)
  await expect(target).toBeVisible()
  await expect.poll(() => stickyHierarchyMatchesFirstUncoveredRow(files)).toBe(true)

  await page.reload({ waitUntil: 'domcontentloaded' })
  const restoredFiles = page.getByTestId('code-files-section')
  const restoredTarget = restoredFiles.locator(`[data-testid="code-file-row"][data-file-path="${TARGET_FILE}"]`)
  await expect(restoredTarget).toBeVisible()
  await scrollFileRowIntoStickyRange(restoredTarget)
  await expect.poll(() => stickyHierarchyMatchesFirstUncoveredRow(restoredFiles)).toBe(true)
})

test('keeps compact sticky context on the real ancestor instead of a crossed sibling directory', async ({ page, workspaceRoot }) => {
  const workspace = path.join(workspaceRoot, 'sibling-directory-sticky-prefix')
  const codeDirectory = path.join(workspace, 'src', 'components', 'code')
  fs.mkdirSync(path.join(codeDirectory, 'acp'), { recursive: true })
  fs.mkdirSync(path.join(codeDirectory, 'pet'), { recursive: true })
  for (let index = 0; index < 24; index += 1) {
    fs.writeFileSync(path.join(codeDirectory, `agent-${String(index).padStart(2, '0')}.ts`), `export const value${index} = ${index}\n`)
  }

  await openFarming(page)
  await openNewAgentDialog(page)
  await startAgentFromOpenDialog(page, 'bash', workspace)

  const files = page.getByTestId('code-files-section')
  const filesTitle = files.getByRole('button', { name: 'Files', exact: true })
  if (await filesTitle.getAttribute('aria-expanded') !== 'true') await filesTitle.click()
  const targetPath = 'src/components/code/agent-23.ts'
  const search = files.getByPlaceholder('Search or path:line')
  await search.fill(`${targetPath}:1`)
  await search.press('Enter')

  const target = files.locator(`[data-testid="code-file-row"][data-file-path="${targetPath}"]`)
  await expect(target).toBeVisible()
  await scrollFileRowIntoStickyRange(target)
  const stickyRow = files.getByTestId('code-file-sticky-stack').locator('.code-file-sticky-row')
  await expect(stickyRow).toHaveAttribute('title', 'src/components/code')
  await expect(stickyRow.locator('.code-file-name')).toHaveText('src/components/code')
})

test('does not pin a collapsed root sibling above root files', async ({ page, workspaceRoot }) => {
  const workspace = path.join(workspaceRoot, 'collapsed-root-sibling')
  fs.mkdirSync(path.join(workspace, 'tests'), { recursive: true })
  fs.writeFileSync(path.join(workspace, 'tests', 'fixture.ts'), 'export const fixture = true\n')
  for (let index = 0; index < 30; index += 1) {
    fs.writeFileSync(path.join(workspace, `root-${String(index).padStart(2, '0')}.ts`), `export const value${index} = ${index}\n`)
  }

  await openFarming(page)
  await openNewAgentDialog(page)
  await startAgentFromOpenDialog(page, 'bash', workspace)

  const files = page.getByTestId('code-files-section')
  const filesTitle = files.getByRole('button', { name: 'Files', exact: true })
  if (await filesTitle.getAttribute('aria-expanded') !== 'true') await filesTitle.click()

  const testsDirectory = files.locator('[data-testid="code-file-row"][data-file-path="tests"]')
  await expect(testsDirectory).toHaveAttribute('aria-expanded', 'false')
  await scrollFileRowIntoStickyRange(files.locator('[data-testid="code-file-row"][data-file-path="root-29.ts"]'))

  await expect(files.getByTestId('code-file-sticky-stack')).toHaveCount(0)
  await expect(testsDirectory).toHaveAttribute('aria-expanded', 'false')
})

test('keeps a deeply scrolled directory anchored while pointer expansion loads its children', async ({ page, workspaceRoot }) => {
  const workspace = path.join(workspaceRoot, 'stable-pointer-directory-expansion')
  for (let index = 0; index < 120; index += 1) {
    fs.mkdirSync(path.join(workspace, `module-${String(index).padStart(3, '0')}`), { recursive: true })
  }
  for (let index = 0; index < 40; index += 1) {
    fs.mkdirSync(path.join(workspace, `zz-tail-${String(index).padStart(2, '0')}`), { recursive: true })
  }
  for (let index = 0; index < 24; index += 1) {
    fs.mkdirSync(path.join(workspace, 'velox', `child-${String(index).padStart(2, '0')}`), { recursive: true })
  }
  for (let index = 0; index < 12; index += 1) {
    fs.writeFileSync(path.join(workspace, 'velox', 'child-12', `nested-${String(index).padStart(2, '0')}.ts`), `export const nested${index} = true\n`)
  }
  fs.writeFileSync(path.join(workspace, 'velox', 'fixture.ts'), 'export const fixture = true\n')

  await openFarming(page)
  await openNewAgentDialog(page)
  await startAgentFromOpenDialog(page, 'bash', workspace)

  const files = page.getByTestId('code-files-section')
  const filesTitle = files.getByRole('button', { name: 'Files', exact: true })
  if (await filesTitle.getAttribute('aria-expanded') !== 'true') await filesTitle.click()

  const velox = files.locator('[data-testid="code-file-row"][data-file-path="velox"]')
  await scrollFileRowIntoStickyRange(velox)
  await page.evaluate(() => {
    const testWindow = window as Window & { __fileTreeScrollIntoViewPaths?: string[] }
    testWindow.__fileTreeScrollIntoViewPaths = []
    const originalScrollIntoView = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = function (...args) {
      if (this instanceof HTMLElement && this.dataset.filePath) {
        testWindow.__fileTreeScrollIntoViewPaths?.push(this.dataset.filePath)
      }
      return originalScrollIntoView.apply(this, args)
    }
  })
  const readAnchor = () => velox.evaluate(element => {
    const scroller = element.closest<HTMLElement>('.code-project-list')
    return {
      rowTop: element.getBoundingClientRect().top,
      scrollTop: scroller?.scrollTop ?? -1,
    }
  })

  await velox.click()
  await expect(velox).toHaveAttribute('aria-expanded', 'true')
  const sameDepthLabelLeft = await Promise.all([
    files.locator('[data-file-path="velox/child-00"] .code-file-name').evaluate(element => element.getBoundingClientRect().left),
    files.locator('[data-file-path="velox/fixture.ts"] .code-file-name').evaluate(element => element.getBoundingClientRect().left),
  ])
  expect(Math.abs(sameDepthLabelLeft[0] - sameDepthLabelLeft[1])).toBeLessThanOrEqual(1)
  const desktopViewport = page.viewportSize()
  await page.setViewportSize({ width: 720, height: 900 })
  await expect(page.locator('body')).toHaveClass(/code-compact-layout/)
  await page.locator('.code-sidebar').evaluate(element => element.classList.remove('collapsed'))
  const compactFileName = files.locator('[data-file-path="velox/fixture.ts"] .code-file-name')
  await expect(compactFileName).toBeVisible()
  await expect.poll(() => files.locator('[data-file-path="velox/fixture.ts"] .code-file-label')
    .evaluate(element => element.getBoundingClientRect().width)).toBeGreaterThan(100)
  expect(await compactFileName.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  const compactSameDepthLabelLeft = await Promise.all([
    files.locator('[data-file-path="velox/child-00"] .code-file-name').evaluate(element => element.getBoundingClientRect().left),
    compactFileName.evaluate(element => element.getBoundingClientRect().left),
  ])
  expect(Math.abs(compactSameDepthLabelLeft[0] - compactSameDepthLabelLeft[1])).toBeLessThanOrEqual(1)
  if (desktopViewport) await page.setViewportSize(desktopViewport)
  await expect(page.locator('body')).not.toHaveClass(/code-compact-layout/)
  await settleLayout(page)
  const intentionalScrollTop = await velox.evaluate(element => {
    const scroller = element.closest<HTMLElement>('.code-project-list')
    if (!scroller) return -1
    scroller.scrollTop = Math.max(0, scroller.scrollTop - 48)
    return scroller.scrollTop
  })
  await expect.poll(async () => Math.abs((await readAnchor()).scrollTop - intentionalScrollTop))
    .toBeLessThanOrEqual(1)

  await scrollFileRowIntoStickyRange(velox)
  let previousAnchor = await readAnchor()
  for (const expanded of ['false', 'true']) {
    await velox.click()
    await expect(velox).toHaveAttribute('aria-expanded', expanded)
    await settleLayout(page)
    const nextAnchor = await readAnchor()
    expect(Math.abs(nextAnchor.scrollTop - previousAnchor.scrollTop)).toBeLessThanOrEqual(1)
    expect(Math.abs(nextAnchor.rowTop - previousAnchor.rowTop)).toBeLessThanOrEqual(1)
    previousAnchor = nextAnchor
  }
  for (const expanded of ['false', 'true']) {
    await page.keyboard.press('Enter')
    await expect(velox).toHaveAttribute('aria-expanded', expanded)
    await settleLayout(page)
    const nextAnchor = await readAnchor()
    expect(Math.abs(nextAnchor.scrollTop - previousAnchor.scrollTop)).toBeLessThanOrEqual(1)
    expect(Math.abs(nextAnchor.rowTop - previousAnchor.rowTop)).toBeLessThanOrEqual(1)
    previousAnchor = nextAnchor
  }
  for (const expanded of ['false', 'true']) {
    await page.keyboard.press('Space')
    await expect(velox).toHaveAttribute('aria-expanded', expanded)
    await settleLayout(page)
    const nextAnchor = await readAnchor()
    expect(Math.abs(nextAnchor.scrollTop - previousAnchor.scrollTop)).toBeLessThanOrEqual(1)
    expect(Math.abs(nextAnchor.rowTop - previousAnchor.rowTop)).toBeLessThanOrEqual(1)
    previousAnchor = nextAnchor
  }
  await page.keyboard.press('ArrowLeft')
  await expect(velox).toHaveAttribute('aria-expanded', 'false')
  let nextAnchor = await readAnchor()
  expect(Math.abs(nextAnchor.scrollTop - previousAnchor.scrollTop)).toBeLessThanOrEqual(1)
  expect(Math.abs(nextAnchor.rowTop - previousAnchor.rowTop)).toBeLessThanOrEqual(1)
  previousAnchor = nextAnchor
  await page.keyboard.press('ArrowRight')
  await expect(velox).toHaveAttribute('aria-expanded', 'true')
  await settleLayout(page)
  nextAnchor = await readAnchor()
  expect(Math.abs(nextAnchor.scrollTop - previousAnchor.scrollTop)).toBeLessThanOrEqual(1)
  expect(Math.abs(nextAnchor.rowTop - previousAnchor.rowTop)).toBeLessThanOrEqual(1)
  const nestedDirectory = files.locator('[data-testid="code-file-row"][data-file-path="velox/child-12"]')
  await scrollFileRowIntoStickyRange(nestedDirectory)
  await expect(files.getByTestId('code-file-sticky-stack').locator('.code-file-sticky-row')).toHaveAttribute('title', 'velox')
  const nestedAnchor = await nestedDirectory.evaluate(element => ({
    rowTop: element.getBoundingClientRect().top,
    scrollTop: element.closest<HTMLElement>('.code-project-list')?.scrollTop ?? -1,
  }))
  await nestedDirectory.click()
  await expect(nestedDirectory).toHaveAttribute('aria-expanded', 'true')
  await settleLayout(page)
  const expandedNestedAnchor = await nestedDirectory.evaluate(element => ({
    rowTop: element.getBoundingClientRect().top,
    scrollTop: element.closest<HTMLElement>('.code-project-list')?.scrollTop ?? -1,
  }))
  expect(Math.abs(expandedNestedAnchor.scrollTop - nestedAnchor.scrollTop)).toBeLessThanOrEqual(1)
  expect(Math.abs(expandedNestedAnchor.rowTop - nestedAnchor.rowTop)).toBeLessThanOrEqual(1)
  const revealedPaths = await page.evaluate(() => (
    (window as Window & { __fileTreeScrollIntoViewPaths?: string[] }).__fileTreeScrollIntoViewPaths ?? []
  ))
  expect(revealedPaths).not.toContain('velox')
  expect(revealedPaths).not.toContain('velox/child-12')
})

test('continues first expansion through a bounded compact directory chain', async ({ page, workspaceRoot }) => {
  const workspace = path.join(workspaceRoot, 'compact-directory-first-expansion')
  const terminalDirectory = path.join(workspace, 'chain', 'level-one', 'level-two')
  fs.mkdirSync(terminalDirectory, { recursive: true })
  fs.writeFileSync(path.join(terminalDirectory, 'first.ts'), 'export const first = true\n')
  fs.writeFileSync(path.join(terminalDirectory, 'second.ts'), 'export const second = true\n')
  fs.writeFileSync(path.join(workspace, 'README.md'), '# compact directory fixture\n')
  fs.symlinkSync('chain', path.join(workspace, 'linked-chain'))
  const boundedDirectoryPaths = ['bounded']
  let boundedDirectory = path.join(workspace, boundedDirectoryPaths[0])
  for (let depth = 0; depth < 14; depth += 1) {
    boundedDirectoryPaths.push(`${boundedDirectoryPaths[boundedDirectoryPaths.length - 1]}/level-${depth}`)
    boundedDirectory = path.join(boundedDirectory, `level-${depth}`)
  }
  fs.mkdirSync(boundedDirectory, { recursive: true })
  fs.writeFileSync(path.join(boundedDirectory, 'terminal.ts'), 'export const terminal = true\n')

  const loadedDirectoryPaths: string[] = []
  page.on('request', request => {
    const requestUrl = new URL(request.url())
    if (!requestUrl.pathname.endsWith('/api/files/tree')) return
    loadedDirectoryPaths.push(requestUrl.searchParams.get('path') ?? '')
  })

  await openFarming(page)
  await openNewAgentDialog(page)
  await startAgentFromOpenDialog(page, 'bash', workspace)

  const files = page.getByTestId('code-files-section')
  const filesTitle = files.getByRole('button', { name: 'Files', exact: true })
  if (await filesTitle.getAttribute('aria-expanded') !== 'true') await filesTitle.click()

  await files.locator('[data-testid="code-file-row"][data-file-path="chain"]').click()
  const compactedDirectory = files.locator(
    '[data-testid="code-file-row"][data-file-path="chain/level-one/level-two"]'
  )
  await expect(compactedDirectory).toBeVisible()
  await expect(compactedDirectory.locator('.code-file-name')).toHaveText('chain/level-one/level-two')
  await expect(compactedDirectory).toHaveAttribute('aria-expanded', 'true')
  await expect(files.locator('[data-file-path="chain/level-one/level-two/first.ts"]')).toBeVisible()
  await expect(files.locator('[data-file-path="chain/level-one/level-two/second.ts"]')).toBeVisible()
  await expect.poll(() => Array.from(new Set(
    loadedDirectoryPaths.filter(directoryPath => directoryPath.startsWith('chain'))
  ))).toEqual(['chain', 'chain/level-one', 'chain/level-one/level-two'])

  await compactedDirectory.click()
  await expect(compactedDirectory).toHaveAttribute('aria-expanded', 'false')
  await expect(files.locator('[data-file-path="chain/level-one/level-two/first.ts"]')).toHaveCount(0)
  await expect(compactedDirectory).toHaveAttribute('aria-expanded', 'false')

  const linkedDirectory = files.locator('[data-testid="code-file-row"][data-file-path="linked-chain"]')
  await linkedDirectory.click()
  await expect(linkedDirectory).toHaveAttribute('aria-expanded', 'true')
  await expect(files.locator('[data-file-path="linked-chain/level-one"]')).toBeVisible()
  await expect.poll(() => loadedDirectoryPaths.includes('linked-chain')).toBe(true)
  expect(loadedDirectoryPaths.some(directoryPath => directoryPath.startsWith('linked-chain/'))).toBe(false)

  await files.locator('[data-testid="code-file-row"][data-file-path="bounded"]').click()
  await expect.poll(() => new Set(
    loadedDirectoryPaths.filter(directoryPath => directoryPath === 'bounded' || directoryPath.startsWith('bounded/'))
  ).size).toBe(12)
  const deepestVisiblePath = boundedDirectoryPaths[12]
  const boundedCompactedDirectory = files.locator(
    `[data-testid="code-file-row"][data-file-path="${deepestVisiblePath}"]`
  )
  await expect(boundedCompactedDirectory).toBeVisible()
  await expect(boundedCompactedDirectory).toHaveAttribute('aria-expanded', 'false')
  expect(loadedDirectoryPaths).not.toContain(deepestVisiblePath)
  await expect(files.locator(`[data-file-path="${boundedDirectoryPaths[14]}/terminal.ts"]`)).toHaveCount(0)
})

test('keeps file row slots stable for rename, links, statuses, loading, and compact layout', async ({ page, workspaceRoot }) => {
  const workspace = path.join(workspaceRoot, 'stable-file-row-slots')
  fs.mkdirSync(path.join(workspace, 'folder'), { recursive: true })
  fs.writeFileSync(path.join(workspace, 'folder', 'child.ts'), 'export const child = true\n')
  fs.writeFileSync(path.join(workspace, 'regular.ts'), 'export const regular = true\n')
  fs.writeFileSync(path.join(workspace, 'target-a.ts'), 'export const target = "a"\n')
  fs.writeFileSync(path.join(workspace, 'target-b.ts'), 'export const target = "b"\n')
  fs.symlinkSync('target-a.ts', path.join(workspace, 'linked.ts'))
  execFileSync('git', ['init', '-q'], { cwd: workspace })
  execFileSync('git', ['config', 'user.email', 'farming@example.test'], { cwd: workspace })
  execFileSync('git', ['config', 'user.name', 'Farming Test'], { cwd: workspace })
  execFileSync('git', ['add', '.'], { cwd: workspace })
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: workspace })
  fs.unlinkSync(path.join(workspace, 'linked.ts'))
  fs.symlinkSync('target-b.ts', path.join(workspace, 'linked.ts'))

  let releaseFolderLoad = () => {}
  const folderLoadGate = new Promise<void>(resolve => {
    releaseFolderLoad = resolve
  })
  await page.route('**/api/files/tree?**', async route => {
    const requestUrl = new URL(route.request().url())
    if (requestUrl.searchParams.get('path') !== 'folder') {
      await route.continue()
      return
    }
    const response = await route.fetch()
    await folderLoadGate
    await route.fulfill({ response })
  })

  await openFarming(page)
  await openNewAgentDialog(page)
  await startAgentFromOpenDialog(page, 'bash', workspace)

  const files = page.getByTestId('code-files-section')
  const filesTitle = files.getByRole('button', { name: 'Files', exact: true })
  if (await filesTitle.getAttribute('aria-expanded') !== 'true') await filesTitle.click()

  const folderRow = files.locator('[data-testid="code-file-row"][data-file-path="folder"]')
  await folderRow.click()
  await expect(folderRow).toHaveClass(/loading/)
  const loadingChevron = folderRow.locator('.code-file-chevron')
  await expect(loadingChevron).toHaveClass(/loading/)
  await expect.poll(() => loadingChevron.evaluate(element => (
    getComputedStyle(element, '::before').content
  ))).toBe('""')
  await folderRow.click()
  await expect(folderRow).toHaveAttribute('aria-expanded', 'false')
  releaseFolderLoad()
  await expect(folderRow).not.toHaveClass(/loading/)
  await expect(folderRow).toHaveAttribute('aria-expanded', 'false')

  const linkedRow = files.locator('[data-testid="code-file-row"][data-file-path="linked.ts"]')
  await expect(linkedRow.locator('.code-file-git-status')).toHaveText('M')
  const assertStableSlots = async () => {
    const geometry = await linkedRow.evaluate(element => {
      const rowRect = element.getBoundingClientRect()
      const frameRect = element.closest<HTMLElement>('.code-file-tree-row-frame')?.getBoundingClientRect()
      const label = element.querySelector('.code-file-label')
      const trailing = element.querySelector('.code-file-trailing')
      return {
        childCount: element.children.length,
        frameHeight: frameRect?.height ?? 0,
        rowHeight: rowRect.height,
        childrenInsideRow: Array.from(element.children).every(child => {
          const rect = child.getBoundingClientRect()
          return rect.top >= rowRect.top - 1 && rect.bottom <= rowRect.bottom + 1
        }),
        symbolicLinkInLabel: Boolean(label?.querySelector('.code-file-symbolic-link')),
        gitStatusInTrailing: Boolean(trailing?.querySelector('.code-file-git-status')),
      }
    })
    expect(geometry.childCount).toBe(3)
    expect(Math.abs(geometry.rowHeight - geometry.frameHeight)).toBeLessThanOrEqual(1)
    expect(geometry.childrenInsideRow).toBe(true)
    expect(geometry.symbolicLinkInLabel).toBe(true)
    expect(geometry.gitStatusInTrailing).toBe(true)
  }
  await assertStableSlots()

  const assertRenameKeepsLabelOrigin = async (row: Locator) => {
    await row.click({ button: 'right' })
    await page.getByTestId('code-file-context-menu').getByRole('menuitem', { name: 'Rename' }).click()
    const renameInput = row.getByTestId('code-file-operation-input')
    await expect(renameInput).toBeFocused()
    const renameGeometry = await row.evaluate(element => {
      const leading = element.querySelector<HTMLElement>('.code-file-chevron, .code-file-type-icon')
      const input = element.querySelector<HTMLElement>('[data-testid="code-file-operation-input"]')
      const rowStyle = getComputedStyle(element)
      const rowRect = element.getBoundingClientRect()
      const inputRect = input?.getBoundingClientRect()
      const gap = Number.parseFloat(rowStyle.columnGap) || 0
      return {
        expected: (leading?.getBoundingClientRect().right ?? 0) + gap,
        expectedRight: rowRect.right - (Number.parseFloat(rowStyle.paddingRight) || 0),
        input: inputRect?.left ?? -1,
        inputRight: inputRect?.right ?? -1,
        inputWidth: inputRect?.width ?? 0,
        rowWidth: rowRect.width,
        verticallyCentered: inputRect
          ? Math.abs((inputRect.top + inputRect.bottom) / 2 - (rowRect.top + rowRect.bottom) / 2) <= 1
          : false,
      }
    })
    expect(Math.abs(renameGeometry.input - renameGeometry.expected)).toBeLessThanOrEqual(1)
    expect(Math.abs(renameGeometry.inputRight - renameGeometry.expectedRight)).toBeLessThanOrEqual(1)
    expect(renameGeometry.inputWidth).toBeGreaterThan(renameGeometry.rowWidth * 0.6)
    expect(renameGeometry.verticallyCentered).toBe(true)
    await renameInput.press('Escape')
  }
  const regularRow = files.locator('[data-testid="code-file-row"][data-file-path="regular.ts"]')
  await assertRenameKeepsLabelOrigin(regularRow)
  await assertRenameKeepsLabelOrigin(folderRow)

  await folderRow.click()
  await expect(folderRow).toHaveAttribute('aria-expanded', 'true')
  const deepFileRow = files.locator('[data-testid="code-file-row"][data-file-path="folder/child.ts"]')
  await expect(deepFileRow).toBeVisible()
  await expect.poll(() => deepFileRow.evaluate(element => (
    Number.parseFloat(getComputedStyle(element).getPropertyValue('--file-depth'))
  ))).toBeGreaterThan(0)

  await page.evaluate(() => {
    const testWindow = window as Window & {
      __fileTreeHorizontalSamples?: Array<{
        documentLeft: number
        projectLeft: number
        projectScrollLeft: number
        treeLeft: number
      }>
      __fileTreeScrollIntoViewPaths?: string[]
    }
    testWindow.__fileTreeHorizontalSamples = []
    testWindow.__fileTreeScrollIntoViewPaths = []
    const originalScrollIntoView = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = function (...args) {
      if (this instanceof HTMLElement && this.dataset.filePath) {
        testWindow.__fileTreeScrollIntoViewPaths?.push(this.dataset.filePath)
      }
      return originalScrollIntoView.apply(this, args)
    }
    let frames = 0
    const sample = () => {
      const project = document.querySelector<HTMLElement>('.code-project-list')
      const tree = document.querySelector<HTMLElement>('.code-file-tree')
      if (project && tree) {
        testWindow.__fileTreeHorizontalSamples?.push({
          documentLeft: document.scrollingElement?.scrollLeft ?? 0,
          projectLeft: project.getBoundingClientRect().left,
          projectScrollLeft: project.scrollLeft,
          treeLeft: tree.getBoundingClientRect().left,
        })
      }
      frames += 1
      if (frames < 48) requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
  })
  await deepFileRow.click()
  await expect.poll(() => page.evaluate(() => (
    window.__farmingFileEditorTest?.getFocusEditorRequestId() ?? null
  ))).toBeGreaterThan(0)
  await expect(page.locator('.monaco-editor textarea.inputarea')).toBeFocused()
  await page.waitForTimeout(800)
  const pointerOpenStability = await page.evaluate(() => {
    const testWindow = window as Window & {
      __fileTreeHorizontalSamples?: Array<{
        documentLeft: number
        projectLeft: number
        projectScrollLeft: number
        treeLeft: number
      }>
      __fileTreeScrollIntoViewPaths?: string[]
    }
    const samples = testWindow.__fileTreeHorizontalSamples ?? []
    const spread = (values: number[]) => values.length > 0 ? Math.max(...values) - Math.min(...values) : Infinity
    return {
      calls: testWindow.__fileTreeScrollIntoViewPaths ?? [],
      documentLeft: spread(samples.map(sample => sample.documentLeft)),
      projectLeft: spread(samples.map(sample => sample.projectLeft)),
      projectScrollLeft: spread(samples.map(sample => sample.projectScrollLeft)),
      treeLeft: spread(samples.map(sample => sample.treeLeft)),
    }
  })
  expect(pointerOpenStability.calls).toEqual([])
  expect(pointerOpenStability.documentLeft).toBeLessThanOrEqual(0.5)
  expect(pointerOpenStability.projectLeft).toBeLessThanOrEqual(0.5)
  expect(pointerOpenStability.projectScrollLeft).toBeLessThanOrEqual(0.5)
  expect(pointerOpenStability.treeLeft).toBeLessThanOrEqual(0.5)
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
  await page.keyboard.insertText('replacement from editor focus')
  await expect.poll(() => page.evaluate(() => window.__farmingFileEditorTest?.getValue())).toBe('replacement from editor focus')

  let releaseSlowRead = () => {}
  let markSlowReadStarted = () => {}
  const slowReadGate = new Promise<void>(resolve => { releaseSlowRead = resolve })
  const slowReadStarted = new Promise<void>(resolve => { markSlowReadStarted = resolve })
  await page.route('**/api/files/file?**', async route => {
    const requestUrl = new URL(route.request().url())
    if (requestUrl.searchParams.get('path') !== 'target-a.ts') {
      await route.continue()
      return
    }
    const response = await route.fetch()
    markSlowReadStarted()
    await slowReadGate
    await route.fulfill({ response })
  })
  const slowFileRow = files.locator('[data-testid="code-file-row"][data-file-path="target-a.ts"]')
  const latestFileRow = files.locator('[data-testid="code-file-row"][data-file-path="target-b.ts"]')
  await slowFileRow.click()
  await slowReadStarted
  await latestFileRow.click()
  await expect(page.getByTestId('code-file-editor').getByRole('tab', { name: /target-b\.ts/ })).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('.monaco-editor textarea.inputarea')).toBeFocused()
  const latestFocusRequestId = await page.evaluate(() => window.__farmingFileEditorTest?.getFocusEditorRequestId() ?? null)
  expect(latestFocusRequestId).not.toBeNull()
  releaseSlowRead()
  await expect.poll(() => page.getByTestId('code-file-editor').getByRole('tab', { name: /target-b\.ts/ })
    .getAttribute('aria-selected')).toBe('true')
  await expect.poll(() => page.evaluate(() => window.__farmingFileEditorTest?.getFocusEditorRequestId() ?? null))
    .toBe(latestFocusRequestId)
  await expect(page.locator('.monaco-editor textarea.inputarea')).toBeFocused()
  await page.unroute('**/api/files/file?**')

  await page.setViewportSize({ width: 720, height: 900 })
  await expect(page.locator('body')).toHaveClass(/code-compact-layout/)
  await page.locator('.code-sidebar').evaluate(element => element.classList.remove('collapsed'))
  await expect(linkedRow).toBeVisible()
  await assertStableSlots()
  await assertRenameKeepsLabelOrigin(regularRow)
})
