import fs from 'node:fs'
import path from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { expect, interceptWorkspaceRequests, openFarming, test } from './fixtures'

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

async function selectNewAgent(page: Page, workspace: string, runtime: 'chat' | 'terminal' = 'chat') {
  const response = await page.request.post('/farming/api/control/agents', {
    data: { command: 'codex', workspace, agentRuntimeMode: runtime },
  })
  expect(response.ok()).toBeTruthy()
  const { agentId } = await response.json() as { agentId: string }
  await openFarming(page)
  await page.getByTestId('code-mobile-menu').tap()
  await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).tap()
  await guardSettled(page, false)
  return agentId
}

async function guardSettled(page: Page, armed: boolean) {
  await expect.poll(() => page.evaluate(() => Boolean(history.state?.__farmingInteractionGuard))).toBe(armed)
}

async function capture(page: Page, name: string) {
  const png = await page.screenshot({ path: test.info().outputPath(`${name}.png`), animations: 'disabled' })
  const scale = await page.evaluate(() => devicePixelRatio)
  expect(png.readUInt32BE(16)).toBe(390 * scale)
  expect(png.readUInt32BE(20)).toBe(844 * scale)
}

async function touchTarget(control: Locator) {
  const box = await control.boundingBox()
  expect(box).not.toBeNull()
  // WebKit reports fractional viewport coordinates (e.g. 43.9999847 for
  // a 44px target). Ignore floating-point noise, not a smaller touch target.
  expect(box!.width).toBeGreaterThanOrEqual(44 - 0.001)
  expect(box!.height).toBeGreaterThanOrEqual(44 - 0.001)
}

