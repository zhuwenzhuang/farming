import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { expect, interceptWorkspaceRequests, openFarming, test } from './fixtures'

function repository(root: string) {
  const directory = path.join(root, 'diff-navigation')
  fs.mkdirSync(directory)
  const lines = Array.from({ length: 600 }, (_, index) => `source line ${index + 1}`)
  fs.writeFileSync(path.join(directory, 'example.txt'), lines.join('\n') + '\n')
  for (const args of [['init'], ['config', 'user.email', 'fixture@example.test'], ['config', 'user.name', 'Fixture'], ['add', '.'], ['commit', '-m', 'Diff base']]) {
    execFileSync('git', args, { cwd: directory, stdio: 'ignore' })
  }
  lines[119] = 'FIRST CHANGE at line 120'
  lines.splice(579)
  lines.splice(299, 0, 'SECOND CHANGE inserted before line 300')
  fs.writeFileSync(path.join(directory, 'example.txt'), lines.join('\n') + '\n')
  return directory
}

for (const appearance of ['light', 'dark', 'paper'] as const) {
  for (const compact of [false, true]) {
    test(`file diff reveals and navigates changes in ${appearance} ${compact ? 'compact' : 'desktop'}`, async ({ page, workspaceRoot }, testInfo) => {
      const directory = repository(workspaceRoot)
      await page.setViewportSize({ width: compact ? 390 : 1440, height: 900 })
      await page.request.post('/farming/api/settings', { data: { appearance } })
      let agentId: string | undefined
      try {
        if (compact) {
          await page.goto(`/farming/?${new URLSearchParams({ ftarget: 'file', path: path.join(directory, 'example.txt'), view: 'diff' })}`)
        } else {
          const response = await page.request.post('/farming/api/control/agents', { data: { command: 'bash', workspace: directory } })
          expect(response.ok()).toBeTruthy()
          agentId = (await response.json() as { agentId: string }).agentId
          await openFarming(page)
          const files = page.getByTestId('code-project-group').filter({ hasText: 'diff-navigation' }).getByTestId('code-files-section')
          if ((await files.getAttribute('class'))?.includes('collapsed')) await files.locator('.code-files-title').click()
          const tracked = files.getByTestId('code-file-change-tracked-group')
          if (await tracked.locator('.code-file-change-group-toggle').getAttribute('aria-expanded') === 'false') await tracked.locator('.code-file-change-group-toggle').click()
          await tracked.getByTestId('code-file-change-row').locator('button').click()
        }
        const diff = page.getByTestId('code-file-diff-view')
        const count = diff.getByRole('status', { name: 'Change navigation' })
        const next = diff.getByRole('button', { name: 'Next change', exact: true })
        const previous = diff.getByRole('button', { name: 'Previous change', exact: true })
        const modified = diff.locator('.editor.modified .view-lines:not(.line-delete)')
        await expect(count).toHaveText('1 / 3')
        await expect(modified).toContainText('FIRST CHANGE')
        await expect(modified.locator('.view-line').filter({ hasText: /^source.line.1$/ })).toHaveCount(0)
        await next.focus()
        await page.keyboard.press('Enter')
        await expect(count).toHaveText('2 / 3')
        await expect(modified).toContainText('SECOND CHANGE')
        // Navigation follows an explicit cursor placement, including the original side.
        await diff.locator(`.editor.${compact ? 'modified' : 'original'} .view-line`)
          .filter({ hasText: /^source.line.298$/ }).click()
        await expect(count).toHaveText('1 / 3')
        await next.click()
        await expect(count).toHaveText('2 / 3')
        await previous.click()
        await expect(count).toHaveText('1 / 3')
        await expect(modified).toContainText('FIRST CHANGE')
        await previous.click()
        await expect(count).toHaveText('3 / 3')
        // The last change is a pure deletion at EOF; inline mode must expose it too.
        await expect(diff.locator(`.editor.${compact ? 'modified' : 'original'} .view-line`).filter({ hasText: /^source.line.590$/ })).toBeVisible()
        await next.click()
        await expect(count).toHaveText('1 / 3')
        await expect(modified).toContainText('FIRST CHANGE')
        await expect(next).toBeInViewport()
        await expect(previous).toBeInViewport()
        await expect(page.locator('body')).toHaveAttribute('data-appearance', appearance)
        await diff.screenshot({ path: testInfo.outputPath(`diff-navigation-${appearance}-${compact ? 'compact' : 'desktop'}.png`) })
        // Theme/layout updates preserve the current location instead of repeating auto-reveal.
        await next.click()
        await page.setViewportSize({ width: compact ? 430 : 1300, height: 820 })
        await page.locator('body').evaluate(body => { body.dataset.appearance = 'paper' })
        await expect(count).toHaveText('2 / 3')
        await expect(modified).toContainText('SECOND CHANGE')
        await diff.getByRole('button', { name: 'Close diff', exact: true }).click()
        await expect(diff).toHaveCount(0)
      } finally {
        if (agentId) await page.request.delete(`/farming/api/control/agents/${agentId}?recordHistory=0`)
      }
    })
  }
}

