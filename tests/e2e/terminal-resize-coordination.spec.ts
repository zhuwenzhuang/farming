import fs from 'node:fs'
import path from 'node:path'
import { expect, test } from './fixtures'

declare global {
  interface Window {
    __farmingResizeMessages?: Array<{
      type: string
      agentId?: string
      cols?: number
      rows?: number
    }>
  }
}

async function createControlAgent(page: import('@playwright/test').Page, workspace: string) {
  const response = await page.request.post('/farming/api/control/agents', {
    data: { command: 'bash', workspace },
  })
  expect(response.ok()).toBeTruthy()
  const data = await response.json() as { agentId?: string }
  expect(data.agentId).toBeTruthy()
  return data.agentId as string
}

async function installResizeMessageCapture(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    window.__farmingResizeMessages = []
    const originalSend = WebSocket.prototype.send
    WebSocket.prototype.send = function send(data) {
      if (typeof data === 'string') {
        try {
          const message = JSON.parse(data) as { type?: string; agentId?: string; cols?: number; rows?: number }
          if (message.type === 'resize-agent') {
            window.__farmingResizeMessages?.push({
              type: message.type,
              agentId: message.agentId,
              cols: message.cols,
              rows: message.rows,
            })
          }
        } catch {
          // Ignore non-JSON WebSocket traffic.
        }
      }
      return originalSend.call(this, data)
    }
  })
}

async function openAgent(page: import('@playwright/test').Page, agentId: string) {
  const row = page.locator(
    `[data-testid="code-agent-row"][data-agent-id="${agentId}"], ` +
    `[data-testid="code-project-agent-compact"][data-agent-id="${agentId}"]`,
  ).first()
  await expect(row).toBeVisible({ timeout: 30_000 })
  await row.click()
  await expect(page.locator(`.terminal-session-host[data-agent-id="${agentId}"]`))
    .toBeVisible({ timeout: 15_000 })
  await page.waitForFunction(id => Boolean(window.__farmingTerminalTest?.isReady(id)), agentId)
}

async function sendActiveTerminalCommand(
  page: import('@playwright/test').Page,
  agentId: string,
  command: string,
) {
  const host = page.locator(
    `[data-testid="code-terminal-pane"][data-agent-id="${agentId}"].active ` +
    `.terminal-session-host[data-agent-id="${agentId}"]`,
  )
  await expect(host).toBeVisible({ timeout: 15_000 })
  await page.waitForFunction(id => Boolean(window.__farmingTerminalTest?.isReady(id)), agentId)
  const inputCount = await page.evaluate(
    id => window.__farmingTerminalTest?.getInputCount(id) ?? 0,
    agentId,
  )
  const input = host.locator('.xterm-helper-textarea')
  await input.focus()
  await page.keyboard.insertText(command)
  await input.press('Enter')
  await expect.poll(() => page.evaluate(
    id => window.__farmingTerminalTest?.getInputCount(id) ?? 0,
    agentId,
  )).toBeGreaterThan(inputCount)
}

async function waitForFileLines(file: string, expected: string[]) {
  await expect.poll(() => (
    fs.existsSync(file)
      ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).sort()
      : []
  )).toEqual([...expected].sort())
}