for (const appearance of ['light', 'dark', 'paper'] as const) {
  test(`touch settings labels and transcript disclosures stay discoverable in ${appearance}`, async ({ page, workspaceRoot }) => {
    expect((await page.request.post('/farming/api/settings', { data: { appearance } })).ok()).toBeTruthy()
    await page.addInitScript(() => {
      Object.defineProperty(window, 'Notification', { configurable: true, value: { permission: 'denied' } })
    })
    const agentId = await selectNewAgent(page, workspaceRoot)
    try {
      await expect(page.locator('body')).toHaveAttribute('data-appearance', appearance)
      const input = page.getByTestId('code-acp-composer-input')
      await input.fill('rich timeline')
      await page.getByTestId('code-acp-composer-send').tap()
      await expect(page.getByText('Rich ACP timeline complete.', { exact: true })).toBeVisible()
      const summary = page.getByTestId('code-agent-transcript-process-summary').last()
      await summary.scrollIntoViewIfNeeded()
      const chevron = summary.locator('.code-agent-transcript-chevron')
      await expect(chevron).toHaveCSS('opacity', '0.9')
      await expect(summary).toHaveAttribute('aria-expanded', 'false')
      await summary.tap()
      await expect(summary).toHaveAttribute('aria-expanded', 'true')
      await expect(chevron).toHaveCSS('opacity', '0.9')
      await capture(page, `disclosures-${appearance}`)
      await summary.tap()

      await input.fill('preserved draft')
      const usage = page.getByTestId('code-acp-context-window')
      await touchTarget(usage)
      await usage.tap()
      await expect(usage).toHaveAttribute('aria-expanded', 'true')
      await expect(usage.getByRole('tooltip')).toContainText('tokens used')
      await expect(usage.getByRole('tooltip')).toHaveCSS('opacity', '1')
      await capture(page, `usage-${appearance}`)
      await usage.tap()
      await expect(usage.getByRole('tooltip')).toBeHidden()
      await guardSettled(page, false)
      await usage.tap()
      await page.goBack()
      await expect(usage).toHaveAttribute('aria-expanded', 'false')
      await expect(usage).toBeFocused()
      await usage.tap()
      await input.tap()
      await expect(usage).toHaveAttribute('aria-expanded', 'false')
      await expect(input).toHaveText('preserved draft')

      await page.getByTestId('code-mobile-menu').tap()
      await page.getByTestId('code-sidebar-options').tap()
      const settings = page.getByTestId('code-settings-panel')
      const sticky = settings.getByTestId('code-settings-sticky-turn-prompt')
      const toggle = sticky.getByRole('switch')
      await touchTarget(toggle)
      const checked = await toggle.getAttribute('aria-checked')
      await sticky.locator('label').tap()
      await expect(toggle).toHaveAttribute('aria-checked', checked === 'true' ? 'false' : 'true')
      await capture(page, `settings-${appearance}`)
      await toggle.tap()
      await expect(toggle).toHaveAttribute('aria-checked', checked!)
      const denied = settings.getByTestId('code-settings-agent-completion-notifications')
      await expect(denied.getByRole('switch')).toBeDisabled()
      // Playwright's locator actionability correctly treats a label for a
      // disabled control as disabled. Send a real touch to prove it is inert.
      await denied.locator('label').scrollIntoViewIfNeeded()
      const deniedLabel = (await denied.locator('label').boundingBox())!
      await page.touchscreen.tap(deniedLabel.x + deniedLabel.width / 2, deniedLabel.y + deniedLabel.height / 2)
      await expect(denied.getByRole('switch')).toHaveAttribute('aria-checked', 'false')
      await page.goBack()
      await expect(settings).toBeHidden()
      await expect(page.getByTestId('code-mobile-sidebar-backdrop')).toBeVisible()
      await guardSettled(page, true)
      await page.goBack()
      await expect(page.getByTestId('code-mobile-sidebar-backdrop')).toBeHidden()
      await guardSettled(page, false)
    } finally {
      await page.request.delete(`/farming/api/control/agents/${agentId}`)
    }
  })

  test(`dirty file Close stays visible beside its indicator in ${appearance}`, async ({ page, workspaceRoot }) => {
    expect((await page.request.post('/farming/api/settings', { data: { appearance } })).ok()).toBeTruthy()
    const filePath = path.join(workspaceRoot, 'touch.txt')
    fs.writeFileSync(filePath, 'original\n')
    const agentId = await selectNewAgent(page, workspaceRoot)
    try {
      await page.getByTestId('code-mobile-menu').tap()
      const files = page.getByTestId('code-project-group')
        .filter({ has: page.locator(`[data-agent-id="${agentId}"]`) }).getByTestId('code-files-section')
      const title = files.locator('.code-files-title')
      if (await title.getAttribute('aria-expanded') !== 'true') await title.tap()
      await files.locator('[data-file-path="touch.txt"]').tap()
      const source = page.getByTestId('code-file-touch-source').getByRole('textbox')
      await expect(source).toHaveValue('original\n')
      await expect(page.locator('body')).toHaveAttribute('data-appearance', appearance)
      const tab = page.locator('.code-file-editor-tab.active')
      const close = tab.getByRole('button', { name: /Close/ })
      const cleanBox = await tab.boundingBox()
      await source.fill('changed\n')
      await source.tap()
      await expect(tab).toHaveClass(/dirty/)
      await touchTarget(close)
      await expect(close).toHaveCSS('opacity', '1')
      const indicator = tab.locator('.code-file-editor-dirty')
      await expect(indicator).toHaveCSS('opacity', '1')
      const dotBox = (await indicator.boundingBox())!
      const closeBox = (await close.boundingBox())!
      expect(dotBox.x + dotBox.width).toBeLessThanOrEqual(closeBox.x)
      expect((await tab.boundingBox())!.width).toBe(cleanBox!.width)
      await capture(page, `dirty-tab-${appearance}`)
      fs.writeFileSync(filePath, 'external change\n')
      await expect(tab).toHaveClass(/warning/)
      await expect(close).toHaveCSS('opacity', '1')
      await expect(indicator).toHaveCSS('opacity', '1')
      await close.tap()
      const confirmation = page.getByTestId('code-file-save-confirm')
      await expect(confirmation).toBeVisible()
      await guardSettled(page, true)
      await page.goBack()
      await expect(confirmation).toBeHidden()
      await expect(source).toHaveValue('changed\n')
      await expect(close).toBeFocused()
      expect(fs.readFileSync(filePath, 'utf8')).toBe('external change\n')
      await close.tap()
      await confirmation.getByRole('button', { name: "Don't Save", exact: true }).tap()
      await expect(tab).toHaveCount(0)
      await guardSettled(page, false)
    } finally {
      await page.request.delete(`/farming/api/control/agents/${agentId}`)
    }
  })
}

