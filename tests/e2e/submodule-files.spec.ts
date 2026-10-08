import type { Locator } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { expect, interceptWorkspaceRequests, openFarming, test } from './fixtures'

function git(root: string, ...args: string[]) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

async function expectHistoryHeaderRow(history: Locator) {
  const header = history.locator('.code-git-history-header')
  await expect(header.locator('.code-git-history-controls')).toBeVisible()
  const geometry = await header.evaluate(element => {
    const outer = element.getBoundingClientRect()
    const controls = ['.code-git-history-title', '.code-git-history-repository', '.code-git-history-controls']
      .map(selector => element.querySelector(selector)!.getBoundingClientRect())
    return {
      sameRow: controls.every(box => Math.abs(box.y + box.height / 2 - (outer.y + outer.height / 2)) < 2),
      inside: controls.every(box => box.x >= outer.x && box.right <= outer.right && box.width > 0),
      nonOverlapping: controls.every((box, index) => index === 0 || box.x >= controls[index - 1].right),
      labelWidth: element.querySelector('.code-select-value')!.clientWidth,
      labelScrollWidth: element.querySelector('.code-select-value')!.scrollWidth,
    }
  })
  expect(geometry.sameRow).toBe(true)
  expect(geometry.inside).toBe(true)
  expect(geometry.nonOverlapping).toBe(true)
  expect(geometry.labelWidth).toBeGreaterThan(20)
  expect(geometry.labelScrollWidth).toBeGreaterThan(geometry.labelWidth)
}