test('keeps newer local terminal geometry while older resize transitions arrive', async ({ page, workspaceRoot }) => {
  await installResizeMessageCapture(page)

  const workspace = path.join(workspaceRoot, 'terminal-resize-coordination')
  fs.mkdirSync(workspace, { recursive: true })
  await page.goto('/farming/', { waitUntil: 'domcontentloaded' })
  await expect(page.getByTestId('app-shell')).toBeVisible()

  const agentId = await createControlAgent(page, workspace)
  const row = page.locator(
    `[data-testid="code-agent-row"][data-agent-id="${agentId}"], ` +
    `[data-testid="code-project-agent-compact"][data-agent-id="${agentId}"]`,
  ).first()
  await expect(row).toBeVisible({ timeout: 30_000 })
  await row.click()
  await expect(page.locator(`.terminal-session-host[data-agent-id="${agentId}"]`))
    .toBeVisible({ timeout: 15_000 })
  await page.waitForFunction(id => Boolean(window.__farmingTerminalTest?.isReady(id)), agentId)
  await expect.poll(() => page.evaluate(id => {
    const diagnostics = window.__farmingTerminalTest?.getBufferDiagnostics(id) as unknown as {
      resizeRequestInFlight?: { cols: number; rows: number } | null
      pendingResizeRequest?: { cols: number; rows: number } | null
    } | null
    return {
      inFlight: diagnostics?.resizeRequestInFlight ?? null,
      pending: diagnostics?.pendingResizeRequest ?? null,
    }
  }, agentId)).toEqual({ inFlight: null, pending: null })

  const resizeCountBeforeRecovery = await page.evaluate(
    id => window.__farmingResizeMessages?.filter(message => message.agentId === id).length ?? 0,
    agentId,
  )
  await page.evaluate(() => window.dispatchEvent(new Event('farming:backend-connected')))
  await expect.poll(() => page.evaluate(id => {
    const diagnostics = window.__farmingTerminalTest?.getBufferDiagnostics(id) as unknown as {
      resizeRequestInFlight?: { cols: number; rows: number } | null
      pendingResizeRequest?: { cols: number; rows: number } | null
      needsReconnectOutputSync?: boolean
    } | null
    return {
      inFlight: diagnostics?.resizeRequestInFlight ?? null,
      pending: diagnostics?.pendingResizeRequest ?? null,
      recovering: diagnostics?.needsReconnectOutputSync ?? true,
    }
  }, agentId)).toEqual({ inFlight: null, pending: null, recovering: false })
  expect(await page.evaluate(
    id => window.__farmingResizeMessages?.filter(message => message.agentId === id).length ?? 0,
    agentId,
  )).toBe(resizeCountBeforeRecovery)

  const initial = await page.evaluate(id => {
    const diagnostics = window.__farmingTerminalTest?.getBufferDiagnostics(id)
    return {
      cols: diagnostics?.cols ?? 100,
      rows: diagnostics?.rows ?? 30,
      messageCount: window.__farmingResizeMessages?.filter(message => message.agentId === id).length ?? 0,
    }
  }, agentId)
  const sizes = Array.from({ length: 10 }, (_, index) => ({
    cols: initial.cols + ((index + 1) * 2),
    rows: initial.rows,
  }))
  const first = sizes[0]
  const latest = sizes[sizes.length - 1]

  const observed = await page.evaluate(async ({ id, sizes: requestedSizes }) => {
    const api = window.__farmingTerminalTest
    if (!api) throw new Error('terminal test API is unavailable')
    requestedSizes.forEach(({ cols, rows }) => api.notifyResizeForTest(id, cols, rows))

    const immediate = api.getBufferDiagnostics(id) as unknown as {
      cols: number
      rows: number
      resizeRequestInFlight?: { cols: number; rows: number } | null
      pendingResizeRequest?: { cols: number; rows: number } | null
    }
    const samples: Array<{ cols: number; rows: number }> = []
    const startedAt = performance.now()
    await new Promise<void>((resolve) => {
      const sample = () => {
        const diagnostics = api.getBufferDiagnostics(id) as unknown as {
          cols: number
          rows: number
          resizeRequestInFlight?: { cols: number; rows: number } | null
          pendingResizeRequest?: { cols: number; rows: number } | null
        } | null
        if (diagnostics) samples.push({ cols: diagnostics.cols, rows: diagnostics.rows })
        const settled = Boolean(
          diagnostics &&
          diagnostics.resizeRequestInFlight == null &&
          diagnostics.pendingResizeRequest == null,
        )
        if ((settled && samples.length >= 2) || performance.now() - startedAt > 2_000) {
          resolve()
          return
        }
        requestAnimationFrame(sample)
      }
      requestAnimationFrame(sample)
    })

    return {
      immediate: {
        cols: immediate.cols,
        rows: immediate.rows,
        inFlight: immediate.resizeRequestInFlight ?? null,
        pending: immediate.pendingResizeRequest ?? null,
      },
      samples,
      messages: (window.__farmingResizeMessages ?? []).filter(message => message.agentId === id),
    }
  }, { id: agentId, sizes })

  expect(observed.immediate).toEqual({
    cols: latest.cols,
    rows: latest.rows,
    inFlight: first,
    pending: latest,
  })
  expect(observed.samples.length).toBeGreaterThan(0)
  expect(observed.samples.every(sample => sample.cols === latest.cols && sample.rows === latest.rows)).toBe(true)
  expect(observed.messages.slice(initial.messageCount).map(message => ({
    cols: message.cols,
    rows: message.rows,
  }))).toEqual([first, latest])

  await expect.poll(async () => {
    const response = await page.request.get(`/farming/api/agents/${agentId}/session-view`)
    const body = await response.json() as { session?: { previewCols?: number; previewRows?: number } }
    return {
      cols: body.session?.previewCols ?? null,
      rows: body.session?.previewRows ?? null,
    }
  }).toEqual({ cols: latest.cols, rows: latest.rows })
})

