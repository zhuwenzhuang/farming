import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import type { Page } from '@playwright/test'
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

function observeWorkspaceReads(page: Page, reads: string[]) {
  page.on('websocket', socket => {
    socket.on('framesent', ({ payload }) => {
      try {
        const message = JSON.parse(String(payload)) as {
          type?: string
          request?: { operation?: string; path?: string }
        }
        if (message.type === 'workspace-request' && message.request?.operation === 'read-file' && message.request.path) {
          reads.push(message.request.path)
        }
      } catch {
        // Ignore terminal and other non-JSON websocket frames.
      }
    })
  })
}

async function setWebSocketLatency(page: Page, latency: number) {
  const session = await page.context().newCDPSession(page)
  await session.send('Network.enable')
  await session.send('Network.emulateNetworkConditions', {
    offline: false,
    latency,
    downloadThroughput: -1,
    uploadThroughput: -1,
    connectionType: 'wifi',
  })
  return async () => {
    await session.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
      connectionType: 'wifi',
    })
    await session.detach()
  }
}

test('uses one italic preview tab and pins it on double click', async ({ page }) => {
  const workspaceReads: string[] = []
  observeWorkspaceReads(page, workspaceReads)
  const workspaceRoot = path.join(PLAYWRIGHT_WORKSPACE_ROOT, 'editor-preview-tabs')
  fs.rmSync(workspaceRoot, { recursive: true, force: true })
  fs.mkdirSync(workspaceRoot, { recursive: true })
  fs.writeFileSync(path.join(workspaceRoot, 'one.txt'), 'one\n')
  fs.writeFileSync(path.join(workspaceRoot, 'two.txt'), 'two\n')
  fs.writeFileSync(path.join(workspaceRoot, 'three.txt'), 'three\n')
  fs.writeFileSync(path.join(workspaceRoot, 'four.txt'), 'four\n')
  fs.writeFileSync(path.join(workspaceRoot, 'five.txt'), 'five\n')

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
  const fourRow = files.locator('[data-testid="code-file-row"][data-file-path="four.txt"]')
  const fiveRow = files.locator('[data-testid="code-file-row"][data-file-path="five.txt"]')

  await oneRow.click()
  await expect(project.locator('.code-agent-row.active')).toHaveCount(0)
  await expect(project.getByTestId('code-agent-row')).toHaveCount(1)
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

  workspaceReads.length = 0
  await twoRow.click()
  await expect(twoTab).toHaveAttribute('aria-selected', 'true')
  await expect(twoTab).not.toHaveAttribute('data-preview', 'true')
  await expect(twoTab.locator('.code-file-editor-tab-name')).toHaveCSS('font-style', 'normal')
  expect(workspaceReads.filter(filePath => filePath === 'two.txt')).toHaveLength(0)

  await threeRow.dblclick()
  await expect(threeTab).not.toHaveAttribute('data-preview', 'true')
  await expect(threeTab.locator('.code-file-editor-tab-name')).toHaveCSS('font-style', 'normal')
  await expect(editor.getByRole('tab')).toHaveCount(2)

  workspaceReads.length = 0
  await fourRow.dblclick()
  await expect.poll(() => workspaceReads.filter(filePath => filePath === 'four.txt').length).toBe(1)
  const fourTab = editor.getByRole('tab').filter({ hasText: 'four.txt' })
  await expect(fourTab).toHaveAttribute('aria-selected', 'true')
  await expect(fourTab).not.toHaveAttribute('data-preview', 'true')

  let repeatedProjectMounts = 0
  const countRepeatedProjectMounts = (request: { url(): string }) => {
    if (new URL(request.url()).pathname.endsWith('/api/projects/mount')) repeatedProjectMounts += 1
  }
  page.on('request', countRepeatedProjectMounts)
  await fiveRow.dblclick()
  const fiveTab = editor.getByRole('tab').filter({ hasText: 'five.txt' })
  await expect(fiveTab).toHaveAttribute('aria-selected', 'true')
  await expect(fiveTab).not.toHaveAttribute('data-preview', 'true')
  expect(repeatedProjectMounts).toBe(0)
  page.off('request', countRepeatedProjectMounts)
})

