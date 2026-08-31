import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Page, TestInfo } from '@playwright/test'
import { expect, openFarming, test } from '../fixtures'

// This gate runs against a real Codex account, so every billed turn must stay
// on one fixed low-cost model. LAUNCH_MODEL is only selected to prove a live
// model switch; the switch below completes before the first prompt is sent, and
// each surface re-checks provider truth before it spends anything.
const PRIMARY_MODEL = 'gpt-5.6-luna'
const PRIMARY_EFFORT = 'low'
const LAUNCH_MODEL = 'gpt-5.6-terra'
const CLI_BEGIN = 'CLI_FLOW_BEGIN_7F3A'
const CLI_END = 'CLI_FLOW_END_7F3A'
const COMPOSITE_BEGIN = 'COMPOSITE_BEGIN_7F3A'
const COMPOSITE_END = 'COMPOSITE_END_7F3A'
const RELEASE_SMOKE_REQUEST = 'RELEASE_SMOKE_REQUEST_7F3A'
const RELEASE_SMOKE_END = 'RELEASE_SMOKE_END_7F3A'
const CRT_TERMINAL_ACK = 'CRT_TERMINAL_ACK_7F3A'
const CRT_MSG_ACK = 'CRT_MSG_ACK_7F3A'
const ACP_FOLLOW_UP_ACK = 'ACP_FOLLOW_UP_ACK_7F3A'
const RUNNING_SWITCH_END = 'RUNNING_SWITCH_END_7F3A'
const ANCHOR_SUFFIX = '7F3A'
const NORMAL_VIEWPORT = { width: 1440, height: 900 }
const COMPACT_VIEWPORT = { width: 1080, height: 650 }
// Runtime switching verifies the provider session through the normal history
// inventory, which intentionally excludes temporary-directory workspaces.
// Keep this explicit release fixture under the user's home and remove this
// exact process-owned directory in afterAll.
const REAL_CODEX_WORKSPACE = path.join(
  os.homedir(),
  `.farming-release-e2e-real-codex-${process.pid}`,
)

type PublicAgent = {
  id: string
  runtimeBinding?: { kind?: string }
  providerSessionId?: string
  providerSessionTemporary?: boolean
  terminalBusy?: boolean | null
  terminalStatus?: { activity?: string }
  acpState?: string
  status?: string
}

type CodexCatalogModel = {
  value: string
  displayName?: string
  description?: string
  defaultEffort?: string
  reasoningLevels?: Array<{ value: string, label?: string }>
}

type AcpSessionConfigOption = {
  id?: string
  name?: string
  category?: string
  type?: string
  currentValue?: unknown
}

type CodeTerminalDiagnostics = {
  renderer?: string
  cols: number
  rows: number
  scrollbackLength: number
  resizeNotificationCount?: number
  fitResizeTimerPending?: boolean
  resizeRequestInFlight?: { cols: number, rows: number } | null
  pendingResizeRequest?: { cols: number, rows: number } | null
  checkpointRequestInFlight?: boolean
  replayTargetRevision?: number | null
  replayInProgress?: boolean
  bootstrappingSnapshot?: boolean
  pendingSnapshotReplay?: boolean
}

type CrtTerminalState = {
  runtimeEpoch: string
  outputSeq: number
  stateRevision: number
  cols: number
  rows: number
  replaying: boolean
  writeInProgress: boolean
  checkpointInFlight: boolean
  checkpointInstallInProgress: boolean
  queuedTransitionCount: number
  pendingFitResize: { cols: number, rows: number } | null
  fitResizeTimerPending: boolean
}

type CrtTerminalGeometry = {
  cols: number
  rows: number
  proposedCols: number
  proposedRows: number
  baseY: number
  viewportY: number
}

declare global {
  interface Window {
    __farmingCrtTerminalTest?: {
      getState: () => CrtTerminalState | null
      getRows: () => string[]
      getGeometry: () => CrtTerminalGeometry
    }
  }
}

function oneLine(value: string) {
  return value.replace(/\s+/g, ' ').trim()
}

const CLI_PROMPT = oneLine(`
  Do not use tools, inspect files, or explain the task. Reply with plain text only.
  The first line must concatenate CLI_FLOW_BEGIN_ and ${ANCHOR_SUFFIX}, with no
  separator. Then print 48 separate lines, numbered from
  CLI_PAGE_LINE_01 through CLI_PAGE_LINE_48, one token per line. After them print
  CLI_JSON {"route":"terminal","ok":true}, then CLI_CJK 中文终端正常, and make the
  final line by concatenating CLI_FLOW_END_ and ${ANCHOR_SUFFIX}, with no separator.
  Do not omit or combine lines.
`)

const RUNNING_SWITCH_PROMPT = oneLine(`
  Use the terminal tool to run exactly this command and wait for it to finish:
  for i in $(seq 1 300); do echo REAL_CODEX_RUNNING_SWITCH_$i; sleep 0.1; done
  After it finishes, reply with only ${RUNNING_SWITCH_END}. Do not do anything else.
`)

const COMPOSITE_PROMPT = `Do not use tools or inspect files. Return only the requested Markdown, with no introduction or conclusion. Do not wrap the whole response in one code fence.

Start with a standalone line formed by concatenating COMPOSITE_BEGIN_ and ${ANCHOR_SUFFIX}, with no separator.

# RELEASE_HEADING_7F3A

Write one paragraph containing INLINE_CODE_7F3A as inline code and https://example.invalid/release-case as a link.

## RELEASE_LISTS_7F3A

- BULLET_ALPHA_7F3A
- BULLET_BETA_7F3A

1. ORDERED_ONE_7F3A
2. ORDERED_TWO_7F3A

- [x] TASK_DONE_7F3A
- [ ] TASK_OPEN_7F3A

> QUOTE_FORMAT_7F3A

| kind | anchor |
| --- | --- |
| table | TABLE_FORMAT_7F3A |

Write a JSON fenced block containing exactly {"kind":"json","anchor":"JSON_FORMAT_7F3A"}.
Write a YAML fenced block containing two lines: kind: yaml and anchor: YAML_FORMAT_7F3A.
Write a diff fenced block containing one removed line -old DIFF_OLD_7F3A and one added line +new DIFF_NEW_7F3A.
Write a shell fenced block containing printf 'SHELL_FORMAT_7F3A\\n'.
Write one standalone line CJK_FORMAT_7F3A 中文显示正常.
Write one standalone line EMOJI_FORMAT_7F3A [OK].

Then produce six sections named exactly PAGE_01_7F3A through PAGE_06_7F3A. Under every section print 18 separate plain lines. For example, PAGE_01 must contain PAGE_01_LINE_01 through PAGE_01_LINE_18, and PAGE_06 must contain PAGE_06_LINE_01 through PAGE_06_LINE_18. Never abbreviate a range and never combine two tokens on one line.

The final standalone line must concatenate COMPOSITE_END_ and ${ANCHOR_SUFFIX}, with no separator.`

const ACP_LONG_PROMPT = `Do not use tools or inspect files. First print ACP_LONG_BEGIN_${ANCHOR_SUFFIX}. Then write 80 separate numbered lines, one token per line, from ACP_LONG_LINE_001 through ACP_LONG_LINE_080. Do not abbreviate or combine lines.`

