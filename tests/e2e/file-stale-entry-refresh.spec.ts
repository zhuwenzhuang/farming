import fs from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { expect, openFarming, test } from './fixtures'

async function openFiles(page: Page, workspace: string) {
  const response = await page.request.post('/farming/api/control/agents', {
    data: { command: 'bash', workspace },
  })
  expect(response.ok()).toBeTruthy()
  await openFarming(page)
  const files = page.getByTestId('code-project-group').filter({ hasText: path.basename(workspace) }).getByTestId('code-files-section')
  const title = files.locator('.code-files-title').first()
  if (await title.getAttribute('aria-expanded') !== 'true') await title.click()
  return files
}

test('revalidates cached directories and removes missing ancestors without disturbing other branches', async ({ page, workspaceRoot }, testInfo) => {
  const workspace = path.join(workspaceRoot, 'stale-tree')
  for (const directory of ['keep', 'parent/gone', 'cached']) {
    fs.mkdirSync(path.join(workspace, directory), { recursive: true })
    fs.writeFileSync(path.join(workspace, directory, 'old.txt'), 'old\n')
  }
  fs.writeFileSync(path.join(workspace, 'parent/anchor.txt'), 'anchor\n')
  fs.writeFileSync(path.join(workspace, 'missing.txt'), 'missing\n')
  const files = await openFiles(page, workspace)
  const row = (name: string) => files.locator(`[data-testid="code-file-row"][data-file-path="${name}"]`)
  await row('keep').click()
  await expect(row('keep/old.txt')).toBeVisible()
  await row('cached').click()
  await expect(row('cached/old.txt')).toBeVisible()
  await row('cached').click()
  await expect(row('cached/old.txt')).toBeHidden()
  fs.unlinkSync(path.join(workspace, 'cached/old.txt'))
  fs.writeFileSync(path.join(workspace, 'cached/new.txt'), 'new\n')
  await row('cached').click()
  await expect(row('cached/new.txt')).toBeVisible()
  await expect(row('cached/old.txt')).toHaveCount(0)

  await row('parent').click()
  await expect(row('parent/gone')).toBeVisible()
  fs.rmSync(path.join(workspace, 'parent'), { recursive: true })
  await row('parent/gone').click()
  await expect(row('parent')).toHaveCount(0)
  await expect(row('keep/old.txt')).toBeVisible()

  fs.unlinkSync(path.join(workspace, 'missing.txt'))
  await row('missing.txt').click()
  await expect(row('missing.txt')).toHaveCount(0)
  await expect(files).toContainText('missing.txt: path not found')
  await expect(row('keep/old.txt')).toBeVisible()
  for (const appearance of ['light', 'dark', 'paper']) {
    await page.evaluate(value => {
      document.body.dataset.appearance = value
      document.documentElement.dataset.appearance = value
    }, appearance)
    await page.screenshot({ path: testInfo.outputPath(`${appearance}-stale-tree.png`), animations: 'disabled' })
  }
})

test('refresh reconciles a deleted open file while preserving its unsaved draft', async ({ page, workspaceRoot }, testInfo) => {
  const workspace = path.join(workspaceRoot, 'deleted-open-file')
  fs.mkdirSync(workspace, { recursive: true })
  fs.writeFileSync(path.join(workspace, 'draft.txt'), 'original\n')
  const files = await openFiles(page, workspace)
  const row = files.locator('[data-testid="code-file-row"][data-file-path="draft.txt"]')
  await row.dblclick()
  await expect(page.getByTestId('code-file-editor')).toBeVisible()
  await expect.poll(() => page.evaluate(() => Boolean(window.__farmingFileEditorTest))).toBe(true)
  await page.evaluate(() => window.__farmingFileEditorTest?.insertText('unsaved text'))
  await expect.poll(() => page.evaluate(() => window.__farmingFileEditorTest?.getValue())).toContain('unsaved text')
  fs.unlinkSync(path.join(workspace, 'draft.txt'))
  const refresh = files.getByTestId('code-files-refresh')
  await files.locator('.code-files-header').hover()
  await refresh.click()
  await expect(refresh).toHaveAttribute('data-refresh-status', 'success')
  await expect(row).toHaveCount(0)
  await expect(page.getByTestId('code-file-editor-alert')).toContainText('path not found')
  await expect.poll(() => page.evaluate(() => window.__farmingFileEditorTest?.getValue())).toContain('unsaved text')
  await page.screenshot({ path: testInfo.outputPath('deleted-file-draft.png'), animations: 'disabled' })
})

