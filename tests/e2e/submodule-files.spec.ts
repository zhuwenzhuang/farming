import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { expect, openFarming, test } from './fixtures'

function git(root: string, ...args: string[]) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

for (const appearance of ['light', 'dark', 'paper'] as const) {
  test(`groups child changes and opens child Review in ${appearance}`, async ({ page, workspaceRoot }, testInfo) => {
    const workspace = path.join(workspaceRoot, 'nested-project')
    const source = path.join(workspaceRoot, 'engine-source')
    for (const directory of [workspace, source]) {
      fs.mkdirSync(directory, { recursive: true })
      git(directory, 'init', '-q')
      git(directory, 'config', 'core.hooksPath', '/dev/null')
      git(directory, 'config', 'user.name', 'Fixture')
      git(directory, 'config', 'user.email', 'fixture@example.test')
    }
    fs.writeFileSync(path.join(source, 'engine.ts'), 'export const capacity = 1\n')
    git(source, 'add', '.'); git(source, 'commit', '-qm', 'Engine base')
    fs.writeFileSync(path.join(workspace, 'main.ts'), 'export const enabled = false\n')
    git(workspace, '-c', 'protocol.file.allow=always', 'submodule', 'add', source, 'engine')
    git(workspace, 'add', '.'); git(workspace, 'commit', '-qm', 'Project base')
    const child = path.join(workspace, 'engine')
    fs.writeFileSync(path.join(child, 'engine.ts'), 'export const capacity = 2\n')
    git(child, 'add', 'engine.ts')
    fs.writeFileSync(path.join(child, 'engine.ts'), 'export const capacity = 3\n')
    fs.writeFileSync(path.join(child, 'new.ts'), 'export const added = true\n')
    fs.writeFileSync(path.join(workspace, 'main.ts'), 'export const enabled = true\n')
    await page.request.post('/farming/api/settings', { data: { appearance } })
    const response = await page.request.post('/farming/api/control/agents', { data: { command: 'bash', workspace } })
    expect(response.ok()).toBeTruthy()
    const { agentId } = await response.json() as { agentId: string }
    try {
      await openFarming(page)
      const project = page.getByTestId('code-project-group').filter({ hasText: 'nested-project' })
      const files = project.getByTestId('code-files-section')
      if ((await files.getAttribute('class'))?.includes('collapsed')) await files.locator('.code-files-title').click()
      const groups = files.getByTestId('code-repository-changes')
      await expect(groups.locator('[data-repository-path=""]')).toContainText('Main repository')
      const childGroup = groups.locator('[data-repository-path="engine"]')
      await expect(childGroup).toContainText('Submodule')
      const tracked = childGroup.getByTestId('code-file-change-tracked-group')
      if (await tracked.locator('.code-file-change-group-toggle').getAttribute('aria-expanded') === 'false') await tracked.locator('.code-file-change-group-toggle').click()
      await tracked.getByTestId('code-file-change-directory-row').locator('button').click()
      await expect(tracked.getByTestId('code-file-change-row')).toContainText('Staged + unstaged')
      expect(await tracked.getByTestId('code-file-change-row').evaluate(element => {
        const main = element.querySelector('button')!.getBoundingClientRect()
        return Array.from(element.querySelectorAll('button > *')).every(child => child.getBoundingClientRect().bottom <= main.bottom + 1)
      })).toBe(true)
      await tracked.getByTestId('code-file-change-row').locator('button').click()
      await expect(page.getByTestId('code-file-editor')).toBeVisible()
      await expect(page.locator('body')).toHaveAttribute('data-appearance', appearance)
      await page.screenshot({ path: testInfo.outputPath(`submodule-files-${appearance}.png`), animations: 'disabled' })
      const popupPromise = page.waitForEvent('popup')
      await tracked.getByRole('button', { name: 'Review', exact: true }).click()
      const review = await popupPromise
      try {
        await expect(review.getByTestId('review-file-row')).toHaveCount(1)
        expect(new URL(review.url()).searchParams.get('root')).toBe(child)
        const row = review.getByTestId('review-file-row')
        await row.locator('.review-file-select').click()
        await expect(review.getByLabel('Diff for engine.ts', { exact: true })).toContainText('capacity = 3')
      } finally { await review.close() }
    } finally {
      await page.request.delete(`/farming/api/control/agents/${agentId}?recordHistory=0`)
    }
  })
}
