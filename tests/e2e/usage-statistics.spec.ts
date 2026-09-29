import { expect, openFarming, openNewAgentDialog, startAgentFromOpenDialog, test } from './fixtures'

function fixture() {
  const sampledAt = Date.now()
  const date = new Date(sampledAt)
  const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  const breakdown = (totalTokens: number) => ({ totalTokens, inputTokens: totalTokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, unattributedTokens: 0 })
  const days = Array.from({ length: 364 }, (_, index) => {
    const cursor = new Date(sampledAt)
    cursor.setDate(cursor.getDate() - 363 + index)
    const date = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(cursor.getDate()).padStart(2, '0')}`
    const tokens = index === 363 ? 100 : index % 5 * 1500
    return { date, ...breakdown(tokens), providers: { codex: breakdown(tokens) } }
  })
  const points = Array.from({ length: 24 }, (_, index) => ({ startedAt: sampledAt - (24 - index) * 3600000,
    endedAt: sampledAt - (23 - index) * 3600000, totalTokens: index === 23 ? 100 : 0,
    tokensPerMinute: index === 23 ? 100 / 60 : 0, providers: { codex: index === 23 ? 100 : 0 } }))
  return {
    day,
    usage: {
      sampledAt, windowMs: 300000, agentUsage: null, systemStats: null,
      timeline: { source: 'fixture', sampledAt, startAt: points[0]!.startedAt, endAt: sampledAt, windowMs: 86400000,
        bucketMs: 3600000, bucketCount: 24, totalTokens: 100, averageTokensPerMinute: 100 / 1440,
        peakTokensPerMinute: 100 / 60, activeBucketCount: 1, points },
      daily: { source: 'fixture', sampledAt, timeZone: 'Asia/Shanghai', days: days.length, startDate: days[0]!.date, endDate: day,
        summary: { todayTokens: 100, sevenDayTokens: days.slice(-7).reduce((sum, day) => sum + day.totalTokens, 0),
          thirtyDayTokens: days.slice(-30).reduce((sum, day) => sum + day.totalTokens, 0),
          periodTokens: days.reduce((sum, day) => sum + day.totalTokens, 0), peakDate: days[4]!.date, peakTokens: 6000 },
        points: days },
      providers: [{ provider: 'codex', providerName: 'Codex', auth: { available: true, status: '2/2 Homes logged in', source: 'fixture' },
        quota: { available: true, source: 'Agent Home account quota', accounts: [
          { available: true, source: 'account/rateLimits/read', homeId: 'default', homeLabel: 'default', sampledAt,
            primary: { usedPercent: 49, windowMinutes: 10080, resetsAt: sampledAt + 86400000 } },
          { available: false, source: 'account/rateLimits/read', homeId: 'alternate', homeLabel: 'alternate', reason: 'Account quota read timed out.', sampledAt },
        ] }, tokenUsage: { available: true, totalTokens: 100, tokensPerMinute: 20, windowMs: 300000, eventCount: 1, sampledAt, source: 'fixture' } },
      { provider: 'claude', providerName: 'Claude Code', auth: { available: true, status: 'Logged in', source: 'fixture' },
        quota: { available: true, source: 'fixture', primary: { usedPercent: null, windowMinutes: 10080, resetsAt: null } },
        tokenUsage: { available: false, totalTokens: null, tokensPerMinute: null, reason: 'History scan failed', source: 'fixture' } }],
    },
    detail: (tokens: number) => ({ date: day, timeZone: 'Asia/Shanghai', available: true, sampledAt, total: breakdown(tokens),
      agents: [{ key: 'codex:demo', provider: 'codex', sessionId: 'demo', label: 'Demo Agent', ...breakdown(tokens) }],
      hours: Array.from({ length: 24 }, (_, hour) => ({ hour, label: String(hour).padStart(2, '0'), ...breakdown(hour === 10 ? tokens : 0),
        agents: hour === 10 ? { 'codex:demo': breakdown(tokens) } : {} })),
    }),
  }
}

for (const appearance of ['light', 'dark', 'paper'] as const) {
  test(`account quotas, unavailable values and live day detail remain truthful (${appearance})`, async ({ page }, testInfo) => {
    const data = fixture()
    let dayReads = 0
    let fail = false
    await page.route(/\/api\/usage(?:\?|$)/, route => route.fulfill({ json: { usage: data.usage } }))
    await page.route(/\/api\/usage\/day(?:\?|$)/, route => {
      dayReads += 1
      return route.fulfill(fail ? { status: 503, json: { error: 'History temporarily unavailable' } }
        : { json: { detail: data.detail(dayReads > 1 ? 200 : 100) } })
    })
    await openFarming(page)
    await page.emulateMedia({ colorScheme: appearance === 'dark' ? 'dark' : 'light', reducedMotion: 'reduce' })
    await page.evaluate(value => { document.documentElement.dataset.appearance = value; document.body.dataset.appearance = value }, appearance)
    const toggle = page.getByTestId('code-usage-toggle')
    if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click()
    const panel = page.getByTestId('code-usage-panel')
    await expect(panel).toContainText('51% left')
    await expect(panel).toContainText('alternate · Quota')
    await expect(panel).toContainText('Unavailable')
    await expect(panel).not.toContainText('100% left')
    await expect(panel).not.toContainText('8% left')
    await expect(panel.getByText('Total local tokens', { exact: true })).toHaveCount(0)
    await panel.screenshot({ path: testInfo.outputPath(`usage-${appearance}.png`) })
    await page.getByTestId('code-usage-open-year').click()
    const dialog = page.getByTestId('code-usage-detail-dialog')
    const readout = page.getByTestId('code-usage-day-histogram-readout')
    await expect(readout).toContainText('100 tokens')
    await expect(dialog).toContainText('Day boundary: Asia/Shanghai')
    await dialog.screenshot({ path: testInfo.outputPath(`usage-day-${appearance}.png`) })
    await page.setViewportSize({ width: 1100, height: 680 })
    await expect.poll(() => dialog.evaluate(element => {
      const bounds = element.getBoundingClientRect()
      return bounds.top >= 0 && bounds.bottom <= innerHeight && element.scrollWidth <= element.clientWidth
    })).toBe(true)
    await dialog.screenshot({ path: testInfo.outputPath(`usage-day-compact-${appearance}.png`) })
    await page.setViewportSize({ width: 1440, height: 900 })
    if (appearance === 'light') {
      await expect(readout).toContainText('200 tokens', { timeout: 20000 })
      fail = true
      await expect(page.getByTestId('code-usage-day-histogram-error')).toContainText('History temporarily unavailable', { timeout: 20000 })
      fail = false
      await dialog.getByRole('button', { name: 'Retry', exact: true }).click()
      await expect(readout).toContainText('200 tokens')
    }
    await page.getByRole('button', { name: 'Close usage activity', exact: true }).click()
    await expect(dialog).toHaveCount(0)
  })
}

test('CRT reads the same account quotas and does not convert missing percentages to 100', async ({ page, workspaceRoot }, testInfo) => {
  const data = fixture()
  await page.route(/\/api\/usage(?:\?|$)/, route => route.fulfill({ json: { usage: data.usage } }))
  await page.route(/\/api\/usage\/day(?:\?|$)/, route => route.fulfill({ json: { detail: data.detail(100) } }))
  await openFarming(page)
  await openNewAgentDialog(page)
  await startAgentFromOpenDialog(page, 'bash', workspaceRoot)
  await page.goto('/farming/crt/', { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: '[$] BILLING', exact: true }).click()
  const quotas = page.locator('#billing-quota-list')
  await expect(quotas.getByRole('meter')).toHaveCount(1)
  await expect(quotas.getByRole('meter')).toHaveAttribute('aria-valuenow', '51')
  await expect(quotas).toContainText('alternate: QUOTA UNAVAILABLE')
  await quotas.screenshot({ path: testInfo.outputPath('crt-account-quota.png') })
})

test('summary transport failure is visible and a new read recovers', async ({ page }) => {
  await page.route(/\/api\/usage(?:\?|$)/, route => route.fulfill({ status: 503, json: { error: 'Unavailable' } }))
  await openFarming(page)
  await expect(page.getByTestId('code-usage-panel')).toContainText('Usage unavailable')
  const data = fixture()
  await page.route(/\/api\/usage(?:\?|$)/, route => route.fulfill({ json: { usage: data.usage } }))
  await page.reload()
  const toggle = page.getByTestId('code-usage-toggle')
  if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click()
  await expect(page.getByTestId('code-usage-panel')).toContainText('51%')
  await expect(page.getByTestId('code-usage-panel')).not.toContainText('Usage unavailable')
})
