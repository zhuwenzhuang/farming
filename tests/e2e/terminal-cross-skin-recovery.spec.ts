import fs from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

type TerminalInputFrame = {
  agentId: string
  input: string
}

async function createBashAgent(page: Page, workspace: string) {
  const response = await page.request.post('/farming/api/control/agents', {
    data: { command: 'bash', workspace },
  })
  expect(response.ok()).toBeTruthy()
  const data = await response.json() as { agentId?: string }
  expect(data.agentId).toBeTruthy()
  return data.agentId as string
}

async function sessionView(page: Page, agentId: string) {
  const response = await page.request.get(`/farming/api/agents/${agentId}/session-view`)
  expect(response.ok()).toBeTruthy()
  const body = await response.json() as {
    session?: {
      renderOutput?: string
    }
  }
  return body.session || {}
}

async function prepareBrowserPage(page: Page) {
  await page.addInitScript(() => {
    window.__FARMING_E2E__ = true
  })
}

function codeAgentRow(page: Page, agentId: string) {
  return page.locator(
    `[data-testid="code-agent-row"][data-agent-id="${agentId}"], ` +
    `[data-testid="code-project-agent-compact"][data-agent-id="${agentId}"], ` +
    `[data-testid="code-pinned-agent-compact"][data-agent-id="${agentId}"]`,
  ).first()
}

function codeTerminalHost(page: Page, agentId: string) {
  return page.locator(`.terminal-session-host[data-agent-id="${agentId}"]`)
}

async function openCodeTerminal(page: Page, agentId: string) {
  await page.goto('/farming/', { waitUntil: 'domcontentloaded' })
  await expect(page.getByTestId('app-shell')).toBeVisible()
  await expect(codeAgentRow(page, agentId)).toBeVisible({ timeout: 30_000 })
  await codeAgentRow(page, agentId).click()
  await expect(codeTerminalHost(page, agentId)).toBeVisible({ timeout: 15_000 })
  await page.waitForFunction(id => Boolean(window.__farmingTerminalTest?.isReady(id)), agentId)
}

async function waitForCodeReady(page: Page, agentId: string) {
  await expect(codeTerminalHost(page, agentId)).toBeVisible({ timeout: 15_000 })
  await page.waitForFunction(id => Boolean(window.__farmingTerminalTest?.isReady(id)), agentId)
  await page.waitForFunction(id => {
    const diagnostics = window.__farmingTerminalTest?.getBufferDiagnostics(id) as unknown as {
      checkpointRequestInFlight?: boolean
      replayTargetRevision?: number | null
      replayInProgress?: boolean
      bootstrappingSnapshot?: boolean
      pendingSnapshotReplay?: boolean
    } | null
    return diagnostics?.checkpointRequestInFlight === false
      && diagnostics.replayTargetRevision === null
      && diagnostics.replayInProgress === false
      && diagnostics.bootstrappingSnapshot === false
      && diagnostics.pendingSnapshotReplay === false
  }, agentId)
}

async function openCrtTerminal(page: Page, agentId: string) {
  await page.goto(`/farming/crt/?agent=${encodeURIComponent(agentId)}`, {
    waitUntil: 'domcontentloaded',
  })
  await expect(page.locator('#session-modal')).toHaveClass(/active/, { timeout: 30_000 })
  await expect(page.locator('#terminal-output .xterm')).toBeVisible({ timeout: 15_000 })
}

async function waitForCrtReady(page: Page) {
  await expect(page.locator('.crt-terminal-sync-status')).toBeHidden({ timeout: 15_000 })
}

async function sendCrtCommand(page: Page, command: string) {
  const input = page.locator('#terminal-output .xterm-helper-textarea')
  await input.focus()
  await page.keyboard.insertText(command)
  await expect(input).toBeFocused()
  await input.press('Enter')
}

