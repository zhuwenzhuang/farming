import fs from 'node:fs'
import path from 'node:path'
import {
  expect,
  openFarming,
  PLAYWRIGHT_WORKSPACE_ROOT,
  test,
} from './fixtures'

test('keeps large expanded file trees off the warm file-switch render path', async ({ page }, testInfo) => {
  const workspaceRoot = path.join(
    PLAYWRIGHT_WORKSPACE_ROOT,
    `project-files-performance-${testInfo.repeatEachIndex}`,
  )
  fs.rmSync(workspaceRoot, { recursive: true, force: true })
  fs.mkdirSync(workspaceRoot, { recursive: true })
  for (let index = 0; index < 2_000; index += 1) {
    fs.writeFileSync(path.join(workspaceRoot, `file-${String(index).padStart(4, '0')}.txt`), `${index}\n`)
  }

  await page.addInitScript(() => {
    const originalSend = WebSocket.prototype.send
    const readStarts: Record<string, number> = {}
    const readResponses: Record<string, number> = {}
    const readPathsByRequestId = new Map<string, string>()
    const observedSockets = new WeakSet<WebSocket>()
    const performanceWindow = window as Window & {
      __farmingWorkspaceReadResponses?: Record<string, number>
      __farmingWorkspaceReadStarts?: Record<string, number>
    }
    performanceWindow.__farmingWorkspaceReadStarts = readStarts
    performanceWindow.__farmingWorkspaceReadResponses = readResponses
    WebSocket.prototype.send = function send(data) {
      if (!observedSockets.has(this)) {
        observedSockets.add(this)
        this.addEventListener('message', event => {
          if (typeof event.data !== 'string') return
          try {
            const message = JSON.parse(event.data) as { type?: string; requestId?: string }
            if (message.type !== 'workspace-result' || !message.requestId) return
            const filePath = readPathsByRequestId.get(message.requestId)
            if (!filePath) return
            readResponses[filePath] = performance.now()
            readPathsByRequestId.delete(message.requestId)
          } catch {
            // Terminal frames and extension payloads are not necessarily JSON.
          }
        })
      }
      if (typeof data === 'string') {
        try {
          const message = JSON.parse(data) as {
            type?: string
            requestId?: string
            request?: { operation?: string; path?: string }
          }
          if (message.type === 'workspace-request' && message.request?.operation === 'read-file') {
            const filePath = message.request.path ?? ''
            readStarts[filePath] = performance.now()
            if (message.requestId) readPathsByRequestId.set(message.requestId, filePath)
          }
        } catch {
          // Terminal frames and extension payloads are not necessarily JSON.
        }
      }
      return originalSend.call(this, data)
    }
  })

  const mount = await page.request.post('/farming/api/projects/mount', { data: { workspace: workspaceRoot } })
  expect(mount.ok()).toBe(true)
  await openFarming(page)

  const project = page.getByTestId('code-project-group').filter({ hasText: path.basename(workspaceRoot) })
  await expect(project).toBeVisible({ timeout: 30_000 })
  const files = project.getByTestId('code-files-section')
  const filesTitle = files.locator('.code-files-title').first()
  if (await filesTitle.getAttribute('aria-expanded') !== 'true') await filesTitle.click()
  await expect(files.getByTestId('code-file-row')).toHaveCount(2_000)

  const firstPath = 'file-0000.txt'
  const secondPath = 'file-0001.txt'
  const editor = page.getByTestId('code-file-editor')
  const measureFilePaint = async (filePath: string, expectedContent: string) => {
    const row = files.locator(`[data-file-path="${filePath}"]`)
    return row.evaluate((element, expected) => (
      new Promise<{
        contentMs: number
        paintMs: number
        requestMs: number | null
        responseToSelectedMs: number | null
        rowSelectedMs: number
        selectedMs: number
      }>((resolve, reject) => {
        const startedAt = performance.now()
        const readStarts = (window as Window & { __farmingWorkspaceReadStarts?: Record<string, number> })
          .__farmingWorkspaceReadStarts
        const readResponses = (window as Window & {
          __farmingWorkspaceReadResponses?: Record<string, number>
        }).__farmingWorkspaceReadResponses
        if (readStarts) delete readStarts[expected.path]
        if (readResponses) delete readResponses[expected.path]
        let rowSelectedAt: number | null = null
        let selectedAt: number | null = null
        const inspect = () => {
          const selectedTab = document.querySelector<HTMLElement>('.code-file-editor-tab[aria-selected="true"]')
          const monacoText = document.querySelector<HTMLElement>('.monaco-editor .view-lines')?.textContent ?? ''
          const fallbackText = document.querySelector<HTMLTextAreaElement>('[data-testid="code-file-editor-fallback-textarea"]')?.value ?? ''
          const editorText = monacoText || fallbackText
          if (element.classList.contains('selected') && rowSelectedAt === null) rowSelectedAt = performance.now()
          if (selectedTab?.title === expected.path && selectedAt === null) selectedAt = performance.now()
          if (rowSelectedAt !== null && selectedAt !== null && editorText.trim() === expected.content) {
            const contentAt = performance.now()
            requestAnimationFrame(() => resolve({
              selectedMs: selectedAt! - startedAt,
              requestMs: readStarts?.[expected.path] === undefined
                ? null
                : readStarts[expected.path]! - startedAt,
              responseToSelectedMs: readResponses?.[expected.path] === undefined
                ? null
                : selectedAt! - readResponses[expected.path]!,
              rowSelectedMs: rowSelectedAt! - startedAt,
              contentMs: contentAt - startedAt,
              paintMs: performance.now() - startedAt,
            }))
            return
          }
          if (performance.now() - startedAt > 2_000) {
            reject(new Error(`File switch did not paint ${expected.path}`))
            return
          }
          requestAnimationFrame(inspect)
        }
        ;(element as HTMLElement).click()
        requestAnimationFrame(inspect)
      })
    ), { path: filePath, content: expectedContent })
  }
  await page.evaluate(() => window.__farmingPerformanceTest?.reset())
  const coldSwitchDurations = [
    await measureFilePaint(firstPath, '0'),
    await measureFilePaint(secondPath, '1'),
  ]
  const coldRenderCounts = await page.evaluate(() => window.__farmingPerformanceTest?.snapshot())
  await testInfo.attach('cold-file-switch-latency', {
    body: Buffer.from(JSON.stringify({
      coldSamplesMs: coldSwitchDurations,
      coldRenderCounts,
    }, null, 2)),
    contentType: 'application/json',
  })
  for (const sample of coldSwitchDurations) {
    expect(sample.requestMs).not.toBeNull()
    expect(sample.requestMs!).toBeLessThan(50)
    expect(sample.rowSelectedMs).toBeLessThan(100)
    expect(sample.responseToSelectedMs).not.toBeNull()
    expect(sample.responseToSelectedMs!).toBeGreaterThanOrEqual(0)
    expect(sample.responseToSelectedMs!).toBeLessThan(150)
    // End-to-end cold time still bounds the read plus commit; the response-to-
    // selection metric above isolates the frontend commit from runner I/O.
    expect(sample.contentMs).toBeLessThan(500)
  }
  expect(coldRenderCounts?.fileTreeRow).toBeLessThanOrEqual(16)
  await files.locator(`[data-file-path="${firstPath}"]`).dblclick()
  await files.locator(`[data-file-path="${secondPath}"]`).dblclick()
  const firstTab = editor.locator(`[role="tab"][title="${firstPath}"]`)
  const secondTab = editor.locator(`[role="tab"][title="${secondPath}"]`)
  await expect(firstTab).toBeVisible()
  await expect(secondTab).toBeVisible()

  await page.evaluate(() => window.__farmingPerformanceTest?.reset())
  await firstTab.click()
  await expect(firstTab).toHaveAttribute('aria-selected', 'true')
  await secondTab.click()
  await expect(secondTab).toHaveAttribute('aria-selected', 'true')
  const renderCounts = await page.evaluate(() => window.__farmingPerformanceTest?.snapshot())

  expect(renderCounts?.fileTreeRow).toBeLessThanOrEqual(12)
  await expect(files.locator(`[data-file-path="${firstPath}"]`)).not.toHaveClass(/active/)
  await expect(files.locator(`[data-file-path="${secondPath}"]`)).toHaveClass(/active/)

  await page.evaluate(() => window.__farmingPerformanceTest?.reset())
  const warmSwitchDurations: Array<{
    contentMs: number
    paintMs: number
    requestMs: number | null
    responseToSelectedMs: number | null
    rowSelectedMs: number
    selectedMs: number
  }> = []
  for (let index = 0; index < 64; index += 1) {
    const expectedPath = index % 2 === 0 ? firstPath : secondPath
    const expectedContent = index % 2 === 0 ? '0' : '1'
    warmSwitchDurations.push(await measureFilePaint(expectedPath, expectedContent))
  }
  const warmRenderCounts = await page.evaluate(() => window.__farmingPerformanceTest?.snapshot())
  const percentile95 = (samples: number[]) => {
    const sorted = [...samples].sort((left, right) => left - right)
    return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY
  }
  const warmP95 = {
    selectedMs: percentile95(warmSwitchDurations.map(sample => sample.selectedMs)),
    rowSelectedMs: percentile95(warmSwitchDurations.map(sample => sample.rowSelectedMs)),
    contentMs: percentile95(warmSwitchDurations.map(sample => sample.contentMs)),
    paintMs: percentile95(warmSwitchDurations.map(sample => sample.paintMs)),
  }
  const warmMax = {
    selectedMs: Math.max(...warmSwitchDurations.map(sample => sample.selectedMs)),
    rowSelectedMs: Math.max(...warmSwitchDurations.map(sample => sample.rowSelectedMs)),
    contentMs: Math.max(...warmSwitchDurations.map(sample => sample.contentMs)),
    paintMs: Math.max(...warmSwitchDurations.map(sample => sample.paintMs)),
  }
  await testInfo.attach('warm-file-switch-latency', {
    body: Buffer.from(JSON.stringify({
      coldSamplesMs: coldSwitchDurations,
      warmSamplesMs: warmSwitchDurations,
      warmP95Ms: warmP95,
      warmMaxMs: warmMax,
    }, null, 2)),
    contentType: 'application/json',
  })
  expect(warmP95.selectedMs).toBeLessThan(50)
  expect(warmP95.rowSelectedMs).toBeLessThan(50)
  expect(warmP95.contentMs).toBeLessThan(60)
  expect(warmP95.paintMs).toBeLessThan(100)
  expect(warmMax.selectedMs).toBeLessThan(150)
  expect(warmMax.rowSelectedMs).toBeLessThan(150)
  expect(warmMax.contentMs).toBeLessThan(250)
  expect(warmMax.paintMs).toBeLessThan(300)
  expect(warmSwitchDurations.every(sample => sample.requestMs === null)).toBe(true)
  // Each switch has two intentional phases: selection feedback, then active
  // editor commit. Only the old and new rows may render in either phase.
  expect(warmRenderCounts?.fileTreeRow).toBeLessThanOrEqual(272)
  await expect(files.locator('[data-testid="code-file-row"].selected[data-file-type="file"]')).toHaveCount(1)
  await expect(files.locator(`[data-file-path="${secondPath}"]`)).toHaveClass(/selected/)
  await firstTab.click()
  await expect(files.locator(`[data-file-path="${firstPath}"]`)).toHaveClass(/active/)
  const firstRow = files.locator(`[data-file-path="${firstPath}"]`)
  const secondRow = files.locator(`[data-file-path="${secondPath}"]`)
  const tree = files.locator('[role="tree"]')
  await tree.focus()
  await page.keyboard.press('Home')
  await expect(firstRow).toHaveClass(/selected/)
  await secondRow.click({ modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'] })
  await expect(files.locator('[data-testid="code-file-row"].selected[data-file-type="file"]')).toHaveCount(2)
  await expect(firstRow).toHaveClass(/active/)
  await secondRow.click()
  await expect(files.locator('[data-testid="code-file-row"].selected[data-file-type="file"]')).toHaveCount(1)
  await expect(secondRow).toHaveClass(/active/)
})
