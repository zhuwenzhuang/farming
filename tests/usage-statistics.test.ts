/// <reference path="../backend/types/runtime-globals.d.ts" />
import test from 'node:test'
import assert from 'node:assert/strict'
import { UsageMonitor, buildDailyUsage, buildUsageTimeline, collectOpenCodeDailyEvents } from '../backend/usage-monitor.cjs'
import type { UsageHistoryResult } from '../backend/usage-history-client.cjs'

const day = (now: number) => { const date = new Date(now); return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}` }
function history(now: number, tokens = 100): UsageHistoryResult {
  return { source: 'fixture', sampledAt: now, cache: { scan_complete: true, errors: 0 }, providers: {
    codex: { available: true, fileCount: 1, quotaCandidates: [{ timestamp: now, rateLimits: { limit_id: 'codex', primary: { used_percent: 92, window_minutes: 10080 } } }],
      events: [{ timestamp: now - 1, sessionId: 'shared', totalTokens: tokens, inputTokens: tokens }] },
    claude: { available: true, fileCount: 1, quotaCandidates: [], events: [{ timestamp: now - 1, sessionId: 'claude', totalTokens: tokens, outputTokens: tokens }] },
  } }
}
const base = {
  codexHome: '/fixture/codex', claudeHome: '/fixture/claude',
  commandRunner: async () => ({ stdout: 'Logged in' }),
  openCodeCommandRunner: async () => ({ stdout: '[]' }),
  codexQuotaReader: async () => ({ available: true, source: 'account fixture', sampledAt: 1,
    primary: { usedPercent: 49, windowMinutes: 10080, resetsAt: null } }),
}

test('summary uses one history observation for all providers; each account Home remains isolated', async () => {
  const now = new Date(2026, 8, 29, 12).getTime()
  let calls = 0
  const monitor = new UsageMonitor({ ...base, usageHistoryClient: { collect: async () => history(now, ++calls * 100) },
    getProviderHomes: () => ({ codex: [{ id: 'default', path: '/fixture/main' }, { id: 'proxy', path: '/fixture/proxy' }] }),
    codexQuotaReader: async home => ({ available: true, source: 'account fixture', sampledAt: now,
      primary: { usedPercent: home.endsWith('main') ? 49 : 10, windowMinutes: 10080, resetsAt: null } }),
  })
  const summary = await monitor.getUsageSummary({ now })
  assert.equal(calls, 1)
  assert.equal(summary.daily.summary.todayTokens, 200)
  assert.equal(summary.timeline.totalTokens, 200)
  const codex = summary.providers.find(provider => provider.provider === 'codex')!
  const quota = codex.quota as { accounts: Array<{ homeId: string; primary: { usedPercent: number } }> }
  assert.deepEqual(quota.accounts.map(row => [row.homeId, row.primary.usedPercent]), [['default',49],['proxy',10]])
  const detail = await monitor.getUsageDay(day(now), { now, live: true })
  assert.equal(detail.total.totalTokens, 200)
  assert.equal(detail.hours.reduce((sum, hour) => sum + hour.totalTokens, 0), 200)
  assert.equal((await monitor.getUsageSummary({ now: now + 16_000 })).daily.summary.todayTokens, 400)
})

test('cache crosses midnight, Home changes and invalidation without retaining an old observation', async () => {
  let now = new Date(2026, 8, 29, 23, 59, 59).getTime()
  let home = '/fixture/a'; let calls = 0
  const monitor = new UsageMonitor({ ...base, getProviderHomes: () => ({ codex: [home] }),
    usageHistoryClient: { collect: async () => history(now, ++calls) } })
  await monitor.getDailyUsage({ now }); now += 2000
  assert.equal((await monitor.getDailyUsage({ now })).daily.endDate, day(now))
  assert.equal(calls, 2)
  home = '/fixture/b'; await monitor.getDailyUsage({ now }); assert.equal(calls, 3)
  let completeHome!: (value: UsageHistoryResult) => void
  monitor.ccStatisticsClient = { collect: () => new Promise(resolve => { completeHome = resolve }) }
  home = '/fixture/c'
  const changedHome = monitor.getDailyUsage({ now })
  const concurrentHome = monitor.getDailyUsage({ now })
  completeHome(history(now, 12))
  assert.equal((await changedHome).daily.summary.todayTokens, 24)
  assert.equal((await concurrentHome).daily.summary.todayTokens, 24)
  let release!: (value: UsageHistoryResult) => void
  monitor.ccStatisticsClient = { collect: () => new Promise(resolve => { release = resolve }) }
  const pending = monitor.getDailyUsage({ now, force: true })
  monitor.invalidateDailyCache(); release(history(now, 999)); await pending
  monitor.ccStatisticsClient = { collect: async () => history(now, 7) }
  assert.equal((await monitor.getDailyUsage({ now })).daily.summary.todayTokens, 14)
})

test('scan failures remain incomplete, recover promptly, and future records never enter totals', async () => {
  const now = new Date(2026, 8, 29, 12).getTime()
  const monitor = new UsageMonitor({ ...base, usageHistoryClient: { collect: async () => { throw new Error('scan unavailable') } } })
  const failed = await monitor.getUsageDay(day(now), { now, live: true })
  assert.equal(failed.partial, true)
  monitor.ccStatisticsClient = { collect: async () => history(now, 9) }
  assert.equal((await monitor.getUsageDay(day(now), { now: now + 1, live: true })).total.totalTokens, 18)
  const events = { codex: [{ timestamp: now + 1000, totalTokens: 999 }, { timestamp: now - 1, totalTokens: 8 }] }
  assert.equal(buildDailyUsage(events, { now, days: 1 }).summary.todayTokens, 8)
  assert.equal(buildUsageTimeline(events, { now, alignToBucket: true }).totalTokens, 8)
})

test('cached OpenCode source events become visible when their timestamp enters the observation window', async () => {
  const now = new Date(2026, 8, 29, 12).getTime()
  let exports = 0
  const openCodeCommandRunner = async (args: string[]) => {
    if (args[0] === 'session') return { stdout: JSON.stringify([{ id: 'future-cache-fixture', updated: now + 1000 }]) }
    exports += 1
    return { stdout: JSON.stringify({ messages: [{ info: { role: 'assistant', time: { completed: now + 1000 }, tokens: { input: 10, output: 4 } } }] }) }
  }
  const homes = ['/fixture/opencode-future-cache']
  assert.equal((await collectOpenCodeDailyEvents(homes, { now, openCodeCommandRunner })).events.length, 0)
  assert.equal((await collectOpenCodeDailyEvents(homes, { now: now + 2000, openCodeCommandRunner })).events[0]?.totalTokens, 14)
  assert.equal(exports, 1)
})