function resizePath(from: { width: number, height: number }, to: { width: number, height: number }, steps = 8) {
  return Array.from({ length: steps }, (_, index) => {
    const progress = (index + 1) / steps
    return {
      width: Math.round(from.width + ((to.width - from.width) * progress)),
      height: Math.round(from.height + ((to.height - from.height) * progress)),
    }
  })
}

async function attachScreenshot(page: Page, testInfo: TestInfo, name: string) {
  await testInfo.attach(name, {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  })
}

async function agents(page: Page) {
  const response = await page.request.get('/farming/api/control/agents')
  expect(response.ok()).toBeTruthy()
  const body = await response.json() as { agents?: PublicAgent[] }
  return body.agents ?? []
}

async function agent(page: Page, agentId: string) {
  return (await agents(page)).find(candidate => candidate.id === agentId) ?? null
}

async function waitForAgent(
  page: Page,
  agentId: string,
  predicate: (current: PublicAgent) => boolean,
  timeout = 90_000,
) {
  await expect.poll(async () => {
    const current = await agent(page, agentId)
    return Boolean(current && predicate(current))
  }, { timeout }).toBe(true)
  const current = await agent(page, agentId)
  if (!current) throw new Error(`Agent ${agentId} disappeared`)
  return current
}

async function codeRows(page: Page, agentId: string) {
  return page.evaluate(id => window.__farmingTerminalTest?.getRows(id, 10_000) ?? [], agentId)
}

async function codeDiagnostics(page: Page, agentId: string) {
  return page.evaluate(
    id => window.__farmingTerminalTest?.getBufferDiagnostics(id) as CodeTerminalDiagnostics | null,
    agentId,
  )
}

async function waitForCodeTerminal(page: Page, agentId: string) {
  const pane = page.locator(`[data-testid="code-terminal-pane"][data-agent-id="${agentId}"]`)
  await expect(pane).toBeVisible({ timeout: 30_000 })
  await page.waitForFunction(id => Boolean(window.__farmingTerminalTest?.isReady(id)), agentId, { timeout: 30_000 })
  await expect.poll(async () => (await codeDiagnostics(page, agentId))?.renderer, { timeout: 30_000 }).toBe('webgl')
  await expect(pane.getByTestId('code-terminal-status-card')).toHaveCount(0)
}

async function continueWithoutUntrustedHooks(page: Page, agentId: string) {
  const input = page.locator(
    `[data-testid="code-terminal-pane"][data-agent-id="${agentId}"] .terminal-session-host[data-agent-id="${agentId}"] .xterm-helper-textarea`,
  )
  let directoryTrustAccepted = false
  let hooksAccepted = false
  let updateSkipped = false
  for (let transition = 0; transition < 4; transition += 1) {
    let startupState = 'waiting'
    await expect.poll(async () => {
      const rendered = (await codeRows(page, agentId)).join('\n')
      const current = await agent(page, agentId)
      if (current?.terminalStatus?.activity === 'idle') {
        startupState = 'ready'
      } else if (!updateSkipped && rendered.includes('Update available!') && rendered.includes('Skip until next version')) {
        startupState = 'update'
      } else if (!hooksAccepted && rendered.includes('Hooks need review')) {
        startupState = 'hooks'
      } else if (!directoryTrustAccepted && rendered.includes('Do you trust the contents of this directory?')) {
        startupState = 'directory-trust'
      } else {
        startupState = 'waiting'
      }
      return startupState
    }, { timeout: 60_000 }).toMatch(/^(ready|directory-trust|hooks|update)$/)
    if (startupState === 'ready') return

    await input.focus()
    if (startupState === 'update') {
      // A newer verified Terminal executable can supersede the no-update test
      // wrapper. Skip this one prompt through its real UI; never install an
      // update or change the user's persistent update preferences during a gate.
      const selectedOption = async () => (await codeRows(page, agentId))
        .find(row => row.includes('›'))?.match(/›\s*([123])\./)?.[1] ?? ''
      await expect.poll(selectedOption, { timeout: 5_000 }).toMatch(/^[123]$/)
      for (let move = 0; move < 2 && await selectedOption() !== '2'; move += 1) {
        const before = await selectedOption()
        await input.press('ArrowDown')
        await expect.poll(selectedOption, { timeout: 5_000 }).not.toBe(before)
      }
      await expect.poll(selectedOption, { timeout: 5_000 }).toBe('2')
      await input.press('Enter')
      updateSkipped = true
      continue
    }
    if (startupState === 'directory-trust') {
      const options = ['Yes, continue', 'No, quit']
      const selectedOption = async () => {
        const rows = await codeRows(page, agentId)
        return options.find(option => rows.some(row => row.includes('›') && row.includes(option))) || ''
      }
      await expect.poll(selectedOption, { timeout: 5_000 }).toMatch(/^(Yes, continue|No, quit)$/)
      if (await selectedOption() !== 'Yes, continue') {
        await input.press('ArrowUp')
        await expect.poll(selectedOption, { timeout: 5_000 }).toBe('Yes, continue')
      }
      await input.press('Enter')
      directoryTrustAccepted = true
      continue
    }

    const options = ['Review hooks', 'Trust all and continue', 'Continue without trusting']
    const selectedOption = async () => {
      const rows = await codeRows(page, agentId)
      return options.find(option => rows.some(row => row.includes('›') && row.includes(option))) || ''
    }
    const targetIndex = options.indexOf('Continue without trusting')
    let currentIndex = options.indexOf(await selectedOption())
    if (currentIndex < 0) {
      await expect.poll(async () => {
        const rows = await codeRows(page, agentId)
        return options.every(option => rows.some(row => row.includes(option)))
      }, { timeout: 5_000 }).toBe(true)
      currentIndex = 0
    }
    expect(currentIndex, 'Codex hook review must expose a selected rendered option').toBeGreaterThanOrEqual(0)
    while (currentIndex !== targetIndex) {
      const direction = currentIndex < targetIndex ? 1 : -1
      const nextIndex = currentIndex + direction
      await input.press(direction > 0 ? 'ArrowDown' : 'ArrowUp')
      await expect.poll(selectedOption, { timeout: 5_000 }).toBe(options[nextIndex])
      currentIndex = nextIndex
    }
    await input.press('Enter')
    hooksAccepted = true
  }
  throw new Error('Codex Terminal did not settle after the bounded startup prompts')
}

async function continueCrtWithoutUntrustedHooks(page: Page, readyAnchor: string) {
  let startupState = 'waiting'
  await expect.poll(async () => {
    const rendered = (await crtRows(page)).join('\n')
    startupState = rendered.includes(readyAnchor)
      ? 'ready'
      : rendered.includes('Hooks need review') ? 'hooks' : 'waiting'
    return startupState
  }, { timeout: 60_000 }).toMatch(/^(ready|hooks)$/)
  if (startupState === 'ready') return

  const options = ['Review hooks', 'Trust all and continue', 'Continue without trusting']
  const selectedOption = async () => {
    const rows = await crtRows(page)
    return options.find(option => rows.some(row => row.includes('›') && row.includes(option))) || ''
  }
  const targetIndex = options.indexOf('Continue without trusting')
  let currentIndex = options.indexOf(await selectedOption())
  expect(currentIndex, 'Codex hook review must expose a selected rendered option').toBeGreaterThanOrEqual(0)
  const input = page.locator('#terminal-output .xterm-helper-textarea')
  await input.focus()
  while (currentIndex !== targetIndex) {
    const direction = currentIndex < targetIndex ? 1 : -1
    const nextIndex = currentIndex + direction
    await page.keyboard.press(direction > 0 ? 'ArrowDown' : 'ArrowUp')
    await expect.poll(selectedOption, { timeout: 5_000 }).toBe(options[nextIndex])
    currentIndex = nextIndex
  }
  await page.keyboard.press('Enter')
}

