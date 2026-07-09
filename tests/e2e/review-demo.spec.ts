import { expect, test } from '@playwright/test'

test('keeps Gerrit-style review controls and independent inline diffs working', async ({ page }) => {
  await page.goto('/farming/review-demo')

  const review = page.getByTestId('review-demo-page')
  await expect(review.getByText('Base', { exact: true })).toBeVisible()
  await expect(review.getByLabel('Patch set', { exact: true })).toHaveValue('Patchset 20')
  await expect(review.getByRole('button', { name: 'DOWNLOAD' })).toHaveCount(0)
  await expect(review.getByRole('button', { name: 'EXPAND ALL' })).toBeVisible()

  const firstFile = review.locator('[data-file-path="clis/dataflow.py"]')
  await expect(firstFile.getByText('Reviewed', { exact: true })).toBeVisible()
  const firstFileReviewedSwitch = firstFile.getByRole('switch', { name: 'Reviewed' })
  await expect(firstFileReviewedSwitch).toHaveAttribute('data-action-visibility', 'on-row-interaction')
  await expect(firstFileReviewedSwitch).toHaveCSS('opacity', '0')
  await expect(firstFile.locator('.review-demo-file-stats .removed')).toHaveCSS('font-style', 'normal')
  await expect(firstFile.locator('.review-demo-file-stats .added')).toHaveCSS('color', 'rgb(63, 145, 77)')
  await expect(firstFile.locator('.review-demo-file-stats .removed')).toHaveCSS('color', 'rgb(200, 79, 79)')
  const initialStatWeight = await firstFile.locator('.review-demo-file-stats .added').evaluate(element => getComputedStyle(element).fontWeight)
  await expect(firstFile.locator('.review-demo-file-stats .removed')).toHaveCSS('font-weight', initialStatWeight)
  const initialColumns = await firstFile.evaluate(element => {
    const stats = element.querySelector('.review-demo-file-stats')?.getBoundingClientRect()
    const action = element.querySelector('.review-demo-review-status button')?.getBoundingClientRect()
    return { actionLeft: action?.left, statsLeft: stats?.left }
  })
  await firstFile.hover()
  await expect(firstFileReviewedSwitch).toHaveCSS('opacity', '1')
  await expect(firstFileReviewedSwitch).toContainText('MARK UNREVIEWED')
  await firstFile.locator('.review-demo-file-select').click()
  await expect(firstFileReviewedSwitch).toHaveAttribute('aria-checked', 'true')
  await firstFileReviewedSwitch.click()
  await expect(firstFile.getByText('Reviewed', { exact: true })).toHaveCount(0)
  await expect(firstFileReviewedSwitch).toHaveAttribute('aria-checked', 'false')
  await expect(firstFileReviewedSwitch).toContainText('MARK REVIEWED')
  const toggledColumns = await firstFile.evaluate(element => {
    const stats = element.querySelector('.review-demo-file-stats')?.getBoundingClientRect()
    const action = element.querySelector('.review-demo-review-status button')?.getBoundingClientRect()
    return { actionLeft: action?.left, statsLeft: stats?.left }
  })
  expect(toggledColumns).toEqual(initialColumns)
  const dataflowDiff = review.getByLabel('Diff for clis/dataflow.py')
  await expect(dataflowDiff).toBeVisible()
  await expect(dataflowDiff.locator('.hljs-keyword').first()).toBeVisible()
  await expect(review.getByLabel('Diff for clis/diagnose.py')).toBeVisible()

  await dataflowDiff.getByRole('button', { name: 'Show 90 common lines' }).click()
  await expect(dataflowDiff.getByRole('button', { name: 'Hide 90 common lines' })).toBeVisible()
  const firstDiffRow = dataflowDiff.locator('.review-demo-diff-row').first()
  await expect(firstDiffRow).toContainText('unchanged review context 1')

  await review.getByRole('button', { name: 'Diff preferences' }).click()
  await page.getByLabel('Syntax highlighting').uncheck()
  await page.getByRole('button', { name: 'SAVE' }).click()
  await expect(dataflowDiff.locator('.hljs-keyword')).toHaveCount(0)

})

test('keeps the current expanded file header and review action visible while scrolling its diff', async ({ page }) => {
  await page.goto('/farming/review-demo')

  const review = page.getByTestId('review-demo-page')
  const diagnoseRow = review.locator('[data-file-path="clis/diagnose.py"]')
  const reviewSwitch = diagnoseRow.getByRole('switch', { name: 'Reviewed' })
  await expect(review.getByLabel('Diff for clis/diagnose.py')).toBeVisible()
  await expect(reviewSwitch).toHaveCSS('opacity', '0')

  await page.evaluate(() => { window.scrollTo(0, 223) })
  await expect(diagnoseRow).toHaveClass(/reviewing/)
  await expect(diagnoseRow.locator('.review-demo-file-change-header')).toHaveCSS('position', 'sticky')
  await expect(reviewSwitch).toHaveCSS('opacity', '1')
})

