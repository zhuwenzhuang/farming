import fs from 'node:fs'
import path from 'node:path'
import { expect, openFarming, test } from './fixtures'

const paper = [
  '# Candidate ranking',
  '',
  'Inline notation: $K \\in [0,1]$. The surrounding text stays readable.',
  '',
  'The estimate combines predicate selectivity and projected columns:',
  '',
  '$$',
  '\\hat{B}(K)=\\sum_{q\\in Q_{30\\mathrm{d}}}\\mathbf{1}[\\mathit{HasPredicate}(q,K)]\\cdot(1-\\sigma(q,K))\\cdot\\mathit{ColProj}(q)\\tag{2}',
  '$$',
  '',
  'The baseline uses the observed pruning ratio:',
  '',
  '$$',
  'B_{\\mathrm{base}}=\\sum_{q\\in Q_{30\\mathrm{d}}}\\frac{\\mathit{FilesPruned}(q)}{\\mathit{FilesPruned}(q)+\\mathit{FilesRead}(q)}\\cdot\\mathit{ColProj}(q)\\tag{3}',
  '$$',
  '',
  'Short equations stay centered:',
  '',
  '$$E=mc^2$$',
  '',
  'Aligned equations and explicit line breaks keep their mathematical structure:',
  '',
  '$$\\begin{aligned}a&=b+c\\\\d&=e+f\\end{aligned}$$',
  '',
  '$$a=b\\\\c=d$$',
  '',
  'The next paragraph remains inside the reading column.',
].join('\n')

for (const appearance of ['light', 'dark', 'paper'] as const) {
  test('keeps paper equations and numbers reachable without widening Markdown - ' + appearance, async ({ page, workspaceRoot, isMobile }, testInfo) => {
    const workspace = path.join(workspaceRoot, 'paper-reader')
    fs.mkdirSync(workspace, { recursive: true })
    fs.writeFileSync(path.join(workspace, 'paper.md'), paper)
    const response = await page.request.post('/farming/api/control/agents', {
      data: { command: 'bash', workspace, name: 'Paper reader' },
    })
    expect(response.ok()).toBeTruthy()
    await openFarming(page)
    await page.evaluate(value => {
      document.body.dataset.appearance = value
      document.documentElement.dataset.appearance = value
    }, appearance)
    const sidebar = page.getByTestId('code-sidebar')
    if (await sidebar.evaluate(element => element.classList.contains('collapsed'))) {
      await page.getByTestId('code-mobile-menu').click()
    }
    const files = page.getByTestId('code-project-group').filter({ hasText: 'paper-reader' }).getByTestId('code-files-section')
    const title = files.locator('.code-files-title')
    if (await title.getAttribute('aria-expanded') !== 'true') await title.click()
    await files.locator('[data-testid="code-file-row"][data-file-path="paper.md"]').click()
    const preview = page.getByTestId('code-file-markdown-preview')
    await expect(preview.getByRole('heading', { name: 'Candidate ranking' })).toBeVisible()
    await expect(preview.locator('.katex-display')).toHaveCount(5)
    await expect(preview.locator('.katex-error, .code-markdown-math-error')).toHaveCount(0)
    await page.evaluate(() => document.fonts.ready)

    const captureDir = process.env.FARMING_MARKDOWN_MATH_CAPTURE_DIR
      ? path.resolve(process.env.FARMING_MARKDOWN_MATH_CAPTURE_DIR, testInfo.project.name)
      : testInfo.outputPath('math-captures')
    fs.mkdirSync(captureDir, { recursive: true })
    // Capture the actual old/new rendering before layout assertions can fail.
    const startImage = path.join(captureDir, appearance + '-equations-start.png')
    await preview.screenshot({ path: startImage, animations: 'disabled' })
    await testInfo.attach(appearance + '-equations-start', { path: startImage, contentType: 'image/png' })

    const equations = await preview.locator('.katex-display').evaluateAll(elements => elements.map(element => {
      const scroller = element as HTMLElement
      const bases = Array.from(scroller.querySelectorAll<HTMLElement>('.katex-html > .base'))
      const tag = scroller.querySelector<HTMLElement>('.katex-html > .tag')
      const math = scroller.querySelector<HTMLElement>('.katex')
      scroller.scrollLeft = 0
      const viewport = scroller.getBoundingClientRect()
      const first = bases[0].getBoundingClientRect()
      const last = bases.at(-1)!.getBoundingClientRect()
      const tagRect = tag?.getBoundingClientRect()
      const start = {
        firstInset: first.left - viewport.left,
        tagGap: tagRect ? tagRect.left - Math.max(...bases.map(base => base.getBoundingClientRect().right)) : null,
        centered: Math.abs((first.left + last.right) / 2 - (viewport.left + viewport.right) / 2),
      }
      scroller.scrollLeft = scroller.scrollWidth
      return {
        ...start,
        scrollLeft: scroller.scrollLeft,
        overflow: scroller.scrollWidth - scroller.clientWidth,
        lastInset: viewport.right - bases.at(-1)!.getBoundingClientRect().right,
        tagInset: tag ? viewport.right - tag.getBoundingClientRect().right : null,
        fontSize: Number.parseFloat(getComputedStyle(math!).fontSize),
        explicitLines: scroller.querySelectorAll('.katex-html > .newline').length,
        lineSeparation: bases.at(-1)!.getBoundingClientRect().top - bases[0].getBoundingClientRect().bottom,
        height: viewport.height,
      }
    }))
    const endImage = path.join(captureDir, appearance + '-equations-end.png')
    await preview.screenshot({ path: endImage, animations: 'disabled' })
    await testInfo.attach(appearance + '-equations-end', { path: endImage, contentType: 'image/png' })
    await testInfo.attach('equation-geometry', { body: JSON.stringify(equations, null, 2), contentType: 'application/json' })

    const documentBounds = await preview.evaluate(element => ({
      panelOverflow: element.scrollWidth - element.clientWidth,
      pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    }))
    expect(documentBounds.panelOverflow).toBeLessThanOrEqual(1)
    expect(documentBounds.pageOverflow).toBeLessThanOrEqual(1)
    for (const equation of equations.slice(0, 2)) {
      expect(equation.firstInset).toBeGreaterThanOrEqual(-1)
      expect(equation.lastInset).toBeGreaterThanOrEqual(-1)
      expect(equation.tagInset).toBeGreaterThanOrEqual(-1)
      expect(equation.tagGap).toBeGreaterThanOrEqual(equation.fontSize * 0.5)
      if (isMobile) {
        expect(equation.overflow).toBeGreaterThan(20)
        expect(equation.scrollLeft).toBeGreaterThan(20)
      }
    }
    expect(equations[2].centered).toBeLessThanOrEqual(2)
    expect(equations[3].height).toBeGreaterThan(equations[3].fontSize * 2)
    expect(equations[4].explicitLines).toBe(1)
    expect(equations[4].lineSeparation).toBeGreaterThanOrEqual(-1)
    const inline = preview.locator('p').filter({ hasText: 'Inline notation:' }).locator('.katex')
    await expect(inline).toHaveCSS('display', 'inline')
    const inlineFontSize = await inline.evaluate(element => Number.parseFloat(getComputedStyle(element).fontSize))
    expect(equations[0].fontSize).toBeCloseTo(inlineFontSize, 1)
  })
}