for (const appearance of ['light', 'dark', 'paper'] as const) {
  test(`groups repository changes, scopes history and Review in ${appearance}`, async ({ page, workspaceRoot }, testInfo) => {
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
    git(workspace, '-c', 'protocol.file.allow=always', 'submodule', 'add', source, 'engine-with-a-long-repository-name')
    git(workspace, 'add', '.'); git(workspace, 'commit', '-qm', 'Project base')
    const child = path.join(workspace, 'engine-with-a-long-repository-name')
    fs.writeFileSync(path.join(child, 'engine.ts'), 'export const capacity = 2\n')
    git(child, 'add', 'engine.ts')
    fs.writeFileSync(path.join(child, 'engine.ts'), 'export const capacity = 3\n')
    fs.writeFileSync(path.join(child, 'new.ts'), 'export const added = true\n')
    for (let index = 0; index < 220; index++) fs.writeFileSync(path.join(workspace, `scratch-${index}.txt`), 'scratch\n')
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
      const childGroup = groups.locator('[data-repository-path="engine-with-a-long-repository-name"]')
      await expect(childGroup).toContainText('Submodule')
      await expect(files.locator('[data-testid="code-file-row"][data-file-path="engine-with-a-long-repository-name"] .code-file-submodule-label')).toHaveText('Submodule')
      const tracked = childGroup.getByTestId('code-file-change-tracked-group')
      if (await tracked.locator('.code-file-change-group-toggle').getAttribute('aria-expanded') === 'false') await tracked.locator('.code-file-change-group-toggle').click()
      await expect(tracked.getByTestId('code-file-change-directory-row')).toHaveCount(0)
      await expect(childGroup.locator('.code-file-repository-status')).toHaveCount(0)
      const mainGroup = groups.locator('[data-repository-path=""]')
      await expect(mainGroup.getByTestId('code-file-changes-tracked-count')).toHaveText('1')
      await expect(mainGroup.getByTestId('code-file-changes-untracked-count')).toHaveText('220')
      await expect(groups).not.toContainText('0+')
      const mainUntracked = mainGroup.getByTestId('code-file-change-untracked-group')
      await mainUntracked.locator('.code-file-change-group-toggle').click()
      await expect(mainUntracked.getByTestId('code-file-change-row')).toHaveCount(100)
      await mainUntracked.getByRole('button', { name: /Load more/ }).click()
      await expect(mainUntracked.getByTestId('code-file-change-row')).toHaveCount(200)
      await mainUntracked.getByRole('button', { name: /Load more/ }).click()
      await expect(mainUntracked.getByTestId('code-file-change-row')).toHaveCount(220)
      await expect(mainUntracked.getByRole('button', { name: /Load more/ })).toHaveCount(0)
      await mainUntracked.locator('.code-file-change-group-toggle').click()
      await expect(groups).not.toContainText('Some changed files are not shown')
      const mainTracked = mainGroup.getByTestId('code-file-change-tracked-group').locator('.code-file-change-group-toggle')
      await expect(mainTracked).toHaveAttribute('aria-expanded', 'false')
      await mainTracked.click()
      await expect(mainTracked).toHaveAttribute('aria-expanded', 'true')
      await expect(mainGroup.getByTestId('code-file-change-row')).toHaveCount(1)
      await expect(mainGroup.getByTestId('code-file-change-row')).toContainText('main.ts')
      await page.screenshot({ path: testInfo.outputPath(`submodule-deduplicated-${appearance}.png`), animations: 'disabled' })
      await mainGroup.locator(':scope > .code-file-change-group-header > button').first().click()
      await expect(tracked).toBeVisible()
      await expect(tracked.locator('.code-file-change-group-toggle')).toHaveAttribute('aria-expanded', 'true')
      await expect(tracked.getByTestId('code-file-change-row')).toContainText('Staged + unstaged')
      expect(await tracked.getByTestId('code-file-change-row').evaluate(element => {
        const main = element.querySelector('button')!.getBoundingClientRect()
        return Array.from(element.querySelectorAll('button > *')).every(child => child.getBoundingClientRect().bottom <= main.bottom + 1)
      })).toBe(true)
      await tracked.getByTestId('code-file-change-row').locator('button').click()
      await expect(page.getByTestId('code-file-editor')).toBeVisible()
      await expect(page.getByTestId('code-file-diff-monaco')).toBeVisible()
      await expect(page.locator('body')).toHaveAttribute('data-appearance', appearance)
      await page.screenshot({ path: testInfo.outputPath(`submodule-files-${appearance}.png`), animations: 'disabled' })
      const popupPromise = page.waitForEvent('popup')
      await childGroup.getByRole('button', { name: 'Review', exact: true }).click()
      const review = await popupPromise
      try {
        await expect(review.getByTestId('review-file-row')).toHaveCount(1)
        expect(new URL(review.url()).searchParams.get('root')).toBe(child)
        const row = review.getByTestId('review-file-row')
        await row.locator('.review-file-select').click()
        await expect(review.getByLabel('Diff for engine.ts', { exact: true })).toContainText('capacity = 3')
      } finally { await review.close() }
      const untracked = childGroup.getByTestId('code-file-change-untracked-group')
      await untracked.locator('.code-file-change-group-toggle').click()
      const untrackedPopup = page.waitForEvent('popup')
      await untracked.getByRole('button', { name: 'Review untracked', exact: true }).click()
      const untrackedReview = await untrackedPopup
      try {
        await expect(untrackedReview.getByTestId('review-file-row')).toHaveCount(1)
        expect(new URL(untrackedReview.url()).searchParams.get('root')).toBe(child)
        expect(new URL(untrackedReview.url()).searchParams.has('modifiedWithinDays')).toBe(false)
      } finally { await untrackedReview.close() }
      const history = files.getByTestId('code-git-history-section')
      await history.locator('.code-git-history-title').click()
      await expect(history.getByTestId('code-git-history-entry')).toContainText('Project base')
      await history.getByRole('combobox', { name: 'History repository' }).click()
      await history.getByRole('option', { name: 'engine-with-a-long-repository-name', exact: true }).click()
      await expect(history.getByTestId('code-git-history-entry')).toContainText('Engine base')
      await expect(history).not.toContainText('Project base')
      await expectHistoryHeaderRow(history)
      await history.getByRole('combobox', { name: 'History repository' }).focus()
      await page.keyboard.press('ArrowDown')
      await expect(history.getByRole('option', { name: 'Main repository', exact: true })).toBeFocused()
      await page.keyboard.press('Escape')
      await expect(history.getByRole('combobox', { name: 'History repository' })).toBeFocused()
      await history.getByTestId('code-git-history-entry').locator('.code-git-history-commit').click()
      await expect(history.getByTestId('code-git-history-details')).toContainText('engine.ts')
      await page.screenshot({ path: testInfo.outputPath(`submodule-history-${appearance}.png`), animations: 'disabled' })
      await page.reload()
      await expect(files.getByRole('combobox', { name: 'History repository' })).toContainText('engine-with-a-long-repository-name')
      await expect(files.getByTestId('code-git-history-entry')).toContainText('Engine base')
      await expect(mainGroup.locator(':scope > .code-file-change-group-header > button').first()).toHaveAttribute('aria-expanded', 'false')
      await expect(tracked.locator('.code-file-change-group-toggle')).toHaveAttribute('aria-expanded', 'true')
      await mainGroup.locator(':scope > .code-file-change-group-header > button').first().click()
      await expect(mainTracked).toHaveAttribute('aria-expanded', 'true')
      await mainGroup.locator(':scope > .code-file-change-group-header > button').first().click()
      // Start the phone reload from a settled Agent view so file restoration does not own navigation.
      await project.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
      await expect(page.locator(`[data-testid="code-terminal-pane"][data-agent-id="${agentId}"]`)).toBeVisible()
      await page.setViewportSize({ width: 393, height: 852 })
      await page.reload()
      await expect(page.locator('body')).toHaveClass(/code-compact-layout/)
      await expect(page.locator(`[data-testid="code-terminal-pane"][data-agent-id="${agentId}"]`)).toBeVisible()
      await expect(files.getByTestId('code-git-history-entry')).toContainText('Engine base')
      await expect(tracked.getByTestId('code-file-changes-tracked-count')).toHaveText('1')
      await expect(page.getByTestId('code-sidebar')).toHaveClass(/collapsed/)
      const back = page.getByTestId('code-mobile-back')
      if (await back.isVisible()) await back.click()
      await page.getByTestId('code-mobile-menu').click()
      await expect(page.getByTestId('code-mobile-sidebar-backdrop')).toBeVisible()
      await expect(files).toBeVisible()
      await page.getByTestId('code-project-list').evaluate(element => { element.scrollTop = 0 })
      await expect(files.getByRole('combobox', { name: 'History repository' })).toBeInViewport()
      await expect(groups).toBeInViewport()
      await expectHistoryHeaderRow(files.getByTestId('code-git-history-section'))
      const screenshot = await page.screenshot({ path: testInfo.outputPath(`submodule-compact-${appearance}.png`), animations: 'disabled' })
      expect(screenshot.readUInt32BE(16)).toBe(393)
      expect(screenshot.readUInt32BE(20)).toBe(852)
    } finally {
      await page.request.delete(`/farming/api/control/agents/${agentId}?recordHistory=0`)
    }
  })
}

