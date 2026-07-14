import path from 'node:path'
import { expect, openFarming, openNewAgentDialog, startAgentFromOpenDialog, test } from './fixtures'

test('switches from Farming Code to the same Agent in Farming CRT', async ({ page, workspaceRoot }) => {
  await openFarming(page)
  await openNewAgentDialog(page)
  const agentId = await startAgentFromOpenDialog(page, 'bash', workspaceRoot)
  await page.getByTestId('code-sidebar-options').click()

  const settings = page.getByTestId('code-settings-panel')
  await expect(settings).toBeVisible()
  await expect(settings.getByTestId('code-settings-skin-code')).toHaveClass(/active/)
  await expect(settings.getByTestId('code-settings-skin-crt')).toBeVisible()

  await settings.getByTestId('code-settings-skin-crt').click()
  await expect(page).toHaveURL(new RegExp(`/farming/crt/\\?agent=${agentId}$`))
  await expect(page.locator('body')).toHaveAttribute('id', 'farming-crt')
  await expect(page.locator('#session-modal')).toHaveClass(/active/)

  await expect(page.getByRole('button', { name: 'Close session, Ctrl+Escape', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('#session-modal')).toHaveClass(/active/)
  await page.keyboard.press('Control+Escape')
  await expect(page.locator('#session-modal')).not.toHaveClass(/active/)
  await page.getByRole('button', { name: '[S] SETTINGS', exact: true }).click()
  await expect(page.getByText('Farming CRT', { exact: true })).toBeVisible()
  await expect(page.getByText('Terminal', { exact: true })).toHaveCount(0)
})

test('searches live Agents and provider sessions from CRT search', async ({ page, workspaceRoot }) => {
  const observedQueries: string[] = []
  const resumeRequests: string[] = []
  let liveAgentId = ''
  await page.route('**/api/agent-sessions/search?**', async route => {
    const query = new URL(route.request().url()).searchParams.get('q') || ''
    observedQueries.push(query)
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        sessions: [{
          provider: 'codex',
          providerName: 'Codex',
          providerHomeId: 'default',
          id: '019f-crt-search-archive',
          title: 'Retro archive session',
          workspace: '/tmp/retro-vault',
          updatedAt: '2026-07-14T00:00:00.000Z',
        }],
        total: 1,
        query,
      }),
    })
  })
  await page.route('**/api/agent-sessions/codex/019f-crt-search-archive/resume', async route => {
    resumeRequests.push(route.request().postData() || '')
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ agentId: liveAgentId }),
    })
  })

  await openFarming(page)
  await openNewAgentDialog(page)
  const agentId = await startAgentFromOpenDialog(page, 'bash', workspaceRoot)
  liveAgentId = agentId
  await page.getByTestId('code-sidebar-options').click()
  await page.getByTestId('code-settings-skin-crt').click()
  await expect(page).toHaveURL(new RegExp(`/farming/crt/\\?agent=${agentId}$`))
  await expect(page.locator('#session-modal')).toHaveClass(/active/)
  await page.keyboard.press('Control+Escape')
  await expect(page.locator('#session-modal')).not.toHaveClass(/active/)

  await expect(page.getByText('TASK LIST', { exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: '[F] SEARCH', exact: true }).click()
  const searchInput = page.getByRole('searchbox', { name: 'Search projects, Agents, and sessions' })
  await expect(searchInput).toBeFocused()
  await searchInput.fill(path.basename(workspaceRoot))
  const liveResult = page.locator('.search-row').filter({ hasText: 'LIVE RUNNING' })
  await expect(liveResult).toHaveCount(1)
  await searchInput.press('Enter')
  await expect(page.locator('#session-modal')).toHaveClass(/active/)

  await page.keyboard.press('Control+Escape')
  await page.keyboard.press('f')
  await expect(searchInput).toBeFocused()
  await searchInput.fill('Retro archive')
  const archiveResult = page.locator('.search-row').filter({ hasText: 'Retro archive session' })
  await expect(archiveResult).toBeVisible()
  await expect(archiveResult).toContainText(/RESUME/i)
  await expect.poll(() => observedQueries).toContain('Retro archive')

  await searchInput.press('Escape')
  await expect(page.locator('#search-area')).toHaveClass(/hidden/)
  await expect(page.locator('#map-area')).not.toHaveClass(/hidden/)

  await page.keyboard.press('f')
  await searchInput.fill('Retro archive')
  await expect(archiveResult).toBeVisible()
  await searchInput.press('Enter')
  await expect.poll(() => resumeRequests.length).toBe(1)
  await expect(page.locator('#session-modal')).toHaveClass(/active/)
})