async function dispatchCrtComposition(page: Page, text: string) {
  const input = page.locator('#terminal-output .xterm-helper-textarea')
  await expect(input).toHaveCount(1)
  await input.focus()
  await input.evaluate((node, committedText) => {
    if (!(node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement)) {
      throw new Error('CRT IME target is not an input control')
    }
    node.value = ''
    node.dispatchEvent(new CompositionEvent('compositionstart', {
      data: '',
      bubbles: true,
      cancelable: true,
    }))
    node.value = committedText
    node.dispatchEvent(new CompositionEvent('compositionupdate', {
      data: committedText,
      bubbles: true,
      cancelable: true,
    }))
    node.dispatchEvent(new InputEvent('input', {
      data: committedText,
      inputType: 'insertCompositionText',
      isComposing: true,
      bubbles: true,
      cancelable: false,
    }))
    node.dispatchEvent(new CompositionEvent('compositionend', {
      data: committedText,
      bubbles: true,
      cancelable: true,
    }))
  }, text)
}

async function expectFileText(file: string, expected: string) {
  await expect.poll(() => (
    fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  ), { timeout: 10_000 }).toBe(expected)
}

function trackTerminalInputs(page: Page) {
  const inputs: TerminalInputFrame[] = []
  page.on('websocket', socket => {
    socket.on('framesent', frame => {
      const payload = Buffer.isBuffer(frame.payload)
        ? frame.payload.toString('utf8')
        : frame.payload
      try {
        const message = JSON.parse(payload) as {
          type?: string
          agentId?: string
          input?: string
        }
        if (message.type === 'input' && message.agentId && typeof message.input === 'string') {
          inputs.push({ agentId: message.agentId, input: message.input })
        }
      } catch {
        // Ignore non-JSON WebSocket frames from unrelated test traffic.
      }
    })
  })
  return inputs
}

test('CRT reload restores one checkpoint and keeps accepting input', async ({
  page,
  context,
  workspaceRoot,
}) => {
  const workspace = path.join(workspaceRoot, 'crt-checkpoint-reload')
  fs.mkdirSync(workspace, { recursive: true })
  const agentId = await createBashAgent(page, workspace)
  const afterReloadFile = path.join(workspace, 'after-reload.txt')
  const historyMarker = `CRT_RELOAD_HISTORY_${Date.now()}`
  const crtPage = await context.newPage()
  await prepareBrowserPage(crtPage)
  const inputs = trackTerminalInputs(crtPage)
  let checkpointRequests = 0
  crtPage.on('request', request => {
    if (request.url().endsWith(`/farming/api/agents/${agentId}/session-view`)) {
      checkpointRequests += 1
    }
  })

  try {
    await openCrtTerminal(crtPage, agentId)
    await waitForCrtReady(crtPage)
    await crtPage.waitForTimeout(3_000)
    // Each visible CRT attachment hydrates from one authoritative checkpoint.
    expect(checkpointRequests).toBe(1)

    const historyCommand = `printf '${historyMarker}\\n'`
    const historyInputStart = inputs.length
    await sendCrtCommand(crtPage, historyCommand)
    await expect.poll(() => inputs.slice(historyInputStart).map(frame => frame.input).join(''))
      .toContain(`${historyCommand}\r`)
    await expect.poll(async () => {
      const response = await crtPage.request.get(`/farming/api/agents/${agentId}/session-view`)
      const body = await response.json() as { session?: { renderOutput?: string } }
      return body.session?.renderOutput || ''
    }, { timeout: 10_000 }).toContain(historyMarker)

    const requestsBeforeReload = checkpointRequests
    await crtPage.reload({ waitUntil: 'domcontentloaded' })
    await expect(crtPage.locator('#session-modal')).toHaveClass(/active/, { timeout: 30_000 })
    await waitForCrtReady(crtPage)
    await crtPage.waitForTimeout(3_000)
    expect(checkpointRequests).toBe(requestsBeforeReload + 1)

    const reloadCommand = "printf 'reload-input-ok\\n' > after-reload.txt"
    const reloadInputStart = inputs.length
    await sendCrtCommand(crtPage, reloadCommand)
    await expect.poll(() => inputs.slice(reloadInputStart).map(frame => frame.input).join(''))
      .toContain(`${reloadCommand}\r`)
    await expectFileText(afterReloadFile, 'reload-input-ok\n')
  } finally {
    await crtPage.close()
  }
})

