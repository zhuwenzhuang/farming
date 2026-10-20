import { expect, openFarming, test } from './fixtures'

for (const appearance of ['light', 'dark', 'paper'] as const) {
  test(`black-hole blocks unrefracted page text behind the photon ring in ${appearance}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.request.post('/farming/api/settings', {
      data: { appearance, restReminderIntervalSeconds: 50 * 60, language: 'en' },
    })
    await page.addInitScript(() => {
      const testWindow = window as Window & {
        __farmingBlackHoleEvolutionSeed?: number
        __farmingBlackHoleElapsedSeconds?: number
      }
      testWindow.__farmingBlackHoleEvolutionSeed = 1
      testWindow.__farmingBlackHoleElapsedSeconds = 15.05
    })
    await openFarming(page)
    // Keep realistic text density behind the real compositor, including the
    // high-contrast glyphs that reveal a transparent hole in the body layer.
    await page.getByTestId('code-main').evaluate(element => {
      const article = document.createElement('article')
      article.style.cssText = 'position:absolute;inset:0;overflow:hidden;padding:24px;font:20px/2 monospace;white-space:pre-wrap'
      article.textContent = `${'Readable page text · 原始文字不应穿过黑洞 · '.repeat(3)}\n`.repeat(30)
      element.appendChild(article)
    })
    await page.getByTestId('code-sidebar-options').click()
    await page.getByTestId('code-settings-panel').getByRole('button', { name: 'Preview black hole' }).click()
    const scene = page.getByTestId('pet-rest-scene')
    await expect(scene.locator('.code-pet-black-hole-compositor')).toHaveAttribute('data-refresh-state', 'idle')
    const canvas = scene.locator('.code-pet-black-hole-canvas')
    await expect(canvas).toHaveAttribute('data-macro-phase', 'gargantua')
    await page.evaluate(async () => {
      await (window as Window & {
        __farmingBlackHoleRenderFrames?: (count: number) => Promise<void>
      }).__farmingBlackHoleRenderFrames?.(2)
    })
    const coverage = await canvas.evaluate(element => {
      const canvas = element as HTMLCanvasElement
      const gl = canvas.getContext('webgl2')
      if (!gl) throw new Error('Black-hole WebGL context unavailable')
      const program = gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram | null
      if (!program) throw new Error('Black-hole program unavailable')
      const placement = gl.getUniform(program, gl.getUniformLocation(program, 'uPlacement')) as Float32Array
      const mass = Number(gl.getUniform(program, gl.getUniformLocation(program, 'uMass')))
      const opacity = Number(gl.getUniform(program, gl.getUniformLocation(program, 'uOpacity')))
      const pixel = new Uint8Array(4)
      let minimumAlpha = 255
      // Rays just outside the photon ring turn away from the page plane.
      // They have no background image, even where they cross glowing gas.
      // Probe a band safely away from the antialiased silhouette edge.
      for (const horizonRatio of [1.08, 1.12, 1.15]) {
        for (let index = 0; index < 64; index += 1) {
          const angle = index * Math.PI * 2 / 64
          const radius = (72 / 840) * mass * horizonRatio * placement[2]!
          const x = Math.floor((0.5 + placement[0]! + Math.cos(angle) * radius) * canvas.width)
          const y = Math.floor((0.5 - placement[1]! - Math.sin(angle) * radius) * canvas.height)
          gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel)
          minimumAlpha = Math.min(minimumAlpha, pixel[3]!)
        }
      }
      return { minimumAlpha, opacity, width: canvas.width, height: canvas.height }
    })
    await page.screenshot({ path: testInfo.outputPath(`black-hole-text-${appearance}.png`) })
    expect(coverage.width).toBeGreaterThan(0)
    expect(coverage.height).toBeGreaterThan(0)
    expect(coverage.opacity).toBe(1)
    expect(coverage.minimumAlpha).toBeGreaterThanOrEqual(254)
    await scene.getByRole('button', { name: 'End break' }).click()
    await page.evaluate(async () => {
      const testWindow = window as Window & {
        __farmingBlackHoleExitProgress?: number
        __farmingBlackHoleRenderFrames?: (count: number) => Promise<void>
      }
      testWindow.__farmingBlackHoleExitProgress = 1
      await testWindow.__farmingBlackHoleRenderFrames?.(1)
    })
    await expect(scene).toHaveCount(0)
  })
}