test('returns to a watched retained preview without a remote reread and reuses its editor model', async ({ page }) => {
  const workspaceReads: string[] = []
  observeWorkspaceReads(page, workspaceReads)
  const workspaceRoot = path.join(PLAYWRIGHT_WORKSPACE_ROOT, 'editor-retained-preview-model')
  fs.rmSync(workspaceRoot, { recursive: true, force: true })
  fs.mkdirSync(workspaceRoot, { recursive: true })
  fs.writeFileSync(path.join(workspaceRoot, 'one.txt'), 'one\n')
  fs.writeFileSync(path.join(workspaceRoot, 'two.txt'), 'two\n')

  await openFarming(page)
  await openNewAgentDialog(page)
  await startAgentFromOpenDialog(page, 'bash', workspaceRoot)

  const project = page.getByTestId('code-project-group').filter({ hasText: path.basename(workspaceRoot) })
  const files = project.getByTestId('code-files-section')
  const filesTitle = files.locator('.code-files-title').first()
  if (await filesTitle.getAttribute('aria-expanded') !== 'true') await filesTitle.click()
  const oneRow = files.locator('[data-testid="code-file-row"][data-file-path="one.txt"]')
  const twoRow = files.locator('[data-testid="code-file-row"][data-file-path="two.txt"]')
  const editor = page.getByTestId('code-file-editor')

  await oneRow.click()
  const oneTab = editor.getByRole('tab').filter({ hasText: 'one.txt' })
  await expect(oneTab).toHaveAttribute('aria-selected', 'true')
  await expect.poll(() => page.evaluate(() => window.__farmingFileEditorTest?.getModelId() ?? null)).not.toBeNull()
  const firstModelId = await page.evaluate(() => window.__farmingFileEditorTest?.getModelId() ?? null)
  expect(firstModelId).not.toBeNull()

  await twoRow.click()
  await expect(oneTab).toHaveCount(0)
  await expect(editor.getByRole('tab').filter({ hasText: 'two.txt' })).toHaveAttribute('aria-selected', 'true')

  workspaceReads.length = 0
  await oneRow.click()
  await expect(oneTab).toHaveAttribute('aria-selected', 'true')
  expect(await page.evaluate(() => window.__farmingFileEditorTest?.getModelId() ?? null)).toBe(firstModelId)
  expect(await page.evaluate(() => window.__farmingFileEditorTest?.getValue() ?? '')).toBe('one\n')

  expect(workspaceReads.filter(filePath => filePath === 'one.txt')).toHaveLength(0)
})

test('lets the latest same-file intent replace a pending diff target', async ({ page }) => {
  const workspaceReads: string[] = []
  observeWorkspaceReads(page, workspaceReads)
  const workspaceRoot = path.join(PLAYWRIGHT_WORKSPACE_ROOT, 'editor-latest-same-file-intent')
  fs.rmSync(workspaceRoot, { recursive: true, force: true })
  fs.mkdirSync(workspaceRoot, { recursive: true })
  fs.writeFileSync(path.join(workspaceRoot, 'target.txt'), 'before\n')
  execFileSync('git', ['init', '-q'], { cwd: workspaceRoot })
  execFileSync('git', ['config', 'user.email', 'farming@example.test'], { cwd: workspaceRoot })
  execFileSync('git', ['config', 'user.name', 'Farming Test'], { cwd: workspaceRoot })
  execFileSync('git', ['add', 'target.txt'], { cwd: workspaceRoot })
  execFileSync('git', ['commit', '-qm', 'initial'], { cwd: workspaceRoot })
  fs.writeFileSync(path.join(workspaceRoot, 'target.txt'), 'after\n')

  await openFarming(page)
  await openNewAgentDialog(page)
  await startAgentFromOpenDialog(page, 'bash', workspaceRoot)

  const project = page.getByTestId('code-project-group').filter({ hasText: path.basename(workspaceRoot) })
  const files = project.getByTestId('code-files-section')
  const filesTitle = files.locator('.code-files-title').first()
  if (await filesTitle.getAttribute('aria-expanded') !== 'true') await filesTitle.click()
  const trackedGroup = files.getByTestId('code-file-change-tracked-group')
  const changesTitle = trackedGroup.getByRole('button', { name: /Changes/ })
  await expect(changesTitle).toBeVisible({ timeout: 30_000 })
  if (await changesTitle.getAttribute('aria-expanded') !== 'true') await changesTitle.click()
  const changeRow = trackedGroup.locator('[data-testid="code-file-change-row"][data-file-path="target.txt"]')
  const treeRow = files.locator('[data-testid="code-file-row"][data-file-path="target.txt"]')
  await expect(changeRow).toBeVisible()
  await expect(treeRow).toBeVisible()

  const clearLatency = await setWebSocketLatency(page, 350)
  workspaceReads.length = 0
  await changeRow.click()
  await expect.poll(() => workspaceReads.filter(filePath => filePath === 'target.txt').length).toBe(1)
  await treeRow.click()
  expect(workspaceReads.filter(filePath => filePath === 'target.txt')).toHaveLength(1)

  const targetTab = page.getByTestId('code-file-editor').getByRole('tab').filter({ hasText: 'target.txt' })
  await expect(targetTab).toHaveAttribute('aria-selected', 'true')
  await expect(targetTab).toHaveAttribute('data-preview', 'true')
  await expect(page.getByTestId('code-file-diff-view')).toHaveCount(0)
  await clearLatency()
})

