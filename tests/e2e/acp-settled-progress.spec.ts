import { expect, openFarming, test } from './fixtures'

test('input and result stay visible without empty activity, including media and failures', async ({ page, workspaceRoot }) => {
  const created = await page.request.post('/farming/api/control/agents', {
    data: { command: 'codex', workspace: workspaceRoot, agentRuntimeMode: 'chat' },
  })
  const { agentId } = await created.json() as { agentId: string }
  const identity = await (await page.request.get(`/farming/api/agents/${agentId}/acp-transcript`)).json() as {
    sessionId: string; runtimeEpoch: string
  }
  const message = (id: string, role: string, text: string, meta = {}) => ({
    id, type: 'message', role, content: [{ type: 'text', text }], _meta: meta,
  })
  const start = (id: string, text: string, stop = 'end_turn') => ({
    ...message(id, 'user', text), turnCompletedAt: 200, turnStopReason: stop,
  })
  const final = { codex: { phase: 'final_answer' } }
  await page.route(new RegExp(`/api/agents/${agentId}/acp-transcript(?:\\?.*)?$`), route => route.fulfill({ json: {
    version: 1, agentId, ...identity, fromRevision: null, toRevision: 1000000, replace: true, settled: true,
    transcript: { sessionId: identity.sessionId, revision: 1000000, state: 'idle', includesLatest: true, stopReason: 'end_turn', entries: [
      start('plain', 'Return the result directly.'),
      message('plain-result', 'assistant', 'Direct result.', final),
      start('planned', 'Return the plan result.'),
      { id: 'plan', type: 'plan', plan: [{ content: 'Check the change', status: 'completed', priority: 'medium' }] },
      message('plan-result', 'assistant', 'Planned result.', final),
      start('media', 'Return an image.'),
      message('media-progress', 'assistant', 'Rendering the image.', { codex: { phase: 'commentary' } }),
      { id: 'media-result', type: 'message', role: 'assistant', _meta: final, content: [{ type: 'image', mimeType: 'image/png',
        data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf1sAAAAASUVORK5CYII=' }] },
      start('failure', 'Report a connection failure.', 'error'),
      { id: 'error', type: 'error', message: 'The connection failed.', status: 'failed' },
    ] },
  } }))
  await openFarming(page)
  await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
  const turns = page.locator('.code-agent-transcript-turn')
  await expect(turns).toHaveCount(4)
  for (const index of [0, 1, 3]) {
    await expect(turns.nth(index).getByTestId('code-agent-transcript-process-summary')).toHaveCount(0)
    await expect(turns.nth(index).locator('.code-agent-transcript-user')).toBeVisible()
  }
  await expect(turns.nth(0).locator('.code-agent-transcript-assistant')).toHaveText('Direct result.')
  await expect(turns.nth(1).locator('.code-agent-transcript-assistant')).toHaveText('Planned result.')
  const media = turns.nth(2)
  await expect(media.locator('.code-agent-transcript-answer img')).toBeVisible()
  await expect(media.getByTestId('code-acp-progress-update')).toHaveCount(0)
  await media.getByTestId('code-agent-transcript-process-summary').click()
  await expect(media.getByTestId('code-acp-progress-update')).toHaveText('Rendering the image.')
  await expect(media.locator('.code-agent-transcript-answer img')).toBeVisible()
  await expect(turns.last().getByTestId('code-agent-transcript-error')).toHaveText(/The connection failed/)
})

for (const provider of ['codex', 'claude']) {
  for (const appearance of ['light', 'dark', 'paper']) {
    test(`settled ${provider} commentary folds with evidence in ${appearance}`, async ({ page, workspaceRoot }, testInfo) => {
      await page.request.post('/farming/api/settings', { data: { language: 'en', appearance } })
      const created = await page.request.post('/farming/api/control/agents', {
        data: { command: provider, workspace: workspaceRoot, agentRuntimeMode: 'chat' },
      })
      expect(created.ok()).toBeTruthy()
      const { agentId } = await created.json() as { agentId: string }
      await openFarming(page)
      await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
      await page.getByTestId('code-acp-composer-input').fill('live commentary stream')
      await page.getByTestId('code-acp-composer-send').click()
      const turn = page.locator('.code-agent-transcript-turn').last()
      const summary = turn.getByTestId('code-agent-transcript-process-summary')
      const progress = turn.getByTestId('code-acp-progress-update')
      await expect(progress.first()).toBeVisible()
      await expect(summary).toHaveAttribute('aria-expanded', 'false')
      await expect(turn.locator('.code-agent-transcript-assistant')).toHaveText('Live commentary stream complete.')
      await expect(progress).toHaveCount(0)
      await expect(turn.getByTestId('code-agent-transcript-process-compact-list')).toHaveCount(0)

      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 844 })
        await summary.click()
        await expect(progress).toHaveCount(18)
        expect(await progress.allTextContents()).toEqual(Array.from({ length: 18 }, (_, i) =>
          `Live commentary ${i + 1}: checking the current implementation.`))
        await summary.click()
        await expect(progress).toHaveCount(0)
        await expect(turn.locator('.code-agent-transcript-answer')).toBeVisible()
        const screenshot = await page.screenshot({ path: testInfo.outputPath(`${provider}-${appearance}-${width}.png`), animations: 'disabled' })
        expect([screenshot.readUInt32BE(16), screenshot.readUInt32BE(20)]).toEqual([width, 844])
      }
      await page.reload()
      await expect(turn.locator('.code-agent-transcript-assistant')).toHaveText('Live commentary stream complete.')
      await expect(progress).toHaveCount(0)
      await summary.click()
      await expect(progress).toHaveCount(18)
    })
  }
}

