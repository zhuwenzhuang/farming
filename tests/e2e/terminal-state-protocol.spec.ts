import fs from 'node:fs'
import path from 'node:path'
import { expect, terminalRows, terminalViewport, test, writeTerminalFixture } from './fixtures'

async function openTerminalTestPage(page: import('@playwright/test').Page) {
  await page.goto('/farming/', { waitUntil: 'domcontentloaded' })
  await expect(page.getByTestId('app-shell')).toBeVisible()
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

async function selectControlAgent(page: import('@playwright/test').Page, agentId: string) {
  const row = page.locator(
    `[data-testid="code-agent-row"][data-agent-id="${agentId}"], ` +
    `[data-testid="code-project-agent-compact"][data-agent-id="${agentId}"], ` +
    `[data-testid="code-pinned-agent-compact"][data-agent-id="${agentId}"]`,
  ).first()
  await expect(row).toBeVisible({ timeout: 30_000 })
  await row.click()
  await expect(page.locator(`.terminal-session-host[data-agent-id="${agentId}"]`))
    .toBeVisible({ timeout: 15_000 })
  await page.waitForFunction(id => Boolean(window.__farmingTerminalTest?.isReady(id)), agentId)
  await waitForProtocolIdle(page, agentId)
}

function terminalHost(page: import('@playwright/test').Page, agentId: string) {
  return page.locator(`.terminal-session-host[data-agent-id="${agentId}"]`)
}

function nextEpoch(current: string, offset: number) {
  const match = /^farming-runtime-v1:(\d{20}):(.*)$/.exec(current)
  expect(match).not.toBeNull()
  const generation = Number(match?.[1] || 0) + offset
  return `farming-runtime-v1:${String(generation).padStart(20, '0')}:e2e-${offset}`
}

async function terminalState(page: import('@playwright/test').Page, agentId: string) {
  return page.evaluate((id) => {
    const diagnostics = window.__farmingTerminalTest?.getBufferDiagnostics(id)
    return {
      runtimeEpoch: window.__farmingTerminalTest?.getRuntimeEpoch(id) || '',
      outputSeq: window.__farmingTerminalTest?.getLastOutputSeq(id) ?? 0,
      stateRevision: window.__farmingTerminalTest?.getStateRevision(id) ?? 0,
      cols: diagnostics?.cols ?? 80,
      rows: diagnostics?.rows ?? 30,
    }
  }, agentId)
}

async function authoritativeTerminalState(
  page: import('@playwright/test').Page,
  agentId: string,
) {
  const response = await page.request.get(`/farming/api/agents/${agentId}/session-view`)
  expect(response.ok()).toBeTruthy()
  const body = await response.json() as {
    session?: {
      runtimeEpoch?: string
      outputSeq?: number
      stateRevision?: number
    }
  }
  return {
    runtimeEpoch: body.session?.runtimeEpoch || '',
    outputSeq: body.session?.outputSeq ?? 0,
    stateRevision: body.session?.stateRevision ?? 0,
  }
}

async function waitForProtocolIdle(
  page: import('@playwright/test').Page,
  agentId: string,
) {
  let stableCuts = 0
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const first = await terminalState(page, agentId)
    await page.waitForTimeout(75)
    const second = await terminalState(page, agentId)
    const authoritative = await authoritativeTerminalState(page, agentId)
    if (
      first.runtimeEpoch === second.runtimeEpoch &&
      first.outputSeq === second.outputSeq &&
      first.stateRevision === second.stateRevision &&
      second.runtimeEpoch === authoritative.runtimeEpoch &&
      second.outputSeq === authoritative.outputSeq &&
      second.stateRevision === authoritative.stateRevision
    ) {
      stableCuts += 1
      if (stableCuts >= 3) return
    } else {
      stableCuts = 0
    }
  }
  throw new Error('terminal protocol did not reach an authoritative idle cut')
}

function checkpoint(
  runtimeEpoch: string,
  outputSeq: number,
  stateRevision: number,
  cols: number,
  rows: number,
  label: string,
) {
  const renderOutput = `${label}\r\n$ `
  return {
    session: {
      runtimeEpoch,
      output: renderOutput,
      renderOutput,
      outputSeq,
      stateRevision,
      previewCols: cols,
      previewRows: rows,
    },
  }
}

async function visibleText(page: import('@playwright/test').Page, agentId: string) {
  return (await terminalRows(page, agentId, 80)).join('\n')
}

