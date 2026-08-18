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

const STRESS_SEED = 0x5eedc0de

function seededRandom(seed: number) {
  let state = seed >>> 0
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 0x1_0000_0000
  }
}

function shuffled<T>(values: readonly T[], random: () => number) {
  const result = [...values]
  for (let index = result.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1))
    ;[result[index], result[target]] = [result[target], result[index]]
  }
  return result
}

test('survives seeded cold and warm human Project Files interactions', {
  tag: ['@critical-behavior', '@behavior-CODE-PROJECT-FILES-HUMAN-STRESS'],
}, async ({ page }, testInfo) => {
  const workspaceRoot = path.join(PLAYWRIGHT_WORKSPACE_ROOT, 'project-files-human-stress')
  const filesByDirectory = {
    alpha: ['model.cpp', 'model.h'],
    beta: ['notes.md', 'state.txt'],
    gamma: ['config.json', 'tool.ts'],
  } as const
  const directories = Object.keys(filesByDirectory) as Array<keyof typeof filesByDirectory>
  const filePaths = directories.flatMap(directory => (
    filesByDirectory[directory].map(fileName => `${directory}/${fileName}`)
  ))
  fs.rmSync(workspaceRoot, { recursive: true, force: true })
  for (const directory of directories) {
    fs.mkdirSync(path.join(workspaceRoot, directory), { recursive: true })
    for (const fileName of filesByDirectory[directory]) {
      const filePath = `${directory}/${fileName}`
      fs.writeFileSync(path.join(workspaceRoot, filePath), `${filePath}\n${'content '.repeat(256)}\n`)
    }
  }

  const random = seededRandom(STRESS_SEED)
  const operations: Array<Record<string, unknown>> = []
  const reads = new Map<string, number>()
  const failedResponses: string[] = []
  page.on('request', request => {
    const url = new URL(request.url())
    if (!url.pathname.endsWith('/api/files/file')) return
    const filePath = url.searchParams.get('path')
    if (filePath) reads.set(filePath, (reads.get(filePath) ?? 0) + 1)
  })
  page.on('response', response => {
    const url = new URL(response.url())
    if (url.pathname.includes('/api/files/') && response.status() >= 400) {
      failedResponses.push(`${response.status()} ${response.url()}`)
    }
  })

  try {
    await openFarming(page)
    await openNewAgentDialog(page)
    await startAgentFromOpenDialog(page, 'bash', workspaceRoot)

    const project = page.getByTestId('code-project-group').filter({ hasText: path.basename(workspaceRoot) })
    await expect(project).toBeVisible({ timeout: 30_000 })
    const agentVisibility = project.getByTestId('code-project-agent-visibility')
    await expect(agentVisibility).toBeVisible()
    if (await agentVisibility.getAttribute('data-collapsed') !== 'true') {
      await project.getByTestId('code-project-title').hover({ position: { x: 40, y: 10 } })
      await agentVisibility.click({ force: true, timeout: 3_000 })
    }
    await expect(agentVisibility).toHaveAttribute('data-collapsed', 'true')
    operations.push({ action: 'collapse-agents', path: path.basename(workspaceRoot) })
    const files = project.getByTestId('code-files-section')
    const filesTitle = files.locator('.code-files-title').first()
    if (await filesTitle.getAttribute('aria-expanded') !== 'true') await filesTitle.click()
    await files.evaluate(element => {
      document.documentElement.dataset.projectFileClickAudit = '[]'
      for (const type of ['click', 'dblclick']) {
        element.addEventListener(type, event => {
          const target = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-file-path]') : null
          const audit = JSON.parse(document.documentElement.dataset.projectFileClickAudit || '[]') as unknown[]
          audit.push({ type, detail: (event as MouseEvent).detail, path: target?.dataset.filePath ?? null })
          document.documentElement.dataset.projectFileClickAudit = JSON.stringify(audit)
        })
      }
    })

    const setDirectoryExpanded = async (directory: string, expanded: boolean) => {
      const row = files.locator(`[data-testid="code-file-row"][data-file-path="${directory}"]`)
      await row.scrollIntoViewIfNeeded()
      const visibleDirectory = files.locator([
        `[data-testid="code-file-sticky-row"][data-sticky-file-path="${directory}"]`,
        `[data-testid="code-file-row"][data-file-path="${directory}"]`,
      ].join(', ')).first()
      await visibleDirectory.click({ timeout: 3_000 })
      if (await row.getAttribute('aria-expanded') !== String(expanded)) {
        await expect(row).toHaveClass(/selected/, { timeout: 3_000 })
        await page.keyboard.press(expanded ? 'ArrowRight' : 'ArrowLeft')
      }
      await expect(row).toHaveAttribute('aria-expanded', String(expanded), { timeout: 3_000 })
    }

    for (const directory of shuffled(directories, random)) {
      await setDirectoryExpanded(directory, true)
      operations.push({ action: 'expand', path: directory })
    }
    for (const directory of shuffled(directories, random)) {
      await setDirectoryExpanded(directory, false)
      await setDirectoryExpanded(directory, true)
      operations.push({ action: 'collapse-expand', path: directory })
    }

    const humanClick = async (filePath: string, clickCount: 1 | 2) => {
      const row = files.locator(`[data-testid="code-file-row"][data-file-path="${filePath}"]`)
      await row.scrollIntoViewIfNeeded()
      const box = await row.boundingBox()
      if (!box) throw new Error(`Missing visible file row for ${filePath}`)
      await page.mouse.move(
        box.x + Math.min(box.width - 8, 42 + random() * 80),
        box.y + box.height / 2,
        { steps: 2 + Math.floor(random() * 4) },
      )
      const clickX = box.x + Math.min(box.width - 8, 42 + random() * 80)
      const clickY = box.y + box.height / 2
      const delay = 24 + Math.floor(random() * 36)
      const position = { x: clickX - box.x, y: clickY - box.y }
      if (clickCount === 2) {
        await row.dblclick({ delay, position })
      } else {
        await row.click({ delay, position })
      }
      operations.push({ action: clickCount === 2 ? 'double-click' : 'click', path: filePath })
    }

    const coldOrder = shuffled(filePaths, random)
    const editor = page.getByTestId('code-file-editor')
    const pinnedPaths: string[] = []
    for (const filePath of coldOrder.slice(0, 2)) {
      await humanClick(filePath, 2)
      const tab = editor.locator(`.code-file-editor-tab[title="${filePath}"]`)
      await expect(tab).toBeVisible()
      if (await tab.getAttribute('data-preview') === 'true') {
        const clickAudit = await page.evaluate(() => JSON.parse(
          document.documentElement.dataset.projectFileClickAudit || '[]',
        ) as unknown[])
        const tabStates = await editor.getByRole('tab').evaluateAll(tabs => tabs.map(candidate => ({
          path: candidate.getAttribute('title'),
          preview: candidate.getAttribute('data-preview') === 'true',
          selected: candidate.getAttribute('aria-selected'),
        })))
        throw new Error(`Double-click left ${filePath} in preview: ${JSON.stringify({ clickAudit, tabStates })}`)
      }
      pinnedPaths.push(filePath)
      const tabStates = await editor.getByRole('tab').evaluateAll(tabs => tabs.map(tab => ({
        path: tab.getAttribute('title'),
        preview: tab.getAttribute('data-preview') === 'true',
      })))
      const missingPinnedPath = pinnedPaths.find(pinnedPath => (
        !tabStates.some(tabState => tabState.path === pinnedPath && !tabState.preview)
      ))
      if (missingPinnedPath) {
        const clickAudit = await page.evaluate(() => JSON.parse(
          document.documentElement.dataset.projectFileClickAudit || '[]',
        ) as unknown[])
        throw new Error(`Pinned tab ${missingPinnedPath} changed after pinning ${filePath}: ${JSON.stringify({ clickAudit, tabStates })}`)
      }
    }
    for (const filePath of coldOrder.slice(2)) {
      await humanClick(filePath, 1)
      for (const pinnedPath of pinnedPaths) {
        const pinnedTab = editor.locator(`.code-file-editor-tab[title="${pinnedPath}"]`)
        await expect(pinnedTab, `Pinned tab disappeared after opening ${filePath}`).toBeVisible()
        await expect(pinnedTab).not.toHaveAttribute('data-preview', 'true')
      }
    }
    await expect(editor.getByRole('tab', { selected: true })).toHaveAttribute('title', coldOrder.at(-1)!)
    await expect.poll(() => filePaths.map(filePath => reads.get(filePath) ?? 0)).toEqual(filePaths.map(() => 1))
    await expect(page.getByTestId('code-file-editor-alert')).toHaveCount(0)

    const pinnedTabs = coldOrder.slice(0, 2).map(filePath => editor.locator(`.code-file-editor-tab[title="${filePath}"]`))
    await expect(pinnedTabs[0]).not.toHaveAttribute('data-preview', 'true')
    await expect(pinnedTabs[1]).not.toHaveAttribute('data-preview', 'true')
    await pinnedTabs[0].dragTo(pinnedTabs[1])
    operations.push({ action: 'drag-tab', path: coldOrder[0] })

    const resizer = page.getByTestId('code-sidebar-resizer')
    const resizerBox = await resizer.boundingBox()
    if (!resizerBox) throw new Error('Sidebar resizer must be measurable')
    const resizeY = resizerBox.y + Math.min(180, resizerBox.height / 2)
    await page.mouse.move(resizerBox.x + resizerBox.width / 2, resizeY)
    await page.mouse.down()
    await page.mouse.move(resizerBox.x + 96, resizeY, { steps: 8 })
    await page.mouse.up()
    operations.push({ action: 'resize-sidebar', delta: 96 })

    const warmOrder = Array.from({ length: 24 }, () => filePaths[Math.floor(random() * filePaths.length)])
    for (let index = 0; index < warmOrder.length; index += 1) {
      await humanClick(warmOrder[index], index % 7 === 0 ? 2 : 1)
    }
    const finalPath = coldOrder[0]
    await humanClick(finalPath, 1)
    await expect(editor.getByRole('tab', { selected: true })).toHaveAttribute('title', finalPath)
    await expect(editor.locator(`.code-file-editor-tab[title="${finalPath}"]`)).not.toHaveAttribute('data-preview', 'true')
    await expect(files.locator('[data-testid="code-file-row"].selected[data-file-type="file"]')).toHaveCount(1)
    await expect(page.getByTestId('code-file-editor-alert')).toHaveCount(0)
    await expect(agentVisibility).toHaveAttribute('data-collapsed', 'true')
    expect(failedResponses).toEqual([])

    const viewport = files.locator('.code-file-tree-viewport')
    await viewport.hover()
    await page.mouse.wheel(0, 420)
    await page.mouse.wheel(0, -260)
    operations.push({ action: 'scroll-tree', delta: 160 })
    await expect(page.getByTestId('code-file-editor-alert')).toHaveCount(0)
    await expect(agentVisibility).toHaveAttribute('data-collapsed', 'true')
    const editorBox = await editor.boundingBox()
    if (!editorBox) throw new Error('File editor must be measurable for visual capture')
    await page.mouse.move(editorBox.x + editorBox.width * 0.75, editorBox.y + editorBox.height * 0.75)

    const screenshotPath = testInfo.outputPath(`project-files-human-stress-${STRESS_SEED}.png`)
    await page.screenshot({ path: screenshotPath, fullPage: false })
    await testInfo.attach('project-files-human-stress-screenshot', {
      path: screenshotPath,
      contentType: 'image/png',
    })
  } finally {
    await testInfo.attach('project-files-human-stress-actions', {
      body: Buffer.from(JSON.stringify({
        seed: STRESS_SEED,
        operations,
        reads: Object.fromEntries(reads),
        failedResponses,
      }, null, 2)),
      contentType: 'application/json',
    })
  }
})