test('settled questions do not expose commentary, while missing answers and failures retain progress', async ({ page, workspaceRoot }) => {
  const created = await page.request.post('/farming/api/control/agents', {
    data: { command: 'codex', workspace: workspaceRoot, agentRuntimeMode: 'chat' },
  })
  expect(created.ok()).toBeTruthy()
  const { agentId } = await created.json() as { agentId: string }
  const identity = await (await page.request.get(`/farming/api/agents/${agentId}/acp-transcript`)).json() as {
    sessionId: string; runtimeEpoch: string
  }
  const message = (id: string, role: string, text: string, phase?: string) => ({
    id, type: 'message', role, content: [{ type: 'text', text }],
    ...(phase ? { _meta: { codex: { phase } } } : {}),
  })
  let failed = false
  await page.route(new RegExp(`/api/agents/${agentId}/acp-transcript(?:\\?.*)?$`), route => route.fulfill({ json: {
    version: 1, agentId, ...identity, fromRevision: null, toRevision: 1000000, replace: true, settled: true,
    transcript: { sessionId: identity.sessionId, revision: 1000000, state: failed ? 'error' : 'idle',
      includesLatest: true, stopReason: failed ? 'error' : 'end_turn', entries: [
        message('request', 'user', 'Inspect the analysis skill.'),
        message('before', 'assistant', 'I will locate the skill and inspect its tools.', 'commentary'),
        { ...message('steer', 'user', 'Also inspect recovery.'), _meta: { farming: { steer: true } } },
        { id: 'read', type: 'tool', title: 'Read skill definition', kind: 'read', status: 'completed' },
        { id: 'question', type: 'question', message: 'Which scope?', status: 'answered', answer: 'All scripts' },
        message('after', 'assistant', 'Found the skill; checking the two helper scripts.', 'commentary'),
        message('answer', 'assistant', 'The skill coordinates analysis and uses two helper scripts.\n\n| Script | Role |\n| --- | --- |\n| Rank | Compare runs |\n| Inspect | Compare operators |', 'final_answer'),
        message('next', 'user', 'Verify the findings.'),
        message('unfinished', 'assistant', 'Verification is still incomplete.', 'commentary'),
        ...(failed ? [{ id: 'failure', type: 'error', kind: 'network', message: 'Verification connection lost.', status: 'failed' }] : []),
      ],
    },
  } }))
  await openFarming(page)
  await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
  const turns = page.locator('.code-agent-transcript-turn')
  const completed = turns.first()
  const unfinished = turns.last()
  await expect(turns).toHaveCount(2)
  await expect(completed.getByTestId('code-acp-progress-update')).toHaveCount(0)
  await expect(completed.locator('.code-agent-transcript-steer-content')).toHaveCount(0)
  await expect(completed.getByTestId('code-acp-question-history')).toHaveCount(0)
  await expect(completed.locator('.code-agent-transcript-answer table')).toBeVisible()
  await expect(unfinished.getByTestId('code-acp-progress-update')).toHaveText('Verification is still incomplete.')
  await expect(unfinished.getByTestId('code-agent-transcript-missing-final-reply')).toBeVisible()
  await completed.getByTestId('code-agent-transcript-process-summary').click()
  await expect(completed.getByTestId('code-acp-progress-update')).toHaveCount(2)
  await expect(completed.getByTestId('code-acp-question-history')).toContainText('All scripts')
  expect(await completed.locator('[data-testid="code-acp-progress-update"], .code-agent-transcript-steer-content')
    .allTextContents()).toEqual([
      'I will locate the skill and inspect its tools.',
      'Also inspect recovery.',
      'Found the skill; checking the two helper scripts.',
    ])
  failed = true
  await page.reload()
  await expect(unfinished.getByTestId('code-acp-progress-update')).toHaveText('Verification is still incomplete.')
  await expect(unfinished).toContainText('Verification connection lost.')
  await expect(unfinished.getByTestId('code-agent-transcript-process-summary')).toHaveAttribute('aria-expanded', 'false')
})

