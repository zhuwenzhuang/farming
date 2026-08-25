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
  let cachedHistoryResponses = 0
  let failCurrentRequests = false
  let blockCurrentCapabilityRefresh = false
  let blockCurrentHistoryRefresh = false
  let releaseCapabilityRefresh: (() => void) | null = null
  let releaseHistoryRefresh: (() => void) | null = null
  const capabilityRefreshBlocked = new Promise<void>(resolve => {
    releaseCapabilityRefresh = resolve
  })
  const historyRefreshBlocked = new Promise<void>(resolve => {
    releaseHistoryRefresh = resolve
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
    const current = new URL(route.request().url()).searchParams.get('force') === '1'
    if (current && blockCurrentHistoryRefresh) await historyRefreshBlocked
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
    if (!current) cachedHistoryResponses += 1
  })

  await openFarming(page)
  await expect.poll(() => browserCapabilityRequests).toBeGreaterThan(0)
  await expect.poll(() => computerCapabilityRequests).toBeGreaterThan(0)
  await expect.poll(() => cachedHistoryResponses).toBeGreaterThan(0)
  const browserRequestsBeforePlugins = browserCapabilityRequests
  const computerRequestsBeforePlugins = computerCapabilityRequests
  const extensionRequestsBeforePlugins = agentExtensionRequests

  await page.getByTestId('code-nav-plugins').click()
  await expect(page.getByTestId('code-plugin-browser')).not.toContainText('Checking')
  await expect(page.getByTestId('code-plugin-computer')).not.toContainText('Checking')
  await expect.poll(() => browserCapabilityRequests).toBeGreaterThan(browserRequestsBeforePlugins)
  await expect.poll(() => computerCapabilityRequests).toBeGreaterThan(computerRequestsBeforePlugins)
  await expect.poll(() => agentExtensionRequests).toBeGreaterThan(extensionRequestsBeforePlugins)

  await page.getByTestId('code-plugins-panel').getByRole('button', { name: 'Back', exact: true }).click()
  blockCurrentCapabilityRefresh = true
  const browserRequestsBeforeBlockedRefresh = browserCapabilityRequests
  const computerRequestsBeforeBlockedRefresh = computerCapabilityRequests
  await page.getByTestId('code-nav-plugins').click()
  await expect(page.getByTestId('code-plugin-browser')).not.toContainText('Checking')
  await expect(page.getByTestId('code-plugin-computer')).not.toContainText('Checking')
  await expect.poll(() => browserCapabilityRequests).toBeGreaterThan(browserRequestsBeforeBlockedRefresh)
  await expect.poll(() => computerCapabilityRequests).toBeGreaterThan(computerRequestsBeforeBlockedRefresh)
  releaseCapabilityRefresh?.()
  await page.getByTestId('code-plugins-panel').getByRole('button', { name: 'Back', exact: true }).click()
  blockCurrentHistoryRefresh = true
  await page.getByTestId('code-nav-history').click()
  const history = page.getByTestId('code-history-panel')
  await expect(history.getByTestId('code-history-loading')).toBeHidden()
  await expect(history).toContainText('Old provider session')
  releaseHistoryRefresh?.()
  await expect(history).toContainText('Current provider session')
  await expect(history).not.toContainText('Old provider session')

  await history.getByTestId('code-history-back').click()
  failCurrentRequests = true
  await page.getByTestId('code-nav-plugins').click()
  await expect(page.getByTestId('code-plugin-browser')).toContainText('Check failed')
  await expect(page.getByTestId('code-plugin-computer')).toContainText('Check failed')
  await page.getByTestId('code-plugins-panel').getByRole('button', { name: 'Back', exact: true }).click()
  await page.getByTestId('code-nav-history').click()
  await expect(page.getByTestId('code-history-refresh-error')).toContainText('Failed to load current information')
  await expect(page.getByTestId('code-history-panel')).toContainText('Current provider session')
})

test('CRT History, Search, and New Agent controls request current backend inventories', async ({ page }) => {
  let executableRequests = 0
  const historyRequests: URL[] = []
  const searchRequests: URL[] = []

  await page.route('**/api/executables', async route => {
    executableRequests += 1
    await route.continue()
  })
  await page.route('**/api/agent-sessions/search?**', async route => {
    searchRequests.push(new URL(route.request().url()))
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ sessions: [providerSession('crt-search', 'CRT current search result')] }),
    })
  })
  await page.route('**/api/agent-sessions?**', async route => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('fresh') !== '1') {
      await route.continue()
      return
    }
    historyRequests.push(url)
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ sessions: [providerSession('crt-history', 'CRT current history result')] }),
    })
  })

  await openFarming(page)
  await page.goto('/farming/crt/', { waitUntil: 'domcontentloaded' })

  await page.keyboard.press('h')
  await expect(page.locator('#history-area')).not.toHaveClass(/hidden/)
  await expect(page.locator('#history-list')).toContainText('CRT current history result')
  expect(historyRequests).toHaveLength(1)
  expect(historyRequests[0].searchParams.get('limit')).toBe('60')
  expect(historyRequests[0].searchParams.get('fresh')).toBe('1')

  await page.keyboard.press('Escape')
  await page.keyboard.press('f')
  const search = page.locator('#crt-search-input')
  await expect(search).toBeFocused()
  await search.fill('current')
  await expect(page.locator('#search-list')).toContainText('CRT current search result')
  expect(searchRequests).toHaveLength(1)
  expect(searchRequests[0].searchParams.get('q')).toBe('current')
  expect(searchRequests[0].searchParams.get('fresh')).toBe('1')

  await page.keyboard.press('Escape')
  const requestsBeforeDialog = executableRequests
  await page.keyboard.press('n')
  await expect(page.locator('#input-dialog')).toHaveClass(/active/)
  await expect.poll(() => executableRequests).toBeGreaterThan(requestsBeforeDialog)
})
