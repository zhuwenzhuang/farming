import fs from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { MAX_RETAINED_AGENT_VIEWS } from '../../src/components/code/agent-view-cache'
import { expect, openFarming, test } from './fixtures'

type ControlAgent = {
  id?: string
  runtimeEpoch?: string
}

async function createAgent(page: Page, workspace: string, command: string, agentRuntimeMode?: 'chat') {
  const response = await page.request.post('/farming/api/control/agents', {
    data: { command, workspace, agentRuntimeMode },
  })
  expect(response.ok()).toBeTruthy()
  const payload = await response.json() as { agentId?: string }
  expect(payload.agentId).toBeTruthy()
  return payload.agentId as string
}

async function controlAgent(page: Page, agentId: string) {
  const response = await page.request.get('/farming/api/control/agents')
  expect(response.ok()).toBeTruthy()
  const payload = await response.json() as { agents?: ControlAgent[] }
  return payload.agents?.find(agent => agent.id === agentId) ?? null
}

function largeTranscript(label: string) {
  return Array.from({ length: 20 }, (_, turnIndex) => ([
    {
      id: `${label}-user-${turnIndex}`,
      type: 'message',
      role: 'user',
      content: [{ type: 'text', text: `${label} cached question ${turnIndex}` }],
    },
    ...Array.from({ length: 50 }, (_, toolIndex) => ({
      id: `${label}-tool-${turnIndex}-${toolIndex}`,
      type: 'tool',
      kind: toolIndex % 2 === 0 ? 'read' : 'command',
      title: `${label} ${toolIndex % 2 === 0 ? 'Read file' : 'Ran command'} ${toolIndex}`,
      status: 'completed',
      transcriptDetail: `${label} tool ${toolIndex} output\n${`${label} bounded retained detail `.repeat(70)}`,
      content: [],
    })),
    {
      id: `${label}-answer-${turnIndex}`,
      type: 'message',
      role: 'assistant',
      _meta: { codex: { phase: 'final_answer' } },
      content: [{
        type: 'text',
        text: `${label} cached answer ${turnIndex}. ${`${label} retained frontend state. `.repeat(6)}`,
      }],
    },
  ])).flat()
}

