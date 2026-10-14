import { expect, openFarming, test } from './fixtures'
import type { Route } from '@playwright/test'

test('keeps parent activity visible while child history fails, recovers and pages within a turn', async ({ page, workspaceRoot }, testInfo) => {
  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.request.post('/farming/api/settings', { data: { language: 'en' } })
  const created = await page.request.post('/farming/api/control/agents', {
    data: { command: 'codex', workspace: workspaceRoot, agentRuntimeMode: 'chat' },
  })
  expect(created.ok()).toBeTruthy()
  const { agentId } = await created.json() as { agentId: string }
  await openFarming(page)
  await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
  await page.getByTestId('code-acp-composer-input').fill('related workflow demo')
  await page.getByTestId('code-acp-composer-send').click()
  await expect(page.getByTestId('code-agent-chat-view')).toContainText('Review group ready.')
  const envelope = await (await page.request.get(`/farming/api/agents/${agentId}/acp-transcript`)).json()
  const now = Date.now()
  envelope.toRevision += 10000
  envelope.replace = true
  envelope.transcript = {
    ...envelope.transcript, state: 'working', revision: envelope.toRevision, includesLatest: true,
    chatTurn: { status: 'active', turnId: 'parent-turn' },
    entries: [
      { id: 'question', type: 'message', role: 'user', turnStartedAt: now - 30000,
        content: [{ type: 'text', text: 'Inspect parser changes with parallel reviewers.' }] },
      { id: 'verification', type: 'tool', kind: 'execute', title: 'npm test --unit', status: 'completed',
        lastActivityAt: now, content: [], transcriptDetail: '42 checks passed' },
    ],
  }
  await page.route(`**/api/agents/${agentId}/acp-transcript?*`, route => route.fulfill({ json: envelope }))
  let failRead = true
  await page.route(`**/api/agents/${agentId}/acp-subagents/*/transcript?*`, route => {
    if (failRead) return route.fulfill({ status: 409, json: { error: 'Provider history read unavailable. Retry this page.' } })
    const url = new URL(route.request().url())
    const sessionId = decodeURIComponent(url.pathname.split('/').at(-2)!)
    const older = Boolean(url.searchParams.get('cursor'))
    return route.fulfill({ json: {
      version: 2, protocol: 'acp', provider: 'codex', sessionId, state: 'idle',
      includesLatest: !older, nextCursor: older ? null : 'older-item-boundary', hasMoreBefore: !older,
      entries: [
        ...(!older ? Array.from({ length: 30 }, (_, index) => ({
          id: `peer-${index}`, type: 'message', role: 'user',
          content: [{ type: 'text', text: `Peer history message ${index}.` }],
          _meta: { peerMessage: { version: 1, direction: 'incoming', senderAddress: '/root/reviewer' } },
        })) : []),
        { id: older ? 'earlier-output' : 'latest-answer', type: 'message', role: 'assistant',
          content: [{ type: 'text', text: older ? 'Earlier tool output from the same long turn.' : 'Review complete. Latest result remains readable.' }] },
      ],
    } })
  })
  await page.reload()
  await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
  const recent = page.getByTestId('code-agent-transcript-live-activity')
  await expect(recent).toContainText('Last activity: npm test --unit')
  await expect(recent.getByTestId('code-agent-transcript-live-activity-icon')).toHaveAttribute('data-kind', 'processing')
  const parentRow = page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
  await parentRow.hover()
  const disclosure = parentRow.getByTestId('code-agent-row-related-visibility')
  await expect(disclosure).toBeVisible()
  if (await disclosure.getAttribute('aria-expanded') === 'false') await disclosure.click()
  await expect(disclosure).toHaveAttribute('aria-expanded', 'true')
  await page.getByTestId('code-native-related-finished').locator('summary').click()
  await page.getByTestId('code-native-related-row').filter({ hasText: 'Review 0' }).click()
  const panel = page.getByTestId('code-related-session-panel')
  await expect(panel.getByRole('alert')).toContainText('Transcript read failed:')
  for (const appearance of ['light', 'dark', 'paper']) {
    await page.evaluate(value => {
      document.body.dataset.appearance = value
      document.documentElement.dataset.appearance = value
    }, appearance)
    await expect(recent).toBeVisible()
    const image = await page.screenshot({ path: testInfo.outputPath(`${appearance}-read-error.png`), animations: 'disabled' })
    expect([image.readUInt32BE(16), image.readUInt32BE(20)]).toEqual([1600, 1000])
  }
  failRead = false
  await panel.getByRole('button', { name: 'Retry', exact: true }).click()
  await expect(panel).toContainText('Latest result remains readable.')
  await expect(panel).toContainText('Peer history message 0.')
  await expect(panel).toContainText('Peer history message 29.')
  await expect(panel.getByRole('alert')).toHaveCount(0)
  await panel.getByRole('button', { name: 'Load earlier messages' }).click()
  await expect(panel).toContainText('Earlier tool output from the same long turn.')
  await expect(panel.getByRole('button', { name: 'Load earlier messages' })).toHaveCount(0)
  await panel.getByRole('button', { name: 'Return to latest' }).click()
  await expect(panel).toContainText('Latest result remains readable.')
  for (const appearance of ['light', 'dark', 'paper']) {
    await page.evaluate(value => {
      document.body.dataset.appearance = value
      document.documentElement.dataset.appearance = value
    }, appearance)
    await expect(recent).toBeVisible()
    await panel.getByText('Review complete. Latest result remains readable.', { exact: true }).scrollIntoViewIfNeeded()
    await expect(panel.getByText('Review complete. Latest result remains readable.', { exact: true })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath(`${appearance}-recovered.png`), animations: 'disabled' })
  }
  await page.setViewportSize({ width: 760, height: 900 })
  const switcher = page.getByRole('navigation', { name: 'Related sessions' })
  for (const appearance of ['light', 'dark', 'paper']) {
    await page.evaluate(value => {
      document.body.dataset.appearance = value
      document.documentElement.dataset.appearance = value
    }, appearance)
    await switcher.getByRole('button', { name: 'Parent', exact: true }).click()
    await expect(recent).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath(`${appearance}-compact-parent.png`), animations: 'disabled' })
    await switcher.getByRole('button', { name: 'Review 0', exact: true }).click()
    await expect(panel).toBeVisible()
    await panel.getByText('Review complete. Latest result remains readable.', { exact: true }).scrollIntoViewIfNeeded()
    await expect(panel.getByText('Review complete. Latest result remains readable.', { exact: true })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath(`${appearance}-compact-child.png`), animations: 'disabled' })
  }
})