async function waitForCodeAnchor(page: Page, agentId: string, anchor: string, timeout = 120_000) {
  await expect.poll(async () => (await codeRows(page, agentId)).join('\n'), { timeout }).toContain(anchor)
}

async function waitForCompletedTerminalTurn(
  page: Page,
  agentId: string,
  anchor: string,
  timeout = 180_000,
) {
  await waitForCodeAnchor(page, agentId, anchor, timeout)
  await expect.poll(async () => page.getByTestId('code-composer-send').getAttribute('data-action'), { timeout })
    .not.toBe('interrupt')
}

async function assertCodeTerminalHealthy(page: Page, agentId: string) {
  await expect.poll(async () => {
    const diagnostics = await codeDiagnostics(page, agentId)
    if (!diagnostics) return null
    return {
      renderer: diagnostics.renderer,
      checkpointRequestInFlight: diagnostics.checkpointRequestInFlight,
      replayInProgress: diagnostics.replayInProgress,
      bootstrappingSnapshot: diagnostics.bootstrappingSnapshot,
      pendingSnapshotReplay: diagnostics.pendingSnapshotReplay,
      replayTargetRevision: diagnostics.replayTargetRevision ?? null,
    }
  }, { timeout: 15_000 }).toEqual({
    renderer: 'webgl',
    checkpointRequestInFlight: false,
    replayInProgress: false,
    bootstrappingSnapshot: false,
    pendingSnapshotReplay: false,
    replayTargetRevision: null,
  })
  await expect(page.getByTestId('code-terminal-status-card')).toHaveCount(0)
}

async function sampleCodeAnchor(page: Page, agentId: string, anchor: string, durationMs = 70) {
  return page.evaluate(async ({ id, expected, duration }) => {
    const startedAt = performance.now()
    let samples = 0
    let missing = 0
    while (performance.now() - startedAt < duration) {
      const rows = window.__farmingTerminalTest?.getRows(id, 10_000) ?? []
      samples += 1
      if (!rows.join('\n').includes(expected)) missing += 1
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
    }
    return { samples, missing }
  }, { id: agentId, expected: anchor, duration: durationMs })
}

async function dragCodeTerminal(
  page: Page,
  agentId: string,
  sizes: Array<{ width: number, height: number }>,
  anchor: string,
) {
  const before = await codeDiagnostics(page, agentId)
  expect(before).not.toBeNull()
  for (const size of sizes) {
    await page.setViewportSize(size)
    const sample = await sampleCodeAnchor(page, agentId, anchor)
    expect(sample.samples).toBeGreaterThan(0)
    expect(sample.missing).toBe(0)
    await page.waitForTimeout(40)
  }
  await expect.poll(async () => {
    const current = await codeDiagnostics(page, agentId)
    return {
      fitPending: current?.fitResizeTimerPending ?? true,
      inFlight: current?.resizeRequestInFlight ?? null,
      pending: current?.pendingResizeRequest ?? null,
    }
  }, { timeout: 15_000 }).toEqual({ fitPending: false, inFlight: null, pending: null })
  const after = await codeDiagnostics(page, agentId)
  expect(after?.resizeNotificationCount).toBe((before?.resizeNotificationCount ?? 0) + 1)
  expect({ cols: after?.cols, rows: after?.rows }).not.toEqual({ cols: before?.cols, rows: before?.rows })
  await assertCodeTerminalHealthy(page, agentId)
  await waitForCodeAnchor(page, agentId, anchor, 15_000)
  return { before, after }
}

async function sendCodeTerminalInput(page: Page, agentId: string, message: string, draftAnchor: string) {
  const host = page.locator(
    `[data-testid="code-terminal-pane"][data-agent-id="${agentId}"] .terminal-session-host[data-agent-id="${agentId}"]`,
  )
  const input = host.locator('.xterm-helper-textarea')
  await expect(input).toHaveCount(1)
  const previousInputCount = await page.evaluate(
    id => window.__farmingTerminalTest?.getInputCount(id) ?? 0,
    agentId,
  )
  await input.focus()
  await page.evaluate(({ id, text }) => {
    window.__farmingTerminalTest?.dispatchPasteToTextarea(id, text)
  }, { id: agentId, text: message })
  await expect.poll(() => page.evaluate(
    id => window.__farmingTerminalTest?.getInputCount(id) ?? 0,
    agentId,
  )).toBeGreaterThanOrEqual(previousInputCount + 1)
  await expect.poll(async () => (await codeRows(page, agentId)).join('\n'), { timeout: 30_000 })
    .toContain(draftAnchor)
  const inputCountAfterPaste = await page.evaluate(
    id => window.__farmingTerminalTest?.getInputCount(id) ?? 0,
    agentId,
  )
  await input.focus()
  await expect(input).toBeFocused()
  await page.keyboard.press('Enter')
  await expect.poll(() => page.evaluate(
    id => window.__farmingTerminalTest?.getInputCount(id) ?? 0,
    agentId,
  )).toBeGreaterThanOrEqual(inputCountAfterPaste + 1)
  await expect.poll(async () => (await agent(page, agentId))?.terminalInputReceived, { timeout: 30_000 })
    .toBe(true)
}

async function sendCodeComposerInput(page: Page, message: string) {
  const input = page.getByTestId('code-composer-input')
  await expect(input).toBeEnabled()
  await input.fill(message)
  await page.getByTestId('code-composer-send').click()
  await expect(input).toHaveValue('')
}

async function sendCodeAcpPromptAndSteer(page: Page) {
  const input = page.getByTestId('code-acp-composer-input')
  const send = page.getByTestId('code-acp-composer-send')
  await expect(input).toBeEnabled()
  await input.fill(ACP_LONG_PROMPT)
  await send.click()
  await expect(input).toHaveValue('')
  await expect(send).toHaveAttribute('data-action', 'interrupt', { timeout: 60_000 })
  await input.fill(`Reply with only ${ACP_FOLLOW_UP_ACK}.`)
  await expect(send).toHaveAttribute('data-action', 'send')
  await send.click()
  await expect(input).toHaveValue('')
  const queuedFollowUp = page.getByTestId('code-acp-pending-followup-row')
    .filter({ hasText: ACP_FOLLOW_UP_ACK }).last()
  await expect(queuedFollowUp).toBeVisible()
  await queuedFollowUp.getByTestId('code-acp-pending-followup-steer').click()
}

async function switchCodeRuntime(page: Page, agentId: string, mode: 'terminal' | 'chat') {
  const responsePromise = page.waitForResponse(response => (
    response.request().method() === 'PATCH'
    && response.url().includes(`/api/agents/${agentId}`)
  ))
  await page.getByTestId('code-terminal-mode-toggle')
    .getByRole('button', { name: mode === 'chat' ? 'Chat' : 'Terminal' })
    .click()
  const response = await responsePromise
  const body = await response.json() as {
    error?: string
    restartedAgentId?: string
    agentRuntimeMode?: string
    switchFailed?: boolean
  }
  expect(response.ok(), body.error || `Failed to switch Code runtime to ${mode}`).toBeTruthy()
  expect(body.switchFailed).not.toBe(true)
  expect(body.agentRuntimeMode).toBe(mode)
  return body.restartedAgentId || agentId
}