test.describe('terminal state protocol', () => {
  test('terminal starts on LAN HTTP where crypto.randomUUID is unavailable', async ({ page, workspaceRoot }) => {
    await page.addInitScript(() => {
      Object.defineProperty(globalThis.crypto, 'randomUUID', {
        configurable: true,
        value: undefined,
      })
    })
    const workspace = path.join(workspaceRoot, 'terminal-insecure-http-uuid')
    fs.mkdirSync(workspace, { recursive: true })
    const agentId = await createControlAgent(page, workspace)
    await openTerminalTestPage(page)
    await selectControlAgent(page, agentId)
    await expect(terminalHost(page, agentId)).toBeVisible()
    await expect(terminalHost(page, agentId).locator('.terminal-controller-status')).toHaveCount(0)
  })

  test('resuming a stale visible fixture installs one latest checkpoint instead of replaying history', async ({ page, workspaceRoot }) => {
    const workspace = path.join(workspaceRoot, 'terminal-one-shot-latest-checkpoint')
    fs.mkdirSync(workspace, { recursive: true })
    const agentId = await createControlAgent(page, workspace)
    await openTerminalTestPage(page)
    await selectControlAgent(page, agentId)
    await writeTerminalFixture(page, agentId, 'STALE_VISIBLE_TERMINAL\r\n$ ')

    const marker = `LATEST_CHECKPOINT_${Date.now()}`
    const input = await page.request.post(`/farming/api/control/agents/${agentId}/input`, {
      data: {
        input: `for i in $(seq 1 240); do printf 'history-%03d\\n' "$i"; done; printf '${marker}\\n'\n`,
      },
    })
    expect(input.ok()).toBeTruthy()
    await page.waitForTimeout(250)

    await page.evaluate(async id => window.__farmingTerminalTest?.resumeLive(id), agentId)
    await page.waitForFunction(
      id => Boolean(window.__farmingTerminalTest?.isReady(id)),
      agentId,
      { timeout: 10_000 },
    )
    await expect.poll(() => visibleText(page, agentId), { timeout: 10_000 }).toContain(marker)
    expect(await visibleText(page, agentId)).not.toContain('STALE_VISIBLE_TERMINAL')
    const diagnostics = await page.evaluate(
      id => window.__farmingTerminalTest?.getBufferDiagnostics(id),
      agentId,
    )
    expect(diagnostics?.checkpointRequestInFlight).toBe(false)
    expect(diagnostics?.checkpointFailureCount).toBe(0)
  })

  test('page resume repairs output produced while rendering was suspended', async ({ page, workspaceRoot }) => {
    const workspace = path.join(workspaceRoot, 'terminal-page-resume-checkpoint')
    fs.mkdirSync(workspace, { recursive: true })
    const agentId = await createControlAgent(page, workspace)
    await openTerminalTestPage(page)
    await selectControlAgent(page, agentId)
    let sessionViewRequests = 0
    const routePattern = new RegExp(`/farming/api/agents/${agentId}/session-view$`)
    await page.route(routePattern, async route => {
      sessionViewRequests += 1
      await route.continue()
    })

    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')))
    const input = await page.request.post(`/farming/api/control/agents/${agentId}/input`, {
      data: { input: 'printf "MISSED_PAGE_RESUME_OUTPUT\\n"\r' },
    })
    expect(input.ok()).toBeTruthy()
    await page.evaluate(() => window.dispatchEvent(new Event('farming:backend-connected')))
    await page.evaluate(() => window.dispatchEvent(new Event('pageshow')))

    try {
      await expect.poll(() => visibleText(page, agentId), { timeout: 10_000 })
        .toContain('MISSED_PAGE_RESUME_OUTPUT')
    } catch (error) {
      const diagnostics = await page.evaluate(
        id => window.__farmingTerminalTest?.getBufferDiagnostics(id),
        agentId,
      )
      const authoritative = await page.request.get(`/farming/api/agents/${agentId}/session-view`)
        .then(response => response.json())
        .catch(probeError => ({ error: String(probeError) }))
      throw new Error(
        `Page resume did not install checkpoint: ${JSON.stringify({ diagnostics, authoritative })}`,
        { cause: error },
      )
    }
    expect(sessionViewRequests).toBeLessThanOrEqual(2)
  })

  test('jumping to a completed command clears both viewport and attention unread state', async ({ page, workspaceRoot }) => {
    const workspace = path.join(workspaceRoot, 'terminal-jump-read-cut')
    fs.mkdirSync(workspace, { recursive: true })
    const agentId = await createControlAgent(page, workspace)
    const otherAgentId = await createControlAgent(page, workspace)
    await openTerminalTestPage(page)
    await selectControlAgent(page, agentId)
    const longOutput = await page.request.post(`/farming/api/control/agents/${agentId}/input`, {
      data: {
        input: 'i=0; while [ "$i" -lt 180 ]; do printf "jump-read-line-%03d\\n" "$i"; i=$((i + 1)); done\r',
      },
    })
    expect(longOutput.ok()).toBeTruthy()
    await expect.poll(() => visibleText(page, agentId)).toContain('jump-read-line-179')
    await expect.poll(async () => (await terminalViewport(page, agentId)).scrollbackLength)
      .toBeGreaterThan(0)
    await page.evaluate(async id => window.__farmingTerminalTest?.scrollToLine(id, 30), agentId)
    await expect.poll(async () => (await terminalViewport(page, agentId)).following).toBe(false)
    const readingRowsBeforeSwitch = await terminalRows(page, agentId, 4)

    const input = await page.request.post(`/farming/api/control/agents/${agentId}/input`, {
      data: { input: 'printf "JUMP_READ_COMPLETED\\n"\r' },
    })
    expect(input.ok()).toBeTruthy()
    await expect.poll(async () => {
      const response = await page.request.get(`/farming/api/control/agents/${agentId}/output?tail=2000`)
      return response.ok() ? (await response.text()).includes('JUMP_READ_COMPLETED') : false
    }).toBe(true)
    const unread = await page.request.patch(`/farming/api/agents/${agentId}`, {
      data: { unread: true },
    })
    expect(unread.ok()).toBeTruthy()
    const row = page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
    await expect(row).toHaveClass(/unread/)
    await selectControlAgent(page, otherAgentId)
    await expect(row).toHaveClass(/unread/)
    await selectControlAgent(page, agentId)
    await expect(row).toHaveClass(/unread/)
    await expect.poll(() => terminalRows(page, agentId, 4)).toEqual(readingRowsBeforeSwitch)
    await expect(page.getByTestId('code-terminal-jump-bottom')).toBeVisible()
    await page.getByTestId('code-terminal-jump-bottom').click()
    await expect.poll(async () => (await terminalViewport(page, agentId)).following).toBe(true)
    await expect(row).not.toHaveClass(/unread/)
  })

  test('duplicate, stale, output-gap and revision-gap transitions are distinguished', async ({ page, workspaceRoot }) => {
    const workspace = path.join(workspaceRoot, 'terminal-sequence-ordering')
    fs.mkdirSync(workspace, { recursive: true })
    const agentId = await createControlAgent(page, workspace)
    await openTerminalTestPage(page)
    await selectControlAgent(page, agentId)
    const initial = await terminalState(page, agentId)
    await page.evaluate(id => {
      window.__farmingTerminalTest?.setCheckpointAckSuppressed(id, true)
    }, agentId)
    const routePattern = new RegExp(`/farming/api/agents/${agentId}/session-view$`)
    const checkpoints = [
      checkpoint(
        initial.runtimeEpoch,
        initial.outputSeq + 3,
        initial.stateRevision + 2,
        initial.cols,
        initial.rows,
        'OUTPUT_GAP_REPAIRED',
      ),
      checkpoint(
        initial.runtimeEpoch,
        initial.outputSeq + 4,
        initial.stateRevision + 4,
        initial.cols,
        initial.rows,
        'REVISION_GAP_REPAIRED',
      ),
    ]
    let requests = 0
    await page.route(routePattern, async (route) => {
      const body = checkpoints[Math.min(requests, checkpoints.length - 1)]
      requests += 1
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })
    })

    await page.evaluate(async ({ id, epoch, outputSeq, stateRevision }) => {
      await window.__farmingTerminalTest?.streamSequenced(
        id,
        'CONTIGUOUS_GOOD\r\n',
        outputSeq + 1,
        epoch,
        stateRevision + 1,
      )
    }, { id: agentId, epoch: initial.runtimeEpoch, ...initial })
    await expect.poll(() => visibleText(page, agentId)).toContain('CONTIGUOUS_GOOD')

    await page.evaluate(async ({ id, epoch, outputSeq, stateRevision }) => {
      await window.__farmingTerminalTest?.streamSequenced(
        id,
        'DUPLICATE_POISON\r\n',
        outputSeq + 1,
        epoch,
        stateRevision + 1,
      )
      await window.__farmingTerminalTest?.streamSequenced(
        id,
        'STALE_POISON\r\n',
        outputSeq,
        epoch,
        stateRevision,
      )
    }, { id: agentId, epoch: initial.runtimeEpoch, ...initial })
    await page.waitForTimeout(100)
    expect(await visibleText(page, agentId)).not.toContain('DUPLICATE_POISON')
    expect(await visibleText(page, agentId)).not.toContain('STALE_POISON')
    expect(requests).toBe(0)

    await page.evaluate(async ({ id, epoch, outputSeq, stateRevision }) => {
      await window.__farmingTerminalTest?.streamSequenced(
        id,
        'OUTPUT_GAP_POISON\r\n',
        outputSeq + 3,
        epoch,
        stateRevision + 2,
      )
    }, { id: agentId, epoch: initial.runtimeEpoch, ...initial })
    await expect.poll(() => requests).toBe(1)
    await expect.poll(() => page.evaluate(id => (
      window.__farmingTerminalTest?.getStateRevision(id) ?? null
    ), agentId)).toBe(initial.stateRevision + 2)
    await expect.poll(() => visibleText(page, agentId)).toContain('OUTPUT_GAP_REPAIRED')
    expect(await visibleText(page, agentId)).not.toContain('OUTPUT_GAP_POISON')

    await page.evaluate(async ({ id, epoch, outputSeq, stateRevision }) => {
      await window.__farmingTerminalTest?.streamSequenced(
        id,
        'REVISION_GAP_POISON\r\n',
        outputSeq + 4,
        epoch,
        stateRevision + 4,
      )
    }, { id: agentId, epoch: initial.runtimeEpoch, ...initial })
    await expect.poll(() => requests).toBe(2)
    await expect.poll(() => page.evaluate(id => (
      window.__farmingTerminalTest?.getStateRevision(id) ?? null
    ), agentId)).toBe(initial.stateRevision + 4)
    await expect.poll(() => visibleText(page, agentId)).toContain('REVISION_GAP_REPAIRED')
    expect(await visibleText(page, agentId)).not.toContain('REVISION_GAP_POISON')
  })

  test('a held checkpoint composes with the next contiguous live transition', async ({ page, workspaceRoot }) => {
    const workspace = path.join(workspaceRoot, 'terminal-held-checkpoint-composition')
    fs.mkdirSync(workspace, { recursive: true })
    const agentId = await createControlAgent(page, workspace)
    await openTerminalTestPage(page)
    await selectControlAgent(page, agentId)
    const initial = await terminalState(page, agentId)
    await page.evaluate(id => {
      window.__farmingTerminalTest?.setCheckpointAckSuppressed(id, true)
    }, agentId)

    const checkpointOutputSeq = initial.outputSeq + 2
    const checkpointStateRevision = initial.stateRevision + 2
    const routePattern = new RegExp(`/farming/api/agents/${agentId}/session-view$`)
    let observeRequest!: () => void
    let releaseCheckpoint!: () => void
    const requestObserved = new Promise<void>(resolve => { observeRequest = resolve })
    const checkpointReleased = new Promise<void>(resolve => { releaseCheckpoint = resolve })
    const handler = async (route: import('@playwright/test').Route) => {
      observeRequest()
      await checkpointReleased
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(checkpoint(
          initial.runtimeEpoch,
          checkpointOutputSeq,
          checkpointStateRevision,
          initial.cols,
          initial.rows,
          'HELD_CHECKPOINT',
        )),
      })
    }
    await page.route(routePattern, handler)

    try {
      await page.evaluate(async ({ id, epoch, outputSeq, stateRevision }) => {
        await window.__farmingTerminalTest?.streamSequenced(
          id,
          'HELD_CHECKPOINT_GAP_POISON\r\n',
          outputSeq + 2,
          epoch,
          stateRevision + 2,
        )
      }, { id: agentId, epoch: initial.runtimeEpoch, ...initial })
      await requestObserved
      await page.evaluate(async ({ id, epoch, outputSeq, stateRevision }) => {
        await window.__farmingTerminalTest?.writeSequenced(
          id,
          'CONTIGUOUS_AFTER_HELD_CHECKPOINT\r\n',
          outputSeq + 3,
          epoch,
          stateRevision + 3,
        )
      }, { id: agentId, epoch: initial.runtimeEpoch, ...initial })
      releaseCheckpoint()

      await expect.poll(() => terminalState(page, agentId)).toMatchObject({
        outputSeq: initial.outputSeq + 3,
        stateRevision: initial.stateRevision + 3,
      })
      const output = await visibleText(page, agentId)
      expect(output).toContain('HELD_CHECKPOINT')
      expect(output).toContain('CONTIGUOUS_AFTER_HELD_CHECKPOINT')
      expect(output.indexOf('HELD_CHECKPOINT'))
        .toBeLessThan(output.indexOf('CONTIGUOUS_AFTER_HELD_CHECKPOINT'))
      expect(output).not.toContain('HELD_CHECKPOINT_GAP_POISON')
    } finally {
      releaseCheckpoint()
      await page.unroute(routePattern, handler)
    }
  })

  test('Code commits a live transition only after the xterm write callback', async ({ page, workspaceRoot }) => {
    const workspace = path.join(workspaceRoot, 'terminal-render-commit-callback')
    fs.mkdirSync(workspace, { recursive: true })
    const agentId = await createControlAgent(page, workspace)
    await openTerminalTestPage(page)
    await selectControlAgent(page, agentId)
    const initial = await terminalState(page, agentId)
    const marker = `RENDER_COMMITTED_${Date.now()}`

    const duringSameTask = await page.evaluate(({ id, epoch, outputSeq, stateRevision, text }) => {
      void window.__farmingTerminalTest?.streamSequenced(
        id,
        text,
        outputSeq + 1,
        epoch,
        stateRevision + 1,
      )
      return {
        outputSeq: window.__farmingTerminalTest?.getLastOutputSeq(id) ?? null,
        stateRevision: window.__farmingTerminalTest?.getStateRevision(id) ?? null,
      }
    }, {
      id: agentId,
      epoch: initial.runtimeEpoch,
      outputSeq: initial.outputSeq,
      stateRevision: initial.stateRevision,
      text: `${'x'.repeat(6_000)}\r\n${marker}\r\n`,
    })

    expect(duringSameTask).toEqual({
      outputSeq: initial.outputSeq,
      stateRevision: initial.stateRevision,
    })
    await expect.poll(() => terminalState(page, agentId)).toMatchObject({
      outputSeq: initial.outputSeq + 1,
      stateRevision: initial.stateRevision + 1,
    })
    await expect.poll(() => visibleText(page, agentId)).toContain(marker)
  })

  test('Code gives one coalesced websocket output batch to xterm in one write', async ({ page, workspaceRoot }) => {
    const workspace = path.join(workspaceRoot, 'terminal-render-output-batch')
    fs.mkdirSync(workspace, { recursive: true })
    const agentId = await createControlAgent(page, workspace)
    await openTerminalTestPage(page)
    await selectControlAgent(page, agentId)
    const initial = await terminalState(page, agentId)
    const marker = `BATCH_RENDERED_${Date.now()}`
    const chunks = [
      '\x1b[2J\x1b[H',
      ...Array.from({ length: 36 }, (_, index) => `batch-line-${index + 1}\r\n`),
      `${marker}\r\n`,
    ]
    const writeCountBefore = await page.evaluate(id => (
      window.__farmingTerminalTest?.getBufferDiagnostics(id)?.terminalWriteBatchCount ?? 0
    ), agentId)

    const duringSameTask = await page.evaluate(({ id, epoch, outputSeq, stateRevision, parts }) => {
      parts.forEach((part, index) => {
        void window.__farmingTerminalTest?.streamSequenced(
          id,
          part,
          outputSeq + index + 1,
          epoch,
          stateRevision + index + 1,
        )
      })
      return {
        outputSeq: window.__farmingTerminalTest?.getLastOutputSeq(id) ?? null,
        stateRevision: window.__farmingTerminalTest?.getStateRevision(id) ?? null,
        writeCount: window.__farmingTerminalTest?.getBufferDiagnostics(id)?.terminalWriteBatchCount ?? 0,
      }
    }, {
      id: agentId,
      epoch: initial.runtimeEpoch,
      outputSeq: initial.outputSeq,
      stateRevision: initial.stateRevision,
      parts: chunks,
    })

    expect(duringSameTask).toEqual({
      outputSeq: initial.outputSeq,
      stateRevision: initial.stateRevision,
      writeCount: writeCountBefore,
    })
    await expect.poll(() => terminalState(page, agentId)).toMatchObject({
      outputSeq: initial.outputSeq + chunks.length,
      stateRevision: initial.stateRevision + chunks.length,
    })
    await expect.poll(() => page.evaluate(id => (
      window.__farmingTerminalTest?.getBufferDiagnostics(id)?.terminalWriteBatchCount ?? 0
    ), agentId)).toBe(writeCountBefore + 1)
    await expect.poll(() => visibleText(page, agentId)).toContain(marker)
  })

  test('Code holds a resize redraw until the burst is quiet and paints it once', async ({ page, workspaceRoot }) => {
    const workspace = path.join(workspaceRoot, 'terminal-resize-redraw-batch')
    fs.mkdirSync(workspace, { recursive: true })
    const agentId = await createControlAgent(page, workspace)
    await openTerminalTestPage(page)
    await selectControlAgent(page, agentId)
    const initial = await terminalState(page, agentId)
    const nextRows = initial.rows > 10 ? initial.rows - 1 : initial.rows + 1
    const marker = `RESIZE_REDRAW_COMPLETE_${Date.now()}`
    const writeCountBefore = await page.evaluate(id => (
      window.__farmingTerminalTest?.getBufferDiagnostics(id)?.terminalWriteBatchCount ?? 0
    ), agentId)

    const duringBurst = await page.evaluate(async ({
      id,
      epoch,
      outputSeq,
      stateRevision,
      cols,
      rows,
      finalMarker,
    }) => {
      await window.__farmingTerminalTest?.streamSequenced(
        id,
        '',
        outputSeq,
        epoch,
        stateRevision + 1,
        'resize',
        cols,
        rows,
      )
      let nextOutputSeq = outputSeq
      let nextRevision = stateRevision + 1
      for (let batch = 0; batch < 3; batch += 1) {
        const parts = Array.from({ length: 12 }, (_, index) => (
          `redraw-${batch + 1}-${index + 1}\r\n`
        ))
        if (batch === 2) parts.push(`${finalMarker}\r\n`)
        parts.forEach(part => {
          nextOutputSeq += 1
          nextRevision += 1
          void window.__farmingTerminalTest?.streamSequenced(
            id,
            part,
            nextOutputSeq,
            epoch,
            nextRevision,
          )
        })
        await new Promise(resolve => window.setTimeout(resolve, 20))
      }
      return {
        outputSeq: window.__farmingTerminalTest?.getLastOutputSeq(id) ?? null,
        stateRevision: window.__farmingTerminalTest?.getStateRevision(id) ?? null,
        diagnostics: window.__farmingTerminalTest?.getBufferDiagnostics(id),
        finalOutputSeq: nextOutputSeq,
        finalRevision: nextRevision,
      }
    }, {
      id: agentId,
      epoch: initial.runtimeEpoch,
      outputSeq: initial.outputSeq,
      stateRevision: initial.stateRevision,
      cols: initial.cols,
      rows: nextRows,
      finalMarker: marker,
    })

    expect(duringBurst.outputSeq).toBe(initial.outputSeq)
    expect(duringBurst.stateRevision).toBe(initial.stateRevision + 1)
    expect(duringBurst.diagnostics?.terminalWriteBatchCount).toBe(writeCountBefore)
    expect(duringBurst.diagnostics?.resizeRedrawTimerPending).toBe(true)
    await expect.poll(() => terminalState(page, agentId)).toMatchObject({
      outputSeq: duringBurst.finalOutputSeq,
      stateRevision: duringBurst.finalRevision,
    })
    await expect.poll(() => page.evaluate(id => (
      window.__farmingTerminalTest?.getBufferDiagnostics(id)?.terminalWriteBatchCount ?? 0
    ), agentId)).toBe(writeCountBefore + 1)
    await expect.poll(() => visibleText(page, agentId)).toContain(marker)
  })

  test('stale same-epoch checkpoint keeps chasing the required revision', async ({ page, workspaceRoot }) => {
    const workspace = path.join(workspaceRoot, 'terminal-stale-checkpoint')
    fs.mkdirSync(workspace, { recursive: true })
    const agentId = await createControlAgent(page, workspace)
    await openTerminalTestPage(page)
    await selectControlAgent(page, agentId)
    const initial = await terminalState(page, agentId)
    const targetSeq = initial.outputSeq + 2
    const targetRevision = initial.stateRevision + 2
    const routePattern = new RegExp(`/farming/api/agents/${agentId}/session-view$`)
    let requests = 0

    await page.route(routePattern, async (route) => {
      requests += 1
      const body = requests === 1
        ? checkpoint(
          initial.runtimeEpoch,
          initial.outputSeq,
          initial.stateRevision,
          initial.cols,
          initial.rows,
          'STALE_CHECKPOINT',
        )
        : checkpoint(
          initial.runtimeEpoch,
          targetSeq,
          targetRevision,
          initial.cols,
          initial.rows,
          'LATEST_CHECKPOINT',
        )
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })
    })

    await page.evaluate(async ({ id, epoch, seq, revision }) => {
      await window.__farmingTerminalTest?.streamSequenced(
        id,
        'GAP_POISON\r\n',
        seq,
        epoch,
        revision,
      )
    }, {
      id: agentId,
      epoch: initial.runtimeEpoch,
      seq: targetSeq,
      revision: targetRevision,
    })

    await expect.poll(() => requests, { timeout: 10_000 }).toBeGreaterThanOrEqual(2)
    await expect.poll(() => visibleText(page, agentId), { timeout: 10_000 })
      .toContain('LATEST_CHECKPOINT')
    expect(requests).toBeLessThanOrEqual(3)
    expect(await visibleText(page, agentId)).not.toContain('GAP_POISON')
    await expect.poll(() => page.evaluate(id => (
      window.__farmingTerminalTest?.getStateRevision(id) ?? null
    ), agentId)).toBe(targetRevision)
  })

  test('identical invariant-breaking checkpoints halt instead of retrying forever', async ({ page, workspaceRoot }) => {
    const workspace = path.join(workspaceRoot, 'terminal-stuck-checkpoint')
    fs.mkdirSync(workspace, { recursive: true })
    const agentId = await createControlAgent(page, workspace)
    await openTerminalTestPage(page)
    await selectControlAgent(page, agentId)
    const initial = await terminalState(page, agentId)
    const targetSeq = initial.outputSeq + 2
    const targetRevision = initial.stateRevision + 2
    const routePattern = new RegExp(`/farming/api/agents/${agentId}/session-view$`)
    let requests = 0

    await page.route(routePattern, async (route) => {
      requests += 1
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(checkpoint(
          initial.runtimeEpoch,
          initial.outputSeq,
          initial.stateRevision,
          initial.cols,
          initial.rows,
          'STUCK_CHECKPOINT',
        )),
      })
    })

    await page.evaluate(async ({ id, epoch, seq, revision }) => {
      await window.__farmingTerminalTest?.streamSequenced(
        id,
        'GAP_MUST_NOT_RENDER\r\n',
        seq,
        epoch,
        revision,
      )
    }, {
      id: agentId,
      epoch: initial.runtimeEpoch,
      seq: targetSeq,
      revision: targetRevision,
    })

    await expect.poll(() => page.evaluate(id => (
      window.__farmingTerminalTest?.getBufferDiagnostics(id) as unknown as {
        checkpointHalted?: boolean
      } | null
    )?.checkpointHalted === true, agentId), { timeout: 10_000 }).toBe(true)
    expect(requests).toBe(3)
    await page.waitForTimeout(2_000)
    expect(requests).toBe(3)
    await expect(page.getByTestId('code-terminal-status-card')).toBeVisible()
    expect(await visibleText(page, agentId)).not.toContain('GAP_MUST_NOT_RENDER')
  })

  test('cross-epoch overflow cannot lose the newest replay target or accept a retired epoch', async ({ page, workspaceRoot }) => {
    const workspace = path.join(workspaceRoot, 'terminal-cross-epoch')
    fs.mkdirSync(workspace, { recursive: true })
    const agentId = await createControlAgent(page, workspace)
    await openTerminalTestPage(page)
    await selectControlAgent(page, agentId)
    const initial = await terminalState(page, agentId)
    const epochB = nextEpoch(initial.runtimeEpoch, 1)
    const epochC = nextEpoch(initial.runtimeEpoch, 2)
    const routePattern = new RegExp(`/farming/api/agents/${agentId}/session-view$`)
    let requests = 0
    let releaseFirst!: () => void
    let markFirstStarted!: () => void
    const firstGate = new Promise<void>(resolve => {
      releaseFirst = resolve
    })
    const firstStarted = new Promise<void>(resolve => {
      markFirstStarted = resolve
    })

    await page.route(routePattern, async (route) => {
      requests += 1
      if (requests === 1) {
        markFirstStarted()
        await firstGate
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify(checkpoint(epochB, 1, 1, initial.cols, initial.rows, 'EPOCH_B_STALE')),
        })
        return
      }
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(checkpoint(epochC, 513, 513, initial.cols, initial.rows, 'EPOCH_C_LATEST')),
      })
    })

    await page.evaluate(async ({ id, epoch }) => {
      await window.__farmingTerminalTest?.streamSequenced(id, 'BARRIER_B\r\n', 1, epoch, 1)
    }, { id: agentId, epoch: epochB })
    await firstStarted

    await page.evaluate(async ({ id, epoch }) => {
      for (let revision = 1; revision <= 513; revision += 1) {
        await window.__farmingTerminalTest?.streamSequenced(
          id,
          `C_${revision}\r\n`,
          revision,
          epoch,
          revision,
        )
      }
    }, { id: agentId, epoch: epochC })

    const duringOverflow = await page.evaluate(id => (
      window.__farmingTerminalTest?.getBufferDiagnostics(id)
    ), agentId)
    expect(duringOverflow?.queuedTransitions).toBeLessThanOrEqual(512)
    expect(duringOverflow?.queuedBytes).toBeLessThanOrEqual(1024 * 1024)
    expect(duringOverflow?.replayTargetEpoch).toBe(epochC)
    expect(duringOverflow?.replayTargetRevision).toBe(513)

    releaseFirst()
    await expect.poll(() => requests, { timeout: 10_000 }).toBeGreaterThanOrEqual(2)
    await expect.poll(() => page.evaluate(id => (
      window.__farmingTerminalTest?.getStateRevision(id) ?? null
    ), agentId), { timeout: 10_000 }).toBe(513)
    await expect.poll(() => visibleText(page, agentId), { timeout: 10_000 })
      .toContain('EPOCH_C_LATEST')
    expect(await visibleText(page, agentId)).not.toContain('EPOCH_B_STALE')

    await expect.poll(() => page.evaluate(id => (
      window.__farmingTerminalTest?.getBufferDiagnostics(id) as unknown as {
        checkpointHalted?: boolean
        replayTargetRevision?: number | null
      } | null
    ), agentId), { timeout: 10_000 }).toMatchObject({
      checkpointHalted: false,
      replayTargetRevision: null,
    })
    expect(requests).toBeLessThanOrEqual(3)
    const requestsAfterRecovery = requests
    await page.waitForTimeout(500)
    expect(requests).toBe(requestsAfterRecovery)
    await expect(page.getByTestId('code-terminal-status-card')).toHaveCount(0)

    const requestsBeforeRetiredPoison = requests
    await page.evaluate(async ({ id, epoch }) => {
      await window.__farmingTerminalTest?.streamSequenced(
        id,
        'RETIRED_EPOCH_POISON\r\n',
        2,
        epoch,
        2,
      )
    }, { id: agentId, epoch: epochB })
    await page.waitForTimeout(200)
    expect(await visibleText(page, agentId)).not.toContain('RETIRED_EPOCH_POISON')
    expect(requests).toBe(requestsBeforeRetiredPoison)
    expect(await page.evaluate(id => (
      window.__farmingTerminalTest?.getRuntimeEpoch(id)
    ), agentId)).toBe(epochC)
  })

  test('CRT installs an authoritative replacement epoch without ownership negotiation', async ({ page, workspaceRoot }) => {
    const workspace = path.join(workspaceRoot, 'crt-replacement-checkpoint')
    fs.mkdirSync(workspace, { recursive: true })
    const agentId = await createControlAgent(page, workspace)
    await page.goto(`/farming/crt/?agent=${encodeURIComponent(agentId)}`, {
      waitUntil: 'domcontentloaded',
    })
    await expect(page.locator('#session-modal')).toHaveClass(/active/, { timeout: 30_000 })
    await expect(page.locator('#terminal-output .xterm')).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('.crt-terminal-sync-status')).toBeHidden({ timeout: 15_000 })
    const initial = await page.evaluate(() => (
      (window as typeof window & {
        __farmingCrtTerminalTest?: {
          getState: () => {
            runtimeEpoch: string
            outputSeq: number
            stateRevision: number
            cols: number
            rows: number
          } | null
        }
      }).__farmingCrtTerminalTest?.getState() || null
    ))
    expect(initial?.runtimeEpoch).toBeTruthy()
    const replacementEpoch = nextEpoch(initial!.runtimeEpoch, 1)
    const routePattern = new RegExp(`/farming/api/agents/${agentId}/session-view$`)
    let requests = 0
    await page.route(routePattern, async (route) => {
      requests += 1
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(checkpoint(
          replacementEpoch,
          initial!.outputSeq + 1,
          initial!.stateRevision + 1,
          initial!.cols,
          initial!.rows,
          'CRT_REPLACEMENT_CHECKPOINT',
        )),
      })
    })

    await page.evaluate(({ epoch, outputSeq, stateRevision }) => {
      const api = (window as typeof window & {
        __farmingCrtTerminalTest?: {
          streamSequenced: (
            data: string,
            outputSeq: number,
            runtimeEpoch: string,
            stateRevision: number,
          ) => boolean
        }
      }).__farmingCrtTerminalTest
      api?.streamSequenced('CRT_EPOCH_CHANGE\r\n', outputSeq + 1, epoch, stateRevision + 1)
    }, {
      epoch: replacementEpoch,
      outputSeq: initial!.outputSeq,
      stateRevision: initial!.stateRevision,
    })

    await expect.poll(() => page.evaluate(() => (
      (window as typeof window & {
        __farmingCrtTerminalTest?: {
          getState: () => {
            runtimeEpoch?: string
            stateRevision?: number
            checkpointHalted?: boolean
          } | null
        }
      }).__farmingCrtTerminalTest?.getState() || null
    )), { timeout: 10_000 }).toMatchObject({
      runtimeEpoch: replacementEpoch,
      stateRevision: initial!.stateRevision + 1,
      checkpointHalted: false,
    })
    expect(requests).toBeLessThanOrEqual(2)
    const requestsAfterRecovery = requests
    await page.waitForTimeout(500)
    expect(requests).toBe(requestsAfterRecovery)
    await expect(page.locator('.crt-terminal-sync-status')).toBeHidden()
    await expect.poll(() => page.evaluate(() => (
      (window as typeof window & {
        __farmingCrtTerminalTest?: { getRows: () => string[] }
      }).__farmingCrtTerminalTest?.getRows().join('\n') || ''
    ))).toContain('CRT_REPLACEMENT_CHECKPOINT')
  })

  test('parked terminal fetches one checkpoint after a real websocket disconnect', async ({ page, workspaceRoot }) => {
    const workspace = path.join(workspaceRoot, 'parked-real-reconnect')
    fs.mkdirSync(workspace, { recursive: true })
    const parkedAgentId = await createControlAgent(page, workspace)
    const activeAgentId = await createControlAgent(page, workspace)
    await openTerminalTestPage(page)
    await selectControlAgent(page, parkedAgentId)
    await selectControlAgent(page, activeAgentId)

    const routePattern = new RegExp(`/farming/api/agents/${parkedAgentId}/session-view$`)
    let checkpointRequests = 0
    const handler = async (route: import('@playwright/test').Route) => {
      checkpointRequests += 1
      await route.continue()
    }
    await page.route(routePattern, handler)
    try {
      await page.evaluate(() => {
        const state = window as typeof window & {
          __parkedReconnectDisconnected?: boolean
          __parkedReconnectConnected?: boolean
        }
        state.__parkedReconnectDisconnected = false
        state.__parkedReconnectConnected = false
        window.addEventListener('farming:backend-disconnected', () => {
          state.__parkedReconnectDisconnected = true
        }, { once: true })
        window.addEventListener('farming:backend-connected', () => {
          state.__parkedReconnectConnected = true
        }, { once: true })
      })
      const closeResponse = await page.request.post('/farming/api/control/e2e/close-websockets')
      expect(closeResponse.ok()).toBeTruthy()
      await page.waitForFunction(() => (
        (window as typeof window & { __parkedReconnectDisconnected?: boolean })
          .__parkedReconnectDisconnected === true
      ))

      const marker = `PARKED_REAL_RECONNECT_${Date.now()}`
      const inputResponse = await page.request.post(`/farming/api/control/agents/${parkedAgentId}/input`, {
        data: { input: `printf "${marker}\\n"\r` },
      })
      expect(inputResponse.ok()).toBeTruthy()
      await expect.poll(async () => {
        const response = await page.request.get(`/farming/api/agents/${parkedAgentId}/session-view`)
        const payload = await response.json() as { session?: { renderOutput?: string } }
        return payload.session?.renderOutput || ''
      }).toContain(marker)
      await page.waitForFunction(() => (
        (window as typeof window & { __parkedReconnectConnected?: boolean })
          .__parkedReconnectConnected === true
      ), undefined, { timeout: 10_000 })
      expect(checkpointRequests).toBe(0)

      await selectControlAgent(page, parkedAgentId)
      await expect.poll(() => visibleText(page, parkedAgentId), { timeout: 10_000 }).toContain(marker)
      expect(checkpointRequests).toBe(1)
    } finally {
      await page.unroute(routePattern, handler)
    }
  })

  test('1013 backpressure close reconnects through an authoritative checkpoint', async ({ page, workspaceRoot }) => {
    const workspace = path.join(workspaceRoot, 'terminal-backpressure-reconnect')
    fs.mkdirSync(workspace, { recursive: true })
    const agentId = await createControlAgent(page, workspace)
    await openTerminalTestPage(page)
    await selectControlAgent(page, agentId)
    await page.evaluate(() => {
      const state = window as typeof window & {
        __terminalDisconnectCode?: number
        __terminalReconnectCount?: number
      }
      state.__terminalDisconnectCode = 0
      state.__terminalReconnectCount = 0
      window.addEventListener('farming:backend-disconnected', (event) => {
        state.__terminalDisconnectCode = (event as CustomEvent<{ code?: number }>).detail?.code || 0
      }, { once: true })
      window.addEventListener('farming:backend-connected', () => {
        state.__terminalReconnectCount = (state.__terminalReconnectCount || 0) + 1
      })
    })

    const closeResponse = await page.request.post('/farming/api/control/e2e/close-websockets')
    expect(closeResponse.ok()).toBeTruthy()
    await page.waitForFunction(() => (
      (window as typeof window & { __terminalDisconnectCode?: number }).__terminalDisconnectCode === 1013
    ))

    const marker = `MISSED_DURING_BACKPRESSURE_${Date.now()}`
    const markerBytes = Buffer.from(`${marker}\n`, 'utf8')
    const escapedMarker = [...markerBytes].map(byte => `\\x${byte.toString(16).padStart(2, '0')}`).join('')
    const inputResponse = await page.request.post(`/farming/api/control/agents/${agentId}/input`, {
      data: { input: `printf '${escapedMarker}'\n` },
    })
    expect(inputResponse.ok()).toBeTruthy()

    await page.waitForFunction(() => (
      ((window as typeof window & { __terminalReconnectCount?: number }).__terminalReconnectCount || 0) > 0
    ), undefined, { timeout: 10_000 })
    await expect.poll(() => visibleText(page, agentId), { timeout: 10_000 }).toContain(marker)
    const text = await visibleText(page, agentId)
    expect(text.split(marker).length - 1).toBe(1)

    await expect(terminalHost(page, agentId)).toBeVisible({ timeout: 10_000 })
    const authoritative = await page.request.get(`/farming/api/agents/${agentId}/session-view`)
      .then(response => response.json()) as {
        session?: { runtimeEpoch?: string; stateRevision?: number }
      }
    await expect.poll(() => page.evaluate(id => ({
      runtimeEpoch: window.__farmingTerminalTest?.getRuntimeEpoch(id),
      stateRevision: window.__farmingTerminalTest?.getStateRevision(id),
    }), agentId)).toEqual({
      runtimeEpoch: authoritative.session?.runtimeEpoch,
      stateRevision: authoritative.session?.stateRevision,
    })
  })
})