test('keeps the latest file intent across Project sections', async ({ page }) => {
  const workspaceReads: string[] = []
  observeWorkspaceReads(page, workspaceReads)
  const slowWorkspace = path.join(PLAYWRIGHT_WORKSPACE_ROOT, 'editor-cross-project-slow')
  const fastWorkspace = path.join(PLAYWRIGHT_WORKSPACE_ROOT, 'editor-cross-project-fast')
  for (const workspace of [slowWorkspace, fastWorkspace]) {
    fs.rmSync(workspace, { recursive: true, force: true })
    fs.mkdirSync(workspace, { recursive: true })
  }
  fs.writeFileSync(path.join(slowWorkspace, 'slow.txt'), 'slow\n')
  fs.writeFileSync(path.join(fastWorkspace, 'fast.txt'), 'fast\n')

  await openFarming(page)
  for (const workspace of [slowWorkspace, fastWorkspace]) {
    await openNewAgentDialog(page)
    await startAgentFromOpenDialog(page, 'bash', workspace)
  }

  const slowProject = page.getByTestId('code-project-group').filter({ hasText: path.basename(slowWorkspace) })
  const fastProject = page.getByTestId('code-project-group').filter({ hasText: path.basename(fastWorkspace) })
  const slowFiles = slowProject.getByTestId('code-files-section')
  const fastFiles = fastProject.getByTestId('code-files-section')
  for (const files of [slowFiles, fastFiles]) {
    const title = files.locator('.code-files-title').first()
    if (await title.getAttribute('aria-expanded') !== 'true') await title.click()
  }

  const clearLatency = await setWebSocketLatency(page, 350)
  workspaceReads.length = 0
  await slowFiles.locator('[data-testid="code-file-row"][data-file-path="slow.txt"]').click()
  await expect.poll(() => workspaceReads.filter(filePath => filePath === 'slow.txt').length).toBe(1)
  await fastFiles.locator('[data-testid="code-file-row"][data-file-path="fast.txt"]').click()
  const editor = page.getByTestId('code-file-editor')
  const fastTab = editor.getByRole('tab').filter({ hasText: 'fast.txt' })
  await expect(fastTab).toHaveAttribute('aria-selected', 'true')

  await expect(editor.getByRole('tab').filter({ hasText: 'slow.txt' })).toHaveCount(0)
  await expect(fastTab).toHaveAttribute('aria-selected', 'true')
  await clearLatency()
})

