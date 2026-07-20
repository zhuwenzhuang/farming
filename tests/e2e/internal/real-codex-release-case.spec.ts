import fs from 'node:fs'
import path from 'node:path'
import type { Page, TestInfo } from '@playwright/test'
import { expect, openFarming, test } from '../fixtures'

const PRIMARY_MODEL = 'gpt-5.6-luna'
const PRIMARY_EFFORT = 'medium'
const CLI_BEGIN = 'CLI_FLOW_BEGIN_7F3A'
const CLI_END = 'CLI_FLOW_END_7F3A'
const COMPOSITE_BEGIN = 'COMPOSITE_BEGIN_7F3A'
const COMPOSITE_END = 'COMPOSITE_END_7F3A'
const CRT_TERMINAL_ACK = 'CRT_TERMINAL_ACK_7F3A'
const CRT_MSG_ACK = 'CRT_MSG_ACK_7F3A'
const ACP_FOLLOW_UP_ACK = 'ACP_FOLLOW_UP_ACK_7F3A'
const ANCHOR_SUFFIX = '7F3A'
const NORMAL_VIEWPORT = { width: 1440, height: 900 }
const COMPACT_VIEWPORT = { width: 1080, height: 650 }
const REAL_CODEX_WORKSPACE = path.join(process.cwd(), '.tmp', 'real-codex-release-case-e2e')

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
  pendingFitResize: { cols: number, rows: number } | null
  fitResizeTimerPending: boolean
}