test('refresh reports the failed step while still updating successful directory reads', async ({ page, workspaceRoot }) => {
  const workspace = path.join(workspaceRoot, 'refresh-partial-failure')
  fs.mkdirSync(workspace, { recursive: true })
  fs.writeFileSync(path.join(workspace, 'old.txt'), 'old\n')
  let failChanges = false
  await page.routeWebSocket(/\/farming\/ws(?:\?|$)/, socket => {
    const server = socket.connectToServer()
    socket.onMessage(payload => {
      const message = JSON.parse(String(payload))
      if (failChanges && message.type === 'workspace-request' && message.request?.operation === 'changes') {
        socket.send(JSON.stringify({
          type: 'workspace-result', requestId: message.requestId, ok: false,
          error: { status: 503, code: 'WORKSPACE_REQUEST_FAILED', message: 'Git status unavailable' },
        }))
      } else server.send(payload)
    })
  })
  const files = await openFiles(page, workspace)
  await expect(files.locator('[data-file-path="old.txt"]')).toBeVisible()
  failChanges = true
  fs.writeFileSync(path.join(workspace, 'new.txt'), 'new\n')
  const refresh = files.getByTestId('code-files-refresh')
  await refresh.click()
  await expect(refresh).toHaveAttribute('data-refresh-status', 'error')
  await expect(refresh).toHaveAttribute('title', /Changes[\s\S]*Git status unavailable/)
  await expect(files.locator('[data-file-path="new.txt"]')).toBeVisible()
  failChanges = false
  await refresh.click()
  await expect(refresh).toHaveAttribute('data-refresh-status', 'success')
})

test('does not resurrect a removed branch from a late directory response', async ({ page, workspaceRoot }) => {
  const workspace = path.join(workspaceRoot, 'late-directory-response')
  fs.mkdirSync(path.join(workspace, 'parent/child'), { recursive: true })
  fs.writeFileSync(path.join(workspace, 'parent/anchor.txt'), 'anchor\n')
  fs.writeFileSync(path.join(workspace, 'parent/child/old.txt'), 'old\n')
  let heldRequestId: string | undefined
  let releaseResponse: (() => void) | undefined
  let reportHeld!: () => void
  const responseHeld = new Promise<void>(resolve => { reportHeld = resolve })
  await page.routeWebSocket(/\/farming\/ws(?:\?|$)/, socket => {
    const server = socket.connectToServer()
    socket.onMessage(payload => {
      const message = JSON.parse(String(payload))
      if (!heldRequestId && message.type === 'workspace-request' && message.request?.operation === 'tree' && message.request.path === 'parent/child') {
        heldRequestId = message.requestId
      }
      server.send(payload)
    })
    server.onMessage(payload => {
      const message = JSON.parse(String(payload))
      if (message.type === 'workspace-result' && message.requestId === heldRequestId) {
        releaseResponse = () => socket.send(payload)
        reportHeld()
      } else socket.send(payload)
    })
  })
  try {
    const files = await openFiles(page, workspace)
    const row = (name: string) => files.locator(`[data-testid="code-file-row"][data-file-path="${name}"]`)
    await row('parent').click()
    await row('parent/child').click()
    await responseHeld
    fs.rmSync(path.join(workspace, 'parent'), { recursive: true })
    const refresh = files.getByTestId('code-files-refresh')
    await files.locator('.code-files-header').hover()
    await refresh.click()
    await expect(refresh).toHaveAttribute('data-refresh-status', 'success')
    await expect(row('parent')).toHaveCount(0)
    releaseResponse?.()
    releaseResponse = undefined

    fs.mkdirSync(path.join(workspace, 'parent/child'), { recursive: true })
    fs.writeFileSync(path.join(workspace, 'parent/anchor.txt'), 'anchor\n')
    fs.writeFileSync(path.join(workspace, 'parent/child/new.txt'), 'new\n')
    await refresh.click()
    await expect(row('parent')).toHaveAttribute('aria-expanded', 'false')
    await row('parent').click()
    await row('parent/child').click()
    await expect(row('parent/child/new.txt')).toBeVisible()
    await expect(row('parent/child/old.txt')).toHaveCount(0)
  } finally {
    releaseResponse?.()
  }
})
