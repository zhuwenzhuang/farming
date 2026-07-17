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
      diagnostics?.geometryStatus === 'owner'
      && diagnostics.checkpointRequestInFlight === false
      && diagnostics.replayTargetRevision === null
      && diagnostics.replayInProgress === false
      && diagnostics.bootstrappingSnapshot === false
    ) return
    await page.waitForTimeout(100)
  }
  throw new Error(`terminal did not settle: ${JSON.stringify(diagnostics)}`)
}

async function ensureTerminalOwner(
  page: import('@playwright/test').Page,
  agentId: string,
) {
  const host = terminalHost(page, agentId)
  if (await host.getAttribute('data-geometry-status') !== 'owner') {
    await host.locator('.terminal-geometry-takeover').click()
  }
  await expect(host).toHaveAttribute('data-geometry-status', 'owner')
  await waitForTerminalSettled(page, agentId)
}

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
  const script = [
    'let i=0',
    'const timer=setInterval(()=>{',
    "if(i++<40){process.stdout.write('x'.repeat(5000));return}",
    'clearInterval(timer)',
    `process.stdout.write(${JSON.stringify(`\n${marker}\n`)})`,
    '},2)',
  ].join(';')
  const response = await page.request.post(`/farming/api/control/agents/${agentId}/input`, {
    data: { input: `node -e ${JSON.stringify(script)}\n` },
  })
  expect(response.ok()).toBeTruthy()
  await expect.poll(async () => (
    (await sessionState(page, agentId)).renderOutput || ''
  ), { timeout: 20_000 }).toContain(marker)
}

test('one browser owns PTY geometry and interactive takeover is fenced across windows', async ({
  page,
  context,
  workspaceRoot,
}) => {
  const workspace = path.join(workspaceRoot, 'terminal-geometry-multiwindow')
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
      .toHaveAttribute('data-geometry-status', 'observer')

    await observerPage.reload({ waitUntil: 'domcontentloaded' })
    await expect(observerPage.getByTestId('app-shell')).toBeVisible()
    await selectAgent(observerPage, agentId)
    await expect(terminalHost(observerPage, agentId))
      .toHaveAttribute('data-geometry-status', 'observer')
    await expect(terminalHost(page, agentId))
      .toHaveAttribute('data-geometry-status', 'owner')

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
      .toHaveAttribute('data-geometry-status', 'observer')

    await terminalHost(observerPage, agentId).click({ position: { x: 20, y: 20 } })
    await observerPage.waitForTimeout(100)
    await expect(terminalHost(observerPage, agentId))
      .toHaveAttribute('data-geometry-status', 'observer')
    await terminalHost(observerPage, agentId)
      .locator('.terminal-geometry-takeover')
      .click()
    await expect(terminalHost(observerPage, agentId))
      .toHaveAttribute('data-geometry-status', 'owner')
    await waitForTerminalSettled(observerPage, agentId)
    await expect(terminalHost(page, agentId))
      .toHaveAttribute('data-geometry-status', 'observer')

    const beforeOwnerResize = await waitForStableSessionRevision(page, agentId)
    const takeoverDiagnostics = await observerPage.evaluate(id => (
      window.__farmingTerminalTest?.getBufferDiagnostics(id)
    ), agentId)
    const takeoverCols = (takeoverDiagnostics?.cols || 80) + 7
    const takeoverRows = (takeoverDiagnostics?.rows || 30) + 5
    await observerPage.evaluate(({ id, cols, rows }) => {
      window.__farmingTerminalTest?.notifyResizeForTest(id, cols, rows)
    }, { id: agentId, cols: takeoverCols, rows: takeoverRows })
    await expect.poll(async () => (
      (await sessionState(page, agentId)).stateRevision || 0
    )).toBeGreaterThan(beforeOwnerResize.stateRevision || 0)
    const afterOwnerResize = await waitForStableSessionRevision(page, agentId)
    const ownerDiagnostics = await observerPage.evaluate(id => (
      window.__farmingTerminalTest?.getBufferDiagnostics(id)
    ), agentId)
    expect(afterOwnerResize.previewCols).toBe(ownerDiagnostics?.cols)
    expect(afterOwnerResize.previewRows).toBe(ownerDiagnostics?.rows)

    await page.evaluate((id) => {
      window.__farmingTerminalTest?.notifyResizeForTest(id, 111, 35)
    }, agentId)
    await page.waitForTimeout(150)
    const afterRevokedResize = await sessionState(page, agentId)
    expect(afterRevokedResize.previewCols).toBe(afterOwnerResize.previewCols)
    expect(afterRevokedResize.previewRows).toBe(afterOwnerResize.previewRows)

    await observerPage.close()
    await terminalHost(page, agentId)
      .locator('.terminal-geometry-takeover')
      .click()
    await expect(terminalHost(page, agentId))
      .toHaveAttribute('data-geometry-status', 'owner')
    await waitForTerminalSettled(page, agentId)
    await page.waitForFunction(id => Boolean(window.__farmingTerminalTest?.isReady(id)), agentId)
    const reacquiredState = await waitForStableSessionRevision(page, agentId)
    const reacquiredDiagnostics = await page.evaluate(id => (
      window.__farmingTerminalTest?.getBufferDiagnostics(id)
    ), agentId)
    await page.evaluate(({ id, cols, rows }) => {
      window.__farmingTerminalTest?.notifyResizeForTest(id, cols, rows)
    }, {
      id: agentId,
      cols: (reacquiredDiagnostics?.cols || 80) + 5,
      rows: (reacquiredDiagnostics?.rows || 30) + 3,
    })
    await expect.poll(async () => (
      (await sessionState(page, agentId)).stateRevision || 0
    )).toBeGreaterThan(reacquiredState.stateRevision || 0)
    const finalState = await waitForStableSessionRevision(page, agentId)
    const finalDiagnostics = await page.evaluate(id => (
      window.__farmingTerminalTest?.getBufferDiagnostics(id)
    ), agentId)
    expect(finalState.previewCols).toBe(finalDiagnostics?.cols)
    expect(finalState.previewRows).toBe(finalDiagnostics?.rows)
  } finally {
    if (!observerPage.isClosed()) await observerPage.close()
  }
})

