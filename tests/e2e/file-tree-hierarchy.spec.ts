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
    const actualStickyPaths = Array.from(
      stack.querySelectorAll<HTMLElement>('.code-file-sticky-expanded-rows .code-file-sticky-row'),
    )
      .map(row => row.getAttribute('title') || '')
      .filter(Boolean)
    return actualStickyPaths.length > 0 &&
      JSON.stringify(actualStickyPaths) === JSON.stringify(expectedStickyPaths.slice(-actualStickyPaths.length))
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
  await expect.poll(() => stickyHierarchyMatchesFirstUncoveredRow(files)).toBe(true)

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
  await expect(target).toBeVisible()
  await expect.poll(() => stickyHierarchyMatchesFirstUncoveredRow(files)).toBe(true)

  await page.reload({ waitUntil: 'domcontentloaded' })
  const restoredFiles = page.getByTestId('code-files-section')
  const restoredTarget = restoredFiles.locator(`[data-testid="code-file-row"][data-file-path="${TARGET_FILE}"]`)
  await expect(restoredTarget).toBeVisible()
  await expect.poll(() => stickyHierarchyMatchesFirstUncoveredRow(restoredFiles)).toBe(true)
})
