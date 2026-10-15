import { expect, openFarming, test } from './fixtures'

for (const appearance of ['light', 'dark', 'paper'] as const) {
  test(`audit fixes preserve Settings and Search interactions in ${appearance}`, async ({ page }, testInfo) => {
    await openFarming(page)
    await page.getByTestId('code-nav-search').click()
    const search = page.getByTestId('code-search-box').locator('input')
    await search.fill('audit-query')
    await page.getByTestId('code-sidebar-options').click()
    const settings = page.getByTestId('code-settings-panel')
    await expect(settings).toBeVisible()
    await expect(settings.getByTestId('code-settings-follow-up-behavior').getByRole('button', { name: 'Queue', exact: true })).toBeEnabled()
    await expect(settings.locator('.code-settings-status').filter({ hasText: 'Loading…' })).toHaveCount(0)
    const themeChoice = settings.locator(`[data-theme-choice="${appearance}"]`)
    await themeChoice.click()
    await expect(themeChoice).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('body')).toHaveAttribute('data-appearance', appearance)
    const row = settings.locator('.code-settings-choice-row').first()
    await expect(row).toBeVisible()
    expect(await row.evaluate(element => {
      const probe = document.createElement('span')
      probe.style.color = 'var(--code-diff-removed)'
      element.append(probe)
      const danger = getComputedStyle(probe).color
      probe.remove()
      return getComputedStyle(element).color === danger
    })).toBe(false)
    await settings.screenshot({ path: testInfo.outputPath(`settings-${appearance}.png`) })
    await page.keyboard.press('Escape')
    await expect(settings).toBeHidden()
    await expect(search).toBeVisible()
    await expect(search).toHaveValue('audit-query')
    await page.getByTestId('code-nav-history').click()
    const history = page.getByTestId('code-history-search-box').locator('input')
    await history.focus()
    await history.dispatchEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true, cancelable: true })
    await expect(history).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(history).toBeHidden()
    await page.getByTestId('code-nav-plugins').click()
    const tabs = page.locator('.code-plugin-tabs')
    await expect(page.getByTestId('code-plugin-tab-homes').locator('small')).toHaveText(/^\d+$/, { timeout: 45_000 })
    const selected = tabs.locator('[aria-selected="true"]')
    const inactive = tabs.locator('[aria-selected="false"]').first()
    await inactive.hover()
    await expect(inactive).toHaveCSS('background-color', await selected.evaluate(element => getComputedStyle(element).backgroundColor))
    await tabs.screenshot({ path: testInfo.outputPath(`plugin-tabs-${appearance}.png`) })
  })
}

test('a stale Settings read cannot roll back a saved follow-up choice', async ({ page }) => {
  await openFarming(page)
  await page.getByTestId('code-sidebar-options').click()
  const settings = page.getByTestId('code-settings-panel')
  const row = settings.getByTestId('code-settings-follow-up-behavior')
  await expect(row).toBeVisible()
  await row.getByRole('button', { name: 'Queue', exact: true }).click()
  await expect.poll(async () => (await (await page.request.get('/farming/api/settings')).json()).settings.composerFollowUpBehavior).toBe('queue')
  await settings.getByRole('button', { name: 'Close', exact: true }).click()
  let release!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  let captured = false
  await page.route('**/farming/api/settings', async route => {
    if (route.request().method() !== 'GET') return route.continue()
    const response = await route.fetch()
    captured = true
    await barrier
    await route.fulfill({ response })
  })
  try {
    await page.getByTestId('code-sidebar-options').click()
    await expect.poll(() => captured).toBe(true)
    const steer = row.getByRole('button', { name: 'Steer', exact: true })
    await steer.click()
    await expect.poll(async () => (await (await page.request.get('/farming/api/settings')).json()).settings.composerFollowUpBehavior).toBe('steer')
    release()
    await page.unrouteAll({ behavior: 'wait' })
    await expect(steer).toHaveAttribute('aria-pressed', 'true')
  } finally {
    release()
  }
})

test('New Agent waits for its own creation result despite unrelated socket errors', async ({ page, workspaceRoot }) => {
  let sendError: (() => void) | undefined
  await page.routeWebSocket(/\/farming\/ws(?:\?|$)/, socket => {
    socket.connectToServer()
    sendError = () => socket.send(JSON.stringify({ type: 'error', message: 'unrelated background operation failed' }))
  })
  await openFarming(page)
  let release!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  let accepted = false
  await page.route('**/farming/api/control/agents', async route => {
    if (route.request().method() !== 'POST') return route.continue()
    const response = await route.fetch()
    accepted = true
    await barrier
    await route.fulfill({ response })
  })
  try {
    await page.getByTestId('code-new-agent').click()
    const dialog = page.getByTestId('input-dialog')
    await dialog.getByTestId('agent-option-bash').click()
    await dialog.getByTestId('workspace-input').fill(workspaceRoot)
    const start = dialog.getByTestId('workspace-start')
    await start.click()
    await expect.poll(() => accepted).toBe(true)
    await expect(start).toBeDisabled()
    await expect(start).toHaveText('Starting…')
    sendError?.()
    await expect(dialog).toBeVisible()
    await expect(start).toBeDisabled()
    release()
    await expect(dialog).toBeHidden()
  } finally { release() }
})
