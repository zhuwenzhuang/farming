import fs from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

type TerminalClaim = {
  agentId: string
  attachmentId: string
  claimId: string
}

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

async function waitForCodeOwner(page: Page, agentId: string) {
  await expect(codeTerminalHost(page, agentId))
    .toHaveAttribute('data-controller-status', 'owner', { timeout: 15_000 })
  await page.waitForFunction(id => Boolean(window.__farmingTerminalTest?.isReady(id)), agentId)
  await page.waitForFunction(id => {
    const diagnostics = window.__farmingTerminalTest?.getBufferDiagnostics(id) as unknown as {
      controllerStatus?: string
      checkpointRequestInFlight?: boolean
      replayTargetRevision?: number | null
      replayInProgress?: boolean
      bootstrappingSnapshot?: boolean
      pendingSnapshotReplay?: boolean
    } | null
    return diagnostics?.controllerStatus === 'owner'
      && diagnostics.checkpointRequestInFlight === false
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

async function waitForCrtOwner(page: Page) {
  await expect(page.locator('.crt-terminal-takeover')).toBeHidden({ timeout: 15_000 })
  await expect(page.locator('.crt-terminal-sync-status')).toBeHidden({ timeout: 15_000 })
}

async function sendCodeCommand(page: Page, agentId: string, command: string) {
  const input = codeTerminalHost(page, agentId).locator('.xterm-helper-textarea')
  const previousInputCount = await page.evaluate(
    id => window.__farmingTerminalTest?.getInputCount(id) || 0,
    agentId,
  )
  await input.focus()
  await input.pressSequentially(command)
  await input.press('Enter')
  await expect.poll(() => page.evaluate(
    id => window.__farmingTerminalTest?.getInputCount(id) || 0,
    agentId,
  ), { timeout: 2_000 }).toBeGreaterThan(previousInputCount)
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

function trackTerminalClaims(page: Page) {
  const claims: TerminalClaim[] = []
  page.on('websocket', socket => {
    socket.on('framesent', frame => {
      const payload = Buffer.isBuffer(frame.payload)
        ? frame.payload.toString('utf8')
        : frame.payload
      try {
        const message = JSON.parse(payload) as {
          type?: string
          agentId?: string
          attachmentId?: string
          claimId?: string
        }
        if (
          message.type === 'terminal-controller-claim' &&
          message.agentId &&
          message.attachmentId &&
          message.claimId
        ) {
          claims.push({
            agentId: message.agentId,
            attachmentId: message.attachmentId,
            claimId: message.claimId,
          })
        }
      } catch {
        // Ignore non-JSON WebSocket frames from unrelated test traffic.
      }
    })
  })
  return claims
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

test('CRT owner reload restores its checkpoint with a new attachment and keeps accepting input', async ({
  page,
  context,
  workspaceRoot,
}) => {
  const workspace = path.join(workspaceRoot, 'crt-owner-reload')
  fs.mkdirSync(workspace, { recursive: true })
  const agentId = await createBashAgent(page, workspace)
  const afterReloadFile = path.join(workspace, 'after-reload.txt')
  const historyMarker = `CRT_RELOAD_HISTORY_${Date.now()}`
  const crtPage = await context.newPage()
  await prepareBrowserPage(crtPage)
  const claims = trackTerminalClaims(crtPage)
  const inputs = trackTerminalInputs(crtPage)
  let checkpointRequests = 0
  crtPage.on('request', request => {
    if (request.url().endsWith(`/farming/api/agents/${agentId}/session-view`)) {
      checkpointRequests += 1
    }
  })

  try {
    await openCrtTerminal(crtPage, agentId)
    await waitForCrtOwner(crtPage)
    await expect.poll(() => claims.find(claim => claim.agentId === agentId)?.attachmentId || '')
      .not.toBe('')
    const firstAttachmentId = claims.find(claim => claim.agentId === agentId)?.attachmentId
    expect(firstAttachmentId).toBeTruthy()
    await crtPage.waitForTimeout(3_000)
    // Display attachment owns one explicit checkpoint request; controller
    // controller claims never hydrate terminal output.
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
    await waitForCrtOwner(crtPage)
    await crtPage.waitForTimeout(3_000)
    expect(checkpointRequests).toBe(requestsBeforeReload + 1)
    await expect.poll(() => claims.findLast(claim => (
      claim.agentId === agentId && claim.attachmentId !== firstAttachmentId
    ))?.attachmentId || '', { timeout: 10_000 }).not.toBe('')

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

  const crtPage = await context.newPage()
  await crtPage.addInitScript(() => { window.__FARMING_E2E__ = true })
  try {
    await crtPage.goto(`/farming/crt/?agent=${encodeURIComponent(agentId)}`, { waitUntil: 'domcontentloaded' })
    await expect(crtPage.locator('#session-modal')).toHaveClass(/active/, { timeout: 30_000 })
    const takeover = crtPage.locator('.crt-terminal-takeover')
    await expect(takeover).toBeVisible({ timeout: 15_000 })
    await takeover.click()
    await expect(takeover).toBeHidden({ timeout: 15_000 })

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
    await waitForCrtOwner(crtPage)
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
    await waitForCrtOwner(crtPage)
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

    const accepted = await crtPage.evaluate(({ state, marker }) => {
      const api = (window as typeof window & { __farmingCrtTerminalTest?: CrtTestApi })
        .__farmingCrtTerminalTest
      if (!api) return false
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
      return first && queued && checkpoint
    }, { state: initial!, marker: queuedMarker })
    expect(accepted).toBe(true)
    await expect.poll(() => crtPage.evaluate(() => (
      (window as typeof window & { __farmingCrtTerminalTest?: CrtTestApi })
        .__farmingCrtTerminalTest?.getState() || null
    ))).toMatchObject({
      outputSeq: initial!.outputSeq + 2,
      stateRevision: initial!.stateRevision + 2,
    })
    await expect.poll(() => crtPage.evaluate(() => (
      ((window as typeof window & { __farmingCrtTerminalTest?: CrtTestApi })
        .__farmingCrtTerminalTest?.getRows() || []).join('\n')
    ))).toContain(queuedMarker)

    const emptyChunkMarker = `CRT_EMPTY_CHECKPOINT_CHUNK_${Date.now()}`
    expect(await crtPage.evaluate(({ state, marker }) => {
      const api = (window as typeof window & { __farmingCrtTerminalTest?: CrtTestApi })
        .__farmingCrtTerminalTest
      return api?.replaceStream({
        runtimeEpoch: state.runtimeEpoch,
        outputSeq: state.outputSeq + 2,
        stateRevision: state.stateRevision + 2,
        cols: state.cols,
        rows: state.rows,
        data: '',
        chunks: [{
          kind: 'output',
          data: `${marker}\r\n`,
          outputSeq: state.outputSeq + 3,
          stateRevision: state.stateRevision + 3,
        }],
      }) || false
    }, { state: initial!, marker: emptyChunkMarker })).toBe(true)
    await expect.poll(() => crtPage.evaluate(() => (
      (window as typeof window & { __farmingCrtTerminalTest?: CrtTestApi })
        .__farmingCrtTerminalTest?.getState() || null
    ))).toMatchObject({
      outputSeq: initial!.outputSeq + 3,
      stateRevision: initial!.stateRevision + 3,
    })
    await expect.poll(() => crtPage.evaluate(() => (
      ((window as typeof window & { __farmingCrtTerminalTest?: CrtTestApi })
        .__farmingCrtTerminalTest?.getRows() || []).join('\n')
    ))).toContain(emptyChunkMarker)
  } finally {
    await crtPage.close()
  }
})

test('closing the Code owner lets the CRT observer explicitly take over and write', async ({
  page,
  context,
  workspaceRoot,
}) => {
  const workspace = path.join(workspaceRoot, 'code-close-crt-survivor')
  fs.mkdirSync(workspace, { recursive: true })
  const agentId = await createBashAgent(page, workspace)
  const resultFile = path.join(workspace, 'crt-survivor.txt')
  const codePage = await context.newPage()
  const crtPage = await context.newPage()
  await prepareBrowserPage(codePage)
  await prepareBrowserPage(crtPage)

  try {
    await openCodeTerminal(codePage, agentId)
    await waitForCodeOwner(codePage, agentId)
    await openCrtTerminal(crtPage, agentId)
    const takeover = crtPage.locator('.crt-terminal-takeover')
    await expect(takeover).toBeVisible({ timeout: 15_000 })

    await codePage.close()
    await expect(takeover).toBeVisible()
    await takeover.click()
    await waitForCrtOwner(crtPage)
    await sendCrtCommand(
      crtPage,
      `printf 'crt-survivor-ok\\n' > ${JSON.stringify(resultFile)}`,
    )
    await expectFileText(resultFile, 'crt-survivor-ok\n')
  } finally {
    if (!codePage.isClosed()) await codePage.close()
    await crtPage.close()
  }
})

test('closing the CRT owner lets the Code observer explicitly take over and write', async ({
  page,
  context,
  workspaceRoot,
}) => {
  const workspace = path.join(workspaceRoot, 'crt-close-code-survivor')
  fs.mkdirSync(workspace, { recursive: true })
  const agentId = await createBashAgent(page, workspace)
  const resultFile = path.join(workspace, 'code-survivor.txt')
  const crtPage = await context.newPage()
  const codePage = await context.newPage()
  await prepareBrowserPage(crtPage)
  await prepareBrowserPage(codePage)

  try {
    await openCrtTerminal(crtPage, agentId)
    await waitForCrtOwner(crtPage)
    await openCodeTerminal(codePage, agentId)
    const host = codeTerminalHost(codePage, agentId)
    await expect(host).toHaveAttribute('data-controller-status', 'observer', { timeout: 15_000 })
    const takeover = host.locator('.terminal-controller-takeover')
    await expect(takeover).toBeVisible()

    await crtPage.close()
    await expect(takeover).toBeVisible()
    await takeover.click()
    await waitForCodeOwner(codePage, agentId)
    await sendCodeCommand(
      codePage,
      agentId,
      `printf 'code-survivor-ok\\n' > ${JSON.stringify(resultFile)}`,
    )
    await expectFileText(resultFile, 'code-survivor-ok\n')
  } finally {
    if (!crtPage.isClosed()) await crtPage.close()
    await codePage.close()
  }
})

test('CRT synthetic composition commits once for the owner and zero times for an observer', async ({
  page,
  context,
  workspaceRoot,
}) => {
  const workspace = path.join(workspaceRoot, 'crt-ime-owner-observer')
  fs.mkdirSync(workspace, { recursive: true })
  const agentId = await createBashAgent(page, workspace)
  const ownerFile = path.join(workspace, 'crt-owner-ime.txt')
  const observerFile = path.join(workspace, 'crt-observer-ime.txt')
  const ownerPage = await context.newPage()
  const observerPage = await context.newPage()
  await prepareBrowserPage(ownerPage)
  await prepareBrowserPage(observerPage)

  try {
    await openCrtTerminal(ownerPage, agentId)
    await waitForCrtOwner(ownerPage)
    await dispatchCrtComposition(
      ownerPage,
      `printf '中文提交\\n' >> ${JSON.stringify(ownerFile)}\r`,
    )
    await expectFileText(ownerFile, '中文提交\n')

    await openCrtTerminal(observerPage, agentId)
    const takeover = observerPage.locator('.crt-terminal-takeover')
    await expect(takeover).toBeVisible({ timeout: 15_000 })
    await dispatchCrtComposition(
      observerPage,
      `printf '不应提交\\n' >> ${JSON.stringify(observerFile)}\r`,
    )
    await observerPage.waitForTimeout(300)
    expect(fs.existsSync(observerFile)).toBe(false)
    expect(fs.readFileSync(ownerFile, 'utf8')).toBe('中文提交\n')
  } finally {
    await ownerPage.close()
    await observerPage.close()
  }
})
