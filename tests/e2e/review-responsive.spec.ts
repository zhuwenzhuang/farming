import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from '@playwright/test'

function git(root: string, ...args: string[]) {
  return execFileSync('git', args, {
    cwd: root, encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_DATE: '2026-07-01T12:00:00Z', GIT_COMMITTER_DATE: '2026-07-01T12:00:00Z' },
  }).trim()
}

for (const appearance of ['light', 'dark', 'paper']) {
  test(`adapts a real Review without losing either side's comments or drafts in ${appearance}`, async ({ page }, testInfo) => {
    const settingsResponse = await page.request.get('/farming/api/settings')
    expect(settingsResponse.ok()).toBeTruthy()
    const { settings: originalSettings } = await settingsResponse.json() as { settings: { appearance: string } }
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-responsive-'))
    const filePath = 'src/main/java/example/review/ReviewCoordinator.java'
    const source = [
      'package example.review;',
      'import example.review.storage.immutable.revisions.candidate.ReviewCandidateSnapshot;',
      'class ReviewCoordinator {',
      '  void review() {',
      '    int capacity = 1;',
      '    publishCapturedRevisionWithItsOriginalComparisonAndComments();',
      '  }',
      '}',
      '',
    ]
    try {
      git(root, 'init', '-b', 'main')
      git(root, 'config', 'core.hooksPath', '/dev/null')
      git(root, 'config', 'user.name', 'Review Fixture')
      git(root, 'config', 'user.email', 'review@example.test')
      fs.mkdirSync(path.dirname(path.join(root, filePath)), { recursive: true })
      fs.writeFileSync(path.join(root, filePath), source.join('\n'))
      fs.writeFileSync(path.join(root, 'old-name.md'), 'Review documentation\n')
      git(root, 'add', '.'); git(root, 'commit', '-m', 'Initial review coordinator')
      const base = git(root, 'rev-parse', 'HEAD')
      source.splice(4, 1, '    prepare();', '    validate();', '    int capacity = 4;')
      fs.writeFileSync(path.join(root, filePath), source.join('\n'))
      git(root, 'mv', 'old-name.md', 'review-guide.md')
      git(root, 'add', '.'); git(root, 'commit', '-m', 'Validate captured revisions before publication')
      const head = git(root, 'rev-parse', 'HEAD')
      await page.addInitScript(() => localStorage.setItem('farming.review.diff-preferences', JSON.stringify({ fitToScreen: false, autoMarkReviewed: false })))
      expect((await page.request.post('/farming/api/settings', { data: { appearance } })).ok()).toBeTruthy()
      await page.setViewportSize({ width: 1440, height: 900 })
      await page.goto(`/farming/review?${new URLSearchParams({ root, base, head })}`)
      const row = page.locator(`[data-file-path="${filePath}"]`)
      await row.locator('.review-file-select').click()
      const diff = page.getByLabel(`Diff for ${filePath}`, { exact: true })
      await expect(diff).toHaveClass(/split/)
      await expect(diff.locator('code[data-review-side="right"][data-review-line="8"]')).toContainText('publishCapturedRevision')
      for (const [side, line] of [['base', 6], ['patchset', 8]] as const) {
        await diff.getByRole('button', { name: `Comment on ${side} line ${line}`, exact: true }).click()
        await diff.getByLabel('Review comment').fill(`${side} common-line comment`)
        await diff.getByRole('button', { name: 'SAVE COMMENT', exact: true }).click()
        await expect(diff.getByLabel('Review comment')).toHaveCount(0)
        await expect(diff.getByText(`${side} common-line comment`, { exact: true })).toBeVisible()
      }
      const reviewed = row.getByRole('switch', { name: 'Reviewed', exact: true })
      await reviewed.click()
      await expect(reviewed).toHaveAttribute('aria-checked', 'true')
      await diff.getByRole('button', { name: 'Comment on base line 2', exact: true }).click()
      await diff.getByLabel('Review comment').fill('Keep this base-side draft while resizing.')
      const url = page.url()
      for (const width of [980, 768, 767, 390, 320]) {
        await page.setViewportSize({ width, height: 844 })
        const compact = await page.evaluate(() => matchMedia('(max-width: 767px), (max-width: 980px) and (pointer: coarse)').matches)
        await expect(diff).toHaveClass(compact ? /unified.*fit-to-screen/ : /split/)
        await expect(page.getByRole('button', { name: 'Side-by-side diff', exact: true })).toHaveCount(compact ? 0 : 1)
        await expect(diff.getByText('base common-line comment', { exact: true })).toBeVisible()
        await expect(diff.getByText('patchset common-line comment', { exact: true })).toBeVisible()
        await expect(diff.getByLabel('Review comment')).toHaveValue('Keep this base-side draft while resizing.')
        await expect(reviewed).toHaveAttribute('aria-checked', 'true')
        expect(page.url()).toBe(url)
        if (compact) {
          expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width)
          await expect(diff.locator('.review-diff-row.unified.context').filter({ hasText: 'publishCapturedRevision' }).getByRole('button', { name: 'Comment on base line 6', exact: true })).toBeVisible()
          await expect(diff.locator('.review-diff-row.unified.context').filter({ hasText: 'publishCapturedRevision' }).getByRole('button', { name: 'Comment on patchset line 8', exact: true })).toBeVisible()
          await expect(diff.locator('.review-diff-row.added .review-diff-sign').first()).toHaveText('+')
          await expect(diff.locator('.review-diff-row.deleted .review-diff-sign').first()).toHaveText('−')
        }
      }
      await page.setViewportSize({ width: 390, height: 844 })
      await page.evaluate(() => scrollTo(0, 0))
      await expect(page.locator('body')).toHaveAttribute('data-appearance', appearance)
      await expect(page).toHaveScreenshot(`review-compact-${appearance}.png`, { fullPage: true })
      await page.getByRole('button', { name: 'Diff preferences', exact: true }).click()
      await expect(page.getByLabel('Fit to screen', { exact: true })).toBeChecked()
      await expect(page.getByLabel('Fit to screen', { exact: true })).toBeDisabled()
      await page.getByRole('button', { name: 'CANCEL', exact: true }).click()
      await page.setViewportSize({ width: 1440, height: 900 })
      await expect(diff).toHaveClass(/split/)
      await expect(diff).not.toHaveClass(/fit-to-screen/)
      await expect(diff.getByLabel('Review comment')).toHaveValue('Keep this base-side draft while resizing.')
      await diff.getByRole('button', { name: 'DISCARD', exact: true }).click()
      await page.getByRole('button', { name: 'Unified diff', exact: true }).click()
      await page.setViewportSize({ width: 390, height: 844 })
      await page.setViewportSize({ width: 1440, height: 900 })
      await expect(diff).toHaveClass(/unified/)
      await diff.screenshot({ path: testInfo.outputPath(`review-desktop-unified-${appearance}.png`), animations: 'disabled' })
      await page.setViewportSize({ width: 390, height: 844 })
      await page.reload()
      await row.locator('.review-file-select').click()
      await expect(diff).toHaveClass(/unified.*fit-to-screen/)
      await expect(page.getByRole('button', { name: 'Side-by-side diff', exact: true })).toHaveCount(0)
      await expect(diff.getByText('base common-line comment', { exact: true })).toBeVisible()
      await expect(diff.getByText('patchset common-line comment', { exact: true })).toBeVisible()
      await expect(reviewed).toHaveAttribute('aria-checked', 'true')
    } catch (error) {
      if (!page.isClosed()) {
        await testInfo.attach('Review at failure', { body: await page.locator('body').innerText(), contentType: 'text/plain' })
        await page.screenshot({ path: testInfo.outputPath('review-at-failure.png'), animations: 'disabled' })
      }
      throw error
    } finally {
      try {
        if (!page.isClosed()) await page.goto('about:blank')
        expect((await page.request.post('/farming/api/settings', { data: { appearance: originalSettings.appearance } })).ok()).toBeTruthy()
      } finally {
        fs.rmSync(root, { recursive: true, force: true })
      }
    }
  })
}