test('closing a loading diff revokes its late result and reveal', async ({ page, workspaceRoot }) => {
  const directory = repository(workspaceRoot)
  let release = () => {}
  const held = new Promise<void>(resolve => { release = resolve })
  let requests = 0
  let released = false
  await interceptWorkspaceRequests(page, request => {
    if (request.operation !== 'diff' || ++requests !== 1) return
    return { onResult: async result => { await held; released = true; return result } }
  })
  try {
    await page.goto(`/farming/?${new URLSearchParams({ ftarget: 'file', path: path.join(directory, 'example.txt'), view: 'diff' })}`)
    const diff = page.getByTestId('code-file-diff-view')
    await expect.poll(() => requests).toBe(1)
    await expect(diff.getByRole('button', { name: 'Next change', exact: true })).toBeDisabled()
    await diff.getByRole('button', { name: 'Close diff', exact: true }).click()
    await expect(diff).toHaveCount(0)
    await page.getByRole('button', { name: 'Open File Diff', exact: true }).click()
    const count = diff.getByRole('status', { name: 'Change navigation' })
    await expect(count).toHaveText('1 / 3')
    await diff.getByRole('button', { name: 'Next change', exact: true }).click()
    await expect(count).toHaveText('2 / 3')
    release()
    await expect.poll(() => released).toBe(true)
    await expect(count).toHaveText('2 / 3')
    await expect(diff.locator('.editor.modified .view-lines:not(.line-delete)')).toContainText('SECOND CHANGE')
  } finally { release() }
})

test('first-line insertion navigates and empty diffs disable navigation', async ({ page, workspaceRoot }) => {
  const directory = repository(workspaceRoot)
  const filePath = path.join(directory, 'example.txt')
  const original = execFileSync('git', ['show', 'HEAD:example.txt'], { cwd: directory, encoding: 'utf8' })
  fs.writeFileSync(filePath, 'INSERTED AT START\n' + original)
  await page.goto(`/farming/?${new URLSearchParams({ ftarget: 'file', path: filePath, view: 'diff' })}`)
  const diff = page.getByTestId('code-file-diff-view')
  const count = diff.getByRole('status', { name: 'Change navigation' })
  await expect(count).toHaveText('1 / 1')
  await expect(diff.locator('.editor.modified .view-lines')).toContainText('INSERTED AT START')
  for (const name of ['Next change', 'Previous change']) {
    await diff.getByRole('button', { name, exact: true }).click()
    await expect(count).toHaveText('1 / 1')
  }
  await diff.getByRole('button', { name: 'Close diff', exact: true }).click()
  fs.writeFileSync(filePath, original)
  await page.getByRole('button', { name: 'Open File Diff', exact: true }).click()
  await expect(diff.locator('.code-file-diff-state')).toHaveText('No file changes.')
  await expect(count).toHaveText('0 / 0')
  await expect(diff.getByRole('button', { name: 'Next change', exact: true })).toBeDisabled()
  await expect(diff.getByRole('button', { name: 'Previous change', exact: true })).toBeDisabled()
})