test('mounts an absent Project once and then reuses membership', async ({ page }) => {
  const workspaceReads: string[] = []
  observeWorkspaceReads(page, workspaceReads)
  const workspaceRoot = path.join(PLAYWRIGHT_WORKSPACE_ROOT, 'editor-project-mount-membership')
  fs.rmSync(workspaceRoot, { recursive: true, force: true })
  fs.mkdirSync(workspaceRoot, { recursive: true })
  fs.writeFileSync(path.join(workspaceRoot, 'one.txt'), 'one\n')
  fs.writeFileSync(path.join(workspaceRoot, 'two.txt'), 'two\n')

  await openFarming(page)
  await openNewAgentDialog(page)
  await startAgentFromOpenDialog(page, 'bash', workspaceRoot)
  const removeResponse = await page.request.post('/farming/api/projects/remove', {
    data: { workspace: workspaceRoot },
  })
  expect(removeResponse.ok()).toBeTruthy()
  await page.reload({ waitUntil: 'domcontentloaded' })

  const project = page.getByTestId('code-project-group').filter({ hasText: path.basename(workspaceRoot) })
  await expect(project).toBeVisible({ timeout: 30_000 })
  const files = project.getByTestId('code-files-section')
  const filesTitle = files.locator('.code-files-title').first()
  if (await filesTitle.getAttribute('aria-expanded') !== 'true') await filesTitle.click()

  let mountCount = 0
  let releaseMount = () => {}
  let markMountStarted = () => {}
  const mountGate = new Promise<void>(resolve => { releaseMount = resolve })
  const mountStarted = new Promise<void>(resolve => { markMountStarted = resolve })
  await page.route('**/api/projects/mount', async route => {
    mountCount += 1
    const response = await route.fetch()
    markMountStarted()
    await mountGate
    await route.fulfill({ response })
  })
  workspaceReads.length = 0
  const oneRow = files.locator('[data-testid="code-file-row"][data-file-path="one.txt"]')
  await oneRow.click()
  await mountStarted
  await oneRow.dblclick()
  expect(mountCount).toBe(1)
  expect(workspaceReads.filter(filePath => filePath === 'one.txt')).toHaveLength(1)
  releaseMount()
  const firstTab = page.getByTestId('code-file-editor').getByRole('tab').filter({ hasText: 'one.txt' })
  await expect(firstTab).toBeVisible()
  await expect(firstTab).not.toHaveAttribute('data-preview', 'true')

  await files.locator('[data-testid="code-file-row"][data-file-path="two.txt"]').click()
  await expect(page.getByTestId('code-file-editor').getByRole('tab').filter({ hasText: 'two.txt' })).toBeVisible()
  expect(mountCount).toBe(1)
  await page.unroute('**/api/projects/mount')
})

