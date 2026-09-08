import fs from 'node:fs'
import path from 'node:path'
import { expect, openFarming, test } from './fixtures'

for (const presentation of ['row', 'rail', 'rail-pinned'] as const) {
test(`shell ${presentation} activity waits one second without delaying authoritative state`, async ({ page, workspaceRoot }, testInfo) => {
  const workspace = path.join(workspaceRoot, 'shell-status')
  fs.mkdirSync(workspace, { recursive: true })
  const response = await page.request.post('/farming/api/control/agents', { data: { command: 'bash', workspace } })
  expect(response.ok()).toBeTruthy()
  const { agentId } = await response.json() as { agentId: string }
  if (presentation === 'rail-pinned') {
    const pinResponse = await page.request.patch(`/farming/api/agents/${agentId}`, { data: { pinned: true } })
    expect(pinResponse.ok()).toBeTruthy()
  }
  // This case owns synthetic runtime phases and a virtual clock. Hydrate from
  // the real server, then stop its independent idle/heartbeat snapshots from
  // replacing those phases. Real Shell input/notifications are covered by the
  // terminal-native notification case and release Computer acceptance.
  let receiveLiveMessages = true
  await page.routeWebSocket(/\/farming\/ws(?:\?|$)/, socket => {
    const server = socket.connectToServer()
    server.onMessage(payload => {
      if (receiveLiveMessages) socket.send(payload)
    })
  })
  await openFarming(page)
  if (presentation !== 'row') {
    await page.getByTestId('code-sidebar-toggle').click()
    await expect(page.getByTestId('code-workspace')).toHaveClass(/sidebar-collapsed/)
  }
  const row = page.locator(`[data-testid="${presentation === 'row' ? 'code-agent-row' : 'code-agent-rail-item'}"][data-agent-id="${agentId}"]`)
  const statusClass = presentation === 'row' ? '.code-agent-dot' : '.code-agent-rail-status'
  await expect(row).toBeVisible()
  await expect(row.locator(statusClass)).toHaveCount(0)
  receiveLiveMessages = false
  const clockStart = new Date()
  // Start behind the target so separate browser calls cannot pause in the past.
  await page.clock.install({ time: new Date(clockStart.getTime() - 60_000) })
  await page.clock.pauseAt(clockStart)
  // Drain any real update already queued in the 32ms live-state batch.
  await page.clock.runFor(40)
  let commandStartedAt = Date.now()
  const patch = async (phase: 'working' | 'idle', kind: 'shell' | 'codex' = 'shell', epoch = 'shell-test') => {
    await page.evaluate(({ agentId, phase, kind, epoch, startedAt }) => {
      const bridge = (window as typeof window & {
        __farmingAgentActivityTest?: { update: (id: string, patch: unknown) => void }
      }).__farmingAgentActivityTest
      if (!bridge) throw new Error('Agent activity fixture is unavailable')
      bridge.update(agentId, {
        status: 'running',
        runtimeEpoch: epoch,
        shellCommandStartedAt: startedAt,
        terminalStatus: { kind, busy: phase === 'working', runningCommandStartedAt: startedAt },
        runtimeObservation: { kind, phase, confidence: 'authoritative', source: 'shell-marker', observerVersion: 'shell-status-test', observedAt: Date.now() },
      })
    }, { agentId, phase, kind, epoch, startedAt: ++commandStartedAt })
    // Live state publishes through a 32ms batch before the visual timer mounts.
    await page.clock.runFor(40)
  }
  const indicator = row.locator(`${statusClass}.turn-active`)
  // Collapsed desktop navigation shows the rail; both compact strip variants
  // remain mounted but hidden. Verify their live projection without changing UI.
  const compact = presentation === 'row' ? null : page.locator(
    `[data-testid="${presentation === 'rail-pinned' ? 'code-pinned-agent-compact' : 'code-project-agent-compact'}"][data-agent-id="${agentId}"]`,
  )
  if (compact) await expect(compact).toHaveCount(1)
  const compactIndicator = compact?.locator('.code-project-agent-compact-status.turn-active')
  for (const appearance of ['light', 'dark', 'paper']) {
    await page.locator('body').evaluate((body, value) => { body.dataset.appearance = value }, appearance)
    await patch('working')
    await expect(indicator).toHaveCount(1)
    await expect(indicator).toBeHidden()
    if (compactIndicator) await expect(compactIndicator).toHaveCSS('visibility', 'hidden')
    await page.clock.runFor(500)
    await expect(indicator).toBeHidden()
    await patch('idle')
    await page.clock.runFor(1000)
    await expect(indicator).toHaveCount(0)
    if (compactIndicator) await expect(compactIndicator).toHaveCount(0)
    await expect(row).not.toHaveClass(/unread/)

    await patch('working')
    await page.clock.runFor(1000)
    await expect(indicator).toBeVisible()
    if (compactIndicator) await expect(compactIndicator).toHaveCSS('visibility', 'visible')
    await row.screenshot({ path: testInfo.outputPath(`shell-${presentation}-running-${appearance}.png`), animations: 'disabled' })
    // A new command can replace the old one without an intervening idle frame.
    await patch('working')
    await expect(indicator).toBeHidden()
    if (compactIndicator) await expect(compactIndicator).toHaveCSS('visibility', 'hidden')
    await page.clock.runFor(500)
    await patch('working', 'shell', 'replacement-epoch')
    await page.clock.runFor(600)
    await expect(indicator).toBeHidden()
    if (compactIndicator) await expect(compactIndicator).toHaveCSS('visibility', 'hidden')
    await page.clock.runFor(400)
    await expect(indicator).toBeVisible()
    if (compactIndicator) await expect(compactIndicator).toHaveCSS('visibility', 'visible')
    await patch('idle')
    await expect(indicator).toHaveCount(0)
    if (compactIndicator) await expect(compactIndicator).toHaveCount(0)
  }
  await patch('working', 'codex')
  await expect(indicator).toBeVisible()
  await patch('idle')
})
}
