import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { expect, openFarming, test } from './fixtures'

test('renders intermediate commentary promptly during a dense live stream', {
  tag: ['@critical-behavior', '@behavior-CODE-LIVE-COMMENTARY-FEEDBACK'],
}, async ({ page, workspaceRoot }) => {
  const workspace = path.join(workspaceRoot, 'codex-acp-live-commentary')
  fs.mkdirSync(workspace, { recursive: true })
  const response = await page.request.post('/farming/api/control/agents', {
    data: { command: 'codex', workspace, agentRuntimeMode: 'chat' },
  })
  expect(response.ok()).toBeTruthy()
  const { agentId } = await response.json() as { agentId: string }

  await page.route(new RegExp(`/farming/api/agents/${agentId}/acp-transcript(?:\\?.*)?$`), async route => {
    await new Promise(resolve => setTimeout(resolve, 180))
    await route.continue()
  })
  await openFarming(page)
  await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
  await expect(page.locator('.code-agent-transcript-blank')).toHaveText('No conversation yet.')

  const input = page.getByTestId('code-acp-composer-input')
  await input.fill('live commentary stream')
  const submittedAt = Date.now()
  await page.getByTestId('code-acp-composer-send').click()

  const firstCommentary = page.getByText('Live commentary 1: checking the current implementation.', { exact: true })
  await expect(firstCommentary).toBeVisible({ timeout: 5_000 })
  const commentaryLatencyMs = Date.now() - submittedAt
  test.info().annotations.push({
    type: 'performance-budget',
    description: `First live commentary rendered in ${commentaryLatencyMs}ms`,
  })
  expect(commentaryLatencyMs).toBeLessThan(1_300)
  await expect(page.getByText('Live commentary stream complete.', { exact: true })).toHaveCount(0)
  const firstProgress = firstCommentary.locator('xpath=ancestor::*[@data-testid="code-acp-progress-update"]')
  await expect(firstProgress).toHaveCSS('animation-name', 'code-acp-progress-fill')
  expect(Number.parseFloat(await firstProgress.evaluate(element => getComputedStyle(element).animationDuration)) * 1_000).toBeLessThanOrEqual(520)
  const processingActivity = page.getByTestId('code-agent-transcript-live-activity')
  await expect(processingActivity.getByTestId('code-agent-transcript-live-activity-icon')).toHaveAttribute('data-kind', 'processing')
  await expect.poll(() => processingActivity.locator(':scope > span:not(.code-agent-transcript-live-activity-icon)').evaluate(element => (
    getComputedStyle(element).animationName
  ))).toBe('none')

  await expect.poll(() => page.getByTestId('code-acp-progress-update').count(), { timeout: 1_000 })
    .toBeGreaterThanOrEqual(5)
  await expect(page.getByText('Live commentary stream complete.', { exact: true })).toHaveCount(0)
  await expect(page.getByText('Live commentary stream complete.', { exact: true })).toBeVisible({ timeout: 5_000 })
})

