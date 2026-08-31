import fs from 'node:fs'
import path from 'node:path'
import { expect, interceptWorkspaceRequests, openFarming, test } from './fixtures'

for (const appearance of ['light', 'dark', 'paper'] as const) {
  test(`searches directory identities and reveals an empty directory in ${appearance}`, async ({ page, workspaceRoot }) => {
    await page.setViewportSize({ width: 1440, height: 1000 })
    const roots = ['first', 'second'].map(name => path.join(workspaceRoot, name, 'org', 'team', 'example-project'))
    for (const root of roots) {
      fs.mkdirSync(path.join(root, 'tools', 'sql-insight'), { recursive: true })
      fs.mkdirSync(path.join(root, 'archive', 'sql-insight'), { recursive: true })
      fs.writeFileSync(path.join(root, 'tools', 'sql-insight', 'SKILL.md'), '# Nested file\n')
      fs.writeFileSync(path.join(root, 'sql-insight.md'), '# Matching filename\n')
    }
    let agentMutationCount = 0
    page.on('request', request => {
      if (request.method() === 'POST' && /\/(agents|agent-sessions)(\/|$)/.test(new URL(request.url()).pathname)) agentMutationCount += 1
    })
    await page.route(/\/api\/agent-sessions\/search(?:\?.*)?$/, route => route.fulfill({ json: { sessions: [] } }))
    await openFarming(page)
    for (const workspace of roots) {
      expect((await page.request.post('/farming/api/projects/mount', { data: { workspace } })).ok()).toBeTruthy()
    }
    await page.emulateMedia({ colorScheme: appearance === 'dark' ? 'dark' : 'light', reducedMotion: 'reduce' })
    await page.evaluate(value => {
      document.documentElement.dataset.appearance = value
      document.body.dataset.appearance = value
    }, appearance)
    await page.getByTestId('code-nav-search').click()
    const input = page.getByRole('combobox', { name: 'Search projects, agents, or files' })
    const directories = page.getByTestId('code-global-directory-search-result')
    const files = page.getByTestId('code-global-file-search-result')
    await input.fill('sql-insight')
    await expect(directories).toHaveCount(4)
    await expect(files).toHaveCount(2)
    await expect(page.getByTestId('code-search-filter-files')).toHaveText('Files and Folders 6')
    await expect(page.getByRole('listbox').getByRole('option').first()).toHaveAttribute('data-testid', 'code-global-directory-search-result')
    await expect(files).not.toContainText(['SKILL.md', 'SKILL.md'])
    await expect(page.getByTestId('code-main')).toHaveScreenshot(`directory-results-${appearance}.png`)

    // A path query is explicit; it does not list everything below the directory.
    await input.fill('tools/sql-insight/')
    await expect(directories).toHaveCount(2)
    await expect(files).toHaveCount(0)
    await input.fill('sql-insight/SKILL.md')
    await expect(directories).toHaveCount(0)
    await expect(files).toHaveCount(2)

    const emptyPath = path.join(roots[1], 'archive', 'sql-insight')
    await input.fill(emptyPath)
    await expect(directories).toHaveCount(1)
    await expect(directories).toHaveAttribute('aria-selected', 'true')
    await input.press('Enter')
    await expect(page.getByTestId('code-search-panel')).toHaveCount(0)
    const selected = page.locator('[data-testid="code-file-row"].selected[data-file-path="archive/sql-insight"]')
    await expect(selected).toBeVisible()
    await expect(selected).toHaveAttribute('aria-expanded', 'true')
    await expect(selected.locator('xpath=ancestor::*[@data-testid="code-files-section"]')).toHaveAttribute('data-project-id', roots[1])
    await expect(page.getByTestId('code-file-editor')).toHaveCount(0)
    expect(agentMutationCount).toBe(0)

    await page.getByTestId('code-nav-search').click()
    await input.fill(roots[0])
    await expect(directories).toHaveCount(1)
    await directories.click()
    await expect(page.getByTestId('code-search-panel')).toHaveCount(0)
    await expect(page.locator(`[data-testid="code-files-section"][data-project-id="${roots[0]}"]`)).not.toHaveClass(/collapsed/)
    await expect(page.getByTestId('code-file-editor')).toHaveCount(0)
    expect(agentMutationCount).toBe(0)
  })
}

