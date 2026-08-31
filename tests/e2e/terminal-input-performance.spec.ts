import fs from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { expect, openFarming, test, terminalCheckpointOutput } from './fixtures'

const LOCAL_KEY_TO_OUTPUT_P95_MS = 250
const FOCUSED_PREVIEW_MAX_BYTES = 8 * 1024

type TerminalWireMessage = {
  at: number
  direction: 'sent' | 'received'
  type?: string
  agentId?: string
  input?: string
  preview?: { agentId?: string; previewSnapshot?: unknown }
  stream?: { agentId?: string }
  activity?: { agentId?: string }
  bytes: number
}

async function createBashAgent(page: Page, workspace: string) {
  const response = await page.request.post('/farming/api/control/agents', {
    data: { command: 'bash', workspace },
  })
  expect(response.ok()).toBeTruthy()
  const body = await response.json() as { agentId?: string }
  expect(body.agentId).toBeTruthy()
  return body.agentId as string
}

function codeAgentRow(page: Page, agentId: string) {
  return page.locator(
    `[data-testid="code-agent-row"][data-agent-id="${agentId}"], ` +
    `[data-testid="code-project-agent-compact"][data-agent-id="${agentId}"], ` +
    `[data-testid="code-pinned-agent-compact"][data-agent-id="${agentId}"]`,
  ).first()
}

function terminalHost(page: Page, agentId: string) {
  return page.locator(`[data-testid="code-terminal-pane"][data-agent-id="${agentId}"] .terminal-session-host[data-agent-id="${agentId}"]`)
}

async function clickReadyTerminalInput(page: Page, agentId: string) {
  const host = terminalHost(page, agentId)
  await expect(host).not.toHaveClass(/terminal-checkpoint-installing/, { timeout: 15_000 })
  await expect(page.locator(`[data-testid="code-terminal-pane"][data-agent-id="${agentId}"] [data-testid="code-terminal-recovery"]`))
    .toHaveCount(0, { timeout: 15_000 })

  const screen = host.locator('.xterm-screen')
  await expect(screen).toBeVisible()
  await screen.click({ position: { x: 8, y: 8 } })

  const input = host.locator('.xterm-helper-textarea')
  await expect(input).toHaveCount(1)
  await expect.poll(() => input.evaluate(element => document.activeElement === element))
    .toBe(true)
  return input
}

async function openTerminal(page: Page, agentId: string) {
  const row = codeAgentRow(page, agentId)
  await expect(row).toBeVisible({ timeout: 30_000 })
  await row.click()
  await expect(terminalHost(page, agentId)).toBeVisible({ timeout: 15_000 })
  await page.waitForFunction(id => Boolean(window.__farmingTerminalTest?.isReady(id)), agentId)
}

async function waitForEstablishedTerminal(page: Page, agentId: string) {
  await expect.poll(() => page.evaluate(id => {
    const diagnostics = window.__farmingTerminalTest?.getBufferDiagnostics(id) as unknown as {
      checkpointRequestInFlight?: boolean
      pendingSnapshotReplay?: boolean
      replayInProgress?: boolean
    } | null
    return Boolean(
      window.__farmingTerminalTest?.isReady(id)
      && diagnostics
      && (diagnostics.checkpointRequestInFlight ?? false) === false
      && (diagnostics.pendingSnapshotReplay ?? false) === false
      && (diagnostics.replayInProgress ?? false) === false,
    )
  }, agentId), { timeout: 15_000, intervals: [25, 50, 100, 200] }).toBe(true)
}

function trackTerminalWire(page: Page) {
  const messages: TerminalWireMessage[] = []
  page.on('websocket', socket => {
    const record = (direction: TerminalWireMessage['direction'], payload: string | Buffer) => {
      const text = Buffer.isBuffer(payload) ? payload.toString('utf8') : payload
      try {
        const parsed = JSON.parse(text) as Omit<TerminalWireMessage, 'at' | 'direction' | 'bytes'>
        messages.push({
          at: Date.now(),
          direction,
          type: parsed.type,
          agentId: parsed.agentId ?? parsed.stream?.agentId ?? parsed.activity?.agentId,
          input: parsed.input,
          preview: parsed.preview,
          stream: parsed.stream,
          activity: parsed.activity,
          bytes: Buffer.byteLength(text),
        })
      } catch {
        // Ignore non-Farming browser traffic.
      }
    }
    socket.on('framesent', frame => record('sent', frame.payload))
    socket.on('framereceived', frame => record('received', frame.payload))
  })
  return messages
}