test('shows both paths for a renamed file', async ({ page }) => {
  await page.goto('/farming/review-demo')
  const renamedFile = page.locator('[data-file-path="tests/review/change-set.spec.ts"]')
  await expect(renamedFile.locator('.review-demo-file-name')).toHaveText('tests/review/change-set.spec.ts')
  await expect(renamedFile.locator('.review-demo-file-previous-path')).toHaveText('tests/changes/change-summary.spec.ts')
})

test('creates and persists a comment for a selected code range', async ({ page }) => {
  await page.goto('/farming/review-demo')
  const review = page.getByTestId('review-demo-page')
  const file = review.locator('[data-file-path="clis/dataflow.py"]')
  await expect(file).toBeVisible()
  if (!(await file.getAttribute('class'))?.includes('expanded')) await file.locator('.review-demo-file-select').click()
  const diff = review.getByLabel('Diff for clis/dataflow.py')
  await expect(diff).toBeVisible()
  const rightCells = diff.locator('code[data-review-side="right"][data-review-line]')
  await expect(rightCells.nth(1)).toBeVisible()
  await rightCells.nth(0).evaluate((first, second) => {
    if (!(second instanceof HTMLElement)) throw new Error('second code cell missing')
    const selection = window.getSelection()
    const range = document.createRange()
    range.setStart(first, 0)
    range.setEnd(second, second.childNodes.length)
    selection?.removeAllRanges()
    selection?.addRange(range)
    first.closest('.review-demo-diff-code')?.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
  }, await rightCells.nth(1).elementHandle())

  const editor = diff.locator('.review-demo-comment-editor')
  await expect(editor.locator('header')).toContainText(/Patchset lines \d+–\d+/)
  await editor.getByLabel('Review comment').fill('Review the selected range as one unit.')
  await editor.getByRole('button', { name: 'SAVE COMMENT' }).click()
  await expect(diff.getByText('Review the selected range as one unit.')).toBeVisible()
  await expect(diff.locator('.review-demo-comment-thread header').filter({ hasText: /Patchset lines \d+–\d+/ })).toBeVisible()
})

test('persists reviewed files and diff preferences across a refresh', async ({ page }) => {
  await page.goto('/farming/review-demo')

  const review = page.getByTestId('review-demo-page')
  const diagnoseRow = review.locator('[data-file-path="clis/diagnose.py"]')
  const diagnoseSwitch = diagnoseRow.getByRole('switch', { name: 'Reviewed' })
  await expect(diagnoseSwitch).toHaveAttribute('aria-checked', 'false')
  await diagnoseRow.hover()
  await diagnoseSwitch.click()
  await expect(diagnoseSwitch).toHaveAttribute('aria-checked', 'true')

  await review.getByRole('button', { name: 'Diff preferences' }).click()
  await page.getByLabel('Context', { exact: true }).selectOption('25')
  await page.getByRole('button', { name: 'CANCEL' }).click()
  await expect(review.getByLabel('Diff for clis/diagnose.py').getByRole('button', { name: 'Show 90 common lines' })).toBeVisible()

  await review.getByRole('button', { name: 'Diff preferences' }).click()
  await page.getByLabel('Context', { exact: true }).selectOption('3')
  await page.getByRole('button', { name: 'SAVE' }).click()

  const diagnoseDiff = review.getByLabel('Diff for clis/diagnose.py')
  await diagnoseDiff.locator('code[data-review-line="130"][data-review-side="right"]').click()
  await page.getByLabel('Review comment').fill('Discard this draft.')
  await page.getByRole('button', { name: 'CANCEL' }).click()
  await expect(diagnoseDiff.getByText('Discard this draft.', { exact: true })).toHaveCount(0)

  await diagnoseDiff.locator('code[data-review-line="130"][data-review-side="right"]').click()
  const changedLine = diagnoseDiff.locator('.review-demo-diff-row.added:has(code[data-review-line="130"][data-review-side="right"])')
  const attachment = changedLine.locator('xpath=following-sibling::*[1]')
  await expect(attachment).toHaveClass(/review-demo-line-attachment/)
  await attachment.getByLabel('Review comment').fill('Keep the base range explicit.')
  await attachment.getByRole('button', { name: 'SAVE COMMENT' }).click()
  await expect(attachment.getByText('Keep the base range explicit.', { exact: true })).toBeVisible()

  await page.reload()
  await expect(diagnoseRow.getByText('Reviewed', { exact: true })).toBeVisible()
  await expect(review.getByLabel('Diff for clis/diagnose.py').getByRole('button', { name: 'Show 97 common lines' })).toBeVisible()
  const persistedDiff = review.getByLabel('Diff for clis/diagnose.py')
  await expect(persistedDiff.getByText('Keep the base range explicit.', { exact: true })).toBeVisible()
  await persistedDiff.getByRole('button', { name: 'Delete comment on line 13' }).click()
  await expect(persistedDiff.getByText('Keep the base range explicit.', { exact: true })).toHaveCount(0)
  await page.reload()
  await expect(review.getByLabel('Diff for clis/diagnose.py').getByText('Keep the base range explicit.', { exact: true })).toHaveCount(0)
})

