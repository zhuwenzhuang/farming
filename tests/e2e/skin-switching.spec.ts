import path from 'node:path'
import type { Page } from '@playwright/test'
import { expect, openFarming, openNewAgentDialog, startAgentFromOpenDialog, test } from './fixtures'

async function createControlAgent(page: Page, command: string, workspace: string, agentRuntimeMode: 'terminal' | 'acp' = 'terminal') {
  const response = await page.request.post('/farming/api/control/agents', {
    data: { command, workspace, agentRuntimeMode },
  })
  expect(response.ok()).toBeTruthy()
  const payload = await response.json() as { agentId?: string }
  expect(payload.agentId).toBeTruthy()
  return payload.agentId as string
}

test('shows the quota reset countdown in the collapsed Code Usage summary', async ({ page }) => {
  await page.route(/\/api\/usage(?:\?|$)/, async route => {
    const sampledAt = Date.now()
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        usage: {
          sampledAt,
          windowMs: 5 * 60 * 1000,
          providers: [{
            provider: 'codex',
            providerName: 'Codex',
            auth: { available: true, status: 'Logged in using ChatGPT', source: 'codex login status' },
            quota: {
              available: true,
              source: 'codex token_count events',
              primary: null,
              secondary: {
                usedPercent: 76,
                windowMinutes: 7 * 24 * 60,
                resetsAt: sampledAt + ((2 * 24 + 3) * 60 + 10) * 60_000,
              },
            },
            tokenUsage: {
              available: true,
              totalTokens: 46_000,
              tokensPerMinute: 120,
              windowMs: 5 * 60 * 1000,
              eventCount: 4,
              sampledAt,
              source: 'codex cumulative token_count deltas',
            },
          }],
          agentUsage: null,
          systemStats: null,
        },
      }),
    })
  })

  await openFarming(page)

  await expect(page.getByTestId('code-usage-summary')).toHaveText('Codex · Weekly 24% · reset 2d 3h')
})