async function waitForWireMessage(
  page: Page,
  messages: TerminalWireMessage[],
  from: number,
  predicate: (message: TerminalWireMessage) => boolean,
) {
  await expect.poll(
    () => messages.slice(from).some(predicate),
    { timeout: 1_000, intervals: [10, 20, 40, 80] },
  ).toBe(true)
  const message = messages.slice(from).find(predicate)
  if (!message) throw new Error('Expected terminal WebSocket message disappeared')
  return message
}

function p95(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? Infinity
}

test('foreground input remains measurable with eight background output producers', async ({ page, workspaceRoot }) => {
  test.setTimeout(90_000)
  const workspace = path.join(workspaceRoot, 'terminal-background-performance')
  fs.mkdirSync(workspace, { recursive: true })
  const producers: string[] = []
  for (let i = 0; i < 8; i++) producers.push(await createBashAgent(page, workspace))
  const foreground = await createBashAgent(page, workspace)
  await openFarming(page)
  await openTerminal(page, foreground)
  await clickReadyTerminalInput(page, foreground)
  for (const id of producers) {
    const response = await page.request.post(`/farming/api/control/agents/${id}/input`, { data: {
      input: 'i=0; while [ "$i" -lt 80 ]; do printf "BACKGROUND_OUTPUT_%04d abcdefghijklmnopqrstuvwxyz\\n" "$i"; i=$((i+1)); sleep 0.1; done\n',
    } })
    expect(response.ok()).toBeTruthy()
  }
  await Promise.all(producers.map(id => expect.poll(() => terminalCheckpointOutput(page, id)).toContain('BACKGROUND_OUTPUT_0002')))
  const before = await page.evaluate(() => window.farmingPerformance!.snapshot().records.map(record => record.id))
  await page.keyboard.type('foreground', { delay: 45 })
  for (let i = 0; i < 10; i++) await page.keyboard.press('Backspace')
  await expect.poll(() => page.evaluate(ids => window.farmingPerformance!.snapshot().records.filter(record => (
    !ids.includes(record.id) && record.operation === 'terminal.input' && record.outcome === 'observed'
  )).length, before)).toBeGreaterThanOrEqual(20)
  const records = await page.evaluate(ids => window.farmingPerformance!.snapshot().records.filter(record => (
    !ids.includes(record.id) && record.operation === 'terminal.input' && record.outcome === 'observed'
  )), before)
  console.log(`terminal with 8 background producers: event-to-frame p95=${p95(records.map(record => record.durationMs))}ms n=${records.length}`)
  expect(p95(records.map(record => record.durationMs))).toBeLessThanOrEqual(250)
  await expect.poll(async () => {
    const response = await page.request.get('/farming/api/diagnostics/performance')
    const body = await response.json() as { records: Array<{ operation: string; target?: string; metrics: { outputChunks?: number } }> }
    return body.records.filter(record => record.operation === 'runtime.sample' && record.target && (record.metrics.outputChunks || 0) > 0).length
  }, { timeout: 10_000 }).toBeGreaterThanOrEqual(8)
})