test('keeps existing toolbar controls reflected in the rendered review', async ({ page }) => {
  await page.goto('/farming/review-demo')

  const review = page.getByTestId('review-demo-page')
  const diagnoseDiff = review.getByLabel('Diff for clis/diagnose.py')

  await review.getByRole('button', { name: '34a15ae' }).click()
  await expect(review.getByRole('button', { name: 'Copied' })).toBeVisible()

  await review.getByRole('button', { name: 'Unified diff' }).click()
  await expect(diagnoseDiff).toHaveClass(/unified/)
  await review.getByRole('button', { name: 'Side-by-side diff' }).click()
  await expect(diagnoseDiff).toHaveClass(/split/)

  await review.getByRole('button', { name: 'EXPAND ALL' }).click()
  await expect(review.getByRole('button', { name: 'COLLAPSE ALL' })).toBeVisible()
  await expect(review.locator('[aria-label^="Diff for "]')).toHaveCount(12)
  await review.getByRole('button', { name: 'COLLAPSE ALL' }).click()
  await expect(review.locator('[aria-label^="Diff for "]')).toHaveCount(0)
})

test('applies whitespace presentation preferences to the rendered diff', async ({ page }) => {
  await page.goto('/farming/review-demo')

  const review = page.getByTestId('review-demo-page')
  const diagnoseDiff = review.getByLabel('Diff for clis/diagnose.py')
  await diagnoseDiff.getByRole('button', { name: 'Show 90 common lines' }).click()
  await expect(diagnoseDiff.locator('.review-demo-tab-marker')).toHaveCount(4)
  await expect(diagnoseDiff.locator('.review-demo-trailing-whitespace')).toHaveCount(1)
  await expect(diagnoseDiff.locator('code[data-review-line="139"]')).toHaveCount(2)

  await review.getByRole('button', { name: 'Diff preferences' }).click()
  await page.getByLabel('Show tabs').uncheck()
  await page.getByLabel('Show trailing whitespace').uncheck()
  await page.getByLabel('Ignore Whitespace').selectOption('TRAILING')
  await page.getByRole('button', { name: 'SAVE' }).click()

  await expect(diagnoseDiff.locator('.review-demo-tab-marker')).toHaveCount(0)
  await expect(diagnoseDiff.locator('.review-demo-trailing-whitespace')).toHaveCount(0)
  await expect(diagnoseDiff.locator('code[data-review-line="139"]')).toHaveCount(0)
})

test('renders the full selected common context instead of silently truncating it', async ({ page }) => {
  await page.goto('/farming/review-demo')

  const review = page.getByTestId('review-demo-page')
  await review.getByRole('button', { name: 'Diff preferences' }).click()
  await page.getByLabel('Context', { exact: true }).selectOption('100')
  await page.getByRole('button', { name: 'SAVE' }).click()

  const diagnoseDiff = review.getByLabel('Diff for clis/diagnose.py')
  await expect(diagnoseDiff.getByRole('button', { name: 'Show 1 common lines' })).toHaveCount(0)
  await expect(diagnoseDiff.locator('code[data-review-line="29"][data-review-side="right"]')).toBeVisible()
})

test('marks a single opened file reviewed while expand-all does not mark every file', async ({ page }) => {
  await page.goto('/farming/review-demo')

  const review = page.getByTestId('review-demo-page')
  const fetchLogview = review.locator('[data-file-path="clis/fetch_logview.py"]')
  const querySls = review.locator('[data-file-path="clis/query_sls.py"]')

  await fetchLogview.locator('.review-demo-file-select').click()
  await expect(fetchLogview.getByText('Reviewed', { exact: true })).toBeVisible()

  await review.getByRole('button', { name: 'EXPAND ALL' }).click()
  await expect(querySls.getByText('Reviewed', { exact: true })).toHaveCount(0)
})