test('CRT hidden-page disconnect resumes from one authoritative latest checkpoint', async ({
  page,
  context,
  workspaceRoot,
}) => {
  const workspace = path.join(workspaceRoot, 'crt-hidden-checkpoint-resume')
  fs.mkdirSync(workspace, { recursive: true })
  const agentId = await createBashAgent(page, workspace)
  await prepareBrowserPage(page)
  await openCodeTerminal(page, agentId)
  await waitForCodeReady(page, agentId)

  const crtPage = await context.newPage()
  await crtPage.addInitScript(() => { window.__FARMING_E2E__ = true })
  try {
    await crtPage.goto(`/farming/crt/?agent=${encodeURIComponent(agentId)}`, { waitUntil: 'domcontentloaded' })
    await expect(crtPage.locator('#session-modal')).toHaveClass(/active/, { timeout: 30_000 })
    await waitForCrtReady(crtPage)

    await crtPage.evaluate(() => {
      (window as typeof window & { suspendCrtPageConnection?: () => void }).suspendCrtPageConnection?.()
    })
    await expect(crtPage.locator('body')).toHaveClass(/page-hidden/)
    const marker = `CRT_RESUMED_LATEST_${Date.now()}`
    const response = await page.request.post(`/farming/api/control/agents/${agentId}/input`, {
      data: { input: `printf '${marker}\\n'\n` },
    })
    expect(response.ok()).toBeTruthy()
    await expect.poll(async () => (
      (await sessionView(page, agentId)).renderOutput || ''
    ), { timeout: 10_000 }).toContain(marker)

    await crtPage.evaluate(() => {
      (window as typeof window & { resumeCrtPageConnection?: () => void }).resumeCrtPageConnection?.()
    })
    await expect(crtPage.locator('body')).not.toHaveClass(/page-hidden/)
    await expect.poll(() => crtPage.evaluate(() => (
      ((window as typeof window & {
        __farmingCrtTerminalTest?: { getRows: () => string[] }
      }).__farmingCrtTerminalTest?.getRows() || []).join('\n')
    )), { timeout: 20_000 }).toContain(marker)
    await expect(crtPage.locator('.crt-terminal-sync-status')).toBeHidden({ timeout: 15_000 })
  } finally {
    await crtPage.close()
  }
})

test('CRT commits a live transition only after the xterm write callback', async ({
  page,
  context,
  workspaceRoot,
}) => {
  const workspace = path.join(workspaceRoot, 'crt-render-commit-callback')
  fs.mkdirSync(workspace, { recursive: true })
  const agentId = await createBashAgent(page, workspace)
  const crtPage = await context.newPage()
  await prepareBrowserPage(crtPage)

  try {
    await openCrtTerminal(crtPage, agentId)
    await waitForCrtReady(crtPage)
    const initial = await crtPage.evaluate(() => (
      (window as typeof window & {
        __farmingCrtTerminalTest?: {
          getState: () => { runtimeEpoch: string; outputSeq: number; stateRevision: number } | null
        }
      }).__farmingCrtTerminalTest?.getState() || null
    ))
    expect(initial?.runtimeEpoch).toBeTruthy()
    expect(initial?.outputSeq).toBeGreaterThanOrEqual(0)
    expect(initial?.stateRevision).toBeGreaterThanOrEqual(0)
    const marker = `CRT_RENDER_COMMITTED_${Date.now()}`

    const duringSameTask = await crtPage.evaluate(({ text, outputSeq, runtimeEpoch, stateRevision }) => {
      const api = (window as typeof window & {
        __farmingCrtTerminalTest?: {
          getState: () => { outputSeq: number; stateRevision: number } | null
          streamSequenced: (
            data: string,
            outputSeq: number,
            runtimeEpoch: string,
            stateRevision: number,
          ) => boolean
        }
      }).__farmingCrtTerminalTest
      const accepted = api?.streamSequenced(
        text,
        outputSeq + 1,
        runtimeEpoch,
        stateRevision + 1,
      ) || false
      return { accepted, state: api?.getState() || null }
    }, {
      text: `${'x'.repeat(6_000)}\r\n${marker}\r\n`,
      outputSeq: initial!.outputSeq,
      runtimeEpoch: initial!.runtimeEpoch,
      stateRevision: initial!.stateRevision,
    })

    expect(duringSameTask).toEqual({
      accepted: true,
      state: {
        ...duringSameTask.state,
        outputSeq: initial!.outputSeq,
        stateRevision: initial!.stateRevision,
      },
    })
    await expect.poll(() => crtPage.evaluate(() => (
      (window as typeof window & {
        __farmingCrtTerminalTest?: {
          getState: () => { outputSeq: number; stateRevision: number } | null
        }
      }).__farmingCrtTerminalTest?.getState() || null
    ))).toMatchObject({
      outputSeq: initial!.outputSeq + 1,
      stateRevision: initial!.stateRevision + 1,
    })
    await expect.poll(() => crtPage.evaluate(() => (
      ((window as typeof window & {
        __farmingCrtTerminalTest?: { getRows: () => string[] }
      }).__farmingCrtTerminalTest?.getRows() || []).join('\n')
    ))).toContain(marker)
  } finally {
    await crtPage.close()
  }
})

