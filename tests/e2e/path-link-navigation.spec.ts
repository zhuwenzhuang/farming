import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import type { Page } from '@playwright/test'
import { expect, interceptWorkspaceRequests, openFarming, terminalRows, test, writeTerminalFixture } from './fixtures'

async function createAgent(page: Page, workspace: string, command = 'codex') {
  const response = await page.request.post('/farming/api/control/agents', {
    data: { command, workspace, ...(command === 'codex' ? { agentRuntimeMode: 'chat' } : {}) },
  })
  expect(response.ok()).toBeTruthy()
  return (await response.json() as { agentId: string }).agentId
}

async function transcript(page: Page, agentId: string, text: string) {
  const response = await page.request.get(`/farming/api/agents/${agentId}/acp-transcript?maxTurns=5&media=external-v1`)
  const identity = await response.json() as { sessionId: string; runtimeEpoch: string; toRevision: number }
  const revision = identity.toRevision + 1_000_000
  await page.route(new RegExp(`/farming/api/agents/${agentId}/acp-transcript(?:\\?.*)?$`), route => route.fulfill({
    json: {
      version: 1, agentId, sessionId: identity.sessionId, runtimeEpoch: identity.runtimeEpoch,
      fromRevision: null, toRevision: revision, replace: true, settled: true, hasMoreBefore: false,
      transcript: { sessionId: identity.sessionId, provider: 'codex', revision, state: 'idle', entries: [
        { id: 'question', type: 'message', role: 'user', content: [{ type: 'text', text: 'Open the checked out reference.' }] },
        { id: 'answer', type: 'message', role: 'assistant', content: [{ type: 'text', text }] },
      ] },
    },
  }))
}

for (const appearance of ['light', 'dark', 'paper'] as const) {
  test(`opens exact directory links across Chat, preview and Projects in ${appearance}`, async ({ page, workspaceRoot }, testInfo) => {
    const workspace = path.join(workspaceRoot, 'path-link-reader')
    const other = path.join(workspaceRoot, 'path-link-other')
    fs.mkdirSync(path.join(workspace, 'reference', 'gluten'), { recursive: true })
    fs.mkdirSync(path.join(workspace, 'empty'), { recursive: true })
    fs.mkdirSync(path.join(other, 'peer'), { recursive: true })
    fs.writeFileSync(path.join(workspace, '.gitignore'), 'reference/\n')
    execFileSync('git', ['init', '--quiet'], { cwd: workspace })
    fs.writeFileSync(path.join(workspace, 'reference/gluten/README.md'), '# Gluten reference\n')
    fs.writeFileSync(path.join(workspace, 'missing.md'), '# Wrong same-named file\n')
    fs.symlinkSync('reference/gluten', path.join(workspace, 'linked-directory'), 'dir')
    fs.writeFileSync(path.join(workspace, 'guide.md'), [
      '# Local paths', '[Directory](reference/gluten/)', '[Root](./)',
      '[Missing](deleted/missing.md)',
      `[Absolute directory](${workspace}/empty)`,
      `[File URL](file://${workspace}/reference/gluten/README.md#L1)`,
      '[Unsafe](javascript:alert%281%29)',
      ...(appearance === 'paper' ? Array.from({ length: 1500 }, (_, index) => `## Section ${index}\n\n${'Reference content. '.repeat(12)}`) : []),
    ].join('\n\n'))
    await page.request.post('/farming/api/settings', { data: { appearance } })
    const agentId = await createAgent(page, workspace)
    await createAgent(page, other)
    await transcript(page, agentId, [
      `Cloned to [reference/gluten/](${workspace}/reference/gluten).`,
      '[Empty](empty) · [Symlink](linked-directory/) · [Preview](guide.md) · [Root](./)',
      `[Other Project](${other}/peer/)`,
      '[Missing](deleted/missing.md) · [Missing directory](deleted/gluten/) · [Denied](denied.txt)',
    ].join('\n\n'))
    let searches = 0
    await interceptWorkspaceRequests(page, request => {
      if (request.operation === 'search') searches += 1
      if ((request.operation === 'read-file' || request.operation === 'tree') && request.path === 'denied.txt') {
        return { response: { ok: false, error: { code: 'FORBIDDEN', message: 'Permission denied', status: 403 } } }
      }
    })
    await openFarming(page)
    await page.locator(`[data-agent-id="${agentId}"][data-testid="code-agent-row"]`).click()
    const answer = page.locator('.code-agent-transcript-answer')
    const project = page.getByTestId('code-project-group').filter({ hasText: 'path-link-reader' })
    const row = (filePath: string) => project.locator(`[data-testid="code-file-row"][data-file-path="${filePath}"]`)
    await answer.getByRole('link', { name: 'gluten', exact: true }).first().click()
    await expect(row('reference/gluten')).toHaveAttribute('aria-expanded', 'true')
    await expect(row('reference/gluten/README.md')).toBeVisible()
    await expect(page.getByTestId('code-file-editor')).toHaveCount(0)
    await expect(page.locator('.code-copy-toast.error')).toHaveCount(0)
    await project.screenshot({ path: testInfo.outputPath(`directory-link-${appearance}.png`), animations: 'disabled' })
    await answer.getByRole('link', { name: 'empty', exact: true }).click()
    await expect(row('empty')).toHaveAttribute('aria-expanded', 'true')
    await answer.getByRole('link', { name: 'linked-directory', exact: true }).click()
    await expect(row('linked-directory/README.md')).toBeVisible()
    await answer.getByRole('link', { name: 'peer', exact: true }).click()
    const peer = page.getByTestId('code-project-group').filter({ hasText: 'path-link-other' })
    await expect(peer.locator('[data-file-path="peer"][data-testid="code-file-row"]')).toHaveAttribute('aria-expanded', 'true')
    await answer.getByRole('link', { name: 'missing.md', exact: true }).click()
    await expect(page.locator('.code-copy-toast.error')).toContainText('deleted/missing.md')
    await expect(page.getByTestId('code-file-editor')).toHaveCount(0)
    expect(searches).toBe(0)
    await answer.getByRole('link', { name: 'gluten', exact: true }).last().click()
    await expect(page.locator('.code-copy-toast.error')).toContainText('deleted/gluten')
    await answer.getByRole('link', { name: 'denied.txt', exact: true }).click()
    await expect(page.locator('.code-copy-toast.error')).toContainText('denied.txt')
    expect(searches).toBe(0)

    await answer.getByRole('link', { name: 'guide.md', exact: true }).click()
    const preview = page.getByTestId('code-file-markdown-preview')
    await expect(preview).toBeVisible()
    await preview.getByRole('link', { name: 'Directory', exact: true }).click()
    await expect(row('reference/gluten')).toHaveAttribute('aria-expanded', 'true')
    await preview.getByRole('link', { name: 'Root', exact: true }).click()
    await expect(project.locator('.code-files-title').first()).toHaveAttribute('aria-expanded', 'true')
    await preview.getByRole('link', { name: 'Absolute directory', exact: true }).click()
    await expect(row('empty')).toHaveAttribute('aria-expanded', 'true')
    await preview.getByRole('link', { name: 'Missing', exact: true }).click()
    await expect(page.locator('.code-copy-toast.error')).toContainText('deleted/missing.md')
    await expect(preview.getByRole('heading', { name: 'Local paths' })).toBeVisible()
    expect(searches).toBe(0)
    await expect(preview.getByRole('link', { name: 'Unsafe' })).not.toHaveAttribute('href', /javascript:/)
    await preview.getByRole('link', { name: 'File URL', exact: true }).click()
    await expect(page.getByRole('tab', { name: /^README\.md/ })).toHaveAttribute('aria-selected', 'true')
    await expect(preview.getByRole('heading', { name: 'Gluten reference' })).toBeVisible()
  })
}

