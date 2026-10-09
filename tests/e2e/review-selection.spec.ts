import { expect, test } from '@playwright/test'
import { selectCodeOption } from './code-select'

for (const appearance of ['light', 'dark', 'paper']) {
  test(`retains the selected Review file after collapse in ${appearance}`, async ({ page }, testInfo) => {
    await page.addInitScript(() => Object.assign(window, { __FARMING_BASE_PATH__: '/farming' }))
    // Supply the same authoritative appearance bootstrap as the server, keeping
    // this interaction fixture independent of other tests' saved settings.
    await page.route('**/review?fixture=1', async route => {
      const response = await route.fetch()
      const html = (await response.text()).replace(/data-appearance-preference="[^"]*"/, `data-appearance-preference="${appearance}"`)
      await route.fulfill({ response, body: html })
    })
    await page.route('**/api/reviews/**', async route => {
      const comments = new URL(route.request().url()).pathname.endsWith('/comments')
      await route.fulfill({ json: comments ? { comments: [] } : [], headers: { 'X-Farming-Review-Revision': '0' } })
    })
    await page.goto('/farming/review?fixture=1')
    await expect(page.locator('body')).toHaveAttribute('data-appearance', appearance)
    await page.locator('[data-file-path="clis/diagnose.py"]').getByRole('button', { name: 'Collapse file diff', exact: true }).click()
    const row = page.locator('[data-file-path="clis/fetch_logview.py"]')
    const next = page.locator('[data-file-path="clis/fetch_meta_timeline.py"]')
    await row.locator('.review-file-select').click()
    await expect(row).toHaveClass(/expanded/)
    await row.getByRole('button', { name: 'Collapse file diff', exact: true }).click()
    await page.getByRole('button', { name: 'Diff preferences' }).focus()
    await page.mouse.move(0, 0)
    await expect(row).toHaveClass(/selected/)
    await expect(row).not.toHaveClass(/expanded/)
    await expect(row.locator('.review-file-select')).toHaveAttribute('aria-current', 'true')
    await expect(page.locator('.review-file-change.selected')).toHaveCount(1)
    const selectedBackground = await row.locator('header').evaluate(element => getComputedStyle(element).background)
    await next.hover()
    expect(await next.locator('header').evaluate(element => getComputedStyle(element).background)).toBe(selectedBackground)
    await page.mouse.move(0, 0)
    expect(await next.locator('header').evaluate(element => getComputedStyle(element).background)).not.toBe(selectedBackground)
    await page.evaluate(() => window.dispatchEvent(new Event('scroll')))
    await expect(row).toHaveClass(/selected/)
    await page.screenshot({ path: testInfo.outputPath(`review-selection-${appearance}.png`), fullPage: true })
    await page.getByRole('button', { name: 'NEXT FILE', exact: true }).click()
    await expect(next).toHaveClass(/selected/)
    await expect(next).toHaveClass(/expanded/)
    await next.getByRole('button', { name: 'Collapse file diff', exact: true }).press('Enter')
    await expect(next).toHaveClass(/selected/)
    await expect(next).not.toHaveClass(/expanded/)
    await row.getByRole('button', { name: 'Expand file diff', exact: true }).click()
    // The last file leaves too little content to retain this viewport position
    // without trailing space. Exercise the actual pointer control near the end.
    const last = page.locator('[data-file-path="tests/review/change-set.spec.ts"]')
    await last.getByRole('button', { name: 'Expand file diff', exact: true }).click()
    await last.getByRole('button', { name: /Show all .* common lines/ }).first().click()
    await last.locator('header').evaluate(element => {
      window.scrollBy(0, element.getBoundingClientRect().top - 180)
    })
    const before = (await last.locator('header').boundingBox())!.y
    expect(Math.abs(before - 180)).toBeLessThan(2)
    await last.getByRole('button', { name: 'Collapse file diff', exact: true }).click()
    await expect.poll(async () => Math.abs((await last.locator('header').boundingBox())!.y - before)).toBeLessThan(2)
    expect(await page.locator('.review-scroll-tail').evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThan(0)
    await last.getByRole('button', { name: 'Expand file diff', exact: true }).click()
    await expect(page.locator('.review-scroll-tail')).toHaveCSS('height', '0px')
    // The expanded header is now sticky while reading farther down the diff.
    await last.evaluate(element => window.scrollBy(0, element.getBoundingClientRect().top + 100))
    const stickyTop = (await last.locator('header').boundingBox())!.y
    expect(Math.abs(stickyTop)).toBeLessThan(2)
    await last.getByRole('button', { name: 'Collapse file diff', exact: true }).click()
    await expect.poll(async () => Math.abs((await last.locator('header').boundingBox())!.y - stickyTop)).toBeLessThan(2)
    await expect(row).toHaveClass(/expanded/)
    await page.screenshot({ path: testInfo.outputPath(`review-collapse-anchor-${appearance}.png`) })
    await selectCodeOption(page.getByLabel('Patch set', { exact: true }), 'Patchset 19')
    await expect(page.locator('.review-file-change.selected')).toHaveCount(0)
    await expect(page.locator('.review-scroll-tail')).toHaveCSS('height', '0px')
  })
}

for (const appearance of ['light', 'dark', 'paper']) {
  test(`keeps long Review comparisons readable and resizable in ${appearance}`, async ({ page }, testInfo) => {
    await page.addInitScript(() => Object.assign(window, { __FARMING_BASE_PATH__: '/farming' }))
    await page.route('**/review?*', async route => {
      const response = await route.fetch()
      await route.fulfill({ response, body: (await response.text()).replace(/data-appearance-preference="[^"]*"/, `data-appearance-preference="${appearance}"`) })
    })
    const base = '1'.repeat(40)
    const head = '2'.repeat(40)
    const label = 'abc123456789 Support incremental compilation and preserve complete workspace comparison metadata across all review revisions'
    await page.route('**/api/reviews/**', async route => {
      const path = new URL(route.request().url()).pathname
      const source = { base, head, available: true }
      const body = path.endsWith('/comparison-sources') ? {
        root: '/workspace/demo', currentBranch: 'main', uncommittedPaths: [], uncommittedPathsTruncated: false,
        staged: { ...source, id: 'staged', label: 'Staged' }, unstaged: { ...source, id: 'unstaged', label: 'Unstaged' },
        commits: Array.from({ length: 20 }, (_, i) => ({ ...source, id: `commit:${i}`, label: `${label} ${i}` })),
        branches: [{ ...source, id: 'branch:topic', label: `topic/${'long-branch-name-'.repeat(12)}` }],
      } : path.endsWith('/git-range') ? {
        root: '/workspace/demo', basePatchset: base, patchset: head, reviewId: 'menu-review', files: [], source: 'git-range', isGitRepo: true, truncated: false,
      } : path.endsWith('/comments') ? { comments: [] } : []
      await route.fulfill({ json: body, headers: { 'X-Farming-Review-Revision': '0' } })
    })
    await page.goto(`/farming/review?root=/workspace/demo&base=${base}&head=${head}`)
    await page.locator('.review-files-toolbar .review-source-trigger').click()
    const menu = page.getByRole('menu', { name: 'Compare changes from' })
    await menu.locator('summary').filter({ hasText: 'Commit' }).click()
    const list = menu.getByLabel('Commit comparisons', { exact: true })
    await expect(menu.getByRole('menuitemradio', { name: `${label} 0`, exact: true })).toHaveAttribute('title', `${label} 0`)
    const bounds = (await menu.boundingBox())!
    expect(bounds.width).toBeGreaterThan(600)
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(1440)
    await expect(menu).toHaveCSS('resize', 'horizontal')
    // Exercise the browser's native resize affordance, including dragging right.
    await page.mouse.move(bounds.x + bounds.width - 3, bounds.y + bounds.height - 3)
    await page.mouse.down()
    await page.mouse.move(bounds.x + bounds.width - 203, bounds.y + bounds.height - 3, { steps: 8 })
    await page.mouse.up()
    const narrow = (await menu.boundingBox())!
    expect(narrow.width).toBeLessThan(bounds.width - 100)
    await page.mouse.move(narrow.x + narrow.width - 3, narrow.y + narrow.height - 3)
    await page.mouse.down()
    await page.mouse.move(narrow.x + narrow.width + 97, narrow.y + narrow.height - 3, { steps: 8 })
    await page.mouse.up()
    expect((await menu.boundingBox())!.width).toBeGreaterThan(narrow.width + 50)
    await page.screenshot({ path: testInfo.outputPath(`review-comparisons-${appearance}.png`) })
    await page.setViewportSize({ width: 390, height: 844 })
    expect((await menu.boundingBox())!.x + (await menu.boundingBox())!.width).toBeLessThanOrEqual(390)
    expect(await list.evaluate(element => element.scrollWidth > element.clientWidth)).toBeTruthy()
    await list.focus()
    await page.keyboard.press('ArrowRight')
    await expect.poll(() => list.evaluate(element => element.scrollLeft)).toBeGreaterThan(0)
    await list.evaluate(element => { element.scrollLeft = element.scrollWidth })
    const lastText = list.locator('button > span').first()
    expect((await lastText.boundingBox())!.x + (await lastText.boundingBox())!.width).toBeLessThanOrEqual(390)
    await page.screenshot({ path: testInfo.outputPath(`review-comparisons-mobile-${appearance}.png`) })
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
  })
}

for (const appearance of ['light', 'dark', 'paper']) {
  test(`compares independently chosen immutable endpoints in ${appearance}`, async ({ page }, testInfo) => {
    await page.addInitScript(() => Object.assign(window, { __FARMING_BASE_PATH__: '/farming' }))
    await page.route('**/review?*', async route => {
      const response = await route.fetch()
      await route.fulfill({ response, body: (await response.text()).replace(/data-appearance-preference="[^"]*"/, `data-appearance-preference="${appearance}"`) })
    })
    const base = '1'.repeat(40), head = '2'.repeat(40), older = '3'.repeat(40), captured = '4'.repeat(40)
    const root = '/workspace/demo'
    let reads = 0
    let failSources = false
    let captureBody: unknown
    const revision = { root, base: older, head: captured, fixesBase: older, reviewId: 'captured-review', number: 1, createdAt: '2026-10-09T00:00:00Z' }
    await page.route('**/api/review-sessions{,/**}', async route => {
      if (route.request().method() === 'POST') captureBody = route.request().postDataJSON()
      await route.fulfill({ json: { ...revision, revisions: [revision] } })
    })
    await page.route('**/api/reviews/**', async route => {
      const url = new URL(route.request().url())
      const source = { base, head, available: true }
      if (url.pathname.endsWith('/comparison-sources')) {
        reads++
        if (failSources) { await route.fulfill({ status: 503, json: { error: 'Version lookup unavailable' } }); return }
      }
      const resolvedBase = url.searchParams.get('base') || base
      const resolvedHead = url.searchParams.get('head') || head
      const commit = (id: string) => ({ id, message: id === older ? 'Earlier implementation' : id === base ? 'Initial implementation' : 'Current implementation', authoredAt: '', authorName: 'Demo', authorEmail: '' })
      const body = url.pathname.endsWith('/comparison-sources') ? {
        root, currentBranch: 'main', uncommittedPaths: [], uncommittedPathsTruncated: false,
        staged: { ...source, head: '5'.repeat(40), id: 'staged', label: 'Staged' },
        unstaged: { ...source, head: 'now', id: 'unstaged', label: 'Unstaged' },
        commits: [{ ...source, head: older, id: `commit:${older}`, label: '333333333333 Earlier implementation' }, { ...source, id: `commit:${head}`, label: '222222222222 Current implementation' }], branches: [],
      } : url.pathname.endsWith('/git-range') ? {
        root, basePatchset: resolvedBase, patchset: resolvedHead, reviewId: url.searchParams.get('reviewId') || `range-${resolvedBase}-${resolvedHead}`, files: [], source: 'git-range', isGitRepo: true, truncated: false,
        comparison: { base: commit(resolvedBase), head: commit(resolvedHead), workingTree: false },
      } : url.pathname.endsWith('/comments') ? { comments: [] } : []
      await route.fulfill({ json: body, headers: { 'X-Farming-Review-Revision': '0' } })
    })
    await page.goto(`/farming/review?root=${root}&base=${base}&head=${head}`)
    const left = page.getByRole('button', { name: 'Change Base (left)', exact: true })
    const right = page.getByRole('button', { name: 'Change Candidate (right)', exact: true })
    await expect(left).toContainText('111111111111 · Initial implementation')
    await expect(right).toContainText('222222222222 · Current implementation')
    await left.click()
    await page.getByRole('menuitemradio', { name: '333333333333 Earlier implementation', exact: true }).click()
    await expect(left).toContainText('333333333333 · Earlier implementation')
    expect(new URL(page.url()).searchParams.get('head')).toBe(head)
    await right.click()
    await page.getByRole('menuitemradio', { name: '333333333333 Earlier implementation', exact: true }).click()
    await expect(right).toContainText('333333333333 · Earlier implementation')
    expect(new URL(page.url()).searchParams.get('base')).toBe(older)
    await page.reload()
    await expect(left).toContainText('333333333333')
    await expect(right).toContainText('333333333333')
    failSources = true
    await right.click()
    await expect(page.getByRole('alert')).toContainText('Version lookup unavailable')
    failSources = false
    await page.getByRole('button', { name: 'RETRY', exact: true }).click()
    await page.getByRole('menuitemradio', { name: 'Latest working tree · capture now', exact: true }).click()
    await expect(right).toContainText('Captured working tree · Revision 1 · 444444444444')
    expect(captureBody).toEqual({ root, base: older })
    expect(new URL(page.url()).searchParams.get('base')).toBe(older)
    expect(new URL(page.url()).searchParams.get('head')).toBe(captured)
    expect(reads).toBe(4)
    await page.screenshot({ path: testInfo.outputPath(`review-endpoints-${appearance}.png`) })
    await page.setViewportSize({ width: 390, height: 844 })
    await right.click()
    const menu = page.getByRole('menu', { name: 'Choose Candidate (right)', exact: true })
    await expect(menu.getByRole('menuitemradio').first()).toBeVisible()
    expect((await menu.boundingBox())!.x).toBeGreaterThanOrEqual(0)
    expect((await menu.boundingBox())!.x + (await menu.boundingBox())!.width).toBeLessThanOrEqual(390)
    await page.screenshot({ path: testInfo.outputPath(`review-endpoints-mobile-${appearance}.png`) })
  })
}

test('keeps Reviewed and current diff preferences through collapse, late responses and retries', async ({ page }) => {
  await page.addInitScript(() => Object.assign(window, { __FARMING_BASE_PATH__: '/farming' }))
  const base = 'a'.repeat(40), head = 'b'.repeat(40), root = '/workspace/demo'
  let reviewed = false, failed = false, hold = false
  let releaseOld: () => void = () => {}
  const oldResponse = new Promise<void>(resolve => { releaseOld = resolve })
  let finishOld: () => void = () => {}
  const oldFinished = new Promise<void>(resolve => { finishOld = resolve })
  const contexts: string[] = []
  const file = (metadata: boolean, context = '10') => ({ path: 'src/Large.java', added: 1, removed: 1, kind: 'modified', diffLoaded: !metadata,
    diff: { hunks: metadata ? [] : [{ header: '@@ -1,1 +1,1 @@', oldStart: 1, oldLines: 1, newStart: 1, newLines: 1,
      rows: [{ kind: 'changed', left: { line: 1, text: 'previous' }, right: { line: 1, text: `current_context_${context}` } }] }] } })
  await page.route('**/api/review-sessions', route => route.fulfill({ status: 503, json: { error: 'Capture unavailable' } }))
  await page.route('**/api/reviews/**', async route => {
    const url = new URL(route.request().url()), pathname = url.pathname
    if (pathname.endsWith('/diff')) {
      const context = url.searchParams.get('context') || '10'
      contexts.push(context)
      if (hold && context === '100') { await oldResponse; await route.fulfill({ json: file(false, context) }); finishOld(); return }
      if (failed) { await route.fulfill({ status: 503, json: { error: 'Diff temporarily unavailable' } }); return }
      await route.fulfill({ json: file(false, context) }); return
    }
    if (pathname.endsWith('/reviewed')) { reviewed = route.request().method() === 'PUT'; await route.fulfill({ status: 204 }); return }
    const source = { base, head, available: true }
    const body = pathname.endsWith('/comparison-sources') ? {
      root, currentBranch: 'main', uncommittedPaths: [], uncommittedPathsTruncated: false, branches: [], commits: [],
      staged: { ...source, id: 'staged', label: 'Staged' }, unstaged: { ...source, id: 'unstaged', label: 'Unstaged' },
    } : pathname.endsWith('/git-range') ? {
      root, basePatchset: base, patchset: head, reviewId: 'preference-review', files: [file(true)], isGitRepo: true, source: 'git-range', truncated: false,
    } : pathname.endsWith('/comments') ? { comments: [] } : reviewed ? ['src/Large.java'] : []
    await route.fulfill({ json: body, headers: { 'X-Farming-Review-Revision': reviewed ? '1' : '0' } })
  })
  const setContext = async (label: string) => {
    await page.getByRole('button', { name: 'Diff preferences' }).click()
    await selectCodeOption(page.getByLabel('Context', { exact: true }), label.split(' ')[0])
    await page.getByRole('button', { name: 'SAVE', exact: true }).click()
  }
  try {
    await page.goto(`/farming/review?root=${root}&base=${base}&head=${head}`)
    const row = page.locator('[data-file-path="src/Large.java"]')
    await row.getByRole('button', { name: 'Expand file diff', exact: true }).click()
    await expect(row.getByText('current_context_10', { exact: true })).toBeVisible()
    await expect(row.getByRole('switch', { name: 'Reviewed', exact: true })).toBeChecked()
    await row.getByRole('button', { name: 'Collapse file diff', exact: true }).click()
    await setContext('25 lines')
    await row.getByRole('button', { name: 'Expand file diff', exact: true }).click()
    await expect(row.getByText('current_context_25', { exact: true })).toBeVisible()
    hold = true
    await setContext('100 lines')
    await expect.poll(() => contexts.includes('100')).toBeTruthy()
    await setContext('3 lines')
    await expect(row.getByText('current_context_3', { exact: true })).toBeVisible()
    releaseOld()
    await oldFinished
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await expect(row.getByText('current_context_100', { exact: true })).toHaveCount(0)
    await expect(row.getByText('current_context_3', { exact: true })).toBeVisible()
    failed = true
    await setContext('25 lines')
    await expect(row).toContainText('Diff temporarily unavailable')
    failed = false
    await row.getByRole('button', { name: 'RETRY', exact: true }).click()
    await expect(row.getByText('current_context_25', { exact: true })).toBeVisible()
    await expect(row.getByRole('switch', { name: 'Reviewed', exact: true })).toBeChecked()
    await page.getByRole('button', { name: 'Change Candidate (right)', exact: true }).click()
    await page.getByRole('menuitemradio', { name: 'Latest working tree · capture now', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('Capture unavailable')
    await page.getByRole('alert').getByRole('button', { name: 'RETRY', exact: true }).click()
    await expect(row.getByRole('switch', { name: 'Reviewed', exact: true })).toBeChecked()
    await expect(page.getByText('Reviewed status unavailable')).toHaveCount(0)
    expect(new URL(page.url()).searchParams.get('head')).toBe(head)
  } finally { releaseOld() }
})