test('coalesces a sustained diagonal window drag into one geometry update', async ({ page, workspaceRoot }) => {
  await installResizeMessageCapture(page)
  await page.setViewportSize({ width: 1280, height: 720 })

  const workspace = path.join(workspaceRoot, 'terminal-window-resize-debounce')
  fs.mkdirSync(workspace, { recursive: true })
  await page.goto('/farming/', { waitUntil: 'domcontentloaded' })
  await expect(page.getByTestId('app-shell')).toBeVisible()

  const agentId = await createControlAgent(page, workspace)
  const row = page.locator(
    `[data-testid="code-agent-row"][data-agent-id="${agentId}"], ` +
    `[data-testid="code-project-agent-compact"][data-agent-id="${agentId}"]`,
  ).first()
  await expect(row).toBeVisible({ timeout: 30_000 })
  await row.click()
  await expect(page.locator(`.terminal-session-host[data-agent-id="${agentId}"]`))
    .toBeVisible({ timeout: 15_000 })
  await page.waitForFunction(id => Boolean(window.__farmingTerminalTest?.isReady(id)), agentId)
  await expect.poll(() => page.evaluate(
    id => window.__farmingTerminalTest?.getBufferDiagnostics(id)?.renderer,
    agentId,
  )).toBe('webgl')

  await page.evaluate(async id => {
    const lines = Array.from({ length: 260 }, (_, index) => `resize-line-${index + 1}`)
    await window.__farmingTerminalTest?.writeFixture(id, `${lines.join('\r\n')}\r\n`)
  }, agentId)
  await expect.poll(() => page.evaluate(id => {
    const diagnostics = window.__farmingTerminalTest?.getBufferDiagnostics(id) as unknown as {
      resizeRequestInFlight?: { cols: number; rows: number } | null
      pendingResizeRequest?: { cols: number; rows: number } | null
      fitResizeTimerPending?: boolean
    } | null
    return {
      inFlight: diagnostics?.resizeRequestInFlight ?? null,
      pending: diagnostics?.pendingResizeRequest ?? null,
      fitPending: diagnostics?.fitResizeTimerPending ?? false,
    }
  }, agentId)).toEqual({ inFlight: null, pending: null, fitPending: false })

  const before = await page.evaluate(id => {
    const diagnostics = window.__farmingTerminalTest?.getBufferDiagnostics(id)
    return {
      cols: diagnostics?.cols ?? 0,
      rows: diagnostics?.rows ?? 0,
      messageCount: window.__farmingResizeMessages?.filter(message => message.agentId === id).length ?? 0,
    }
  }, agentId)
  const viewportSizes = [
    { width: 1260, height: 710 },
    { width: 1240, height: 700 },
    { width: 1220, height: 690 },
    { width: 1200, height: 680 },
    { width: 1180, height: 670 },
    { width: 1160, height: 660 },
    { width: 1140, height: 650 },
    { width: 1120, height: 640 },
    { width: 1100, height: 630 },
  ]
  const duringDimensions: Array<{ cols: number; rows: number }> = []
  for (const size of viewportSizes) {
    await page.setViewportSize(size)
    await page.waitForTimeout(125)
    duringDimensions.push(await page.evaluate(id => {
      const diagnostics = window.__farmingTerminalTest?.getBufferDiagnostics(id)
      return {
        cols: diagnostics?.cols ?? 0,
        rows: diagnostics?.rows ?? 0,
      }
    }, agentId))
  }

  expect(duringDimensions.every(({ cols, rows }) => (
    cols === before.cols && rows === before.rows
  ))).toBe(true)
  await expect.poll(() => page.evaluate(({ id, initial }) => {
    const diagnostics = window.__farmingTerminalTest?.getBufferDiagnostics(id) as unknown as {
      cols: number
      rows: number
      resizeRequestInFlight?: { cols: number; rows: number } | null
      pendingResizeRequest?: { cols: number; rows: number } | null
      fitResizeTimerPending?: boolean
    } | null
    return {
      colsChanged: Boolean(diagnostics && diagnostics.cols !== initial.cols),
      rowsChanged: Boolean(diagnostics && diagnostics.rows !== initial.rows),
      inFlight: diagnostics?.resizeRequestInFlight ?? null,
      pending: diagnostics?.pendingResizeRequest ?? null,
      fitPending: diagnostics?.fitResizeTimerPending ?? false,
    }
  }, { id: agentId, initial: before })).toEqual({
    colsChanged: true,
    rowsChanged: true,
    inFlight: null,
    pending: null,
    fitPending: false,
  })

  const messages = await page.evaluate(
    ({ id, offset }) => (window.__farmingResizeMessages ?? [])
      .filter(message => message.agentId === id)
      .slice(offset)
      .map(message => ({ cols: message.cols, rows: message.rows })),
    { id: agentId, offset: before.messageCount },
  )
  expect(messages).toHaveLength(1)
  expect(messages[0].cols).not.toBe(before.cols)
  expect(messages[0].rows).not.toBe(before.rows)

  await expect.poll(async () => {
    const response = await page.request.get(`/farming/api/agents/${agentId}/session-view`)
    const body = await response.json() as { session?: { previewCols?: number; previewRows?: number } }
    return {
      cols: body.session?.previewCols ?? null,
      rows: body.session?.previewRows ?? null,
    }
  }).toEqual(messages[0])
})