test('keeps files, review state, comments, and expanded diffs scoped to each patchset', async ({ page }) => {
  await page.goto('/farming/review-demo')

  const review = page.getByTestId('review-demo-page')
  const patchsetSelect = review.getByLabel('Patch set', { exact: true })
  await patchsetSelect.selectOption('Patchset 19')
  await expect(patchsetSelect).toHaveValue('Patchset 19')
  await expect(review.locator('[data-file-path="clis/fetch_quota_snapshot.py"]')).toHaveCount(0)

  const dataflow19 = review.locator('[data-file-path="clis/dataflow.py"]')
  await dataflow19.locator('.review-demo-file-select').click()
  await expect(review.getByLabel('Diff for clis/dataflow.py')).toBeVisible()

  const diagnose19 = review.locator('[data-file-path="clis/diagnose.py"]')
  const diagnose19Switch = diagnose19.getByRole('switch', { name: 'Reviewed' })
  await expect(diagnose19Switch).toHaveAttribute('aria-checked', 'false')
  await diagnose19Switch.click()
  await expect(diagnose19Switch).toHaveAttribute('aria-checked', 'true')
  const diagnose19Diff = review.getByLabel('Diff for clis/diagnose.py')
  await diagnose19Diff.locator('code[data-review-line="130"][data-review-side="right"]').click()
  await page.getByLabel('Review comment').fill('Patchset 19 needs an explicit range.')
  await page.getByRole('button', { name: 'SAVE COMMENT' }).click()
  await expect(diagnose19.getByText('Reviewed', { exact: true })).toBeVisible()

  await patchsetSelect.selectOption('Patchset 20')
  await expect(review.getByText('Patchset 19 needs an explicit range.', { exact: true })).toHaveCount(0)
  await expect(review.getByLabel('Diff for clis/dataflow.py')).toHaveCount(0)

  await patchsetSelect.selectOption('Patchset 19')
  await expect(review.getByLabel('Diff for clis/dataflow.py')).toBeVisible()
  await expect(review.getByLabel('Diff for clis/diagnose.py')).toBeVisible()
  await expect(review.getByText('Patchset 19 needs an explicit range.', { exact: true })).toBeVisible()
  await expect(diagnose19.getByText('Reviewed', { exact: true })).toBeVisible()
})

