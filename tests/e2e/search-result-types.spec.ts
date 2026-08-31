import fs from 'node:fs'
import path from 'node:path'
import { expect, interceptWorkspaceRequests, openFarming, test } from './fixtures'

test.use({ timezoneId: 'UTC', locale: 'en-US' })

for (const appearance of ['light', 'dark', 'paper'] as const) {
  test(`separates files from same-name Project history in ${appearance}`, async ({ page, workspaceRoot }) => {
    await page.setViewportSize({ width: 1440, height: 1000 })
    const roots = ['first', 'second'].map(name => path.join(workspaceRoot, name, 'org', 'team', 'sql-insight'))
    for (const [index, root] of roots.entries()) {
      fs.mkdirSync(path.join(root, 'tools', 'sql-insight'), { recursive: true })
      fs.writeFileSync(path.join(root, 'tools', 'sql-insight.md'), `# Example ${index}\nEXACT_FILE_${index}\n`)
    }
    const sessions = Array.from({ length: 212 }, (_, index) => ({
      id: `search-history-${index}`,
      provider: 'codex',
      providerName: 'Codex',
      model: 'example-model',
      title: `Inspect sql-insight example ${index + 1}`,
      workspace: roots[index % roots.length],
      cwd: index === 0 ? path.join(roots[0], 'tools') : roots[index % roots.length],
      updatedAt: new Date(Date.UTC(2026, 0, 1, 12, 0) - index * 60_000).toISOString(),
    }))
    await page.route(/\/api\/agent-sessions\/search(?:\?.*)?$/, route => route.fulfill({ json: { sessions } }))
    await page.route(/\/api\/agent-sessions\?(.*)$/, route => route.fulfill({ json: { sessions: [] } }))
    let failFileSearch = false
    await interceptWorkspaceRequests(page, request => {
      if (request.operation !== 'search' || request.scope !== 'entries' || !failFileSearch) return undefined
      return { response: { ok: false, error: { code: 'SEARCH_UNAVAILABLE', message: 'Search unavailable', status: 503 } } }
    })
    await openFarming(page)
    for (const workspace of roots) {
      expect((await page.request.post('/farming/api/projects/mount', { data: { workspace } })).ok()).toBeTruthy()
    }
    const response = await page.request.post('/farming/api/control/agents', { data: { command: 'bash', workspace: roots[0] } })
    expect(response.ok()).toBeTruthy()
    const { agentId } = await response.json() as { agentId: string }
    try {
      await page.emulateMedia({ colorScheme: appearance === 'dark' ? 'dark' : 'light', reducedMotion: 'reduce' })
      await page.evaluate(value => {
        document.documentElement.dataset.appearance = value
        document.body.dataset.appearance = value
      }, appearance)
      await page.getByTestId('code-nav-search').click()
      const input = page.getByRole('combobox', { name: 'Search projects, agents, or files' })
      await input.fill('sql-insight')
      const files = page.getByTestId('code-global-file-search-result')
      const history = page.getByTestId('code-session-search-result')
      await expect(files).toHaveCount(2)
      await expect(history).toHaveCount(212)
      await expect(page.getByTestId('code-search-filter-files')).toHaveText('Files and Folders 6')
      await expect(page.getByTestId('code-search-filter-sessions')).toHaveText('History 212')
      await expect(page.getByTestId('code-search-filter-agents')).toHaveText('Current Agents 1')
      await expect(page.getByRole('listbox').getByRole('option').first()).toHaveAttribute('data-testid', 'code-global-directory-search-result')
      await expect(files.first()).toBeInViewport()
      await expect.poll(async () => (await page.getByTestId('code-search-group-workspace').allTextContents()).sort()).toEqual([
        '…/first/org/team/sql-insight', '…/second/org/team/sql-insight',
      ])
      await expect(history.first()).toContainText('History')
      await expect(history.filter({ hasText: 'Working directory:' })).toHaveCount(1)
      // Keep capture paths anonymous and stable without hiding identity differences.
      await expect(page.getByTestId('code-main')).toHaveScreenshot(`search-result-types-${appearance}.png`, {
        mask: [page.locator('.code-search-working-directory')],
      })

      await page.getByTestId('code-search-filter-files').click()
      await expect(input).toHaveValue('sql-insight')
      await expect(history).toHaveCount(0)
      await expect(page.getByTestId('code-search-result')).toHaveCount(0)
      await input.fill('sql-insight.md')
      await expect(files).toHaveCount(2)
      await expect(files.first()).toHaveAttribute('aria-selected', 'true')
      await input.press('ArrowDown')
      await expect(files.nth(1)).toHaveAttribute('aria-selected', 'true')
      const selectedFileText = await files.nth(1).textContent()
      const expectedFile = selectedFileText?.includes('first/org/team/sql-insight') ? 'EXACT_FILE_0' : 'EXACT_FILE_1'
      await input.press('Enter')
      await expect(page.getByTestId('code-file-markdown-preview')).toContainText(expectedFile)

      await page.getByTestId('code-nav-search').click()
      await input.fill('sql-insight')
      await expect(files).toHaveCount(2)
      await page.getByTestId('code-search-filter-sessions').click()
      await expect(files).toHaveCount(0)
      await expect(history).toHaveCount(212)
      await expect(history.first()).toHaveAttribute('aria-selected', 'true')
      await input.press('ArrowDown')
      await expect(history.nth(1)).toHaveAttribute('aria-selected', 'true')
      await page.getByTestId('code-search-filter-agents').click()
      await expect(history).toHaveCount(0)
      await expect(page.getByTestId('code-search-result')).toHaveCount(1)
      await expect(page.getByTestId('code-search-result')).toHaveAttribute('aria-selected', 'true')

      // History matches must not mask an empty or failed file search.
      await page.getByTestId('code-search-filter-all').click()
      await input.fill('example')
      await expect(history).toHaveCount(212)
      await expect(page.getByTestId('code-global-file-search-empty')).toBeVisible()
      await page.getByTestId('code-search-filter-files').click()
      await expect(page.getByTestId('code-empty-search')).toHaveText('No matching files or folders in mounted Projects.')
      await page.getByTestId('code-search-filter-all').click()
      failFileSearch = true
      await input.fill('sql-insight')
      await expect(history).toHaveCount(212)
      await expect(page.getByTestId('code-global-file-search-partial')).toBeInViewport()
    } finally {
      expect((await page.request.delete(`/farming/api/control/agents/${agentId}`)).ok()).toBeTruthy()
    }
  })
}