test('CRT preserves checkpoint-uncovered live transitions and flushes empty checkpoint chunks', async ({
  page,
  context,
  workspaceRoot,
}) => {
  const workspace = path.join(workspaceRoot, 'crt-checkpoint-live-race')
  fs.mkdirSync(workspace, { recursive: true })
  const agentId = await createBashAgent(page, workspace)
  const crtPage = await context.newPage()
  await prepareBrowserPage(crtPage)

  try {
    await openCrtTerminal(crtPage, agentId)
    await waitForCrtReady(crtPage)
    type CrtState = {
      runtimeEpoch: string
      outputSeq: number
      stateRevision: number
      cols: number
      rows: number
    }
    type CrtTestApi = {
      getState: () => CrtState | null
      getRows: () => string[]
      streamSequenced: (
        data: string,
        outputSeq: number,
        runtimeEpoch: string,
        stateRevision: number,
      ) => boolean
      replaceStream: (stream: Record<string, unknown>) => boolean
    }
    const initial = await crtPage.evaluate(() => (
      (window as typeof window & { __farmingCrtTerminalTest?: CrtTestApi })
        .__farmingCrtTerminalTest?.getState() || null
    ))
    expect(initial?.runtimeEpoch).toBeTruthy()
    const queuedMarker = `CRT_QUEUED_AFTER_CHECKPOINT_${Date.now()}`

    const queuedResult = await crtPage.evaluate(marker => {
      const api = (window as typeof window & { __farmingCrtTerminalTest?: CrtTestApi })
        .__farmingCrtTerminalTest
      const state = api?.getState()
      if (!api || !state) return null
      const first = api.streamSequenced(
        'LIVE_BEFORE_CHECKPOINT\r\n',
        state.outputSeq + 1,
        state.runtimeEpoch,
        state.stateRevision + 1,
      )
      const queued = api.streamSequenced(
        `${marker}\r\n`,
        state.outputSeq + 2,
        state.runtimeEpoch,
        state.stateRevision + 2,
      )
      const checkpoint = api.replaceStream({
        runtimeEpoch: state.runtimeEpoch,
        outputSeq: state.outputSeq + 1,
        stateRevision: state.stateRevision + 1,
        cols: state.cols,
        rows: state.rows,
        data: 'CHECKPOINT_COVERS_FIRST\r\n',
      })
      return {
        accepted: first && queued && checkpoint,
        outputSeq: state.outputSeq + 2,
        stateRevision: state.stateRevision + 2,
      }
    }, queuedMarker)
    expect(queuedResult?.accepted).toBe(true)
    await expect.poll(() => crtPage.evaluate(({ outputSeq, stateRevision }) => {
      const state = (window as typeof window & { __farmingCrtTerminalTest?: CrtTestApi })
        .__farmingCrtTerminalTest?.getState()
      return Boolean(state && state.outputSeq >= outputSeq && state.stateRevision >= stateRevision)
    }, {
      outputSeq: queuedResult!.outputSeq,
      stateRevision: queuedResult!.stateRevision,
    })).toBe(true)
    await expect.poll(() => crtPage.evaluate(() => (
      ((window as typeof window & { __farmingCrtTerminalTest?: CrtTestApi })
        .__farmingCrtTerminalTest?.getRows() || []).join('\n')
    ))).toContain(queuedMarker)

    const emptyChunkMarker = `CRT_EMPTY_CHECKPOINT_CHUNK_${Date.now()}`
    const emptyChunkResult = await crtPage.evaluate(marker => {
      const api = (window as typeof window & { __farmingCrtTerminalTest?: CrtTestApi })
        .__farmingCrtTerminalTest
      const state = api?.getState()
      if (!api || !state) return null
      const accepted = api.replaceStream({
        runtimeEpoch: state.runtimeEpoch,
        outputSeq: state.outputSeq,
        stateRevision: state.stateRevision,
        cols: state.cols,
        rows: state.rows,
        data: '',
        chunks: [{
          kind: 'output',
          data: `${marker}\r\n`,
          outputSeq: state.outputSeq + 1,
          stateRevision: state.stateRevision + 1,
        }],
      })
      return {
        accepted,
        outputSeq: state.outputSeq + 1,
        stateRevision: state.stateRevision + 1,
      }
    }, emptyChunkMarker)
    expect(emptyChunkResult?.accepted).toBe(true)
    await expect.poll(() => crtPage.evaluate(({ outputSeq, stateRevision }) => {
      const state = (window as typeof window & { __farmingCrtTerminalTest?: CrtTestApi })
        .__farmingCrtTerminalTest?.getState()
      return Boolean(state && state.outputSeq >= outputSeq && state.stateRevision >= stateRevision)
    }, {
      outputSeq: emptyChunkResult!.outputSeq,
      stateRevision: emptyChunkResult!.stateRevision,
    })).toBe(true)
    await expect.poll(() => crtPage.evaluate(() => (
      ((window as typeof window & { __farmingCrtTerminalTest?: CrtTestApi })
        .__farmingCrtTerminalTest?.getRows() || []).join('\n')
    ))).toContain(emptyChunkMarker)
  } finally {
    await crtPage.close()
  }
})

