import fs from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { expect, openFarming, test } from './fixtures'

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

async function openTerminal(page: Page, agentId: string) {
  const row = codeAgentRow(page, agentId)
  await expect(row).toBeVisible({ timeout: 30_000 })
  await row.click()
  await expect(terminalHost(page, agentId)).toBeVisible({ timeout: 15_000 })
  await page.waitForFunction(id => Boolean(window.__farmingTerminalTest?.isReady(id)), agentId)
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

test('terminal typing stays small and direct after switching an existing agent', async ({ page, workspaceRoot }) => {
  const workspace = path.join(workspaceRoot, 'terminal-input-performance')
  fs.mkdirSync(workspace, { recursive: true })
  const firstAgentId = await createBashAgent(page, workspace)
  const secondAgentId = await createBashAgent(page, workspace)
  const messages = trackTerminalWire(page)

  await openFarming(page)
  await openTerminal(page, firstAgentId)
  await openTerminal(page, secondAgentId)
  // Let the two fresh PTYs finish their initial state/snapshot publication.
  // The assertion below is about an established Agent switch, not startup.
  await page.waitForTimeout(1_000)

  const focusStart = messages.length
  await codeAgentRow(page, firstAgentId).click()
  await expect(terminalHost(page, firstAgentId)).toBeVisible({ timeout: 15_000 })
  await page.waitForTimeout(350)

  const afterFocus = messages.slice(focusStart)
  expect(afterFocus.filter(message => message.direction === 'sent' && message.type === 'focus-agent'))
    .toEqual(expect.arrayContaining([expect.objectContaining({ agentId: firstAgentId })]))
  expect(afterFocus.filter(message => message.direction === 'received' && message.type === 'state')).toHaveLength(0)

  const input = terminalHost(page, firstAgentId).locator('.xterm-helper-textarea')
  await expect(input).toHaveCount(1)
  await input.focus()

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
  }

  const keyToOutputP95Ms = p95(samples)
  test.info().annotations.push({
    type: 'terminal-input-performance',
    description: `key-to-session-output p95=${keyToOutputP95Ms}ms samples=${samples.join(',')}ms`,
  })
  console.log(`terminal-input-performance key-to-session-output p95=${keyToOutputP95Ms}ms samples=${samples.join(',')}ms`)
  expect(keyToOutputP95Ms).toBeLessThanOrEqual(LOCAL_KEY_TO_OUTPUT_P95_MS)
  await page.waitForTimeout(600)
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