test('Terminal uses the same context-details toggle, outside dismissal and Escape', async ({ page, workspaceRoot }) => {
  const response = await page.request.post('/farming/api/control/agents', {
    data: { command: 'codex', workspace: workspaceRoot, agentRuntimeMode: 'terminal' },
  })
  expect(response.ok()).toBeTruthy()
  const { agentId } = await response.json() as { agentId: string }
  // The shell fixture has no persisted provider conversation. Supply the
  // confirmed identity at the wire boundary, alongside the context read below;
  // this case tests inspection, not provider session discovery.
  await page.routeWebSocket(/\/farming\/ws(?:\?|$)/, socket => {
    const server = socket.connectToServer()
    const confirmSession = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(confirmSession)
      if (!value || typeof value !== 'object') return value
      const entry = value as Record<string, unknown>
      if (entry.id === agentId) return {
        ...entry, providerSessionTemporary: false, providerSessionId: 'context-usage-fixture',
      }
      return Object.fromEntries(Object.entries(entry).map(([key, child]) => [key, confirmSession(child)]))
    }
    server.onMessage(message => socket.send(JSON.stringify(confirmSession(JSON.parse(String(message))))))
  })
  await page.route('**/api/provider-context-windows', async route => {
    const { agentIds } = route.request().postDataJSON() as { agentIds: string[] }
    await route.fulfill({ json: { contextWindows: agentIds.map(agentId => ({
      agentId, available: true, provider: 'codex', sessionId: 'fixture',
      usedTokens: 53000, limitTokens: 200000, percentUsed: 27, percentLeft: 73,
      source: 'fixture', confidence: 'exact',
    })) } })
  })
  try {
    await openFarming(page)
    await page.getByTestId('code-mobile-menu').tap()
    await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).tap()
    const usage = page.getByTestId('code-composer-context-window')
    await expect(usage).toBeVisible()
    await usage.tap()
    await expect(usage.getByRole('tooltip')).toContainText('53k / 200k')
    await usage.tap()
    await expect(usage.getByRole('tooltip')).toBeHidden()
    await usage.tap()
    await page.keyboard.press('Escape')
    await expect(usage).toBeFocused()
    await expect(usage).toHaveAttribute('aria-expanded', 'false')
    await guardSettled(page, false)
    await usage.tap()
    await page.getByTestId('code-composer-input').tap()
    await expect(usage.getByRole('tooltip')).toBeHidden()
  } finally {
    await page.request.delete(`/farming/api/control/agents/${agentId}`)
  }
})

test('browser Back dismisses nested menus before dialogs, then resumes normal navigation', async ({ page }) => {
  await page.route('**/mobile-origin', route => route.fulfill({ contentType: 'text/html', body: '<h1>Previous page</h1>' }))
  await page.goto('/mobile-origin')
  await page.goto('/farming/review?fixture=1')
  await page.evaluate(() => history.replaceState({ preserved: 'navigation-owner' }, ''))
  const preferences = page.getByRole('button', { name: 'Diff preferences' })
  await preferences.tap()
  const dialog = page.getByRole('dialog', { name: 'Diff Preferences' })
  const context = dialog.getByRole('combobox', { name: 'Context', exact: true })
  await context.tap()
  await guardSettled(page, true)
  await page.goBack()
  await expect(context).toHaveAttribute('aria-expanded', 'false')
  await expect(context).toBeFocused()
  await expect(dialog).toBeVisible()
  await guardSettled(page, true)
  await page.goBack()
  await expect(dialog).toBeHidden()
  await expect(preferences).toBeFocused()
  await guardSettled(page, false)
  expect(await page.evaluate(() => history.state)).toEqual({ preserved: 'navigation-owner' })

  // An obsolete Forward guard cannot reopen a dismissed dialog.
  await page.goForward()
  await guardSettled(page, false)
  await expect(dialog).toBeHidden()
  await expect(page).toHaveURL(/\/farming\/review\?fixture=1$/)

  // Explicit close followed immediately by reopen must not be undone by the
  // asynchronous cleanup traversal from the previous dialog.
  await preferences.tap()
  await guardSettled(page, true)
  await dialog.getByRole('button', { name: 'CANCEL', exact: true }).tap()
  await preferences.tap()
  await expect(dialog).toBeVisible()
  await guardSettled(page, true)
  await page.goBack()
  await expect(dialog).toBeHidden()
  await guardSettled(page, false)
  await page.goBack()
  await expect(page).toHaveURL(/\/mobile-origin$/)
})