test('keeps Search on directory failure and cancels a delayed reveal when the query changes', async ({ page, workspaceRoot }) => {
  const root = path.join(workspaceRoot, 'directory-failures')
  const slowPath = 'tools/slow-directory'
  fs.mkdirSync(path.join(root, slowPath), { recursive: true })
  fs.mkdirSync(path.join(root, 'deleted-directory'), { recursive: true })
  let releaseRead!: () => void
  const readReleased = new Promise<void>(resolve => { releaseRead = resolve })
  let markReadStarted!: () => void
  const readStarted = new Promise<void>(resolve => { markReadStarted = resolve })
  let delayRead = false
  await interceptWorkspaceRequests(page, request => {
    if (!delayRead || request.operation !== 'tree' || request.path !== slowPath) return undefined
    return { onResult: async message => { markReadStarted(); await readReleased; return message } }
  })
  await page.route(/\/api\/agent-sessions\/search(?:\?.*)?$/, route => route.fulfill({ json: { sessions: [] } }))
  await openFarming(page)
  expect((await page.request.post('/farming/api/projects/mount', { data: { workspace: root } })).ok()).toBeTruthy()
  try {
    await page.getByTestId('code-nav-search').click()
    const input = page.getByRole('combobox', { name: 'Search projects, agents, or files' })
    const result = page.getByTestId('code-global-directory-search-result')
    await input.fill('deleted-directory')
    await expect(result).toHaveCount(1)
    fs.rmdirSync(path.join(root, 'deleted-directory'))
    await result.click()
    await expect(page.getByTestId('code-global-file-open-error')).toContainText('Could not open folder: deleted-directory')
    await expect(input).toHaveValue('deleted-directory')
    await input.fill('slow-directory')
    await expect(result).toHaveCount(1)
    delayRead = true
    await result.click()
    await readStarted
    await expect(result).toHaveAttribute('aria-busy', 'true')
    await expect(result).toContainText('Opening folder')
    await input.fill('missing-directory')
    await expect(result).toHaveCount(0)
    releaseRead()
    await expect(page.getByTestId('code-empty-search')).toBeVisible()
    await expect(page.getByTestId('code-search-panel')).toBeVisible()
    await expect(page.getByTestId('code-file-editor')).toHaveCount(0)
    await expect(page.getByTestId('code-global-file-open-error')).toHaveCount(0)
  } finally {
    releaseRead()
  }
})

test('a newer directory activation owns navigation over an older delayed read', async ({ page, workspaceRoot }) => {
  const root = path.join(workspaceRoot, 'directory-activation-order')
  fs.mkdirSync(path.join(root, 'first-target'), { recursive: true })
  fs.mkdirSync(path.join(root, 'second-target'), { recursive: true })
  let releaseRead!: () => void
  const readReleased = new Promise<void>(resolve => { releaseRead = resolve })
  let firstReadStarted = false
  await interceptWorkspaceRequests(page, request => {
    if (request.operation !== 'tree' || request.path !== 'first-target') return undefined
    return { onResult: async message => { firstReadStarted = true; await readReleased; return message } }
  })
  await page.route(/\/api\/agent-sessions\/search(?:\?.*)?$/, route => route.fulfill({ json: { sessions: [] } }))
  await openFarming(page)
  expect((await page.request.post('/farming/api/projects/mount', { data: { workspace: root } })).ok()).toBeTruthy()
  try {
    await page.getByTestId('code-nav-search').click()
    await page.getByRole('combobox', { name: 'Search projects, agents, or files' }).fill('target')
    const results = page.getByTestId('code-global-directory-search-result')
    await expect(results).toHaveCount(2)
    await results.filter({ hasText: 'first-target' }).click()
    await expect.poll(() => firstReadStarted).toBe(true)
    await results.filter({ hasText: 'second-target' }).click()
    const selected = page.locator('[data-testid="code-file-row"].selected')
    await expect(selected).toHaveAttribute('data-file-path', 'second-target')
    releaseRead()
    await expect(page.getByTestId('code-search-panel')).toHaveCount(0)
    await expect(selected).toHaveAttribute('data-file-path', 'second-target')
    await expect(page.getByTestId('code-file-editor')).toHaveCount(0)
  } finally {
    releaseRead()
  }
})