test('keeps Code Usage to real token sources and renders a compact activity heatmap', async ({ page }) => {
  const sampledAt = Date.now()
  const bucketMs = 60 * 60 * 1000
  const timelineEndAt = Math.ceil(sampledAt / bucketMs) * bucketMs
  const points = Array.from({ length: 24 }, (_, index) => {
    const totalTokens = index === 18 ? 1_500_000_000 : index % 6 === 0 ? 2_000 : 0
    return {
      startedAt: timelineEndAt - (24 - index) * bucketMs,
      endedAt: timelineEndAt - (23 - index) * bucketMs,
      totalTokens,
      tokensPerMinute: totalTokens / 60,
      providers: { codex: totalTokens },
    }
  })
  const dailyCursor = new Date(sampledAt)
  dailyCursor.setHours(12, 0, 0, 0)
  dailyCursor.setDate(dailyCursor.getDate() - 52 * 7 + 1)
  const dailyPoints = Array.from({ length: 52 * 7 }, (_, index) => {
    const date = [
      dailyCursor.getFullYear(),
      String(dailyCursor.getMonth() + 1).padStart(2, '0'),
      String(dailyCursor.getDate()).padStart(2, '0'),
    ].join('-')
    const totalTokens = index === 0
      ? 2_000_000_000
      : index === 1
        ? 1_200_000_000
      : index >= 52 * 7 - 7
        ? 250_000_000
        : index >= 52 * 7 - 14
          ? 100_000_000
          : 0
    const cacheReadTokens = index >= 52 * 7 - 7 ? 50_000_000 : 0
    const cacheWriteTokens = index >= 52 * 7 - 7 ? 25_000_000 : 0
    dailyCursor.setDate(dailyCursor.getDate() + 1)
    return {
      date,
      totalTokens,
      inputTokens: Math.max(0, totalTokens - cacheReadTokens - cacheWriteTokens),
      outputTokens: 0,
      cacheReadTokens,
      cacheWriteTokens,
      unattributedTokens: 0,
      providers: {
        codex: {
          totalTokens,
          inputTokens: Math.max(0, totalTokens - cacheReadTokens - cacheWriteTokens),
          outputTokens: 0,
          cacheReadTokens,
          cacheWriteTokens,
          unattributedTokens: 0,
        },
      },
    }
  })
  const peakDailyPoint = dailyPoints.reduce((peak, point) => (
    point.totalTokens > peak.totalTokens ? point : peak
  ), dailyPoints[0]!)

  await page.route(/\/api\/usage\/day(?:\?|$)/, async route => {
    const date = new URL(route.request().url()).searchParams.get('date') || ''
    const totalTokens = dailyPoints.find(point => point.date === date)?.totalTokens ?? 0
    const firstAgentTokens = Math.round(totalTokens * 0.6)
    const secondAgentTokens = totalTokens - firstAgentTokens
    const emptyBreakdown = () => ({
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      unattributedTokens: 0,
    })
    const firstAgent = {
      key: 'codex:agent-alpha',
      provider: 'codex',
      sessionId: 'agent-alpha',
      label: 'Agent Alpha',
      ...emptyBreakdown(),
      totalTokens: firstAgentTokens,
      inputTokens: firstAgentTokens,
    }
    const secondAgent = {
      key: 'claude:agent-beta',
      provider: 'claude',
      sessionId: 'agent-beta',
      label: 'Agent Beta',
      ...emptyBreakdown(),
      totalTokens: secondAgentTokens,
      inputTokens: secondAgentTokens,
    }
    const agents = totalTokens > 0 ? [firstAgent, secondAgent] : []
    const hours = Array.from({ length: 24 }, (_, hour) => ({
      hour,
      label: String(hour).padStart(2, '0'),
      ...emptyBreakdown(),
      ...(hour === 10 ? { totalTokens, inputTokens: totalTokens } : {}),
      agents: hour === 10 && totalTokens > 0
        ? {
            [firstAgent.key]: { ...emptyBreakdown(), totalTokens: firstAgentTokens, inputTokens: firstAgentTokens },
            [secondAgent.key]: { ...emptyBreakdown(), totalTokens: secondAgentTokens, inputTokens: secondAgentTokens },
          }
        : {},
    }))
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        detail: {
          source: 'local provider token events',
          date,
          timeZone: 'Asia/Shanghai',
          total: { ...emptyBreakdown(), totalTokens, inputTokens: totalTokens },
          hours,
          providers: {
            codex: { ...emptyBreakdown(), totalTokens: firstAgentTokens, inputTokens: firstAgentTokens },
            claude: { ...emptyBreakdown(), totalTokens: secondAgentTokens, inputTokens: secondAgentTokens },
          },
          agents,
        },
      }),
    })
  })

  await page.route(/\/api\/usage(?:\?|$)/, async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        usage: {
          sampledAt,
          windowMs: 5 * 60 * 1000,
          timeline: {
            source: 'local provider token events',
            sampledAt,
            startAt: timelineEndAt - 24 * 60 * 60 * 1000,
            endAt: timelineEndAt,
            windowMs: 24 * 60 * 60 * 1000,
            bucketMs,
            bucketCount: points.length,
            totalTokens: points.reduce((sum, point) => sum + point.totalTokens, 0),
            averageTokensPerMinute: 1_042_000,
            peakTokensPerMinute: 25_000_000,
            activeBucketCount: points.filter(point => point.totalTokens > 0).length,
            points,
          },
          daily: {
            source: 'local provider token events',
            sampledAt,
            timeZone: 'Asia/Shanghai',
            days: dailyPoints.length,
            startDate: dailyPoints[0]!.date,
            endDate: dailyPoints.at(-1)!.date,
            summary: {
              todayTokens: dailyPoints.at(-1)!.totalTokens,
              sevenDayTokens: 0,
              thirtyDayTokens: 0,
              periodTokens: dailyPoints.reduce((sum, point) => sum + point.totalTokens, 0),
              peakDate: peakDailyPoint.date,
              peakTokens: peakDailyPoint.totalTokens,
            },
            points: dailyPoints,
          },
          providers: [
            {
              provider: 'codex',
              providerName: 'Codex',
              auth: { available: true, status: 'Logged in using ChatGPT', source: 'codex login status' },
              quota: { available: false, source: 'codex token_count events', reason: 'No recent quota event.' },
              tokenUsage: { available: true, totalTokens: 11_000, tokensPerMinute: 2_200, windowMs: 300_000, eventCount: 2, sampledAt, source: 'codex token_count events' },
            },
            {
              provider: 'claude',
              providerName: 'Claude',
              auth: { available: false, status: 'Command not found', source: 'claude auth status --json' },
              quota: { available: false, source: 'claude auth status', reason: 'Quota unavailable' },
              tokenUsage: { available: true, totalTokens: 0, tokensPerMinute: 0, windowMs: 300_000, eventCount: 0, sampledAt, source: 'local Claude usage fields' },
            },
            {
              provider: 'opencode',
              providerName: 'OpenCode',
              auth: { available: false, status: 'Command not found', source: 'opencode session export' },
              quota: { available: false, source: 'opencode session export', reason: 'Quota unavailable' },
              tokenUsage: { available: false, totalTokens: 0, tokensPerMinute: 0, windowMs: 300_000, eventCount: 0, sampledAt, source: 'opencode session export', reason: 'Command not found' },
            },
            {
              provider: 'qoder',
              providerName: 'Qoder',
              auth: { available: true, status: 'Local sessions', source: 'Qoder session files' },
              quota: { available: false, source: 'Qoder session files', reason: 'Quota unavailable' },
              tokenUsage: { available: false, totalTokens: null, tokensPerMinute: null, windowMs: 300_000, eventCount: 0, sampledAt, source: 'Qoder session files', reason: 'Qoder session files do not expose model token usage.' },
            },
          ],
          agentUsage: null,
          systemStats: null,
        },
      }),
    })
  })

  await openFarming(page)
  await page.getByTestId('code-usage-toggle').click()

  const panel = page.getByTestId('code-usage-panel')
  await expect(page.getByTestId('code-usage-summary')).toHaveText('5m rate · activity')
  await expect(panel.getByText('Codex', { exact: true })).toBeVisible()
  await expect(panel.getByText('Claude', { exact: true })).toHaveCount(0)
  await expect(panel.getByText('OpenCode', { exact: true })).toHaveCount(0)
  await expect(panel.getByText('Qoder', { exact: true })).toHaveCount(0)
  await expect(panel.getByText('unavailable', { exact: true })).toHaveCount(0)
  await expect(panel.getByText('Total local tokens', { exact: true })).toHaveCount(0)

  const heatmap = panel.getByTestId('code-usage-heatmap')
  await expect(heatmap).toBeVisible()
  await expect(panel.getByText('1d · activity', { exact: true })).toBeVisible()
  await expect(panel.getByText('1h buckets', { exact: true })).toBeVisible()
  await expect(heatmap.locator('.code-usage-heatmap-cell')).toHaveCount(24)
  await expect(heatmap.locator(".code-usage-heatmap-cell[data-level='5']")).toHaveCount(1)
  await expect(panel.getByTestId('code-usage-time-axis').locator('span')).toHaveCount(5)
  await expect(panel.getByTestId('code-usage-time-axis').locator('span')).toHaveText([
    /^\d{2}:00$/,
    /^\d{2}:00$/,
    /^\d{2}:00$/,
    /^\d{2}:00$/,
    /^\d{2}:00$/,
  ])
  await expect(panel.getByTestId('code-usage-activity-readout')).toHaveText('1d 1.5B · 7d 1.8B · 52w 5.7B')
  await expect.poll(() => panel.getByTestId('code-usage-activity-readout').evaluate(element => getComputedStyle(element).fontSize)).toBe('13px')

  const peakHourCell = heatmap.locator(`[data-start="${points[18]!.startedAt}"]`)
  await expect(peakHourCell).toHaveAttribute('title', /1,500,000,000 tokens/)
  await peakHourCell.hover()
  await expect(panel.getByTestId('code-usage-activity-readout')).toContainText('1,500,000,000 tokens')

  const dailyHeatmap = panel.getByTestId('code-usage-daily-heatmap')
  await expect(dailyHeatmap).toBeVisible()
  await expect(dailyHeatmap.locator('.code-usage-daily-heatmap-cell')).toHaveCount(52 * 7)
  await expect(dailyHeatmap.locator(".code-usage-daily-heatmap-cell[data-recent='true']")).toHaveCount(7)
  const peakDayCell = dailyHeatmap.locator(`[data-date="${peakDailyPoint.date}"]`)
  await expect(peakDayCell).toHaveAttribute('title', `${peakDailyPoint.date} · 2,000,000,000 tokens · Token king`)
  await expect(peakDayCell).toHaveAttribute('data-peak', 'true')
  await peakDayCell.hover()
  await expect(panel.getByTestId('code-usage-activity-readout')).toHaveText(`${peakDailyPoint.date} · 2,000,000,000 tokens`)

  await panel.getByTestId('code-usage-open-day').click()
  const detail = page.getByTestId('code-usage-detail-dialog')
  await expect(detail).toBeVisible()
  await expect(detail.getByTestId('code-usage-detail-day-tab')).toHaveAttribute('aria-selected', 'true')
  await expect(detail.getByText('24-hour tokens', { exact: true })).toBeVisible()
  await expect(detail.getByText('Peak hour', { exact: true })).toBeVisible()
  await expect.poll(() => detail.getByTestId('code-usage-heatmap').locator('.code-usage-heatmap-cell').first().evaluate(element => getComputedStyle(element).height)).toBe('28px')

  await detail.getByTestId('code-usage-detail-year-tab').click()
  await expect(detail.getByTestId('code-usage-detail-year-tab')).toHaveAttribute('aria-selected', 'true')
  const dayHighlight = detail.getByTestId('code-usage-detail-day-highlight')
  await expect(dayHighlight).toHaveAttribute('data-state', 'today')
  await expect(dayHighlight).not.toContainText('Top')
  await expect(dayHighlight).toContainText('250M')
  const detailDailyHeatmap = detail.getByTestId('code-usage-daily-heatmap')
  const crownDayCell = detailDailyHeatmap.locator(`[data-date="${peakDailyPoint.date}"]`)
  const flameDayCell = detailDailyHeatmap.locator(`[data-date="${dailyPoints[1]!.date}"]`)
  await expect(crownDayCell).toHaveAttribute('data-shape', 'crown')
  await expect(flameDayCell).toHaveAttribute('data-shape', 'flame')
  await expect(crownDayCell.locator('[data-marker]')).toHaveCount(0)
  await expect(flameDayCell.locator('[data-marker]')).toHaveCount(0)
  const [crownMask, flameMask] = await Promise.all([crownDayCell, flameDayCell].map(locator => (
    locator.evaluate(element => {
      const style = getComputedStyle(element)
      return style.maskImage || style.getPropertyValue('-webkit-mask-image')
    })
  )))
  expect(crownMask).not.toBe('none')
  expect(flameMask).not.toBe('none')
  expect(crownMask).not.toBe(flameMask)
  const hourlyHistogram = detail.getByTestId('code-usage-day-histogram')
  await expect(hourlyHistogram).toBeVisible()
  await expect(hourlyHistogram.getByText('Hourly by Agent type', { exact: true })).toBeVisible()
  await expect(detail.getByTestId('code-usage-day-histogram-readout')).toContainText('250M tokens')
  await expect(hourlyHistogram.locator('.code-usage-day-histogram-column')).toHaveCount(24)
  await expect(hourlyHistogram.locator('[data-hour="10"] .code-usage-day-histogram-segment')).toHaveCount(2)
  await expect(detail.getByTestId('code-usage-day-agent-legend')).toContainText('Codex')
  await expect(detail.getByTestId('code-usage-day-agent-legend')).toContainText('Claude Code')
  await expect(detail.getByTestId('code-usage-day-agent-legend')).not.toContainText('Agent Alpha')
  await expect(detail.getByTestId('code-usage-day-agent-legend')).not.toContainText('Agent Beta')
  const selectedDailyPoint = dailyPoints.at(-1)!
  const selectedDayCell = detailDailyHeatmap.locator(`[data-date="${selectedDailyPoint.date}"]`)
  await selectedDayCell.hover()
  await expect(selectedDayCell).toHaveAttribute('data-selected', 'true')
  await expect(dayHighlight).toHaveAttribute('data-state', 'selected')
  await expect(dayHighlight).toContainText('250M')
  await expect(dayHighlight).toContainText('tokens')
  await expect(detail.getByTestId('code-usage-detail-readout')).toHaveText(
    `${selectedDailyPoint.date} · 250,000,000 tokens`,
  )
  await expect(detail.getByTestId('code-usage-day-histogram-readout')).toContainText('250M tokens')
  await hourlyHistogram.locator('[data-hour="10"] .code-usage-day-histogram-segment').first().hover()
  await expect(detail.getByTestId('code-usage-day-histogram-readout')).toContainText('Codex')
  await expect(detail.getByText('Last 7 days', { exact: true })).toBeVisible()
  await expect(detail.getByText('Previous 7 days', { exact: true })).toBeVisible()
  await expect(detail.getByText('7-day cache share', { exact: true })).toBeVisible()
  await expect(detail.getByText('30%', { exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(detail).toHaveCount(0)

  await panel.getByTestId('code-usage-open-year').click()
  await expect(page.getByTestId('code-usage-detail-year-tab')).toHaveAttribute('aria-selected', 'true')
  await page.getByRole('button', { name: 'Close usage activity' }).click()
  await expect(page.getByTestId('code-usage-detail-dialog')).toHaveCount(0)
})

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

test('keeps the CRT dashboard actionable when only the Main Agent is running', async ({ page, workspaceRoot }) => {
  await openFarming(page)
  await expect.poll(async () => {
    const response = await page.request.get('/farming/api/control/agents')
    const payload = await response.json() as { mainAgentId?: string }
    return payload.mainAgentId || ''
  }, { timeout: 30_000 }).not.toBe('')

  await page.goto('/farming/crt/', { waitUntil: 'networkidle' })

  const mapArea = page.locator('#map-area')
  const emptyState = page.locator('#empty-state')
  const emptyStartAgent = emptyState.getByRole('button', { name: '[N] New Agent', exact: true })
  await expect(mapArea).toHaveClass(/empty/)
  await expect(emptyState).toBeVisible()
  await expect(emptyStartAgent).toBeVisible()
  await expect(page.locator('#main-agent-panel')).toBeVisible()

  await emptyStartAgent.click()
  await expect(page.locator('#input-dialog')).toHaveClass(/active/)
  await expect(page.locator('#dialog-title')).toHaveText('Start New Agent')
  await page.keyboard.press('Escape')
  await expect(page.locator('#input-dialog')).not.toHaveClass(/active/)

  await page.keyboard.press('ArrowDown')
  await expect(emptyStartAgent).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.locator('#input-dialog')).toHaveClass(/active/)
  await page.keyboard.press('Escape')

  const agentId = await createControlAgent(page, 'bash', workspaceRoot)
  const agentCard = page.locator(`#map-area .agent-block[data-agent-id="${agentId}"]`)
  await expect(agentCard).toBeVisible({ timeout: 30_000 })
  await expect(emptyState).toBeHidden()
  await expect(mapArea).not.toHaveClass(/empty/)

  const killResponse = await page.request.delete(`/farming/api/control/agents/${agentId}`)
  expect(killResponse.ok()).toBeTruthy()
  await expect(agentCard).toHaveCount(0)
  await expect(emptyState).toBeVisible()
  await expect(emptyStartAgent).toBeVisible()
  await expect(page.locator('#main-agent-panel')).toBeVisible()
})