async function switchCrtRuntime(page: Page, agentId: string) {
  const responsePromise = page.waitForResponse(response => (
    response.request().method() === 'PATCH'
    && response.url().includes(`/api/agents/${agentId}`)
  ))
  await page.keyboard.press('Alt+M')
  const response = await responsePromise
  const body = await response.json() as {
    error?: string
    restartedAgentId?: string
    agentRuntimeMode?: string
    switchFailed?: boolean
  }
  expect(response.ok(), body.error || 'Failed to switch CRT runtime').toBeTruthy()
  expect(body.switchFailed).not.toBe(true)
  return { agentId: body.restartedAgentId || agentId, mode: body.agentRuntimeMode || '' }
}

async function assertSameProviderSession(page: Page, agentId: string, providerSessionId: string, mode: string) {
  const current = await waitForAgent(page, agentId, candidate => (
    candidate.runtimeBinding?.kind === mode
    && candidate.providerSessionTemporary !== true
    && candidate.providerSessionId === providerSessionId
    && candidate.status === 'running'
  ))
  expect(current.providerSessionId).toBe(providerSessionId)
}

async function assertChatFormats(page: Page, agentId: string) {
  const assistant = page.locator('.code-agent-transcript-assistant.code-markdown-preview')
    .filter({ hasText: COMPOSITE_END })
    .last()
  if (await assistant.count() === 0) {
    const response = await page.request.get(
      `/farming/api/agents/${encodeURIComponent(agentId)}/acp-transcript?maxTurns=1000`,
    )
    expect(response.ok()).toBeTruthy()
    const payload = await response.json() as {
      transcript?: { entries?: Array<{ role?: string, content?: unknown }> }
    }
    expect(
      payload.transcript?.entries?.some(entry => (
        entry.role === 'assistant'
        && JSON.stringify(entry.content).includes(COMPOSITE_END)
      )) ?? false,
      'The authoritative ACP transcript must preserve the Terminal-generated composite Turn',
    ).toBe(true)
    const firstPageResponse = await page.request.get(
      `/farming/api/agents/${encodeURIComponent(agentId)}/acp-transcript?maxTurns=5`,
    )
    expect(firstPageResponse.ok()).toBeTruthy()
    const firstPage = await firstPageResponse.json() as {
      hasMoreBefore?: boolean
      transcript?: { entries?: Array<{
        id?: string
        type?: string
        role?: string
        internal?: boolean
        internalScope?: string
        content?: unknown
        _meta?: { codex?: { steer?: boolean, phase?: string } }
      }> }
    }
    const firstPageHasAssistant = firstPage.transcript?.entries?.some(entry => (
      entry.role === 'assistant'
      && JSON.stringify(entry.content).includes(COMPOSITE_END)
    )) ?? false
    if (!firstPageHasAssistant) expect(firstPage.hasMoreBefore).toBe(true)
    const scroll = page.getByTestId('code-agent-transcript-scroll')
    await expect(scroll).toBeVisible()
    await scroll.hover()
    const requestedTurnLimits: string[] = []
    const recordTranscriptRequest = (request: { url: () => string }) => {
      const url = new URL(request.url())
      if (!url.pathname.endsWith('/acp-transcript')) return
      requestedTurnLimits.push(url.searchParams.get('maxTurns') || '')
    }
    page.on('request', recordTranscriptRequest)
    for (let attempt = 0; attempt < 20 && await assistant.count() === 0; attempt += 1) {
      await page.mouse.wheel(0, -10_000)
      await page.waitForTimeout(1_000)
    }
    page.off('request', recordTranscriptRequest)
    const firstPageEntries = firstPage.transcript?.entries ?? []
    const targetEntryIndex = firstPageEntries.findIndex(entry => (
      entry.role === 'assistant'
      && JSON.stringify(entry.content).includes(COMPOSITE_END)
    ))
    const entryDiagnostics = firstPageEntries
      .slice(Math.max(0, targetEntryIndex - 5), targetEntryIndex + 6)
      .map(entry => ({
        id: entry.id || '',
        type: entry.type || '',
        role: entry.role || '',
        internal: entry.internal === true,
        internalScope: entry.internalScope || '',
        steer: entry._meta?.codex?.steer === true,
        phase: entry._meta?.codex?.phase || '',
        composite: JSON.stringify(entry.content).includes(COMPOSITE_END),
        textChars: JSON.stringify(entry.content).length,
      }))
    expect(
      await assistant.count() > 0,
      `Older ACP Turn did not load: ${JSON.stringify({
        firstPageHasAssistant,
        firstPageHasMoreBefore: firstPage.hasMoreBefore,
        requestedTurnLimits,
        targetEntryIndex,
        entryDiagnostics,
      })}`,
    ).toBe(true)
  }
  await expect(assistant).toBeVisible({ timeout: 120_000 })
  await expect(assistant.getByRole('heading', { name: 'RELEASE_HEADING_7F3A' })).toBeVisible()
  await expect(assistant.getByRole('heading', { name: 'RELEASE_LISTS_7F3A' })).toBeVisible()
  await expect(assistant.locator('table')).toContainText('TABLE_FORMAT_7F3A')
  await expect(assistant.locator('blockquote')).toContainText('QUOTE_FORMAT_7F3A')
  await expect(assistant.locator('pre')).toHaveCount(4)
  await expect(assistant.locator('ul')).not.toHaveCount(0)
  await expect(assistant.locator('ol')).not.toHaveCount(0)
  await expect(assistant).toContainText('PAGE_06_LINE_18')
}

async function resizeStructuredView(page: Page, anchor: string) {
  for (const size of resizePath(NORMAL_VIEWPORT, COMPACT_VIEWPORT)) {
    await page.setViewportSize(size)
    await expect(page.getByText(anchor, { exact: false }).last()).toBeAttached()
    await page.waitForTimeout(90)
  }
  for (const size of resizePath(COMPACT_VIEWPORT, NORMAL_VIEWPORT)) {
    await page.setViewportSize(size)
    await expect(page.getByText(anchor, { exact: false }).last()).toBeAttached()
    await page.waitForTimeout(90)
  }
  await expect(page.getByText(anchor, { exact: false }).last()).toBeVisible()
}

async function crtRows(page: Page) {
  return page.evaluate(() => window.__farmingCrtTerminalTest?.getRows() ?? [])
}

async function waitForCrtTerminal(page: Page) {
  await expect(page.locator('#terminal-output .xterm')).toBeVisible({ timeout: 60_000 })
  await expect(page.locator('#terminal-output canvas').first()).toBeVisible()
  await expect(page.locator('.crt-webgl-error')).toHaveCount(0)
  await expect.poll(async () => page.evaluate(() => window.__farmingCrtTerminalTest?.getState() ?? null), {
    timeout: 60_000,
  }).toMatchObject({
    replaying: false,
    checkpointInFlight: false,
    checkpointInstallInProgress: false,
    pendingFitResize: null,
    fitResizeTimerPending: false,
  })
}