test('captures an agent working copy as an isolated immutable review session', async ({ page }) => {
  let reviewedFiles: string[] = []
  let loadedFileDiff = false
  const base = '1111111111111111111111111111111111111111'
  const head = '2222222222222222222222222222222222222222'
  const reviewId = 'review-11111111111111111111111111111111'
  await page.route('**/api/review-sessions', async route => {
    expect(route.request().method()).toBe('POST')
    expect(await route.request().postDataJSON()).toEqual({ agentId: 'fsess-demo', base: 'HEAD' })
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        base,
        createdAt: '2026-07-11T00:00:00.000Z',
        fixesBase: base,
        head,
        number: 1,
        reviewId,
        root: '/workspace/demo',
      }),
    })
  })
  await page.route('**/api/reviews/**', async route => {
    const request = route.request()
    const url = request.url()
    if (url.includes('/git-range/files/src%2Freview.cpp/diff')) {
      loadedFileDiff = true
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          added: 1,
          diff: {
            hunks: [{
              header: '@@ -8,1 +8,1 @@',
              oldStart: 8,
              oldLines: 1,
              newStart: 8,
              newLines: 1,
              rows: [
                { kind: 'deleted', left: { intraline: [{ start: 7, end: 18 }], line: 8, text: 'return staleReview;' } },
                { kind: 'added', right: { intraline: [{ start: 7, end: 19 }], line: 8, text: 'return activeReview;' } },
              ],
            }],
            truncated: false,
          },
          diffLoaded: true,
          kind: 'modified',
          path: 'src/review.cpp',
          removed: 1,
          status: 'M',
        }),
      })
      return
    }
    if (url.includes('/git-range/files/src%2Ffail.cpp/diff')) {
      await route.fulfill({
        contentType: 'application/json',
        status: 500,
        body: JSON.stringify({ error: 'diff backend unavailable' }),
      })
      return
    }
    if (url.includes('/git-range?root=%2Fworkspace%2Fdemo')) {
      expect(url).toContain('metadataOnly=1')
      expect(url).toContain(`base=${base}`)
      expect(url).toContain(`head=${head}`)
      expect(url).toContain(`reviewId=${reviewId}`)
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          files: [{
            added: 1,
            diff: { hunks: [] },
            diffLoaded: false,
            kind: 'modified',
            path: 'src/review.cpp',
            removed: 1,
          }, {
            added: 0,
            binary: true,
            diff: { hunks: [] },
            kind: 'modified',
            path: 'assets/logo.png',
            removed: 0,
            size: 2048,
            sizeDelta: 512,
            status: 'M',
          }, {
            added: 0,
            diff: { hunks: [], truncated: true },
            diffLoaded: false,
            diffTooExpensive: true,
            kind: 'modified',
            path: 'src/huge.cpp',
            removed: 0,
            status: 'M',
          }, {
            added: 1,
            diff: { hunks: [] },
            diffLoaded: false,
            kind: 'modified',
            path: 'src/fail.cpp',
            removed: 1,
            status: 'M',
          }],
          isGitRepo: true,
          basePatchset: base,
          patchset: head,
          reviewId,
          root: '/workspace/demo',
          source: 'git-range',
          truncated: false,
        }),
      })
      return
    }
    if (url.includes('/files?reviewed')) {
      await route.fulfill({
        body: JSON.stringify(reviewedFiles),
        contentType: 'application/json',
        headers: { 'X-Farming-Review-Revision': String(reviewedFiles.length) },
      })
      return
    }
    if (url.includes('/files/src%2Freview.cpp/reviewed')) {
      reviewedFiles = request.method() === 'PUT' ? ['src/review.cpp'] : []
      await route.fulfill({
        headers: { 'X-Farming-Review-Revision': String(reviewedFiles.length) },
        status: 204,
      })
      return
    }
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ comments: [] }),
    })
  })

  await page.goto('/farming/review?agentId=fsess-demo')
  const review = page.getByTestId('review-demo-page')
  const workingFile = review.locator('[data-file-path="src/review.cpp"]')
  const binaryFile = review.locator('[data-file-path="assets/logo.png"]')
  const hugeFile = review.locator('[data-file-path="src/huge.cpp"]')
  const failFile = review.locator('[data-file-path="src/fail.cpp"]')
  await expect(review.getByText('Revision 1', { exact: true })).toBeVisible()
  await expect(review.getByRole('button', { name: 'FINAL CHANGE' })).toHaveCount(0)
  await expect(review.getByRole('button', { name: 'DOWNLOAD' })).toHaveCount(0)
  await expect(review.getByText('Workspace changes', { exact: true })).toBeVisible()
  await review.locator('.review-demo-commit-message summary').click()
  await expect(review.getByText('Uncommitted workspace changes do not have a commit author or commit message yet.', { exact: true })).toBeVisible()
  await expect(review.getByLabel('Patch set', { exact: true })).toHaveCount(0)
  await expect(review.locator('.review-demo-patch-static').filter({ hasText: base })).toBeVisible()
  await expect(workingFile).toBeVisible()
  await expect(binaryFile).toContainText('512 B')
  await expect(review.locator('[data-file-path="clis/dataflow.py"]')).toHaveCount(0)

  await workingFile.locator('.review-demo-file-select').click()
  const workingDiff = review.getByLabel('Diff for src/review.cpp')
  await expect(workingDiff).toBeVisible()
  await expect(workingDiff.locator('.review-demo-intraline')).toHaveCount(2)
  await review.getByRole('button', { name: 'Diff preferences' }).click()
  await page.getByLabel('Intraline differences').uncheck()
  await page.getByRole('button', { name: 'SAVE' }).click()
  await expect(workingDiff.locator('.review-demo-intraline')).toHaveCount(0)
  expect(loadedFileDiff).toBe(true)
  const workingReviewedSwitch = workingFile.getByRole('switch', { name: 'Reviewed' })
  await expect(workingReviewedSwitch).toHaveAttribute('aria-checked', 'true')
  await workingFile.hover()
  await workingReviewedSwitch.click()
  await expect(workingReviewedSwitch).toHaveAttribute('aria-checked', 'false')
  await expect(workingFile.getByText('Reviewed', { exact: true })).toHaveCount(0)

  await binaryFile.locator('.review-demo-file-select').click()
  await expect(review.getByLabel('Diff for assets/logo.png').getByText('Binary file changed', { exact: true })).toBeVisible()
  await hugeFile.locator('.review-demo-file-select').click()
  await expect(review.getByLabel('Diff for src/huge.cpp').getByText('Diff too large to render', { exact: true })).toBeVisible()
  await failFile.locator('.review-demo-file-select').click()
  await expect(review.getByLabel('Diff for src/fail.cpp').getByRole('alert')).toHaveText('Could not load diff: diff backend unavailable')

  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390)
})