for (const appearance of ['light', 'dark', 'paper'] as const) {
  test(`keeps a single repository simple in ${appearance}`, async ({ page, workspaceRoot }, testInfo) => {
    const workspace = path.join(workspaceRoot, 'single-project')
    fs.mkdirSync(workspace, { recursive: true })
    git(workspace, 'init', '-q')
    git(workspace, 'config', 'core.hooksPath', '/dev/null')
    git(workspace, 'config', 'user.name', 'Fixture')
    git(workspace, 'config', 'user.email', 'fixture@example.test')
    fs.writeFileSync(path.join(workspace, 'main.ts'), 'export const enabled = false\n')
    git(workspace, 'add', '.'); git(workspace, 'commit', '-qm', 'Project base')
    fs.writeFileSync(path.join(workspace, 'main.ts'), 'export const enabled = true\n')
    fs.writeFileSync(path.join(workspace, 'notes.txt'), 'untracked\n')
    await page.request.post('/farming/api/settings', { data: { appearance } })
    const response = await page.request.post('/farming/api/control/agents', { data: { command: 'bash', workspace } })
    const { agentId } = await response.json() as { agentId: string }
    try {
      await openFarming(page)
      const files = page.getByTestId('code-project-group').filter({ hasText: 'single-project' }).getByTestId('code-files-section')
      if (await files.locator('.code-files-title').getAttribute('aria-expanded') !== 'true') await files.locator('.code-files-title').click()
      await expect(files.getByTestId('code-file-changes-tracked-count')).toHaveText('1')
      await expect(files.getByTestId('code-file-changes-untracked-count')).toHaveText('1')
      await expect(files.getByTestId('code-repository-changes')).toHaveCount(0)
      await expect(files.getByRole('combobox', { name: 'History repository' })).toHaveCount(0)
      await expect(files).not.toContainText('Main repository')
      await files.locator('.code-git-history-title').click()
      await expect(files.getByTestId('code-git-history-entry')).toContainText('Project base')
      await page.screenshot({ path: testInfo.outputPath(`single-repository-${appearance}.png`), animations: 'disabled' })
    } finally {
      await page.request.delete(`/farming/api/control/agents/${agentId}?recordHistory=0`)
    }
  })
}