test('different-sized viewers settle after repeatedly switching the same terminal', async ({
  page,
  context,
  workspaceRoot,
}) => {
  await installResizeMessageCapture(page)
  await page.setViewportSize({ width: 1280, height: 720 })

  const workspace = path.join(workspaceRoot, 'terminal-shared-viewer-resize-settle')
  fs.mkdirSync(workspace, { recursive: true })
  await page.goto('/farming/', { waitUntil: 'domcontentloaded' })
  await expect(page.getByTestId('app-shell')).toBeVisible()
  const sharedAgentId = await createControlAgent(page, workspace)
  const alternateAgentId = await createControlAgent(page, workspace)

  const widePage = await context.newPage()
  await widePage.addInitScript(() => {
    window.__FARMING_E2E__ = true
  })
  await installResizeMessageCapture(widePage)
  await widePage.setViewportSize({ width: 1855, height: 1391 })
  await widePage.goto('/farming/', { waitUntil: 'domcontentloaded' })
  await expect(widePage.getByTestId('app-shell')).toBeVisible()

  try {
    await openAgent(page, sharedAgentId)
    await openAgent(widePage, sharedAgentId)

    for (let index = 0; index < 4; index += 1) {
      await openAgent(page, alternateAgentId)
      await openAgent(page, sharedAgentId)
      await openAgent(widePage, alternateAgentId)
      await openAgent(widePage, sharedAgentId)
    }

    const messageCount = async () => {
      const [narrow, wide] = await Promise.all([
        page.evaluate(id => window.__farmingResizeMessages
          ?.filter(message => message.agentId === id).length ?? 0, sharedAgentId),
        widePage.evaluate(id => window.__farmingResizeMessages
          ?.filter(message => message.agentId === id).length ?? 0, sharedAgentId),
      ])
      return narrow + wide
    }

    await page.waitForTimeout(1_000)
    const settledCount = await messageCount()
    await page.waitForTimeout(1_000)
    expect(await messageCount()).toBe(settledCount)
    expect(settledCount).toBeLessThanOrEqual(12)

    const recover = async (viewer: import('@playwright/test').Page) => {
      await viewer.evaluate(() => window.dispatchEvent(new Event('farming:backend-connected')))
      await expect.poll(() => viewer.evaluate(id => {
        const diagnostics = window.__farmingTerminalTest?.getBufferDiagnostics(id)
        return Boolean(
          diagnostics
          && diagnostics.needsReconnectOutputSync === false
          && diagnostics.replayInProgress === false
          && diagnostics.checkpointRequestInFlight === false,
        )
      }, sharedAgentId)).toBe(true)
    }
    for (let index = 0; index < 3; index += 1) {
      await recover(page)
      await recover(widePage)
    }
    await page.waitForTimeout(1_000)
    expect(await messageCount()).toBe(settledCount)

    const [narrowRows, wideRows] = await Promise.all([
      page.evaluate(id => window.__farmingTerminalTest?.getRows(id) ?? [], sharedAgentId),
      widePage.evaluate(id => window.__farmingTerminalTest?.getRows(id) ?? [], sharedAgentId),
    ])
    expect(narrowRows.some(row => row.trim().length > 0)).toBe(true)
    expect(wideRows.some(row => row.trim().length > 0)).toBe(true)
  } finally {
    await widePage.close()
  }
})

