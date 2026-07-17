import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import {
  expect,
  openFarming,
  openNewAgentDialog,
  startAgentFromOpenDialog,
  test,
} from './fixtures'

function git(root: string, ...args: string[]) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
}

function commitFile(root: string, filePath: string, content: string, subject: string) {
  const absolutePath = path.join(root, filePath)
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true })
  fs.writeFileSync(absolutePath, content)
  git(root, 'add', filePath)
  git(root, 'commit', '-m', subject)
  return git(root, 'rev-parse', 'HEAD')
}

test('shows the VS Code-derived commit graph and opens commit changes in Review', async ({ page, workspaceRoot }) => {
  git(workspaceRoot, 'init', '--quiet')
  git(workspaceRoot, 'branch', '-m', 'main')
  fs.mkdirSync(path.join(workspaceRoot, '.empty-hooks'))
  git(workspaceRoot, 'config', 'core.hooksPath', '.empty-hooks')
  git(workspaceRoot, 'config', 'user.email', 'history@example.test')
  git(workspaceRoot, 'config', 'user.name', 'History Test')
  const rootCommit = commitFile(workspaceRoot, 'base.txt', 'base\n', 'root commit')
  git(workspaceRoot, 'checkout', '-b', 'topic')
  const topicCommit = commitFile(workspaceRoot, 'topic.txt', 'topic\n', 'topic commit')
  git(workspaceRoot, 'checkout', 'main')
  const mainCommit = commitFile(workspaceRoot, 'main.txt', 'main\n', 'main commit')
  git(workspaceRoot, 'merge', '--no-ff', 'topic', '-m', 'merge topic', '-m', 'Keep the topic work grouped as one merge.')
  const mergeCommit = git(workspaceRoot, 'rev-parse', 'HEAD')
  fs.appendFileSync(path.join(workspaceRoot, 'base.txt'), 'working change\n')

  await openFarming(page)
  await openNewAgentDialog(page)
  await startAgentFromOpenDialog(page, 'bash', workspaceRoot)

  const sidebar = page.getByTestId('code-sidebar')
  const workspaceBox = await page.getByTestId('code-workspace').boundingBox()
  const resizerBox = await page.getByTestId('code-sidebar-resizer').boundingBox()
  if (!workspaceBox || !resizerBox) throw new Error('Sidebar resize handle is unavailable')
  await page.mouse.move(resizerBox.x + (resizerBox.width / 2), resizerBox.y + 80)
  await page.mouse.down()
  await page.mouse.move(workspaceBox.x + 640, resizerBox.y + 80)
  await page.mouse.up()
  await expect.poll(async () => (await sidebar.boundingBox())?.width ?? 0).toBeGreaterThan(600)

  const files = page.getByTestId('code-files-section')
  await files.getByRole('button', { name: 'Files', exact: true }).click()
  const history = files.getByTestId('code-git-history-section')
  await expect(history).toBeVisible()
  const changesToggle = files.locator('.code-file-change-group-toggle').first()
  await expect(changesToggle).toBeVisible()
  await expect.poll(async () => {
    const changesBox = await changesToggle.boundingBox()
    const historyBox = await history.locator('.code-git-history-title').boundingBox()
    return Math.abs((changesBox?.x ?? 0) - (historyBox?.x ?? 0))
  }).toBeLessThan(1)
  await expect(history.getByRole('button', { name: 'History', exact: true })).toHaveAttribute('aria-expanded', 'false')
  await history.getByRole('button', { name: 'History', exact: true }).click()
  await expect(page.getByTestId('code-project-worktree').first()).toContainText('main')

  const scope = history.getByLabel('History view')
  await expect(scope).toContainText('Current')
  const commits = history.getByTestId('code-git-history-entry')
  await expect(commits).toHaveCount(3)
  await expect(history.locator('.code-git-history-reference', { hasText: 'main' })).toHaveCount(0)
  await expect(history.locator(`[data-commit-id="${topicCommit}"]`)).toHaveCount(0)
  await scope.click()
  const scopeMenu = page.getByTestId('code-git-history-scope-menu')
  await expect(scopeMenu).toBeVisible()
  await expect(scopeMenu.getByRole('menuitemradio')).toHaveCount(2)
  await expect(scopeMenu.getByRole('menuitemradio', { name: 'Current branch' })).toHaveAttribute('aria-checked', 'true')
  await scopeMenu.getByRole('menuitemradio', { name: 'All branches' }).click()
  await expect(scope).toContainText('All')
  await expect(commits).toHaveCount(4)
  const merge = history.locator(`[data-commit-id="${mergeCommit}"]`)
  await expect(merge).toContainText('merge topic')
  await expect(merge.locator('.code-git-history-graph-svg')).toHaveAttribute('width', '33')
  await merge.getByRole('button', { expanded: false }).click()

  const details = merge.getByTestId('code-git-history-details')
  await expect(details.getByText('Keep the topic work grouped as one merge.', { exact: true })).toBeVisible()
  const graphPlaceholder = details.locator('.code-git-history-graph-placeholder')
  await expect(graphPlaceholder.locator('path')).toHaveCount(2)
  await expect.poll(async () => {
    const detailBox = await details.boundingBox()
    const placeholderBox = await graphPlaceholder.boundingBox()
    return Math.abs((detailBox?.height ?? 0) - (placeholderBox?.height ?? 0))
  }).toBeLessThan(2)
  const parentSelect = details.getByLabel('Compare with parent')
  await expect(parentSelect.locator('option')).toHaveCount(2)
  await expect(details.getByText('1 file changed', { exact: true })).toBeVisible()
  await expect(details.getByRole('button', { name: 'Review commit', exact: true })).toContainText('Review')
  await expect(details.getByRole('button', { name: /topic\.txt/ })).toBeVisible()

  const [topicReview] = await Promise.all([
    page.waitForEvent('popup'),
    details.getByRole('button', { name: /topic\.txt/ }).click(),
  ])
  await topicReview.waitForLoadState('domcontentloaded')
  const topicReviewUrl = new URL(topicReview.url())
  expect(topicReviewUrl.pathname).toBe('/farming/review')
  expect(topicReviewUrl.searchParams.get('base')).toBe(mainCommit)
  expect(topicReviewUrl.searchParams.get('head')).toBe(mergeCommit)
  expect(topicReviewUrl.searchParams.get('path')).toBe('topic.txt')
  await expect(topicReview.getByTestId('review-page')).toBeVisible()
  await expect(topicReview.locator('[data-file-path="topic.txt"]')).toBeVisible()
  await topicReview.close()

  await parentSelect.selectOption(topicCommit)
  await expect(details.getByRole('button', { name: /main\.txt/ })).toBeVisible()
  await expect(details.getByRole('button', { name: /topic\.txt/ })).toHaveCount(0)

  const root = history.locator(`[data-commit-id="${rootCommit}"]`)
  await root.getByRole('button', { expanded: false }).click()
  const rootDetails = root.getByTestId('code-git-history-details')
  await expect(rootDetails.getByText('Root commit', { exact: true })).toBeVisible()
  await expect(rootDetails.getByRole('button', { name: 'Review commit', exact: true })).toBeVisible()
  const [rootReview] = await Promise.all([
    page.waitForEvent('popup'),
    rootDetails.getByRole('button', { name: 'Review commit', exact: true }).click(),
  ])
  await rootReview.waitForLoadState('domcontentloaded')
  const rootReviewUrl = new URL(rootReview.url())
  expect(rootReviewUrl.searchParams.get('base')).toBe('4b825dc642cb6eb9a060e54bf8d69288fbee4904')
  expect(rootReviewUrl.searchParams.get('head')).toBe(rootCommit)
  await expect(rootReview.getByTestId('review-page')).toBeVisible()
  await expect(rootReview.locator('[data-file-path="base.txt"]')).toBeVisible()
  await rootReview.close()
})