test('sends the first Codex Chat message as a Prompt while the Session is connecting', async ({ page, workspaceRoot }) => {
  const workspace = path.join(workspaceRoot, 'codex-acp-first-prompt')
  fs.mkdirSync(workspace, { recursive: true })
  const displayFixture = path.join(workspace, 'display-fixture.txt')
  fs.writeFileSync(displayFixture, 'before\n')
  execFileSync('git', ['init', '-q'], { cwd: workspace })
  execFileSync('git', ['config', 'user.email', 'farming@example.test'], { cwd: workspace })
  execFileSync('git', ['config', 'user.name', 'Farming Test'], { cwd: workspace })
  execFileSync('git', ['add', 'display-fixture.txt'], { cwd: workspace })
  execFileSync('git', ['commit', '-qm', 'seed fixture'], { cwd: workspace })
  fs.writeFileSync(displayFixture, 'after\n')

  const settingsResponse = await page.request.post('/farming/api/settings', {
    data: { composerFollowUpBehavior: 'steer' },
  })
  expect(settingsResponse.ok()).toBeTruthy()

  const response = await page.request.post('/farming/api/control/agents', {
    data: { command: 'codex', workspace, agentRuntimeMode: 'chat' },
  })
  expect(response.ok()).toBeTruthy()
  const { agentId } = await response.json() as { agentId: string }

  await openFarming(page)
  await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
  await expect(page.getByTestId('code-acp-composer-input')).toBeEditable()
  await page.evaluate(id => {
    const testWindow = window as typeof window & {
      __farmingAgentActivityTest?: { update: (agentId: string, patch: unknown) => void }
    }
    testWindow.__farmingAgentActivityTest?.update(id, {
      runtimeObservation: {
        kind: 'codex',
        phase: 'starting',
        confidence: 'authoritative',
        source: 'structured-runtime',
        observerVersion: 'structured-v1',
        observedAt: Date.now(),
      },
    })
  }, agentId)

  const input = page.getByTestId('code-acp-composer-input')
  await input.fill('rich timeline')
  await page.getByTestId('code-acp-composer-send').click()

  await expect(page.getByText('Rich ACP timeline complete.', { exact: true })).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText('No active Codex turn to steer', { exact: true })).toHaveCount(0)
  const commitPrompt = page.getByTestId('code-agent-transcript-review-and-commit')
  await expect(commitPrompt).toHaveText('Commit')
  const sparkle = commitPrompt.getByTestId('code-agent-transcript-review-and-commit-sparkle')
  await expect(sparkle).toBeVisible()
  await expect(sparkle.locator('path')).toHaveAttribute('d', 'M8 0c.3 4.4 3.6 7.7 8 8-4.4.3-7.7 3.6-8 8-.3-4.4-3.6-7.7-8-8 4.4-.3 7.7-3.6 8-8Z')
  await expect(sparkle).toHaveCSS('opacity', '0.44')
  const reviewPrompt = commitPrompt.locator('xpath=preceding-sibling::button[1]')
  const [commitBox, reviewBox, sparkleBox] = await Promise.all([
    commitPrompt.boundingBox(),
    reviewPrompt.boundingBox(),
    sparkle.boundingBox(),
  ])
  expect(commitBox).not.toBeNull()
  expect(reviewBox).not.toBeNull()
  expect(sparkleBox).not.toBeNull()
  expect(Math.abs((commitBox?.y || 0) + (commitBox?.height || 0) - ((reviewBox?.y || 0) + (reviewBox?.height || 0)))).toBeLessThanOrEqual(1)
  expect((sparkleBox?.x || 0)).toBeGreaterThan((commitBox?.x || 0) + 30)
  const commitSubmittedAt = Date.now()
  await commitPrompt.click()
  await expect(input).toHaveValue('')
  await expect(page.locator('.code-agent-transcript-user').getByText('commit', { exact: true })).toBeVisible({ timeout: 15_000 })
  const commitConfirmationMs = Date.now() - commitSubmittedAt
  console.log(`performance-commit-send confirmation-ms=${commitConfirmationMs}`)
  test.info().annotations.push({
    type: 'performance-budget',
    description: `Commit send confirmed in ${commitConfirmationMs}ms`,
  })
  expect(commitConfirmationMs).toBeLessThan(15_000)
  const permission = page.getByTestId('code-acp-permission-request')
  await expect(permission).toBeVisible({ timeout: 15_000 })
  await permission.getByRole('button', { name: /Approve|Allow/ }).click()
  await expect(page.getByText('ACP reply', { exact: true })).toBeVisible({ timeout: 15_000 })

  execFileSync('git', ['add', 'display-fixture.txt'], { cwd: workspace })
  execFileSync('git', ['commit', '-qm', 'commit fixture change'], { cwd: workspace })
  fs.writeFileSync(path.join(workspace, 'unrelated.txt'), 'still uncommitted\n')
  await page.reload()
  await expect(page.getByText('Rich ACP timeline complete.', { exact: true })).toBeVisible({ timeout: 20_000 })
  await expect(commitPrompt).toHaveCount(0)
})

