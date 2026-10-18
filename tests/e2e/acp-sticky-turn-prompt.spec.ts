import fs from 'node:fs'
import path from 'node:path'
import { expect, openFarming, test } from './fixtures'

for (const appearance of ['light', 'dark', 'paper'] as const) {
  test(`pushes earlier turns above viewport on send, pins sticky turn prompt when scrolled past header, and toggles off in Settings (${appearance})`, async ({ page, workspaceRoot }, testInfo) => {
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

    // 1. Sending a second turn in an active conversation smoothly pushes the first turn
    //    above the viewport and glides the newly sent turn to the top of the viewport.
    stage = 'two-short-turns'
    await page.getByTestId('code-acp-composer-input').fill('Second turn prompt: summarize all verification gates and scroll behavior across long responses.')
    await page.getByTestId('code-acp-composer-send').click()
    await expect(scroll.getByText('Second turn short answer.', { exact: true })).toBeVisible()

    await expect.poll(async () => scroll.evaluate(element => {
      const scrollerRect = element.getBoundingClientRect()
      const turns = element.querySelectorAll<HTMLElement>('[data-turn-id]')
      if (turns.length < 2) return null
      const firstRect = turns[0]!.getBoundingClientRect()
      const secondRect = turns[1]!.getBoundingClientRect()
      return {
        firstAboveViewport: firstRect.bottom <= scrollerRect.top,
        secondNearTop: secondRect.top >= scrollerRect.top && secondRect.top <= scrollerRect.top + 28,
      }
    })).toEqual({
      firstAboveViewport: true,
      secondNearTop: true,
    })
    // Since the second turn's inline user prompt is visible at the top, sticky bar is hidden.
    await expect(stickyTurn).toHaveCount(0)

    // 2. When the latest turn becomes long and auto-scrolls to the bottom, its inline user prompt
    //    scrolls above the viewport and the sticky turn prompt bar pins the summary at the top.
    stage = 'long-latest-turn'
    await page.getByRole('button', { name: 'Allow', exact: true }).click()
    await expect(scroll.getByText('Second turn detailed paragraph 42.', { exact: true })).toBeVisible()
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
