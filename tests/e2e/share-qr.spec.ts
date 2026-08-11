import fs from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { expect, openFarming, test } from './fixtures'

async function createAgent(page: Page, workspace: string, agentRuntimeMode: 'chat' | 'terminal') {
  const response = await page.request.post('/farming/api/control/agents', {
    data: { command: agentRuntimeMode === 'chat' ? 'claude' : 'bash', workspace, agentRuntimeMode },
  })
  expect(response.ok()).toBeTruthy()
  const payload = await response.json() as { agentId?: string }
  expect(payload.agentId).toBeTruthy()
  return payload.agentId as string
}

test.describe('workspace sharing', () => {
  test('keeps read-only and full-control copy actions distinct', async ({ page }) => {
    const readOnlyUrl = 'https://share.example.test/workspace?token=read-only'
    const fullAccessUrl = 'https://share.example.test/workspace?token=full-control'
    await page.route('**/api/share/qr-ticket', async route => {
      if (route.request().method() === 'DELETE') {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ revoked: true }) })
        return
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 'SHARECODE1',
          expiresAt: Date.now() + 5 * 60 * 1000,
          ttlMs: 5 * 60 * 1000,
          shortPath: '/j/SHARECODE1',
          shortUrl: 'https://share.example.test/j/SHARECODE1',
          longUrl: readOnlyUrl,
          fullAccessUrl,
          shortUrlAccessMode: 'owner',
          longUrlAccessMode: 'read-only',
          tokenLabel: '春风轻拂长堤岸边-轻落庭前幽静深处-一枝梅花悄然盛开',
        }),
      })
    })

    await page.setViewportSize({ width: 1000, height: 900 })
    await openFarming(page)
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(page.url()).origin })
    await page.getByTestId('code-share-button').click()

    const popover = page.getByTestId('code-share-popover')
    await expect(popover).toHaveCSS('color', 'rgb(38, 51, 39)')
    await page.evaluate(() => document.body.setAttribute('data-appearance', 'dark'))
    await expect(popover).toHaveCSS('color', 'rgb(255, 255, 255)')

    await expect.poll(async () => page.evaluate(() => navigator.clipboard.readText())).toBe(readOnlyUrl)
    await expect(page.getByTestId('code-share-copy-status')).toContainText(/Current page read-only link copied|当前页面只读链接已复制/)

    const fullAccessButton = page.getByTestId('code-share-copy-link')
    await expect(fullAccessButton).toBeVisible()
    await expect(fullAccessButton.locator('.code-share-token-line')).toHaveCount(3)
    await expect(fullAccessButton).toContainText(/Copy full-control passphrase link|复制完整控制口令链接/)
    await fullAccessButton.click()

    await expect.poll(async () => page.evaluate(() => navigator.clipboard.readText())).toBe(fullAccessUrl)
    await expect(fullAccessButton).toContainText(/Full-control passphrase link copied|完整控制口令链接已复制/)
  })

  test('copies the selected Chat Turn read-only link and fences an older response', async ({ page, workspaceRoot }) => {
    const workspace = path.join(workspaceRoot, 'chat-context-share')
    fs.mkdirSync(workspace, { recursive: true })
    const agentId = await createAgent(page, workspace, 'chat')
    const capturedTargets: Array<{ agentId?: string; readingAnchor?: string }> = []
    let releaseFirstShare = () => {}
    const firstShareGate = new Promise<void>(resolve => { releaseFirstShare = resolve })
    let shareRequestCount = 0
    let revokedTickets = 0

    await page.route(new RegExp(`/farming/api/agents/${agentId}/acp-transcript(?:\\?.*)?$`), async route => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          transcript: {
            sessionId: 'chat-context-share-session',
            state: 'idle',
            revision: 1,
            entries: [
              { id: 'share-user-one', type: 'message', role: 'user', content: [{ type: 'text', text: 'First question' }] },
              { id: 'share-answer-one', type: 'message', role: 'assistant', _meta: { codex: { phase: 'final_answer' } }, content: [{ type: 'text', text: 'First answer to share' }] },
              { id: 'share-user-two', type: 'message', role: 'user', content: [{ type: 'text', text: 'Second question' }] },
              { id: 'share-answer-two', type: 'message', role: 'assistant', _meta: { codex: { phase: 'final_answer' } }, content: [{ type: 'text', text: 'Second answer to share' }] },
            ],
          },
        }),
      })
    })
    await page.route('**/api/share/qr-ticket**', async route => {
      if (route.request().method() === 'DELETE') {
        revokedTickets += 1
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ revoked: true }) })
        return
      }
      shareRequestCount += 1
      const target = (route.request().postDataJSON() as { target?: { agentId?: string; readingAnchor?: string } }).target
      capturedTargets.push(target || {})
      const requestNumber = shareRequestCount
      if (requestNumber === 1) await firstShareGate
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          code: `DIRECTCHAT${requestNumber}`,
          expiresAt: Date.now() + 5 * 60 * 1000,
          ttlMs: 5 * 60 * 1000,
          shortPath: `/j/DIRECTCHAT${requestNumber}`,
          shortUrl: `https://share.example.test/j/DIRECTCHAT${requestNumber}`,
          longUrl: `https://share.example.test/chat-${requestNumber}`,
          shortUrlAccessMode: 'owner',
          longUrlAccessMode: 'read-only',
          tokenLabel: 'owner-token',
        }),
      })
    })

    await openFarming(page)
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(page.url()).origin })
    await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
    await expect(page.getByText('Second answer to share', { exact: true })).toBeVisible()
    const turnIds = await page.locator('[data-testid="code-agent-chat-view"] article[data-turn-id]').evaluateAll(turns => (
      turns.map(turn => (turn as HTMLElement).dataset.turnId || '')
    ))
    expect(turnIds).toHaveLength(2)

    const shareButtons = page.getByTestId('code-agent-transcript-share-answer')
    await expect(shareButtons).toHaveCount(2)
    await shareButtons.nth(0).click()
    await expect.poll(() => shareRequestCount).toBe(1)
    await shareButtons.nth(1).click()
    await expect.poll(async () => page.evaluate(() => navigator.clipboard.readText())).toBe('https://share.example.test/chat-2')
    await expect(page.getByTestId('code-copy-toast')).toHaveText(/Read-only share link copied|只读分享链接已复制/)

    releaseFirstShare()
    await expect.poll(() => revokedTickets).toBe(2)
    await expect.poll(async () => page.evaluate(() => navigator.clipboard.readText())).toBe('https://share.example.test/chat-2')
    expect(capturedTargets.map(target => target.agentId)).toEqual([agentId, agentId])
    const decodedAnchors = await page.evaluate(encoded => encoded.map(value => (
      window.FarmingReadingAnchors?.decode(value) ?? null
    )), capturedTargets.map(target => target.readingAnchor || ''))
    expect(decodedAnchors.map(anchor => anchor?.surface === 'chat' ? anchor.locator.id : '')).toEqual(turnIds)
  })

  test('copies the current File Viewer position as a read-only link', async ({ page, workspaceRoot }) => {
    const workspace = path.join(workspaceRoot, 'file-context-share')
    fs.mkdirSync(workspace, { recursive: true })
    fs.writeFileSync(path.join(workspace, 'notes.txt'), Array.from({ length: 180 }, (_, index) => `line ${index + 1}`).join('\n'))
    await createAgent(page, workspace, 'terminal')
    let capturedTarget: {
      absolutePath?: string
      filePath?: string
      view?: string
      lineNumber?: number
      column?: number
    } | null = null
    let revoked = false

    await page.route('**/api/share/qr-ticket**', async route => {
      if (route.request().method() === 'DELETE') {
        revoked = true
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ revoked: true }) })
        return
      }
      capturedTarget = (route.request().postDataJSON() as { target?: typeof capturedTarget }).target || null
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 'DIRECTFILE1',
          expiresAt: Date.now() + 5 * 60 * 1000,
          ttlMs: 5 * 60 * 1000,
          shortPath: '/j/DIRECTFILE1',
          shortUrl: 'https://share.example.test/j/DIRECTFILE1',
          longUrl: 'https://share.example.test/file-position',
          shortUrlAccessMode: 'owner',
          longUrlAccessMode: 'read-only',
          tokenLabel: 'owner-token',
        }),
      })
    })

    await openFarming(page)
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(page.url()).origin })
    const project = page.getByTestId('code-project-group').filter({ hasText: path.basename(workspace) })
    await expect(project).toHaveCount(1, { timeout: 30_000 })
    const files = project.getByTestId('code-files-section')
    const filesTitle = files.locator('.code-files-title').first()
    if (await filesTitle.getAttribute('aria-expanded') !== 'true') await filesTitle.click()
    await files.locator('[data-testid="code-file-row"][data-file-path="notes.txt"]').click()
    await expect(page.getByTestId('code-file-editor')).toBeVisible()
    expect(await page.evaluate(() => window.__farmingFileEditorTest?.revealLine(120, 6) === true)).toBe(true)

    await page.getByTestId('code-file-editor-share').click()
    await expect.poll(async () => page.evaluate(() => navigator.clipboard.readText())).toBe('https://share.example.test/file-position')
    await expect(page.getByTestId('code-copy-toast')).toHaveText(/Read-only share link copied|只读分享链接已复制/)
    await expect.poll(() => revoked).toBe(true)
    expect(capturedTarget).not.toBeNull()
    expect(capturedTarget?.absolutePath).toBe(path.join(workspace, 'notes.txt'))
    expect(capturedTarget?.filePath).toBe('notes.txt')
    expect(capturedTarget?.view).toBe('editor')
    expect(capturedTarget?.lineNumber).toBe(120)
    expect(capturedTarget?.column).toBe(6)
  })

  test('refuses to present an unsafe share when authentication is disabled', async ({ page }) => {
    const pageErrors: string[] = []
    page.on('pageerror', error => pageErrors.push(error.message))

    await page.setViewportSize({ width: 1000, height: 900 })
    await openFarming(page)
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(page.url()).origin })
    const shareButton = page.getByTestId('code-share-button')
    await expect(shareButton).toBeVisible()
    const ticketResponsePromise = page.waitForResponse(response => (
      response.request().method() === 'POST' && response.url().includes('/api/share/qr-ticket')
    ))
    await shareButton.click()
    const ticketResponse = await ticketResponsePromise
    expect(ticketResponse.status()).toBe(409)
    const ticketError = await ticketResponse.json() as { error?: string }
    expect(ticketError.error).toContain('requires token authentication')

    const popover = page.getByTestId('code-share-popover')
    await expect(popover).toBeVisible()
    await expect(popover.getByRole('status')).toContainText('Read-only sharing requires token authentication.')
    await expect(popover.getByTestId('code-share-copy-status')).toHaveCount(0)
    const tokenDisplay = page.getByTestId('code-share-token-display')
    await expect(tokenDisplay).toHaveCount(0)
    await expect(page.getByTestId('code-share-copy-link')).toHaveCount(0)
    await expect(popover.locator('svg[aria-label="QR code"]')).toHaveCount(0)
    await expect(page.getByTestId('app-shell')).toBeVisible()
    await expect.poll(() => pageErrors).toEqual([])
    await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(255, 255, 255)')

    await shareButton.click()
    await expect(popover).toHaveCount(0)
  })
})
