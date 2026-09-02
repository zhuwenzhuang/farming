import fs from 'node:fs'
import path from 'node:path'
import { expect, openFarming, test } from './fixtures'

// Keep each appearance's 90 real animation frames in its own bounded test.
// Software-rendered Linux WebKit can take about 36 seconds for that sample.
for (const appearance of ['light', 'dark', 'paper'] as const) {
  test(`large file tree preserves native scroll geometry on every frame in ${appearance} @native-file-scroll`, async ({ page, workspaceRoot, isMobile, browserName }, testInfo) => {
    testInfo.setTimeout(90_000)
    const workspace = path.join(workspaceRoot, `native-file-scrolling-${appearance}`)
    fs.mkdirSync(path.join(workspace, 'sources'), { recursive: true })
    for (let index = 0; index < 2_000; index++) {
      fs.writeFileSync(path.join(workspace, 'sources', `module-${String(index).padStart(4, '0')}.ts`), `export const value = ${index}\n`)
    }
    const response = await page.request.post('/farming/api/control/agents', { data: { command: 'bash', workspace, name: 'Scroll sample' } })
    expect(response.ok()).toBeTruthy()
    await openFarming(page)
    const sidebar = page.getByTestId('code-sidebar')
    if (await sidebar.evaluate(element => element.classList.contains('collapsed'))) await page.getByTestId('code-mobile-menu').click()
    const project = page.getByTestId('code-project-group').filter({ hasText: path.basename(workspace) })
    const files = project.getByTestId('code-files-section')
    const title = files.locator('.code-files-title')
    if (await title.getAttribute('aria-expanded') !== 'true') await title.click()
    const directory = files.locator('[data-file-path="sources"]')
    if (isMobile) await directory.tap()
    else await directory.click()
    await expect(files.locator('.code-file-tree-viewport')).toHaveAttribute('data-visible-row-count', '2001')
    await expect.poll(() => files.locator('[data-file-path]').count()).toBeLessThan(100)

    await page.evaluate(value => {
      document.body.dataset.appearance = value
      document.documentElement.dataset.appearance = value
    }, appearance)
    const result = await files.evaluate(async section => {
      const scroller = section.closest<HTMLElement>('.code-project-list')!
      const viewport = section.querySelector<HTMLElement>('.code-file-tree-viewport')!
      const windowElement = section.querySelector<HTMLElement>('.code-file-tree-window')!
      const tree = section.querySelector<HTMLElement>('.code-file-tree')!
      const rowHeight = Number.parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue('--code-sidebar-file-row-height'),
      )
      const originalGetBoundingClientRect = Element.prototype.getBoundingClientRect
      let auditRowLayoutReads = true
      let fileRowLayoutReads = 0
      Element.prototype.getBoundingClientRect = function (...args) {
        if (
          auditRowLayoutReads
          && this instanceof HTMLElement
          && (this.matches('[data-testid="code-file-row"]') || this.matches('.code-file-tree-row-frame'))
        ) {
          fileRowLayoutReads += 1
        }
        return originalGetBoundingClientRect.apply(this, args)
      }
      const samples: Array<{
        offset: number
        rows: number
        visibleRows: number
        interval: number
        physicalOffsetError: number
        treeScrollTop: number
        treeTransform: string
      }> = []
      const frame = () => new Promise<number>(resolve => requestAnimationFrame(resolve))
      try {
        scroller.scrollTop = 500
        await frame(); await frame(); await frame()
        let lastFrame = await frame()
        for (let index = 0; index < 90; index++) {
          scroller.scrollTop += index < 60 ? 17 : -23
          const now = await frame()
          auditRowLayoutReads = false
          const bounds = scroller.getBoundingClientRect()
          const viewportBounds = viewport.getBoundingClientRect()
          const headerBottom = section.querySelector('.code-files-header')!.getBoundingClientRect().bottom
          const rows = [...viewport.querySelectorAll<HTMLElement>('[data-file-path]')]
          const sample = rows.find(row => row.dataset.filePath?.includes('module-'))
          const sampleMatch = sample?.dataset.filePath?.match(/module-(\d+)\.ts$/)
          const sampleIndex = sampleMatch ? Number(sampleMatch[1]) + 1 : -1
          const physicalOffsetError = sample && sampleIndex >= 0
            ? Math.abs(sample.getBoundingClientRect().top - (viewportBounds.top + sampleIndex * rowHeight))
            : Number.POSITIVE_INFINITY
          const visibleRows = rows.filter(row => {
            const rect = row.getBoundingClientRect()
            return rect.top >= headerBottom && rect.bottom <= bounds.bottom
          }).length
          samples.push({
            offset: scroller.scrollTop,
            rows: rows.length,
            visibleRows,
            interval: now - lastFrame,
            physicalOffsetError,
            treeScrollTop: tree.scrollTop,
            treeTransform: getComputedStyle(windowElement).transform,
          })
          auditRowLayoutReads = true
          lastFrame = now
        }
        // Let the row-range update for the final offset settle before asserting
        // mounting coverage; per-frame samples already prove each mounted row
        // stays in the outer scroller's coordinates.
        await frame(); await frame(); await frame()
        auditRowLayoutReads = false
      } finally {
        Element.prototype.getBoundingClientRect = originalGetBoundingClientRect
      }
      const settledBounds = scroller.getBoundingClientRect()
      const settledViewportBounds = viewport.getBoundingClientRect()
      const settledHeaderBottom = section.querySelector('.code-files-header')!.getBoundingClientRect().bottom
      const settledRows = [...viewport.querySelectorAll<HTMLElement>('[data-file-path]')]
      const mountedIndexes = settledRows.map(row => {
        if (row.dataset.filePath === 'sources') return 0
        const match = row.dataset.filePath?.match(/module-(\d+)\.ts$/)
        return match ? Number(match[1]) + 1 : -1
      }).filter(rowIndex => rowIndex >= 0)
      const visibleStartIndex = Math.floor(Math.max(0, settledBounds.top - settledViewportBounds.top) / rowHeight)
      // The outer Project scroller is the only scroll surface on the path from
      // a mounted row upward; the virtualizer DOM must not add a second one.
      const scrollSurfaces: string[] = []
      const mountedRow = viewport.querySelector<HTMLElement>('[data-testid="code-file-row"]')
      for (let ancestor = mountedRow?.parentElement; ancestor; ancestor = ancestor.parentElement) {
        const overflowY = getComputedStyle(ancestor).overflowY
        if (overflowY === 'auto' || overflowY === 'scroll') {
          scrollSurfaces.push(ancestor.className)
        }
        if (ancestor === scroller) break
      }
      return {
        samples,
        fileRowLayoutReads,
        maximumPhysicalOffsetError: Math.max(...samples.map(sample => sample.physicalOffsetError)),
        maximumRows: Math.max(...samples.map(sample => sample.rows)),
        mountedIncludesVisibleStart: mountedIndexes.length > 0
          && Math.min(...mountedIndexes) <= visibleStartIndex
          && Math.max(...mountedIndexes) >= visibleStartIndex,
        hasVisibleMountedTarget: settledRows.some(row => {
          const bounds = row.getBoundingClientRect()
          return bounds.top >= settledHeaderBottom && bounds.bottom <= settledBounds.bottom
        }),
        scrollSurfaces,
      }
    })
    await testInfo.attach(`${appearance}-scroll-frames`, { body: Buffer.from(JSON.stringify(result, null, 2)), contentType: 'application/json' })
    expect(result.fileRowLayoutReads).toBe(0)
    expect(result.maximumRows).toBeLessThan(100)
    expect(result.maximumPhysicalOffsetError).toBeLessThanOrEqual(1)
    expect(result.samples.every(sample => sample.treeScrollTop === 0)).toBe(true)
    expect(result.samples.every(sample => sample.treeTransform === 'none')).toBe(true)
    expect(result.mountedIncludesVisibleStart).toBe(true)
    expect(result.hasVisibleMountedTarget).toBe(true)
    expect(result.scrollSurfaces).toHaveLength(1)
    expect(result.scrollSurfaces[0]).toContain('code-project-list')
    expect(Math.min(...result.samples.map(sample => sample.visibleRows))).toBeGreaterThan(3)
    // Native browser wheel input also has to reach the outer owner when it
    // starts over a file row; a hidden inner scroller must not consume it.
    const scroller = page.getByTestId('code-project-list')
    const scrollBeforeWheel = await scroller.evaluate(element => element.scrollTop)
    const box = await scroller.boundingBox()
    expect(box).not.toBeNull()
    if (!isMobile) {
      await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height * 0.7)
      await page.mouse.wheel(0, 240)
      await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBeGreaterThan(scrollBeforeWheel + 100)
    } else if (browserName === 'chromium') {
      const session = await page.context().newCDPSession(page)
      try {
        const x = box!.x + box!.width / 2
        const y = box!.y + box!.height * 0.8
        await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
        for (let step = 1; step <= 12; step++) {
          await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - 20 * step }] })
          await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)))
        }
        await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
        await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBeGreaterThan(scrollBeforeWheel + 100)
      } finally {
        await session.detach()
      }
    }
    // Mobile WebKit exposes tap, but no wheel or native swipe API. Its frame
    // geometry and final touch activation are verified without faking a swipe.
    await expect.poll(() => files.locator('.code-file-tree').evaluate(element => element.scrollTop)).toBe(0)
    await sidebar.screenshot({ path: testInfo.outputPath(`${appearance}-native-scroll.png`), animations: 'disabled' })
    // A new virtual range still owns ordinary file activation after scrolling.
    const visiblePath = await files.evaluate(section => {
      const scroller = section.closest<HTMLElement>('.code-project-list')!
      const bounds = scroller.getBoundingClientRect()
      const rows = [...section.querySelectorAll<HTMLElement>('[data-file-type="file"]')]
      return rows.find(row => {
        const rect = row.getBoundingClientRect()
        return rect.top >= bounds.top + bounds.height * 0.6 && rect.bottom < bounds.bottom
      })?.dataset.filePath
    })
    expect(visiblePath).toBeTruthy()
    const row = files.locator(`[data-file-path="${visiblePath}"]`)
    if (isMobile) await row.tap()
    else await row.click()
    await expect(page.getByTestId('code-file-editor')).toBeVisible()
    await expect(page.getByTestId('code-file-editor')).toContainText(path.basename(visiblePath!))
  })
}