test('focuses the Main Agent terminal after leaving a structured Agent', async ({ page, workspaceRoot }) => {
  await openFarming(page)
  let mainAgentId = ''
  await expect.poll(async () => {
    const response = await page.request.get('/farming/api/control/agents')
    const payload = await response.json() as { mainAgentId?: string }
    mainAgentId = payload.mainAgentId || ''
    return mainAgentId
  }, { timeout: 30_000 }).not.toBe('')
  const chatAgentId = await createControlAgent(page, 'codex', workspaceRoot, 'acp')

  await page.goto('/farming/crt/', { waitUntil: 'networkidle' })
  const chatAgentCard = page.locator(`#map-area .agent-block[data-agent-id="${chatAgentId}"]`)
  await expect(chatAgentCard).toBeVisible({ timeout: 30_000 })
  await chatAgentCard.click()
  await expect(page.locator('#crt-structured-input')).toBeFocused({ timeout: 30_000 })
  await page.getByRole('button', { name: 'Close session, Escape', exact: true }).click()

  const mainAgentCard = page.locator(`#main-agent-block[data-agent-id="${mainAgentId}"]`)
  await mainAgentCard.click()
  await expect(page.locator('#session-modal')).toHaveClass(/active/)
  await expect.poll(() => page.evaluate(() => {
    const terminalState = (window as Window & {
      __farmingCrtTerminalTest?: { getState: () => {
        checkpointInFlight: boolean
        checkpointInstallInProgress: boolean
        initialFocusPending: boolean
        replaying: boolean
      } | null }
    }).__farmingCrtTerminalTest?.getState()
    return Boolean(
      terminalState
      && !terminalState.checkpointInFlight
      && !terminalState.checkpointInstallInProgress
      && !terminalState.initialFocusPending
      && !terminalState.replaying,
    )
  }), { timeout: 30_000 }).toBe(true)
  await expect(page.locator('#terminal-output .xterm-helper-textarea')).toBeFocused({ timeout: 30_000 })
})