test('captures recent untracked files as an immutable single-column review', async ({ page }) => {
  const base = '1111111111111111111111111111111111111111'
  const head = '2222222222222222222222222222222222222222'
  const reviewId = 'review-33333333333333333333333333333333'
  const filePath = 'notes/new-plan.md'

  await page.route('**/api/review-sessions', async route => {
    expect(route.request().postDataJSON()).toMatchObject({
      agentId: 'fsess-demo',
      base: 'HEAD',
      modifiedWithinDays: 3,
      scope: 'untracked',
    })
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        base,
        createdAt: '2026-07-11T00:00:00.000Z',
        fixesBase: base,
        head,
        modifiedWithinDays: 3,
        number: 1,
        reviewId,
        root: '/workspace/demo',
        scope: 'untracked',
      }),
    })
  })
  await page.route('**/api/reviews/**', async route => {
    const url = route.request().url()
    if (url.includes(`/git-range/files/${encodeURIComponent(filePath)}/diff`)) {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          added: 2,
          diff: {
            hunks: [{
              header: '@@ -0,0 +1,2 @@',
              oldStart: 0,
              oldLines: 0,
              newStart: 1,
              newLines: 2,
              rows: [
                { kind: 'added', right: { line: 1, text: '# New plan' } },
                { kind: 'added', right: { line: 2, text: 'Review this file.' } },
              ],
            }],
          },
          diffLoaded: true,
          kind: 'added',
          path: filePath,
          removed: 0,
          status: 'A',
        }),
      })
      return
    }
    if (url.includes('/git-range?')) {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          basePatchset: base,
          files: [{ added: 2, diff: { hunks: [] }, diffLoaded: false, kind: 'added', path: filePath, removed: 0, status: 'A' }],
          isGitRepo: true,
          patchset: head,
          reviewId,
          root: '/workspace/demo',
          source: 'git-range',
          truncated: false,
        }),
      })
      return
    }
    if (url.includes('/files?reviewed')) {
      await route.fulfill({ body: '[]', contentType: 'application/json', headers: { 'X-Farming-Review-Revision': '0' } })
      return
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ comments: [] }) })
  })

  await page.goto('/farming/review?agentId=fsess-demo&scope=untracked&modifiedWithinDays=3')
  const review = page.getByTestId('review-demo-page')
  await expect(review.getByText('Untracked', { exact: true })).toBeVisible()
  await expect(review.getByRole('button', { name: 'Side-by-side diff' })).toHaveCount(0)
  const row = review.locator(`[data-file-path="${filePath}"]`)
  await row.locator('.review-demo-file-select').click()
  const diff = review.getByLabel(`Diff for ${filePath}`)
  await expect(diff).toHaveClass(/unified/)
  await expect(diff.locator('.review-demo-diff-columns span')).toHaveCount(1)
  await expect(diff.getByText('Review this file.', { exact: true })).toBeVisible()
})

test('refreshes a review revision without losing inherited state or attaching outdated comments to new lines', async ({ page }) => {
  const base = '1111111111111111111111111111111111111111'
  const firstHead = '2222222222222222222222222222222222222222'
  const secondHead = '3333333333333333333333333333333333333333'
  const reviewId = 'review-22222222222222222222222222222222'
  const path = 'src/review.ts'
  let refreshed = false
  let loadedFileDiff = false

  await page.route('**/api/review-sessions**', async route => {
    const isRefresh = route.request().url().endsWith(`/${reviewId}/revisions`)
    if (isRefresh) refreshed = true
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        base,
        changedPaths: isRefresh ? [path] : undefined,
        createdAt: '2026-07-11T00:00:00.000Z',
        fixesBase: isRefresh ? firstHead : base,
        head: isRefresh ? secondHead : firstHead,
        number: isRefresh ? 2 : 1,
        reviewId,
        root: '/workspace/demo',
      }),
    })
  })

  await page.route('**/api/reviews/**', async route => {
    const request = route.request()
    const url = request.url()
    if (url.includes('/git-range/files/src%2Freview.ts/diff')) {
      loadedFileDiff = true
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          added: 1,
          diff: {
            hunks: [{
              header: '@@ -4,1 +4,1 @@',
              oldStart: 4,
              oldLines: 1,
              newStart: 4,
              newLines: 1,
              rows: [
                { kind: 'deleted', left: { line: 4, text: 'return oldReview' } },
                { kind: 'added', right: { line: 4, text: refreshed ? 'return fixedReview' : 'return newReview' } },
              ],
            }],
          },
          diffLoaded: true,
          kind: 'modified',
          path,
          removed: 1,
          status: 'M',
        }),
      })
      return
    }
    if (url.includes('/git-range?')) {
      expect(url).toContain('metadataOnly=1')
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          basePatchset: refreshed ? firstHead : base,
          files: [{ added: 1, diff: { hunks: [] }, diffLoaded: false, kind: 'modified', path, removed: 1, status: 'M' }],
          isGitRepo: true,
          patchset: refreshed ? secondHead : firstHead,
          reviewId,
          root: '/workspace/demo',
          source: 'git-range',
          truncated: false,
        }),
      })
      return
    }
    if (url.includes('/files?reviewed')) {
      await route.fulfill({
        body: JSON.stringify(refreshed ? [] : [path]),
        contentType: 'application/json',
        headers: { 'X-Farming-Review-Revision': refreshed ? '0' : '1' },
      })
      return
    }
    if (url.endsWith('/comments') && request.method() === 'GET') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          comments: [{
            body: 'Check the previous implementation.',
            id: 'comment-1',
            line: 4,
            patchset: refreshed ? secondHead : firstHead,
            path,
            side: 'right',
            ...(refreshed ? { sourcePatchset: firstHead, status: 'outdated' } : {}),
          }],
        }),
      })
      return
    }
    await route.fulfill({ status: request.method() === 'PUT' ? 201 : 204 })
  })

  await page.goto('/farming/review?agentId=fsess-demo')
  const review = page.getByTestId('review-demo-page')
  const row = review.locator(`[data-file-path="${path}"]`)
  await expect(review.getByText('Revision 1', { exact: true })).toBeVisible()
  await expect(row.getByText('Reviewed', { exact: true })).toBeVisible()
  expect(loadedFileDiff).toBe(false)

  await review.getByRole('button', { name: 'REFRESH' }).click()
  await expect(review.getByText('Revision 2', { exact: true })).toBeVisible()
  await expect(review.getByRole('button', { name: 'FIXES SINCE REVIEW' })).toHaveClass(/active/)
  await expect(row.getByText('Reviewed', { exact: true })).toHaveCount(0)
  await expect(row.getByRole('switch', { name: 'Reviewed' })).toHaveAttribute('aria-checked', 'false')
  expect(loadedFileDiff).toBe(false)

  await row.locator('.review-demo-file-select').click()
  await expect(review.getByLabel(`Diff for ${path}`)).toBeVisible()
  await expect(review.getByText('Check the previous implementation.', { exact: true })).toBeVisible()
  await expect(review.locator('.review-demo-outdated-comments')).toBeVisible()
  await expect(review.getByText('Outdated · Patchset line 4', { exact: true })).toBeVisible()
  expect(loadedFileDiff).toBe(true)
})

