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
const FILE_OPERATION_AUDIT_DIR = path.resolve('.tmp/file-operation-visual-audit')

function observeWorkspaceOperations(page: Page, onOperation: (operation: string, filePath: string) => void) {
  page.on('websocket', socket => {
    socket.on('framesent', ({ payload }) => {
      try {
        const message = JSON.parse(String(payload)) as {
          type?: string
          request?: { operation?: string; path?: string }
        }
        if (message.type === 'workspace-request' && message.request?.operation) {
          onOperation(message.request.operation, message.request.path || '')
        }
      } catch {
        // Ignore terminal and other non-JSON websocket frames.
      }
    })
  })
}

async function installWorkspaceRequestGate(page: Page) {
  let nextRule: {
    operation: string
    path: string
    started(): void
    wait: Promise<void>
  } | null = null
  await page.routeWebSocket(/\/farming\/ws(?:\?|$)/, socket => {
    const server = socket.connectToServer()
    socket.onMessage(async payload => {
      let message: { type?: string; request?: { operation?: string; path?: string } } | null = null
      try {
        message = JSON.parse(String(payload))
      } catch {
        // Non-JSON frames are forwarded unchanged.
      }
      const rule = nextRule
      if (
        rule
        && message?.type === 'workspace-request'
        && message.request?.operation === rule.operation
        && (message.request.path || '') === rule.path
      ) {
        nextRule = null
        rule.started()
        await rule.wait
      }
      server.send(payload)
    })
  })
  return {
    blockNext(operation: string, filePath: string) {
      if (nextRule) throw new Error('a Workspace request gate is already armed')
      let started!: () => void
      let release!: () => void
      const startedPromise = new Promise<void>(resolve => { started = resolve })
      const wait = new Promise<void>(resolve => { release = resolve })
      nextRule = { operation, path: filePath, started, wait }
      return { started: startedPromise, release }
    },
  }
}

async function captureFileOperationAudit(page: Page, name: string) {
  fs.mkdirSync(FILE_OPERATION_AUDIT_DIR, { recursive: true })
  await page.locator('.code-sidebar').screenshot({
    path: path.join(FILE_OPERATION_AUDIT_DIR, name),
    animations: 'disabled',
    scale: 'css',
  })
}

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
    const agentsRect = agents.getBoundingClientRect()
    const agentsVisibleHeight = agentsRect.height
      - Number.parseFloat(getComputedStyle(agents).paddingBottom || '0')
    return Math.round(publishedHeight) === Math.ceil(agentsVisibleHeight)
      && sticky.getBoundingClientRect().top >= agentsRect.top + agentsVisibleHeight - 1
  })
}