for (const appearance of ['light', 'dark', 'paper']) {
  test(`completed steering and Agent exchanges share one ordered disclosure in ${appearance}`, async ({ page, workspaceRoot }, testInfo) => {
    await page.request.post('/farming/api/settings', { data: { language: 'en', appearance } })
    const created = await page.request.post('/farming/api/control/agents', {
      data: { command: 'codex', workspace: workspaceRoot, agentRuntimeMode: 'chat' },
    })
    const { agentId } = await created.json() as { agentId: string }
    const identity = await (await page.request.get(`/farming/api/agents/${agentId}/acp-transcript`)).json() as {
      sessionId: string; runtimeEpoch: string
    }
    const message = (id: string, role: string, text: string, meta = {}) => ({
      id, type: 'message', role, content: [{ type: 'text', text }], _meta: meta,
    })
    const peer = { version: 1, direction: 'incoming', senderAddress: '/review', senderName: 'Reviewer', senderSessionId: 'review' }
    await page.route(new RegExp(`/api/agents/${agentId}/acp-transcript(?:\\?.*)?$`), route => route.fulfill({ json: {
      version: 1, agentId, ...identity, fromRevision: null, toRevision: 1000000, replace: true, settled: true,
      transcript: { sessionId: identity.sessionId, revision: 1000000, state: 'idle', includesLatest: true, stopReason: 'end_turn', entries: [
        { ...message('request', 'user', 'Check the change and report the result.'), turnStartedAt: 100, turnCompletedAt: 200, turnStopReason: 'end_turn' },
        message('progress', 'assistant', 'Inspecting the change.', { codex: { phase: 'commentary' } }),
        message('steer-one', 'user', 'Do not deploy.', { farming: { steer: true } }),
        { id: 'send', type: 'tool', title: 'sendInput', status: 'completed', _meta: { codex: { collaboration: {
          tool: 'sendInput', senderThreadId: 'parent', receiverThreadIds: ['review'], message: 'Review the change.',
        } } } },
        message('receive', 'user', 'Review passed.', { peerMessage: peer, farming: { steer: true } }),
        message('steer-two', 'user', 'Keep the report concise.', { farming: { steer: true } }),
        { id: 'read', type: 'tool', title: 'Read verification report', kind: 'read', status: 'completed' },
        message('result', 'assistant', 'Verified successfully. No deployment was performed.', { codex: { phase: 'final_answer' } }),
        { ...message('peer-task', 'user', 'Check the follow-up change.', { peerMessage: peer }), turnCompletedAt: 300, turnStopReason: 'end_turn' },
        message('peer-result', 'assistant', 'Follow-up verified.', { codex: { phase: 'final_answer' } }),
        message('peer-work', 'user', 'Check the next change.', { peerMessage: peer }),
        message('peer-progress', 'assistant', 'Checking the next change now.', { codex: { phase: 'commentary' } }),
        message('peer-steer', 'user', 'Also check the validation.', { peerMessage: peer, farming: { steer: true } }),
        message('peer-work-result', 'assistant', 'Next change verified.', { codex: { phase: 'final_answer' } }),
      ] },
    } }))
    await openFarming(page)
    await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
    const turns = page.locator('.code-agent-transcript-turn')
    const completed = turns.first()
    const summary = completed.getByTestId('code-agent-transcript-process-summary')
    await expect(turns).toHaveCount(3)
    const peerTurn = turns.nth(1)
    const peerWork = turns.last()
    await expect(peerTurn.locator('.code-agent-transcript-user')).toHaveText('Check the follow-up change.')
    await expect(peerTurn.locator('.code-agent-transcript-assistant')).toHaveText('Follow-up verified.')
    await expect(peerTurn.getByTestId('code-agent-transcript-process-summary')).toHaveCount(0)
    await expect(peerWork.locator('.code-agent-transcript-user')).toHaveText('Check the next change.')
    await expect(peerWork.locator('.code-agent-transcript-assistant')).toHaveText('Next change verified.')
    await expect(peerWork.getByTestId('code-agent-transcript-process-summary')).toContainText('1 Agent message')
    await expect(peerWork.getByTestId('code-acp-progress-update')).toHaveCount(0)
    await expect(summary).toContainText('2 steering updates')
    await expect(summary).toContainText('2 Agent messages')
    const details = completed.locator('[data-testid="code-acp-progress-update"], .code-agent-transcript-steer-content, [data-testid="code-agent-outgoing-body"], .code-agent-transcript-peer-message .code-agent-transcript-user')
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 844 })
      await expect(details).toHaveCount(0)
      await expect(completed.locator('.code-agent-transcript-assistant')).toHaveText('Verified successfully. No deployment was performed.')
      await expect(completed.getByTestId('code-agent-message-source')).toHaveCount(0)
      await summary.scrollIntoViewIfNeeded()
      await expect.poll(() => summary.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(0)
      await page.screenshot({ path: testInfo.outputPath(`minimal-${appearance}-${width}.png`), animations: 'disabled' })
      await summary.focus()
      await page.keyboard.press('Enter')
      await expect(details).toHaveCount(5)
      expect((await details.allTextContents()).map(text => text.trim())).toEqual([
        'Inspecting the change.', 'Do not deploy.', 'Review the change.', 'Review passed.', 'Keep the report concise.',
      ])
      await expect(completed.getByTestId('code-agent-message-source')).toHaveText('Reviewer')
      await expect(completed.getByTestId('code-agent-transcript-steer')).toHaveCount(2)
      await summary.click()
      await expect(summary).toHaveAttribute('aria-expanded', 'false')
      // A rotating chevron temporarily extends beyond its layout box. Finish
      // the close transition before measuring the next viewport's settled layout.
      await expect(summary.locator('.code-agent-transcript-chevron')).toHaveCSS('transform', 'none')
    }
    await peerWork.getByTestId('code-agent-transcript-process-summary').click()
    await expect(peerWork.getByTestId('code-acp-progress-update')).toHaveText('Checking the next change now.')
    await expect(peerWork.locator('.code-agent-transcript-user')).toHaveText(['Check the next change.', 'Also check the validation.'])
    await expect(peerWork.locator('.code-agent-transcript-assistant')).toHaveText('Next change verified.')
    await expect(peerTurn.getByTestId('code-agent-message-source')).toHaveText('Reviewer')
    await expect(peerTurn.locator('.code-agent-transcript-user')).toHaveText('Check the follow-up change.')
    await page.reload()
    await expect(summary).toHaveAttribute('aria-expanded', 'false')
    await expect(details).toHaveCount(0)
    await expect(completed.getByTestId('code-agent-message-source')).toHaveCount(0)
    await expect(peerTurn.getByTestId('code-agent-transcript-process-summary')).toHaveCount(0)
    await expect(peerWork.getByTestId('code-acp-progress-update')).toHaveCount(0)
    await summary.click()
    await expect(details).toHaveCount(5)
    // A saved position on the initial message must not manufacture a disclosure.
    await page.addInitScript(id => {
      const key = `farming.reading-anchor.v1:agent:${id}:chat`
      const anchor = JSON.stringify({ version: 1, surface: 'chat', resource: { kind: 'agent', id },
        locator: { kind: 'message', id: 'acp-turn-peer-task', childId: 'acp-turn-peer-task-user' },
        position: { unit: 'pixel', value: 0 } })
      localStorage.setItem(key, anchor)
      sessionStorage.setItem(key, anchor)
    }, agentId)
    await page.reload()
    await expect(peerTurn.getByTestId('code-agent-transcript-process-summary')).toHaveCount(0)
    await expect(peerTurn.getByTestId('code-agent-message-source')).toHaveText('Reviewer')
  })
}