test('different-sized viewers converge after concurrent rapid Agent switching', async ({
  page,
  context,
  workspaceRoot,
}) => {
  await installResizeMessageCapture(page)
  await page.setViewportSize({ width: 1280, height: 720 })

  const workspace = path.join(workspaceRoot, 'terminal-shared-viewer-rapid-switch')
  fs.mkdirSync(workspace, { recursive: true })
  await page.goto('/farming/', { waitUntil: 'domcontentloaded' })
  await expect(page.getByTestId('app-shell')).toBeVisible()
  const firstAgentId = await createControlAgent(page, workspace)
  const secondAgentId = await createControlAgent(page, workspace)

  const widePage = await context.newPage()
  await widePage.addInitScript(() => {
    window.__FARMING_E2E__ = true
  })
  await installResizeMessageCapture(widePage)
  await widePage.setViewportSize({ width: 1855, height: 1391 })
  await widePage.goto('/farming/', { waitUntil: 'domcontentloaded' })
  await expect(widePage.getByTestId('app-shell')).toBeVisible()

  const rapidSwitch = async (viewer: import('@playwright/test').Page) => {
    const first = viewer.locator(`[data-testid="code-agent-row"][data-agent-id="${firstAgentId}"]`)
    const second = viewer.locator(`[data-testid="code-agent-row"][data-agent-id="${secondAgentId}"]`)
    await expect(first).toBeVisible({ timeout: 30_000 })
    await expect(second).toBeVisible({ timeout: 30_000 })
    for (let index = 0; index < 8; index += 1) {
      await first.click()
      await second.click()
    }
    await first.click()
  }

  try {
    await Promise.all([rapidSwitch(page), rapidSwitch(widePage)])
    await Promise.all([openAgent(page, firstAgentId), openAgent(widePage, firstAgentId)])

    for (const viewer of [page, widePage]) {
      await expect(viewer.locator(
        `[data-testid="code-agent-row"][data-agent-id="${firstAgentId}"]`,
      )).toHaveClass(/active/)
      await expect(viewer.locator(
        `[data-testid="code-terminal-pane"][data-agent-id="${firstAgentId}"]`,
      )).toBeVisible()
      await expect(viewer.getByTestId('code-terminal-recovery')).toBeHidden()
      await expect.poll(() => viewer.evaluate(id => {
        const diagnostics = window.__farmingTerminalTest?.getBufferDiagnostics(id)
        return {
          ready: window.__farmingTerminalTest?.isReady(id) ?? false,
          queuedTransitions: diagnostics?.queuedTransitions ?? -1,
          replayInProgress: diagnostics?.replayInProgress ?? true,
          needsReconnectOutputSync: diagnostics?.needsReconnectOutputSync ?? true,
        }
      }, firstAgentId)).toMatchObject({
        ready: true,
        queuedTransitions: 0,
        replayInProgress: false,
        needsReconnectOutputSync: false,
      })
      const nonblankRows = await viewer.evaluate(id => (
        window.__farmingTerminalTest?.getRows(id, 120).filter(row => row.trim()).length ?? 0
      ), firstAgentId)
      expect(nonblankRows).toBeGreaterThan(0)
    }

    const countMessages = async () => {
      const counts = await Promise.all([page, widePage].map(viewer => viewer.evaluate(
        id => window.__farmingResizeMessages?.filter(message => message.agentId === id).length ?? 0,
        firstAgentId,
      )))
      return counts[0] + counts[1]
    }
    await page.waitForTimeout(1_000)
    const settledCount = await countMessages()
    await page.waitForTimeout(1_000)
    expect(await countMessages()).toBe(settledCount)
  } finally {
    await widePage.close()
  }
})