async function sidebarRowPalette(section: Locator) {
  return section.evaluate(element => {
    const project = element.closest<HTMLElement>('.code-project-group')
    const projectTitle = project?.querySelector<HTMLElement>('.code-project-title')
    const header = element.querySelector<HTMLElement>('.code-files-header')
    const fileRow = element.querySelector<HTMLElement>('.code-file-row.directory:not(.code-file-sticky-row):not(.ignored)')
    const activeFileFrame = element.querySelector<HTMLElement>('.code-file-tree-row-frame:has(.code-file-row.active)')
    const stickyRow = element.querySelector<HTMLElement>('.code-file-sticky-row')
    const openEditor = project?.querySelector<HTMLElement>('.code-open-editor-main')
    if (!projectTitle || !header || !fileRow || !activeFileFrame || !stickyRow || !openEditor) return null
    return {
      projectTitle: getComputedStyle(projectTitle).color,
      filesHeader: getComputedStyle(header).color,
      fileRow: getComputedStyle(fileRow).color,
      activeFileBackground: getComputedStyle(activeFileFrame).backgroundColor,
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
  const stickyResizeBaseline = await files.evaluate(element => {
    const viewport = element.querySelector<HTMLElement>('.code-file-tree-viewport')
    const tree = element.querySelector<HTMLElement>('.code-file-tree')
    const sticky = element.querySelector<HTMLElement>('[data-testid="code-file-sticky-stack"]')
    if (!viewport || !tree || !sticky) return null
    return {
      shift: Number.parseFloat(getComputedStyle(viewport).getPropertyValue('--file-context-shift')),
      stickyPath: sticky.querySelector<HTMLElement>('[data-sticky-file-path]')?.dataset.stickyFilePath ?? '',
      treeOffset: viewport.getBoundingClientRect().left - tree.getBoundingClientRect().left,
      stickyOffset: viewport.getBoundingClientRect().left - sticky.getBoundingClientRect().left,
    }
  })
  expect(stickyResizeBaseline).not.toBeNull()
  expect(stickyResizeBaseline!.shift).toBe(14)
  expect(stickyResizeBaseline!.treeOffset).toBeCloseTo(14, 0)
  expect(stickyResizeBaseline!.stickyOffset).toBeCloseTo(14, 0)

  await files.evaluate(element => {
    const testWindow = window as Window & {
      __fileTreeStickyResizeAudit?: {
        observer: MutationObserver
        removedStickyStacks: number
      }
    }
    const audit = {
      observer: null as unknown as MutationObserver,
      removedStickyStacks: 0,
    }
    audit.observer = new MutationObserver(mutations => {
      for (const mutation of mutations) {
        for (const removedNode of mutation.removedNodes) {
          if (!(removedNode instanceof HTMLElement)) continue
          if (
            removedNode.matches('[data-testid="code-file-sticky-stack"]')
            || removedNode.querySelector('[data-testid="code-file-sticky-stack"]')
          ) {
            audit.removedStickyStacks += 1
          }
        }
      }
    })
    audit.observer.observe(element, { childList: true, subtree: true })
    testWindow.__fileTreeStickyResizeAudit = audit
  })

  const sidebarResizer = page.getByTestId('code-sidebar-resizer')
  const resizerBox = await sidebarResizer.boundingBox()
  if (!resizerBox) throw new Error('Sidebar resizer must be measurable')
  const resizeY = resizerBox.y + Math.min(160, resizerBox.height / 2)
  const resizeStartX = resizerBox.x + resizerBox.width / 2
  await page.mouse.move(resizeStartX, resizeY)
  await page.mouse.down()
  const stickyResizeSamples = []
  for (const delta of [32, 64, 96, 128, 104, 80, 56, 32, 56, 80, 104, 128]) {
    await page.mouse.move(resizeStartX + delta, resizeY)
    await settleLayout(page)
    const sample = await files.evaluate(element => new Promise<{
      shift: number
      stickyPath: string
      treeOffset: number
      stickyOffset: number
    }>(resolve => requestAnimationFrame(() => {
      const viewport = element.querySelector<HTMLElement>('.code-file-tree-viewport')
      const tree = element.querySelector<HTMLElement>('.code-file-tree')
      const sticky = element.querySelector<HTMLElement>('[data-testid="code-file-sticky-stack"]')
      resolve({
        shift: viewport
          ? Number.parseFloat(getComputedStyle(viewport).getPropertyValue('--file-context-shift'))
          : Number.NaN,
        stickyPath: sticky?.querySelector<HTMLElement>('[data-sticky-file-path]')?.dataset.stickyFilePath ?? '',
        treeOffset: viewport && tree
          ? viewport.getBoundingClientRect().left - tree.getBoundingClientRect().left
          : Number.NaN,
        stickyOffset: viewport && sticky
          ? viewport.getBoundingClientRect().left - sticky.getBoundingClientRect().left
          : Number.NaN,
      })
    })))
    stickyResizeSamples.push(sample)
  }
  await page.mouse.up()
  const stickyDetachCount = await files.evaluate(() => {
    const testWindow = window as Window & {
      __fileTreeStickyResizeAudit?: {
        observer: MutationObserver
        removedStickyStacks: number
      }
    }
    const audit = testWindow.__fileTreeStickyResizeAudit
    audit?.observer.disconnect()
    delete testWindow.__fileTreeStickyResizeAudit
    return audit?.removedStickyStacks ?? -1
  })
  expect(stickyDetachCount).toBe(0)
  for (const sample of stickyResizeSamples) {
    expect(sample.shift).toBe(stickyResizeBaseline!.shift)
    expect(sample.stickyPath).toBe(stickyResizeBaseline!.stickyPath)
    expect(sample.treeOffset).toBeCloseTo(stickyResizeBaseline!.treeOffset, 1)
    expect(sample.stickyOffset).toBeCloseTo(stickyResizeBaseline!.stickyOffset, 1)
  }
  const openEditors = page.getByTestId('code-open-editors')
  const openEditorsTitle = openEditors.locator('.code-open-editors-title')
  if (await openEditorsTitle.getAttribute('aria-expanded') !== 'true') await openEditorsTitle.click()
  await expect.poll(() => sidebarRowPalette(files)).toEqual({
    projectTitle: 'rgb(87, 96, 106)',
    filesHeader: 'rgb(87, 96, 106)',
    fileRow: 'rgb(87, 96, 106)',
    activeFileBackground: 'rgb(238, 238, 236)',
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

test('restores the open editor set, preview state, and Open Editors disclosure', async ({ page, workspaceRoot }) => {
  const workspace = path.join(workspaceRoot, 'remembered-open-editors')
  fs.mkdirSync(workspace, { recursive: true })
  fs.writeFileSync(path.join(workspace, 'pinned.ts'), 'export const pinned = true\n')
  fs.writeFileSync(path.join(workspace, 'preview.ts'), 'export const preview = true\n')

  await openFarming(page)
  await openNewAgentDialog(page)
  await startAgentFromOpenDialog(page, 'bash', workspace)

  const project = page.getByTestId('code-project-group').filter({ hasText: path.basename(workspace) })
  const files = project.getByTestId('code-files-section')
  const filesTitle = files.getByRole('button', { name: 'Files', exact: true })
  if (await filesTitle.getAttribute('aria-expanded') !== 'true') await filesTitle.click()
  const pinned = files.locator('[data-testid="code-file-row"][data-file-path="pinned.ts"]')
  const preview = files.locator('[data-testid="code-file-row"][data-file-path="preview.ts"]')
  await pinned.dblclick()
  await preview.click()

  const openEditors = project.getByTestId('code-open-editors')
  const openEditorsTitle = openEditors.locator('.code-open-editors-title')
  if (await openEditorsTitle.getAttribute('aria-expanded') !== 'true') await openEditorsTitle.click()
  await expect(openEditors.getByTestId('code-open-editor-row')).toHaveCount(2)

  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(openEditors).toHaveAttribute('data-open-editor-count', '2')
  await expect(openEditorsTitle).toHaveAttribute('aria-expanded', 'true')
  await expect(openEditors.locator('[data-file-path="pinned.ts"]')).toBeVisible()
  await expect(openEditors.locator('[data-file-path="preview.ts"]')).toBeVisible()
  await expect(page.locator('.code-file-editor-tab[title="preview.ts"]')).toHaveAttribute('data-preview', 'true')
})

test('keeps the sticky Files seam opaque over scrolled file rows', async ({ page, workspaceRoot }) => {
  const workspace = path.join(workspaceRoot, 'opaque-files-sticky-seam')
  fs.mkdirSync(workspace, { recursive: true })
  for (let index = 0; index < 40; index += 1) {
    fs.writeFileSync(path.join(workspace, `file-${String(index).padStart(2, '0')}.ts`), `export const value = ${index}\n`)
  }

  await openFarming(page)
  await openNewAgentDialog(page)
  await startAgentFromOpenDialog(page, 'bash', workspace)

  const project = page.getByTestId('code-project-group').filter({
    has: page.locator('[data-agent-id]'),
  }).first()
  const files = project.getByTestId('code-files-section')
  const filesTitle = files.getByRole('button', { name: 'Files', exact: true })
  if (await filesTitle.getAttribute('aria-expanded') !== 'true') await filesTitle.click()
  const search = files.getByPlaceholder('Search or path:line')
  await search.fill('file-39.ts:1')
  await search.press('Enter')

  const openEditorsTitle = project.locator('.code-open-editors-title')
  await expect(openEditorsTitle).toBeVisible()
  if (await openEditorsTitle.getAttribute('aria-expanded') !== 'false') await openEditorsTitle.click()

  await project.evaluate(element => {
    const scroller = element.closest<HTMLElement>('.code-project-list')
    if (scroller) scroller.scrollTop = scroller.scrollHeight
  })
  await settleLayout(page)

  await expect.poll(() => project.evaluate(element => {
    const filesHeader = element.querySelector<HTMLElement>('.code-files-header')
    if (!filesHeader) return null
    const headerBox = filesHeader.getBoundingClientRect()
    const target = document.elementFromPoint(headerBox.left + 40, headerBox.top - 1)
    return {
      coveredFileRow: Boolean(target?.closest('[data-testid="code-file-row"]')),
      seamOwner: Boolean(target?.closest('.code-files-header')),
    }
  })).toEqual({
    coveredFileRow: false,
    seamOwner: true,
  })
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
  const readSameDepthLabelLeft = () => files.evaluate(element => {
    const directoryName = element.querySelector<HTMLElement>('[data-file-path="velox/child-00"] .code-file-name')
    const fileName = element.querySelector<HTMLElement>('[data-file-path="velox/fixture.ts"] .code-file-name')
    if (!directoryName || !fileName) throw new Error('Same-depth file tree labels are missing')
    return [directoryName.getBoundingClientRect().left, fileName.getBoundingClientRect().left]
  })
  const sameDepthLabelLeft = await readSameDepthLabelLeft()
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
  const compactSameDepthLabelLeft = await readSameDepthLabelLeft()
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
  observeWorkspaceOperations(page, (operation, filePath) => {
    if (operation === 'tree') loadedDirectoryPaths.push(filePath)
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

  const workspaceGate = await installWorkspaceRequestGate(page)

  await openFarming(page)
  await openNewAgentDialog(page)
  await startAgentFromOpenDialog(page, 'bash', workspace)

  const files = page.getByTestId('code-files-section')
  const filesTitle = files.getByRole('button', { name: 'Files', exact: true })
  if (await filesTitle.getAttribute('aria-expanded') !== 'true') await filesTitle.click()

  const folderRow = files.locator('[data-testid="code-file-row"][data-file-path="folder"]')
  const folderLoad = workspaceGate.blockNext('tree', 'folder')
  await folderRow.click()
  await folderLoad.started
  await expect(folderRow).toHaveClass(/loading/)
  const loadingChevron = folderRow.locator('.code-file-chevron')
  await expect(loadingChevron).toHaveClass(/loading/)
  await expect.poll(() => loadingChevron.evaluate(element => (
    getComputedStyle(element, '::before').content
  ))).toBe('""')
  await folderRow.click()
  await expect(folderRow).toHaveAttribute('aria-expanded', 'false')
  await expect(folderRow).not.toHaveClass(/loading/)
  await expect(folderRow).toHaveAttribute('aria-expanded', 'false')
  folderLoad.release()

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
    await expect(renameInput).toHaveCount(0)
  }
  const regularRow = files.locator('[data-testid="code-file-row"][data-file-path="regular.ts"]')
  await assertRenameKeepsLabelOrigin(regularRow)
  await assertRenameKeepsLabelOrigin(folderRow)

  await expect(folderRow).toHaveAttribute('aria-expanded', 'false')
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
      __fileTreeHorizontalSamplingDone?: boolean
      __fileTreeScrollIntoViewPaths?: string[]
    }
    testWindow.__fileTreeHorizontalSamples = []
    testWindow.__fileTreeHorizontalSamplingDone = false
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
      else testWindow.__fileTreeHorizontalSamplingDone = true
    }
    requestAnimationFrame(sample)
  })
  await deepFileRow.click()
  await expect.poll(() => page.evaluate(() => (
    window.__farmingFileEditorTest?.getFocusEditorRequestId() ?? null
  ))).toBeGreaterThan(0)
  await expect(page.locator('.monaco-editor textarea.inputarea')).toBeFocused()
  await expect.poll(() => page.evaluate(() => (
    (window as typeof window & { __fileTreeHorizontalSamplingDone?: boolean })
      .__fileTreeHorizontalSamplingDone === true
  ))).toBe(true)
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
  await page.keyboard.insertText('replacement from editor focus')
  await expect.poll(() => page.evaluate(() => window.__farmingFileEditorTest?.getValue()))
    .toContain('replacement from editor focus')

  const slowRead = workspaceGate.blockNext('read-file', 'target-a.ts')
  const slowFileRow = files.locator('[data-testid="code-file-row"][data-file-path="target-a.ts"]')
  const latestFileRow = files.locator('[data-testid="code-file-row"][data-file-path="target-b.ts"]')
  await slowFileRow.click()
  await slowRead.started
  await latestFileRow.click()
  await expect(page.getByTestId('code-file-editor').getByRole('tab', { name: /target-b\.ts/ })).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('.monaco-editor textarea.inputarea')).toBeFocused()
  const latestFocusRequestId = await page.evaluate(() => window.__farmingFileEditorTest?.getFocusEditorRequestId() ?? null)
  expect(latestFocusRequestId).not.toBeNull()
  await expect.poll(() => page.getByTestId('code-file-editor').getByRole('tab', { name: /target-b\.ts/ })
    .getAttribute('aria-selected')).toBe('true')
  await expect.poll(() => page.evaluate(() => window.__farmingFileEditorTest?.getFocusEditorRequestId() ?? null))
    .toBe(latestFocusRequestId)
  await expect(page.locator('.monaco-editor textarea.inputarea')).toBeFocused()
  slowRead.release()

  let repeatedProjectMounts = 0
  const countRepeatedProjectMounts = (request: { url(): string }) => {
    if (new URL(request.url()).pathname.endsWith('/api/projects/mount')) repeatedProjectMounts += 1
  }
  page.on('request', countRepeatedProjectMounts)
  await slowFileRow.click()
  await expect(page.getByTestId('code-file-editor').getByRole('tab', { name: /target-a\.ts/ })).toHaveAttribute('aria-selected', 'true')
  await latestFileRow.click()
  await expect(page.getByTestId('code-file-editor').getByRole('tab', { name: /target-b\.ts/ })).toHaveAttribute('aria-selected', 'true')
  expect(repeatedProjectMounts).toBe(0)
  await expect(page.locator('.monaco-editor textarea.inputarea')).toBeFocused()
  page.off('request', countRepeatedProjectMounts)

  await page.setViewportSize({ width: 720, height: 900 })
  await expect(page.locator('body')).toHaveClass(/code-compact-layout/)
  await page.locator('.code-sidebar').evaluate(element => element.classList.remove('collapsed'))
  await expect(linkedRow).toBeVisible()
  await assertStableSlots()
  await assertRenameKeepsLabelOrigin(regularRow)
})

test('keeps directory mutations and keyboard file operations authoritative', async ({ page, workspaceRoot }) => {
  const workspace = path.join(workspaceRoot, 'file-operation-authority')
  fs.mkdirSync(path.join(workspace, 'rename-parent', 'child'), { recursive: true })
  fs.writeFileSync(path.join(workspace, 'rename-parent', 'root.ts'), 'export const root = true\n')
  fs.writeFileSync(path.join(workspace, 'rename-parent', 'child', 'one.ts'), 'export const one = true\n')
  fs.mkdirSync(path.join(workspace, 'delete-parent', 'deep'), { recursive: true })
  fs.writeFileSync(path.join(workspace, 'delete-parent', 'keep.ts'), 'export const keep = true\n')
  fs.writeFileSync(path.join(workspace, 'delete-parent', 'deep', 'remove.ts'), 'export const remove = true\n')
  fs.mkdirSync(path.join(workspace, 'keyboard'), { recursive: true })
  fs.writeFileSync(path.join(workspace, 'keyboard', 'alpha.ts'), 'export const alpha = true\n')
  fs.writeFileSync(path.join(workspace, 'keyboard', 'beta.ts'), 'export const beta = true\n')

  await openFarming(page)
  await openNewAgentDialog(page)
  await startAgentFromOpenDialog(page, 'bash', workspace)

  const files = page.getByTestId('code-files-section')
  const filesTitle = files.getByRole('button', { name: 'Files', exact: true })
  if (await filesTitle.getAttribute('aria-expanded') !== 'true') await filesTitle.click()
  const tree = files.locator('[role="tree"]')

  const renameParent = files.locator('[data-testid="code-file-row"][data-file-path="rename-parent"]')
  await renameParent.click()
  const renameChild = files.locator('[data-testid="code-file-row"][data-file-path="rename-parent/child"]')
  await renameChild.click()
  const renamedOpenFile = files.locator('[data-testid="code-file-row"][data-file-path="rename-parent/child/one.ts"]')
  await renamedOpenFile.click()
  await expect(page.locator('.code-file-editor-tab[title="rename-parent/child/one.ts"]')).toHaveAttribute('aria-selected', 'true')
  await renameParent.click({ button: 'right' })
  await page.getByTestId('code-file-context-menu').getByRole('menuitem', { name: 'Rename' }).click()
  const directoryRenameInput = renameParent.getByTestId('code-file-operation-input')
  await directoryRenameInput.fill('moved-parent')
  await directoryRenameInput.press('Enter')
  const movedParent = files.locator('[data-testid="code-file-row"][data-file-path="moved-parent"]')
  await expect(movedParent).toBeVisible()
  await expect(files.locator('[data-testid="code-file-row"][data-file-path="moved-parent/child/one.ts"]')).toBeVisible()
  await expect(page.locator('.code-file-editor-tab[title="moved-parent/child/one.ts"]')).toHaveAttribute('aria-selected', 'true')
  await expect.poll(() => fs.existsSync(path.join(workspace, 'moved-parent', 'child', 'one.ts'))).toBe(true)
  expect(fs.existsSync(path.join(workspace, 'rename-parent'))).toBe(false)

  const deleteParent = files.locator('[data-testid="code-file-row"][data-file-path="delete-parent"]')
  await deleteParent.click()
  const deleteDeep = files.locator('[data-testid="code-file-row"][data-file-path="delete-parent/deep"]')
  await deleteDeep.click()
  const deleteOpenFile = files.locator('[data-testid="code-file-row"][data-file-path="delete-parent/deep/remove.ts"]')
  await deleteOpenFile.click()
  await expect(page.locator('.code-file-editor-tab[title="delete-parent/deep/remove.ts"]')).toHaveAttribute('aria-selected', 'true')
  const stickyDeleteParent = files.locator('[data-testid="code-file-sticky-row"][data-sticky-file-path="delete-parent"]')
  if (await stickyDeleteParent.count()) await stickyDeleteParent.click({ button: 'right' })
  else await deleteParent.click({ button: 'right' })
  await page.getByTestId('code-file-context-menu').getByRole('menuitem', { name: 'Delete' }).click()
  await page.getByTestId('code-file-operation-dialog').getByRole('button', { name: 'Delete' }).click()
  await expect(deleteParent).toHaveCount(0)
  await expect(page.locator('.code-file-editor-tab[title="delete-parent/deep/remove.ts"]')).toHaveCount(0)
  await expect.poll(() => fs.existsSync(path.join(workspace, 'delete-parent'))).toBe(false)

  const keyboardDirectory = files.locator('[data-testid="code-file-row"][data-file-path="keyboard"]')
  await tree.focus()
  await expect(tree).toBeFocused()
  await page.keyboard.press('Home')
  await expect(keyboardDirectory).toHaveClass(/selected/)
  await page.keyboard.press('ArrowRight')
  await expect(keyboardDirectory).toHaveAttribute('aria-expanded', 'true')
  const alphaRow = files.locator('[data-testid="code-file-row"][data-file-path="keyboard/alpha.ts"]')
  await expect(alphaRow).toBeVisible()
  await page.keyboard.press('ArrowRight')
  await expect(alphaRow).toHaveClass(/selected/)
  await page.keyboard.press('Enter')
  await expect(page.locator('.code-file-editor-tab[title="keyboard/alpha.ts"]')).toHaveAttribute('aria-selected', 'true')
  await expect(tree).toBeFocused()

  await page.keyboard.press('Shift+F10')
  const keyboardMenu = page.getByTestId('code-file-context-menu')
  await expect(keyboardMenu).toBeVisible()
  await expect(keyboardMenu.getByRole('menuitem', { name: 'New File' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(tree).toBeFocused()
  await page.keyboard.press('F2')
  const keyboardRenameInput = alphaRow.getByTestId('code-file-operation-input')
  await expect(keyboardRenameInput).toBeFocused()
  await keyboardRenameInput.fill('gamma.ts')
  await keyboardRenameInput.press('Enter')
  const gammaRow = files.locator('[data-testid="code-file-row"][data-file-path="keyboard/gamma.ts"]')
  await expect(gammaRow).toBeVisible()
  await expect(page.locator('.code-file-editor-tab[title="keyboard/gamma.ts"]')).toHaveAttribute('aria-selected', 'true')
  await expect.poll(() => fs.existsSync(path.join(workspace, 'keyboard', 'gamma.ts'))).toBe(true)

  await expect(gammaRow).toHaveClass(/selected/)
  await expect(tree).toBeFocused()
  await page.keyboard.press('Delete')
  const keyboardDeleteDialog = page.getByTestId('code-file-operation-dialog')
  await expect(keyboardDeleteDialog).toContainText('keyboard/gamma.ts')
  const keyboardCancelDelete = keyboardDeleteDialog.getByRole('button', { name: 'Cancel' })
  await expect(keyboardCancelDelete).toBeFocused()
  await keyboardCancelDelete.press('Enter')
  await expect(gammaRow).toBeVisible()
  await expect(tree).toBeFocused()
  await page.keyboard.press('Delete')
  await expect(keyboardCancelDelete).toBeFocused()
  await page.keyboard.press('Tab')
  const keyboardConfirmDelete = keyboardDeleteDialog.getByRole('button', { name: 'Delete' })
  await expect(keyboardConfirmDelete).toBeFocused()
  await keyboardConfirmDelete.press('Enter')
  await expect(gammaRow).toHaveCount(0)
  await expect(page.locator('.code-file-editor-tab[title="keyboard/gamma.ts"]')).toHaveCount(0)
  await expect.poll(() => fs.existsSync(path.join(workspace, 'keyboard', 'gamma.ts'))).toBe(false)
})

test('keeps file operation states distinguishable across light, dark, and paper', async ({ page, workspaceRoot }) => {
  const workspace = path.join(workspaceRoot, 'file-operation-appearance')
  fs.mkdirSync(workspace, { recursive: true })
  fs.writeFileSync(path.join(workspace, '.gitignore'), '*.ignored\n')
  fs.writeFileSync(path.join(workspace, 'normal.txt'), 'normal file\n')
  fs.writeFileSync(path.join(workspace, 'hidden.ignored'), 'ignored file\n')
  execFileSync('git', ['init', '-q'], { cwd: workspace })
  execFileSync('git', ['config', 'user.email', 'farming@example.test'], { cwd: workspace })
  execFileSync('git', ['config', 'user.name', 'Farming Test'], { cwd: workspace })
  execFileSync('git', ['add', '.'], { cwd: workspace })
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: workspace })

  await openFarming(page)
  await openNewAgentDialog(page)
  await startAgentFromOpenDialog(page, 'bash', workspace)
  const files = page.getByTestId('code-files-section')
  const filesTitle = files.getByRole('button', { name: 'Files', exact: true })
  if (await filesTitle.getAttribute('aria-expanded') !== 'true') await filesTitle.click()
  const normalRow = files.locator('[data-testid="code-file-row"][data-file-path="normal.txt"]')
  const ignoredRow = files.locator('[data-testid="code-file-row"][data-file-path="hidden.ignored"]')
  await expect(ignoredRow).toHaveClass(/ignored/)

  for (const appearance of ['light', 'dark', 'paper'] as const) {
    await page.locator('body').evaluate((body, value) => {
      body.dataset.appearance = value
    }, appearance)
    await normalRow.click({ button: 'right' })
    const menu = page.getByTestId('code-file-context-menu')
    const refreshItem = menu.getByRole('menuitem', { name: 'Refresh' })
    const restingMenuItemBackground = await refreshItem.evaluate(element => getComputedStyle(element).backgroundColor)
    await refreshItem.hover()
    const hoveredMenuItemBackground = await refreshItem.evaluate(element => getComputedStyle(element).backgroundColor)
    expect(hoveredMenuItemBackground).not.toBe(restingMenuItemBackground)
    await captureFileOperationAudit(page, `${appearance}-file-menu.png`)

    await menu.getByRole('menuitem', { name: 'Rename' }).click()
    const renameInput = normalRow.getByTestId('code-file-operation-input')
    await expect(renameInput).toBeFocused()
    const palette = await files.evaluate(element => {
      const normal = element.querySelector<HTMLElement>('[data-file-path="normal.txt"]')
      const ignored = element.querySelector<HTMLElement>('[data-file-path="hidden.ignored"]')
      const input = normal?.querySelector<HTMLInputElement>('[data-testid="code-file-operation-input"]')
      if (!normal || !ignored || !input) return null
      return {
        normalColor: getComputedStyle(normal).color,
        ignoredColor: getComputedStyle(ignored).color,
        rowBackground: getComputedStyle(normal).backgroundColor,
        inputBackground: getComputedStyle(input).backgroundColor,
      }
    })
    expect(palette).not.toBeNull()
    expect(palette?.ignoredColor).not.toBe(palette?.normalColor)
    expect(palette?.inputBackground).not.toBe(palette?.rowBackground)
    await captureFileOperationAudit(page, `${appearance}-file-rename.png`)
    await renameInput.press('Escape')
    await expect(renameInput).toHaveCount(0)
  }
})

test('copies relative file and directory paths when the Clipboard API is unavailable', async ({ page, workspaceRoot }) => {
  const workspace = path.join(workspaceRoot, 'copy-relative-path')
  fs.mkdirSync(path.join(workspace, 'nested'), { recursive: true })
  fs.writeFileSync(path.join(workspace, 'root-file.txt'), 'copy me\n')

  await openFarming(page)
  await openNewAgentDialog(page)
  await startAgentFromOpenDialog(page, 'bash', workspace)
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: undefined,
    })
    document.execCommand = command => {
      if (command !== 'copy') return false
      const activeElement = document.activeElement
      ;(window as Window & { __farmingFallbackCopyText?: string }).__farmingFallbackCopyText =
        activeElement instanceof HTMLTextAreaElement ? activeElement.value : ''
      return true
    }
  })

  const files = page.getByTestId('code-files-section')
  const filesTitle = files.getByRole('button', { name: 'Files', exact: true })
  if (await filesTitle.getAttribute('aria-expanded') !== 'true') await filesTitle.click()
  const menu = page.getByTestId('code-file-context-menu')
  const copyRelativePath = async (filePath: string) => {
    const row = files.locator(`[data-testid="code-file-row"][data-file-path="${filePath}"]`)
    await row.click({ button: 'right' })
    await menu.getByRole('menuitem', { name: 'Copy Relative Path' }).click()
    await expect(menu).toHaveCount(0)
    await expect(files.getByTestId('code-file-open-error')).toHaveCount(0)
    await expect.poll(() => page.evaluate(() => (
      window as Window & { __farmingFallbackCopyText?: string }
    ).__farmingFallbackCopyText)).toBe(filePath)
  }

  await copyRelativePath('root-file.txt')
  await copyRelativePath('nested')
})

