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