for (const language of ['en', 'zh']) {
  test(`isolates delayed child reads and recovers historical failures without changing parent drafts (${language})`, async ({ page, workspaceRoot }, testInfo) => {
    await page.setViewportSize({ width: 1600, height: 1000 })
    await page.request.post('/farming/api/settings', { data: { language } })
    const created = await page.request.post('/farming/api/control/agents', {
      data: { command: 'codex', workspace: workspaceRoot, agentRuntimeMode: 'chat' },
    })
    expect(created.ok()).toBeTruthy()
    const { agentId } = await created.json() as { agentId: string }
    await openFarming(page)
    const parent = page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
    await parent.click()
    const input = page.getByTestId('code-acp-composer-input')
    await input.fill('related workflow demo')
    await page.getByTestId('code-acp-composer-send').click()
    await expect(page.getByTestId('code-agent-chat-view')).toContainText('Review group ready.')
    await input.fill('Keep the parent draft unchanged.')
    const rows = page.getByTestId('code-native-related-row')
    const panel = page.getByTestId('code-related-session-panel')
    const reads: Array<{ sessionId: string; cursor: string }> = []
    let held: Route | undefined
    let released = false
    let failOlder = true
    const text = {
      latest: language === 'zh' ? '实现检查仍在执行，最新结果可读。' : 'Implementation is still running; latest output is readable.',
      older: language === 'zh' ? '更早的长命令输出。' : 'Earlier long command output.',
      failed: language === 'zh' ? '依赖服务不可用，集成测试失败。' : 'Integration failed because its dependency is unavailable.',
      error: language === 'zh' ? '会话记录读取失败：' : 'Transcript read failed:',
      earlier: language === 'zh' ? '加载更早消息' : 'Load earlier messages',
      return: language === 'zh' ? '返回最新消息' : 'Return to latest',
      retry: language === 'zh' ? '重试' : 'Retry',
    }
    const reply = (route: Route, message?: string) => {
      const url = new URL(route.request().url())
      const sessionId = decodeURIComponent(url.pathname.split('/').at(-2)!)
      const older = Boolean(url.searchParams.get('cursor'))
      const failed = sessionId.endsWith('-review-13')
      return route.fulfill({ json: {
        version: 2, protocol: 'acp', provider: 'codex', sessionId, canCancel: false,
        state: failed ? 'error' : 'working', error: failed ? text.failed : '',
        stopReason: failed ? 'error' : '', includesLatest: !older,
        nextCursor: !failed && !older ? 'older-item-boundary' : null,
        hasMoreBefore: !failed && !older,
        entries: [{ id: 'question', type: 'message', role: 'user',
          content: [{ type: 'text', text: 'Review parser implementation and integration tests.' }] },
        { id: older ? 'older' : 'answer', type: 'message', role: 'assistant',
          content: [{ type: 'text', text: message || (failed ? text.failed : older ? text.older : text.latest) }] }],
      } })
    }
    await page.route(`**/api/agents/${agentId}/acp-subagents/*/transcript?*`, async route => {
      const url = new URL(route.request().url())
      const sessionId = decodeURIComponent(url.pathname.split('/').at(-2)!)
      const cursor = url.searchParams.get('cursor') || ''
      reads.push({ sessionId, cursor })
      if (sessionId.endsWith('-review-12') && !held) { held = route; return }
      if (cursor && failOlder) return route.fulfill({
        status: 409, json: { error: 'A single subagent history item exceeds the 1.5 MiB page limit. Inspect provider history.' },
      })
      await reply(route)
    })
    try {
      await rows.filter({ hasText: 'Review 12' }).click()
      await expect.poll(() => Boolean(held)).toBe(true)
      await expect(panel.getByRole('status')).toContainText(language === 'zh' ? '加载中' : 'Loading')
      await rows.filter({ hasText: 'Review 13' }).click()
      await expect(panel).toContainText(text.failed)
      // Complete an obsolete request only after the next child's view is ready.
      await reply(held!, 'OBSOLETE CHILD RESPONSE MUST NOT REPLACE THE SELECTED CHILD')
      released = true
      await expect(panel.locator('.code-related-session-header')).toContainText('Review 13')
      await expect(panel).not.toContainText('OBSOLETE CHILD RESPONSE')
      await expect(panel.getByRole('alert')).toHaveCount(0)
      await expect(input).toHaveValue('Keep the parent draft unchanged.')
      for (const appearance of ['light', 'dark', 'paper']) {
        await page.evaluate(value => {
          document.body.dataset.appearance = value
          document.documentElement.dataset.appearance = value
        }, appearance)
        await expect(panel.locator('.code-agent-transcript-subagent-status')).toHaveText(language === 'zh' ? '失败' : 'Failed')
        await page.screenshot({ path: testInfo.outputPath(`${language}-${appearance}-execution-failed.png`), animations: 'disabled' })
      }
      await rows.filter({ hasText: 'Review 12' }).click()
      await expect(panel).toContainText(text.latest)
      await panel.getByRole('button', { name: text.earlier, exact: true }).click()
      await expect(panel.getByRole('alert')).toContainText(text.error)
      await expect(panel.getByRole('alert')).toContainText('1.5 MiB')
      await expect(panel.getByRole('button', { name: text.return, exact: true })).toBeEnabled()
      for (const width of [1600, 390]) {
        await page.setViewportSize({ width, height: width === 1600 ? 1000 : 844 })
        // The shared viewport owner applies compact layout after resize.
        // Wait for that transition before measuring controls or capturing it.
        if (width === 390) await expect(page.locator('body')).toHaveClass(/code-compact-layout/)
        else await expect(page.locator('body')).not.toHaveClass(/code-compact-layout/)
        for (const appearance of ['light', 'dark', 'paper']) {
          await page.evaluate(value => {
            document.body.dataset.appearance = value
            document.documentElement.dataset.appearance = value
          }, appearance)
          await expect(panel.getByRole('alert')).toBeVisible()
          expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
          expect(await panel.locator('.code-related-session-content').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
          const retry = panel.getByRole('button', { name: text.retry, exact: true })
          await expect(retry).toHaveCSS('border-radius', '6px')
          expect((await retry.boundingBox())!.height).toBeGreaterThanOrEqual(width === 390 ? 44 : 32)
          const navigation = panel.getByRole('navigation', { name: language === 'zh' ? '会话记录翻页' : 'Transcript history' })
          const [newer, latest] = await navigation.getByRole('button').all()
          const newerBox = (await newer.boundingBox())!
          const latestBox = (await latest.boundingBox())!
          expect(latestBox.x >= newerBox.x + newerBox.width + 4 || latestBox.y >= newerBox.y + newerBox.height + 4).toBe(true)
          if (width === 390) expect(latestBox.height).toBeGreaterThanOrEqual(44)
          await latest.focus()
          await expect(latest).toBeFocused()
          const png = await page.screenshot({ path: testInfo.outputPath(`${language}-${appearance}-${width}-history-error.png`), animations: 'disabled' })
          expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([width, width === 1600 ? 1000 : 844])
        }
      }
      failOlder = false
      await panel.getByRole('button', { name: text.retry, exact: true }).click()
      await expect(panel).toContainText(text.older)
      await expect(panel.getByRole('alert')).toHaveCount(0)
      expect(reads.at(-1)?.cursor).toBe('older-item-boundary')
      await panel.getByRole('button', { name: text.return, exact: true }).click()
      await expect(panel).toContainText(text.latest)
      await page.setViewportSize({ width: 1600, height: 1000 })
      await rows.filter({ hasText: 'Review 13' }).click()
      await expect(panel).toContainText(text.failed)
      expect(reads.filter(read => read.sessionId.endsWith('-review-13')).every(read => !read.cursor)).toBe(true)
      await expect(input).toHaveValue('Keep the parent draft unchanged.')
      await parent.press('Enter')
      await expect(panel).toHaveCount(0)
      await expect(input).toHaveValue('Keep the parent draft unchanged.')
    } finally {
      // A failed assertion must not leave a paused route alive in the browser.
      if (held && !released) await held.abort()
    }
  })
}
