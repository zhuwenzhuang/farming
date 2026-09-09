import fs from 'node:fs'
import path from 'node:path'
import type { Locator } from '@playwright/test'
import { expect, openFarming, test } from './fixtures'

async function expectDiagramFits(container: Locator) {
  await expect.poll(() => container.evaluate(element => {
    const viewport = element.querySelector('.code-markdown-mermaid-viewport')!
    const canvas = element.querySelector('.code-markdown-mermaid-canvas') as HTMLElement
    const svg = canvas?.querySelector('svg')
    if (!svg || !canvas.style.width) return false
    const bounds = svg.getBoundingClientRect()
    const frame = viewport.getBoundingClientRect()
    const padding = getComputedStyle(viewport)
    const width = viewport.clientWidth - parseFloat(padding.paddingLeft) - parseFloat(padding.paddingRight)
    return bounds.width > 0 && bounds.height > 0 && bounds.width <= width + 1
      && bounds.left >= frame.left && bounds.right <= frame.right + 1
      && bounds.top >= frame.top && bounds.bottom <= frame.bottom + 1
  })).toBe(true)
}

for (const appearance of ['light', 'dark', 'paper'] as const) {
  test(`unifies streaming rich content and fullscreen inspection in ${appearance}`, async ({ page, workspaceRoot }) => {
    test.setTimeout(120_000)
    const workspace = path.join(workspaceRoot, `rich-content-${appearance}`)
    fs.mkdirSync(workspace, { recursive: true })
    const gate = path.join(workspace, '.rich-content-stage')
    const response = await page.request.post('/farming/api/control/agents', {
      data: { command: appearance === 'dark' ? 'codex' : appearance === 'paper' ? 'qwen' : 'claude', workspace, agentRuntimeMode: 'chat' },
    })
    expect(response.ok()).toBeTruthy()
    const { agentId } = await response.json() as { agentId: string }
    try {
      await openFarming(page)
      await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
      await page.evaluate(value => { document.body.dataset.appearance = value }, appearance)
      await page.evaluate(() => {
        const errors: string[] = []
        const observer = new MutationObserver(() => {
          for (const error of document.querySelectorAll('.code-markdown-mermaid.error, .katex-error')) errors.push(error.textContent || '')
        })
        observer.observe(document.body, { childList: true, subtree: true, attributes: true })
        Object.assign(window, { richContentAudit: { errors, stop: () => observer.disconnect() } })
      })
      const input = page.getByTestId('code-acp-composer-input')
      await input.fill('streaming rich content')
      await page.getByTestId('code-acp-composer-send').click()
      const answer = page.locator('.code-agent-transcript-answer').last()
      const diagram = answer.locator('.code-markdown-mermaid').first()
      await expect(diagram).toHaveAttribute('data-render-state', 'streaming')
      await expect(diagram).toContainText('Generating diagram')
      await expect(diagram.locator('pre')).toHaveCount(0)
      await page.screenshot({ path: test.info().outputPath(`streaming-${appearance}.png`) })
      fs.writeFileSync(gate, '1')
      await expect(diagram).toHaveAttribute('data-render-state', 'ready')
      await expect(answer.locator('[data-math-pending]')).toBeVisible()
      await expectDiagramFits(diagram)
      await page.screenshot({ path: test.info().outputPath(`inline-${appearance}.png`) })
      const expand = diagram.getByRole('button', { name: 'Open fullscreen diagram' })
      const inlineIcon = await expand.locator('svg').boundingBox()
      const inlineHeight = (await diagram.boundingBox())!.height
      await expand.click()
      const viewer = page.getByRole('dialog', { name: 'Mermaid diagram', exact: true })
      await expect(viewer).toBeVisible()
      await expect(page.locator('#root')).toHaveAttribute('inert', '')
      await expect(viewer.getByRole('button', { name: 'Close fullscreen diagram' })).toBeFocused()
      await expect.poll(() => viewer.locator('.code-markdown-mermaid-canvas').evaluate(element => (element as HTMLElement).style.width)).not.toBe('')
      const metrics = await viewer.evaluate(element => {
        const canvas = element.querySelector('.code-markdown-mermaid-canvas')!
        const svg = canvas.querySelector('svg')!
        const bounds = svg.getBoundingClientRect()
        const viewport = element.querySelector('.code-markdown-mermaid-viewport')!.getBoundingClientRect()
        const rect = svg.querySelector('.node rect')!
        return { svgWidth: bounds.width, canvasWidth: canvas.getBoundingClientRect().width,
          inside: bounds.left >= viewport.left && bounds.right <= viewport.right + 1 && bounds.top >= viewport.top && bounds.bottom <= viewport.bottom + 1,
          iconWidth: element.querySelector('button svg')!.getBoundingClientRect().width,
          stroke: getComputedStyle(rect).stroke }
      })
      expect(Math.abs(metrics.svgWidth - metrics.canvasWidth)).toBeLessThan(1)
      expect(metrics.inside).toBe(true)
      expect(metrics.iconWidth).toBe(16)
      expect(inlineIcon?.width).toBe(metrics.iconWidth)
      expect(metrics.stroke).not.toBe('rgba(0, 0, 0, 0)')
      expect(Math.abs((await diagram.boundingBox())!.height - inlineHeight)).toBeLessThan(1)
      const backgroundHit = await input.evaluate(element => {
        const rect = element.getBoundingClientRect()
        return Boolean(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.closest('.code-content-viewer'))
      })
      expect(backgroundHit).toBe(true)
      for (let index = 0; index < 8; index += 1) {
        await page.keyboard.press('Tab')
        expect(await viewer.evaluate(element => element.contains(document.activeElement))).toBe(true)
      }
      await page.screenshot({ path: test.info().outputPath(`fullscreen-${appearance}.png`) })
      await viewer.getByRole('button', { name: 'Zoom in', exact: true }).click()
      const transform = await viewer.locator('.code-markdown-mermaid-gesture-content').evaluate(element => (element as HTMLElement).style.transform)
      await viewer.getByRole('button', { name: 'Toggle pan mode' }).click()
      const viewport = viewer.locator('.code-markdown-mermaid-viewport')
      const box = (await viewport.boundingBox())!
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      const beforePan = await viewer.locator('.code-markdown-mermaid-gesture-content').evaluate(element => {
        const matrix = new DOMMatrix(getComputedStyle(element).transform)
        return { x: matrix.e, y: matrix.f }
      })
      await page.mouse.down()
      await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2 + 25)
      await page.mouse.up()
      const afterPan = await viewer.locator('.code-markdown-mermaid-gesture-content').evaluate(element => {
        const matrix = new DOMMatrix(getComputedStyle(element).transform)
        return { x: matrix.e, y: matrix.f }
      })
      expect(afterPan.x - beforePan.x).toBeCloseTo(40, 0)
      expect(afterPan.y - beforePan.y).toBeCloseTo(25, 0)
      expect(await viewer.locator('.code-markdown-mermaid-gesture-viewport').evaluate(element => {
        const event = new WheelEvent('wheel', { deltaY: -100, ctrlKey: true, bubbles: true, cancelable: true })
        element.dispatchEvent(event)
        return event.defaultPrevented
      })).toBe(true)
      await viewer.getByRole('button', { name: 'Fit diagram to view' }).click()
      const svgBefore = (await viewer.locator('.code-markdown-mermaid-canvas > svg').boundingBox())!
      const point = { x: svgBefore.x + svgBefore.width * 0.3, y: svgBefore.y + svgBefore.height * 0.4 }
      await page.mouse.move(point.x, point.y)
      await page.keyboard.down('Control')
      await page.mouse.wheel(0, -100)
      await page.keyboard.up('Control')
      await expect.poll(async () => (await viewer.locator('.code-markdown-mermaid-canvas > svg').boundingBox())!.width).toBeGreaterThan(svgBefore.width)
      const svgAfter = (await viewer.locator('.code-markdown-mermaid-canvas > svg').boundingBox())!
      expect((point.x - svgAfter.x) / svgAfter.width).toBeCloseTo(0.3, 2)
      expect((point.y - svgAfter.y) / svgAfter.height).toBeCloseTo(0.4, 2)
      // Unmodified wheel input is not consumed by the diagram.
      expect(await viewer.locator('.code-markdown-mermaid-gesture-viewport').evaluate(element => {
        const event = new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true })
        element.dispatchEvent(event)
        return event.defaultPrevented
      })).toBe(false)
      await viewer.getByRole('button', { name: 'Fit diagram to view' }).click()
      await page.mouse.dblclick(point.x, point.y)
      await expect.poll(async () => (await viewer.locator('.code-markdown-mermaid-canvas > svg').boundingBox())!.width).toBeGreaterThan(svgBefore.width)
      const afterDoubleClick = (await viewer.locator('.code-markdown-mermaid-canvas > svg').boundingBox())!
      expect((point.x - afterDoubleClick.x) / afterDoubleClick.width).toBeCloseTo(0.3, 2)
      await viewer.getByRole('button', { name: 'Fit diagram to view' }).click()
      await viewer.getByRole('button', { name: 'Zoom in', exact: true }).click()
      const alternate = appearance === 'paper' ? 'dark' : 'paper'
      await page.evaluate(value => { document.body.dataset.appearance = value }, alternate)
      await expect(viewer.locator(`.code-markdown-mermaid-canvas > svg[id*="-${alternate}-"]`)).toBeVisible()
      await expect(viewer.locator('.code-markdown-mermaid-gesture-content')).toHaveCSS('transform', /1\.2/)
      fs.writeFileSync(gate, '2')
      await expect(answer.locator('.katex')).toBeVisible()
      await expect(answer.locator('table')).toBeVisible()
      await expect(answer.locator('code.language-ts')).toBeVisible()
      await expect(answer.locator('.code-markdown-mermaid').last()).toHaveAttribute('data-render-state', 'streaming')
      expect(await viewer.locator('.code-markdown-mermaid-gesture-content').evaluate(element => (element as HTMLElement).style.transform)).toBe(transform)
      const transientErrors = await page.evaluate(() => {
        const audit = (window as typeof window & { richContentAudit: { errors: string[]; stop: () => void } }).richContentAudit
        audit.stop()
        return audit.errors
      })
      expect(transientErrors).toEqual([])
      await page.keyboard.press('Escape')
      await expect(viewer).toHaveCount(0)
      await expect(expand).toBeFocused()
      await expect(diagram.locator('.code-markdown-mermaid-gesture-content')).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)')
      await expect(page.locator('#root')).not.toHaveAttribute('inert')
      fs.writeFileSync(gate, '3')
      const invalid = answer.locator('.code-markdown-mermaid').last()
      await expect(invalid).toHaveAttribute('data-render-state', 'error')
      await expect(invalid.locator('details')).not.toHaveAttribute('open')
      await invalid.locator('summary').click()
      await expect(invalid.locator('pre code')).toHaveText('this is not a diagram')
      await invalid.getByRole('button', { name: 'Retry', exact: true }).click()
      await expect(invalid).toHaveAttribute('data-render-state', 'error')
      await page.evaluate(value => { document.body.dataset.appearance = value }, appearance)
      await diagram.scrollIntoViewIfNeeded()
      await page.screenshot({ path: test.info().outputPath(`completed-${appearance}.png`) })
      // Resizing an existing transcript keeps the viewer operable.
      await page.setViewportSize({ width: 320, height: 740 })
      await diagram.scrollIntoViewIfNeeded()
      await expand.click()
      await expect(viewer).toBeVisible()
      await expect(viewer.getByRole('button', { name: 'Close fullscreen diagram' })).toBeInViewport()
      expect(await viewer.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
      await expectDiagramFits(viewer)
      await page.screenshot({ path: test.info().outputPath(`fullscreen-narrow-${appearance}.png`) })
      await viewer.getByRole('button', { name: 'Actual size (100%)', exact: true }).click()
      await expect.poll(() => viewer.locator('.code-markdown-mermaid-canvas > svg').evaluate(svg => svg.getBoundingClientRect().width / (svg as SVGSVGElement).viewBox.baseVal.width)).toBeGreaterThan(0.99)
      await page.keyboard.press('Escape')
    } finally {
      fs.writeFileSync(gate, '3')
      await page.request.delete(`/farming/api/control/agents/${agentId}`)
      fs.rmSync(gate, { force: true })
    }
  })
}