test('routes each viewer input exactly once across switching and recovery', async ({
  page,
  context,
  workspaceRoot,
}) => {
  const sharedWorkspace = path.join(workspaceRoot, 'terminal-shared-viewer-input')
  const alternateWorkspace = path.join(workspaceRoot, 'terminal-shared-viewer-alternate')
  fs.mkdirSync(sharedWorkspace, { recursive: true })
  fs.mkdirSync(alternateWorkspace, { recursive: true })
  const sharedFile = path.join(sharedWorkspace, 'multi-viewer-input.log')
  const alternateFile = path.join(alternateWorkspace, 'multi-viewer-input.log')

  await page.goto('/farming/', { waitUntil: 'domcontentloaded' })
  await expect(page.getByTestId('app-shell')).toBeVisible()
  const sharedAgentId = await createControlAgent(page, sharedWorkspace)
  const alternateAgentId = await createControlAgent(page, alternateWorkspace)

  const observerPage = await context.newPage()
  await observerPage.addInitScript(() => {
    window.__FARMING_E2E__ = true
  })
  await observerPage.setViewportSize({ width: 1600, height: 1000 })
  await observerPage.goto('/farming/', { waitUntil: 'domcontentloaded' })
  await expect(observerPage.getByTestId('app-shell')).toBeVisible()

  const command = (marker: string) => `printf '%s\\n' '${marker}' >> multi-viewer-input.log`
  try {
    await Promise.all([openAgent(page, sharedAgentId), openAgent(observerPage, sharedAgentId)])
    await sendActiveTerminalCommand(page, sharedAgentId, command('primary-before'))
    await sendActiveTerminalCommand(observerPage, sharedAgentId, command('observer-before'))
    await waitForFileLines(sharedFile, ['primary-before', 'observer-before'])

    await openAgent(observerPage, alternateAgentId)
    await sendActiveTerminalCommand(page, sharedAgentId, command('primary-while-observer-away'))
    await sendActiveTerminalCommand(observerPage, alternateAgentId, command('observer-on-alternate'))
    await waitForFileLines(sharedFile, [
      'primary-before',
      'observer-before',
      'primary-while-observer-away',
    ])
    await waitForFileLines(alternateFile, ['observer-on-alternate'])

    await openAgent(observerPage, sharedAgentId)
    await Promise.all([page, observerPage].map(async viewer => {
      await viewer.evaluate(() => window.dispatchEvent(new Event('farming:backend-connected')))
      await viewer.waitForFunction(id => {
        const diagnostics = window.__farmingTerminalTest?.getBufferDiagnostics(id)
        return Boolean(
          diagnostics
          && diagnostics.needsReconnectOutputSync === false
          && diagnostics.replayInProgress === false
          && diagnostics.checkpointRequestInFlight === false,
        )
      }, sharedAgentId)
    }))

    await sendActiveTerminalCommand(page, sharedAgentId, command('primary-after-recovery'))
    await sendActiveTerminalCommand(observerPage, sharedAgentId, command('observer-after-recovery'))
    await waitForFileLines(sharedFile, [
      'primary-before',
      'observer-before',
      'primary-while-observer-away',
      'primary-after-recovery',
      'observer-after-recovery',
    ])
    await waitForFileLines(alternateFile, ['observer-on-alternate'])

    for (const viewer of [page, observerPage]) {
      await expect(viewer.getByTestId('code-terminal-recovery')).toBeHidden()
      await expect(viewer.locator(
        `[data-testid="code-terminal-pane"][data-agent-id="${sharedAgentId}"]`,
      )).toBeVisible()
    }
  } finally {
    await observerPage.close()
  }
})
