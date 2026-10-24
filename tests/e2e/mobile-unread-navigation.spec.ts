import fs from 'node:fs'
import path from 'node:path'
import type { Locator } from '@playwright/test'
import { expect, openFarming, test } from './fixtures'

test.use({ hasTouch: true, viewport: { width: 390, height: 844 } })

async function touch(target: Locator, phase: 'touchstart' | 'touchmove' | 'touchend' | 'touchcancel', x: number, y = 200) {
  await target.evaluate((element, args) => {
    // WebKit does not expose a constructible Touch. Supply the event's public
    // touch lists; Chromium additionally exercises a native stream below.
    const point = { identifier: 1, target: element, clientX: args.x, clientY: args.y }
    const event = new Event(args.phase, { bubbles: true, cancelable: true })
    Object.defineProperties(event, {
      touches: { value: args.phase === 'touchend' || args.phase === 'touchcancel' ? [] : [point] },
      changedTouches: { value: [point] },
    })
    element.dispatchEvent(event)
  }, { phase, x, y })
}

test('mobile unread navigation previews, cancels and preserves drafts across appearances', async ({ page, workspaceRoot, browserName }, testInfo) => {
  test.setTimeout(120_000)
  const ids: string[] = []
  for (let i = 0; i < 3; i++) {
    const workspace = path.join(workspaceRoot, i === 2 ? 'Atlas' : 'Northstar')
    fs.mkdirSync(workspace, { recursive: true })
    const response = await page.request.post('/farming/api/control/agents', {
      data: { command: 'codex', workspace, name: `Mobile Agent ${i}`, agentRuntimeMode: 'chat' },
    })
    expect(response.ok()).toBeTruthy()
    const { agentId } = await response.json() as { agentId: string }
    ids.push(agentId)
    expect((await page.request.post(`/farming/api/control/agents/${agentId}/title`, {
      data: { title: `Mobile Agent ${i}` },
    })).ok()).toBeTruthy()
  }
  // Northstar's newest Agent precedes source. Continue through Atlas first,
  // then wrap to the earlier Northstar row, exactly as the Project list does.
  const [source, third, second] = ids as [string, string, string]
  await openFarming(page)
  const select = async (id: string) => {
    await page.getByTestId('code-mobile-menu').click()
    await page.locator(`[data-testid="code-agent-row"][data-agent-id="${id}"]`).click()
    await expect(page.locator(`[data-testid="code-agent-work-pane"][data-agent-id="${id}"]`)).toBeVisible()
  }
  await select(source)
  const input = page.getByTestId('code-acp-composer-input')
  await input.fill('markdown typography')
  await page.getByTestId('code-acp-composer-send').click()
  const chat = page.getByTestId('code-agent-chat-view').filter({ visible: true })
  await expect(chat.getByText('Typography baseline.')).toBeVisible()
  await input.fill('Keep this unsent draft')
  await input.blur()
  const markUnread = async (id: string, unread = true) => {
    expect((await page.request.patch(`/farming/api/agents/${id}`, { data: { unread } })).ok()).toBeTruthy()
  }
  await markUnread(second)
  await markUnread(third)
  const next = page.getByTestId('code-mobile-next-unread')
  await expect(next).toContainText('2')
  await expect(next).toHaveAccessibleName(/Mobile Agent 2/)
  const prose = chat.getByText('Typography baseline.')
  for (const appearance of ['light', 'dark', 'paper'] as const) {
    await page.evaluate(value => {
      document.documentElement.dataset.appearance = value
      document.body.dataset.appearance = value
    }, appearance)
    await expect(next).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    await next.evaluate(element => element.blur())
    await page.screenshot({ path: testInfo.outputPath(`unread-${appearance}-resting.png`) })
    await touch(prose, 'touchstart', 300)
    await touch(prose, 'touchmove', 150)
    const preview = page.getByTestId('code-mobile-unread-preview')
    await expect(preview).toContainText('Mobile Agent 2')
    await expect(preview).toContainText('Release to switch')
    await expect(next).toContainText('2')
    await page.screenshot({ path: testInfo.outputPath(`unread-${appearance}-preview.png`) })
    await touch(prose, 'touchmove', 280)
    await touch(prose, 'touchend', 280)
    await expect(preview).toHaveCount(0)
    await expect(input).toHaveText('Keep this unsent draft')
  }

  // Capture a target once: new arrivals must not change the meaning of release.
  await markUnread(second, false)
  await expect(next).toHaveAccessibleName(/Mobile Agent 1/)
  await touch(prose, 'touchstart', 300)
  await touch(prose, 'touchmove', 150)
  await expect(page.getByTestId('code-mobile-unread-preview')).toContainText('Mobile Agent 1')
  await markUnread(second)
  await expect(next).toHaveAccessibleName(/Mobile Agent 2/)
  await touch(prose, 'touchmove', 140)
  await expect(page.getByTestId('code-mobile-unread-preview')).toContainText('Mobile Agent 1')
  await touch(prose, 'touchcancel', 140)

  // A read acknowledgement from another client invalidates the captured target.
  await touch(prose, 'touchstart', 300)
  await touch(prose, 'touchmove', 150)
  await markUnread(second, false)
  await expect(next).toHaveAccessibleName(/Mobile Agent 1/)
  await touch(prose, 'touchend', 150)
  await expect(page.getByTestId('code-mobile-unread-preview')).toHaveCount(0)
  await expect(input).toHaveText('Keep this unsent draft')
  await markUnread(second)
  await expect(next).toHaveAccessibleName(/Mobile Agent 2/)

  // Vertical scrolling, cancellation, selected text, and code/table gestures
  // must retain the current Agent and never acknowledge the target.
  await touch(prose, 'touchstart', 300)
  await touch(prose, 'touchmove', 290, 280)
  await touch(prose, 'touchmove', 140, 280)
  await touch(prose, 'touchend', 140, 280)
  await expect(page.getByTestId('code-mobile-unread-preview')).toHaveCount(0)
  for (const target of [prose, chat.locator('pre').first(), chat.locator('table').first()]) {
    await touch(target, 'touchstart', 300)
    await touch(target, 'touchmove', 140)
    if (target !== prose) await expect(page.getByTestId('code-mobile-unread-preview')).toHaveCount(0)
    await touch(target, 'touchcancel', 140)
  }
  await prose.evaluate(element => {
    const range = document.createRange()
    range.selectNodeContents(element)
    window.getSelection()?.removeAllRanges()
    window.getSelection()?.addRange(range)
  })
  await expect.poll(() => page.evaluate(() => String(window.getSelection()))).toContain('Typography baseline.')
  await touch(prose, 'touchstart', 300)
  await touch(prose, 'touchmove', 140)
  await expect(page.getByTestId('code-mobile-unread-preview')).toHaveCount(0)
  await touch(prose, 'touchend', 140)
  await page.evaluate(() => window.getSelection()?.removeAllRanges())

  // A real Chromium touch stream also exercises browser gesture arbitration.
  if (browserName === 'chromium') {
    const session = await page.context().newCDPSession(page)
    const box = await prose.boundingBox()
    expect(box).toBeTruthy()
    const y = box!.y + box!.height / 2
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 290, y }] })
    for (const x of [270, 240, 210, 180, 150]) {
      await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] })
    }
    await expect(page.getByTestId('code-mobile-unread-preview')).toBeVisible()
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await session.detach()
  } else {
    await touch(prose, 'touchstart', 300)
    await touch(prose, 'touchmove', 150)
    await touch(prose, 'touchend', 150)
  }
  await expect(page.locator(`[data-testid="code-agent-work-pane"][data-agent-id="${second}"]`)).toBeVisible()
  // Even a manually unread empty Chat is consumed only by its settled visible owner.
  await expect.poll(async () => {
    const inventory = await (await page.request.get('/farming/api/control/agents')).json() as { agents: Array<{ id: string; unread: boolean }> }
    return inventory.agents.find(agent => agent.id === second)?.unread
  }).toBe(false)
  await page.clock.install()
  await page.clock.runFor(6000)
  await select(source)
  await page.clock.runFor(1000)
  await expect(next).toHaveAccessibleName(/Mobile Agent 1/)
  await next.click()
  await expect(page.locator(`[data-testid="code-agent-work-pane"][data-agent-id="${third}"]`)).toBeVisible()
  // Returning via the sidebar does not consume Back. A new jump from the same
  // source must replace its lifetime, even when the previous source ID matches.
  await page.clock.runFor(2500)
  await expect(page.getByRole('button', { name: 'Go back', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Go back', exact: true }).click()
  await expect(input).toHaveText('Keep this unsent draft')
  await markUnread(third)
  await expect(next).toHaveAccessibleName(/Mobile Agent 1/)
  await next.click()
  await expect(page.locator(`[data-testid="code-agent-work-pane"][data-agent-id="${third}"]`)).toBeVisible()
  await expect(next).toHaveCount(0)
  await expect(page.getByTestId('code-mobile-unread-nav')).toHaveCount(0, { timeout: 10_000 })
  await page.screenshot({ path: testInfo.outputPath('unread-empty.png') })
  await markUnread(second)
  await expect(next).toContainText('1')
  await page.screenshot({ path: testInfo.outputPath('unread-new-arrival.png') })
})