test('fences old history reads and keeps missing child failures explicit', async ({ page, workspaceRoot }) => {
  const workspace = path.join(workspaceRoot, 'history-project')
  const source = path.join(workspaceRoot, 'child-source')
  for (const directory of [workspace, source]) {
    fs.mkdirSync(directory, { recursive: true })
    git(directory, 'init', '-q')
    git(directory, 'config', 'core.hooksPath', '/dev/null')
    git(directory, 'config', 'user.name', 'Fixture')
    git(directory, 'config', 'user.email', 'fixture@example.test')
    fs.writeFileSync(path.join(directory, 'readme.txt'), 'fixture\n')
    git(directory, 'add', '.'); git(directory, 'commit', '-qm', directory === source ? 'Child base' : 'Parent base')
  }
  git(workspace, '-c', 'protocol.file.allow=always', 'submodule', 'add', source, 'child')
  git(workspace, 'add', '.'); git(workspace, 'commit', '-qm', 'Parent head')
  let releaseParent: (() => void) | undefined
  let childReads = 0
  await interceptWorkspaceRequests(page, request => {
    if (request.operation !== 'history') return
    if (request.repositoryPath) { childReads++; return }
    return { onResult: result => new Promise(resolve => { releaseParent = () => resolve(result) }) }
  })
  const response = await page.request.post('/farming/api/control/agents', { data: { command: 'bash', workspace } })
  const { agentId } = await response.json() as { agentId: string }
  try {
    await openFarming(page)
    const files = page.getByTestId('code-project-group').filter({ hasText: 'history-project' }).getByTestId('code-files-section')
    if (await files.locator('.code-files-title').getAttribute('aria-expanded') !== 'true') await files.locator('.code-files-title').click()
    await files.locator('.code-git-history-title').click()
    await expect.poll(() => Boolean(releaseParent)).toBe(true)
    await files.getByRole('combobox', { name: 'History repository' }).click()
    await files.getByRole('option', { name: 'child', exact: true }).click()
    await expect(files.getByTestId('code-git-history-entry')).toContainText('Child base')
    releaseParent?.()
    await expect(files).not.toContainText('Parent head')
    fs.renameSync(path.join(workspace, 'child'), path.join(workspaceRoot, 'parked-child'))
    fs.mkdirSync(path.join(workspace, 'child'))
    const history = files.getByTestId('code-git-history-section')
    await history.getByRole('button', { name: 'Refresh', exact: true }).click()
    await expect(history.locator('.code-git-history-status.error')).toContainText('not initialized')
    await expect(history.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled()
    const failedCount = childReads
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    expect(childReads).toBe(failedCount)
    await history.getByRole('button', { name: 'Refresh', exact: true }).click()
    await expect.poll(() => childReads).toBe(failedCount + 1)
    await expect(history.locator('.code-git-history-status.error')).toContainText('not initialized')
  } finally {
    releaseParent?.()
    await page.request.delete(`/farming/api/control/agents/${agentId}?recordHistory=0`)
  }
})

test('refresh retries a failed page even when the repository inventory is unchanged', async ({ page, workspaceRoot }) => {
  const workspace = path.join(workspaceRoot, 'page-recovery')
  fs.mkdirSync(workspace, { recursive: true })
  git(workspace, 'init', '-q')
  for (let index = 0; index < 120; index++) fs.writeFileSync(path.join(workspace, `note-${index}.txt`), 'fixture\n')
  let failNextPage = true
  let pageReads = 0
  await interceptWorkspaceRequests(page, request => {
    if (request.operation !== 'changes' || request.scope !== 'untracked') return
    pageReads++
    if (request.cursor?.endsWith(':100') && failNextPage) {
      failNextPage = false
      return { response: { ok: false, error: { code: 'FIXTURE_READ_FAILURE', status: 503, message: 'Change list temporarily unavailable' } } }
    }
  })
  const response = await page.request.post('/farming/api/control/agents', { data: { command: 'bash', workspace } })
  const { agentId } = await response.json() as { agentId: string }
  try {
    await openFarming(page)
    const files = page.getByTestId('code-project-group').filter({ hasText: 'page-recovery' }).getByTestId('code-files-section')
    if (await files.locator('.code-files-title').getAttribute('aria-expanded') !== 'true') await files.locator('.code-files-title').click()
    const untracked = files.getByTestId('code-file-change-untracked-group')
    await expect(untracked.getByTestId('code-file-changes-untracked-count')).toHaveText('120')
    await untracked.locator('.code-file-change-group-toggle').click()
    await expect(untracked.getByTestId('code-file-change-row')).toHaveCount(100)
    await untracked.getByRole('button', { name: /Load more/ }).click()
    const error = untracked.getByRole('alert')
    await expect(error).toContainText('Change list temporarily unavailable')
    await expect(untracked.getByTestId('code-file-change-row')).toHaveCount(100)
    const failedReads = pageReads
    await error.getByRole('button', { name: 'Refresh files', exact: true }).click()
    await expect(error).toHaveCount(0)
    await expect.poll(() => pageReads).toBeGreaterThan(failedReads)
    await expect(untracked.getByTestId('code-file-change-row')).toHaveCount(100)
    await untracked.getByRole('button', { name: /Load more/ }).click()
    await expect(untracked.getByTestId('code-file-change-row')).toHaveCount(120)
    await expect(untracked.getByRole('button', { name: /Load more/ })).toHaveCount(0)
  } finally {
    await page.request.delete(`/farming/api/control/agents/${agentId}?recordHistory=0`)
  }
})