test('uses the git-range endpoint when base and head are selected in the review URL', async ({ page }) => {
  let loadedRangeFileDiff = 0
  const loadedContexts: string[] = []
  let reviewedFiles: string[] = []
  await page.route('**/api/reviews/**', async route => {
    const request = route.request()
    const url = request.url()
    if (url.includes('/working-copy')) {
      await route.fulfill({
        contentType: 'application/json',
        status: 500,
        body: JSON.stringify({ error: 'unexpected working-copy request' }),
      })
      return
    }
    if (url.includes('/git-range/files/src%2Frange.cpp/diff')) {
      loadedRangeFileDiff += 1
      const context = new URL(url).searchParams.get('context') ?? ''
      loadedContexts.push(context)
      const expandedContext = context !== '10'
      expect(url).toContain('agentId=fsess-demo')
      expect(url).toContain('base=HEAD%7E3')
      expect(url).toContain('head=HEAD')
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          added: 1,
          diff: {
            hunks: [{
              header: expandedContext ? '@@ -1,4 +1,4 @@' : '@@ -4,1 +4,1 @@',
              oldStart: expandedContext ? 1 : 4,
              oldLines: expandedContext ? 4 : 1,
              newStart: expandedContext ? 1 : 4,
              newLines: expandedContext ? 4 : 1,
              rows: [
                ...(expandedContext ? [1, 2, 3].map(line => ({ kind: 'context', left: { line, text: `context ${line}` }, right: { line, text: `context ${line}` } })) : []),
                { kind: 'changed', left: { line: 4, text: 'return oldRange;' }, right: { line: 4, text: 'return newRange;' } },
              ],
            }],
          },
          diffLoaded: true,
          kind: 'modified',
          path: 'src/range.cpp',
          removed: 1,
          status: 'M',
        }),
      })
      return
    }
    if (url.includes('/git-range?agentId=fsess-demo')) {
      expect(url).toContain('metadataOnly=1')
      expect(url).toContain('base=HEAD%7E3')
      expect(url).toContain('head=HEAD')
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          basePatchset: 'HEAD~3',
          comparison: {
            base: { authoredAt: '2026-07-09T08:00:00.000Z', authorEmail: 'base@example.com', authorName: 'Base Author', id: '1111111111111111111111111111111111111111', message: 'Base commit' },
            head: { authoredAt: '2026-07-11T09:30:00.000Z', authorEmail: 'reviewer@example.com', authorName: 'Review Author', id: '2222222222222222222222222222222222222222', message: 'Make review context interactive\n\nKeep the diff focused.' },
            workingTree: false,
          },
          files: [{
            added: 1,
            diff: { hunks: [] },
            diffLoaded: false,
            kind: 'modified',
            path: 'src/range.cpp',
            removed: 1,
            status: 'M',
          }],
          isGitRepo: true,
          patchset: 'HEAD',
          reviewId: 'git-range-test-review',
          root: '/workspace/demo',
          source: 'git-range',
          truncated: false,
        }),
      })
      return
    }
    if (url.includes('/files?reviewed')) {
      await route.fulfill({
        body: JSON.stringify(reviewedFiles),
        contentType: 'application/json',
        headers: { 'X-Farming-Review-Revision': String(reviewedFiles.length) },
      })
      return
    }
    if (url.includes('/files/src%2Frange.cpp/reviewed')) {
      expect(url).toContain('/api/reviews/git-range-test-review/revisions/HEAD/files/src%2Frange.cpp/reviewed')
      reviewedFiles = request.method() === 'PUT' ? ['src/range.cpp'] : []
      await route.fulfill({
        headers: { 'X-Farming-Review-Revision': String(reviewedFiles.length) },
        status: 201,
      })
      return
    }
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ comments: [] }),
    })
  })

  await page.goto('/farming/review?agentId=fsess-demo&base=HEAD~3&head=HEAD')
  const review = page.getByTestId('review-demo-page')
  const rangeFile = review.locator('[data-file-path="src/range.cpp"]')
  await expect(review.getByText('HEAD~3', { exact: true })).toBeVisible()
  await expect(review.getByText('HEAD', { exact: true })).toBeVisible()
  await expect(review.getByText('Working copy', { exact: true })).toHaveCount(0)
  await expect(review.getByLabel('Patch set', { exact: true })).toHaveCount(0)
  await expect(rangeFile).toBeVisible()
  const commitMessage = review.locator('.review-demo-commit-message')
  await expect(commitMessage.getByText('Make review context interactive', { exact: true })).toBeVisible()
  await commitMessage.locator('summary').click()
  await expect(commitMessage.getByText(/Review Author <reviewer@example.com>/)).toBeVisible()
  await expect(commitMessage.locator('pre')).toContainText('Keep the diff focused.')

  await rangeFile.locator('.review-demo-file-select').click()
  const rangeDiff = review.getByLabel('Diff for src/range.cpp')
  await expect(rangeDiff).toContainText('return newRange;')
  expect(loadedRangeFileDiff).toBe(1)
  await rangeDiff.getByRole('button', { name: 'Show 3 common lines' }).click()
  await expect(rangeDiff.getByText('context 1', { exact: true }).first()).toBeVisible()
  await expect(rangeDiff.getByRole('button', { name: 'Show 3 common lines' })).toHaveCount(0)
  expect(loadedRangeFileDiff).toBe(2)
  const rangeReviewedSwitch = rangeFile.getByRole('switch', { name: 'Reviewed' })
  await expect(rangeReviewedSwitch).toHaveAttribute('aria-checked', 'true')
  await rangeFile.hover()
  await rangeReviewedSwitch.click()
  await expect(rangeReviewedSwitch).toHaveAttribute('aria-checked', 'false')
  await expect(rangeFile.getByText('Reviewed', { exact: true })).toHaveCount(0)

  await review.getByRole('button', { name: 'Diff preferences' }).click()
  await page.getByLabel('Context', { exact: true }).selectOption('25')
  await page.getByRole('button', { name: 'SAVE' }).click()
  await expect.poll(() => loadedRangeFileDiff).toBe(3)
  expect(loadedContexts).toEqual(['10', '13', '25'])

  await expect(review.getByRole('button', { name: 'DOWNLOAD' })).toHaveCount(0)
})

