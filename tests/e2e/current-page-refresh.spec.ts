import { expect, openFarming, test } from './fixtures'

function providerSession(id: string, title: string) {
  return {
    provider: 'codex',
    providerName: 'Codex',
    providerHomeId: 'default',
    id,
    title,
    workspace: '/tmp/current-page-refresh',
    updatedAt: '2026-07-30T12:00:00.000Z',
    createdAt: '2026-07-30T11:00:00.000Z',
    archived: false,
    pinned: false,
    unread: false,
    projectless: false,
    model: 'gpt-5.5',
    effort: 'high',
    source: 'codex',
  }
}

test('entry pages preserve cached capabilities and History while refreshing current backend results', async ({ page }) => {
  let browserCapabilityRequests = 0
  let computerCapabilityRequests = 0
  let agentExtensionRequests = 0
  let failCurrentRequests = false
  let blockCurrentCapabilityRefresh = false
  let releaseCapabilityRefresh: (() => void) | null = null
  const capabilityRefreshBlocked = new Promise<void>(resolve => {
    releaseCapabilityRefresh = resolve
  })

  await page.route('**/api/browsers/capability', async route => {
    browserCapabilityRequests += 1
    if (blockCurrentCapabilityRefresh) await capabilityRefreshBlocked
    if (failCurrentRequests) {
      await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"probe failed"}' })
      return
    }
    await route.continue()
  })
  await page.route('**/api/computers/capability', async route => {
    computerCapabilityRequests += 1
    if (blockCurrentCapabilityRefresh) await capabilityRefreshBlocked
    if (failCurrentRequests) {
      await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"probe failed"}' })
      return
    }
    await route.continue()
  })
  await page.route('**/api/agent-extensions', async route => {
    agentExtensionRequests += 1
    await route.continue()
  })
  await page.route('**/api/agent-sessions?**', async route => {
    const current = new URL(route.request().url()).searchParams.get('fresh') === '1'
    if (current) await new Promise(resolve => setTimeout(resolve, 300))
    if (current && failCurrentRequests) {
      await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"scan failed"}' })
      return
    }
    const sessions = current
      ? [providerSession('current-session', 'Current provider session')]
      : [providerSession('old-session', 'Old provider session')]
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ sessions, nextCursor: '', hasMore: false, total: sessions.length }),
    })
  })

  await openFarming(page)
  await expect.poll(() => browserCapabilityRequests).toBeGreaterThan(0)
  await expect.poll(() => computerCapabilityRequests).toBeGreaterThan(0)
  const browserRequestsBeforePlugins = browserCapabilityRequests
  const computerRequestsBeforePlugins = computerCapabilityRequests
  const extensionRequestsBeforePlugins = agentExtensionRequests

  await page.getByTestId('code-nav-plugins').click()
  await expect(page.getByTestId('code-plugin-browser')).not.toContainText('Checking')
  await expect(page.getByTestId('code-plugin-computer')).not.toContainText('Checking')
  await expect.poll(() => browserCapabilityRequests).toBeGreaterThan(browserRequestsBeforePlugins)
  await expect.poll(() => computerCapabilityRequests).toBeGreaterThan(computerRequestsBeforePlugins)
  await expect.poll(() => agentExtensionRequests).toBeGreaterThan(extensionRequestsBeforePlugins)

  await page.getByTestId('code-plugins-panel').getByRole('button', { name: 'Back to workspace' }).click()
  blockCurrentCapabilityRefresh = true
  const browserRequestsBeforeBlockedRefresh = browserCapabilityRequests
  const computerRequestsBeforeBlockedRefresh = computerCapabilityRequests
  await page.getByTestId('code-nav-plugins').click()
  await expect(page.getByTestId('code-plugin-browser')).not.toContainText('Checking')
  await expect(page.getByTestId('code-plugin-computer')).not.toContainText('Checking')
  await expect.poll(() => browserCapabilityRequests).toBeGreaterThan(browserRequestsBeforeBlockedRefresh)
  await expect.poll(() => computerCapabilityRequests).toBeGreaterThan(computerRequestsBeforeBlockedRefresh)
  releaseCapabilityRefresh?.()
  await page.getByTestId('code-plugins-panel').getByRole('button', { name: 'Back to workspace' }).click()
  await page.getByTestId('code-nav-history').click()
  const history = page.getByTestId('code-history-panel')
  await expect(history.getByTestId('code-history-loading')).toBeHidden()
  await expect(history).toContainText('Old provider session')
  await expect(history).toContainText('Current provider session')
  await expect(history).not.toContainText('Old provider session')

  await history.getByTestId('code-history-back').click()
  failCurrentRequests = true
  await page.getByTestId('code-nav-plugins').click()
  await expect(page.getByTestId('code-plugin-browser')).toContainText('Check failed')
  await expect(page.getByTestId('code-plugin-computer')).toContainText('Check failed')
  await page.getByTestId('code-plugins-panel').getByRole('button', { name: 'Back to workspace' }).click()
  await page.getByTestId('code-nav-history').click()
  await expect(page.getByTestId('code-history-refresh-error')).toContainText('Failed to load current information')
  await expect(page.getByTestId('code-history-panel')).toContainText('Current provider session')
})