test('CRT fits the current surface before a live checkpoint backlog becomes idle', async ({
  page,
  context,
  workspaceRoot,
}) => {
  const workspace = path.join(workspaceRoot, 'crt-checkpoint-live-fit')
  fs.mkdirSync(workspace, { recursive: true })
  const agentId = await createBashAgent(page, workspace)
  const crtPage = await context.newPage()
  await prepareBrowserPage(crtPage)
  await crtPage.setViewportSize({ width: 1280, height: 720 })

  try {
    await openCrtTerminal(crtPage, agentId)
    await waitForCrtReady(crtPage)
    await expect.poll(() => crtPage.evaluate(() => {
      const state = (window as typeof window & {
        __farmingCrtTerminalTest?: {
          getState: () => {
            pendingFitResize: { cols: number, rows: number } | null
            fitResizeTimerPending: boolean
          } | null
        }
      }).__farmingCrtTerminalTest?.getState()
      return state && {
        pendingFitResize: state.pendingFitResize,
        fitResizeTimerPending: state.fitResizeTimerPending,
      }
    })).toEqual({ pendingFitResize: null, fitResizeTimerPending: false })

    const result = await crtPage.evaluate(async () => {
      type CrtState = {
        runtimeEpoch: string
        outputSeq: number
        stateRevision: number
        writeInProgress: boolean
        checkpointInstallInProgress: boolean
        queuedTransitionCount: number
        pendingFitResize: { cols: number, rows: number } | null
        fitResizeTimerPending: boolean
      }
      type CrtGeometry = {
        cols: number
        rows: number
        proposedCols: number
        proposedRows: number
      }
      type CrtTestApi = {
        getState: () => CrtState | null
        getGeometry: () => CrtGeometry
        replaceStream: (stream: Record<string, unknown>) => boolean
      }
      const api = (window as typeof window & { __farmingCrtTerminalTest?: CrtTestApi })
        .__farmingCrtTerminalTest
      const initial = api?.getState()
      const surface = api?.getGeometry()
      if (!api || !initial || !surface?.proposedCols || !surface.proposedRows) return null

      const chunks = Array.from({ length: 120 }, (_, index) => ({
        kind: 'output',
        data: `CRT_LIVE_FIT_${index}_${'x'.repeat(4096)}\r\n`,
        outputSeq: initial.outputSeq + index + 2,
        stateRevision: initial.stateRevision + index + 2,
      }))
      const accepted = api.replaceStream({
        runtimeEpoch: initial.runtimeEpoch,
        outputSeq: initial.outputSeq + 1,
        stateRevision: initial.stateRevision + 1,
        cols: surface.proposedCols,
        rows: surface.proposedRows + 12,
        data: 'CRT_CHECKPOINT_FROM_TALLER_CODE_VIEW\r\n',
        chunks,
      })

      const deadline = performance.now() + 5_000
      while (performance.now() < deadline) {
        const state = api.getState()
        if (
          state
          && !state.checkpointInstallInProgress
          && (state.writeInProgress || state.queuedTransitionCount > 0)
        ) {
          const geometry = api.getGeometry()
          return {
            accepted,
            fitReconciledWhileBusy: (
              geometry.rows === geometry.proposedRows
              && geometry.cols === geometry.proposedCols
            ) || state.fitResizeTimerPending || state.pendingFitResize !== null,
            queuedTransitionCount: state.queuedTransitionCount,
          }
        }
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
      }
      return { accepted, timedOut: true }
    })

    expect(result).toMatchObject({
      accepted: true,
      fitReconciledWhileBusy: true,
    })
    expect(result?.queuedTransitionCount).toBeGreaterThan(0)
    await expect.poll(() => crtPage.evaluate(() => {
      type CrtGeometry = {
        cols: number
        rows: number
        proposedCols: number
        proposedRows: number
      }
      const geometry = (window as typeof window & {
        __farmingCrtTerminalTest?: { getGeometry: () => CrtGeometry }
      }).__farmingCrtTerminalTest?.getGeometry()
      return geometry && {
        colsMatch: geometry.cols === geometry.proposedCols,
        rowsMatch: geometry.rows === geometry.proposedRows,
      }
    }), { timeout: 5_000 }).toEqual({ colsMatch: true, rowsMatch: true })
  } finally {
    await crtPage.close()
  }
})

