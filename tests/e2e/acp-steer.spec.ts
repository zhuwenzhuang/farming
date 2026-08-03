import fs from 'node:fs'
import path from 'node:path'
import { expect, openFarming, test } from './fixtures'

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
  await page.getByTestId('code-acp-composer-send').click()
  await expect(page.getByTestId('code-acp-composer-send')).toHaveAttribute('data-action', 'interrupt')
  const liveProcessSummary = page.getByTestId('code-agent-transcript-process-summary')
  await expect(liveProcessSummary).toContainText(/Working for \d+s/, { timeout: 3_000 })
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
  const latestSteerActivity = page.getByTestId('code-agent-transcript-latest-steer-activity')
  await expect(latestSteerActivity).toBeVisible()
  await expect(latestSteerActivity.getByTestId('code-agent-transcript-live-activity-icon')).toHaveAttribute('data-kind', 'processing')
  await expect(liveProcessSummary.getByTestId('code-agent-transcript-live-activity-icon')).toHaveCount(0)
  await expect(latestSteerActivity).toHaveCSS('font-size', '14px')
  await expect(latestSteerActivity).toHaveCSS('line-height', '20px')
  expect(await latestSteerActivity.evaluate(element => {
    const previous = element.previousElementSibling
    return !previous || element.getBoundingClientRect().top >= previous.getBoundingClientRect().bottom
  })).toBe(true)
  await expect.poll(() => latestSteerActivity.evaluate(element => (
    getComputedStyle(element, '::after').animationName
  ))).toBe('code-agent-transcript-latest-activity-sweep')
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
      latestActivityAfterProcess: element.querySelector('.code-agent-transcript-process + [data-testid="code-agent-transcript-latest-steer-activity"]') !== null,
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
  await expect(page.getByTestId('code-agent-transcript-latest-steer-activity')).toHaveCount(0)
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