test('blocks ACP submission when an image upload fails', async ({ page, workspaceRoot }) => {
  const workspace = path.join(workspaceRoot, 'codex-acp-failed-upload')
  fs.mkdirSync(workspace, { recursive: true })
  const imagePath = path.join(workspace, 'failed.png')
  fs.writeFileSync(
    imagePath,
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=', 'base64'),
  )

  const response = await page.request.post('/farming/api/control/agents', {
    data: { command: 'codex', workspace, agentRuntimeMode: 'chat' },
  })
  expect(response.ok()).toBeTruthy()
  const { agentId } = await response.json() as { agentId: string }

  await page.route('**/farming/api/attachments/image', route => route.fulfill({
    status: 500,
    contentType: 'application/json',
    body: JSON.stringify({ error: 'simulated upload failure' }),
  }))
  await openFarming(page)
  await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()

  const input = page.getByTestId('code-acp-composer-input')
  const send = page.getByTestId('code-acp-composer-send')
  await input.fill('this draft must remain editable')
  await page.getByTestId('code-acp-composer-file-input').setInputFiles(imagePath)

  const attachment = page.getByTestId('code-composer-attachment')
  await expect(attachment).toHaveClass(/error/)
  await expect(attachment).toContainText('Upload failed')
  await expect(send).toBeDisabled()
  await expect(send).toHaveAttribute('data-action', 'disabled')
  await input.press('Enter')
  await expect(input).toHaveValue('this draft must remain editable')

  await attachment.getByRole('button', { name: 'Remove failed.png' }).click()
  await expect(send).toBeEnabled()
  await expect(send).toHaveAttribute('data-action', 'send')
})