test('terminal typing stays small and direct after switching an existing agent', async ({ page, workspaceRoot }) => {
  const workspace = path.join(workspaceRoot, 'terminal-input-performance')
  fs.mkdirSync(workspace, { recursive: true })
  const firstAgentId = await createBashAgent(page, workspace)
  const secondAgentId = await createBashAgent(page, workspace)
  const messages = trackTerminalWire(page)

  await openFarming(page)
  await openTerminal(page, firstAgentId)
  await openTerminal(page, secondAgentId)
  await expect.poll(() => page.evaluate(() => window.farmingPerformance?.snapshot().records.some(record => (
    record.operation === 'connection.probe' && record.outcome === 'completed' && record.stages.received !== undefined
  )))).toBe(true)
  // Measure a genuine Agent switch only after both PTYs have reached their
  // authoritative idle state, never during their initial snapshot traffic.
  await Promise.all([
    waitForEstablishedTerminal(page, firstAgentId),
    waitForEstablishedTerminal(page, secondAgentId),
  ])

  const focusStart = messages.length
  await codeAgentRow(page, firstAgentId).click()
  await expect(terminalHost(page, firstAgentId)).toBeVisible({ timeout: 15_000 })
  await expect.poll(() => messages.slice(focusStart).some(message => (
    message.direction === 'sent'
    && message.type === 'focus-agent'
    && message.agentId === firstAgentId
  )), { timeout: 1_000, intervals: [10, 20, 40, 80] }).toBe(true)

  const afterFocus = messages.slice(focusStart)
  expect(afterFocus.filter(message => message.direction === 'sent' && message.type === 'focus-agent'))
    .toEqual(expect.arrayContaining([expect.objectContaining({ agentId: firstAgentId })]))
  expect(afterFocus.filter(message => message.direction === 'received' && message.type === 'state')).toHaveLength(0)
  expect(afterFocus.filter(message => message.direction === 'received' && message.type === 'state-delta')).toHaveLength(0)

  // Exercise the same path as a person: wait until the authoritative screen
  // has finished installing, click the visible xterm surface, and prove that
  // xterm moved focus to its native input before measuring key-to-PTY latency.
  await clickReadyTerminalInput(page, firstAgentId)

  const samples: number[] = []
  const typingStart = messages.length
  for (const key of ['a', 'b', 'c', 'd', 'Backspace', 'Backspace', 'Backspace', 'Backspace']) {
    const inputCountBefore = await page.evaluate(
      id => window.__farmingTerminalTest?.getInputCount(id) ?? 0,
      firstAgentId,
    )
    const frameStart = messages.length
    const startedAt = Date.now()
    await page.keyboard.press(key)
    await expect.poll(() => page.evaluate(
      id => window.__farmingTerminalTest?.getInputCount(id) ?? 0,
      firstAgentId,
    ), { timeout: 1_000 }).toBeGreaterThan(inputCountBefore)

    const output = await waitForWireMessage(
      page, messages, frameStart,
      message => message.direction === 'received' && message.type === 'session-output' && message.agentId === firstAgentId,
    )
    samples.push(output.at - startedAt)
    expect(messages.slice(frameStart).filter(message => message.direction === 'received' && message.type === 'state')).toHaveLength(0)
    expect(messages.slice(frameStart).filter(message => (
      message.direction === 'received' && message.type === 'state-delta'
    ))).toHaveLength(0)
  }

  const keyToOutputP95Ms = p95(samples)
  test.info().annotations.push({
    type: 'terminal-input-performance',
    description: `key-to-session-output p95=${keyToOutputP95Ms}ms samples=${samples.join(',')}ms`,
  })
  console.log(`terminal-input-performance key-to-session-output p95=${keyToOutputP95Ms}ms samples=${samples.join(',')}ms`)
  expect(keyToOutputP95Ms).toBeLessThanOrEqual(LOCAL_KEY_TO_OUTPUT_P95_MS)
  await expect.poll(() => page.evaluate(() => window.farmingPerformance?.snapshot().records.filter(record => (
    record.operation === 'terminal.input' && record.outcome === 'observed' && record.stages.frame !== undefined
  )).length ?? 0)).toBeGreaterThanOrEqual(8)
  const interactions = await page.evaluate(() => window.farmingPerformance!.snapshot().records.filter(record => record.operation === 'terminal.input'))
  const painted = interactions.filter(record => record.outcome === 'observed')
  for (const record of painted) {
    expect(record.stages.sent).toBeLessThanOrEqual(record.stages.output!)
    expect(record.stages.output).toBeLessThanOrEqual(record.stages.renderer!)
    expect(record.stages.renderer).toBeLessThanOrEqual(record.stages.frame!)
    expect(record).not.toHaveProperty('input')
  }
  const diagnosticResponse = await page.request.get('/farming/api/diagnostics/performance')
  expect(diagnosticResponse.ok()).toBeTruthy()
  const serverDiagnostics = await diagnosticResponse.json() as { records: Array<{ source: string; id: string; operation: string; stages: Record<string, number> }> }
  expect(serverDiagnostics.records.some(record => record.source === 'server' && painted.some(client => client.id === record.id))).toBeTruthy()
  console.log(`terminal-input-performance event-to-frame p95=${p95(painted.map(record => record.durationMs))}ms n=${painted.length}`)
  await expect.poll(() => messages.slice(typingStart).filter(message => (
    message.direction === 'received'
    && message.type === 'session-preview'
    && message.preview?.agentId === firstAgentId
  )).length, { timeout: 1_000, intervals: [10, 20, 40, 80] }).toBeGreaterThan(0)
  const focusedPreviews = messages.slice(typingStart).filter(message => (
    message.direction === 'received'
    && message.type === 'session-preview'
    && message.preview?.agentId === firstAgentId
  ))
  expect(focusedPreviews.length).toBeGreaterThan(0)
  focusedPreviews.forEach(preview => {
    expect(preview.bytes).toBeLessThan(FOCUSED_PREVIEW_MAX_BYTES)
    expect(preview.preview?.previewSnapshot).toBeNull()
  })
})
