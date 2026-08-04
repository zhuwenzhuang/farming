import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import type { Page } from '@playwright/test'
import { expect, openFarming, terminalRows, test } from './fixtures'

async function createAcpAgent(page: Page, workspace: string) {
  const response = await page.request.post('/farming/api/control/agents', {
    data: { command: 'claude', workspace, agentRuntimeMode: 'chat' },
  })
  expect(response.ok()).toBeTruthy()
  const payload = await response.json() as { agentId?: string }
  expect(payload.agentId).toBeTruthy()
  return payload.agentId as string
}

async function createCodexAcpAgent(page: Page, workspace: string) {
  const response = await page.request.post('/farming/api/control/agents', {
    data: { command: 'codex', workspace, agentRuntimeMode: 'chat' },
  })
  expect(response.ok()).toBeTruthy()
  const payload = await response.json() as { agentId?: string }
  expect(payload.agentId).toBeTruthy()
  return payload.agentId as string
}

function agentRow(page: Page, agentId: string) {
  return page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
}

async function sendAcpMessage(page: Page, text: string) {
  const input = page.getByTestId('code-acp-composer-input')
  await input.fill(text)
  await page.getByTestId('code-acp-composer-send').click()
  await expect(input).toHaveValue('')
}

test.describe('ACP human-like browser matrix', () => {
  test('renders a Codex host visualization directly inside the Chat result', async ({ page, workspaceRoot }) => {
    const workspace = path.join(workspaceRoot, 'acp-inline-visualization')
    fs.mkdirSync(workspace, { recursive: true })

    const agentId = await createCodexAcpAgent(page, workspace)
    await openFarming(page)
    await agentRow(page, agentId).click()
    await expect(page.getByTestId('code-acp-composer-input')).toBeEditable({ timeout: 20_000 })
    await sendAcpMessage(page, 'inline visualization')

    await expect(page.getByText('Inline visualization result', { exact: true })).toBeVisible({ timeout: 20_000 })
    const visualization = page.getByTestId('code-agent-transcript-inline-visualization')
    await expect(visualization).toBeVisible()
    const frame = visualization.locator('iframe').contentFrame()
    await expect(frame.getByRole('heading', { name: 'Farming visualization ready' })).toBeVisible()
    await expect(frame.locator('body')).toHaveAttribute('data-visualization-ready', 'true')
    await expect(page.getByText('farming-inline.html', { exact: true })).toHaveCount(0)
  })

  test('opens connecting Chat without waiting for ordered workspace-history saves', async ({ page }) => {
    const firstWorkspace = path.resolve('tests')
    const secondWorkspace = path.resolve('docs')

    await openFarming(page)

    let releaseFirstSave = () => {}
    let firstSaveReleased = false
    const firstSaveGate = new Promise<void>(resolve => {
      releaseFirstSave = () => {
        if (firstSaveReleased) return
        firstSaveReleased = true
        resolve()
      }
    })
    const savedWorkspaces: string[] = []
    await page.route('**/farming/api/workspaces/recent', async route => {
      const request = route.request()
      const body = request.postDataJSON() as { workspace?: string }
      savedWorkspaces.push(body.workspace || '')
      if (savedWorkspaces.length === 1) await firstSaveGate
      await route.continue()
    })

    const startChat = async (workspace: string) => {
      await page.getByTestId('code-new-agent').click()
      await expect(page.getByTestId('agent-list-status')).toBeHidden({ timeout: 30_000 })
      await page.getByTestId('agent-option-claude').click()
      const runtime = page.getByTestId('agent-runtime-mode')
      await runtime.getByRole('button', { name: /^Chat$/ }).click()
      await page.getByTestId('workspace-input').fill(workspace)
      await page.getByTestId('workspace-start').click()
      await expect(page.getByTestId('input-dialog')).toBeHidden({ timeout: 5_000 })
      await expect(page.getByTestId('code-acp-composer-input')).toBeEditable({ timeout: 5_000 })
    }

    try {
      await startChat(firstWorkspace)
      await expect.poll(() => savedWorkspaces).toEqual([firstWorkspace])

      await startChat(secondWorkspace)
      await expect.poll(() => savedWorkspaces).toEqual([firstWorkspace])

      releaseFirstSave()
      await expect.poll(() => savedWorkspaces).toEqual([firstWorkspace, secondWorkspace])
      await expect.poll(async () => {
        const response = await page.request.get('/farming/api/settings')
        const payload = await response.json() as { settings?: { workspaceHistory?: string[] } }
        return payload.settings?.workspaceHistory?.slice(0, 2) || []
      }).toEqual([secondWorkspace, firstWorkspace])
    } finally {
      releaseFirstSave()
    }
  })

  test('recovers a read-only transcript from bounded transport failures', async ({ page, workspaceRoot }) => {
    const workspace = path.join(workspaceRoot, 'acp-transcript-transport-retry')
    fs.mkdirSync(workspace, { recursive: true })

    const agentId = await createAcpAgent(page, workspace)
    const otherAgentResponse = await page.request.post('/farming/api/control/agents', {
      data: { command: 'bash', workspace },
    })
    expect(otherAgentResponse.ok()).toBeTruthy()
    const { agentId: otherAgentId } = await otherAgentResponse.json() as { agentId: string }
    let attempts = 0
    await page.route(
      new RegExp(`/farming/api/agents/${agentId}/acp-transcript(?:\\?.*)?$`),
      async route => {
        attempts += 1
        if (attempts < 4) {
          await route.abort('connectionreset')
          return
        }
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            transcript: {
              sessionId: `transport-retry-${agentId}`,
              state: 'idle',
              revision: 1,
              entries: [
                {
                  id: 'retry-user',
                  type: 'message',
                  role: 'user',
                  content: [{ type: 'text', text: 'Recover the transcript' }],
                },
                {
                  id: 'retry-answer',
                  type: 'message',
                  role: 'assistant',
                  _meta: { codex: { phase: 'final_answer' } },
                  content: [{ type: 'text', text: 'Transcript transport recovered.' }],
                },
              ],
            },
          }),
        })
      },
    )

    await openFarming(page)
    await page.evaluate(() => window.dispatchEvent(new Event('farming:backend-disconnected')))
    await agentRow(page, agentId).click()
    await expect(page.getByText('This session’s Chat history could not be loaded.', { exact: true }))
      .toBeVisible({ timeout: 10_000 })
    expect(attempts).toBe(3)

    await page.evaluate(() => window.dispatchEvent(new Event('farming:backend-connected')))
    await expect(page.getByText('Transcript transport recovered.', { exact: true })).toBeVisible({
      timeout: 10_000,
    })
    expect(attempts).toBe(4)
    await expect(page.getByText('Failed to fetch', { exact: true })).toHaveCount(0)

    await agentRow(page, otherAgentId).click()
    await expect(page.locator(
      `[data-testid="code-terminal-pane"][data-agent-id="${otherAgentId}"]`,
    )).toBeVisible()
    await agentRow(page, agentId).click()
    await expect(page.getByText('Transcript transport recovered.', { exact: true })).toBeVisible()
    await expect.poll(() => attempts, { timeout: 5_000 }).toBeGreaterThanOrEqual(5)
    await expect(page.getByText('Transcript transport recovered.', { exact: true })).toBeVisible()
    await expect(page.getByText('This session’s Chat history could not be loaded.', { exact: true }))
      .toHaveCount(0)
  })

  test('reconnects an exited ACP adapter without replaying the interrupted request', async ({ page, workspaceRoot }) => {
    const workspace = path.join(workspaceRoot, 'acp-adapter-reconnect')
    fs.mkdirSync(workspace, { recursive: true })

    const agentId = await createAcpAgent(page, workspace)
    await openFarming(page)
    await agentRow(page, agentId).click()
    await sendAcpMessage(page, 'disconnect adapter once')

    const reconnect = page.getByTestId('code-acp-reconnect')
    await expect(reconnect).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText('ACP reply', { exact: true })).toHaveCount(0)

    const reconnectResponsePromise = page.waitForResponse(response => (
      response.request().method() === 'POST'
      && response.url().includes(`/api/agents/${agentId}/acp-session/reconnect`)
    ))
    await reconnect.click()
    const reconnectResponse = await reconnectResponsePromise
    expect(reconnectResponse.ok()).toBeTruthy()
    await expect(reconnectResponse.json()).resolves.toMatchObject({ reconnected: true })
    await expect(page.getByTestId('code-acp-reconnect')).toHaveCount(0, { timeout: 15_000 })

    await sendAcpMessage(page, 'new explicit request after reconnect')
    await expect(page.getByText('ACP reconnect reply', { exact: true })).toBeVisible({ timeout: 15_000 })
    expect(fs.existsSync(path.join(workspace, '.adapter-disconnect-replayed'))).toBe(false)
  })

  test('paints the terminal checkpoint after switching from Chat', async ({ page, workspaceRoot }) => {
    const workspace = path.join(workspaceRoot, 'acp-chat-to-terminal')
    fs.mkdirSync(workspace, { recursive: true })

    const originalAgentId = await createAcpAgent(page, workspace)
    await openFarming(page)
    await agentRow(page, originalAgentId).click()
    await expect(page.getByTestId('code-agent-chat-view')).toBeVisible()

    const switchResponsePromise = page.waitForResponse((response) => {
      if (
        response.request().method() !== 'PATCH'
        || !response.url().includes(`/api/agents/${originalAgentId}`)
      ) return false
      try {
        return (response.request().postDataJSON() as { agentRuntimeMode?: string }).agentRuntimeMode === 'terminal'
      } catch {
        return false
      }
    })
    await page.getByTestId('code-terminal-mode-toggle').getByRole('button', { name: 'Terminal' }).click()
    const switchResponse = await switchResponsePromise
    const payload = await switchResponse.json() as { error?: string, restartedAgentId?: string }
    expect(switchResponse.ok(), payload.error || 'Runtime switch request failed').toBeTruthy()
    expect(payload.restartedAgentId).toBeTruthy()

    const restartedAgentId = payload.restartedAgentId as string
    await expect(page.getByTestId('code-agent-terminal-view')).toBeVisible({ timeout: 30_000 })
    await expect.poll(
      async () => (await terminalRows(page, restartedAgentId, 10)).join('\n'),
      { timeout: 30_000 },
    ).toContain('Fake Claude Code ready')
    const terminalHost = page.getByTestId('code-agent-terminal-view').locator('.terminal-session-host')
    await expect(terminalHost).toBeVisible()
    await expect(terminalHost).not.toHaveClass(/terminal-checkpoint-installing/)
    await expect.poll(async () => terminalHost.locator('.xterm').evaluate(element => {
      const bounds = element.getBoundingClientRect()
      return [getComputedStyle(element).opacity, bounds.width > 100, bounds.height > 100]
    })).toEqual(['1', true, true])
  })

  test('keeps a fresh OpenCode launch on ACP before the provider session id exists', async ({ page, workspaceRoot }) => {
    const workspace = path.join(workspaceRoot, 'opencode-acp-launch')
    fs.mkdirSync(workspace, { recursive: true })
    await page.route('**/farming/api/executables', route => route.fulfill({
      json: {
        agents: [
          { name: 'codex', command: 'codex', description: 'Codex', category: 'coding', supported: true, interactive: true },
          { name: 'opencode', command: 'opencode', description: 'OpenCode', category: 'coding', supported: true, interactive: true },
          { name: 'bash', command: 'bash', description: 'Bash', category: 'other', supported: true, interactive: true },
        ],
      },
    }))
    await openFarming(page)

    await page.getByTestId('code-new-agent').click()
    await expect(page.getByTestId('input-dialog')).toBeVisible()
    await expect(page.getByTestId('agent-list-status')).toBeHidden({ timeout: 30_000 })
    await page.getByTestId('agent-option-opencode').click()
    const runtime = page.getByTestId('agent-runtime-mode')
    await runtime.getByRole('button', { name: /^Chat/ }).click()
    await expect(runtime.getByRole('button', { name: /^Chat/ })).toHaveAttribute('aria-pressed', 'true')
    await page.getByTestId('workspace-input').fill(workspace)
    await page.getByTestId('workspace-start').click()

    await expect(page.getByTestId('input-dialog')).toBeHidden({ timeout: 30_000 })
    await expect(page.getByTestId('code-agent-chat-view')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('code-acp-composer')).toBeVisible()
    const stateResponse = await page.request.get('/farming/api/control/agents')
    const state = await stateResponse.json() as {
      agents?: Array<{
        command?: string
        runtimeBinding?: { kind?: string }
        providerSessionProvider?: string
      }>
    }
    const openCode = state.agents?.find(agent => agent.command === 'opencode')
    expect(openCode?.runtimeBinding?.kind).toBe('acp')
    expect(openCode?.providerSessionProvider).toBe('opencode')
  })

  test('keeps Chat reading content on one typography baseline', async ({ page, workspaceRoot }) => {
    const workspace = path.join(workspaceRoot, 'acp-markdown-typography')
    fs.mkdirSync(workspace, { recursive: true })

    const agentId = await createAcpAgent(page, workspace)
    await openFarming(page)
    await agentRow(page, agentId).click()
    await sendAcpMessage(page, 'markdown typography')

    const turn = page.locator('.code-agent-transcript-turn').filter({ hasText: 'Typography baseline.' })
    await expect(turn).toBeVisible({ timeout: 15_000 })
    await page.evaluate(() => {
      document.body.dataset.appearance = 'dark'
    })
    const metrics = await turn.evaluate(element => {
      const answer = element.querySelector<HTMLElement>('.code-agent-transcript-assistant.code-markdown-preview')
      const pre = answer?.querySelector<HTMLElement>('pre')
      const preCode = pre?.querySelector<HTMLElement>('code')
      const table = answer?.querySelector<HTMLElement>('table')
      const header = table?.querySelector<HTMLElement>('th')
      const quote = answer?.querySelector<HTMLElement>('blockquote')
      const inlineCode = Array.from(answer?.querySelectorAll<HTMLElement>('code') ?? [])
        .find(code => !code.closest('pre'))
      if (!answer || !pre || !preCode || !table || !header || !quote || !inlineCode) {
        throw new Error('Markdown typography fixtures are incomplete')
      }
      return {
        answerFontSize: getComputedStyle(answer).fontSize,
        answerLineHeight: getComputedStyle(answer).lineHeight,
        preFontSize: getComputedStyle(pre).fontSize,
        preLineHeight: getComputedStyle(pre).lineHeight,
        preCodeFontSize: getComputedStyle(preCode).fontSize,
        preCodePaddingLeft: getComputedStyle(preCode).paddingLeft,
        tableFontSize: getComputedStyle(table).fontSize,
        headerLineHeight: getComputedStyle(header).lineHeight,
        quoteFontSize: getComputedStyle(quote).fontSize,
        inlineCodeFontSize: Number.parseFloat(getComputedStyle(inlineCode).fontSize),
        inlineCodeColor: getComputedStyle(inlineCode).color,
        inlineCodeBackground: getComputedStyle(inlineCode).backgroundColor,
      }
    })
    expect(metrics).toMatchObject({
      answerFontSize: '14px',
      answerLineHeight: '20px',
      preFontSize: '14px',
      preLineHeight: '20px',
      preCodeFontSize: '14px',
      preCodePaddingLeft: '0px',
      tableFontSize: '14px',
      headerLineHeight: '20px',
      quoteFontSize: '14px',
      inlineCodeColor: 'rgb(255, 255, 255)',
      inlineCodeBackground: 'rgba(255, 255, 255, 0.09)',
    })
    expect(metrics.inlineCodeFontSize).toBeGreaterThanOrEqual(12)
    expect(metrics.inlineCodeFontSize).toBeLessThan(14)
  })

  test('hides an incomplete ACP plan when its Turn ends', async ({ page, workspaceRoot }) => {
    const workspace = path.join(workspaceRoot, 'acp-stale-ended-plan')
    fs.mkdirSync(workspace, { recursive: true })
    fs.writeFileSync(path.join(workspace, 'README.md'), '# Stale ended plan\n')
    fs.writeFileSync(path.join(workspace, 'display-fixture.txt'), 'before\n')

    const agentId = await createAcpAgent(page, workspace)
    await openFarming(page)
    await agentRow(page, agentId).click()
    await sendAcpMessage(page, 'rich timeline')

    const plan = page.getByTestId('code-agent-transcript-plan-driver')
    await expect(plan).toBeVisible()
    await expect(plan).toContainText('1/3')
    await expect(plan).toHaveCSS('position', 'absolute')
    await expect(plan.locator('.code-agent-transcript-plan-driver-summary > span')).toHaveCSS('font-weight', '400')
    const runningPlanStep = plan.locator('.code-agent-transcript-plan-list li.running')
    await expect(runningPlanStep).toHaveCSS('font-weight', '400')
    expect(await runningPlanStep.evaluate(element => getComputedStyle(element, '::marker').fontWeight)).toBe('400')
    expect(await page.getByTestId('code-agent-transcript-scroll').evaluate(element => {
      const style = getComputedStyle(element)
      return style.paddingRight === style.paddingLeft
    })).toBe(true)
    await expect(page.getByText('Rich ACP timeline complete.', { exact: true })).toBeVisible({ timeout: 20_000 })
    await expect(plan).toHaveCount(0)
    const processSummary = page.getByTestId('code-agent-transcript-process-summary')
    const processChevron = processSummary.locator('.code-agent-transcript-chevron')
    await processSummary.hover()
    await expect(processChevron).toHaveCSS('opacity', '0.9')
    await processSummary.click()
    await page.getByTestId('code-acp-composer').hover()
    await expect(processChevron).toHaveCSS('opacity', '0')
  })

  test('isolates transcript Markdown, tool, and turn render failures', async ({ page, workspaceRoot }) => {
    const workspace = path.join(workspaceRoot, 'acp-local-error-boundaries')
    fs.mkdirSync(workspace, { recursive: true })
    fs.writeFileSync(path.join(workspace, 'README.md'), '# Local error boundaries\n')
    fs.writeFileSync(path.join(workspace, 'display-fixture.txt'), 'before\n')

    const agentId = await createAcpAgent(page, workspace)
    await openFarming(page)
    await agentRow(page, agentId).click()
    await sendAcpMessage(page, 'rich timeline')

    const turn = page.locator('.code-agent-transcript-turn').filter({ hasText: 'rich timeline' })
    await expect(turn.getByText('Rich ACP timeline complete.', { exact: true })).toBeVisible({ timeout: 20_000 })
    const turnId = await turn.getAttribute('data-turn-id')
    expect(turnId).toBeTruthy()
    const processSummary = turn.getByTestId('code-agent-transcript-process-summary')

    await page.evaluate((fault) => {
      window.__farmingLocalRenderFaults = [fault]
    }, `transcript-markdown:${turnId}`)
    await processSummary.click()
    const markdownError = turn.getByTestId('code-agent-transcript-markdown-render-error')
    await expect(markdownError).toBeVisible()
    await expect(turn).toContainText('Rich ACP timeline complete.')
    await expect(page.getByTestId('code-acp-composer')).toBeVisible()
    await expect(page.getByTestId('app-error-fallback')).toHaveCount(0)

    await page.evaluate(() => {
      window.__farmingLocalRenderFaults = []
    })
    await markdownError.getByRole('button', { name: 'Retry' }).click()
    await expect(turn.getByText('Rich ACP timeline complete.', { exact: true })).toBeVisible()

    if (await processSummary.getAttribute('aria-expanded') !== 'true') await processSummary.click()
    const actionGroup = turn.getByTestId('code-agent-transcript-process-group').first()
    const groupToggle = actionGroup.getByTestId('code-agent-transcript-process-group-toggle')
    if (await groupToggle.getAttribute('aria-expanded') !== 'true') await groupToggle.click()
    const readItem = actionGroup.getByTestId('code-agent-transcript-process-item').filter({ hasText: 'Read ACP display fixtures' })
    await expect(readItem).toBeVisible()
    const itemId = await readItem.getAttribute('data-process-item-id')
    expect(itemId).toBeTruthy()

    await page.evaluate((fault) => {
      window.__farmingLocalRenderFaults = [fault]
    }, `transcript-tool:${itemId}`)
    await readItem.getByTestId('code-agent-transcript-process-item-toggle').click()
    const toolError = actionGroup.getByTestId('code-agent-transcript-tool-render-error')
    await expect(toolError).toBeVisible()
    await expect(turn.getByText('Rich ACP timeline complete.', { exact: true })).toBeVisible()
    await expect(page.getByTestId('app-error-fallback')).toHaveCount(0)

    await page.evaluate(() => {
      window.__farmingLocalRenderFaults = []
    })
    await toolError.getByRole('button', { name: 'Retry' }).click()
    await expect(actionGroup.getByTestId('code-agent-transcript-process-item').filter({ hasText: 'Read ACP display fixtures' })).toBeVisible()

    await page.evaluate((fault) => {
      window.__farmingLocalRenderFaults = [fault]
    }, `transcript-turn:${turnId}`)
    await processSummary.click()
    const turnError = page.getByTestId('code-agent-transcript-turn-render-error')
    await expect(turnError).toBeVisible()
    await expect(page.getByTestId('code-acp-composer')).toBeVisible()
    await expect(agentRow(page, agentId)).toBeVisible()
    await expect(page.getByTestId('app-error-fallback')).toHaveCount(0)

    await page.evaluate(() => {
      window.__farmingLocalRenderFaults = []
    })
    await turnError.getByRole('button', { name: 'Retry' }).click()
    await expect(page.locator('.code-agent-transcript-turn').filter({ hasText: 'Rich ACP timeline complete.' })).toBeVisible()
  })

  test('shows readable Codex collaboration summaries and keeps raw Process evidence secondary', async ({ page, workspaceRoot }) => {
    const workspace = path.join(workspaceRoot, 'acp-codex-collaboration')
    fs.mkdirSync(workspace, { recursive: true })

    const agentId = await createAcpAgent(page, workspace)
    await openFarming(page)
    await agentRow(page, agentId).click()
    await sendAcpMessage(page, 'codex collaboration')

    const turn = page.locator('.code-agent-transcript-turn').filter({ hasText: 'Codex collaboration example complete.' })
    await expect(turn).toBeVisible({ timeout: 15_000 })
    const parentProcessSummary = turn.getByTestId('code-agent-transcript-process-summary')
    await expect(parentProcessSummary).toHaveAttribute('aria-expanded', 'false')
    await parentProcessSummary.click()
    const timeline = turn.getByTestId('code-agent-transcript-collaboration')
    const groups = timeline.getByTestId('code-agent-transcript-collaboration-group')
    const events = timeline.getByTestId('code-agent-transcript-collaboration-event')
    await expect(groups).toHaveCount(2)
    await expect(events).toHaveCount(0)
    await expect(groups.nth(0)).toContainText('Review refresh')
    await expect(groups.nth(0)).toContainText('Goodall')
    await expect(groups.nth(0)).toContainText(/Completed|已完成/)
    await expect(groups.nth(0)).toContainText(/1 child|1 个子 Agent/)
    await expect(groups.nth(1)).toContainText('Browser guards')
    await expect(groups.nth(1)).toContainText('Feynman')
    await expect(groups.nth(1)).toContainText(/Completed|已完成/)
    await expect(groups.nth(1)).toContainText(/23 (?:events|个事件)/)
    await expect(groups.nth(0).locator('.code-agent-transcript-collaboration-agent-labels > span'))
      .toHaveCSS('font-weight', '400')
    await expect(groups.nth(0).locator('.code-agent-transcript-collaboration-agent svg')).toBeVisible()
    expect(await groups.evaluateAll(elements => (
      elements.map(element => element.getAttribute('data-agent-icon')).sort()
    ))).toEqual(['3', '4'])
    const agentIconPaths = await groups.locator('.code-agent-transcript-collaboration-agent svg').evaluateAll(
      icons => icons.map(icon => icon.querySelector('path')?.getAttribute('d')),
    )
    expect(new Set(agentIconPaths).size).toBe(2)
    await expect(timeline.locator('.code-agent-transcript-collaboration-heading svg')).toBeVisible()
    for (let index = 0; index < 2; index += 1) {
      await expect(groups.nth(index).getByTestId('code-agent-transcript-collaboration-summary'))
        .toHaveAttribute('aria-expanded', 'false')
    }
    const foldedTimelineBox = await timeline.boundingBox()
    const foldedGroupBoxes = await Promise.all([
      groups.nth(0).boundingBox(),
      groups.nth(1).boundingBox(),
    ])
    expect(foldedTimelineBox).not.toBeNull()
    expect(foldedGroupBoxes.every(Boolean)).toBe(true)
    expect(Math.abs((foldedGroupBoxes[0]?.y || 0) - (foldedGroupBoxes[1]?.y || 0))).toBeLessThan(2)
    expect((foldedGroupBoxes[0]?.width || 0) + (foldedGroupBoxes[1]?.width || 0))
      .toBeLessThan(foldedTimelineBox?.width || 0)
    await expect(groups.nth(0).locator('.code-agent-transcript-collaboration-count')).toBeHidden()
    const reviewGroup = groups.nth(0)
    const reviewSummary = reviewGroup.locator(
      ':scope > [data-testid="code-agent-transcript-collaboration-summary"]',
    )
    await reviewSummary.click()
    await expect(reviewSummary).toHaveAttribute('aria-expanded', 'true')
    await expect(reviewGroup.locator(
      ':scope > .code-agent-transcript-collaboration-summary .code-agent-transcript-collaboration-count',
    )).toBeVisible()
    expect((await reviewGroup.boundingBox())?.width || 0).toBeGreaterThan(
      (foldedGroupBoxes[0]?.width || 0) * 1.5,
    )
    await expect(groups).toHaveCount(3)
    const nestedGroup = reviewGroup.getByTestId('code-agent-transcript-collaboration-group')
      .filter({ hasText: 'Crt races' })
    await expect(nestedGroup).toHaveAttribute('data-agent-depth', '1')
    await expect(nestedGroup).toContainText(/Paused|已暂停/)
    await expect(nestedGroup.locator(
      ':scope > [data-testid="code-agent-transcript-collaboration-summary"]',
    ))
      .toHaveAttribute('aria-expanded', 'false')
    await reviewSummary.click()
    await expect(groups).toHaveCount(2)
    await expect(parentProcessSummary).toHaveAttribute('aria-expanded', 'true')
    const parentProcessList = turn.locator('.code-agent-transcript-process-list').first()
    await expect(parentProcessList.getByTestId('code-agent-transcript-process-group')).toHaveCount(1)
    await expect(parentProcessList).toContainText('Read a file')
    await expect(parentProcessList).not.toContainText('Browser guards')
    await parentProcessSummary.click()
    await expect(parentProcessSummary).toHaveAttribute('aria-expanded', 'false')
    expect((await timeline.boundingBox())?.height || 0).toBeLessThan(160)

    await page.evaluate(() => { document.body.dataset.appearance = 'light' })
    const lightVisuals = await groups.nth(0).evaluate(element => {
      const summary = element.querySelector<HTMLElement>('.code-agent-transcript-collaboration-summary')
      const icon = summary?.querySelector<SVGElement>('svg')
      if (!summary || !icon) throw new Error('Collaboration visuals are incomplete')
      return {
        rowColor: getComputedStyle(summary).color,
        cardBackground: getComputedStyle(element).backgroundColor,
        cardBorderWidth: getComputedStyle(element).borderTopWidth,
        iconColor: getComputedStyle(icon).color,
      }
    })
    await page.evaluate(() => { document.body.dataset.appearance = 'dark' })
    const darkVisuals = await groups.nth(0).evaluate(element => {
      const summary = element.querySelector<HTMLElement>('.code-agent-transcript-collaboration-summary')
      const icon = summary?.querySelector<SVGElement>('svg')
      if (!summary || !icon) throw new Error('Collaboration visuals are incomplete')
      return {
        rowColor: getComputedStyle(summary).color,
        cardBackground: getComputedStyle(element).backgroundColor,
        cardBorderWidth: getComputedStyle(element).borderTopWidth,
        iconColor: getComputedStyle(icon).color,
      }
    })
    expect(darkVisuals.rowColor).not.toBe(lightVisuals.rowColor)
    expect(lightVisuals.cardBackground).toBe('rgba(0, 0, 0, 0)')
    expect(darkVisuals.cardBackground).toBe('rgba(0, 0, 0, 0)')
    expect(lightVisuals.cardBorderWidth).toBe('0px')
    expect(darkVisuals.cardBorderWidth).toBe('0px')
    expect(lightVisuals.iconColor).not.toBe('rgb(140, 149, 159)')
    expect(darkVisuals.iconColor).not.toBe(lightVisuals.iconColor)

    const browserGroup = groups.filter({ hasText: 'Browser guards' })
    const browserSummary = browserGroup.getByTestId('code-agent-transcript-collaboration-summary')
    await browserSummary.click()
    await expect(browserSummary).toHaveAttribute('aria-expanded', 'true')
    const browserEvents = browserGroup.getByTestId('code-agent-transcript-collaboration-event')
    await expect(browserEvents).toHaveCount(6)
    await expect(browserEvents.nth(0)).toContainText(/Created|已创建/)
    await expect(browserEvents.nth(1)).toContainText(/Activity|活动记录/)
    await expect(browserEvents.nth(1)).toHaveAttribute('data-process-item-id', 'collab-browser-provider-unknown')
    await expect(browserEvents.nth(2)).toContainText(/Message sent|已发送消息/)
    await expect(browserEvents.nth(2)).toContainText(/18 (?:events|个事件)/)
    await expect(browserEvents.nth(3)).toContainText(/Failed|失败/)
    await expect(browserEvents.nth(3)).toHaveAttribute('data-process-item-id', 'collab-browser-failed-1')
    await expect(browserEvents.nth(4)).toContainText(/Failed|失败/)
    await expect(browserEvents.nth(4)).toHaveAttribute('data-process-item-id', 'collab-browser-failed-2')
    await expect(browserEvents.nth(5)).toContainText(/Activity|活动记录/)
    await expect(browserEvents.nth(5)).toContainText('Browser guard verification passed.')
    await browserEvents.nth(0).focus()
    await page.keyboard.press('Tab')
    const keyboardFocusedActivity = browserGroup.locator('.code-agent-transcript-collaboration-event:focus')
    await expect(keyboardFocusedActivity).toHaveCount(1)
    expect(await keyboardFocusedActivity.evaluate(element => getComputedStyle(element).boxShadow)).not.toBe('none')

    await browserEvents.nth(2).click()
    await expect(browserEvents.nth(2)).toHaveAttribute('aria-expanded', 'true')
    const repeatedEvidence = browserGroup.getByTestId('code-agent-transcript-collaboration-evidence')
    await expect(repeatedEvidence.getByTestId('code-agent-transcript-process-item')).toHaveCount(8)
    await expect(repeatedEvidence.getByTestId('code-agent-transcript-collaboration-earlier'))
      .toContainText(/10 (?:earlier records|条记录)/)
    await repeatedEvidence.getByTestId('code-agent-transcript-collaboration-earlier').click()
    await expect(repeatedEvidence.getByTestId('code-agent-transcript-process-item')).toHaveCount(18)
    await browserEvents.nth(2).click()
    await expect(browserEvents.nth(2)).toHaveAttribute('aria-expanded', 'false')
    await expect(browserGroup.getByTestId('code-agent-transcript-collaboration-evidence')).toHaveCount(0)

    await browserEvents.nth(3).click()
    await expect(browserEvents.nth(3)).toHaveAttribute('aria-expanded', 'true')
    const detail = browserGroup.locator(
      '[data-testid="code-agent-transcript-process-item"][data-process-item-id="collab-browser-failed-1"]',
    )
    await expect(detail.getByTestId('code-agent-transcript-process-item-toggle')).toHaveAttribute('aria-expanded', 'false')
    await detail.getByTestId('code-agent-transcript-process-item-toggle').click()
    await expect(detail.getByTestId('code-agent-transcript-process-item-toggle')).toHaveAttribute('aria-expanded', 'true')
    await expect(detail).toContainText('Browser guard retry required.')
    await detail.getByTestId('code-agent-transcript-process-item-toggle').click()
    await expect(detail.getByTestId('code-agent-transcript-process-item-toggle')).toHaveAttribute('aria-expanded', 'false')

    await browserSummary.click()
    await expect(browserSummary).toHaveAttribute('aria-expanded', 'false')
    await expect(browserGroup.getByTestId('code-agent-transcript-collaboration-event')).toHaveCount(0)
    await browserSummary.click()
    await expect(browserSummary).toHaveAttribute('aria-expanded', 'true')
    await expect(browserGroup.getByTestId('code-agent-transcript-collaboration-event').nth(3))
      .toHaveAttribute('aria-expanded', 'false')

    await sendAcpMessage(page, 'collaboration follow up')
    const followUpTurn = page.locator('.code-agent-transcript-turn')
      .filter({ hasText: 'Cross-turn collaboration update complete.' })
    await expect(followUpTurn).toBeVisible()
    const followUpProcessSummary = followUpTurn.getByTestId('code-agent-transcript-process-summary')
    await expect(followUpProcessSummary).toHaveAttribute('aria-expanded', 'false')
    const followUpTimeline = followUpTurn.getByTestId('code-agent-transcript-collaboration')
    await expect(page.getByTestId('code-agent-transcript-collaboration')).toHaveCount(2)
    await expect(browserSummary).toHaveAttribute('aria-expanded', 'true')
    await expect(groups).toHaveCount(2)
    await expect(reviewGroup).toContainText(/1 child|1 个子 Agent/)
    await reviewSummary.click()
    await expect(groups).toHaveCount(3)
    const followUpParent = followUpTimeline.getByTestId('code-agent-transcript-collaboration-group')
      .filter({ hasText: 'Goodall' })
    const followUpParentSummary = followUpParent.locator(
      ':scope > [data-testid="code-agent-transcript-collaboration-summary"]',
    )
    await followUpParentSummary.click()
    const followUpChild = followUpParent.getByTestId('code-agent-transcript-collaboration-group')
      .filter({ hasText: 'Cross turn child' })
    await expect(followUpChild).toContainText('Hubble')
    await expect(followUpChild).toHaveAttribute('data-agent-depth', '1')
    await expect(followUpTurn).toContainText('Cross turn child')
    await expect(turn).not.toContainText('Cross turn child')
  })

  test('keeps a manually expanded Agent stable while collaboration updates stream', async ({ page, workspaceRoot }) => {
    test.setTimeout(30_000)
    const workspace = path.join(workspaceRoot, 'acp-live-collaboration')
    fs.mkdirSync(workspace, { recursive: true })

    const agentId = await createAcpAgent(page, workspace)
    await openFarming(page)
    await agentRow(page, agentId).click()
    await sendAcpMessage(page, 'live collaboration demo')

    const turn = page.locator('.code-agent-transcript-turn').filter({ hasText: 'live collaboration demo' })
    const timeline = turn.getByTestId('code-agent-transcript-collaboration')
    const liveReviewGroup = timeline.getByTestId('code-agent-transcript-collaboration-group')
      .filter({ hasText: 'Live reviewer' })
    const summary = liveReviewGroup.getByTestId('code-agent-transcript-collaboration-summary')
    const initialAgentIcon = await liveReviewGroup.getAttribute('data-agent-icon')
    await expect(summary).toContainText(/In progress|进行中/)
    await expect.poll(async () => {
      const match = (await summary.textContent() || '').match(/(\d+) (?:events?|个事件)/)
      return Number(match?.[1] || 0)
    }, { timeout: 5_000 }).toBeGreaterThanOrEqual(2)

    await summary.click()
    await expect(summary).toHaveAttribute('aria-expanded', 'true')
    const activityCountBefore = await liveReviewGroup
      .getByTestId('code-agent-transcript-collaboration-event')
      .count()
    await expect.poll(async () => {
      const match = (await summary.textContent() || '').match(/(\d+) (?:events?|个事件)/)
      return Number(match?.[1] || 0)
    }, { timeout: 5_000 }).toBeGreaterThanOrEqual(5)
    await expect(summary).toHaveAttribute('aria-expanded', 'true')
    expect(await liveReviewGroup.getByTestId('code-agent-transcript-collaboration-event').count())
      .toBe(activityCountBefore)

    await expect(page.getByText('Live collaboration demo complete.', { exact: true })).toBeVisible({
      timeout: 15_000,
    })
    await expect(summary).toHaveAttribute('aria-expanded', 'true')
    await expect(summary).toContainText(/Completed|已完成/)
    await expect(liveReviewGroup).toHaveAttribute('data-agent-icon', initialAgentIcon || '')
    const activities = liveReviewGroup.getByTestId('code-agent-transcript-collaboration-event')
    await expect(activities).toHaveCount(3)
    await expect(activities.nth(1)).toContainText(/10 (?:events|个事件)/)
    await expect(activities.nth(2)).toContainText('Live review completed.')
  })

  test('aligns every Chat turn to one shared content column', async ({ page, workspaceRoot }) => {
    const workspace = path.join(workspaceRoot, 'acp-turn-alignment')
    fs.mkdirSync(workspace, { recursive: true })

    const agentId = await createAcpAgent(page, workspace)
    await openFarming(page)
    await agentRow(page, agentId).click()
    await sendAcpMessage(page, 'usage warning')
    await expect(page.getByText('Usage warning published.', { exact: true })).toBeVisible({ timeout: 15_000 })

    const shortTranscriptGeometry = await page.getByTestId('code-agent-transcript-scroll').evaluate(element => {
      const user = element.querySelector<HTMLElement>('.code-agent-transcript-user')
      if (!user) throw new Error('Short Chat turn fixture is incomplete')
      const scrollerBox = element.getBoundingClientRect()
      const userBox = user.getBoundingClientRect()
      return {
        userTopOffset: userBox.top - scrollerBox.top,
        scrollTop: element.scrollTop,
      }
    })
    expect(shortTranscriptGeometry.scrollTop).toBe(0)
    expect(shortTranscriptGeometry.userTopOffset).toBeGreaterThanOrEqual(30)
    expect(shortTranscriptGeometry.userTopOffset).toBeLessThanOrEqual(60)

    await sendAcpMessage(page, 'Please inspect the complete interaction and return a rich timeline with all relevant details.')
    await expect(page.getByText('Rich ACP timeline complete.', { exact: true })).toBeVisible({ timeout: 20_000 })

    const turns = page.locator('.code-agent-transcript-turn')
    const shortTurn = turns.filter({ hasText: 'usage warning' })
    const longTurn = turns.filter({ hasText: 'Please inspect the complete interaction' })
    const metrics = await Promise.all([shortTurn, longTurn].map(turn => turn.evaluate(element => {
      const turnBox = element.getBoundingClientRect()
      const userBox = element.querySelector('.code-agent-transcript-user')?.getBoundingClientRect()
      const answerBox = element.querySelector('.code-agent-transcript-answer')?.getBoundingClientRect()
      if (!userBox || !answerBox) throw new Error('Chat alignment fixture is incomplete')
      return {
        turnLeft: turnBox.left,
        turnWidth: turnBox.width,
        userRight: userBox.right,
        answerLeft: answerBox.left,
      }
    })))

    expect(Math.abs(metrics[0].turnLeft - metrics[1].turnLeft)).toBeLessThanOrEqual(1)
    expect(Math.abs(metrics[0].turnWidth - metrics[1].turnWidth)).toBeLessThanOrEqual(1)
    expect(Math.abs(metrics[0].userRight - metrics[1].userRight)).toBeLessThanOrEqual(1)
    expect(Math.abs(metrics[0].answerLeft - metrics[1].answerLeft)).toBeLessThanOrEqual(1)
  })

  test('keeps 53 structured chat interactions coherent across live, history, security, and runtime switching', { tag: '@iphone-human' }, async ({ page, workspaceRoot }) => {
    test.setTimeout(150_000)
    const workspace = path.join(workspaceRoot, 'acp-human-cases')
    fs.mkdirSync(workspace, { recursive: true })
    fs.writeFileSync(path.join(workspace, 'README.md'), '# ACP browser fixture\n')
    fs.writeFileSync(path.join(workspace, 'display-fixture.txt'), 'before\n')
    execFileSync('git', ['init'], { cwd: workspace, stdio: 'ignore' })
    execFileSync('git', ['config', 'user.name', 'Farming E2E'], { cwd: workspace })
    execFileSync('git', ['config', 'user.email', 'farming-e2e@example.com'], { cwd: workspace })
    execFileSync('git', ['add', '.'], { cwd: workspace, stdio: 'ignore' })
    execFileSync('git', ['commit', '-m', 'seed ACP fixture'], { cwd: workspace, stdio: 'ignore' })

    let agentId = ''
    let compactLayout = false
    await test.step('01 create a real fake-ACP runtime through the server', async () => {
      agentId = await createAcpAgent(page, workspace)
    })
    await test.step('02 open the Farming Code browser surface', async () => {
      await openFarming(page)
      compactLayout = await page.locator('body').evaluate(element => element.classList.contains('code-compact-layout'))
    })
    await test.step('03 select the ACP Agent from the project list', async () => {
      const mobileMenu = page.getByTestId('code-mobile-menu')
      if (!await agentRow(page, agentId).isVisible().catch(() => false)
        && await mobileMenu.isVisible().catch(() => false)) {
        await mobileMenu.click()
      }
      await expect(agentRow(page, agentId)).toBeVisible()
      await agentRow(page, agentId).click()
      if (compactLayout) {
        await expect(page.getByTestId('code-agent-chat-view')).toBeVisible()
      } else {
        await expect(agentRow(page, agentId)).toHaveClass(/active/)
      }
    })
    await test.step('04 show Chat rather than a terminal for an ACP runtime', async () => {
      await expect(page.getByTestId('code-agent-chat-view')).toBeVisible()
      await expect(page.getByTestId('code-agent-terminal-view')).toHaveCount(0)
      const emptyState = page.locator('.code-agent-transcript-blank')
      await expect(emptyState).toHaveText('No conversation yet.')
      await expect(emptyState).toHaveAttribute('role', 'status')
    })
    await test.step('05 retain the established composer shape and toolbar', async () => {
      await expect(page.getByTestId('code-acp-composer')).toBeVisible()
      await expect(page.getByTestId('code-acp-composer-toolbar')).toBeVisible()
      await expect(page.getByTestId('code-acp-composer-add')).toBeVisible()
      await expect(page.getByTestId('code-acp-composer-send')).toBeVisible()
    })
    await test.step('06 accept ordinary text input', async () => {
      await page.getByTestId('code-acp-composer-input').fill('rich timeline')
      await expect(page.getByTestId('code-acp-composer-input')).toHaveValue('rich timeline')
    })
    const transcriptMediaResponse = page.waitForResponse(response => (
      response.url().includes(`/api/agents/${agentId}/acp-media/`)
      && response.status() === 200
    ))
    await test.step('07 send a structured ACP prompt', async () => {
      await page.getByTestId('code-acp-composer-send').click()
      await expect(page.getByTestId('code-acp-composer-input')).toHaveValue('')
    })
    await test.step('08 render the optimistic user message once', async () => {
      await expect(page.getByText('rich timeline', { exact: true })).toHaveCount(1)
    })
    await test.step('08b render the active plan on the dark appearance surface', async () => {
      await page.locator('body').evaluate(body => { body.dataset.appearance = 'dark' })
      const plan = page.getByTestId('code-agent-transcript-plan-driver')
      await expect(plan).toBeVisible()
      await expect(plan).toContainText('1/3')
      await expect(plan).toHaveCSS('background-color', 'rgba(38, 38, 38, 0.86)')
      await expect(plan).toHaveCSS('border-top-color', 'rgb(56, 56, 56)')
      await expect(plan.locator('.code-agent-transcript-plan-driver-summary > span')).toHaveCSS('color', 'rgb(255, 255, 255)')
      await page.locator('body').evaluate(body => { body.dataset.appearance = 'light' })
    })
    await test.step('09 render the final answer after dynamic updates', async () => {
      await expect(page.getByText('Rich ACP timeline complete.', { exact: true })).toBeVisible({ timeout: 20_000 })
    })
    await test.step('10 expose ACP context usage and session cost', async () => {
      const usage = page.getByTestId('code-acp-context-window')
      await expect(usage).toBeVisible()
      await expect(usage).toHaveAttribute('aria-label', /53k \/ 200k tokens used/i)
      await expect(usage).toHaveAttribute('aria-label', /0\.045 USD/)
    })
    await test.step('10b warn when the Agent reports a nearly full context window', async () => {
      await sendAcpMessage(page, 'usage warning')
      await expect(page.getByText('Usage warning published.', { exact: true })).toBeVisible({ timeout: 15_000 })
      const usage = page.getByTestId('code-acp-context-window')
      await expect(usage).toHaveAttribute('data-level', 'warning')
      await expect(usage).toHaveAttribute('aria-label', /nearly full/i)
      await expect(usage).toHaveAttribute('aria-label', /190k \/ 200k tokens used/i)
    })
    const richTurn = page.locator('.code-agent-transcript-turn').filter({ hasText: 'rich timeline' })
    await test.step('11 hide completed intermediate work behind one folded entry', async () => {
      const processSummary = richTurn.getByTestId('code-agent-transcript-process-summary')
      await expect(processSummary).toHaveAttribute('aria-expanded', 'false')
      await expect(richTurn.getByTestId('code-agent-transcript-process-compact-list')).toHaveCount(0)
      await expect(richTurn.getByTestId('code-agent-transcript-process-group')).toHaveCount(0)
      await processSummary.click()
      await expect(processSummary).toHaveAttribute('aria-expanded', 'true')
      await expect(richTurn.getByTestId('code-agent-transcript-process-group-toggle')).toHaveAttribute('aria-expanded', 'false')
    })
    await test.step('12 render full intermediate commentary in the ordered flow', async () => {
      const progress = richTurn.getByTestId('code-acp-progress-update')
      await expect(progress.getByText('I found the display boundary and am checking the typed ACP content.')).toBeVisible()
      await expect(progress).toHaveCSS('margin-left', '0px')
      await expect(progress).toHaveCSS('padding-left', '0px')
      await expect.poll(async () => {
        const progressBox = await progress.boundingBox()
        const summaryBox = await richTurn.getByTestId('code-agent-transcript-process-summary').boundingBox()
        if (!progressBox || !summaryBox) return Number.POSITIVE_INFINITY
        return Math.abs(progressBox.x - summaryBox.x)
      }).toBeLessThanOrEqual(1)
    })
    await test.step('13 remove the stale floating plan driver after the turn completes', async () => {
      const plan = page.getByTestId('code-agent-transcript-plan-driver')
      await expect(plan).toHaveCount(0)
      await expect(richTurn.getByText('Plan', { exact: true })).toHaveCount(0)
    })
    await test.step('14 group reasoning and tools into one compact reversible segment', async () => {
      const actionGroup = richTurn.getByTestId('code-agent-transcript-process-group').first()
      await expect(actionGroup).toBeVisible()
      await actionGroup.getByTestId('code-agent-transcript-process-group-toggle').click()
      await expect(richTurn.locator('.code-agent-transcript-process-dot')).toHaveCount(0)
    })
    await test.step('15 retain reasoning as an individually folded child item', async () => {
      const reasoning = richTurn.locator('[data-testid="code-agent-transcript-process-item"][data-type="thought"]')
      await expect(reasoning).toBeVisible()
      const toggle = reasoning.getByTestId('code-agent-transcript-process-item-toggle')
      const chevron = toggle.locator('.code-agent-transcript-process-item-chevron')
      await expect(toggle).toHaveAttribute('aria-expanded', 'false')
      await expect(toggle).toContainText('The ordered stream must stay reversible.')
      await expect(chevron).toHaveCSS('opacity', '0')
      await toggle.hover()
      await expect(chevron).toHaveCSS('opacity', '0.9')
      await page.mouse.move(0, 0)
      await toggle.focus()
      await expect(chevron).toHaveCSS('opacity', '0.9')
    })
    const readItem = richTurn.getByTestId('code-agent-transcript-process-item').filter({ hasText: 'Read ACP display fixtures' })
    await test.step('17 retain the typed read-tool title and location', async () => {
      await expect(readItem).toBeVisible()
      await readItem.getByTestId('code-agent-transcript-process-item-toggle').click()
      const locations = readItem.getByTestId('code-agent-transcript-locations')
      await expect(locations).toBeVisible()
      await expect(locations.getByRole('button', { name: /README\.md:1/ })).toBeVisible()
      await expect(readItem).not.toContainText('Locations\n')
    })
    await test.step('18 render a safe HTTP resource as a real link', async () => {
      await expect(readItem.getByRole('link', { name: 'ACP reference' })).toHaveAttribute('href', 'https://agentclientprotocol.com/')
    })
    await test.step('19 render an embedded text resource without losing its content', async () => {
      const embedded = readItem.getByTestId('code-agent-transcript-user-files').locator('details').filter({ hasText: 'acp-note.txt' })
      await embedded.locator('summary').click()
      await expect(embedded.getByText('Embedded ACP note')).toBeVisible()
    })
    await test.step('20 render ACP image content inside the tool detail', async () => {
      await expect(readItem.getByTestId('code-agent-transcript-process-images').locator('img')).toHaveCount(1)
    })
    await test.step('21 render ACP audio content with native controls', async () => {
      await expect(readItem.getByTestId('code-agent-transcript-audios').locator('audio')).toHaveCount(1)
    })
    await test.step('21b load negotiated media through an immutable authenticated response', async () => {
      const response = await transcriptMediaResponse
      expect(response.headers()['cache-control']).toContain('immutable')
      expect(response.headers()['x-content-type-options']).toBe('nosniff')
      expect(response.headers()['content-type']).toMatch(/^(?:image|audio)\//)
    })
    await test.step('22 summarize a file edit as a result card', async () => {
      await expect(richTurn.getByTestId('code-agent-transcript-result-card')).toBeVisible()
      await expect(richTurn.getByTestId('code-agent-transcript-result-card')).toContainText('1 file changed')
      await expect(richTurn.getByTestId('code-agent-transcript-result-icon')).toBeVisible()
    })
    await test.step('23 reveal the exact ACP diff on demand', async () => {
      await richTurn.getByRole('button', { name: /^Review/ }).click()
      const review = page.getByRole('dialog', { name: 'Review' }).getByTestId('code-agent-transcript-result-details')
      await expect(review).toBeVisible()
      await expect(review).toContainText('display-fixture.txt')
      await expect(review.locator('.code-agent-transcript-result-diff')).toContainText('+after')

    })
    await test.step('23b keep expanded supporting content readable but secondary', async () => {
      const progressFontSize = await richTurn.locator('.code-acp-progress-update').evaluate(element => (
        Number.parseFloat(getComputedStyle(element).fontSize)
      ))
      expect(progressFontSize).toBeGreaterThanOrEqual(13.5)
      expect(progressFontSize).toBeLessThanOrEqual(14)
      await expect(readItem.locator('.code-agent-transcript-user-file pre')).toHaveCSS('font-size', '13px')
      await expect(page.getByRole('dialog', { name: 'Review' }).locator('.code-agent-transcript-result-diff')).toHaveCSS('font-size', '13px')
      await page.getByRole('dialog', { name: 'Review' }).getByRole('button', { name: 'Close' }).click()
    })
    const terminalItem = richTurn.getByTestId('code-agent-transcript-process-item').filter({ hasText: 'Run verification command' })
    await test.step('24 fetch terminal presentation only when expanded', async () => {
      await terminalItem.getByTestId('code-agent-transcript-process-item-toggle').click()
      await expect(terminalItem.getByTestId('code-agent-transcript-terminals')).toBeVisible()
    })
    await test.step('25 show terminal exit status and output', async () => {
      await expect(terminalItem).toContainText('Exit 0')
      await expect(terminalItem).toContainText('rich-terminal-output')
      await expect(terminalItem).toContainText(process.execPath)
      await expect(terminalItem).toContainText(workspace)
      await expect(terminalItem.getByRole('button', { name: 'Copy terminal output' })).toBeVisible()
    })
    await test.step('26 keep transcript search controls out of the Chat header', async () => {
      await expect(page.getByRole('button', { name: 'Search this chat' })).toHaveCount(0)
      const userMessage = page.locator('.code-agent-transcript-user').filter({ hasText: 'rich timeline' })
      await expect(userMessage).toHaveCount(1)
      if (compactLayout) {
        await expect.poll(async () => page.evaluate(() => (
          document.documentElement.scrollWidth - window.innerWidth
        ))).toBeLessThanOrEqual(0)
      } else {
        const modeToggle = page.getByTestId('code-terminal-mode-toggle')
        await expect.poll(async () => {
          const userBox = await userMessage.boundingBox()
          const toggleBox = await modeToggle.boundingBox()
          if (!userBox || !toggleBox) return -1
          return toggleBox.x - (userBox.x + userBox.width)
        }).toBeGreaterThanOrEqual(8)
      }
    })
    await test.step('27 keep the ordered transcript unchanged', async () => {
      await expect(page.getByText('Rich ACP timeline complete.', { exact: true })).toBeVisible()
    })
    await test.step('28 expose Agent-provided slash commands', async () => {
      await page.getByTestId('code-acp-composer-input').fill('/')
      await expect(page.getByTestId('code-acp-command-review')).toBeVisible()
      await page.getByTestId('code-acp-composer-input').fill('')
    })
    await test.step('29 keep the plus menu compact and actionable', async () => {
      await page.getByTestId('code-acp-composer-add').click()
      await expect(page.getByTestId('code-acp-plus-menu')).toBeVisible()
      await expect(page.getByTestId('code-acp-composer-attach-file')).toBeVisible()
      await page.getByTestId('code-acp-composer-add').click()
    })
    await test.step('29b attach an image through the established composer control', async () => {
      const imagePath = path.join(workspace, 'attachment.png')
      fs.writeFileSync(imagePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=', 'base64'))
      await page.getByTestId('code-acp-composer-file-input').setInputFiles(imagePath)
      const attachment = page.getByTestId('code-composer-attachment')
      await expect(attachment).toContainText('attachment.png')
      await expect(attachment).toHaveClass(/ready/, { timeout: 15_000 })
    })
    await test.step('29c send native ACP image content and retain it in the user turn', async () => {
      await sendAcpMessage(page, 'image attachment')
      await expect(page.getByText('Received 1 image.', { exact: true })).toBeVisible({ timeout: 15_000 })
      const imageTurn = page.locator('.code-agent-transcript-turn').filter({ hasText: 'image attachment' }).last()
      const image = imageTurn.getByTestId('code-agent-transcript-user-images').locator('img')
      await expect(image).toHaveCount(1)
      await image.click()
      await expect(page.getByTestId('code-agent-transcript-image-overlay')).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(page.getByTestId('code-agent-transcript-image-overlay')).toHaveCount(0)
    })
    await test.step('30 send a subagent-producing prompt', async () => {
      await sendAcpMessage(page, 'subagent preview')
      await expect(page.getByText('Subagent inspection complete.', { exact: true })).toBeVisible({ timeout: 15_000 })
    })
    const subagentTurn = page.locator('.code-agent-transcript-turn').filter({ hasText: 'subagent preview' })
    await test.step('31 keep the completed subagent action collapsed', async () => {
      const processSummary = subagentTurn.getByTestId('code-agent-transcript-process-summary')
      await expect(processSummary).toHaveAttribute('aria-expanded', 'false')
      await processSummary.click()
      await subagentTurn.getByTestId('code-agent-transcript-process-group-toggle').click()
    })
    await test.step('32 lazily fetch and render the child transcript', async () => {
      const subagentItem = subagentTurn.getByTestId('code-agent-transcript-process-item').filter({ hasText: 'Inspect with subagent' })
      await subagentItem.getByTestId('code-agent-transcript-process-item-toggle').click()
      await expect(subagentItem.getByTestId('code-agent-transcript-subagent')).toContainText('Inspect the parser')
      await expect(subagentItem.getByTestId('code-agent-transcript-subagent')).toContainText('The parser is consistent.')
      await expect(subagentItem.getByTestId('code-agent-transcript-subagent')).toContainText('Completed')
      await expect(subagentItem.getByTestId('code-agent-transcript-subagent')).toContainText('1 turn · 3 actions')
      const readAction = subagentItem.getByTestId('code-agent-transcript-subagent-action').filter({ hasText: 'Read parser fixture' })
      await readAction.locator('summary').click()
      await expect(readAction).toContainText('Parser state is valid.')
      const editAction = subagentItem.getByTestId('code-agent-transcript-subagent-action').filter({ hasText: 'Edit parser fixture' })
      await editAction.locator('summary').click()
      await expect(editAction).toContainText('parser-fixture.txt')
      await expect(editAction).toContainText('+1 -1')
    })
    await test.step('32b open the child transcript without leaving the parent chat', async () => {
      const subagentItem = subagentTurn.getByTestId('code-agent-transcript-process-item').filter({ hasText: 'Inspect with subagent' })
      await subagentItem.getByTestId('code-acp-subagent-fullscreen').click()
      const dialog = page.getByRole('dialog', { name: 'Subagent details' })
      await expect(dialog).toContainText('The parser is consistent.')
      await dialog.getByRole('button', { name: 'Close subagent details' }).click()
      await expect(dialog).toHaveCount(0)
      await expect(page.getByTestId('code-agent-chat-view')).toBeVisible()
    })
    await test.step('33 keep an intermediate failed tool out of the collapsed summary', async () => {
      await sendAcpMessage(page, 'failed tool')
      await expect(page.getByText('The check failed; no files were changed.', { exact: true })).toBeVisible({ timeout: 15_000 })
      const failedTurn = page.locator('.code-agent-transcript-turn').filter({ hasText: 'failed tool' })
      const failedSummary = failedTurn.getByTestId('code-agent-transcript-process-summary')
      await expect(failedSummary).toHaveAttribute('aria-expanded', 'false')
      await expect(failedTurn.getByTestId('code-agent-transcript-process-compact-list')).toHaveCount(0)
      await expect(failedTurn.getByText('Failed: Run failing check', { exact: true })).toHaveCount(0)
      await failedSummary.click()
      const failedGroup = failedTurn.getByTestId('code-agent-transcript-process-group')
      await expect(failedGroup.getByTestId('code-agent-transcript-process-group-toggle')).toContainText('Action failed')
      await failedGroup.getByTestId('code-agent-transcript-process-group-toggle').click()
      const failedItem = failedTurn.getByTestId('code-agent-transcript-process-item')
        .filter({ hasText: 'Run failing check' })
      await expect(failedItem).toHaveAttribute('data-status', 'failed')
      await expect(failedItem.getByTestId('code-agent-transcript-process-item-toggle')).toHaveAttribute('aria-expanded', 'false')
      await expect(failedItem.locator('.code-agent-transcript-process-status')).toHaveText('failed')
    })
    await test.step('34 block permission grants for punycode and invisible paths', async () => {
      await sendAcpMessage(page, 'unicode permission')
      const permission = page.getByTestId('code-acp-permission-request')
      await expect(permission).toBeVisible({ timeout: 15_000 })
      await expect(page.getByTestId('code-agent-transcript-live-activity')).toHaveCount(0)
      await expect(permission.getByTestId('code-acp-permission-risk')).toContainText('аpple.com')
      await expect(permission.getByRole('button', { name: /Approve|Allow/ })).toBeDisabled()
    })
    await test.step('35 explain each surprising Unicode code point', async () => {
      const risk = page.getByTestId('code-acp-permission-risk')
      await expect(risk).toContainText('U+0430')
      await expect(risk).toContainText('U+200B')
    })
    await test.step('36 require explicit acknowledgement before Allow', async () => {
      const permission = page.getByTestId('code-acp-permission-request')
      await permission.getByRole('checkbox').check()
      const allow = permission.getByRole('button', { name: /Approve|Allow/ })
      await expect(allow).toBeEnabled()
      await allow.click()
      await expect(permission).toBeHidden()
      await expect(page.getByText(/Unicode permission: selected/)).toBeVisible({ timeout: 15_000 })
    })
    await test.step('37 show restrained live progress while the Agent works', async () => {
      const sendPromise = sendAcpMessage(page, 'live progress')
      const liveTurn = page.locator('.code-agent-transcript-turn').filter({ hasText: 'live progress' }).last()
      const liveSummary = liveTurn.getByTestId('code-agent-transcript-process-summary')
      await expect(liveSummary).toHaveAttribute(
        'title',
        /run-long-command\.js --verify-mobile-composer-focus/,
        { timeout: 10_000 },
      )
      await expect(liveSummary).toHaveAttribute('aria-expanded', 'false')
      const liveActivity = liveTurn.getByTestId('code-agent-transcript-live-activity')
      await expect(liveActivity).toBeVisible()
      await expect(liveActivity.getByTestId('code-agent-transcript-live-activity-icon')).toHaveAttribute('data-kind', 'running')
      const compactList = liveTurn.getByTestId('code-agent-transcript-process-compact-list')
      const compactGroup = compactList.getByTestId('code-agent-transcript-process-group')
      await expect(compactGroup).toHaveCount(1)
      await expect(compactGroup.getByTestId('code-agent-transcript-process-group-toggle')).toContainText('Ran a command')
      await expect(compactGroup.getByTestId('code-agent-transcript-process-group-toggle')).toHaveAttribute('aria-expanded', 'false')
      await sendPromise
      await expect(liveActivity).toHaveCount(0)
      await expect(liveSummary).toContainText(/Process|Worked for/)
      await expect(liveSummary).toHaveAttribute('aria-expanded', 'false')
      await expect(liveTurn.getByTestId('code-agent-transcript-process-compact-list')).toHaveCount(0)
      await liveSummary.click()
      const liveGroup = liveTurn.getByTestId('code-agent-transcript-process-group')
      await liveGroup.getByTestId('code-agent-transcript-process-group-toggle').click()
      const liveAction = liveTurn.getByTestId('code-agent-transcript-process-item')
        .filter({ hasText: 'PORT=4187 FARMING_PLAYWRIGHT_PORT=4187' })
      await expect(liveAction).toBeVisible()
      await expect(liveAction.locator('.code-agent-transcript-process-status')).toHaveCount(0)
      const liveSummaryLabel = liveSummary.locator('.code-agent-transcript-process-summary-label')
      await expect(liveSummaryLabel).toHaveCSS('text-overflow', 'ellipsis')
      await expect(liveSummaryLabel).toHaveCSS('white-space', 'nowrap')
      await expect(page.getByText('Live progress complete.', { exact: true })).toBeVisible({ timeout: 10_000 })
      await expect(liveSummary).not.toHaveAttribute('title', /run-long-command\.js --verify-mobile-composer-focus/)
      await expect(liveTurn.getByText('Editing display data', { exact: true })).toBeVisible()
      await expect(liveTurn.getByText('Running checks', { exact: true })).toBeVisible()
    })
    await test.step('38 queue and discard a follow-up during active work', async () => {
      const sendPromise = sendAcpMessage(page, 'live progress')
      const activeLiveTurn = page.locator('.code-agent-transcript-turn').filter({ hasText: 'live progress' }).last()
      await expect(activeLiveTurn.getByTestId('code-agent-transcript-process-summary')).toHaveAttribute(
        'title',
        /run-long-command\.js --verify-mobile-composer-focus/,
        { timeout: 10_000 },
      )
      await page.getByTestId('code-acp-composer-input').fill('queued follow-up')
      await page.getByTestId('code-acp-composer-send').click()
      await expect(page.getByTestId('code-acp-pending-followup')).toContainText('queued follow-up')
      await page.getByTestId('code-acp-pending-followup-discard').click()
      await expect(page.getByTestId('code-acp-pending-followup')).toBeHidden()
      await sendPromise
      await expect(activeLiveTurn.getByText('Live progress complete.', { exact: true })).toBeVisible({ timeout: 10_000 })
    })
    await test.step('39 expose an ACP form elicitation instead of looking stuck', async () => {
      await sendAcpMessage(page, 'exercise client services')
      const elicitation = page.getByTestId('code-acp-elicitation')
      await expect(elicitation).toBeVisible({ timeout: 15_000 })
      await expect(elicitation).toContainText('Confirm the protocol round trip')
    })
    await test.step('40 submit typed ACP input through the established composer area', async () => {
      const elicitation = page.getByTestId('code-acp-elicitation')
      await elicitation.getByRole('checkbox', { name: 'Confirmed' }).check()
      await elicitation.getByRole('button', { name: 'Submit' }).click()
    })
    await test.step('41 keep client filesystem and terminal results in the ordered turn', async () => {
      await expect(page.getByText('filesystem-ok; terminal-ok; exit=0; confirmed=true', { exact: true })).toBeVisible({ timeout: 15_000 })
      const clientTurn = page.locator('.code-agent-transcript-turn').filter({ hasText: 'exercise client services' })
      const clientSummary = clientTurn.getByTestId('code-agent-transcript-process-summary')
      await expect(clientSummary).toHaveAttribute('aria-expanded', 'false')
      await clientSummary.click()
      await expect(clientTurn.getByTestId('code-agent-transcript-process-group-toggle')).toContainText('Ran a command')
    })
    await test.step('42 clear the resolved elicitation without leaving a duplicate notice', async () => {
      await expect(page.getByTestId('code-acp-elicitation')).toHaveCount(0)
      await expect(page.getByText('Confirm the protocol round trip', { exact: true })).toHaveCount(0)
    })
    const modeToggle = page.getByTestId('code-terminal-mode-toggle')
    const openAgentRuntimeMenu = async () => {
      if (!await agentRow(page, agentId).isVisible().catch(() => false)) {
        await page.getByTestId('code-mobile-menu').click()
      }
      const row = agentRow(page, agentId)
      await expect(row).toBeVisible()
      await row.getByTestId('code-agent-row-more').click()
      const menu = page.getByTestId('code-agent-context-menu')
      await expect(menu).toBeVisible()
      return menu
    }
    await test.step('42b keep Chat and Terminal switch icons visibly rendered', async () => {
      if (await modeToggle.isVisible().catch(() => false)) {
        for (const name of ['Chat', 'Terminal']) {
          const icon = modeToggle.getByRole('button', { name }).locator('svg')
          await expect(icon).toBeVisible()
          await expect(icon).toHaveCSS('fill', /rgb\(/)
        }
        await expect(modeToggle).toHaveCSS('opacity', '0.82')
      } else {
        const menu = await openAgentRuntimeMenu()
        await expect(menu.getByRole('menuitem', { name: /Switch to Terminal|切换到终端/ })).toBeVisible()
        await page.keyboard.press('Escape')
        const backdrop = page.getByTestId('code-mobile-sidebar-backdrop')
        if (await backdrop.isVisible().catch(() => false)) {
          await backdrop.tap({ position: { x: 380, y: 400 } })
        }
      }
    })
    await test.step('43 classify a runtime failure without hiding the transcript', async () => {
      await sendAcpMessage(page, 'authentication error')
      const errorTurn = page.locator('.code-agent-transcript-turn').filter({ hasText: 'authentication error' })
      const errorSummary = errorTurn.getByTestId('code-agent-transcript-process-summary')
      await expect(errorSummary).toContainText('Authentication required', { timeout: 10_000 })
      await expect(errorSummary).toHaveAttribute('aria-expanded', 'false')
      await expect(errorTurn.getByTestId('code-agent-transcript-process-item')).toHaveCount(0)
      await errorSummary.click()
      await errorTurn.getByTestId('code-agent-transcript-process-group-toggle').click()
      const errorItem = errorTurn.getByTestId('code-agent-transcript-process-item').filter({ hasText: 'Authentication required' })
      await expect(errorItem.getByTestId('code-agent-transcript-process-item-toggle')).toHaveAttribute('aria-expanded', 'false')
      await errorItem.getByTestId('code-agent-transcript-process-item-toggle').click()
      await expect(errorTurn).toContainText('401 Unauthorized')
      await expect(page.getByTestId('code-acp-error')).toHaveCount(0)
      await expect(page.getByText('Rich ACP timeline complete.', { exact: true })).toBeVisible()
    })
    await test.step('44 offer the Agent-advertised authentication method', async () => {
      const authentication = page.getByTestId('code-acp-authentication')
      await expect(authentication).toBeVisible()
      await expect(authentication).toContainText('Sign in to fake Agent')
    })
    await test.step('45 authenticate without discarding the failed turn', async () => {
      const agentAuthentication = page.getByTestId('code-acp-authentication')
        .locator('.code-acp-authentication-method')
        .filter({ hasText: 'Sign in to fake Agent' })
      await agentAuthentication.getByRole('button', { name: 'Authenticate' }).click()
      await expect(page.getByTestId('code-acp-authentication')).toHaveCount(0)
      await expect(page.getByTestId('code-agent-transcript-scroll').getByText('401 Unauthorized', { exact: false })).toBeVisible()
    })
    await test.step('45b expose and complete capability-negotiated ACP logout', async () => {
      await page.getByTestId('code-acp-composer-add').click()
      const logout = page.getByTestId('code-acp-logout')
      await expect(logout).toBeVisible()
      const logoutResponse = page.waitForResponse(response => (
        response.request().method() === 'POST'
        && response.url().includes(`/api/agents/${agentId}/acp-session/logout`)
      ))
      await logout.click()
      expect((await logoutResponse).ok()).toBeTruthy()
    })
    await test.step('46 expose a running client terminal as an ordered tool item', async () => {
      await sendAcpMessage(page, 'long terminal')
      const longTurn = page.locator('.code-agent-transcript-turn').filter({ hasText: 'long terminal' }).last()
      const processSummary = longTurn.getByTestId('code-agent-transcript-process-summary')
      await expect(processSummary).toHaveAttribute('aria-expanded', 'false')
      await processSummary.click()
      await longTurn.getByTestId('code-agent-transcript-process-group-toggle').click()
      const longItem = longTurn.getByTestId('code-agent-transcript-process-item')
        .filter({ hasText: 'Run long command' })
      await expect(longItem).toBeVisible({ timeout: 15_000 })
      await expect(longItem.getByTestId('code-agent-transcript-process-item-toggle')).toHaveAttribute('aria-expanded', 'false')
      await longItem.getByTestId('code-agent-transcript-process-item-toggle').click()
      await expect(longItem).toContainText('long-terminal-ready')
      await expect(longTurn.locator('.code-agent-transcript-placeholder')).toHaveCount(0)
      await expect(longItem.locator('.code-agent-transcript-terminal > header > span')).toHaveCount(0)
      expect((await longItem.locator('.code-acp-embedded-terminal-host').boundingBox())?.height || 0).toBeLessThan(120)
    })
    await test.step('47 stop the running ACP terminal from its detail card', async () => {
      const longTurn = page.locator('.code-agent-transcript-turn').filter({ hasText: 'long terminal' }).last()
      const longItem = longTurn.getByTestId('code-agent-transcript-process-item').filter({ hasText: 'Run long command' })
      await expect(longItem).toBeVisible()
      await expect(longItem).toContainText('long-terminal-ready')
      await longItem.getByTestId('code-acp-terminal-stop').click()
    })
    await test.step('48 preserve terminal output and report the stopped result', async () => {
      await expect(page.getByText('Long command stopped.', { exact: true })).toBeVisible({ timeout: 15_000 })
      const longTurn = page.locator('.code-agent-transcript-turn').filter({ hasText: 'long terminal' }).last()
      const processSummary = longTurn.getByTestId('code-agent-transcript-process-summary')
      await expect(processSummary).toHaveAttribute('aria-expanded', 'false')
      await processSummary.click()
      const actionGroup = longTurn.getByTestId('code-agent-transcript-process-group')
      await expect(actionGroup.getByTestId('code-agent-transcript-process-group-toggle')).toHaveAttribute('aria-expanded', 'true')
      const longItem = longTurn.getByTestId('code-agent-transcript-process-item').filter({ hasText: 'Run long command' })
      await expect(longItem.getByTestId('code-agent-transcript-process-item-toggle')).toHaveAttribute('aria-expanded', 'true')
      await expect(longTurn).toContainText('long-terminal-ready')
      await expect(longItem.getByTestId('code-acp-embedded-terminal')).toHaveCount(0)
      await expect(longItem.getByTestId('code-acp-terminal-output')).toContainText('long-terminal-ready')
    })
    await test.step('49 restart from Chat into Terminal with the same provider session', async () => {
      const stateResponse = await page.request.get('/farming/api/control/agents')
      const state = await stateResponse.json() as { agents?: Array<{ id?: string }> }
      expect(state.agents?.some(agent => agent.id === agentId)).toBeTruthy()
      const switchResponsePromise = page.waitForResponse((response) => {
        if (response.request().method() !== 'PATCH'
          || !response.url().includes(`/api/agents/${agentId}`)) {
          return false
        }
        try {
          const payload = response.request().postDataJSON() as { agentRuntimeMode?: string }
          return payload.agentRuntimeMode === 'terminal'
        } catch {
          return false
        }
      })
      if (await modeToggle.isVisible().catch(() => false)) {
        await modeToggle.getByRole('button', { name: 'Terminal' }).click()
      } else {
        const menu = await openAgentRuntimeMenu()
        await menu.getByRole('menuitem', { name: /Switch to Terminal|切换到终端/ }).click()
      }
      await expect(page.getByTestId('code-permission-switching')).toBeVisible()
      const switchResponse = await switchResponsePromise
      const switchPayload = await switchResponse.json() as { error?: string, agentRuntimeMode?: string, restartedAgentId?: string }
      expect(switchResponse.ok(), switchPayload.error || 'Runtime switch request failed').toBeTruthy()
      expect(switchPayload.agentRuntimeMode).toBe('terminal')
      expect(switchPayload.restartedAgentId).toBeTruthy()
      agentId = switchPayload.restartedAgentId || agentId
      await expect(page.getByTestId('code-agent-terminal-view')).toBeVisible({ timeout: 30_000 })
      await expect(page.getByTestId('code-composer-input')).toBeVisible()
      await expect(page.getByTestId('code-acp-composer')).toHaveCount(0)
    })
    await test.step('50 restart back to ACP Chat and preserve structured history', async () => {
      const currentModeToggle = page.getByTestId('code-terminal-mode-toggle')
      if (await currentModeToggle.isVisible().catch(() => false)) {
        await currentModeToggle.getByRole('button', { name: 'Chat' }).click()
      } else {
        const menu = await openAgentRuntimeMenu()
        await menu.getByRole('menuitem', { name: /Switch to Chat|切换到对话/ }).click()
      }
      await expect(page.getByTestId('code-agent-chat-view')).toBeVisible({ timeout: 30_000 })
      await expect(page.getByTestId('code-acp-composer')).toBeVisible()
      await expect(page.getByText('Rich ACP timeline complete.', { exact: true })).toBeVisible({ timeout: 20_000 })
      await expect(page.getByText('Subagent inspection complete.', { exact: true })).toBeVisible()
    })
  })

  test('opens ACP File Changes from history and falls back to the last committed Git diff', async ({ page, workspaceRoot }) => {
    test.setTimeout(60_000)
    const workspace = path.join(workspaceRoot, 'acp-historical-review')
    fs.mkdirSync(workspace, { recursive: true })
    fs.writeFileSync(path.join(workspace, 'README.md'), '# ACP review fixture\n')
    fs.writeFileSync(path.join(workspace, 'display-fixture.txt'), 'before\n')
    execFileSync('git', ['init'], { cwd: workspace, stdio: 'ignore' })
    execFileSync('git', ['config', 'user.name', 'Farming E2E'], { cwd: workspace })
    execFileSync('git', ['config', 'user.email', 'farming-e2e@example.com'], { cwd: workspace })
    execFileSync('git', ['add', '.'], { cwd: workspace, stdio: 'ignore' })
    execFileSync('git', ['commit', '-m', 'seed ACP review fixture'], { cwd: workspace, stdio: 'ignore' })

    const agentId = await createAcpAgent(page, workspace)
    await openFarming(page)
    await agentRow(page, agentId).click()
    await sendAcpMessage(page, 'rich timeline')
    await expect(page.getByText('Rich ACP timeline complete.', { exact: true })).toBeVisible({ timeout: 20_000 })

    const pane = page.locator(`[data-testid="code-agent-work-pane"][data-agent-id="${agentId}"]`)
    const turn = pane.locator('.code-agent-transcript-turn').filter({ hasText: 'rich timeline' }).last()
    const summary = turn.getByTestId('code-agent-transcript-result-summary')
    await expect(summary).toHaveText('1 file changed+1-1')
    await expect(summary).not.toHaveAttribute('aria-expanded')
    await page.locator('body').evaluate(element => { element.dataset.appearance = 'dark' })
    await expect(summary).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    await turn.getByRole('button', { name: /^Review:/ }).click()
    const review = page.getByRole('dialog', { name: 'Review' }).getByTestId('code-agent-transcript-result-details')
    await expect(review).toBeVisible()
    await expect(review.locator('.code-agent-transcript-result-loading')).toHaveCount(0)
    await expect(review.locator('.code-agent-transcript-result-error')).toHaveCount(0)
    await expect(review.locator('.code-agent-transcript-result-diff')).toContainText('+after')
    await page.getByRole('dialog', { name: 'Review' }).getByRole('button', { name: 'Close' }).click()

    fs.writeFileSync(path.join(workspace, 'display-fixture.txt'), 'after\n')
    await page.reload()
    await agentRow(page, agentId).click()
    const dirtyTurn = page.locator(`[data-testid="code-agent-work-pane"][data-agent-id="${agentId}"]`)
      .locator('.code-agent-transcript-turn')
      .filter({ hasText: 'rich timeline' })
      .last()
    const dirtyReviewButton = dirtyTurn.getByRole('button', { name: /^Review:/ })
    const dirtyGitDiffButton = dirtyTurn.getByRole('button', { name: 'Git diff', exact: true })
    await expect(dirtyGitDiffButton).toBeVisible()
    const [dirtyReviewStyle, dirtyGitDiffStyle] = await Promise.all([
      dirtyReviewButton.evaluate(element => {
        const style = getComputedStyle(element)
        return {
          backgroundColor: style.backgroundColor,
          borderColor: style.borderColor,
          borderRadius: style.borderRadius,
          color: style.color,
          padding: style.padding,
        }
      }),
      dirtyGitDiffButton.evaluate(element => {
        const style = getComputedStyle(element)
        return {
          backgroundColor: style.backgroundColor,
          borderColor: style.borderColor,
          borderRadius: style.borderRadius,
          color: style.color,
          padding: style.padding,
        }
      }),
    ])
    expect(dirtyGitDiffStyle).toEqual(dirtyReviewStyle)

    execFileSync('git', ['add', 'display-fixture.txt'], { cwd: workspace, stdio: 'ignore' })
    execFileSync('git', ['commit', '-m', 'commit ACP file change'], { cwd: workspace, stdio: 'ignore' })
    const lastCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' }).trim()
    const lastCommitParent = execFileSync('git', ['rev-parse', 'HEAD~1'], { cwd: workspace, encoding: 'utf8' }).trim()

    await sendAcpMessage(page, 'usage warning')
    await expect(page.getByText('Usage warning published.', { exact: true })).toBeVisible({ timeout: 15_000 })
    const committedTurn = page.locator(`[data-testid="code-agent-work-pane"][data-agent-id="${agentId}"]`)
      .locator('.code-agent-transcript-turn')
      .filter({ hasText: 'rich timeline' })
      .last()
    const lastCommitButton = committedTurn.getByRole('button', { name: 'Git diff last commit', exact: true })
    await expect(lastCommitButton).toBeVisible()
    const popupPromise = page.waitForEvent('popup')
    await lastCommitButton.click()
    const reviewPage = await popupPromise
    await expect.poll(() => new URL(reviewPage.url()).searchParams.get('base')).toBe(lastCommitParent)
    expect(new URL(reviewPage.url()).searchParams.get('head')).toBe(lastCommit)
    await reviewPage.close()
  })

  test('accepts human input in an ACP client terminal without switching to Terminal mode', async ({ page, workspaceRoot }) => {
    test.setTimeout(60_000)
    const workspace = path.join(workspaceRoot, 'acp-interactive-terminal')
    fs.mkdirSync(workspace, { recursive: true })
    const agentId = await createAcpAgent(page, workspace)
    await openFarming(page)
    await agentRow(page, agentId).click()

    await sendAcpMessage(page, 'interactive terminal')
    const turn = page.locator('.code-agent-transcript-turn').filter({ hasText: 'interactive terminal' }).last()
    const processSummary = turn.getByTestId('code-agent-transcript-process-summary')
    await expect(processSummary).toHaveAttribute('aria-expanded', 'false')
    await processSummary.click()
    await turn.getByTestId('code-agent-transcript-process-group-toggle').click()
    const tool = turn.getByTestId('code-agent-transcript-process-item')
      .filter({ hasText: 'Ask in terminal' })
    await expect(tool).toBeVisible({ timeout: 15_000 })
    await expect(tool.getByTestId('code-agent-transcript-process-item-toggle')).toHaveAttribute('aria-expanded', 'false')
    await tool.getByTestId('code-agent-transcript-process-item-toggle').click()
    await expect(tool).toContainText('name>')
    const terminal = tool.getByTestId('code-acp-embedded-terminal')
    await expect(terminal).toBeVisible()
    expect((await terminal.locator('.code-acp-embedded-terminal-host').boundingBox())?.height || 0).toBeLessThan(120)
    await terminal.locator('.code-acp-embedded-terminal-host').click()
    await page.keyboard.type('Farming', { delay: 30 })
    await page.keyboard.press('Enter')
    const answer = page.locator('.code-agent-transcript-answer').filter({ hasText: 'Interactive terminal completed:' })
    await expect(answer).toContainText('hello Farming', { timeout: 15_000 })
    await expect(page.getByTestId('code-agent-chat-view')).toBeVisible()
    await expect(page.getByTestId('code-agent-terminal-view')).toHaveCount(0)
  })

  test('keeps streaming thought folded until its segment and detail are explicitly opened', async ({ page, workspaceRoot }) => {
    test.setTimeout(60_000)
    const workspace = path.join(workspaceRoot, 'acp-streaming-thought')
    fs.mkdirSync(workspace, { recursive: true })
    const agentId = await createAcpAgent(page, workspace)
    await openFarming(page)
    await agentRow(page, agentId).click()

    await sendAcpMessage(page, 'streaming thought')
    const turn = page.locator('.code-agent-transcript-turn').filter({ hasText: 'streaming thought' }).last()
    const processSummary = turn.getByTestId('code-agent-transcript-process-summary')
    await expect(processSummary).toHaveAttribute('aria-expanded', 'false')
    await expect(turn.getByTestId('code-agent-transcript-process-compact-list')).toHaveCount(0)
    await expect(turn.getByText('Comparing the likely causes', { exact: false })).toHaveCount(0)
    await processSummary.click()
    await expect(turn.getByTestId('code-agent-transcript-process-group')).toHaveCount(0)
    const thought = turn.locator('[data-testid="code-agent-transcript-process-item"][data-type="thought"]')
    const thoughtToggle = thought.getByTestId('code-agent-transcript-process-item-toggle')
    const thoughtChevron = thoughtToggle.locator('.code-agent-transcript-process-item-chevron')
    await expect(thoughtToggle).toContainText('Comparing the likely causes')
    await expect(thoughtToggle).toHaveAttribute('aria-expanded', 'false')
    await expect(thoughtChevron).toHaveCSS('opacity', '0')
    await thoughtToggle.hover()
    await expect(thoughtChevron).toHaveCSS('opacity', '0.9')
    await page.mouse.move(0, 0)
    await thoughtToggle.focus()
    await expect(thoughtChevron).toHaveCSS('opacity', '0.9')
    await thoughtToggle.click()
    await expect(thought.locator('.code-agent-transcript-process-detail')).toContainText(
      'Checking the strongest one.',
      { timeout: 10_000 },
    )
    await expect(thought.locator('.code-agent-transcript-process-detail')).not.toContainText('Comparing the likely causes')
    await expect(page.getByText('Streaming thought complete.', { exact: true })).toBeVisible({ timeout: 15_000 })
    if (await processSummary.getAttribute('aria-expanded') === 'true') await processSummary.click()
    await expect(processSummary).toHaveAttribute('aria-expanded', 'false')
    await processSummary.click()
    await expect(thought.getByTestId('code-agent-transcript-process-item-toggle')).toHaveAttribute('aria-expanded', 'true')
  })

  test('shows one compact live command and folds completed process evidence', async ({ page, workspaceRoot }) => {
    test.setTimeout(60_000)
    const workspace = path.join(workspaceRoot, 'acp-compact-live-process')
    fs.mkdirSync(workspace, { recursive: true })
    const agentId = await createAcpAgent(page, workspace)
    await openFarming(page)
    await agentRow(page, agentId).click()

    await sendAcpMessage(page, 'live progress')
    const turn = page.locator('.code-agent-transcript-turn').filter({ hasText: 'live progress' }).last()
    const processSummary = turn.getByTestId('code-agent-transcript-process-summary')
    await expect(processSummary).toHaveAttribute(
      'title',
      /run-long-command\.js --verify-mobile-composer-focus/,
      { timeout: 10_000 },
    )
    await expect(processSummary).toHaveAttribute('aria-expanded', 'false')
    const compactList = turn.getByTestId('code-agent-transcript-process-compact-list')
    const compactGroup = compactList.getByTestId('code-agent-transcript-process-group')
    await expect(compactGroup).toHaveCount(1)
    await expect(compactGroup.getByTestId('code-agent-transcript-process-group-toggle')).toContainText('Ran a command')
    await expect(compactGroup.getByTestId('code-agent-transcript-process-group-toggle')).toHaveAttribute('aria-expanded', 'false')
    await compactGroup.getByTestId('code-agent-transcript-process-group-toggle').click()
    await expect(compactGroup.getByTestId('code-agent-transcript-process-group-toggle')).toHaveAttribute('aria-expanded', 'true')
    await expect(compactGroup).toContainText('PORT=4187 FARMING_PLAYWRIGHT_PORT=4187')

    await expect(page.getByText('Live progress complete.', { exact: true })).toBeVisible({ timeout: 15_000 })
    await expect(processSummary).toHaveAttribute('aria-expanded', 'false')
    await expect(turn.getByTestId('code-agent-transcript-process-compact-list')).toHaveCount(0)
    await expect(turn.getByTestId('code-agent-transcript-process-group')).toHaveCount(0)

    await processSummary.click()
    await expect(processSummary).toHaveAttribute('aria-expanded', 'true')
    await expect(turn.getByTestId('code-agent-transcript-process-group')).toBeVisible()
  })

  test('preserves a manually opened process group while consecutive tools stream into it', async ({ page, workspaceRoot }) => {
    test.setTimeout(60_000)
    const workspace = path.join(workspaceRoot, 'acp-grouped-streaming-tools')
    fs.mkdirSync(workspace, { recursive: true })
    const agentId = await createAcpAgent(page, workspace)
    await openFarming(page)
    await agentRow(page, agentId).click()

    await sendAcpMessage(page, 'grouped streaming tools')
    const turn = page.locator('.code-agent-transcript-turn').filter({ hasText: 'grouped streaming tools' }).last()
    const processSummary = turn.getByTestId('code-agent-transcript-process-summary')
    await expect(processSummary).toHaveAttribute('aria-expanded', 'false')
    await processSummary.click()
    const group = turn.getByTestId('code-agent-transcript-process-group')
    await expect(group).toHaveAttribute('data-count', '1', { timeout: 10_000 })
    await group.getByTestId('code-agent-transcript-process-group-toggle').click()
    await expect(group.getByTestId('code-agent-transcript-process-group-toggle')).toHaveAttribute('aria-expanded', 'true')
    await expect(group).toHaveAttribute('data-count', '2', { timeout: 10_000 })
    await expect(group.getByTestId('code-agent-transcript-process-group-toggle')).toHaveAttribute('aria-expanded', 'true')
    await expect(page.getByText('Grouped streaming tools complete.', { exact: true })).toBeVisible({ timeout: 15_000 })
  })

  test('keeps a manually closed terminal detail closed when the running command fails', async ({ page, workspaceRoot }) => {
    test.setTimeout(60_000)
    const workspace = path.join(workspaceRoot, 'acp-failing-terminal')
    fs.mkdirSync(workspace, { recursive: true })
    const agentId = await createAcpAgent(page, workspace)
    await openFarming(page)
    await agentRow(page, agentId).click()

    let delayedTerminalOutcomeResponses = 0
    await page.route('**/acp-tool-details/failing-terminal-tool', async route => {
      const response = await route.fetch()
      const body = await response.json() as {
        terminals?: Array<{ terminal?: { exitStatus?: unknown, released?: boolean } }>
      }
      const hasTerminalOutcome = body.terminals?.some(terminal => (
        Boolean(terminal.terminal?.exitStatus) || terminal.terminal?.released
      ))
      if (hasTerminalOutcome && delayedTerminalOutcomeResponses < 3) {
        delayedTerminalOutcomeResponses += 1
        body.terminals = body.terminals?.map(terminal => ({
          ...terminal,
          terminal: terminal.terminal ? {
            ...terminal.terminal,
            exitStatus: null,
            released: false,
          } : terminal.terminal,
        }))
      }
      await route.fulfill({ response, json: body })
    })

    await sendAcpMessage(page, 'failing terminal')
    const turn = page.locator('.code-agent-transcript-turn').filter({ hasText: 'failing terminal' }).last()
    const liveProcessSummary = turn.getByTestId('code-agent-transcript-process-summary')
    await expect(liveProcessSummary).toHaveAttribute('aria-expanded', 'false')
    await liveProcessSummary.click()
    await turn.getByTestId('code-agent-transcript-process-group-toggle').click()
    const runningItem = turn.getByTestId('code-agent-transcript-process-item')
      .filter({ hasText: 'Run failing command' })
    const toggle = runningItem.getByTestId('code-agent-transcript-process-item-toggle')
    await expect(toggle).toHaveAttribute('aria-expanded', 'false', { timeout: 15_000 })
    await toggle.click()
    await expect(runningItem).toContainText('failing-terminal-ready')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')

    await expect(page.getByText('Failing terminal finished.', { exact: true })).toBeVisible({ timeout: 15_000 })
    const processSummary = turn.getByTestId('code-agent-transcript-process-summary')
    await expect(processSummary).toHaveAttribute('aria-expanded', 'false')
    await processSummary.click()
    const failedGroup = turn.getByTestId('code-agent-transcript-process-group')
    await expect(failedGroup.getByTestId('code-agent-transcript-process-group-toggle')).toHaveAttribute('aria-expanded', 'true')
    const failedItem = turn.getByTestId('code-agent-transcript-process-item')
      .filter({ hasText: 'Run failing command' })
    await expect(failedItem).toBeVisible()
    const failedToggle = failedItem.getByTestId('code-agent-transcript-process-item-toggle')
    await expect(failedToggle).toHaveAttribute('aria-expanded', 'false')
    await failedToggle.click()
    const syncError = failedItem.getByTestId('code-acp-terminal-sync-error')
    await expect(syncError).toContainText('Terminal status could not be synchronized.')
    await expect(failedItem.getByTestId('code-acp-terminal-stop')).toHaveCount(0)
    await expect(failedItem.getByTestId('code-acp-embedded-terminal')).toHaveCount(0)
    expect(delayedTerminalOutcomeResponses).toBe(3)
    await syncError.getByRole('button', { name: 'Retry' }).click()
    await expect(syncError).toHaveCount(0)
    await expect(failedItem.getByTestId('code-acp-terminal-output')).toContainText('failing-terminal-ready')
    await expect(failedItem.locator('.code-agent-transcript-terminal-meta')).toContainText('Exit 2')
    await expect(failedItem.getByText('Output', { exact: true })).toHaveCount(0)
  })

  test('shows terminal outcome recovery when no terminal snapshot could be loaded', async ({ page, workspaceRoot }) => {
    test.setTimeout(60_000)
    const workspace = path.join(workspaceRoot, 'acp-unavailable-terminal-detail')
    fs.mkdirSync(workspace, { recursive: true })
    const agentId = await createAcpAgent(page, workspace)
    await openFarming(page)
    await agentRow(page, agentId).click()

    let allowTerminalDetail = false
    await page.route('**/acp-tool-details/failing-terminal-tool', async route => {
      if (!allowTerminalDetail) {
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'terminal detail temporarily unavailable' }),
        })
        return
      }
      await route.continue()
    })

    await sendAcpMessage(page, 'failing terminal')
    const turn = page.locator('.code-agent-transcript-turn').filter({ hasText: 'failing terminal' }).last()
    const liveProcessSummary = turn.getByTestId('code-agent-transcript-process-summary')
    await expect(liveProcessSummary).toHaveAttribute('aria-expanded', 'false')
    await liveProcessSummary.click()
    await turn.getByTestId('code-agent-transcript-process-group-toggle').click()
    const runningItem = turn.getByTestId('code-agent-transcript-process-item')
      .filter({ hasText: 'Run failing command' })
    const toggle = runningItem.getByTestId('code-agent-transcript-process-item-toggle')
    await expect(toggle).toBeVisible({ timeout: 10_000 })
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')

    await expect(page.getByText('Failing terminal finished.', { exact: true })).toBeVisible({ timeout: 15_000 })
    const processSummary = turn.getByTestId('code-agent-transcript-process-summary')
    await expect(processSummary).toHaveAttribute('aria-expanded', 'false')
    await processSummary.click()
    const failedItem = turn.getByTestId('code-agent-transcript-process-item')
      .filter({ hasText: 'Run failing command' })
    const syncError = failedItem.getByTestId('code-acp-terminal-sync-error')
    await expect(syncError).toContainText('Terminal status could not be synchronized.', { timeout: 10_000 })
    await expect(failedItem).not.toContainText('Input\n')
    await expect(failedItem.locator('.code-agent-transcript-terminal')).toHaveCount(0)
    await expect(failedItem.getByTestId('code-acp-terminal-stop')).toHaveCount(0)

    allowTerminalDetail = true
    await syncError.getByRole('button', { name: 'Retry' }).click()
    await expect(syncError).toHaveCount(0)
    await expect(failedItem.getByTestId('code-acp-terminal-output')).toContainText('failing-terminal-ready')
    await expect(failedItem.locator('.code-agent-transcript-terminal-meta')).toContainText('Exit 2')
  })

  test('segments dense evidence around full commentary while keeping every detail folded', async ({ page, workspaceRoot }) => {
    test.setTimeout(60_000)
    const workspace = path.join(workspaceRoot, 'acp-dense-multi-step-progress')
    fs.mkdirSync(workspace, { recursive: true })
    const agentId = await createAcpAgent(page, workspace)
    await openFarming(page)
    await agentRow(page, agentId).click()

    await sendAcpMessage(page, 'dense multi-step progress')
    const turn = page.locator('.code-agent-transcript-turn').filter({ hasText: 'dense multi-step progress' }).last()
    const processSummary = turn.getByTestId('code-agent-transcript-process-summary')
    await expect(processSummary).toContainText(/Process|Working for/, { timeout: 10_000 })
    await expect(processSummary).toHaveAttribute('aria-expanded', 'false')
    const collapsedProgress = turn.getByTestId('code-acp-progress-update')
    await expect(collapsedProgress).toHaveCount(2, { timeout: 10_000 })
    await expect(collapsedProgress.last()).toContainText('The second verification phase passed; final checks are running.')
    const compactGroups = turn.getByTestId('code-agent-transcript-process-group')
    await expect(compactGroups).toHaveCount(3)
    expect(await turn.getByTestId('code-agent-transcript-process-compact-list').locator(
      ':scope > [data-testid="code-agent-transcript-process-group"], :scope > [data-testid="code-acp-progress-update"]',
    ).evaluateAll(elements => elements.map(element => element.getAttribute('data-testid')))).toEqual([
      'code-agent-transcript-process-group',
      'code-acp-progress-update',
      'code-agent-transcript-process-group',
      'code-acp-progress-update',
      'code-agent-transcript-process-group',
    ])
    expect(await compactGroups.getByTestId('code-agent-transcript-process-group-toggle').evaluateAll(
      toggles => toggles.map(toggle => toggle.getAttribute('aria-expanded')),
    )).toEqual(['false', 'false', 'false'])
    await processSummary.click()
    const groups = turn.getByTestId('code-agent-transcript-process-group')
    await expect(groups).toHaveCount(3)
    expect(await groups.getByTestId('code-agent-transcript-process-group-toggle').evaluateAll(
      toggles => toggles.map(toggle => toggle.getAttribute('aria-expanded')),
    )).toEqual(['false', 'false', 'false'])
    await expect(turn.getByTestId('code-agent-transcript-process-item')).toHaveCount(0)
    await expect(turn.getByTestId('code-acp-progress-update')).toHaveCount(2)
    const fullProgress = turn.getByTestId('code-acp-progress-update').last()
    expect((await fullProgress.boundingBox())?.height || 0).toBeGreaterThan(60)
    await expect(fullProgress).toContainText('The second verification phase passed; final checks are running.')
    await expect(fullProgress.getByRole('link', { name: 'Details' })).toBeVisible()
    const activeGroup = groups.nth(2)
    await activeGroup.getByTestId('code-agent-transcript-process-group-toggle').click()
    await expect(activeGroup.getByTestId('code-agent-transcript-process-group-toggle')).toHaveAttribute('aria-expanded', 'true')
    const activeAction = activeGroup.getByTestId('code-agent-transcript-process-item')
      .filter({ hasText: 'Run verification step 24' })
    const activeThought = activeGroup.locator(
      '[data-testid="code-agent-transcript-process-item"][data-type="thought"]',
    ).last()
    await expect(activeGroup.getByText('Reasoning', { exact: true })).toHaveCount(0)
    await expect(activeAction.getByTestId('code-agent-transcript-process-item-toggle')).toHaveAttribute('aria-expanded', 'false')
    await expect(activeThought.getByTestId('code-agent-transcript-process-item-toggle')).toHaveAttribute('aria-expanded', 'false')

    await expect(page.getByText('Dense multi-step progress complete.', { exact: true })).toBeVisible({ timeout: 15_000 })
    await expect(processSummary).toHaveAttribute('aria-expanded', 'false')
    await processSummary.click()
    await expect(turn.getByTestId('code-acp-progress-update')).toHaveCount(2)
    await expect(activeAction.getByTestId('code-agent-transcript-process-item-toggle')).toHaveAttribute('aria-expanded', 'false')
  })

  test('keeps a phase-marked rich answer visible after a trailing thought and renders encoded Mermaid source', async ({ page, workspaceRoot }) => {
    test.setTimeout(60_000)
    const workspace = path.join(workspaceRoot, 'acp-phase-aware-mermaid')
    fs.mkdirSync(workspace, { recursive: true })
    const agentId = await createAcpAgent(page, workspace)
    await openFarming(page)
    await agentRow(page, agentId).click()

    await sendAcpMessage(page, 'phase-aware mermaid')
    const turn = page.locator('.code-agent-transcript-turn').filter({ hasText: 'phase-aware mermaid' }).last()
    const answer = turn.locator('.code-agent-transcript-answer')
    await expect(answer).toContainText('Phase-aware rich answer.', { timeout: 15_000 })
    await expect(turn.getByTestId('code-agent-transcript-process-summary')).toHaveAttribute('aria-expanded', 'false')
    await expect(answer.locator('.code-markdown-mermaid')).toBeVisible({ timeout: 15_000 })
    await expect(answer.locator('.code-markdown-mermaid.error')).toHaveCount(0)
    await expect(turn).not.toHaveClass(/running/, { timeout: 15_000 })
    const diagram = answer.locator('.code-markdown-mermaid-canvas > svg')
    await expect(diagram).toBeVisible()
    const diagramId = await diagram.getAttribute('id')
    await page.waitForTimeout(2_500)
    await expect(diagram).toHaveAttribute('id', diagramId || '')

    const turnId = await turn.getAttribute('data-turn-id')
    expect(turnId).toBeTruthy()
    await page.evaluate((fault) => {
      window.__farmingLocalRenderFaults = [fault]
    }, `transcript-mermaid:${turnId}`)
    await turn.getByTestId('code-agent-transcript-process-summary').click()
    const mermaidError = turn.getByTestId('code-agent-transcript-mermaid-render-error')
    await expect(mermaidError).toBeVisible()
    await expect(answer).toContainText('Phase-aware rich answer.')
    await expect(page.getByTestId('app-error-fallback')).toHaveCount(0)

    await page.evaluate(() => {
      window.__farmingLocalRenderFaults = []
    })
    await mermaidError.getByRole('button', { name: 'Retry' }).click()
    await expect(answer.locator('.code-markdown-mermaid-canvas > svg')).toBeVisible({ timeout: 15_000 })
  })

  test('opens and stops a live ACP subagent without leaving the parent chat', async ({ page, workspaceRoot }) => {
    test.setTimeout(60_000)
    const workspace = path.join(workspaceRoot, 'acp-long-subagent')
    fs.mkdirSync(workspace, { recursive: true })
    const agentId = await createAcpAgent(page, workspace)
    await openFarming(page)
    await agentRow(page, agentId).click()

    await sendAcpMessage(page, 'long subagent')
    const turn = page.locator('.code-agent-transcript-turn').filter({ hasText: 'long subagent' }).last()
    const processSummary = turn.getByTestId('code-agent-transcript-process-summary')
    await expect(processSummary).toHaveAttribute('aria-expanded', 'false')
    await processSummary.click()
    await turn.getByTestId('code-agent-transcript-process-group-toggle').click()
    const item = turn.getByTestId('code-agent-transcript-process-item').filter({ hasText: 'Investigate with subagent' })
    await expect(item).toBeVisible({ timeout: 15_000 })
    await item.getByTestId('code-agent-transcript-process-item-toggle').click()
    const preview = item.getByTestId('code-agent-transcript-subagent')
    await expect(preview).toContainText('Inspect the long-running task', { timeout: 15_000 })
    await expect(preview).toContainText('Working')
    await preview.getByTestId('code-acp-subagent-fullscreen').click()
    const dialog = page.getByRole('dialog', { name: 'Subagent details' })
    await expect(dialog).toContainText('Checking the first candidate')
    await dialog.getByRole('button', { name: 'Close subagent details' }).click()
    await preview.getByTestId('code-acp-subagent-stop').click()
    await expect(page.getByText('Subagent stopped.', { exact: true })).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId('code-agent-chat-view')).toBeVisible()
    await expect(page.getByTestId('code-agent-terminal-view')).toHaveCount(0)
  })

  test('answers an ACP elicitation from a child session in the parent composer', async ({ page, workspaceRoot }) => {
    test.setTimeout(60_000)
    const workspace = path.join(workspaceRoot, 'acp-subagent-elicitation')
    fs.mkdirSync(workspace, { recursive: true })
    const agentId = await createAcpAgent(page, workspace)
    await openFarming(page)
    await agentRow(page, agentId).click()

    await sendAcpMessage(page, 'subagent elicitation')
    const elicitation = page.getByTestId('code-acp-elicitation')
    await expect(elicitation).toBeVisible({ timeout: 15_000 })
    await expect(elicitation).toContainText('Subagent · form')
    await expect(elicitation).toContainText('Confirm the subagent scope')
    await elicitation.getByRole('checkbox', { name: 'Confirmed for subagent' }).check()
    await elicitation.getByRole('button', { name: 'Submit' }).click()
    await expect(page.getByText('Subagent input complete.', { exact: true })).toBeVisible({ timeout: 15_000 })
    await expect(elicitation).toHaveCount(0)
  })

  test('completes terminal authentication inside ACP Chat and reconnects the same session', async ({ page, workspaceRoot }) => {
    test.setTimeout(60_000)
    const workspace = path.join(workspaceRoot, 'acp-terminal-authentication')
    fs.mkdirSync(workspace, { recursive: true })
    const agentId = await createAcpAgent(page, workspace)
    await openFarming(page)
    await agentRow(page, agentId).click()

    await sendAcpMessage(page, 'authentication error')
    const authentication = page.getByTestId('code-acp-authentication')
    await expect(authentication).toBeVisible({ timeout: 15_000 })
    const terminalMethod = authentication.locator('.code-acp-authentication-method').filter({ hasText: 'Sign in from terminal' })
    await expect(terminalMethod).toContainText('Exercises client terminal authentication.')
    await terminalMethod.getByRole('button', { name: 'Authenticate' }).click()

    const terminal = authentication.getByTestId('code-acp-auth-terminal')
    await expect(terminal).toBeVisible()
    await expect(terminal.getByTestId('code-acp-auth-terminal-output')).toContainText('fake-login>', { timeout: 15_000 })
    const input = terminal.getByRole('textbox', { name: 'Terminal sign-in input' })
    await input.fill('approved')
    await input.press('Enter')

    await expect(authentication).toHaveCount(0, { timeout: 20_000 })
    await expect(page.getByTestId('code-agent-chat-view')).toBeVisible()
    await expect(page.getByTestId('code-agent-terminal-view')).toHaveCount(0)
    await expect(page.getByText('Rich ACP timeline complete.', { exact: true })).toBeVisible({ timeout: 20_000 })
  })

  test('deduplicates a repeated provider error without hiding a distinct partial answer', async ({ page, workspaceRoot }) => {
    test.setTimeout(60_000)
    const workspace = path.join(workspaceRoot, 'acp-duplicate-provider-error')
    fs.mkdirSync(workspace, { recursive: true })
    const agentId = await createAcpAgent(page, workspace)
    await openFarming(page)
    await agentRow(page, agentId).click()

    await sendAcpMessage(page, 'duplicate provider error')
    const errorText = 'stream disconnected before completion: request to http://example.invalid/v1/responses failed'
    const errorTurn = page.locator('.code-agent-transcript-turn').filter({ hasText: 'duplicate provider error' })
    const errorSummary = errorTurn.getByTestId('code-agent-transcript-process-summary')
    await expect(errorSummary).toContainText('Agent error', { timeout: 10_000 })
    await errorSummary.click()
    await errorTurn.getByTestId('code-agent-transcript-process-group-toggle').click()
    await errorTurn.getByTestId('code-agent-transcript-process-item-toggle').click()
    expect((await errorTurn.innerText()).split(errorText).length - 1).toBe(1)
    await expect(errorTurn.getByTestId('code-agent-transcript-copy-answer')).toHaveCount(0)

    const partialWorkspace = path.join(workspaceRoot, 'acp-partial-provider-error')
    fs.mkdirSync(partialWorkspace, { recursive: true })
    const partialAgentId = await createAcpAgent(page, partialWorkspace)
    await agentRow(page, partialAgentId).click()
    await sendAcpMessage(page, 'partial provider error')
    const partialTurn = page.locator('.code-agent-transcript-turn').filter({ hasText: 'partial provider error' })
    await expect(partialTurn.locator('.code-agent-transcript-answer')).toContainText(
      'Partial result before the connection failed.',
      { timeout: 10_000 },
    )
    await expect(partialTurn.getByTestId('code-agent-transcript-process-summary')).toContainText('Agent error')
    await expect(partialTurn.getByTestId('code-agent-transcript-copy-answer')).toHaveCount(1)
  })

  test('reviews ACP file changes without patch decision controls', async ({ page, workspaceRoot }) => {
    test.setTimeout(60_000)
    const workspace = path.join(workspaceRoot, 'acp-patch-decisions')
    fs.mkdirSync(workspace, { recursive: true })
    fs.writeFileSync(path.join(workspace, 'decision-keep.txt'), 'before keep\n')
    fs.writeFileSync(path.join(workspace, 'decision-revert.txt'), 'before revert\n')
    const agentId = await createAcpAgent(page, workspace)
    await openFarming(page)
    await agentRow(page, agentId).click()

    await sendAcpMessage(page, 'applied edit')
    await expect(page.getByText('Applied edit complete.', { exact: true })).toBeVisible({ timeout: 15_000 })
    expect(fs.readFileSync(path.join(workspace, 'decision-keep.txt'), 'utf8')).toBe('after decision-keep.txt\n')
    expect(fs.readFileSync(path.join(workspace, 'decision-revert.txt'), 'utf8')).toBe('after decision-revert.txt\n')

    const turn = page.locator('.code-agent-transcript-turn').filter({ hasText: 'applied edit' }).last()
    await turn.getByRole('button', { name: /^Review:/ }).click()
    const review = page.getByRole('dialog', { name: 'Review' }).getByTestId('code-agent-transcript-result-details')
    await expect(review).toBeVisible()
    const keepFile = review.locator('.code-agent-transcript-change-review-file').filter({ hasText: 'decision-keep.txt' })
    const revertFile = review.locator('.code-agent-transcript-change-review-file').filter({ hasText: 'decision-revert.txt' })
    await expect(keepFile.getByRole('button', { name: 'Keep' })).toHaveCount(0)
    await expect(keepFile.getByRole('button', { name: 'Revert' })).toHaveCount(0)
    await expect(revertFile.getByRole('button', { name: 'Keep' })).toHaveCount(0)
    await expect(revertFile.getByRole('button', { name: 'Revert' })).toHaveCount(0)
    expect(fs.readFileSync(path.join(workspace, 'decision-keep.txt'), 'utf8')).toBe('after decision-keep.txt\n')
    expect(fs.readFileSync(path.join(workspace, 'decision-revert.txt'), 'utf8')).toBe('after decision-revert.txt\n')
  })

  test('uses ACP diffs in a non-Git workspace without an intermediate file list', async ({ page, workspaceRoot }) => {
    test.setTimeout(60_000)
    const workspace = path.join(workspaceRoot, 'acp-patch-many-files')
    fs.mkdirSync(workspace, { recursive: true })
    for (let index = 1; index <= 6; index += 1) {
      const target = path.join(workspace, 'src/features/very-long-feature-name', `decision-many-${index}.txt`)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, `before ${index}\n`)
    }
    const agentId = await createAcpAgent(page, workspace)
    await openFarming(page)
    await agentRow(page, agentId).click()

    await sendAcpMessage(page, 'deep path many applied edit')
    const turn = page.locator('.code-agent-transcript-turn').filter({ hasText: 'deep path many applied edit' }).last()
    await expect(turn.getByText('Applied edit complete.', { exact: true })).toBeVisible({ timeout: 15_000 })
    await turn.getByRole('button', { name: /^Review:/ }).click()
    const review = page.getByRole('dialog', { name: 'Review' }).getByTestId('code-agent-transcript-result-details')
    await expect(review.locator('.code-agent-transcript-change-review-file')).toHaveCount(6)
    const reviewViewport = await review.evaluate(element => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
    }))
    expect(reviewViewport.scrollHeight).toBeGreaterThan(reviewViewport.clientHeight)
    await expect(review.getByText('src/features/very-long-feature-name/decision-many-5.txt', { exact: true })).toBeVisible()
    await expect(review.locator('.code-agent-transcript-result-error')).toHaveCount(0)
    await expect(review.locator('.code-agent-transcript-result-diff').first()).toContainText(
      '+after src/features/very-long-feature-name/decision-many-1.txt',
    )
  })
})
