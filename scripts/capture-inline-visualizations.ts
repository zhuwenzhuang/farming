import { chromium, expect } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'

async function main() {
  // Explicitly selected live Agent; this capture never sends a provider prompt.
  const [url, agentId, title, outputDirectory = '.tmp/visualization-captures', sourcePath, referencePath] = process.argv.slice(2)
  if (!url || !agentId || !title) throw new Error('Usage: tsx scripts/capture-inline-visualizations.ts <url> <agent-id> <iframe-title> [output-directory]')
  const browser = await chromium.launch({ headless: true, executablePath: process.env.FARMING_PLAYWRIGHT_CHROME_PATH })
  const deadline = setTimeout(() => { void browser.close() }, 120_000)
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } })
    await page.goto(url)
    await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click({ timeout: 30_000 })
    const frameElement = page.locator('iframe').filter({ visible: true }).and(page.locator(`iframe[title="${title}"]`)).last()
    await frameElement.waitFor({ timeout: 45_000 })
    const frame = frameElement.contentFrame()
    await frame.locator('svg').first().waitFor({ timeout: 30_000 })
    if (sourcePath) {
      const source = await fs.readFile(sourcePath, 'utf8')
      if (!(await frameElement.getAttribute('srcdoc'))?.includes(source)) throw new Error('Displayed document does not contain the unchanged source')
      console.log('Unchanged source verified')
    }
    // Optional locally rendered reference supplied by the caller, never bundled
    // in Farming. Match the iframe width, not the outer application window.
    const reference = referencePath ? await browser.newPage() : null
    if (reference && referencePath) {
      await reference.route('http://visualization-reference.test/', route => route.fulfill({ contentType: 'text/html', path: referencePath }))
      await reference.goto('http://visualization-reference.test/')
      await reference.locator('iframe').contentFrame().locator('svg[role="img"]').first().waitFor()
      console.log('Reference rendered')
    }
    const visualization = page.getByTestId('code-agent-transcript-inline-visualization').filter({ has: frameElement }).last()
    const errors = await visualization.locator('[role=alert], [role=status]').allTextContents()
    if (errors.length) throw new Error(errors.join('\n'))
    await fs.mkdir(outputDirectory, { recursive: true })
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1200 })
      for (const theme of ['light', 'dark', 'paper']) {
        await page.bringToFront()
        await page.locator('body').evaluate((body, appearance) => { body.dataset.appearance = appearance }, theme)
        await visualization.scrollIntoViewIfNeeded()
        await expect.poll(() => frame.locator('body').evaluate(body => getComputedStyle(body).color)).toBe(await visualization.evaluate(element => getComputedStyle(element).color))
        await expect.poll(() => frame.locator('body').evaluate(body => body.scrollHeight - innerHeight)).toBeLessThan(4).catch(async error => {
          console.error(await frame.locator('body').evaluate(body => ({
            body: body.getBoundingClientRect().toJSON(), viewport: innerHeight, scroll: body.scrollHeight,
            children: Array.from(body.children).filter(el => el.getBoundingClientRect().height).map(el => ({ tag: el.tagName, box: el.getBoundingClientRect().toJSON() })),
            visibility: document.visibilityState,
          })))
          throw error
        })
        const expand = visualization.getByRole('button', { name: 'Show full visualization' })
        if (await expand.isVisible()) await expand.click()
        const height = await visualization.evaluate(element => Math.ceil(element.getBoundingClientRect().height))
        await page.setViewportSize({ width, height: Math.min(5000, Math.max(1200, height + 400)) })
        await visualization.scrollIntoViewIfNeeded()
        await visualization.screenshot({ path: path.join(outputDirectory, `chart-${width}-${theme}.png`) })
        const geometry = await frame.locator('body').evaluate(body => ({
          font: getComputedStyle(body).fontFamily,
          color: getComputedStyle(body).color,
          width: body.clientWidth,
          contentWidth: body.scrollWidth,
          contentHeight: body.scrollHeight,
          viewportHeight: innerHeight,
          chartCount: body.querySelectorAll('svg').length,
        }))
        if (geometry.contentWidth > geometry.width + 2 || geometry.contentHeight > geometry.viewportHeight + 3) throw new Error(`Clipped chart: ${JSON.stringify(geometry)}`)
        const errors = await visualization.locator('[role=alert], [role=status]').allTextContents()
        if (errors.length) throw new Error(errors.join('\n'))
        if (reference) {
          await reference.bringToFront()
          await reference.setViewportSize({ width: geometry.width + 32, height: geometry.viewportHeight + 32 })
          await reference.emulateMedia({ colorScheme: theme === 'dark' ? 'dark' : 'light' })
          const referenceFrame = reference.locator('iframe').contentFrame()
          const svgMarkup = await frame.locator('svg[role="img"]').evaluateAll(nodes => nodes.map(node => node.outerHTML))
          await expect.poll(() => referenceFrame.locator('svg[role="img"]').evaluateAll(nodes => nodes.map(node => node.outerHTML))).toEqual(svgMarkup)
          await reference.locator('iframe').screenshot({ path: path.join(outputDirectory, `reference-${width}-${theme}.png`) })
        }
        console.log(JSON.stringify({ viewportWidth: width, theme, ...geometry }))
      }
    }
  } finally { clearTimeout(deadline); await browser.close() }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