test('shares a pending Project mount across different file intents', async ({ page }) => {
  const workspaceRoot = path.join(PLAYWRIGHT_WORKSPACE_ROOT, 'editor-shared-project-mount')
  fs.rmSync(workspaceRoot, { recursive: true, force: true })
  fs.mkdirSync(workspaceRoot, { recursive: true })
  fs.writeFileSync(path.join(workspaceRoot, 'slow.txt'), 'slow\n')
  fs.writeFileSync(path.join(workspaceRoot, 'latest.txt'), 'latest\n')

  await openFarming(page)
  await openNewAgentDialog(page)
  await startAgentFromOpenDialog(page, 'bash', workspaceRoot)
  const removeResponse = await page.request.post('/farming/api/projects/remove', {
    data: { workspace: workspaceRoot },
  })
  expect(removeResponse.ok()).toBeTruthy()
  await page.reload({ waitUntil: 'domcontentloaded' })

  const project = page.getByTestId('code-project-group').filter({ hasText: path.basename(workspaceRoot) })
  await expect(project).toBeVisible({ timeout: 30_000 })
  const files = project.getByTestId('code-files-section')
  const filesTitle = files.locator('.code-files-title').first()
  if (await filesTitle.getAttribute('aria-expanded') !== 'true') await filesTitle.click()

  let mountCount = 0
  let releaseMount = () => {}
  let markMountStarted = () => {}
  const mountGate = new Promise<void>(resolve => { releaseMount = resolve })
  const mountStarted = new Promise<void>(resolve => { markMountStarted = resolve })
  await page.route('**/api/projects/mount', async route => {
    mountCount += 1
    const response = await route.fetch()
    markMountStarted()
    await mountGate
    await route.fulfill({ response })
  })

  await files.locator('[data-testid="code-file-row"][data-file-path="slow.txt"]').click()
  await mountStarted
  await files.locator('[data-testid="code-file-row"][data-file-path="latest.txt"]').click()
  await expect.poll(() => mountCount).toBe(1)
  releaseMount()

  const editor = page.getByTestId('code-file-editor')
  const latestTab = editor.getByRole('tab').filter({ hasText: 'latest.txt' })
  await expect(latestTab).toHaveAttribute('aria-selected', 'true')
  await expect(editor.getByRole('tab').filter({ hasText: 'slow.txt' })).toHaveCount(0)
  expect(mountCount).toBe(1)
  await page.unroute('**/api/projects/mount')
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
  const agentsSection = project.getByTestId('code-agents-section')
  const openEditorsSection = project.locator('.code-open-editors')
  const files = project.getByTestId('code-files-section')
  const filesTitle = files.locator('.code-files-title').first()
  if (await filesTitle.getAttribute('aria-expanded') !== 'true') await filesTitle.click()
  await expect(agentsSection).toHaveCSS('border-radius', '0px')
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
  await expect(openEditorsSection).toHaveCSS('border-radius', '0px')
  const stickySurfaceGeometry = await project.evaluate(element => {
    const left = (selector: string) => element.querySelector<HTMLElement>(selector)!.getBoundingClientRect().left
    return {
      agentsSurface: left('.code-agents-section'),
      fileRowSurface: left('.code-file-tree-row-frame'),
      filesHeaderSurface: left('.code-files-header'),
      openEditorsSurface: left('.code-open-editors'),
      openEditorsContent: left('.code-open-editors-header'),
    }
  })
  expect(stickySurfaceGeometry.filesHeaderSurface).toBe(stickySurfaceGeometry.agentsSurface)
  expect(stickySurfaceGeometry.openEditorsSurface).toBe(stickySurfaceGeometry.agentsSurface)
  expect(stickySurfaceGeometry.openEditorsContent).toBe(stickySurfaceGeometry.fileRowSurface)
  expect(stickySurfaceGeometry.fileRowSurface).toBeGreaterThan(stickySurfaceGeometry.agentsSurface)
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
  await expect(project.locator('.code-agent-row.active')).toHaveCount(0)

  const activeSelectionSurfaces = await page.evaluate(() => (
    ['light', 'dark', 'paper'] as const
  ).map(appearance => {
    document.body.dataset.appearance = appearance
    const activeTab = document.querySelector<HTMLElement>('.code-file-editor-tab.active')!
    const activeFileRow = document.querySelector<HTMLElement>('.code-file-row.active')!
    const activeFileFrame = activeFileRow.closest<HTMLElement>('.code-file-tree-row-frame')!
    return {
      appearance,
      activeTabBackground: getComputedStyle(activeTab).backgroundColor,
      activeTabSeamColor: getComputedStyle(activeTab, '::after').backgroundColor,
      activeFileRowBackground: getComputedStyle(activeFileRow).backgroundColor,
      activeFileRowBorderRadius: getComputedStyle(activeFileRow).borderRadius,
      activeFileRowGuideOpacity: getComputedStyle(activeFileRow, '::before').opacity,
      activeFileFrameBackground: getComputedStyle(activeFileFrame).backgroundColor,
      activeFileRowEdgeContent: getComputedStyle(activeFileRow, '::after').content,
    }
  }))
  for (const selection of activeSelectionSurfaces) {
    if (selection.appearance === 'paper') {
      expect(selection.activeFileFrameBackground, selection.appearance).toBe(selection.activeTabBackground)
      expect(colorAlpha(selection.activeTabSeamColor), selection.appearance).toBe(0)
    } else {
      expect(selection.activeFileFrameBackground, selection.appearance).not.toBe(selection.activeTabBackground)
      expect(selection.activeTabSeamColor, selection.appearance).toBe(selection.activeTabBackground)
    }
    expect(selection.activeFileRowBorderRadius, selection.appearance).toBe('8px')
    expect(selection.activeFileRowGuideOpacity, selection.appearance).toBe('0.32')
    expect(colorAlpha(selection.activeFileRowBackground), selection.appearance).toBe(0)
    expect(colorAlpha(selection.activeTabBackground), selection.appearance).toBe(1)
    expect(selection.activeFileRowEdgeContent, selection.appearance).toBe('none')
  }

  const inactiveFileRow = files.locator('[data-testid="code-file-row"][data-file-path="docs/alpha.md"]')
  const inactiveTab = editor.getByRole('tab', { name: /alpha\.md/ })
  const agentRow = project.getByTestId('code-agent-row')
  for (const appearance of ['light', 'dark', 'paper'] as const) {
    await page.locator('body').evaluate((body, value) => { body.dataset.appearance = value }, appearance)
    const surfaces = await page.evaluate(() => {
      const activeFileRow = document.querySelector<HTMLElement>('.code-file-row.active')!
      return {
        row: getComputedStyle(activeFileRow.closest<HTMLElement>('.code-file-tree-row-frame')!).backgroundColor,
        tab: getComputedStyle(document.querySelector<HTMLElement>('.code-file-editor-tab.active')!).backgroundColor,
      }
    })
    await projectTitle.hover()
    await expect(projectTitle, `${appearance} Project hover`).toHaveCSS('background-color', surfaces.row)
    await expect(projectTitle, `${appearance} Project radius`).toHaveCSS('border-radius', '8px')
    await agentRow.hover()
    const agentHoverLayers = await agentRow.evaluate(element => ({
      actionBackground: getComputedStyle(element.querySelector<HTMLElement>('.code-agent-row-actions')!).backgroundImage,
      rowBackground: getComputedStyle(element).backgroundColor,
    }))
    expect(agentHoverLayers.rowBackground, `${appearance} Agent row hover`).toBe(surfaces.row)
    expect(agentHoverLayers.actionBackground, `${appearance} Agent actions`).toContain(surfaces.row)
    await inactiveFileRow.hover()
    await expect(inactiveFileRow, `${appearance} file content`).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    await expect(inactiveFileRow, `${appearance} file radius`).toHaveCSS('border-radius', '8px')
    const hoveredFileLayers = await inactiveFileRow.evaluate(element => ({
      frameBackground: getComputedStyle(element.closest<HTMLElement>('.code-file-tree-row-frame')!).backgroundColor,
      guideOpacity: getComputedStyle(element, '::before').opacity,
    }))
    expect(hoveredFileLayers.frameBackground, `${appearance} file frame`).toBe(surfaces.row)
    expect(hoveredFileLayers.guideOpacity, `${appearance} file guide`).toBe('0.32')
    await inactiveTab.hover()
    await expect(inactiveTab, `${appearance} tab hover`).toHaveCSS('background-color', surfaces.tab)
  }
  await page.mouse.move(1000, 800)

  const compactActiveSelectionSurfaces = await page.evaluate(() => {
    document.body.classList.add('code-compact-layout')
    const surfaces = (['light', 'dark', 'paper'] as const).map(appearance => {
      document.body.dataset.appearance = appearance
      const activeFileRow = document.querySelector<HTMLElement>('.code-file-row.active')!
      return {
        appearance,
        activeFileRowBackground: getComputedStyle(activeFileRow).backgroundColor,
        activeFileRowBorderRadius: getComputedStyle(activeFileRow).borderRadius,
        activeFileFrameBackground: getComputedStyle(activeFileRow.closest<HTMLElement>('.code-file-tree-row-frame')!).backgroundColor,
        activeTabBackground: getComputedStyle(document.querySelector<HTMLElement>('.code-file-editor-tab.active')!).backgroundColor,
      }
    })
    document.body.classList.remove('code-compact-layout')
    return surfaces
  })
  for (const selection of compactActiveSelectionSurfaces) {
    if (selection.appearance === 'paper') {
      expect(selection.activeFileFrameBackground, `${selection.appearance} compact`).toBe(selection.activeTabBackground)
    } else {
      expect(selection.activeFileFrameBackground, `${selection.appearance} compact`).not.toBe(selection.activeTabBackground)
    }
    expect(colorAlpha(selection.activeFileRowBackground), `${selection.appearance} compact content`).toBe(0)
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
    const activeFileFrame = activeFileRow.closest<HTMLElement>('.code-file-tree-row-frame')!
    return {
      tabStripBackground: getComputedStyle(tabStrip).backgroundColor,
      tabsBackground: getComputedStyle(tabs).backgroundColor,
      activeTabBackground: getComputedStyle(activeTab).backgroundColor,
      activeTabColor: getComputedStyle(activeTab).color,
      activeIconBackground: getComputedStyle(activeIcon).backgroundColor,
      activeIconFilter: getComputedStyle(activeIcon).filter,
      activeIconTag: activeIcon.tagName,
      inactiveTabBackground: getComputedStyle(inactiveTab).backgroundColor,
      inactiveTabColor: getComputedStyle(inactiveTab).color,
      inactiveIconBackground: getComputedStyle(inactiveIcon).backgroundColor,
      inactiveIconFilter: getComputedStyle(inactiveIcon).filter,
      inactiveIconTag: inactiveIcon.tagName,
      activeActionBackground: getComputedStyle(activeAction).backgroundColor,
      inactiveActionBackground: getComputedStyle(inactiveAction).backgroundColor,
      activeTabBorderRadius: getComputedStyle(activeTab).borderRadius,
      activeTabBoxShadow: getComputedStyle(activeTab).boxShadow,
      activeTabSeamColor: getComputedStyle(activeTab, '::after').backgroundColor,
      activeFileRowBackground: getComputedStyle(activeFileFrame).backgroundColor,
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
  expect(paperHeader.activeIconTag).toBe('IMG')
  expect(paperHeader.inactiveIconTag).toBe('IMG')
  expect(paperHeader.activeIconBackground).toBe('rgba(0, 0, 0, 0)')
  expect(paperHeader.inactiveIconBackground).toBe('rgba(0, 0, 0, 0)')
  expect(paperHeader.activeIconFilter).toBe('none')
  expect(paperHeader.inactiveIconFilter).toBe('none')
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