test('CRT synthetic composition commits exactly once from each shared viewer', async ({
  page,
  context,
  workspaceRoot,
}) => {
  const workspace = path.join(workspaceRoot, 'crt-ime-shared-viewers')
  fs.mkdirSync(workspace, { recursive: true })
  const agentId = await createBashAgent(page, workspace)
  const firstFile = path.join(workspace, 'crt-first-ime.txt')
  const secondFile = path.join(workspace, 'crt-second-ime.txt')
  const firstPage = await context.newPage()
  const secondPage = await context.newPage()
  await prepareBrowserPage(firstPage)
  await prepareBrowserPage(secondPage)

  try {
    await openCrtTerminal(firstPage, agentId)
    await waitForCrtReady(firstPage)
    await dispatchCrtComposition(
      firstPage,
      `printf '中文提交\\n' >> ${JSON.stringify(firstFile)}\r`,
    )
    await expectFileText(firstFile, '中文提交\n')

    await openCrtTerminal(secondPage, agentId)
    await waitForCrtReady(secondPage)
    await dispatchCrtComposition(
      secondPage,
      `printf '第二窗口\\n' >> ${JSON.stringify(secondFile)}\r`,
    )
    await expectFileText(secondFile, '第二窗口\n')
    expect(fs.readFileSync(firstFile, 'utf8')).toBe('中文提交\n')
  } finally {
    await firstPage.close()
    await secondPage.close()
  }
})