declare global {
  interface Window {
    __farmingCrtTerminalTest?: {
      getState: () => CrtTerminalState | null
      getRows: () => string[]
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

async function sendCodeAcpPromptAndQueuedFollowUp(page: Page) {
  const input = page.getByTestId('code-composer-input')
  const send = page.getByTestId('code-composer-send')
  await expect(input).toBeEnabled()
  await input.fill(ACP_LONG_PROMPT)
  await send.click()
  await expect(input).toHaveValue('')
  await expect(send).toHaveAttribute('data-action', 'interrupt', { timeout: 60_000 })
  await input.fill(`Reply with only ${ACP_FOLLOW_UP_ACK}.`)
  await expect(send).toHaveAttribute('data-action', 'send')
  await send.click()
  await expect(input).toHaveValue('')
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

async function assertChatFormats(page: Page) {
  const assistant = page.locator('.code-codex-transcript-assistant.code-markdown-preview')
    .filter({ hasText: COMPOSITE_END })
    .last()
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

async function waitForCrtTerminalIdle(page: Page, agentId: string) {
  await waitForAgent(page, agentId, current => current.terminalStatus?.activity === 'idle', 120_000)
}

async function waitForCrtAnchor(page: Page, anchor: string, timeout = 120_000) {
  await expect.poll(async () => (await crtRows(page)).join('\n'), { timeout }).toContain(anchor)
}

async function sampleCrtAnchor(page: Page, anchor: string, durationMs = 70) {
  return page.evaluate(async ({ expected, duration }) => {
    const startedAt = performance.now()
    let samples = 0
    let stableMissing = 0
    let transientMissing = 0
    while (performance.now() - startedAt < duration) {
      const rows = window.__farmingCrtTerminalTest?.getRows() ?? []
      const state = window.__farmingCrtTerminalTest?.getState() ?? null
      const transitioning = Boolean(
        state?.writeInProgress
        || state?.replaying
        || state?.checkpointInFlight
        || state?.checkpointInstallInProgress
      )
      samples += 1
      if (!rows.join('\n').includes(expected)) {
        if (transitioning) transientMissing += 1
        else stableMissing += 1
      }
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
    }
    return { samples, stableMissing, transientMissing }
  }, { expected: anchor, duration: durationMs })
}

async function resizeCrtTerminal(page: Page, normalAnchor: string, compactAnchor = normalAnchor) {
  const initial = await page.evaluate(() => window.__farmingCrtTerminalTest?.getState() ?? null)
  expect(initial).not.toBeNull()
  for (const size of resizePath(NORMAL_VIEWPORT, COMPACT_VIEWPORT)) {
    await page.setViewportSize(size)
    const sample = await sampleCrtAnchor(page, normalAnchor)
    expect(sample.samples).toBeGreaterThan(0)
    expect(sample.stableMissing).toBe(0)
    await page.waitForTimeout(40)
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
  await waitForCrtAnchor(page, compactAnchor, 15_000)
  for (const size of resizePath(COMPACT_VIEWPORT, NORMAL_VIEWPORT)) {
    await page.setViewportSize(size)
    const sample = await sampleCrtAnchor(page, compactAnchor)
    expect(sample.samples).toBeGreaterThan(0)
    expect(sample.stableMissing).toBe(0)
    await page.waitForTimeout(40)
  }
  await expect.poll(async () => {
    const state = await page.evaluate(() => window.__farmingCrtTerminalTest?.getState() ?? null)
    return {
      cols: state?.cols ?? 0,
      rows: state?.rows ?? 0,
      replaying: state?.replaying ?? true,
      checkpointInFlight: state?.checkpointInFlight ?? true,
      checkpointInstallInProgress: state?.checkpointInstallInProgress ?? true,
      pending: state?.pendingFitResize ?? null,
      timerPending: state?.fitResizeTimerPending ?? true,
    }
  }, { timeout: 15_000 }).toEqual({
    cols: initial?.cols,
    rows: initial?.rows,
    replaying: false,
    checkpointInFlight: false,
    checkpointInstallInProgress: false,
    pending: null,
    timerPending: false,
  })
  await expect(page.locator('.crt-webgl-error')).toHaveCount(0)
  await waitForCrtAnchor(page, normalAnchor, 15_000)
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

  test('preserves one real Codex session across Code ACP Chat, dark appearance, CRT, Terminal, and resize', async ({ page }, testInfo) => {
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

    const catalogResponse = await page.request.get('/farming/api/codex/models')
    expect(catalogResponse.ok()).toBeTruthy()
    const catalogBody = await catalogResponse.json() as { catalog?: CodexCatalogModel[] }
    const catalog = catalogBody.catalog ?? []
    const primaryModel = catalog.find(model => model.value === PRIMARY_MODEL)
    const supportsPrimaryEffort = (model: CodexCatalogModel) => (
      model.reasoningLevels?.some(level => level.value === PRIMARY_EFFORT) === true
    )
    expect(primaryModel, `${PRIMARY_MODEL} must be present in the live Codex catalog`).toBeTruthy()
    expect(`${primaryModel?.displayName} ${primaryModel?.description}`).toMatch(/affordable|cost-efficient/i)
    expect(primaryModel?.reasoningLevels?.some(level => level.value === PRIMARY_EFFORT)).toBe(true)
    const primaryFamily = PRIMARY_MODEL.replace(/-(sol|terra|luna)$/i, '')
    const launchModel = catalog.find(model => (
      model.value !== PRIMARY_MODEL
      && model.value.startsWith(`${primaryFamily}-`)
      && model.reasoningLevels?.some(level => level.value === PRIMARY_EFFORT)
    ))
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
    await expect.poll(async () => (await codeRows(page, agentId)).join('\n'), { timeout: 60_000 })
      .toContain(`${launchModel?.value} ${PRIMARY_EFFORT}`)
    expect((await codeRows(page, agentId)).join('\n')).not.toContain('Do you trust the contents of this directory?')

    await test.step('Code Terminal switches to the fixed low-cost model', async () => {
      const picker = page.getByTestId('code-composer-model-picker')
      await expect(picker).toHaveAttribute('data-agent-model-preset', `${launchModel?.value}:${PRIMARY_EFFORT}`, { timeout: 60_000 })
      await picker.click()
      const variant = PRIMARY_MODEL.match(/-(sol|terra|luna)$/i)?.[1]?.toLowerCase()
      expect(variant).toBeTruthy()
      const target = page.getByTestId(`code-model-matrix-cell-${variant}-${PRIMARY_EFFORT}`)
      await expect(target).toBeVisible()
      await target.click()
      await expect(picker).toHaveAttribute('data-agent-model-preset', `${PRIMARY_MODEL}:${PRIMARY_EFFORT}`, { timeout: 60_000 })
      await expect(target).toBeEnabled({ timeout: 60_000 })
      await page.keyboard.press('Escape')
    })

    await test.step('Terminal input and Composer input create multi-page mixed-format output', async () => {
      await sendCodeTerminalInput(page, agentId, CLI_PROMPT, 'CLI_JSON')
      await waitForCompletedTerminalTurn(page, agentId, CLI_END)
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

    await test.step('Code ACP Chat reloads the same session, renders formats, and runs a queued follow-up', async () => {
      agentId = await switchCodeRuntime(page, agentId, 'chat')
      await assertSameProviderSession(page, agentId, providerSessionId, 'acp')
      await expect(page.getByTestId('code-agent-chat-view')).toBeVisible({ timeout: 90_000 })
      await assertChatFormats(page)
      await sendCodeAcpPromptAndQueuedFollowUp(page)
      await expect(page.locator('.code-codex-transcript-assistant.code-markdown-preview')
        .filter({ hasText: ACP_FOLLOW_UP_ACK }).last()).toBeVisible({ timeout: 120_000 })
      await resizeStructuredView(page, COMPOSITE_END)
      await expect(page.getByTestId('code-acp-error')).toHaveCount(0)
    })

    await test.step('Dark appearance repaints the preserved Chat at normal size', async () => {
      await page.getByTestId('code-sidebar-options').click()
      const settings = page.getByTestId('code-settings-panel')
      await expect(settings).toBeVisible()
      await settings.getByRole('group', { name: 'Appearance' }).getByRole('button', { name: 'Dark', exact: true }).click()
      await expect(page.locator('body')).toHaveAttribute('data-appearance', 'dark')
      await settings.getByRole('button', { name: 'Close' }).click()
      await resizeStructuredView(page, COMPOSITE_END)
      await assertChatFormats(page)
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
      await waitForCrtAnchor(page, COMPOSITE_END, 180_000)
      await waitForCrtTerminalIdle(page, agentId)
      await resizeCrtTerminal(page, COMPOSITE_END, 'PAGE_06_LINE_18')
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
      await waitForCrtAnchor(page, CRT_MSG_ACK, 180_000)
      await waitForCrtTerminalIdle(page, agentId)
      await expect.poll(async () => (await crtRows(page)).join('\n').toLowerCase(), { timeout: 90_000 })
        .toMatch(new RegExp(`${PRIMARY_MODEL}\\s+medium`))
      await resizeCrtTerminal(page, CRT_MSG_ACK, COMPOSITE_END)
      await page.setViewportSize(NORMAL_VIEWPORT)
      await attachScreenshot(page, testInfo, '05-crt-terminal-final.png')
    })

    expect(terminalErrors, terminalErrors.join('\n')).toEqual([])
    await testInfo.attach('release-case-evidence.json', {
      body: Buffer.from(JSON.stringify({
        providerSessionId,
        primaryModel: PRIMARY_MODEL,
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