async function waitForCrtSurfaceFitWhileCodexIsBusy(page: Page, agentId: string) {
  await expect(page.locator('#terminal-output .xterm')).toBeVisible({ timeout: 60_000 })
  await expect.poll(async () => {
    const current = await agent(page, agentId)
    const geometry = await page.evaluate(() => window.__farmingCrtTerminalTest?.getGeometry() ?? null)
    const activity = current?.terminalStatus?.activity || ''
    return {
      busy: current?.terminalBusy === true || (activity !== '' && activity !== 'idle'),
      fit: Boolean(
        geometry
        && geometry.cols === geometry.proposedCols
        && geometry.rows === geometry.proposedRows
      ),
      atBottom: Boolean(geometry && geometry.baseY === geometry.viewportY),
    }
  }, { timeout: 30_000 }).toEqual({ busy: true, fit: true, atBottom: true })
}

async function waitForCrtTerminalIdle(page: Page, agentId: string) {
  await waitForAgent(page, agentId, current => current.terminalStatus?.activity === 'idle', 120_000)
}

async function waitForCrtAnchor(page: Page, anchor: string, timeout = 120_000) {
  await expect.poll(async () => (await crtRows(page)).join('\n'), { timeout }).toContain(anchor)
}

async function resizeCrtTerminal(page: Page, initialAnchor: string) {
  await waitForCrtAnchor(page, initialAnchor, 15_000)
  const initial = await page.evaluate(() => window.__farmingCrtTerminalTest?.getState() ?? null)
  expect(initial).not.toBeNull()
  const runtimeEpoch = initial!.runtimeEpoch
  let outputSeq = initial!.outputSeq
  let stateRevision = initial!.stateRevision
  const assertOrderedState = async () => {
    const state = await page.evaluate(() => window.__farmingCrtTerminalTest?.getState() ?? null)
    expect(state).not.toBeNull()
    expect(state!.runtimeEpoch).toBe(runtimeEpoch)
    expect(state!.outputSeq).toBeGreaterThanOrEqual(outputSeq)
    expect(state!.stateRevision).toBeGreaterThanOrEqual(stateRevision)
    outputSeq = state!.outputSeq
    stateRevision = state!.stateRevision
  }
  for (const size of resizePath(NORMAL_VIEWPORT, COMPACT_VIEWPORT)) {
    await page.setViewportSize(size)
    await page.waitForTimeout(40)
    await assertOrderedState()
  }
  await expect.poll(async () => {
    const state = await page.evaluate(() => window.__farmingCrtTerminalTest?.getState() ?? null)
    return {
      changed: state?.cols !== initial?.cols || state?.rows !== initial?.rows,
      pending: state?.pendingFitResize ?? null,
      timerPending: state?.fitResizeTimerPending ?? true,
    }
  }, { timeout: 15_000 }).toEqual({ changed: true, pending: null, timerPending: false })
  const compact = await page.evaluate(() => window.__farmingCrtTerminalTest?.getState() ?? null)
  expect({ cols: compact?.cols, rows: compact?.rows }).not.toEqual({ cols: initial?.cols, rows: initial?.rows })
  for (const size of resizePath(COMPACT_VIEWPORT, NORMAL_VIEWPORT)) {
    await page.setViewportSize(size)
    await page.waitForTimeout(40)
    await assertOrderedState()
  }
  await expect.poll(async () => {
    const state = await page.evaluate(() => window.__farmingCrtTerminalTest?.getState() ?? null)
    return {
      cols: state?.cols ?? 0,
      rows: state?.rows ?? 0,
      replaying: state?.replaying ?? true,
      writeInProgress: state?.writeInProgress ?? true,
      checkpointInFlight: state?.checkpointInFlight ?? true,
      checkpointInstallInProgress: state?.checkpointInstallInProgress ?? true,
      queuedTransitionCount: state?.queuedTransitionCount ?? -1,
      pending: state?.pendingFitResize ?? null,
      timerPending: state?.fitResizeTimerPending ?? true,
    }
  }, { timeout: 15_000 }).toEqual({
    cols: initial?.cols,
    rows: initial?.rows,
    replaying: false,
    writeInProgress: false,
    checkpointInFlight: false,
    checkpointInstallInProgress: false,
    queuedTransitionCount: 0,
    pending: null,
    timerPending: false,
  })
  await assertOrderedState()
  await expect(page.locator('.crt-webgl-error')).toHaveCount(0)
}

async function sendCrtTerminalInput(page: Page, message: string) {
  const input = page.locator('#terminal-output .xterm-helper-textarea')
  await input.focus()
  await input.evaluate((node, text) => {
    const clipboardData = new DataTransfer()
    clipboardData.setData('text/plain', text)
    node.dispatchEvent(new ClipboardEvent('paste', {
      clipboardData,
      bubbles: true,
      cancelable: true,
    }))
  }, message)
  await expect.poll(async () => {
    const rendered = (await crtRows(page)).join('\n')
    return rendered.split('CRT_TERMINAL_ACK_').length - 1
  }, { timeout: 30_000 }).toBe(1)
  await input.focus()
  await expect(input).toBeFocused()
  await page.keyboard.press('Enter')
}

async function sendCrtMessage(page: Page, message: string) {
  const input = page.locator('#crt-structured-input')
  await expect(input).toBeEnabled({ timeout: 30_000 })
  await input.fill(message)
  await page.locator('#crt-structured-send').click()
  await expect(input).toHaveValue('')
}

const primaryModelStatus = new RegExp(`${PRIMARY_MODEL}\\s+${PRIMARY_EFFORT}`)

// Provider truth, not composer state: refuse to prompt a real Codex Terminal
// until its own status line reports the fixed low-cost model.
async function expectTerminalRunsPrimaryModel(page: Page, agentId: string) {
  await expect.poll(async () => (await codeRows(page, agentId)).join('\n').toLowerCase(), { timeout: 90_000 })
    .toMatch(primaryModelStatus)
}

async function expectCrtTerminalRunsPrimaryModel(page: Page) {
  await expect.poll(async () => (await crtRows(page)).join('\n').toLowerCase(), { timeout: 90_000 })
    .toMatch(primaryModelStatus)
}

function acpSessionOptionValue(options: AcpSessionConfigOption[], category: string, pattern: RegExp) {
  const option = options.find(candidate => (
    candidate.type === 'select'
    && (candidate.category === category || pattern.test(`${candidate.id || ''} ${candidate.name || ''}`))
  ))
  return { id: String(option?.id || ''), value: String(option?.currentValue ?? '') }
}