test('completes file-menu copy, share, and refresh actions with focus recovery', async ({ page, workspaceRoot }) => {
  const workspace = path.join(workspaceRoot, 'file-menu-utility-actions')
  fs.mkdirSync(path.join(workspace, 'nested'), { recursive: true })
  fs.writeFileSync(path.join(workspace, 'nested', 'fixture.txt'), 'file menu fixture\n')
  const shareTargets: Array<{
    kind?: string
    filePath?: string
    folderPath?: string
    absolutePath?: string
    projectLabel?: string
  }> = []
  let failShare = false
  await page.route('**/api/share/qr-ticket', async route => {
    const body = route.request().postDataJSON() as { target?: typeof shareTargets[number] }
    const target = body.target ?? {}
    shareTargets.push(target)
    if (failShare) {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'simulated share failure' }),
      })
      return
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ longUrl: `https://share.example.test/${target.kind ?? 'unknown'}` }),
    })
  })

  await openFarming(page)
  await openNewAgentDialog(page)
  await startAgentFromOpenDialog(page, 'bash', workspace)
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(page.url()).origin })

  const files = page.getByTestId('code-files-section')
  const filesTitle = files.getByRole('button', { name: 'Files', exact: true })
  if (await filesTitle.getAttribute('aria-expanded') !== 'true') await filesTitle.click()
  const tree = files.locator('[role="tree"]')
  const directoryRow = files.locator('[data-testid="code-file-row"][data-file-path="nested"]')
  await directoryRow.click()
  const fileRow = files.locator('[data-testid="code-file-row"][data-file-path="nested/fixture.txt"]')
  await expect(fileRow).toBeVisible()
  const menu = page.getByTestId('code-file-context-menu')

  await fileRow.click({ button: 'right' })
  await menu.getByRole('menuitem', { name: 'Copy Relative Path' }).click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('nested/fixture.txt')
  await expect(tree).toBeFocused()
  const composer = page.getByTestId('code-composer-input')
  await composer.click()
  await composer.press('Control+V')
  await expect(composer).toHaveValue('nested/fixture.txt')

  await fileRow.click({ button: 'right' })
  await menu.getByRole('menuitem', { name: 'Copy Share URL' }).click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('https://share.example.test/file')
  await expect(tree).toBeFocused()
  expect(shareTargets[0]).toMatchObject({
    kind: 'file',
    filePath: 'nested/fixture.txt',
    absolutePath: path.join(workspace, 'nested', 'fixture.txt'),
    projectLabel: path.basename(workspace),
  })

  await directoryRow.click({ button: 'right' })
  await menu.getByRole('menuitem', { name: 'Copy Share URL' }).click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('https://share.example.test/folder')
  await expect(tree).toBeFocused()
  expect(shareTargets[1]).toMatchObject({
    kind: 'folder',
    folderPath: 'nested',
    absolutePath: path.join(workspace, 'nested'),
    projectLabel: path.basename(workspace),
  })

  failShare = true
  await fileRow.click({ button: 'right' })
  await menu.getByRole('menuitem', { name: 'Copy Share URL' }).click()
  await expect(files.getByTestId('code-file-open-error')).toContainText('simulated share failure')
  await expect(tree).toBeFocused()
  failShare = false
  await fileRow.click({ button: 'right' })
  await expect(files.getByTestId('code-file-open-error')).toHaveCount(0)
  await menu.getByRole('menuitem', { name: 'Copy Share URL' }).click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('https://share.example.test/file')
  await expect(files.getByTestId('code-file-open-error')).toHaveCount(0)
  await expect(tree).toBeFocused()

  fs.writeFileSync(path.join(workspace, 'nested', 'refreshed.txt'), 'appears after refresh\n')
  const refreshedRow = files.locator('[data-testid="code-file-row"][data-file-path="nested/refreshed.txt"]')
  await expect(refreshedRow).toHaveCount(0)
  await fileRow.click({ button: 'right' })
  await menu.getByRole('menuitem', { name: 'Refresh' }).click()
  await expect(refreshedRow).toBeVisible()
  await expect(tree).toBeFocused()
})