test('queues a follow-up and explicitly sends negotiated Codex ACP steer', async ({ page, workspaceRoot }) => {
  const sessionRevisionMessages: Array<{ agentId?: string; revision?: number }> = []
  page.on('websocket', socket => {
    if (!/\/farming\/ws(?:\?|$)/.test(socket.url())) return
    socket.on('framereceived', event => {
      if (typeof event.payload !== 'string') return
      try {
        const message = JSON.parse(event.payload) as {
          type?: string
          session?: { agentId?: string; revision?: number }
        }
        if (message.type === 'acp-session-revision' && message.session) {
          sessionRevisionMessages.push(message.session)
        }
      } catch {
        // Ignore non-JSON frames owned by other websocket protocols.
      }
    })
  })
  const workspace = path.join(workspaceRoot, 'codex-acp-steer')
  fs.mkdirSync(workspace, { recursive: true })
  const imagePath = path.join(workspace, 'steer.png')
  fs.writeFileSync(
    imagePath,
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=', 'base64'),
  )

  const response = await page.request.post('/farming/api/control/agents', {
    data: { command: 'codex', workspace, agentRuntimeMode: 'chat' },
  })
  expect(response.ok()).toBeTruthy()
  const { agentId } = await response.json() as { agentId: string }

  await openFarming(page)
  await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
  await expect.poll(async () => {
    const state = await page.request.get('/farming/api/control/agents')
    const body = await state.json() as {
      agents?: Array<{ id?: string; providerCapabilities?: { supportsSteer?: boolean } }>
    }
    return body.agents?.find(agent => agent.id === agentId)?.providerCapabilities?.supportsSteer
  }).toBe(true)

  const input = page.getByTestId('code-acp-composer-input')
  await input.fill('unsent ACP draft survives reload')
  await page.reload()
  await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
  await expect(input).toHaveValue('unsent ACP draft survives reload')
  await input.fill('hold for steer without user echo with post-steer commentary')
  const interruptButton = page.getByTestId('code-acp-composer-send')
  for (const appearance of ['light', 'dark', 'paper'] as const) {
    await page.locator('body').evaluate((body, nextAppearance) => {
      body.setAttribute('data-appearance', nextAppearance)
    }, appearance)
    await expect.poll(async () => interruptButton.evaluate(element => {
      const bodyStyle = getComputedStyle(document.body)
      const resolveColor = (value: string) => {
        const probe = document.createElement('span')
        probe.style.color = value
        document.body.append(probe)
        const resolved = getComputedStyle(probe).color
        probe.remove()
        return resolved
      }
      const style = getComputedStyle(element)
      return {
        backgroundMatches: style.backgroundColor === resolveColor(bodyStyle.getPropertyValue('--code-emphasis')),
        colorMatches: style.color === resolveColor(bodyStyle.getPropertyValue('--code-text-on-emphasis')),
      }
    })).toEqual({ backgroundMatches: true, colorMatches: true })
  }
  await interruptButton.click()
  await expect(interruptButton).toHaveAttribute('data-action', 'interrupt')
  await page.mouse.move(0, 0)
  for (const appearance of ['light', 'dark', 'paper'] as const) {
    await page.locator('body').evaluate((body, nextAppearance) => {
      body.setAttribute('data-appearance', nextAppearance)
    }, appearance)
    await expect.poll(async () => interruptButton.evaluate(element => {
      const bodyStyle = getComputedStyle(document.body)
      const resolveColor = (value: string) => {
        const probe = document.createElement('span')
        probe.style.color = value
        document.body.append(probe)
        const resolved = getComputedStyle(probe).color
        probe.remove()
        return resolved
      }
      const style = getComputedStyle(element)
      const stopIcon = element.querySelector<HTMLElement>('.code-composer-stop-icon')
      const expectedBackgroundRole = bodyStyle.colorScheme === 'dark'
        ? '--code-danger'
        : '--code-emphasis'
      return {
        backgroundMatches: style.backgroundColor === resolveColor(bodyStyle.getPropertyValue(expectedBackgroundRole)),
        colorMatches: style.color === resolveColor(bodyStyle.getPropertyValue('--code-text-on-emphasis')),
        stopIconMatches: stopIcon
          ? getComputedStyle(stopIcon).backgroundColor === resolveColor(bodyStyle.getPropertyValue('--code-text-on-emphasis'))
          : false,
      }
    })).toEqual({ backgroundMatches: true, colorMatches: true, stopIconMatches: true })
  }
  const liveProcessSummary = page.getByTestId('code-agent-transcript-process-summary')
  await expect(liveProcessSummary).toContainText(/Working for \d+s/, { timeout: 3_000 })
  await expect(page.getByText('Waiting for steering.', { exact: true })).toBeVisible({ timeout: 3_000 })
  const initialWorkingLabel = await liveProcessSummary.textContent()
  await expect.poll(() => liveProcessSummary.textContent(), { timeout: 3_000 }).not.toBe(initialWorkingLabel)

  await page.getByTestId('code-acp-composer-file-input').setInputFiles(imagePath)
  await expect(page.getByTestId('code-composer-attachment')).toHaveClass(/ready/)
  await input.fill('focus on the attached image')
  await page.getByTestId('code-acp-composer-send').click()
  await expect(input).toHaveValue('')
  await expect(page.getByTestId('code-acp-pending-followup-row')).toHaveCount(1)
  await expect(page.getByTestId('code-acp-pending-followup-row')).toContainText('focus on the attached image')
  await expect(page.getByTestId('code-agent-transcript-steer')).toHaveCount(0)
  await page.reload()
  await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
  await expect(page.getByTestId('code-acp-pending-followup-row')).toContainText('focus on the attached image')
  await expect(page.getByTestId('code-composer-attachment')).toHaveCount(0)
  await page.getByTestId('code-acp-pending-followup-edit').click()
  await expect(page.getByTestId('code-acp-pending-followup-row')).toHaveCount(0)
  await expect(input).toHaveValue('focus on the attached image')
  await expect(page.getByTestId('code-composer-attachment')).toHaveCount(1)
  await input.fill('focus on the attached image after editing')
  await page.getByTestId('code-acp-composer-send').click()
  await expect(input).toHaveValue('')
  await expect(page.getByTestId('code-acp-pending-followup-row')).toContainText('focus on the attached image after editing')
  await page.getByTestId('code-acp-pending-followup-steer').click()
  await expect(page.getByTestId('code-acp-pending-followup-row')).toHaveCount(0)

  const steer = page.getByTestId('code-agent-transcript-steer')
  await expect(steer).toContainText('focus on the attached image after editing')
  await expect(steer.getByTestId('code-agent-transcript-steer-label')).toHaveText('Steer')
  await expect(page.locator('.code-agent-transcript-turn > .code-agent-transcript-user').getByTestId('code-agent-transcript-steer-label')).toHaveCount(0)
  await expect(steer.getByTestId('code-agent-transcript-user-images').locator('img')).toHaveCount(1)
  const steerTime = steer.getByTestId('code-agent-transcript-steer-time')
  await expect(steerTime).toHaveCount(1)
  await expect(steerTime).toHaveCSS('opacity', '0')
  await steer.locator('.code-agent-transcript-steer-bubble').hover()
  await expect(steerTime).toHaveCSS('opacity', '1')
  expect(await steer.getByTestId('code-agent-transcript-steer-meta').evaluate(element => {
    const labelRect = element.querySelector('[data-testid="code-agent-transcript-steer-label"]')?.getBoundingClientRect()
    const timeRect = element.querySelector('[data-testid="code-agent-transcript-steer-time"]')?.getBoundingClientRect()
    if (!labelRect || !timeRect) return false
    const labelCenter = labelRect.top + labelRect.height / 2
    const timeCenter = timeRect.top + timeRect.height / 2
    return labelRect.left < timeRect.left && Math.abs(labelCenter - timeCenter) < 1
  })).toBe(true)
  await expect(page.getByText('Steer accepted: focus on the attached image after editing', { exact: true })).toBeVisible()
  const liveActivity = page.getByTestId('code-agent-transcript-live-activity')
  await expect(liveActivity).toBeVisible()
  await expect(liveActivity).toHaveText('Planning secure session inspection')
  await expect(liveActivity.getByTestId('code-agent-transcript-live-activity-icon')).toHaveAttribute('data-kind', 'thinking')
  await expect(liveProcessSummary.getByTestId('code-agent-transcript-live-activity-icon')).toHaveCount(0)
  await expect(liveActivity).toHaveCSS('font-size', '14px')
  await expect(liveActivity).toHaveCSS('line-height', '20px')
  expect(await liveActivity.evaluate(element => {
    const previous = element.previousElementSibling
    return !previous || element.getBoundingClientRect().top >= previous.getBoundingClientRect().bottom
  })).toBe(true)
  const liveActivityText = liveActivity.locator(':scope > span:not(.code-agent-transcript-live-activity-icon)')
  await expect.poll(() => liveActivityText.evaluate(element => (
    getComputedStyle(element).animationName
  ))).toBe('code-agent-transcript-latest-activity-sweep')
  await expect.poll(() => liveActivityText.evaluate(element => (
    getComputedStyle(element).animationTimingFunction
  ))).toBe('linear')
  await expect.poll(() => liveActivityText.evaluate(element => (
    getComputedStyle(element).webkitBackgroundClip
  ))).toBe('text, text')
  await expect.poll(() => liveActivityText.evaluate(element => (
    getComputedStyle(element).backgroundRepeat
  ))).toBe('no-repeat, no-repeat')
  const readSweepMetrics = () => liveActivityText.evaluate(element => {
    const style = getComputedStyle(element)
    return {
      bandWidth: Number.parseFloat(style.getPropertyValue('--code-agent-transcript-live-activity-sweep-band-width')),
      durationSeconds: Number.parseFloat(style.animationDuration),
      width: element.getBoundingClientRect().width,
    }
  })
  const initialSweepMetrics = await readSweepMetrics()
  expect(initialSweepMetrics.durationSeconds).toBeCloseTo(
    (initialSweepMetrics.width + initialSweepMetrics.bandWidth * 2) / 130,
    2,
  )
  await liveActivityText.evaluate(element => {
    element.style.flex = '0 0 400px'
    element.style.width = '400px'
  })
  await expect.poll(async () => (await readSweepMetrics()).durationSeconds).toBeCloseTo((400 + 56 * 2) / 130, 2)
  await expect.poll(() => liveActivity.evaluate(element => (
    getComputedStyle(element, '::after').content
  ))).toBe('none')
  const processSummary = liveProcessSummary
  await expect(processSummary).toHaveAttribute('aria-expanded', 'false')
  const turn = page.locator('.code-agent-transcript-turn').filter({ hasText: 'hold for steer without user echo with post-steer commentary' })
  await expect(turn).toHaveCount(1)
  expect(await turn.evaluate(element => {
    const children = Array.from(element.children)
    const steerIndex = children.findIndex(child => child.matches('[data-testid="code-agent-transcript-steer"]'))
    const processIndex = children.findIndex(child => child.matches('.code-agent-transcript-process'))
    const answerIndex = children.findIndex(child => child.matches('.code-agent-transcript-answer'))
    const flow = Array.from(element.querySelectorAll(
      '.code-agent-transcript-process > .code-acp-progress-update, '
      + '.code-agent-transcript-process-list > .code-acp-progress-update, '
      + '.code-agent-transcript-process-list > [data-testid="code-agent-transcript-steer"]',
    )).map(child => ({
      kind: child.matches('[data-testid="code-agent-transcript-steer"]') ? 'steer' : 'commentary',
      text: child.matches('[data-testid="code-agent-transcript-steer"]')
        ? child.querySelector('.code-agent-transcript-steer-content')?.textContent?.trim() || ''
        : child.textContent?.trim() || '',
    }))
    return {
      steerIndex,
      processIndex,
      answerIndex,
      steerInsideProcess: Boolean(element.querySelector('.code-agent-transcript-process [data-testid="code-agent-transcript-steer"]')),
      latestActivityAfterProcess: element.querySelector('.code-agent-transcript-process + [data-testid="code-agent-transcript-live-activity"]') !== null,
      flow,
    }
  })).toEqual({
    steerIndex: -1,
    processIndex: 1,
    answerIndex: -1,
    steerInsideProcess: true,
    latestActivityAfterProcess: true,
    flow: [
      { kind: 'commentary', text: 'Waiting for steering.' },
      { kind: 'steer', text: 'focus on the attached image after editing' },
      { kind: 'commentary', text: 'Steer accepted: focus on the attached image after editing' },
    ],
  })
  await expect(page.locator('.code-agent-transcript-turn')).toHaveCount(1)
  await processSummary.click()
  await expect(processSummary).toHaveAttribute('aria-expanded', 'true')
  await input.focus()
  await page.keyboard.press('ArrowUp')
  await expect(input).toHaveValue('focus on the attached image after editing')
  await input.fill('')
  await expect.poll(() => page.getByTestId('code-acp-composer-send').getAttribute('data-action')).not.toBe('interrupt')

  await page.reload()
  await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
  await expect(page.getByTestId('code-agent-transcript-steer')).toHaveCount(1)
  await expect(page.getByTestId('code-agent-transcript-steer')).toContainText('focus on the attached image after editing')
  await expect(page.getByTestId('code-agent-transcript-steer-time')).toHaveCount(1)
  await expect(page.getByTestId('code-agent-transcript-live-activity')).toHaveCount(0)
  await expect(page.locator('.code-agent-transcript-turn')).toHaveCount(1)
  await processSummary.click()
  await expect(processSummary).toHaveAttribute('aria-expanded', 'true')
  expect(await turn.evaluate(element => Array.from(element.querySelectorAll(
    '.code-agent-transcript-process-list > .code-acp-progress-update, '
    + '.code-agent-transcript-process-list > [data-testid="code-agent-transcript-steer"]',
  )).map(child => child.matches('[data-testid="code-agent-transcript-steer"]')
    ? child.querySelector('.code-agent-transcript-steer-content')?.textContent?.trim() || ''
    : child.textContent?.trim() || ''))).toEqual([
    'Waiting for steering.',
    'focus on the attached image after editing',
    'Steer accepted: focus on the attached image after editing',
  ])
  expect(sessionRevisionMessages.some(message => (
    message.agentId === agentId && Number.isFinite(message.revision)
  ))).toBe(true)
})

