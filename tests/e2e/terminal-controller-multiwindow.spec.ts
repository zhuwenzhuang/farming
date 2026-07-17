import fs from 'node:fs'
import path from 'node:path'
import { expect, test } from './fixtures'

async function createControlAgent(page: import('@playwright/test').Page, workspace: string) {
  const response = await page.request.post('/farming/api/control/agents', {
    data: { command: 'bash', workspace },
  })
  expect(response.ok()).toBeTruthy()
  const data = await response.json() as { agentId?: string }
  expect(data.agentId).toBeTruthy()
  return data.agentId as string
}

async function openPage(page: import('@playwright/test').Page) {
  await page.goto('/farming/', { waitUntil: 'domcontentloaded' })
  await expect(page.getByTestId('app-shell')).toBeVisible()
}

function agentRow(page: import('@playwright/test').Page, agentId: string) {
  return page.locator(
    `[data-testid="code-agent-row"][data-agent-id="${agentId}"], ` +
    `[data-testid="code-project-agent-compact"][data-agent-id="${agentId}"], ` +
    `[data-testid="code-pinned-agent-compact"][data-agent-id="${agentId}"]`,
  ).first()
}

function terminalHost(page: import('@playwright/test').Page, agentId: string) {
  return page.locator(`.terminal-session-host[data-agent-id="${agentId}"]`)
}

async function selectAgent(page: import('@playwright/test').Page, agentId: string) {
  await expect(agentRow(page, agentId)).toBeVisible({ timeout: 30_000 })
  await agentRow(page, agentId).click()
  await expect(terminalHost(page, agentId)).toBeVisible({ timeout: 15_000 })
  await page.waitForFunction(id => Boolean(window.__farmingTerminalTest?.isReady(id)), agentId)
}

async function sessionState(page: import('@playwright/test').Page, agentId: string) {
  const response = await page.request.get(`/farming/api/agents/${agentId}/session-view`)
  expect(response.ok()).toBeTruthy()
  const body = await response.json() as {
    session?: {
      previewCols?: number
      previewRows?: number
      outputSeq?: number
      stateRevision?: number
      renderOutput?: string
    }
  }
  return body.session || {}
}

async function waitForStableSessionRevision(
  page: import('@playwright/test').Page,
  agentId: string,
) {
  let previous: number | undefined
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const current = await sessionState(page, agentId)
    if (current.stateRevision === previous) return current
    previous = current.stateRevision
    await page.waitForTimeout(50)
  }
  throw new Error('terminal state revision did not settle')
}

async function waitForTerminalSettled(
  page: import('@playwright/test').Page,
  agentId: string,
) {
  let diagnostics: ReturnType<NonNullable<typeof window.__farmingTerminalTest>['getBufferDiagnostics']> = null
  for (let attempt = 0; attempt < 100; attempt += 1) {
    diagnostics = await page.evaluate(id => (
      window.__farmingTerminalTest?.getBufferDiagnostics(id) ?? null
    ), agentId)
    if (
      diagnostics?.controllerStatus === 'owner'
      && diagnostics.controllerFence !== null
      && diagnostics.rendererReadyFence === diagnostics.controllerFence
      && diagnostics.checkpointRequestInFlight === false
      && diagnostics.replayTargetRevision === null
      && diagnostics.replayInProgress === false
      && diagnostics.bootstrappingSnapshot === false
    ) return
    await page.waitForTimeout(100)
  }
  throw new Error(`terminal did not settle: ${JSON.stringify(diagnostics)}`)
}

async function waitForCommittedTerminalGeometry(
  page: import('@playwright/test').Page,
  agentId: string,
) {
  let stableSamples = 0
  let previous = ''
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const state = await sessionState(page, agentId)
    const diagnostics = await page.evaluate(id => (
      window.__farmingTerminalTest?.getBufferDiagnostics(id) ?? null
    ), agentId)
    const signature = diagnostics
      && state.previewCols === diagnostics.cols
      && state.previewRows === diagnostics.rows
      ? `${diagnostics.cols}x${diagnostics.rows}:${state.stateRevision}`
      : ''
    stableSamples = signature && signature === previous ? stableSamples + 1 : 0
    if (stableSamples >= 2) return
    previous = signature
    await page.waitForTimeout(100)
  }
  throw new Error('terminal geometry did not reach a stable committed size')
}