test('renders CRT Billing daily history with a secondary live oscilloscope', async ({ page, workspaceRoot }) => {
  const now = Date.parse('2026-07-14T01:00:00.000Z')
  const bucketMs = 2 * 60 * 1000
  const points = Array.from({ length: 30 }, (_, index) => {
    const totalTokens = index % 7 === 0 ? 24_000 + index * 800 : index % 3 === 0 ? 4_000 + index * 120 : 0
    return {
      startedAt: now - 60 * 60 * 1000 + index * bucketMs,
      endedAt: now - 60 * 60 * 1000 + (index + 1) * bucketMs,
      totalTokens,
      tokensPerMinute: totalTokens / 2,
      providers: { codex: Math.round(totalTokens * 0.8), claude: Math.round(totalTokens * 0.2) },
    }
  })
  const totalTokens = points.reduce((sum, point) => sum + point.totalTokens, 0)
  const dailyCursor = new Date(now)
  dailyCursor.setHours(12, 0, 0, 0)
  dailyCursor.setDate(dailyCursor.getDate() - 52 * 7 + 1)
  const dailyPoints = Array.from({ length: 52 * 7 }, (_, index) => {
    const date = [dailyCursor.getFullYear(), String(dailyCursor.getMonth() + 1).padStart(2, '0'), String(dailyCursor.getDate()).padStart(2, '0')].join('-')
    const dayTotal = index === 52 * 7 - 1
      ? 10_000
      : index === 300
        ? 2_000_000_000
        : index % 9 === 0 ? 240_000 + index * 1_000 : 0
    dailyCursor.setDate(dailyCursor.getDate() + 1)
    return {
      date,
      totalTokens: dayTotal,
      inputTokens: Math.round(dayTotal * 0.35),
      outputTokens: Math.round(dayTotal * 0.15),
      cacheReadTokens: Math.round(dayTotal * 0.45),
      cacheWriteTokens: Math.round(dayTotal * 0.05),
      unattributedTokens: 0,
      providers: {
        codex: { totalTokens: Math.round(dayTotal * 0.8) },
        claude: { totalTokens: Math.round(dayTotal * 0.2) },
        opencode: { totalTokens: 0 },
      },
    }
  })
  const sumDays = (count: number) => dailyPoints.slice(-count).reduce((sum, point) => sum + point.totalTokens, 0)
  const peakDay = dailyPoints.reduce((peak, point) => point.totalTokens > peak.totalTokens ? point : peak, dailyPoints[0])
  const activeDays = dailyPoints.filter(point => point.totalTokens > 0).length
  const billionDays = dailyPoints.filter(point => point.totalTokens >= 1_000_000_000).length
  const chartPoints = dailyPoints.slice(-120)
  const xAxisLabelCount = chartPoints.filter((point, index) => {
    const day = Number(point.date.slice(-2))
    return index === 0 || index === chartPoints.length - 1 || day === 1 || day === 15
  }).length
  const freshRequests: string[] = []
  const dayDetailRequests: string[] = []
  await page.route(/\/api\/usage(?:\/day)?(?:\?|$)/, async route => {
    const requestUrl = new URL(route.request().url())
    if (requestUrl.pathname.endsWith('/api/usage/day')) {
      const date = requestUrl.searchParams.get('date') || ''
      dayDetailRequests.push(date)
      const point = dailyPoints.find(candidate => candidate.date === date) || dailyPoints.at(-1)!
      const hourlyWeights = new Map([[3, 0.08], [8, 0.17], [10, 0.25], [14, 0.12], [18, 0.28], [22, 0.10]])
      const hours = Array.from({ length: 24 }, (_, hour) => {
        const total = Math.round(point.totalTokens * (hourlyWeights.get(hour) || 0))
        return {
          hour,
          label: String(hour).padStart(2, '0'),
          totalTokens: total,
          inputTokens: Math.round(total * 0.35),
          outputTokens: Math.round(total * 0.15),
          cacheReadTokens: Math.round(total * 0.45),
          cacheWriteTokens: Math.round(total * 0.05),
          unattributedTokens: 0,
        }
      })
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          detail: {
            source: 'local provider token events',
            date: point.date,
            timeZone: 'Asia/Shanghai',
            total: {
              totalTokens: point.totalTokens,
              inputTokens: point.inputTokens,
              outputTokens: point.outputTokens,
              cacheReadTokens: point.cacheReadTokens,
              cacheWriteTokens: point.cacheWriteTokens,
              unattributedTokens: 0,
            },
            hours,
            providers: point.providers,
          },
        }),
      })
      return
    }
    if (requestUrl.searchParams.get('fresh') === '1') freshRequests.push(route.request().url())
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        usage: {
          sampledAt: now,
          windowMs: 5 * 60 * 1000,
          timeline: {
            source: 'local provider token events',
            sampledAt: now,
            startAt: now - 60 * 60 * 1000,
            endAt: now,
            windowMs: 60 * 60 * 1000,
            bucketMs,
            bucketCount: points.length,
            totalTokens,
            averageTokensPerMinute: totalTokens / 60,
            peakTokensPerMinute: Math.max(...points.map(point => point.tokensPerMinute)),
            activeBucketCount: points.filter(point => point.totalTokens > 0).length,
            points,
          },
          daily: {
            source: 'local provider token events',
            sampledAt: now,
            timeZone: 'Asia/Shanghai',
            days: dailyPoints.length,
            startDate: dailyPoints[0].date,
            endDate: dailyPoints.at(-1)?.date,
            partial: false,
            coverage: [
              { provider: 'codex', providerName: 'Codex', available: true, homeCount: 2 },
              { provider: 'claude', providerName: 'Claude', available: true, homeCount: 1 },
              { provider: 'opencode', providerName: 'OpenCode', available: true, homeCount: 1 },
              { provider: 'qoder', providerName: 'Qoder', available: false, homeCount: 1, reason: 'Qoder session files do not expose model token usage.' },
            ],
            summary: {
              todayTokens: sumDays(1),
              sevenDayTokens: sumDays(7),
              thirtyDayTokens: sumDays(30),
              periodTokens: sumDays(dailyPoints.length),
              peakDate: peakDay.date,
              peakTokens: peakDay.totalTokens,
            },
            points: dailyPoints,
          },
          providers: [
            {
              provider: 'codex',
              providerName: 'Codex',
              auth: { available: true, status: 'Logged in using ChatGPT', source: 'codex login status' },
              quota: {
                available: true,
                source: 'codex token_count events',
                primary: { usedPercent: 38, windowMinutes: 300, resetsAt: now + 90 * 60 * 1000 },
                secondary: { usedPercent: 71, windowMinutes: 10080, resetsAt: now + 3 * 24 * 60 * 60 * 1000 },
              },
              tokenUsage: { totalTokens: 46_000, tokensPerMinute: 9_200, windowMs: 300_000, eventCount: 4, sampledAt: now, source: 'codex cumulative token_count deltas' },
            },
            {
              provider: 'claude',
              providerName: 'Claude',
              auth: { available: true, status: 'logged in / oauth_token', source: 'claude auth status --json' },
              quota: { available: false, source: 'claude auth status', reason: 'Quota unavailable' },
              tokenUsage: { totalTokens: 7_000, tokensPerMinute: 1_400, windowMs: 300_000, eventCount: 2, sampledAt: now, source: 'claude local usage fields' },
            },
            {
              provider: 'opencode',
              providerName: 'OpenCode',
              auth: { available: true, status: 'Local session export', source: 'opencode session export' },
              quota: { available: false, source: 'opencode session export', reason: 'Quota unavailable' },
              tokenUsage: { available: true, totalTokens: 0, tokensPerMinute: 0, windowMs: 300_000, eventCount: 0, sampledAt: now, source: 'opencode session export' },
            },
            {
              provider: 'qoder',
              providerName: 'Qoder',
              auth: { available: true, status: 'Local sessions', source: 'Qoder session files' },
              quota: { available: false, source: 'Qoder session files', reason: 'Quota unavailable' },
              tokenUsage: { available: false, totalTokens: null, tokensPerMinute: null, windowMs: 300_000, eventCount: 0, sampledAt: now, source: 'Qoder session files', reason: 'Qoder session files do not expose model token usage.' },
            },
          ],
          agentUsage: null,
          systemStats: null,
        },
      }),
    })
  })

  await openFarming(page)
  await openNewAgentDialog(page)
  const agentId = await startAgentFromOpenDialog(page, 'bash', workspaceRoot)
  await page.getByTestId('code-sidebar-options').click()
  await page.getByTestId('code-settings-skin-crt').click()
  await expect(page).toHaveURL(new RegExp(`/farming/crt/\\?agent=${agentId}$`))
  await page.getByRole('button', { name: 'Close session, Ctrl+Escape', exact: true }).click()
  await expect(page.locator('#session-modal')).not.toHaveClass(/active/)

  await page.getByRole('button', { name: '[$] BILLING', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Billing', exact: true })).toBeVisible()
  await expect(page.locator('#billing-status')).toHaveText('HISTORY READY')
  await expect(page.locator('#billing-today-total')).toHaveText('10K')
  await expect(page.locator('#billing-active-days')).toHaveText(String(activeDays))
  await expect(page.locator('#billing-billion-days')).toHaveText(String(billionDays))
  await expect(page.locator('#billing-day-total')).toHaveText('10,000')
  await expect(page.locator('#billing-day-total-compact')).toHaveText('10K')
  await expect(page.locator('#billing-day-insight-state')).toHaveText('24 HOURLY BINS READY')
  await expect(page.locator('#billing-day-total-path')).toHaveAttribute('d', /^M.+L/)
  await expect(page.locator('#billing-day-cache-path')).toHaveAttribute('d', /^M.+L/)
  await expect(page.locator('#billing-day-curve-scale')).toHaveText('2.8K TOK/H PEAK')
  await expect(page.locator('#billing-day-provider-shares .billing-day-share-row')).toHaveCount(2)
  await expect(page.locator('#billing-day-provider-shares')).toContainText('CODEX')
  await expect(page.locator('#billing-day-provider-shares')).toContainText('80.0% · 8,000')
  await expect(page.locator('#billing-daily-range')).toContainText('3/4 SOURCES')
  await expect(page.locator('#billing-daily-bars .billing-daily-column')).toHaveCount(120)
  await expect(page.getByText('Y: TOKENS / DAY [LOG10]', { exact: true })).toBeVisible()
  await expect(page.getByText('X: LOCAL DATE', { exact: true })).toBeVisible()
  await expect(page.locator('#billing-y-axis .billing-y-axis-label')).toHaveCount(4)
  await expect(page.locator('#billing-daily-x-axis .has-label')).toHaveCount(xAxisLabelCount)
  await expect(page.locator('#billing-daily-bars .billing-daily-column.selected')).toHaveAttribute('data-date', dailyPoints.at(-1)!.date)
  await expect(page.locator('#billing-activity-strip .billing-activity-tick')).toHaveCount(52 * 7)
  await expect(page.locator(`.billing-daily-column[data-date="${dailyPoints[300].date}"]`)).toHaveAttribute('data-billion', 'true')
  await expect(page.locator(`.billing-daily-column[data-date="${dailyPoints[300].date}"] .billing-daily-cache`)).toBeVisible()
  await expect(page.locator(`.billing-daily-column[data-date="${dailyPoints[300].date}"] .billing-daily-direct`)).toBeVisible()
  await page.locator(`.billing-daily-column[data-date="${dailyPoints[300].date}"]`).click()
  await expect(page.locator('#billing-day-date')).toContainText(dailyPoints[300].date)
  await expect.poll(() => dayDetailRequests.at(-1)).toBe(dailyPoints[300].date)
  await expect(page.locator('#billing-day-total')).toHaveText('2,000,000,000')
  await expect(page.locator('#billing-day-total-compact')).toHaveText('2B')
  await expect(page.locator('#billing-day-insight-state')).toHaveText('24 HOURLY BINS READY')
  await expect(page.getByText('CODEX 5H', { exact: true })).toBeVisible()
  await expect(page.getByText('CODEX 1W', { exact: true })).toBeVisible()
  await expect(page.getByLabel('Provider channels').getByText('CLAUDE', { exact: true })).toBeVisible()
  await expect(page.getByLabel('Provider channels').getByText('OPENCODE', { exact: true })).toBeVisible()
  await expect(page.getByText('NO TOKEN DATA', { exact: true })).toBeVisible()
  await expect.poll(() => freshRequests.length).toBeGreaterThan(0)
  await page.keyboard.press('l')
  await expect(page.locator('#billing-status')).toHaveText('SIGNAL LOCKED')
  await expect(page.locator('#billing-live-view')).not.toHaveClass(/hidden/)
  await expect(page.locator('#billing-current-rate')).toHaveText('11K')
  await expect.poll(async () => page.locator('#billing-scope').evaluate((node) => {
    const canvas = node as HTMLCanvasElement
    const context = canvas.getContext('2d')
    if (!context || canvas.width <= 0 || canvas.height <= 0) return 0
    return context.getImageData(0, 0, canvas.width, canvas.height).data.some(value => value !== 0) ? 1 : 0
  })).toBe(1)

  await page.keyboard.press('Escape')
  await expect(page.locator('#billing-area')).toHaveClass(/hidden/)
  await page.keyboard.press('Shift+4')
  await expect(page.locator('#billing-area')).not.toHaveClass(/hidden/)
})