test('preview Back, explicit Close and reload never leave stale UI history', async ({ page, workspaceRoot }) => {
  await page.route('**/mobile-origin', route => route.fulfill({ contentType: 'text/html', body: '<h1>Previous page</h1>' }))
  await page.goto('/mobile-origin')
  const agentId = await selectNewAgent(page, workspaceRoot)
  try {
    await page.getByTestId('code-acp-composer-file-input').setInputFiles({
      name: 'preview.png', mimeType: 'image/png',
      buffer: fs.readFileSync(path.resolve('public/farming-2/app-icon-v2-180.png')),
    })
    await expect(page.getByTestId('code-composer-attachment')).toHaveClass(/ready/)
    const trigger = page.getByTestId('code-composer-attachment-preview')
    const viewer = page.getByTestId('composer-image-viewer')
    await trigger.tap()
    await guardSettled(page, true)
    await page.goBack()
    await expect(viewer).toBeHidden()
    await expect(trigger).toBeFocused()
    await trigger.tap()
    await viewer.getByRole('button', { name: 'Close preview' }).tap()
    await guardSettled(page, false)
    await trigger.tap()
    await guardSettled(page, true)
    await page.reload()
    await expect(viewer).toBeHidden()
    await guardSettled(page, false)
    await page.goBack()
    await expect(page).toHaveURL(/\/mobile-origin$/)
  } finally {
    await page.request.delete(`/farming/api/control/agents/${agentId}`)
  }
})

test('Back cancels expanded composer presentation without losing its draft', async ({ page, workspaceRoot }) => {
  const agentId = await selectNewAgent(page, workspaceRoot)
  try {
    const input = page.getByTestId('code-acp-composer-input')
    await input.fill('keep this draft')
    await page.getByTestId('code-composer-editor-toggle').tap()
    await expect(page.getByTestId('code-acp-composer')).toHaveClass(/editor-expanded/)
    await guardSettled(page, true)
    await page.goBack()
    await expect(page.getByTestId('code-acp-composer')).not.toHaveClass(/editor-expanded/)
    await expect(input).toHaveText('keep this draft')
    await guardSettled(page, false)
  } finally {
    await page.request.delete(`/farming/api/control/agents/${agentId}`)
  }
})

test('busy file save consumes Back without cancelling or replaying the write', async ({ page, workspaceRoot }) => {
  fs.writeFileSync(path.join(workspaceRoot, 'busy.txt'), 'before\n')
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let saves = 0
  await interceptWorkspaceRequests(page, async request => {
    if (request.operation === 'save-file') { saves++; await gate }
  })
  const agentId = await selectNewAgent(page, workspaceRoot)
  try {
    await page.getByTestId('code-mobile-menu').tap()
    const files = page.getByTestId('code-project-group')
      .filter({ has: page.locator(`[data-agent-id="${agentId}"]`) }).getByTestId('code-files-section')
    if (await files.locator('.code-files-title').getAttribute('aria-expanded') !== 'true') {
      await files.locator('.code-files-title').tap()
    }
    await files.locator('[data-file-path="busy.txt"]').tap()
    await page.getByTestId('code-file-touch-source').getByRole('textbox').fill('after\n')
    await page.locator('.code-file-editor-tab.active .code-file-editor-close').tap()
    const confirmation = page.getByTestId('code-file-save-confirm')
    await confirmation.getByRole('button', { name: 'Save', exact: true }).tap()
    await expect(confirmation.locator('button.primary')).toBeDisabled()
    await guardSettled(page, true)
    await page.goBack()
    await expect(confirmation).toBeVisible()
    await guardSettled(page, true)
    expect(saves).toBe(1)
    release()
    await expect(confirmation).toBeHidden()
    await guardSettled(page, false)
    expect(saves).toBe(1)
    expect(fs.readFileSync(path.join(workspaceRoot, 'busy.txt'), 'utf8')).toBe('after\n')
  } finally {
    release()
    await page.request.delete(`/farming/api/control/agents/${agentId}`)
  }
})