async function ensureTerminalOwner(
  page: import('@playwright/test').Page,
  agentId: string,
) {
  const host = terminalHost(page, agentId)
  if (await host.getAttribute('data-controller-status') !== 'owner') {
    await host.locator('.terminal-controller-takeover').click()
  }
  await expect(host).toHaveAttribute('data-controller-status', 'owner')
  await waitForTerminalSettled(page, agentId)
}

test('rapid browser geometry changes commit only the first and latest terminal size', async ({
  page,
  workspaceRoot,
}) => {
  const workspace = path.join(workspaceRoot, 'terminal-controller-resize-coalescing')
  fs.mkdirSync(workspace, { recursive: true })
  const agentId = await createControlAgent(page, workspace)

  await openPage(page)
  await selectAgent(page, agentId)
  await ensureTerminalOwner(page, agentId)
  await expect.poll(async () => terminalHost(page, agentId).locator('.terminal-controller-status').evaluate(element => ({
    display: getComputedStyle(element).display,
    width: element.getBoundingClientRect().width,
    height: element.getBoundingClientRect().height,
  }))).toEqual({ display: 'none', width: 0, height: 0 })
  await waitForCommittedTerminalGeometry(page, agentId)
  const before = await page.evaluate(id => (
    window.__farmingTerminalTest?.getBufferDiagnostics(id) ?? null
  ), agentId)
  expect(before).not.toBeNull()

  const finalGeometry = await page.evaluate(({ id, cols, rows }) => {
    const api = window.__farmingTerminalTest
    if (!api) throw new Error('terminal test API unavailable')
    for (let index = 0; index < 40; index += 1) {
      const fraction = (index + 1) / 40
      api.notifyResizeForTest(
        id,
        Math.max(40, Math.round(cols - 20 + (20 * fraction))),
        Math.max(10, Math.round(rows - 4 + (4 * fraction))),
      )
    }
    return { cols, rows }
  }, { id: agentId, cols: before!.cols, rows: before!.rows })

  await expect.poll(async () => {
    const state = await sessionState(page, agentId)
    const diagnostics = await page.evaluate(id => (
      window.__farmingTerminalTest?.getBufferDiagnostics(id) ?? null
    ), agentId)
    return {
      cols: state.previewCols,
      rows: state.previewRows,
      resizeInFlight: diagnostics?.controllerResizeRequestInFlight,
      pendingResize: diagnostics?.controllerPendingResize,
    }
  }).toEqual({
    ...finalGeometry,
    resizeInFlight: false,
    pendingResize: null,
  })

  const after = await page.evaluate(id => (
    window.__farmingTerminalTest?.getBufferDiagnostics(id) ?? null
  ), agentId)
  const sentResizeCount = (after?.controllerResizeRequestSeq || 0) - (before?.controllerResizeRequestSeq || 0)
  expect(sentResizeCount).toBeGreaterThanOrEqual(1)
  expect(sentResizeCount).toBeLessThanOrEqual(2)
})