test('a delayed directory link cannot replace a newer file navigation', async ({ page, workspaceRoot }) => {
  const workspace = path.join(workspaceRoot, 'path-link-ordering')
  fs.mkdirSync(path.join(workspace, 'slow-directory'), { recursive: true })
  fs.writeFileSync(path.join(workspace, 'latest.txt'), 'Newest selection\n')
  const agentId = await createAgent(page, workspace)
  await transcript(page, agentId, '[Old](slow-directory/) · [New](latest.txt)')
  let release: (() => void) | undefined
  let held = false
  let returned = false
  const gate = new Promise<void>(resolve => { release = resolve })
  await interceptWorkspaceRequests(page, request => {
    if (request.operation === 'tree' && request.path === 'slow-directory/' && !held) {
      held = true
      return { onResult: async result => { await gate; returned = true; return result } }
    }
  })
  try {
    await openFarming(page)
    await page.locator(`[data-agent-id="${agentId}"][data-testid="code-agent-row"]`).click()
    const answer = page.locator('.code-agent-transcript-answer')
    await answer.getByRole('link', { name: 'slow-directory', exact: true }).click()
    await expect.poll(() => held).toBe(true)
    await answer.getByRole('link', { name: 'latest.txt', exact: true }).click()
    await expect(page.getByRole('tab', { name: /^latest\.txt/ })).toHaveAttribute('aria-selected', 'true')
    release?.()
    await expect.poll(() => returned).toBe(true)
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    await expect(page.locator('[data-file-path="slow-directory"][data-testid="code-file-row"]')).toHaveAttribute('aria-expanded', 'false')
    await expect(page.getByRole('tab', { name: /^latest\.txt/ })).toHaveAttribute('aria-selected', 'true')
  } finally { release?.() }
})

test('Terminal absolute directory links reveal an existing Project', async ({ page, workspaceRoot }) => {
  const launcher = path.join(workspaceRoot, 'link-terminal')
  const other = path.join(workspaceRoot, 'link-target')
  fs.mkdirSync(launcher, { recursive: true })
  fs.mkdirSync(path.join(other, 'directory'), { recursive: true })
  const agentId = await createAgent(page, launcher, 'bash')
  await createAgent(page, other)
  await openFarming(page)
  await page.locator(`[data-agent-id="${agentId}"][data-testid="code-agent-row"]`).click()
  await writeTerminalFixture(page, agentId, `${other}/directory/\r\n`)
  const rows = await terminalRows(page, agentId, 40)
  const row = rows.findIndex(text => text.includes('/directory/'))
  expect(row).toBeGreaterThanOrEqual(0)
  const col = rows[row]!.indexOf('/directory/') + 2
  const cell = await page.evaluate(({ agentId, row, col }) => window.__farmingTerminalTest?.getCellCenter(agentId, col, row), { agentId, row, col })
  if (!cell) throw new Error('Missing terminal path cell')
  await page.mouse.click(cell.x, cell.y)
  const project = page.getByTestId('code-project-group').filter({ hasText: 'link-target' })
  await expect(project.locator('[data-file-path="directory"][data-testid="code-file-row"]')).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByTestId('code-file-editor')).toHaveCount(0)
  await expect(page.locator('.code-copy-toast.error')).toHaveCount(0)
})
