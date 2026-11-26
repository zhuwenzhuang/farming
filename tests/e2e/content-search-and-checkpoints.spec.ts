import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { expect, openFarming, test } from './fixtures'

function git(cwd: string, args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

test('dedicated project content search (Aa / whole word / regex) and per-turn Git checkpoints work across Light, Dark, and Paper', async ({ page, workspaceRoot }) => {
  await page.setViewportSize({ width: 1440, height: 960 })

  const repoDir = path.join(workspaceRoot, 'content-and-checkpoint-repo')
  fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true })
  fs.writeFileSync(
    path.join(repoDir, 'src', 'engine.ts'),
    [
      'export const BufferPool = 1',
      'export const bufferpool = 2',
      'export const Buffer = 3',
      '// 内存排查 RangeHistoAlgo 缓冲',
    ].join('\n') + '\n',
  )
  fs.writeFileSync(
    path.join(repoDir, 'src', 'notes.md'),
    'Discuss BufferPool scaling and RangeHistoAlgo.\n',
  )

  // Initialize git repo for real hidden Git ref checkpoint capture & rollback.
  git(repoDir, ['init'])
  git(repoDir, ['config', 'user.email', 'e2e@farming.local'])
  git(repoDir, ['config', 'user.name', 'Farming E2E'])
  git(repoDir, ['add', '.'])
  git(repoDir, ['commit', '-m', 'initial'])

  await openFarming(page)
  expect((await page.request.post('/farming/api/projects/mount', { data: { workspace: repoDir } })).ok()).toBeTruthy()
  await page.reload()
  await expect(page.getByTestId('code-nav-search')).toBeVisible()

  // 1. Open dedicated Code Content Search via SearchPanel quick action (and verify shortcut).
  await page.getByTestId('code-nav-search').click()
  const openContentBtn = page.getByTestId('code-open-content-search')
  await expect(openContentBtn).toBeVisible()
  await openContentBtn.click()

  const dialog = page.getByTestId('code-content-search-dialog')
  await expect(dialog).toBeVisible()
  const input = page.getByTestId('code-content-search-input')

  // Case-insensitive search finds both BufferPool & bufferpool across 2 files.
  await input.fill('BufferPool')
  const fileGroups = page.getByTestId('code-content-search-file-group')
  const matchRows = page.getByTestId('code-content-search-row')
  await expect(fileGroups).toHaveCount(2)
  await expect(matchRows).toHaveCount(3)

  // Match case (Aa) narrows to exact-case BufferPool (2 hits across 2 files).
  await page.getByTestId('code-content-search-match-case').click()
  await expect(matchRows).toHaveCount(2)

  // Whole word (\b) on "Buffer" matches only line 3 of src/engine.ts.
  await input.fill('Buffer')
  await page.getByTestId('code-content-search-whole-word').click()
  await expect(matchRows).toHaveCount(1)
  await expect(matchRows.first()).toContainText('export const Buffer = 3')

  // Regex (.*) supports regular expressions and shows explicit alert on invalid regex.
  await page.getByTestId('code-content-search-whole-word').click()
  await page.getByTestId('code-content-search-regex').click()
  await input.fill('Buffer(Pool)?\\s*=\\s*[13]')
  await expect(matchRows).toHaveCount(2)

  // Capture visual check across Light, Dark, and Paper when requested.
  const captureDir = process.env.FARMING_CAPTURE_VISUAL_CHECK_DIR || ''
  if (captureDir) fs.mkdirSync(captureDir, { recursive: true })
  for (const appearance of ['light', 'dark', 'paper'] as const) {
    await page.emulateMedia({ colorScheme: appearance === 'dark' ? 'dark' : 'light', reducedMotion: 'reduce' })
    await page.evaluate(value => {
      document.documentElement.dataset.appearance = value
      document.body.dataset.appearance = value
    }, appearance)
    await expect(dialog).toBeVisible()
    if (captureDir) {
      await page.screenshot({ path: path.join(captureDir, `content-search-${appearance}.png`) })
    }
  }

  // Invalid regex surfaces clear inline error alert.
  await input.fill('[unclosed')
  await expect(page.getByTestId('code-content-search-error')).toBeVisible()

  // Valid match click opens file in editor at exact line.
  await page.getByTestId('code-content-search-regex').click()
  await page.getByTestId('code-content-search-match-case').click()
  await input.fill('RangeHistoAlgo')
  await expect(matchRows).toHaveCount(2)
  await matchRows.first().click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByTestId('code-file-editor')).toBeVisible()

  // 2. Verify Turn Checkpoint API end-to-end on real server with a live agent workspace.
  const createAgent = await page.request.post('/farming/api/control/agents', {
    data: { command: 'codex', workspace: repoDir, agentRuntimeMode: 'chat' },
  })
  expect(createAgent.ok(), await createAgent.text()).toBeTruthy()
  const { agentId } = (await createAgent.json()) as { agentId: string }

  try {
    // Modify file on disk, capture checkpoint, verify diff, then rollback via HTTP API.
    fs.writeFileSync(path.join(repoDir, 'src', 'engine.ts'), 'export const BufferPool = 999\n')
    const captured = await page.request.post(`/farming/api/agents/${agentId}/turn-checkpoints`, {
      data: { summary: 'Test turn edit' },
    })
    expect(captured.ok(), await captured.text()).toBeTruthy()
    const { checkpoint } = (await captured.json()) as { checkpoint: { id: string; files: Array<{ path: string }> } }
    expect(checkpoint.id).toBeTruthy()
    expect(checkpoint.files.map(f => f.path)).toContain('src/engine.ts')

    const diffResp = await page.request.get(`/farming/api/agents/${agentId}/turn-checkpoints/${checkpoint.id}/diff`)
    expect(diffResp.ok()).toBeTruthy()
    const diffBody = (await diffResp.json()) as { patch: string }
    expect(diffBody.patch).toContain('BufferPool = 999')

    const restoreResp = await page.request.post(`/farming/api/agents/${agentId}/turn-checkpoints/${checkpoint.id}/restore`, {
      data: { target: 'before' },
    })
    expect(restoreResp.ok(), await restoreResp.text()).toBeTruthy()
    expect(fs.readFileSync(path.join(repoDir, 'src', 'engine.ts'), 'utf8')).toContain('export const BufferPool = 1')
  } finally {
    await page.request.delete(`/farming/api/agents/${agentId}`).catch(() => {})
  }
})