test('keeps every session command reachable through a Terminal to MSG keyboard flow', async ({ page, workspaceRoot }) => {
  test.setTimeout(90_000)
  await openFarming(page)
  await expect.poll(async () => {
    const response = await page.request.get('/farming/api/control/agents')
    const payload = await response.json() as { mainAgentId?: string }
    return payload.mainAgentId || ''
  }, { timeout: 30_000 }).not.toBe('')
  const initialChatAgentId = await createControlAgent(page, 'codex', workspaceRoot, 'acp')
  const fallbackAgentId = await createControlAgent(page, 'bash', workspaceRoot)

  await page.goto('/farming/crt/', { waitUntil: 'networkidle' })
  await expect(page.locator('body')).toHaveAttribute('id', 'farming-crt')
  const initialChatCard = page.locator(`#map-area .agent-block[data-agent-id="${initialChatAgentId}"]`)
  await expect(initialChatCard).toBeVisible({ timeout: 30_000 })

  // From this point onward the scenario uses only keyboard input.
  await page.keyboard.press('1')
  await expect(page.locator('#session-modal')).toHaveClass(/active/)
  await expect(page.locator('#crt-structured-input')).toBeFocused()

  const terminalSwitchResponsePromise = page.waitForResponse(response => (
    response.request().method() === 'PATCH'
    && response.url().includes(`/api/agents/${initialChatAgentId}`)
  ))
  await page.keyboard.press('Alt+M')
  const terminalSwitchResponse = await terminalSwitchResponsePromise
  const terminalSwitchPayload = await terminalSwitchResponse.json() as { error?: string, restartedAgentId?: string }
  expect(terminalSwitchResponse.ok(), terminalSwitchPayload.error || 'Terminal runtime switch request failed').toBeTruthy()
  const terminalAgentId = terminalSwitchPayload.restartedAgentId || initialChatAgentId
  await expect(page.getByRole('button', { name: 'Close session, Ctrl+Escape', exact: true })).toBeVisible({ timeout: 30_000 })

  const switchResponsePromise = page.waitForResponse(response => (
    response.request().method() === 'PATCH'
    && response.url().includes(`/api/agents/${terminalAgentId}`)
  ))
  await page.keyboard.press('Alt+M')
  const switchResponse = await switchResponsePromise
  const switchPayload = await switchResponse.json() as { error?: string, restartedAgentId?: string }
  expect(switchResponse.ok(), switchPayload.error || 'Runtime switch request failed').toBeTruthy()
  const chatAgentId = switchPayload.restartedAgentId || terminalAgentId
  const chatInput = page.locator('#crt-structured-input')
  await expect(chatInput).toBeVisible({ timeout: 30_000 })
  await expect(chatInput).toBeFocused()
  await expect(page.getByRole('button', { name: 'Close session, Escape', exact: true })).toBeVisible()

  await page.keyboard.press('ArrowDown')
  await expect(page.locator('#crt-structured-attach')).toBeFocused()
  await page.keyboard.press('ArrowLeft')
  await expect(page.locator('#crt-structured-config')).toBeFocused()
  await page.keyboard.press('ArrowDown')
  const configItems = page.locator('#crt-structured-composer-menu .crt-structured-menu-item')
  await expect(configItems.first()).toBeFocused()
  await page.keyboard.press('ArrowDown')
  const selectedConfigLabel = await configItems.nth(1).innerText()
  await page.evaluate(() => {
    const rerender = (window as typeof window & { renderStructuredSessionControls?: () => void })
      .renderStructuredSessionControls
    if (!rerender) throw new Error('CRT structured controls renderer is unavailable')
    rerender()
  })
  await expect(page.locator('#crt-structured-composer-menu .crt-structured-menu-item:focus')).toContainText(selectedConfigLabel)
  await page.keyboard.press('ArrowDown')
  await expect(page.locator('#crt-structured-composer-menu .crt-structured-menu-item:focus')).not.toContainText(selectedConfigLabel)
  await page.keyboard.press('Escape')
  await expect(page.locator('#crt-structured-config')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(chatInput).toBeFocused()

  await page.keyboard.press('Escape')
  await expect(page.locator('#session-modal')).not.toHaveClass(/active/)
  const chatCard = page.locator(`#map-area .agent-block[data-agent-id="${chatAgentId}"]`)
  await expect(chatCard).toBeFocused()

  await page.keyboard.press('Enter')
  await expect(chatInput).toBeFocused()
  await page.keyboard.press('Control+Escape')
  await expect(page.locator('#session-modal')).not.toHaveClass(/active/)
  await expect(chatCard).toBeFocused()

  await page.keyboard.press('Enter')
  await expect(chatInput).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(page.locator('.crt-structured-tool:focus')).toHaveCount(1)
  await page.keyboard.press('Escape')
  await expect(page.locator('#session-modal')).toHaveClass(/active/)
  await expect(chatInput).toBeFocused()

  await page.keyboard.press('Control+K')
  await expect(page.locator('#session-modal')).not.toHaveClass(/active/)
  await expect(chatCard).toHaveCount(0, { timeout: 30_000 })
  const fallbackCard = page.locator(`#map-area .agent-block[data-agent-id="${fallbackAgentId}"]`)
  await expect(fallbackCard).toBeFocused()

  await page.keyboard.press('Enter')
  await expect(page.locator('#session-modal')).toHaveClass(/active/)
  await page.keyboard.press('Escape')
  await expect(page.locator('#session-modal')).toHaveClass(/active/)
  await page.keyboard.press('Control+Escape')
  await expect(page.locator('#session-modal')).not.toHaveClass(/active/)
  await expect(fallbackCard).toBeFocused()
})

test('round-trips every CRT top-level surface with keyboard-only navigation', async ({ page, workspaceRoot }) => {
  await openFarming(page)
  await expect.poll(async () => {
    const response = await page.request.get('/farming/api/control/agents')
    const payload = await response.json() as { mainAgentId?: string }
    return payload.mainAgentId || ''
  }, { timeout: 30_000 }).not.toBe('')
  const agentId = await createControlAgent(page, 'bash', workspaceRoot)

  await page.goto('/farming/crt/', { waitUntil: 'networkidle' })
  const agentCard = page.locator(`#map-area .agent-block[data-agent-id="${agentId}"]`)
  await expect(agentCard).toBeVisible({ timeout: 30_000 })

  await page.keyboard.press('n')
  await expect(page.locator('#input-dialog')).toHaveClass(/active/)
  await page.keyboard.press('3')
  await expect(page.locator('#workspace-input')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.locator('#workspace-input-container')).toBeHidden()
  await page.keyboard.press('Escape')
  await expect(page.locator('#input-dialog')).not.toHaveClass(/active/)

  await page.keyboard.press('s')
  await expect(page.locator('#settings-modal')).toHaveClass(/active/)
  await page.keyboard.press('Escape')
  await expect(page.locator('#settings-modal')).not.toHaveClass(/active/)

  await page.keyboard.press('f')
  const searchInput = page.locator('#crt-search-input')
  await expect(searchInput).toBeFocused()
  await page.keyboard.type('bash')
  await page.keyboard.press('Escape')
  await expect(page.locator('#search-area')).toHaveClass(/hidden/)

  await page.keyboard.press('h')
  await expect(page.locator('#history-area')).not.toHaveClass(/hidden/)
  await page.keyboard.press('Escape')
  await expect(page.locator('#history-area')).toHaveClass(/hidden/)

  await page.keyboard.press('Shift+4')
  await expect(page.locator('#billing-area')).not.toHaveClass(/hidden/)
  await page.keyboard.press('l')
  await expect(page.locator('#billing-live-view')).not.toHaveClass(/hidden/)
  await page.keyboard.press('d')
  await expect(page.locator('#billing-days-view')).not.toHaveClass(/hidden/)
  await page.keyboard.press('Escape')
  await expect(page.locator('#billing-area')).toHaveClass(/hidden/)

  await page.keyboard.press('1')
  await expect(page.locator('#session-modal')).toHaveClass(/active/)
  await page.keyboard.press('Escape')
  await expect(page.locator('#session-modal')).toHaveClass(/active/)
  await page.keyboard.press('Control+Escape')
  await expect(page.locator('#session-modal')).not.toHaveClass(/active/)
  await expect(agentCard).toBeFocused()
})

test('previews structured Chat on CRT cards and removes killed Agents from the live grid', async ({ page, workspaceRoot }) => {
  test.setTimeout(90_000)
  await openFarming(page)
  await openNewAgentDialog(page)
  await startAgentFromOpenDialog(page, 'bash', workspaceRoot)

  const chatAgentId = await createControlAgent(page, 'codex', workspaceRoot, 'acp')
  const chatRow = page.locator(`[data-testid="code-agent-row"][data-agent-id="${chatAgentId}"]`)
  await expect(chatRow).toBeVisible({ timeout: 30_000 })
  await chatRow.click()
  await expect(page.getByTestId('code-acp-composer')).toBeVisible()
  await page.getByTestId('code-acp-composer-input').fill('rich timeline')
  await page.getByTestId('code-acp-composer-send').click()
  await expect(page.getByText('Rich ACP timeline complete.', { exact: true })).toBeVisible({ timeout: 20_000 })

  await page.getByTestId('code-sidebar-options').click()
  await page.getByTestId('code-settings-skin-crt').click()
  await expect(page.locator('body')).toHaveAttribute('id', 'farming-crt')
  await expect(page.locator('#session-modal')).toHaveClass(/active/)
  await page.keyboard.press('Control+Escape')
  await expect(page.locator('#session-modal')).not.toHaveClass(/active/)

  const chatCard = page.locator(`#map-area .agent-block[data-agent-id="${chatAgentId}"]`)
  const chatPreview = chatCard.locator('.agent-chat-preview')
  await expect(chatCard).toBeVisible()
  await expect(chatPreview).toHaveAttribute('data-preview-kind', 'chat')
  await expect(chatPreview.locator('[data-preview-role="user"]')).toContainText('rich timeline')
  await expect(chatPreview.locator('[data-preview-role="assistant"]')).toContainText('Rich ACP timeline complete.')
  const previewLayout = await chatPreview.evaluate((element) => {
    const trail = element.querySelector<HTMLElement>('.agent-chat-preview-trail')
    const text = element.querySelector<HTMLElement>('.agent-chat-preview-text')
    const trailStyle = trail ? getComputedStyle(trail) : null
    const textStyle = text ? getComputedStyle(text) : null
    return {
      overflow: trailStyle?.overflowY || '',
      lineClamp: textStyle?.webkitLineClamp || '',
    }
  })
  expect(previewLayout.overflow).toBe('hidden')
  expect(['', 'none']).toContain(previewLayout.lineClamp)
  await expect(chatCard.getByText('No output yet...', { exact: true })).toHaveCount(0)

  const killedAgentId = await createControlAgent(page, 'bash', workspaceRoot)
  const killedCard = page.locator(`#map-area .agent-block[data-agent-id="${killedAgentId}"]`)
  await expect(killedCard).toBeVisible({ timeout: 30_000 })
  const killResponse = await page.request.delete(`/farming/api/control/agents/${killedAgentId}`)
  expect(killResponse.ok()).toBeTruthy()
  await expect.poll(async () => {
    const response = await page.request.get('/farming/api/control/agents')
    const body = await response.json() as { agents?: Array<{ id?: string; status?: string }> }
    return body.agents?.some(agent => agent.id === killedAgentId) === true
  }, { timeout: 20_000 }).toBe(false)
  await expect(killedCard).toHaveCount(0)
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
    const overrangeTotals = new Map([
      [297, 1_200_000_000],
      [298, 4_800_000_000],
      [299, 8_200_000_000],
      [300, 2_000_000_000],
    ])
    const dayTotal = index === 52 * 7 - 1
      ? 10_000
      : overrangeTotals.get(index) ?? (index % 9 === 0 ? 240_000 + index * 1_000 : 0)
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
  const calendarStartDate = new Date(`${dailyPoints[0].date}T12:00:00`)
  const calendarLeadingDays = (calendarStartDate.getDay() + 6) % 7
  const calendarWeekCount = Math.ceil((calendarLeadingDays + dailyPoints.length) / 7)
  const freshRequests: string[] = []
  const dayDetailRequests: string[] = []
  let currentDayLiveRequests = 0
  let allowCurrentDayIncrease = false
  let omitCurrentDayHourlyBinsOnce = false
  let historicalTransientFailures = 0
  await page.route(/\/api\/usage(?:\/day)?(?:\?|$)/, async route => {
    const requestUrl = new URL(route.request().url())
    if (requestUrl.pathname.endsWith('/api/usage/day')) {
      const date = requestUrl.searchParams.get('date') || ''
      dayDetailRequests.push(date)
      const point = dailyPoints.find(candidate => candidate.date === date) || dailyPoints.at(-1)!
      const isCurrentDayLive = requestUrl.searchParams.get('live') === '1' && date === dailyPoints.at(-1)?.date
      if (isCurrentDayLive) currentDayLiveRequests += 1
      if (date === dailyPoints[300].date && historicalTransientFailures === 0) {
        historicalTransientFailures += 1
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Transient history read failure' }),
        })
        return
      }
      const detailTotal = isCurrentDayLive && allowCurrentDayIncrease ? 16_000 : point.totalTokens
      const omitHourlyBins = isCurrentDayLive && omitCurrentDayHourlyBinsOnce
      if (omitHourlyBins) {
        omitCurrentDayHourlyBinsOnce = false
        await new Promise(resolve => setTimeout(resolve, 1_200))
      }
      const hourlyWeights = new Map([[3, 0.08], [8, 0.17], [10, 0.25], [14, 0.12], [18, 0.28], [22, 0.10]])
      const hours = Array.from({ length: 24 }, (_, hour) => {
        const total = Math.round(detailTotal * (hourlyWeights.get(hour) || 0))
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
      const responseHours = omitHourlyBins ? [] : hours
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          detail: {
            source: 'local provider token events',
            date: point.date,
            timeZone: 'Asia/Shanghai',
            total: {
              totalTokens: detailTotal,
              inputTokens: Math.round(detailTotal * 0.35),
              outputTokens: Math.round(detailTotal * 0.15),
              cacheReadTokens: Math.round(detailTotal * 0.45),
              cacheWriteTokens: Math.round(detailTotal * 0.05),
              unattributedTokens: 0,
            },
            hours: responseHours,
            providers: {
              codex: { totalTokens: Math.round(detailTotal * 0.8) },
              claude: { totalTokens: Math.round(detailTotal * 0.2) },
              opencode: { totalTokens: 0 },
            },
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
  await expect(page.getByText('RELATIVE', { exact: true })).toBeVisible()
  const heatLegendColors = await page.locator('.billing-heat-scale i').evaluateAll(cells => (
    cells.map(cell => getComputedStyle(cell).backgroundColor)
  ))
  expect(new Set(heatLegendColors).size).toBe(6)
  await expect(page.locator('#billing-day-total')).toHaveText('10,000')
  await expect(page.locator('#billing-day-total-compact')).toHaveText('10K')
  await expect(page.locator('#billing-day-total-meter')).toHaveClass(/is-live/)
  await expect(page.locator('#billing-day-state')).toContainText('LIVE 5S')
  const totalLayout = await page.locator('#billing-day-total-meter').evaluate((meter) => {
    const exact = meter.querySelector<HTMLElement>('#billing-day-total')!.getBoundingClientRect()
    const compact = meter.querySelector<HTMLElement>('#billing-day-total-compact')!.getBoundingClientRect()
    return {
      exactRight: exact.right,
      compactLeft: compact.left,
      compactFontSize: Number.parseFloat(getComputedStyle(meter.querySelector<HTMLElement>('#billing-day-total-compact')!).fontSize),
    }
  })
  expect(totalLayout.compactLeft).toBeGreaterThan(totalLayout.exactRight)
  expect(totalLayout.compactFontSize).toBeGreaterThanOrEqual(20)
  await expect(page.locator('#billing-day-insight-state')).toHaveText('24 HOURLY BINS READY')
  await expect(page.locator('#billing-day-total-path')).toHaveAttribute('d', /^M.+L/)
  await expect(page.locator('#billing-day-cache-path')).toHaveAttribute('d', /^M.+L/)
  await expect(page.locator('#billing-day-curve-scale')).toHaveText('2.8K TOK/H PEAK')
  await expect(page.locator('#billing-day-hour-strip .billing-day-hour-cell')).toHaveCount(24)
  await expect(page.locator('#billing-day-hour-strip .billing-day-hour-cell.selected')).toHaveAttribute('data-hour', '18')
  await expect(page.locator('#billing-day-hour-readout')).toHaveText('[18:00—19:00]  TOTAL 2.8K  //  CACHE 1.4K  //  50.0% CACHE')
  await expect(page.locator('#billing-day-hour-readout')).toHaveAttribute('title', '18:00—19:00 · 2,800 total tokens · 1,400 cache tokens')
  await expect(page.locator('.billing-day-hour-axis span')).toHaveCount(9)
  await expect(page.getByText('24:00', { exact: true })).toBeVisible()
  const hourTen = page.locator('#billing-day-hour-strip .billing-day-hour-cell[data-hour="10"]')
  await hourTen.click()
  await expect(page.locator('#billing-day-hour-readout')).toHaveText('[10:00—11:00]  TOTAL 2.5K  //  CACHE 1.3K  //  50.0% CACHE')
  await hourTen.press('ArrowRight')
  await expect(page.locator('#billing-day-hour-strip .billing-day-hour-cell.selected')).toHaveAttribute('data-hour', '11')
  await expect(page.locator('#billing-day-hour-readout')).toHaveText('[11:00—12:00]  TOTAL 0  //  CACHE 0  //  NO ACTIVITY')
  await expect(page.locator('#billing-day-date')).toContainText(dailyPoints.at(-1)!.date)
  await expect(page.locator('#billing-day-provider-shares .billing-day-share-row')).toHaveCount(2)
  await expect(page.locator('#billing-day-provider-shares')).toContainText('CODEX')
  await expect(page.locator('#billing-day-provider-shares')).toContainText('80.0% · 8,000')
  await expect(page.locator('#billing-daily-range')).toContainText('3/4 SOURCES')
  await expect(page.locator('#billing-calendar-grid .billing-calendar-day')).toHaveCount(52 * 7)
  await expect.poll(() => page.locator('#billing-calendar-grid .billing-calendar-day').evaluateAll(days => (
    new Set(days.map(day => day.getAttribute('data-level'))).size
  ))).toBeGreaterThanOrEqual(4)
  await expect(page.locator('#billing-calendar-months span')).toHaveCount(calendarWeekCount)
  await expect(page.locator('#billing-calendar-grid .billing-calendar-day.selected')).toHaveAttribute('data-date', dailyPoints.at(-1)!.date)
  for (const [pointIndex, tier] of [[297, 1], [300, 2], [298, 3], [299, 4]] as const) {
    const overrangeDay = page.locator(`.billing-calendar-day[data-date="${dailyPoints[pointIndex].date}"]`)
    await expect(overrangeDay).toHaveAttribute('data-level', 'overrange')
    await expect(overrangeDay).toHaveAttribute('data-overrange', String(tier))
  }
  await expect(page.locator('.billing-overrange-scale i')).toHaveCount(4)
  const overrangeLegendStyles = await page.locator('.billing-overrange-scale i').evaluateAll(cells => cells.map(cell => ({
    background: getComputedStyle(cell).backgroundColor,
    symbol: {
      content: getComputedStyle(cell, '::after').content,
      width: getComputedStyle(cell, '::after').width,
      height: getComputedStyle(cell, '::after').height,
      borderRadius: getComputedStyle(cell, '::after').borderRadius,
      clipPath: getComputedStyle(cell, '::after').clipPath,
      transform: getComputedStyle(cell, '::after').transform,
    },
  })))
  expect(new Set(overrangeLegendStyles.map(style => style.background)).size).toBe(4)
  expect(overrangeLegendStyles.map(style => style.symbol.content)).toEqual(['""', '""', '""', '""'])
  expect(overrangeLegendStyles.map(style => style.symbol.width)).toEqual(['3px', '6px', '5px', '8px'])
  expect(overrangeLegendStyles.map(style => style.symbol.height)).toEqual(['3px', '6px', '5px', '8px'])
  expect(overrangeLegendStyles.slice(0, 2).map(style => style.symbol.borderRadius)).toEqual(['50%', '50%'])
  expect(overrangeLegendStyles[2].symbol.transform).not.toBe(overrangeLegendStyles[1].symbol.transform)
  expect(overrangeLegendStyles[3].symbol.clipPath).not.toBe('none')
  const liveRequestBaseline = currentDayLiveRequests
  const observedIntermediateTotal = page.locator('#billing-day-total-meter').evaluate((meter) => new Promise<boolean>((resolve) => {
    const readDisplayed = () => Number((meter as HTMLElement).dataset.displayedTotal)
    const observer = new MutationObserver(() => {
      const value = readDisplayed()
      if (value > 10_000 && value < 16_000) {
        observer.disconnect()
        resolve(true)
      }
    })
    observer.observe(meter, { attributes: true, attributeFilter: ['data-displayed-total'] })
    window.setTimeout(() => {
      observer.disconnect()
      resolve(false)
    }, 8_000)
  }))
  omitCurrentDayHourlyBinsOnce = true
  allowCurrentDayIncrease = true
  await expect.poll(() => currentDayLiveRequests, { timeout: 8_000 }).toBeGreaterThan(liveRequestBaseline)
  await expect(page.locator('#billing-day-insight-state')).toHaveText('24 HOURLY BINS READY')
  await expect(page.locator('#billing-day-total-path')).toHaveAttribute('d', /^M.+L/)
  await expect(page.getByText('DAY SIGNAL LOST', { exact: true })).toHaveCount(0)
  expect(await observedIntermediateTotal).toBe(true)
  await expect(page.locator('#billing-day-total')).toHaveText('16,000')
  await expect(page.locator('#billing-day-total-compact')).toHaveText('16K')
  await page.locator(`.billing-calendar-day[data-date="${dailyPoints[300].date}"]`).click()
  await expect(page.locator('#billing-day-date')).toContainText(dailyPoints[300].date)
  await expect.poll(() => dayDetailRequests.at(-1)).toBe(dailyPoints[300].date)
  await expect.poll(() => dayDetailRequests.filter(date => date === dailyPoints[300].date).length).toBe(2)
  expect(historicalTransientFailures).toBe(1)
  await expect(page.locator('#billing-day-total')).toHaveText('2,000,000,000')
  await expect(page.locator('#billing-day-total-compact')).toHaveText('2B')
  await expect(page.locator('#billing-day-total-meter')).not.toHaveClass(/is-live/)
  await expect(page.locator('#billing-day-insight-state')).toHaveText('24 HOURLY BINS READY')
  const observedTodayReselectionGap = page.locator('#billing-day-total-meter').evaluate((meter) => new Promise<boolean>((resolve) => {
    const observer = new MutationObserver(() => {
      const value = Number((meter as HTMLElement).dataset.displayedTotal)
      if (value > 10_000 && value < 16_000) {
        observer.disconnect()
        resolve(true)
      }
    })
    observer.observe(meter, { attributes: true, attributeFilter: ['data-displayed-total'] })
    window.setTimeout(() => {
      observer.disconnect()
      resolve(false)
    }, 4_000)
  }))
  const todayReselectionRequestBaseline = currentDayLiveRequests
  await page.locator(`.billing-calendar-day[data-date="${dailyPoints.at(-1)!.date}"]`).click()
  await expect.poll(() => currentDayLiveRequests).toBeGreaterThan(todayReselectionRequestBaseline)
  expect(await observedTodayReselectionGap).toBe(true)
  await expect(page.locator('#billing-day-input')).toHaveText('5,600')
  await expect(page.locator('#billing-day-output')).toHaveText('2,400')
  await expect(page.locator('#billing-day-cache-read')).toHaveText('7,200')
  await expect(page.locator('#billing-day-cache-write')).toHaveText('800')
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