// An ACP session inherits the model of the Codex session it resumed. Assert that
// inheritance and, when the provider reports anything else, switch it back
// through the product path before the session is allowed to spend a turn.
async function pinAcpSessionToPrimaryModel(page: Page, agentId: string) {
  const sessionUrl = `/farming/api/agents/${encodeURIComponent(agentId)}/acp-session?includeEntries=0`
  const readOptions = async () => {
    const response = await page.request.get(sessionUrl)
    if (!response.ok()) return []
    const body = await response.json() as { session?: { configOptions?: AcpSessionConfigOption[] } }
    return body.session?.configOptions ?? []
  }
  await expect.poll(async () => acpSessionOptionValue(await readOptions(), 'model', /(^|[\s_-])model([\s_-]|$)/i).id, {
    timeout: 90_000,
  }).not.toBe('')

  const options = await readOptions()
  const model = acpSessionOptionValue(options, 'model', /(^|[\s_-])model([\s_-]|$)/i)
  const reasoning = acpSessionOptionValue(options, 'thought_level', /(reasoning|thought|effort)/i)
  const changes = [
    ...(model.value === PRIMARY_MODEL ? [] : [{ configId: model.id, value: PRIMARY_MODEL }]),
    ...(reasoning.id && reasoning.value !== PRIMARY_EFFORT ? [{ configId: reasoning.id, value: PRIMARY_EFFORT }] : []),
  ]
  if (changes.length > 0) {
    const response = await page.request.patch(`/farming/api/agents/${encodeURIComponent(agentId)}/acp-session`, {
      data: { configOptions: changes },
    })
    const body = await response.json() as { error?: string }
    expect(response.ok(), body.error || `Failed to pin the ACP session to ${PRIMARY_MODEL}`).toBeTruthy()
  }
  await expect.poll(async () => acpSessionOptionValue(await readOptions(), 'model', /(^|[\s_-])model([\s_-]|$)/i).value, {
    timeout: 90_000,
  }).toBe(PRIMARY_MODEL)
}

