import fs from 'node:fs'
import path from 'node:path'
import { expect, openFarming, test } from './fixtures'

for (const appearance of ['light', 'dark', 'paper'] as const) {
  test(`keeps previous reply context on send, shrinks reading runway, and pins sticky turn prompt (${appearance})`, async ({ page, workspaceRoot }, testInfo) => {
    const workspace = path.join(workspaceRoot, `sticky-turn-${appearance}`)
    fs.mkdirSync(workspace, { recursive: true })
    const response = await page.request.post('/farming/api/control/agents', {
      data: { command: 'codex', workspace, agentRuntimeMode: 'chat' },
    })
    expect(response.ok()).toBeTruthy()
    const { agentId } = await response.json() as { agentId: string }
    const identity = await (await page.request.get(`/farming/api/agents/${agentId}/acp-transcript`)).json() as { sessionId: string; runtimeEpoch: string }

    const sampleImageUrl = `data:image/svg+xml;utf8,${encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 120 120">'
      + '<rect width="120" height="120" rx="14" fill="#ffffff"/>'
      + '<rect x="12" y="16" width="96" height="14" rx="4" fill="#e8ebe6"/>'
      + '<rect x="12" y="40" width="72" height="10" rx="3" fill="#d0d7de"/>'
      + '<rect x="12" y="58" width="84" height="10" rx="3" fill="#cf222e" fill-opacity="0.28"/>'
      + '<rect x="12" y="78" width="56" height="24" rx="6" fill="#0969da" fill-opacity="0.18"/>'
      + '</svg>',
    )}`
    let stage: 'one-short-turn' | 'two-short-turns' | 'long-latest-turn' = 'one-short-turn'
    let revision = 100
    const firstTurnEntries = [
      {
        id: 'turn-1-user',
        type: 'message',
        role: 'user',
        content: [{ type: 'image', url: sampleImageUrl }],
      },
      {
        id: 'turn-1-answer',
        type: 'message',
        role: 'assistant',
        _meta: { codex: { phase: 'final_answer' } },
        content: [{ type: 'text', text: Array.from({ length: 30 }, (_, i) => `First turn paragraph ${i + 1}.`).join('\n\n') }],
      },
    ]
    await page.route(new RegExp(`/api/agents/${agentId}/acp-transcript(?:\\?.*)?$`), async route => {
      revision += 1
      const entries = stage === 'one-short-turn'
        ? firstTurnEntries
        : stage === 'two-short-turns'
          ? [
              ...firstTurnEntries,
              {
                id: 'turn-2-user',
                type: 'message',
                role: 'user',
                content: [{ type: 'text', text: 'Second turn prompt: summarize all verification gates and scroll behavior across long responses.' }],
              },
              {
                id: 'turn-2-answer',
                type: 'message',
                role: 'assistant',
                content: [{ type: 'text', text: 'Second turn short answer.' }],
              },
            ]
          : [
              ...firstTurnEntries,
              {
                id: 'turn-2-user',
                type: 'message',
                role: 'user',
                content: [{ type: 'text', text: 'Second turn prompt: summarize all verification gates and scroll behavior across long responses.' }],
              },
              {
                id: 'turn-2-answer',
                type: 'message',
                role: 'assistant',
                _meta: { codex: { phase: 'final_answer' } },
                content: [{ type: 'text', text: Array.from({ length: 42 }, (_, i) => `Second turn detailed paragraph ${i + 1}.`).join('\n\n') }],
              },
            ]
      await route.fulfill({
        json: {
          version: 1,
          agentId,
          sessionId: identity.sessionId,
          runtimeEpoch: identity.runtimeEpoch,
          fromRevision: null,
          toRevision: revision,
          replace: true,
          settled: true,
          hasMoreBefore: false,
          transcript: {
            sessionId: identity.sessionId,
            revision,
            state: stage === 'two-short-turns' ? 'working' : 'idle',
            entries,
          },
        },
      })
    })

    await page.request.post('/farming/api/settings', {
      data: { appearance, stickyTurnPromptEnabled: true },
    })
    await page.setViewportSize({ width: 1280, height: 760 })
    await openFarming(page)
    await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()

    const scroll = page.getByTestId('code-agent-transcript-scroll')
    const stickyTurn = page.getByTestId('code-agent-transcript-sticky-turn')
    await expect(scroll.getByText('First turn paragraph 30.', { exact: true })).toBeVisible()

    // A send gives the latest turn room while keeping the previous reply tail.
    stage = 'two-short-turns'
    await page.getByTestId('code-acp-composer-input').fill('Second turn prompt: summarize all verification gates and scroll behavior across long responses.')
    await page.getByTestId('code-acp-composer-send').click()
    await expect(scroll.getByText('Second turn short answer.', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Allow', exact: true })).toBeVisible()
    await expect.poll(() => scroll.evaluate(element => Array.from(element.children)
      .some(child => child.getAnimations().some(animation => animation.playState === 'running')))).toBe(false)

    await expect.poll(async () => scroll.evaluate(element => {
      const scrollerRect = element.getBoundingClientRect()
      const turns = element.querySelectorAll<HTMLElement>('[data-turn-id]')
      if (turns.length < 2) return null
      const firstRect = turns[0]!.getBoundingClientRect()
      const secondRect = turns[1]!.getBoundingClientRect()
      return {
        previousTailVisible: firstRect.bottom > scrollerRect.top + 90 && firstRect.bottom < scrollerRect.top + 210,
        secondNearTop: secondRect.top > scrollerRect.top + 120 && secondRect.top < scrollerRect.top + 240,
      }
    })).toEqual({
      previousTailVisible: true,
      secondNearTop: true,
    })
    await expect(scroll.getByText('First turn paragraph 30.', { exact: true })).toBeInViewport()
    // The previous reply tail still owns the sticky context until it leaves.
    await expect(stickyTurn.getByTestId('code-agent-transcript-sticky-turn-images').locator('img')).toHaveCount(1)
    const previousTailClearance = async () => {
      const tailTop = await scroll.getByText('First turn paragraph 30.', { exact: true })
        .evaluate(element => element.getBoundingClientRect().top)
      const stickyBottom = await stickyTurn.evaluate(element => element.getBoundingClientRect().bottom)
      return tailTop - stickyBottom
    }
    await expect.poll(previousTailClearance).toBeGreaterThan(2)
    await page.screenshot({ path: testInfo.outputPath(`sent-runway-${appearance}.png`), animations: 'disabled', caret: 'hide' })
    await page.setViewportSize({ width: 390, height: 844 })
    await expect.poll(previousTailClearance).toBeGreaterThan(2)
    await expect(scroll.getByText('Second turn short answer.', { exact: true })).toBeInViewport()
    await page.screenshot({ path: testInfo.outputPath(`sent-runway-compact-${appearance}.png`), animations: 'disabled', caret: 'hide' })
    await page.setViewportSize({ width: 1280, height: 760 })
    await expect.poll(previousTailClearance).toBeGreaterThan(2)

    const latest = scroll.locator('.code-agent-transcript-turn').last()
    const height = () => latest.evaluate(element => element.getBoundingClientRect().height)
    const sentHeight = await height()
    const jump = page.getByTestId('code-agent-transcript-jump-bottom')
    const topBeforeScroll = await latest.evaluate(element => element.getBoundingClientRect().top)
    await scroll.hover()
    await page.mouse.wheel(0, -80)
    await expect.poll(height).toBeLessThan(sentHeight - 50)
    await expect.poll(() => latest.evaluate(element => element.getBoundingClientRect().top)).toBeGreaterThan(topBeforeScroll + 50)
    await expect(jump).toHaveCount(0)
    const readingTop = await latest.evaluate(element => element.getBoundingClientRect().top)
    // Layout changes cannot restore the consumed empty space or move the reader.
    await page.setViewportSize({ width: 1280, height: 740 })
    await expect.poll(async () => Math.abs(await latest.evaluate(element => element.getBoundingClientRect().top) - readingTop)).toBeLessThan(3)
    expect(await height()).toBeLessThan(sentHeight - 50)
    await page.screenshot({ path: testInfo.outputPath(`reading-runway-${appearance}.png`), animations: 'disabled', caret: 'hide' })

    const otherResponse = await page.request.post('/farming/api/control/agents', {
      data: { command: 'codex', workspace: workspaceRoot, agentRuntimeMode: 'chat' },
    })
    expect(otherResponse.ok()).toBeTruthy()
    const { agentId: otherAgentId } = await otherResponse.json() as { agentId: string }
    await page.locator(`[data-testid="code-agent-row"][data-agent-id="${otherAgentId}"]`).click()
    await expect(scroll).toHaveCount(0)
    await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
    await expect(scroll.getByText('Second turn short answer.', { exact: true })).toBeInViewport()
    await expect(scroll.locator('.turn-focus-runway')).toHaveCount(0)
    expect(await height()).toBeLessThan(sentHeight - 100)
    await expect(jump).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath(`reentered-chat-${appearance}.png`), animations: 'disabled', caret: 'hide' })
    await page.reload()
    await expect(scroll.getByText('Second turn short answer.', { exact: true })).toBeInViewport()
    await expect(scroll.locator('.turn-focus-runway')).toHaveCount(0)
    await expect(jump).toHaveCount(0)
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(scroll.getByText('Second turn short answer.', { exact: true })).toBeInViewport()
    await expect(scroll.locator('.turn-focus-runway')).toHaveCount(0)
    await expect(jump).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath(`reentered-chat-compact-${appearance}.png`), animations: 'disabled', caret: 'hide' })
    await page.setViewportSize({ width: 1280, height: 740 })
    await scroll.hover()
    await page.mouse.wheel(0, -160)
    await expect(jump).toBeVisible()
    const beforeGrowthTop = await latest.evaluate(element => element.getBoundingClientRect().top)

    // Growth below a paused reader reveals the jump action. Explicit catch-up
    // resumes following and pins the latest turn's context at the top.
    stage = 'long-latest-turn'
    await page.getByRole('button', { name: 'Allow', exact: true }).click()
    await expect(scroll.getByText('Second turn detailed paragraph 42.', { exact: true })).toBeAttached()
    await expect(jump).toBeVisible()
    await expect.poll(async () => Math.abs(await latest.evaluate(element => element.getBoundingClientRect().top) - beforeGrowthTop)).toBeLessThan(3)
    await jump.click()
    await expect(scroll.getByText('Second turn detailed paragraph 42.', { exact: true })).toBeInViewport()
    await expect(stickyTurn).toBeVisible()
    await expect(stickyTurn).toContainText('Second turn prompt: summarize all verification gates and scroll behavior across long responses.')

    const screenshotPath = testInfo.outputPath(`sticky-turn-prompt-${appearance}.png`)
    await page.screenshot({ path: screenshotPath, animations: 'disabled', caret: 'hide' })
    await testInfo.attach(`sticky-turn-prompt-${appearance}`, { path: screenshotPath, contentType: 'image/png' })

    // 3. Clicking the sticky turn prompt bar jumps to the start of that turn and hides the sticky bar.
    await stickyTurn.click()
    await expect(stickyTurn).toHaveCount(0)
    await expect.poll(async () => scroll.evaluate(element => {
      const scrollerRect = element.getBoundingClientRect()
      const turns = element.querySelectorAll<HTMLElement>('[data-turn-id]')
      const secondRect = turns[1]!.getBoundingClientRect()
      return secondRect.top >= scrollerRect.top && secondRect.top <= scrollerRect.top + 28
    })).toBe(true)

    // 4. Scrolling up into the first turn (image-only prompt) pins the image thumbnail in the sticky bar.
    await scroll.evaluate(element => {
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }))
      const firstTurn = element.querySelector<HTMLElement>('[data-turn-id]')!
      const scrollerRect = element.getBoundingClientRect()
      const firstRect = firstTurn.getBoundingClientRect()
      element.scrollTop = Math.max(0, element.scrollTop + (firstRect.top - scrollerRect.top) + 260)
    })
    await expect(stickyTurn).toBeVisible()
    await expect(stickyTurn.getByTestId('code-agent-transcript-sticky-turn-images').locator('img')).toHaveCount(1)

    const imageScreenshotPath = testInfo.outputPath(`sticky-turn-image-${appearance}.png`)
    await page.screenshot({ path: imageScreenshotPath, animations: 'disabled', caret: 'hide' })
    await testInfo.attach(`sticky-turn-image-${appearance}`, { path: imageScreenshotPath, contentType: 'image/png' })

    // 5. Toggling off Sticky turn prompt in Settings -> Interface disables the sticky bar and runway.
    if (appearance === 'light') {
      await page.getByTestId('code-sidebar-options').click()
      const settingsPanel = page.getByTestId('code-settings-panel')
      await expect(settingsPanel).toBeVisible()
      const row = settingsPanel.getByTestId('code-settings-sticky-turn-prompt')
      await expect(row).toBeVisible()
      const toggle = row.getByRole('switch')
      await expect(toggle).toHaveAttribute('aria-checked', 'true')
      await toggle.click()
      await expect(toggle).toHaveAttribute('aria-checked', 'false')
      await expect.poll(async () => {
        const res = await page.request.get('/farming/api/settings')
        const body = await res.json() as { settings?: { stickyTurnPromptEnabled?: boolean } }
        return body.settings?.stickyTurnPromptEnabled
      }).toBe(false)
      await settingsPanel.getByRole('button', { name: 'Close' }).click()
      await expect(stickyTurn).toHaveCount(0)
      await expect(page.locator('.code-agent-transcript-turn.turn-focus-runway')).toHaveCount(0)
    }
  })
}