test.describe('initial touch inspection', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  test('opens a fitted viewer on initial touch load and preserves interrupted content', async ({ page, workspaceRoot, browserName }) => {
    test.setTimeout(90_000)
    const workspace = path.join(workspaceRoot, 'rich-content-touch')
    fs.mkdirSync(workspace, { recursive: true })
    const response = await page.request.post('/farming/api/control/agents', {
      data: { command: 'claude', workspace, agentRuntimeMode: 'chat' },
    })
    const { agentId } = await response.json() as { agentId: string }
    try {
      await openFarming(page)
      await page.getByTestId('code-mobile-menu').tap()
      await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).tap()
      await page.evaluate(() => { document.body.dataset.appearance = 'paper' })
      const input = page.getByTestId('code-acp-composer-input')
      await input.fill('streaming rich content')
      await page.getByTestId('code-acp-composer-send').tap()
      const pending = page.locator('.code-markdown-mermaid').last()
      await expect(pending).toHaveAttribute('data-render-state', 'streaming')
      const stop = page.getByTestId('code-acp-composer-send')
      await expect(stop).toHaveAttribute('data-action', 'interrupt')
      await stop.tap()
      await expect(pending).toHaveAttribute('data-render-state', 'interrupted')
      await expect(pending).toContainText('Diagram incomplete')
      await expect(pending.locator('pre')).toHaveCount(0)
      await input.fill('phase-aware mermaid')
      await page.getByTestId('code-acp-composer-send').tap()
      const completed = page.locator('.code-agent-transcript-answer').last().locator('.code-markdown-mermaid')
      await expect(completed).toHaveAttribute('data-render-state', 'ready')
      await expectDiagramFits(completed)
      await page.screenshot({ path: test.info().outputPath('inline-touch-paper.png') })
      const trigger = completed.getByRole('button', { name: 'Open fullscreen diagram' })
      await trigger.tap()
      const viewer = page.getByRole('dialog', { name: 'Mermaid diagram', exact: true })
      await expect(viewer).toBeVisible()
      await expect.poll(() => viewer.locator('.code-markdown-mermaid-canvas').evaluate(element => (element as HTMLElement).style.width)).not.toBe('')
      await expectDiagramFits(viewer)
      await page.screenshot({ path: test.info().outputPath('fullscreen-initial-touch-paper.png') })
      const gestureViewport = viewer.locator('.code-markdown-mermaid-gesture-viewport')
      const gestureBox = (await gestureViewport.boundingBox())!
      const center = { x: gestureBox.x + gestureBox.width / 2, y: gestureBox.y + gestureBox.height / 2 }
      const beforePinch = (await viewer.locator('.code-markdown-mermaid-canvas > svg').boundingBox())!
      if (browserName === 'chromium') {
        const cdp = await page.context().newCDPSession(page)
        try {
          const points = (distance: number) => [
            { x: center.x - distance, y: center.y, id: 1 },
            { x: center.x + distance, y: center.y, id: 2 },
          ]
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points(35) })
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points(60) })
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
        } finally { await cdp.detach() }
      } else {
        // WebKit has no CDP multi-touch API or constructible Touch; exercise
        // the touch event contract with synthetic contacts. Chromium above
        // covers browser-dispatched multi-touch input.
        await gestureViewport.evaluate((element, point) => {
          const touches = (distance: number) => [-1, 1].map((sign, index) => ({
            identifier: index, target: element, clientX: point.x + sign * distance, clientY: point.y,
            pageX: point.x + sign * distance + window.scrollX, pageY: point.y + window.scrollY,
          }))
          for (const [type, distance] of [['touchstart', 35], ['touchmove', 60], ['touchend', 0]] as const) {
            const list = distance ? touches(distance) : []
            const event = new Event(type, { bubbles: true, cancelable: true })
            Object.defineProperties(event, { touches: { value: list }, targetTouches: { value: list } })
            element.dispatchEvent(event)
          }
        }, center)
      }
      await expect.poll(async () => (await viewer.locator('.code-markdown-mermaid-canvas > svg').boundingBox())!.width).toBeGreaterThan(beforePinch.width * 1.2)
      await page.screenshot({ path: test.info().outputPath('pinch-touch-paper.png') })
      await viewer.getByRole('button', { name: 'Fit diagram to view' }).tap()
      await expectDiagramFits(viewer)
      await viewer.getByRole('button', { name: 'Zoom in', exact: true }).tap()
      const pan = viewer.getByRole('button', { name: 'Toggle pan mode' })
      await pan.tap()
      await expect(pan).toHaveAttribute('aria-pressed', 'true')
      await viewer.getByRole('button', { name: 'Fit diagram to view' }).tap()
      const close = viewer.getByRole('button', { name: 'Close fullscreen diagram' })
      await expect(close).toBeInViewport()
      const rect = await close.boundingBox()
      expect(rect?.width).toBe(44)
      expect(await viewer.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
      await page.screenshot({ path: test.info().outputPath('fullscreen-touch-paper.png') })
      await close.tap()
      await expect(trigger).toBeFocused()
      await expect(page.locator('#root')).not.toHaveAttribute('inert')
    } finally {
      await page.request.delete(`/farming/api/control/agents/${agentId}`)
    }
  })
})
