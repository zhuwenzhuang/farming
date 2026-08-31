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
      const samples: Array<{ offset: number; drift: number; rows: number; visibleRows: number; interval: number }> = []
      const frame = () => new Promise<number>(resolve => requestAnimationFrame(resolve))
      scroller.scrollTop = 500
      await frame(); await frame(); await frame()
      let lastFrame = await frame()
      for (let index = 0; index < 90; index++) {
        scroller.scrollTop += index < 60 ? 17 : -23
        const now = await frame()
        const transform = getComputedStyle(windowElement).transform
        const translation = transform === 'none' ? 0 : new DOMMatrix(transform).m42
        const bounds = scroller.getBoundingClientRect()
        const headerBottom = section.querySelector('.code-files-header')!.getBoundingClientRect().bottom
        const rows = [...viewport.querySelectorAll<HTMLElement>('[data-file-path]')]
        const visibleRows = rows.filter(row => {
          const rect = row.getBoundingClientRect()
          return rect.top >= headerBottom && rect.bottom <= bounds.bottom
        }).length
        samples.push({ offset: scroller.scrollTop, drift: translation - tree.scrollTop, rows: rows.length, visibleRows, interval: now - lastFrame })
        lastFrame = now
      }
      return { samples, maximumDrift: Math.max(...samples.map(sample => Math.abs(sample.drift))), maximumRows: Math.max(...samples.map(sample => sample.rows)) }
    })
    await testInfo.attach(`${appearance}-scroll-frames`, { body: Buffer.from(JSON.stringify(result, null, 2)), contentType: 'application/json' })
    expect(result.maximumRows).toBeLessThan(100)
    expect(result.maximumDrift).toBeLessThanOrEqual(1)
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