test('bounds one shared Chat and Terminal frontend cache and restores evicted views', async ({ page, workspaceRoot }) => {
  test.setTimeout(90_000)
  const workspace = path.join(workspaceRoot, 'agent-view-cache-eviction')
  fs.mkdirSync(workspace, { recursive: true })

  const firstChatAgentId = await createAgent(page, workspace, 'claude', 'chat')
  const secondChatAgentId = await createAgent(page, workspace, 'opencode', 'chat')
  const terminalAgentIds: string[] = []
  for (let index = 0; index < MAX_RETAINED_AGENT_VIEWS - 1; index += 1) {
    const terminalWorkspace = path.join(workspace, `terminal-${index}`)
    fs.mkdirSync(terminalWorkspace, { recursive: true })
    terminalAgentIds.push(await createAgent(page, terminalWorkspace, 'bash'))
  }

  const transcriptEntries = new Map([
    [firstChatAgentId, largeTranscript('FIRST')],
    [secondChatAgentId, largeTranscript('SECOND')],
  ])
  for (const entries of transcriptEntries.values()) {
    expect(entries.filter(entry => entry.type === 'tool')).toHaveLength(1_000)
    expect(Buffer.byteLength(JSON.stringify(entries))).toBeGreaterThan(1.5 * 1024 * 1024)
  }
  const fullTranscriptLoads = new Map([
    [firstChatAgentId, 0],
    [secondChatAgentId, 0],
  ])
  for (const [agentId, entries] of transcriptEntries) {
    await page.route(new RegExp(`/farming/api/agents/${agentId}/acp-transcript(?:\\?.*)?$`), async route => {
      const sinceRevision = new URL(route.request().url()).searchParams.get('sinceRevision')
      if (sinceRevision === null) {
        fullTranscriptLoads.set(agentId, (fullTranscriptLoads.get(agentId) ?? 0) + 1)
      }
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          transcript: {
            sessionId: `cache-${agentId}`,
            state: 'idle',
            revision: 1,
            delta: sinceRevision !== null,
            entries: sinceRevision === null ? entries : [],
          },
        }),
      })
    })
  }

  await openFarming(page)
  const firstChatRow = page.locator(
    `[data-testid="code-agent-row"][data-agent-id="${firstChatAgentId}"]`,
  )
  await firstChatRow.click()
  const firstChatPane = page.locator(
    `[data-testid="code-agent-work-pane"][data-agent-id="${firstChatAgentId}"]`,
  )
  await expect(firstChatPane.getByText('FIRST cached answer 19.', { exact: false })).toBeVisible()
  await firstChatPane.evaluate(element => {
    element.dataset.cacheProbe = 'original-chat-dom'
  })
  expect(fullTranscriptLoads.get(firstChatAgentId)).toBe(1)

  const terminalMarker = '__FARMING_VIEW_CACHE_TERMINAL__'
  let firstTerminalEpoch = ''
  for (const [index, agentId] of terminalAgentIds.entries()) {
    await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
    await expect(page.locator(
      `[data-testid="code-terminal-pane"][data-agent-id="${agentId}"]`,
    )).toBeVisible()
    await expect.poll(() => page.evaluate(id => (
      window.__farmingTerminalTest?.getHostDiagnostics().some(host => host.agentId === id) ?? false
    ), agentId)).toBe(true)
    if (index === 0) {
      const inputResponse = await page.request.post(
        `/farming/api/control/agents/${agentId}/input`,
        { data: { input: `printf '${terminalMarker}\\n'\r` } },
      )
      expect(inputResponse.ok()).toBeTruthy()
      await expect.poll(async () => {
        const outputResponse = await page.request.get(
          `/farming/api/control/agents/${agentId}/output?tail=4000`,
        )
        return outputResponse.ok() && (await outputResponse.text()).includes(terminalMarker)
      }).toBe(true)
      firstTerminalEpoch = (await controlAgent(page, agentId))?.runtimeEpoch ?? ''
      expect(firstTerminalEpoch).not.toBe('')
    }
  }

  await expect(page.getByTestId('code-agent-work-pane')).toHaveCount(MAX_RETAINED_AGENT_VIEWS)
  await expect.poll(() => page.evaluate(agentId => (
    window.__farmingTerminalTest?.getHostDiagnostics().some(host => host.agentId === agentId) ?? false
  ), terminalAgentIds[0])).toBe(true)

  await page.locator(
    `[data-testid="code-agent-row"][data-agent-id="${secondChatAgentId}"]`,
  ).click()
  await expect(page.locator(
    `[data-testid="code-agent-work-pane"][data-agent-id="${secondChatAgentId}"]`,
  ).getByText('SECOND cached answer 19.', { exact: false })).toBeVisible()
  await expect(page.getByTestId('code-agent-work-pane')).toHaveCount(MAX_RETAINED_AGENT_VIEWS)
  await expect(firstChatPane).toHaveCount(0)
  expect(fullTranscriptLoads.get(firstChatAgentId)).toBe(1)
  await expect.poll(() => page.evaluate(agentId => (
    window.__farmingTerminalTest?.getHostDiagnostics().some(host => host.agentId === agentId) ?? false
  ), terminalAgentIds[0])).toBe(true)

  await firstChatRow.click()
  const restoredChatPane = page.locator(
    `[data-testid="code-agent-work-pane"][data-agent-id="${firstChatAgentId}"]`,
  )
  await expect(restoredChatPane.getByText('FIRST cached answer 19.', { exact: false })).toBeVisible()
  await expect.poll(() => fullTranscriptLoads.get(firstChatAgentId)).toBe(2)
  await expect(restoredChatPane).not.toHaveAttribute('data-cache-probe', 'original-chat-dom')
  await expect(page.getByTestId('code-agent-work-pane')).toHaveCount(MAX_RETAINED_AGENT_VIEWS)
  await expect.poll(() => page.evaluate(agentId => (
    window.__farmingTerminalTest?.getHostDiagnostics().some(host => host.agentId === agentId) ?? false
  ), terminalAgentIds[0])).toBe(false)
  const evictedTerminalAgent = await controlAgent(page, terminalAgentIds[0])
  expect(evictedTerminalAgent?.runtimeEpoch).toBe(firstTerminalEpoch)

  await page.locator(
    `[data-testid="code-agent-row"][data-agent-id="${terminalAgentIds[0]}"]`,
  ).click()
  await expect(page.locator(
    `[data-testid="code-terminal-pane"][data-agent-id="${terminalAgentIds[0]}"]`,
  )).toBeVisible()
  await expect.poll(() => page.evaluate(agentId => (
    window.__farmingTerminalTest?.getHostDiagnostics().some(host => (
      host.agentId === agentId && host.recordAttached && !host.inParkingLot
    )) ?? false
  ), terminalAgentIds[0])).toBe(true)
  await expect.poll(() => page.evaluate(({ agentId, marker }) => (
    window.__farmingTerminalTest?.getRows(agentId, 20).join('\n').includes(marker) ?? false
  ), { agentId: terminalAgentIds[0], marker: terminalMarker })).toBe(true)
  expect((await controlAgent(page, terminalAgentIds[0]))?.runtimeEpoch).toBe(firstTerminalEpoch)
  await expect(page.getByTestId('code-agent-work-pane')).toHaveCount(MAX_RETAINED_AGENT_VIEWS)
})