async function dispatchComposition(
  page: import('@playwright/test').Page,
  selector: string,
  text: string,
) {
  await page.locator(selector).focus()
  await page.locator(selector).evaluate((node, committedText) => {
    if (!(node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement)) {
      throw new Error('terminal IME target is not an input control')
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

async function expectRendererFlowControlProgress(
  page: import('@playwright/test').Page,
  agentId: string,
  marker: string,
) {
  const command = `for i in {1..80}; do printf '%05000d' 0; done; printf '\\n${marker}\\n'`
  const input = page.locator(
    `.terminal-session-host[data-agent-id="${agentId}"] .xterm-helper-textarea, `
    + '#terminal-output .xterm-helper-textarea',
  ).first()
  await input.focus()
  await page.keyboard.insertText(command)
  await input.press('Enter')
  await expect.poll(async () => (
    (await sessionState(page, agentId)).renderOutput || ''
  ), { timeout: 20_000 }).toContain(marker)
}

test('one browser owns PTY controller and interactive takeover is fenced across windows', async ({
  page,
  context,
  workspaceRoot,
}) => {
  const workspace = path.join(workspaceRoot, 'terminal-controller-multiwindow')
  fs.mkdirSync(workspace, { recursive: true })
  const agentId = await createControlAgent(page, workspace)

  await openPage(page)
  await selectAgent(page, agentId)
  await ensureTerminalOwner(page, agentId)
  await expectRendererFlowControlProgress(page, agentId, `CODE_FLOW_${Date.now()}`)

  const observerPage = await context.newPage()
  await observerPage.addInitScript(() => {
    window.__FARMING_E2E__ = true
  })
  try {
    await openPage(observerPage)
    await selectAgent(observerPage, agentId)
    await expect(terminalHost(observerPage, agentId))
      .toHaveAttribute('data-controller-status', 'observer')

    await observerPage.reload({ waitUntil: 'domcontentloaded' })
    await expect(observerPage.getByTestId('app-shell')).toBeVisible()
    await selectAgent(observerPage, agentId)
    await expect(terminalHost(observerPage, agentId))
      .toHaveAttribute('data-controller-status', 'observer')
    await expect(terminalHost(page, agentId))
      .toHaveAttribute('data-controller-status', 'owner')

    const beforeObserverResize = await waitForStableSessionRevision(page, agentId)
    await observerPage.evaluate((id) => {
      window.__farmingTerminalTest?.notifyResizeForTest(id, 101, 31)
    }, agentId)
    await observerPage.waitForTimeout(150)
    const afterObserverResize = await waitForStableSessionRevision(page, agentId)
    expect(afterObserverResize.previewCols).toBe(beforeObserverResize.previewCols)
    expect(afterObserverResize.previewRows).toBe(beforeObserverResize.previewRows)

    const observerBlockedMarker = `CODE_OBSERVER_BLOCKED_${Date.now()}`
    await terminalHost(observerPage, agentId).locator('.xterm-helper-textarea').focus()
    await observerPage.keyboard.insertText(observerBlockedMarker)
    await observerPage.waitForTimeout(150)
    const afterObserverInput = await waitForStableSessionRevision(page, agentId)
    expect(afterObserverInput.renderOutput || '').not.toContain(observerBlockedMarker)
    await expect(terminalHost(observerPage, agentId))
      .toHaveAttribute('data-controller-status', 'observer')

    await terminalHost(observerPage, agentId).click({ position: { x: 20, y: 20 } })
    await observerPage.waitForTimeout(100)
    await expect(terminalHost(observerPage, agentId))
      .toHaveAttribute('data-controller-status', 'observer')
    await terminalHost(observerPage, agentId)
      .locator('.terminal-controller-takeover')
      .click()
    await expect(terminalHost(observerPage, agentId))
      .toHaveAttribute('data-controller-status', 'owner')
    await waitForTerminalSettled(observerPage, agentId)
    await expect(terminalHost(observerPage, agentId).locator('.xterm-helper-textarea')).toBeFocused()
    await expect(terminalHost(page, agentId))
      .toHaveAttribute('data-controller-status', 'observer')

    const beforeTakeoverResize = await sessionState(page, agentId)
    const takeoverDiagnostics = await observerPage.evaluate(id => (
      window.__farmingTerminalTest?.getBufferDiagnostics(id)
    ), agentId)
    await observerPage.setViewportSize({ width: 1240, height: 780 })
    await expect.poll(async () => {
      const state = await sessionState(page, agentId)
      const diagnostics = await observerPage.evaluate(id => (
        window.__farmingTerminalTest?.getBufferDiagnostics(id)
      ), agentId)
      return {
        revisionAdvanced: (state.stateRevision || 0) > (beforeTakeoverResize.stateRevision || 0),
        dimensionsChanged: Boolean(diagnostics && (
          diagnostics.cols !== takeoverDiagnostics?.cols
          || diagnostics.rows !== takeoverDiagnostics?.rows
        )),
        committed: Boolean(
          diagnostics
          && state.previewCols === diagnostics.cols
          && state.previewRows === diagnostics.rows
        ),
      }
    }).toEqual({ revisionAdvanced: true, dimensionsChanged: true, committed: true })
    const afterOwnerResize = await sessionState(page, agentId)

    await page.setViewportSize({ width: 1320, height: 820 })
    await page.waitForTimeout(150)
    const afterRevokedResize = await sessionState(page, agentId)
    expect(afterRevokedResize.previewCols).toBe(afterOwnerResize.previewCols)
    expect(afterRevokedResize.previewRows).toBe(afterOwnerResize.previewRows)

    await observerPage.close()
    await terminalHost(page, agentId)
      .locator('.terminal-controller-takeover')
      .click()
    await expect(terminalHost(page, agentId))
      .toHaveAttribute('data-controller-status', 'owner')
    await waitForTerminalSettled(page, agentId)
    await expect(terminalHost(page, agentId).locator('.xterm-helper-textarea')).toBeFocused()
    await page.waitForFunction(id => Boolean(window.__farmingTerminalTest?.isReady(id)), agentId)
    await waitForCommittedTerminalGeometry(page, agentId)
    const reacquiredState = await sessionState(page, agentId)
    const reacquiredDiagnostics = await page.evaluate(id => (
      window.__farmingTerminalTest?.getBufferDiagnostics(id)
    ), agentId)
    await page.setViewportSize({ width: 1160, height: 740 })
    await expect.poll(async () => {
      const state = await sessionState(page, agentId)
      const diagnostics = await page.evaluate(id => (
        window.__farmingTerminalTest?.getBufferDiagnostics(id)
      ), agentId)
      return Boolean(
        diagnostics
        && state.stateRevision > (reacquiredState.stateRevision || 0)
        && diagnostics.cols !== reacquiredDiagnostics?.cols
        && state.previewCols === diagnostics.cols
        && state.previewRows === diagnostics.rows
      )
    }).toBe(true)
    await waitForCommittedTerminalGeometry(page, agentId)
  } finally {
    if (!observerPage.isClosed()) await observerPage.close()
  }
})

test('three browser windows serialize explicit controller takeovers without stale input', async ({
  page,
  context,
  workspaceRoot,
}) => {
  const workspace = path.join(workspaceRoot, 'terminal-controller-three-windows')
  fs.mkdirSync(workspace, { recursive: true })
  const resultFile = path.join(workspace, 'third-owner.txt')
  const agentId = await createControlAgent(page, workspace)

  await openPage(page)
  await selectAgent(page, agentId)
  await ensureTerminalOwner(page, agentId)
  const secondPage = await context.newPage()
  const thirdPage = await context.newPage()
  for (const candidate of [secondPage, thirdPage]) {
    await candidate.addInitScript(() => { window.__FARMING_E2E__ = true })
  }
  try {
    await openPage(secondPage)
    await selectAgent(secondPage, agentId)
    await openPage(thirdPage)
    await selectAgent(thirdPage, agentId)
    await expect(terminalHost(secondPage, agentId)).toHaveAttribute('data-controller-status', 'observer')
    await expect(terminalHost(thirdPage, agentId)).toHaveAttribute('data-controller-status', 'observer')

    await terminalHost(secondPage, agentId).locator('.terminal-controller-takeover').click()
    await expect(terminalHost(secondPage, agentId)).toHaveAttribute('data-controller-status', 'owner')
    await expect(terminalHost(page, agentId)).toHaveAttribute('data-controller-status', 'observer')
    await expect(terminalHost(thirdPage, agentId)).toHaveAttribute('data-controller-status', 'observer')

    await terminalHost(thirdPage, agentId).locator('.terminal-controller-takeover').click()
    await expect(terminalHost(thirdPage, agentId)).toHaveAttribute('data-controller-status', 'owner')
    await waitForTerminalSettled(thirdPage, agentId)
    await expect(terminalHost(page, agentId)).toHaveAttribute('data-controller-status', 'observer')
    await expect(terminalHost(secondPage, agentId)).toHaveAttribute('data-controller-status', 'observer')

    const staleMarker = `STALE_SECOND_${Date.now()}`
    await terminalHost(secondPage, agentId).locator('.xterm-helper-textarea').focus()
    await secondPage.keyboard.insertText(staleMarker)
    await secondPage.waitForTimeout(150)
    expect((await sessionState(page, agentId)).renderOutput || '').not.toContain(staleMarker)

    const input = terminalHost(thirdPage, agentId).locator('.xterm-helper-textarea')
    await input.focus()
    await thirdPage.keyboard.insertText(`printf 'third-owner\\n' > ${JSON.stringify(resultFile)}`)
    await input.press('Enter')
    await expectFileText(resultFile, 'third-owner\n')
  } finally {
    await secondPage.close()
    await thirdPage.close()
  }
})

test('Code and CRT share one explicit terminal controller without stealing on observation', async ({
  page,
  context,
  workspaceRoot,
}) => {
  const workspace = path.join(workspaceRoot, 'terminal-controller-cross-skin')
  fs.mkdirSync(workspace, { recursive: true })
  const agentId = await createControlAgent(page, workspace)

  await openPage(page)
  await selectAgent(page, agentId)
  await ensureTerminalOwner(page, agentId)

  const crtPage = await context.newPage()
  await crtPage.addInitScript(() => {
    window.__FARMING_E2E__ = true
  })
  try {
    await crtPage.goto(`/farming/crt/?agent=${agentId}`, { waitUntil: 'domcontentloaded' })
    await expect(crtPage.locator('#session-modal')).toHaveClass(/active/, { timeout: 30_000 })
    const takeover = crtPage.locator('.crt-terminal-takeover')
    await expect(takeover).toBeVisible({ timeout: 30_000 })

    await crtPage.waitForTimeout(500)
    const beforeObserverInput = await waitForStableSessionRevision(page, agentId)
    const blockedMarker = `observer-blocked-${Date.now()}`
    await crtPage.locator('#terminal-output .xterm-helper-textarea').focus()
    await crtPage.keyboard.insertText(blockedMarker)
    await crtPage.waitForTimeout(250)
    const afterObserverInput = await waitForStableSessionRevision(page, agentId)
    expect(afterObserverInput.renderOutput || '').not.toContain(blockedMarker)
    if (afterObserverInput.outputSeq === beforeObserverInput.outputSeq) {
      expect(afterObserverInput.stateRevision).toBe(beforeObserverInput.stateRevision)
    }

    await crtPage.locator('#terminal-output').click({ position: { x: 20, y: 20 } })
    await crtPage.waitForTimeout(100)
    await expect(takeover).toBeVisible()
    await expect(terminalHost(page, agentId)).toHaveAttribute('data-controller-status', 'owner')

    await takeover.click()
    await expect(takeover).toBeHidden()
    await expect(crtPage.locator('.crt-terminal-sync-status')).toBeHidden()
    await expect(terminalHost(page, agentId)).toHaveAttribute('data-controller-status', 'observer')
    await expect(crtPage.locator('#terminal-output .xterm-helper-textarea')).toBeFocused()
    const beforeInvalidResize = await sessionState(page, agentId)
    const beforeInvalidLocalSize = await crtPage.evaluate(() => window.__farmingCrtTerminalTest?.getState())
    await crtPage.evaluate(() => window.__farmingCrtTerminalTest?.notifyResizeForTest(20, 5))
    await crtPage.waitForTimeout(150)
    const afterInvalidResize = await sessionState(page, agentId)
    const afterInvalidLocalSize = await crtPage.evaluate(() => window.__farmingCrtTerminalTest?.getState())
    expect(afterInvalidResize.previewCols).toBe(beforeInvalidResize.previewCols)
    expect(afterInvalidResize.previewRows).toBe(beforeInvalidResize.previewRows)
    expect(afterInvalidLocalSize?.cols).toBe(beforeInvalidLocalSize?.cols)
    expect(afterInvalidLocalSize?.rows).toBe(beforeInvalidLocalSize?.rows)
    expect(afterInvalidLocalSize?.controllerStatus).toBe('owner')
    await expectRendererFlowControlProgress(crtPage, agentId, `CRT_FLOW_${Date.now()}`)

    await terminalHost(page, agentId).locator('.terminal-controller-takeover').click()
    await expect(terminalHost(page, agentId)).toHaveAttribute('data-controller-status', 'owner')
    await expect(takeover).toBeVisible()
  } finally {
    await crtPage.close()
  }
})

test('IME and Unicode input commit exactly once for the owner and never leak from observers', async ({
  page,
  context,
  workspaceRoot,
}) => {
  const workspace = path.join(workspaceRoot, 'terminal-ime-multiwindow')
  fs.mkdirSync(workspace, { recursive: true })
  const agentId = await createControlAgent(page, workspace)
  const codeOwnerFile = path.join(workspace, 'code-owner-ime.txt')
  const codeObserverFile = path.join(workspace, 'code-observer-ime.txt')
  const crtOwnerFile = path.join(workspace, 'crt-owner-ime.txt')

  await openPage(page)
  await selectAgent(page, agentId)
  await ensureTerminalOwner(page, agentId)
  await dispatchComposition(
    page,
    `.terminal-session-host[data-agent-id="${agentId}"] .xterm-helper-textarea`,
    `printf '中文输入\\n' >> ${JSON.stringify(codeOwnerFile)}\r`,
  )
  await expectFileText(codeOwnerFile, '中文输入\n')

  const observerPage = await context.newPage()
  await observerPage.addInitScript(() => {
    window.__FARMING_E2E__ = true
  })
  const crtPage = await context.newPage()
  await crtPage.addInitScript(() => {
    window.__FARMING_E2E__ = true
  })
  try {
    await openPage(observerPage)
    await selectAgent(observerPage, agentId)
    await expect(terminalHost(observerPage, agentId))
      .toHaveAttribute('data-controller-status', 'observer')
    await dispatchComposition(
      observerPage,
      `.terminal-session-host[data-agent-id="${agentId}"] .xterm-helper-textarea`,
      `printf '不应写入\\n' >> ${JSON.stringify(codeObserverFile)}\r`,
    )
    await observerPage.waitForTimeout(300)
    expect(fs.existsSync(codeObserverFile)).toBe(false)
    await expect(terminalHost(observerPage, agentId).locator('.terminal-controller-takeover'))
      .toBeFocused()

    await crtPage.goto(`/farming/crt/?agent=${agentId}`, { waitUntil: 'domcontentloaded' })
    await expect(crtPage.locator('#session-modal')).toHaveClass(/active/, { timeout: 30_000 })
    const takeover = crtPage.locator('.crt-terminal-takeover')
    await expect(takeover).toBeVisible({ timeout: 30_000 })
    await takeover.click()
    await expect(takeover).toBeHidden()
    await expect(terminalHost(page, agentId)).toHaveAttribute('data-controller-status', 'observer')
    await expect(crtPage.locator('.crt-terminal-sync-status')).toBeHidden({ timeout: 15_000 })

    const crtInput = crtPage.locator('#terminal-output .xterm-helper-textarea')
    await expect(crtInput).toBeFocused()
    await crtPage.keyboard.insertText(
      `printf '终端输入\\n' >> ${JSON.stringify(crtOwnerFile)}`,
    )
    await crtPage.waitForTimeout(150)
    await crtInput.press('Enter')
    await expectFileText(crtOwnerFile, '终端输入\n')
    expect(fs.readFileSync(codeOwnerFile, 'utf8')).toBe('中文输入\n')
  } finally {
    await observerPage.close()
    await crtPage.close()
  }
})
