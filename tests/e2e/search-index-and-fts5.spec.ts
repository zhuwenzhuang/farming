import fs from 'node:fs'
import path from 'node:path'
import { expect, openFarming, test } from './fixtures'

interface SettingsResponse {
  settings?: {
    agentHomes?: Record<string, Array<{ id: string; path: string }>>
  }
}

test('in-memory multi-token/fuzzy file search and SQLite FTS5 session search work across Light, Dark, and Paper', async ({ page, workspaceRoot }) => {
  await page.setViewportSize({ width: 1440, height: 960 })

  // 1. Create a real workspace with deep nested files for multi-token & >6-char fuzzy search.
  const projectDir = path.join(workspaceRoot, 'search-parity-repo')
  fs.mkdirSync(path.join(projectDir, 'task', 'sql_task', 'execution_engine', 'streamline'), { recursive: true })
  fs.writeFileSync(
    path.join(projectDir, 'task', 'sql_task', 'execution_engine', 'streamline', 'slx_columnar_serialize_buffer.cpp'),
    '// serialize buffer impl\n',
  )
  fs.writeFileSync(
    path.join(projectDir, 'task', 'sql_task', 'execution_engine', 'streamline', 'slx_columnar_serialize_buffer.h'),
    '// serialize buffer header\n',
  )

  // 2. Create an isolated Codex home containing a session whose title does NOT mention the body query.
  // Use a non-temporary workspace path in the session metadata because Codex history filters /tmp & /var/folders.
  const sessionWorkspace = '/workspace/search-parity-demo'
  const isolatedCodexHome = path.join(workspaceRoot, 'isolated-codex-fts5-home')
  const sessionId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  const sessionFile = path.join(isolatedCodexHome, 'sessions', '2026', '11', '26', `rollout-2026-11-26-${sessionId}.jsonl`)
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true })
  fs.writeFileSync(sessionFile, [
    JSON.stringify({
      type: 'session_meta',
      payload: {
        id: sessionId,
        cwd: sessionWorkspace,
        timestamp: '2026-11-26T10:00:00.000Z',
      },
    }),
    JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'user_message',
        message: '排查 RangeHistoAlgo 内存暴涨和 slx_columnar_serialize_buffer OOM 根因',
      },
    }),
    JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'agent_message',
        message: 'Confirmed sapphire_fts5_e2e_marker inside columnar serialize buffer.',
      },
    }),
  ].join('\n') + '\n')
  fs.writeFileSync(
    path.join(isolatedCodexHome, 'session_index.jsonl'),
    JSON.stringify({
      id: sessionId,
      thread_name: 'Weekly build triage',
      updated_at: '2026-11-26T10:05:00.000Z',
      cwd: sessionWorkspace,
      workspace: sessionWorkspace,
    }) + '\n',
  )

  await openFarming(page)

  // Register isolated Codex home and mount workspace, always restoring settings in finally.
  const currentSettingsResponse = await page.request.get('/farming/api/settings')
  expect(currentSettingsResponse.ok()).toBeTruthy()
  const currentSettings = (await currentSettingsResponse.json()) as SettingsResponse
  const originalAgentHomes = currentSettings.settings?.agentHomes ?? {}
  const originalCodexHomes = Array.isArray(originalAgentHomes.codex) ? originalAgentHomes.codex : []
  const tempHomeId = `fts5-e2e-${Date.now()}`

  try {
    const updateSettings = await page.request.post('/farming/api/settings', {
      data: {
        agentHomes: {
          ...originalAgentHomes,
          codex: [...originalCodexHomes, { id: tempHomeId, path: isolatedCodexHome }],
        },
      },
    })
    expect(updateSettings.ok(), await updateSettings.text()).toBeTruthy()
    expect((await page.request.post('/farming/api/projects/mount', { data: { workspace: projectDir } })).ok()).toBeTruthy()

    // Force session inventory reload so the newly registered home is visible immediately.
    expect((await page.request.get('/farming/api/agent-sessions?force=1')).ok()).toBeTruthy()
    await page.reload()
    await expect(page.getByTestId('code-nav-search')).toBeVisible()

    // A. Global Search: multi-token file query ("streamline buf") + >6-char fuzzy ("slxcolserbuf")
    await page.getByTestId('code-nav-search').click()
    const globalSearchInput = page.getByRole('combobox', { name: 'Search projects, agents, or files' })
    await globalSearchInput.fill('streamline buf')
    const fileResults = page.getByTestId('code-global-file-search-result')
    await expect(fileResults).toHaveCount(2)
    await expect(fileResults.first()).toContainText('slx_columnar_serialize_buffer')

    await globalSearchInput.fill('slxcolserbuf')
    await expect(fileResults).toHaveCount(2)
    await expect(fileResults.first().locator('strong .code-search-highlight')).toHaveCount(4)
    await expect(fileResults.first().locator('.code-search-file-path .code-search-highlight')).toHaveCount(4)

    // B. Global Search: SQLite FTS5 body-only search (English token + 2-char CJK token)
    await globalSearchInput.fill('sapphire_fts5_e2e_marker')
    const sessionResults = page.getByTestId('code-session-search-result')
    await expect(sessionResults).toHaveCount(1)
    await expect(sessionResults.first()).toContainText('Weekly build triage')
    const searchSnippet = sessionResults.first().getByTestId('code-session-search-snippet')
    await expect(searchSnippet).toBeVisible()
    await expect(searchSnippet).toContainText('sapphire_fts5_e2e_marker')
    await expect(searchSnippet.locator('.code-search-highlight')).toContainText('sapphire_fts5_e2e_marker')

    // C. Verify SearchPanel FTS5 snippet rendering across Light, Dark, and Paper themes.
    const captureDir = process.env.FARMING_CAPTURE_VISUAL_CHECK_DIR || ''
    if (captureDir) fs.mkdirSync(captureDir, { recursive: true })
    for (const appearance of ['light', 'dark', 'paper'] as const) {
      await page.emulateMedia({ colorScheme: appearance === 'dark' ? 'dark' : 'light', reducedMotion: 'reduce' })
      await page.evaluate(value => {
        document.documentElement.dataset.appearance = value
        document.body.dataset.appearance = value
      }, appearance)
      await expect(searchSnippet).toBeVisible()
      const snippetBox = await searchSnippet.boundingBox()
      expect(snippetBox && snippetBox.height > 10 && snippetBox.width > 100).toBeTruthy()
      if (captureDir) {
        await page.screenshot({ path: path.join(captureDir, `search-fts5-${appearance}.png`) })
      }
    }

    // D. History Panel: FTS5 CJK 2-char query ("内存") finds the session and renders highlighted snippet.
    await page.getByTestId('code-nav-history').click()
    const historySearchInput = page.getByTestId('code-history-search-box').locator('input')
    await historySearchInput.fill('RangeHistoAlgo 内存')
    const historyCards = page.getByTestId('code-session-history-card')
    await expect(historyCards).toHaveCount(1)
    await expect(historyCards.first()).toContainText('Weekly build triage')
    const historySnippet = historyCards.first().getByTestId('code-history-session-snippet')
    await expect(historySnippet).toBeVisible()
    await expect(historySnippet).toContainText('RangeHistoAlgo')
    await expect(historySnippet).toContainText('内存')
    await expect(historySnippet.locator('.code-history-highlight').first()).toBeVisible()

    // Verify HistoryPanel FTS5 snippet across Light, Dark, and Paper.
    for (const appearance of ['light', 'dark', 'paper'] as const) {
      await page.emulateMedia({ colorScheme: appearance === 'dark' ? 'dark' : 'light', reducedMotion: 'reduce' })
      await page.evaluate(value => {
        document.documentElement.dataset.appearance = value
        document.body.dataset.appearance = value
      }, appearance)
      await expect(historySnippet).toBeVisible()
      if (captureDir) {
        await page.screenshot({ path: path.join(captureDir, `history-fts5-${appearance}.png`) })
      }
    }
  } finally {
    await page.request.post('/farming/api/settings', {
      data: { agentHomes: originalAgentHomes },
    }).catch(() => {})
    await page.request.get('/farming/api/agent-sessions?force=1').catch(() => {})
  }
})