test('keeps queued follow-ups separate and steers each selected message', async ({ page, workspaceRoot }) => {
  const workspace = path.join(workspaceRoot, 'codex-acp-consecutive-steers')
  fs.mkdirSync(workspace, { recursive: true })

  const response = await page.request.post('/farming/api/control/agents', {
    data: { command: 'codex', workspace, agentRuntimeMode: 'chat' },
  })
  expect(response.ok()).toBeTruthy()
  const { agentId } = await response.json() as { agentId: string }

  await openFarming(page)
  await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.locator('body')).toHaveClass(/code-compact-layout/)
  await expect.poll(async () => {
    const state = await page.request.get('/farming/api/control/agents')
    const body = await state.json() as {
      agents?: Array<{ id?: string; providerCapabilities?: { supportsSteer?: boolean } }>
    }
    return body.agents?.find(agent => agent.id === agentId)?.providerCapabilities?.supportsSteer
  }).toBe(true)

  const input = page.getByTestId('code-acp-composer-input')
  await input.fill('hold for two steers delayed')
  await page.getByTestId('code-acp-composer-send').click()
  await expect(page.getByTestId('code-acp-composer-send')).toHaveAttribute('data-action', 'interrupt')

  await input.fill('你自己先看看自己迭代到合理的展示吧。')
  await page.getByTestId('code-acp-composer-send').click()
  await expect(input).toHaveValue('')
  await expect(page.getByTestId('code-acp-pending-followup-row')).toContainText('你自己先看看自己迭代到合理的展示吧。')
  await expect(page.getByTestId('code-acp-pending-followup-queue-icon')).toBeVisible()
  const queuedGlyphPath = await page.getByTestId('code-acp-pending-followup-queue-icon').locator('path').getAttribute('d')
  const steerGlyphPath = await page.getByTestId('code-acp-pending-followup-steer').locator('path').getAttribute('d')
  expect(queuedGlyphPath).not.toBe(steerGlyphPath)
  await expect(page.getByTestId('code-acp-pending-followup-steer').locator('svg')).toBeHidden()
  await expect(page.getByTestId('code-acp-pending-followup-edit')).toBeVisible()
  expect(await page.getByTestId('code-acp-composer-stack').evaluate(stack => {
    const composer = stack.querySelector<HTMLElement>('[data-testid="code-acp-composer"]')
    const pending = stack.querySelector<HTMLElement>(':scope > [data-testid="code-acp-pending-followup"]')
    if (!composer || !pending) return null
    const composerRect = composer.getBoundingClientRect()
    const pendingRect = pending.getBoundingClientRect()
    const rowRect = pending.querySelector('[data-testid="code-acp-pending-followup-row"]')?.getBoundingClientRect()
    const actionsRect = pending.querySelector('.code-pending-followup-actions')?.getBoundingClientRect()
    const inputRect = composer.querySelector('textarea')?.getBoundingClientRect()
    const toolbarRect = composer.querySelector('[data-testid="code-acp-composer-toolbar"]')?.getBoundingClientRect()
    return {
      composerOverflow: composer.scrollHeight > composer.clientHeight + 1,
      composerKeepsRestingHeight: composerRect.height >= 70 && composerRect.height <= 74,
      pendingOutsideComposer: !composer.contains(pending),
      pendingOverlapsComposer: pendingRect.bottom - composerRect.top >= 13
        && pendingRect.bottom - composerRect.top <= 15,
      surfacesMatch: getComputedStyle(pending).backgroundColor === getComputedStyle(composer).backgroundColor,
      pendingOverflow: pending.scrollWidth > pending.clientWidth + 1
        || pending.scrollHeight > pending.clientHeight + 1,
      rowInsidePending: Boolean(rowRect
        && rowRect.left >= pendingRect.left - 1
        && rowRect.right <= pendingRect.right + 1),
      actionsInsidePending: Boolean(actionsRect
        && actionsRect.left >= pendingRect.left - 1
        && actionsRect.right <= pendingRect.right + 1),
      composerRowsDoNotOverlap: Boolean(inputRect && toolbarRect && inputRect.bottom <= toolbarRect.top + 1),
      toolbarInsideComposer: Boolean(toolbarRect && toolbarRect.bottom <= composerRect.bottom + 1),
    }
  })).toEqual({
    composerOverflow: false,
    composerKeepsRestingHeight: true,
    pendingOutsideComposer: true,
    pendingOverlapsComposer: true,
    surfacesMatch: true,
    pendingOverflow: false,
    rowInsidePending: true,
    actionsInsidePending: true,
    composerRowsDoNotOverlap: true,
    toolbarInsideComposer: true,
  })
  await input.fill('自己看看')
  await page.getByTestId('code-acp-composer-send').click()
  await expect(input).toHaveValue('')
  await expect(page.getByTestId('code-acp-pending-followup-row')).toHaveCount(2)
  await expect(page.getByTestId('code-acp-pending-followup-row').nth(0)).toContainText('你自己先看看自己迭代到合理的展示吧。')
  await expect(page.getByTestId('code-acp-pending-followup-row').nth(1)).toContainText('自己看看')
  await input.focus()
  await page.keyboard.press('ArrowUp')
  await expect(page.getByTestId('code-acp-pending-followup-row')).toHaveCount(1)
  await expect(input).toHaveValue('自己看看')
  await input.fill('自己再看看')
  await page.getByTestId('code-acp-composer-send').click()
  await expect(input).toHaveValue('')
  await expect(page.getByTestId('code-acp-pending-followup-row')).toHaveCount(2)
  await expect(page.getByTestId('code-acp-pending-followup-row').nth(1)).toContainText('自己再看看')
  await page.setViewportSize({ width: 1280, height: 720 })
  await expect(page.getByTestId('code-agent-transcript-steer')).toHaveCount(0)
  expect(await page.getByTestId('code-acp-composer-stack').evaluate(stack => {
    const composer = stack.querySelector<HTMLElement>('[data-testid="code-acp-composer"]')
    const pending = stack.querySelector<HTMLElement>(':scope > [data-testid="code-acp-pending-followup"]')
    if (!composer || !pending) return null
    const composerRect = composer.getBoundingClientRect()
    const pendingRect = pending.getBoundingClientRect()
    const pendingStyle = getComputedStyle(pending)
    return {
      pendingOverlapsComposer: pendingRect.bottom - composerRect.top >= 7
        && pendingRect.bottom - composerRect.top <= 9,
      surfacesMatch: pendingStyle.backgroundColor === getComputedStyle(composer).backgroundColor,
      bottomCornersJoinComposer: pendingStyle.borderBottomLeftRadius === '0px'
        && pendingStyle.borderBottomRightRadius === '0px',
    }
  })).toEqual({
    pendingOverlapsComposer: true,
    surfacesMatch: true,
    bottomCornersJoinComposer: true,
  })

  await page.getByTestId('code-acp-pending-followup-steer').nth(0).click()
  await page.getByTestId('code-acp-pending-followup-steer').nth(0).click()
  await expect(page.getByTestId('code-acp-pending-followup-row')).toHaveCount(0)
  await expect(page.getByTestId('code-acp-submission')).toHaveCount(2)
  await expect(page.getByTestId('code-acp-submission').nth(0)).toContainText('你自己先看看自己迭代到合理的展示吧。')
  await expect(page.getByTestId('code-acp-submission').nth(1)).toContainText('自己再看看')

  await expect(page.getByTestId('code-acp-submission')).toHaveCount(0)
  await expect(page.getByTestId('code-agent-transcript-steer')).toHaveCount(2)
  await expect(page.locator('.code-agent-transcript-steer-content')).toHaveText([
    '你自己先看看自己迭代到合理的展示吧。',
    '自己再看看',
  ])
  await expect(page.getByTestId('code-agent-transcript-steer-label')).toHaveText(['Steer', 'Steer'])

  await input.fill('live progress')
  await expect(page.getByTestId('code-acp-composer-send')).toHaveAttribute('data-action', 'send')
  await page.getByTestId('code-acp-composer-send').click()
  await expect(page.getByTestId('code-acp-composer-send')).toHaveAttribute('data-action', 'interrupt')

  await input.fill('phase-aware mermaid after the active turn')
  await page.getByTestId('code-acp-composer-send').click()
  await expect(page.getByTestId('code-acp-pending-followup-row')).toHaveCount(1)
  await expect(page.getByTestId('code-acp-pending-followup-row')).toContainText('phase-aware mermaid after the active turn')
  await expect(page.getByText('Live progress complete.', { exact: true })).toBeVisible({ timeout: 10_000 })
  await expect(page.getByTestId('code-acp-pending-followup-row')).toHaveCount(0, { timeout: 10_000 })
  const nextTurn = page.locator('.code-agent-transcript-turn').filter({ hasText: 'phase-aware mermaid after the active turn' })
  await expect(nextTurn).toContainText('Phase-aware rich answer.')
})