test.describe('real Codex pre-release composite case', () => {
  test.beforeAll(() => {
    if (process.env.FARMING_REAL_CODEX_RELEASE_CASE !== '1') {
      throw new Error('Run this release gate through npm run test:pre-release:codex-ui')
    }
    if (process.env.FARMING_E2E_REAL_CODEX !== '1') {
      throw new Error('The real Codex release gate cannot run with fake executables')
    }
    if (!process.env.FARMING_REAL_CODEX_BIN) {
      throw new Error('The real Codex binary was not resolved')
    }
    fs.rmSync(REAL_CODEX_WORKSPACE, { recursive: true, force: true })
    fs.mkdirSync(REAL_CODEX_WORKSPACE, { recursive: true })
    fs.writeFileSync(path.join(REAL_CODEX_WORKSPACE, 'README.md'), '# Real Codex release case\n')
  })

  test.afterAll(() => {
    fs.rmSync(REAL_CODEX_WORKSPACE, { recursive: true, force: true })
  })

  test('completes one visible turn through a real Codex Terminal', { tag: '@release-smoke' }, async ({ page }, testInfo) => {
    test.setTimeout(2 * 60_000)
    await page.setViewportSize(NORMAL_VIEWPORT)

    const catalogResponse = await page.request.get('/farming/api/codex/models?homeId=default')
    expect(catalogResponse.ok()).toBeTruthy()
    const catalogBody = await catalogResponse.json() as { catalog?: CodexCatalogModel[] }
    const primaryModel = (catalogBody.catalog ?? []).find(model => model.value === PRIMARY_MODEL)
    expect(primaryModel, `${PRIMARY_MODEL} must be present in the live Codex catalog`).toBeTruthy()
    expect(primaryModel?.reasoningLevels?.some(level => level.value === PRIMARY_EFFORT)).toBe(true)

    const settingsResponse = await page.request.post('/farming/api/settings', {
      data: {
        codexModel: PRIMARY_MODEL,
        codexReasoningEffort: PRIMARY_EFFORT,
        codexServiceTier: 'default',
        codexModelPreset: `${PRIMARY_MODEL}:${PRIMARY_EFFORT}`,
        agentLaunchProfiles: {
          codex: {
            approvalMode: 'approve',
            model: PRIMARY_MODEL,
            reasoningEffort: PRIMARY_EFFORT,
            serviceTier: 'default',
            modelPreset: `${PRIMARY_MODEL}:${PRIMARY_EFFORT}`,
          },
        },
      },
    })
    expect(settingsResponse.ok()).toBeTruthy()

    await openFarming(page)
    const createResponse = await page.request.post('/farming/api/control/agents', {
      data: { command: 'codex', workspace: REAL_CODEX_WORKSPACE, agentRuntimeMode: 'terminal' },
    })
    const createBody = await createResponse.json() as { agentId?: string, error?: string }
    expect(createResponse.ok(), createBody.error || 'Failed to create real Codex Agent').toBeTruthy()
    const agentId = createBody.agentId as string
    expect(agentId).toBeTruthy()

    const row = page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
    await expect(row).toBeVisible({ timeout: 30_000 })
    await row.click()
    await waitForCodeTerminal(page, agentId)
    await continueWithoutUntrustedHooks(page, agentId)
    await sendCodeTerminalInput(
      page,
      agentId,
      `${RELEASE_SMOKE_REQUEST}. Do not use tools. Reply with only the concatenation of RELEASE_SMOKE_END_ and ${ANCHOR_SUFFIX}, with no separator.`,
      RELEASE_SMOKE_REQUEST,
    )
    await waitForCompletedTerminalTurn(page, agentId, RELEASE_SMOKE_END, 60_000)
    await assertCodeTerminalHealthy(page, agentId)
    const liveAgent = await waitForAgent(page, agentId, current => (
      current.status === 'running'
      && current.providerSessionTemporary !== true
      && Boolean(current.providerSessionId)
    ), 30_000)

    await testInfo.attach('release-smoke-evidence.json', {
      body: Buffer.from(JSON.stringify({
        agentId,
        providerSessionId: liveAgent.providerSessionId,
        model: PRIMARY_MODEL,
        effort: PRIMARY_EFFORT,
        anchor: RELEASE_SMOKE_END,
      }, null, 2)),
      contentType: 'application/json',
    })
    // Dispose the Terminal renderer before fixture cleanup archives the real
    // Codex Agent, so a late resize cannot target an already removed PTY.
    await page.goto('about:blank')
  })

  test('preserves one real Codex session across Code ACP Chat, dark appearance, CRT, Terminal, and resize', { tag: '@release-composite' }, async ({ page }, testInfo) => {
    test.setTimeout(15 * 60_000)
    await page.setViewportSize(NORMAL_VIEWPORT)
    const terminalErrors: string[] = []
    page.on('pageerror', error => {
      if (/(terminal|webgl|checkpoint|replay|renderer)/i.test(error.message)) terminalErrors.push(error.message)
    })
    page.on('console', message => {
      if (message.type() === 'error' && /(terminal|webgl|checkpoint|replay|renderer)/i.test(message.text())) {
        terminalErrors.push(message.text())
      }
    })

    const catalogResponse = await page.request.get('/farming/api/codex/models?homeId=default')
    expect(catalogResponse.ok()).toBeTruthy()
    const catalogBody = await catalogResponse.json() as { catalog?: CodexCatalogModel[] }
    const catalog = catalogBody.catalog ?? []
    const primaryModel = catalog.find(model => model.value === PRIMARY_MODEL)
    const supportsPrimaryEffort = (model: CodexCatalogModel) => (
      model.reasoningLevels?.some(level => level.value === PRIMARY_EFFORT) === true
    )
    expect(primaryModel, `${PRIMARY_MODEL} must be present in the live Codex catalog`).toBeTruthy()
    expect(primaryModel?.reasoningLevels?.some(level => level.value === PRIMARY_EFFORT)).toBe(true)
    const primaryFamily = PRIMARY_MODEL.replace(/-(sol|terra|luna)$/i, '')
    const isPrimarySibling = (model: CodexCatalogModel) => (
      model.value !== PRIMARY_MODEL
      && model.value.startsWith(`${primaryFamily}-`)
      && supportsPrimaryEffort(model)
    )
    // Pin the sibling instead of taking whatever the catalog lists first, so the
    // model this gate touches never depends on catalog ordering.
    const launchModel = catalog.find(model => model.value === LAUNCH_MODEL && isPrimarySibling(model))
      ?? catalog.find(isPrimarySibling)
    expect(launchModel, `A ${PRIMARY_MODEL} sibling is required to prove a live model switch`).toBeTruthy()

    const settingsResponse = await page.request.post('/farming/api/settings', {
      data: {
        appearance: 'light',
        codexModel: launchModel?.value,
        codexReasoningEffort: PRIMARY_EFFORT,
        codexServiceTier: 'default',
        codexModelPreset: `${launchModel?.value}:${PRIMARY_EFFORT}`,
        agentLaunchProfiles: {
          codex: {
            approvalMode: 'approve',
            model: launchModel?.value,
            reasoningEffort: PRIMARY_EFFORT,
            serviceTier: 'default',
            modelPreset: `${launchModel?.value}:${PRIMARY_EFFORT}`,
          },
        },
      },
    })
    expect(settingsResponse.ok()).toBeTruthy()

    await openFarming(page)

    const createResponse = await page.request.post('/farming/api/control/agents', {
      data: { command: 'codex', workspace: REAL_CODEX_WORKSPACE, agentRuntimeMode: 'terminal' },
    })
    const createBody = await createResponse.json() as { agentId?: string, error?: string }
    expect(createResponse.ok(), createBody.error || 'Failed to create real Codex Agent').toBeTruthy()
    let agentId = createBody.agentId as string
    expect(agentId).toBeTruthy()
    const row = page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
    await expect(row).toBeVisible({ timeout: 60_000 })
    await row.click()
    await waitForCodeTerminal(page, agentId)
    await continueWithoutUntrustedHooks(page, agentId)
    let terminalProfileResponse
    let terminalProfileBody: { error?: string } = {}
    const terminalProfileDeadline = Date.now() + 60_000
    do {
      terminalProfileResponse = await page.request.post(
        `/farming/api/agents/${encodeURIComponent(agentId)}/codex-terminal-profile`,
        {
          data: {
            model: launchModel?.value,
            effort: PRIMARY_EFFORT,
            serviceTier: 'default',
          },
        },
      )
      terminalProfileBody = await terminalProfileResponse.json() as { error?: string }
      if (terminalProfileResponse.ok()) break
      if (![
        'Codex Terminal is not idle; wait for its composer before changing the model',
        'Wait for the active Codex Terminal turn to finish before changing its model',
      ].includes(terminalProfileBody.error || '')) break
      await page.waitForTimeout(250)
    } while (Date.now() < terminalProfileDeadline)
    expect(terminalProfileResponse.ok(), terminalProfileBody.error || 'Failed to set the real Codex Terminal profile').toBeTruthy()
    await expect.poll(async () => (await codeRows(page, agentId)).join('\n'), { timeout: 60_000 })
      .toContain(`${launchModel?.value} ${PRIMARY_EFFORT}`)
    expect((await codeRows(page, agentId)).join('\n')).not.toContain('Do you trust the contents of this directory?')

    await test.step('Code Terminal switches to the fixed low-cost model', async () => {
      const restoreComposer = page.getByTestId('code-composer-restore')
      if (await restoreComposer.isVisible()) await restoreComposer.click()
      const picker = page.getByTestId('code-composer-model-picker')
      await expect(picker).toHaveAttribute('data-agent-model-preset', `${launchModel?.value}:${PRIMARY_EFFORT}`, { timeout: 60_000 })
      await picker.click()
      await expect(picker).toHaveAttribute('aria-expanded', 'true')
      await expect(page.getByTestId('code-model-menu')).toBeVisible()
      await expect(page.getByTestId('code-model-matrix-picker')).toBeVisible({ timeout: 60_000 })
      const variant = PRIMARY_MODEL.match(/-(sol|terra|luna)$/i)?.[1]?.toLowerCase()
      expect(variant).toBeTruthy()
      const target = page.getByTestId(`code-model-matrix-cell-${variant}-${PRIMARY_EFFORT}`)
      await expect(target).toBeVisible()
      await expect(target).toBeEnabled({ timeout: 60_000 })
      await target.press('Enter')
      await expect(picker).toHaveAttribute('data-agent-model-preset', `${PRIMARY_MODEL}:${PRIMARY_EFFORT}`, { timeout: 60_000 })
      await page.keyboard.press('Escape')
      await expectTerminalRunsPrimaryModel(page, agentId)
    })

    await test.step('Multi-page Composer output stays at the visible bottom during a running Code to CRT switch', async () => {
      await sendCodeTerminalInput(page, agentId, CLI_PROMPT, 'CLI_JSON')
      await waitForCompletedTerminalTurn(page, agentId, CLI_END)
      await sendCodeComposerInput(page, RUNNING_SWITCH_PROMPT)
      await expect(page.getByTestId('code-composer-send')).toHaveAttribute('data-action', 'interrupt', {
        timeout: 60_000,
      })
      await waitForAgent(page, agentId, current => (
        current.terminalBusy === true
        || Boolean(current.terminalStatus?.activity && current.terminalStatus.activity !== 'idle')
      ), 60_000)

      await page.goto(`/farming/crt/?agent=${encodeURIComponent(agentId)}`, {
        waitUntil: 'domcontentloaded',
      })
      await waitForCrtSurfaceFitWhileCodexIsBusy(page, agentId)
      await waitForCrtTerminal(page)
      await waitForCrtAnchor(page, RUNNING_SWITCH_END, 180_000)
      await waitForCrtTerminalIdle(page, agentId)

      await page.goto(`/farming/?agent=${encodeURIComponent(agentId)}`, {
        waitUntil: 'domcontentloaded',
      })
      await waitForCodeTerminal(page, agentId)
      await sendCodeComposerInput(page, COMPOSITE_PROMPT)
      await waitForCompletedTerminalTurn(page, agentId, COMPOSITE_END)
      await waitForCodeAnchor(page, agentId, 'PAGE_06_LINE_18')
      const rows = await codeRows(page, agentId)
      const diagnostics = await codeDiagnostics(page, agentId)
      expect(rows.join('\n')).toContain(CLI_BEGIN)
      expect(rows.join('\n')).toContain('JSON_FORMAT_7F3A')
      expect(rows.length).toBeGreaterThan((diagnostics?.rows ?? 24) * 3)
      await assertCodeTerminalHealthy(page, agentId)
    })

    const terminalAgent = await waitForAgent(page, agentId, current => (
      current.providerSessionTemporary !== true
      && Boolean(current.providerSessionId)
      && current.status === 'running'
    ))
    const providerSessionId = terminalAgent.providerSessionId as string
    await attachScreenshot(page, testInfo, '01-code-terminal-multipage.png')

    await test.step('Code Terminal remains continuous through shrink and expand drags', async () => {
      const shrink = await dragCodeTerminal(
        page,
        agentId,
        resizePath(NORMAL_VIEWPORT, COMPACT_VIEWPORT),
        COMPOSITE_END,
      )
      const expand = await dragCodeTerminal(
        page,
        agentId,
        resizePath(COMPACT_VIEWPORT, NORMAL_VIEWPORT),
        COMPOSITE_END,
      )
      expect({ cols: expand.after?.cols, rows: expand.after?.rows }).toEqual({
        cols: shrink.before?.cols,
        rows: shrink.before?.rows,
      })
    })

    await test.step('Code ACP Chat reloads the same session, renders formats, and steers the active turn', async () => {
      agentId = await switchCodeRuntime(page, agentId, 'chat')
      await assertSameProviderSession(page, agentId, providerSessionId, 'acp')
      await expect(page.getByTestId('code-agent-chat-view')).toBeVisible({ timeout: 90_000 })
      await assertChatFormats(page, agentId)
      await pinAcpSessionToPrimaryModel(page, agentId)
      await sendCodeAcpPromptAndSteer(page)
      await expect(page.getByTestId('code-agent-transcript-steer')
        .filter({ hasText: ACP_FOLLOW_UP_ACK }).last()).toBeVisible({ timeout: 60_000 })
      await expect(page.locator('.code-agent-transcript-assistant.code-markdown-preview')
        .filter({ hasText: ACP_FOLLOW_UP_ACK }).last()).toBeVisible({ timeout: 120_000 })
      await resizeStructuredView(page, ACP_FOLLOW_UP_ACK)
      await expect(page.getByTestId('code-acp-error')).toHaveCount(0)
    })

    await test.step('Dark appearance repaints the preserved Chat at normal size', async () => {
      await page.getByTestId('code-sidebar-options').click()
      const settings = page.getByTestId('code-settings-panel')
      await expect(settings).toBeVisible()
      await settings.getByRole('group', { name: 'Appearance' }).getByRole('button', { name: 'Dark', exact: true }).click()
      await expect(page.locator('body')).toHaveAttribute('data-appearance', 'dark')
      await settings.getByRole('button', { name: 'Close' }).click()
      await resizeStructuredView(page, ACP_FOLLOW_UP_ACK)
      await assertChatFormats(page, agentId)
      await attachScreenshot(page, testInfo, '02-code-chat-dark.png')
    })

    await test.step('Settings carries the same Chat session into CRT MSG', async () => {
      await page.getByTestId('code-sidebar-options').click()
      const settings = page.getByTestId('code-settings-panel')
      await expect(settings).toBeVisible()
      await settings.getByTestId('code-settings-skin-crt').click()
      await expect(page).toHaveURL(new RegExp(`/farming/crt/\\?agent=${agentId}$`), { timeout: 60_000 })
      await expect(page.locator('body')).toHaveAttribute('id', 'farming-crt')
      await expect(page.locator('#session-modal')).toHaveClass(/active/)
      await expect(page.locator('#crt-structured-input')).toBeVisible({ timeout: 60_000 })
      await expect(page.locator('.crt-structured-message.assistant').filter({ hasText: COMPOSITE_END }).last()).toBeVisible({ timeout: 120_000 })
      await expect(page.locator('.crt-structured-error')).toHaveCount(0)
      await resizeStructuredView(page, COMPOSITE_END)
      await attachScreenshot(page, testInfo, '03-crt-msg.png')
    })

    await test.step('CRT MSG to Terminal keeps the session, output, WebGL, and resize continuity', async () => {
      const switched = await switchCrtRuntime(page, agentId)
      agentId = switched.agentId
      expect(switched.mode).toBe('terminal')
      await assertSameProviderSession(page, agentId, providerSessionId, 'terminal')
      await waitForCrtTerminal(page)
      await continueCrtWithoutUntrustedHooks(page, COMPOSITE_END)
      await waitForCrtAnchor(page, COMPOSITE_END, 180_000)
      await waitForCrtTerminalIdle(page, agentId)
      // The terminal is intentionally following the latest output. After the
      // ACP follow-up, older composite lines may move into scrollback during a
      // narrow reflow; assert the newest preserved turn stays continuously
      // visible instead of pinning the viewport to historical content.
      await resizeCrtTerminal(page, ACP_FOLLOW_UP_ACK)
      await expectCrtTerminalRunsPrimaryModel(page)
      await sendCrtTerminalInput(page, oneLine(`Do not use tools. Reply with only the concatenation of CRT_TERMINAL_ACK_ and ${ANCHOR_SUFFIX}, with no separator.`))
      await waitForCrtAnchor(page, CRT_TERMINAL_ACK)
      await waitForCrtTerminalIdle(page, agentId)
      await attachScreenshot(page, testInfo, '04-crt-terminal.png')
    })

    await test.step('CRT Terminal to ACP Chat preserves input and accepts Chat input', async () => {
      const switched = await switchCrtRuntime(page, agentId)
      agentId = switched.agentId
      expect(switched.mode).toBe('chat')
      await assertSameProviderSession(page, agentId, providerSessionId, 'acp')
      await expect(page.locator('#crt-structured-input')).toBeVisible({ timeout: 60_000 })
      await expect(page.locator('.crt-structured-message.assistant').filter({ hasText: CRT_TERMINAL_ACK }).last()).toBeVisible({ timeout: 120_000 })
      await pinAcpSessionToPrimaryModel(page, agentId)
      await sendCrtMessage(page, `Do not use tools. Reply with only the concatenation of CRT_MSG_ACK_ and ${ANCHOR_SUFFIX}, with no separator.`)
      await expect(page.locator('.crt-structured-message.assistant').filter({ hasText: CRT_MSG_ACK }).last()).toBeVisible({ timeout: 120_000 })
      await resizeStructuredView(page, CRT_MSG_ACK)
      await expect(page.locator('#crt-structured-composer-status.error')).toHaveCount(0)
    })

    await test.step('Final CRT Terminal resumes the ACP session and returns to normal size', async () => {
      const switched = await switchCrtRuntime(page, agentId)
      agentId = switched.agentId
      expect(switched.mode).toBe('terminal')
      await assertSameProviderSession(page, agentId, providerSessionId, 'terminal')
      await waitForCrtTerminal(page)
      await continueCrtWithoutUntrustedHooks(page, CRT_MSG_ACK)
      await waitForCrtAnchor(page, CRT_MSG_ACK, 180_000)
      await waitForCrtTerminalIdle(page, agentId)
      await expect.poll(async () => (await crtRows(page)).join('\n').toLowerCase(), { timeout: 90_000 })
        .toMatch(primaryModelStatus)
      await resizeCrtTerminal(page, CRT_MSG_ACK)
      await page.setViewportSize(NORMAL_VIEWPORT)
      await attachScreenshot(page, testInfo, '05-crt-terminal-final.png')
    })

    expect(terminalErrors, terminalErrors.join('\n')).toEqual([])
    await testInfo.attach('release-case-evidence.json', {
      body: Buffer.from(JSON.stringify({
        providerSessionId,
        primaryModel: PRIMARY_MODEL,
        primaryEffort: PRIMARY_EFFORT,
        chatRuntime: 'acp',
        resumedTerminalModel: PRIMARY_MODEL,
        finalAgentId: agentId,
        finalViewport: page.viewportSize(),
        anchors: [CLI_END, COMPOSITE_END, ACP_FOLLOW_UP_ACK, CRT_TERMINAL_ACK, CRT_MSG_ACK],
      }, null, 2)),
      contentType: 'application/json',
    })
  })
})