test('Code and CRT share one explicit terminal controller without stealing on observation', async ({
  page,
  context,
  workspaceRoot,
}) => {
  const workspace = path.join(workspaceRoot, 'terminal-geometry-cross-skin')
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
    await expect(terminalHost(page, agentId)).toHaveAttribute('data-geometry-status', 'owner')

    await takeover.click()
    await expect(takeover).toBeHidden()
    await expect(terminalHost(page, agentId)).toHaveAttribute('data-geometry-status', 'observer')
    await expectRendererFlowControlProgress(crtPage, agentId, `CRT_FLOW_${Date.now()}`)

    await terminalHost(page, agentId).locator('.terminal-geometry-takeover').click()
    await expect(terminalHost(page, agentId)).toHaveAttribute('data-geometry-status', 'owner')
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
      .toHaveAttribute('data-geometry-status', 'observer')
    await dispatchComposition(
      observerPage,
      `.terminal-session-host[data-agent-id="${agentId}"] .xterm-helper-textarea`,
      `printf '不应写入\\n' >> ${JSON.stringify(codeObserverFile)}\r`,
    )
    await observerPage.waitForTimeout(300)
    expect(fs.existsSync(codeObserverFile)).toBe(false)
    await expect(terminalHost(observerPage, agentId).locator('.terminal-geometry-takeover'))
      .toBeFocused()

    await crtPage.goto(`/farming/crt/?agent=${agentId}`, { waitUntil: 'domcontentloaded' })
    await expect(crtPage.locator('#session-modal')).toHaveClass(/active/, { timeout: 30_000 })
    const takeover = crtPage.locator('.crt-terminal-takeover')
    await expect(takeover).toBeVisible({ timeout: 30_000 })
    await takeover.click()
    await expect(takeover).toBeHidden()
    await expect(terminalHost(page, agentId)).toHaveAttribute('data-geometry-status', 'observer')
    await expect(crtPage.locator('.crt-terminal-sync-status')).toBeHidden({ timeout: 15_000 })

    const crtInput = crtPage.locator('#terminal-output .xterm-helper-textarea')
    await crtInput.focus()
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
