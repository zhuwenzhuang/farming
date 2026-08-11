import fs from 'node:fs'
import path from 'node:path'
import type { Locator } from '@playwright/test'
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

    const expectedLabel = expectedStickyPaths.map(path => (
      rows.find(row => row.dataset.filePath === path)
        ?.querySelector<HTMLElement>('.code-file-name')
        ?.textContent
        ?.trim() ?? ''
    )).filter(Boolean).join('/')
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
    projectTitle: 'rgb(68, 68, 68)',
    filesHeader: 'rgb(96, 96, 96)',
    fileRow: 'rgb(74, 74, 74)',
    activeFileBackground: 'rgba(0, 0, 0, 0.055)',
    stickyRow: 'rgb(61, 61, 61)',
    openEditor: 'rgb(68, 68, 68)',
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
  for (let index = 0; index < 24; index += 1) {
    fs.mkdirSync(path.join(workspace, 'velox', `child-${String(index).padStart(2, '0')}`), { recursive: true })
  }

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
  await page.waitForTimeout(40)
  const intentionalScrollTop = await velox.evaluate(element => {
    const scroller = element.closest<HTMLElement>('.code-project-list')
    if (!scroller) return -1
    scroller.scrollTop = Math.max(0, scroller.scrollTop - 48)
    return scroller.scrollTop
  })
  await page.waitForTimeout(220)
  expect(Math.abs((await readAnchor()).scrollTop - intentionalScrollTop)).toBeLessThanOrEqual(1)

  await scrollFileRowIntoStickyRange(velox)
  let previousAnchor = await readAnchor()
  for (const expanded of ['false', 'true']) {
    await velox.click()
    await expect(velox).toHaveAttribute('aria-expanded', expanded)
    await page.waitForTimeout(600)
    const nextAnchor = await readAnchor()
    expect(Math.abs(nextAnchor.scrollTop - previousAnchor.scrollTop)).toBeLessThanOrEqual(1)
    expect(Math.abs(nextAnchor.rowTop - previousAnchor.rowTop)).toBeLessThanOrEqual(1)
    previousAnchor = nextAnchor
  }
  for (const expanded of ['false', 'true']) {
    await page.keyboard.press('Enter')
    await expect(velox).toHaveAttribute('aria-expanded', expanded)
    await page.waitForTimeout(600)
    const nextAnchor = await readAnchor()
    expect(Math.abs(nextAnchor.scrollTop - previousAnchor.scrollTop)).toBeLessThanOrEqual(1)
    expect(Math.abs(nextAnchor.rowTop - previousAnchor.rowTop)).toBeLessThanOrEqual(1)
    previousAnchor = nextAnchor
  }
  await expect.poll(() => page.evaluate(() => (
    (window as Window & { __fileTreeScrollIntoViewPaths?: string[] }).__fileTreeScrollIntoViewPaths ?? []
  ))).not.toContain('velox')
})