test('does not silently fall back to working copy when a range URL is invalid', async ({ page }) => {
  let reviewApiRequests = 0
  await page.route('**/api/reviews/**', async route => {
    reviewApiRequests += 1
    await route.fulfill({
      contentType: 'application/json',
      status: 500,
      body: JSON.stringify({ error: 'review API should not be called for an invalid range target' }),
    })
  })

  await page.goto('/farming/review?agentId=fsess-demo&base=HEAD~3')
  const review = page.getByTestId('review-demo-page')
  await expect(review.getByRole('alert')).toHaveText('Could not load review target: base and head revisions are invalid')
  await expect(review.locator('[data-testid="review-demo-file-row"]')).toHaveCount(0)
  await expect(review.getByText('Working copy', { exact: true })).toHaveCount(0)
  await page.waitForTimeout(100)
  expect(reviewApiRequests).toBe(0)
})

test('restores an optimistic comment when the review API rejects it', async ({ page }) => {
  await page.route('**/api/reviews/**/comments', async route => {
    if (route.request().method() !== 'POST') {
      await route.continue()
      return
    }
    await route.fulfill({
      contentType: 'application/json',
      status: 500,
      body: JSON.stringify({ error: 'comment store unavailable' }),
    })
  })
  await page.goto('/farming/review-demo')

  const review = page.getByTestId('review-demo-page')
  const diagnoseDiff = review.getByLabel('Diff for clis/diagnose.py')
  await diagnoseDiff.locator('code[data-review-line="130"][data-review-side="right"]').click()
  await page.getByLabel('Review comment').fill('This must not remain local only.')
  await page.getByRole('button', { name: 'SAVE COMMENT' }).click()
  await expect(review.getByText('Could not save comment: comment store unavailable', { exact: true })).toBeVisible()
  await expect(diagnoseDiff.getByText('This must not remain local only.', { exact: true })).toHaveCount(0)
})
