import fs from 'node:fs'
import path from 'node:path'
import { expect, openFarming, terminalHostDiagnostics, terminalRows, terminalViewport, test, writeTerminalFixture, writeTerminalRaw } from './fixtures'

type ScenarioRunner = (name: string, fn: () => Promise<void>) => Promise<void>

type TerminalSnapshotCell = {
  char: string
  width: number
  fg?: number
  bg?: number
  attributes?: number
}

function rowCells(text: string): TerminalSnapshotCell[] {
  return text.split('').map(char => ({ char, width: 1 }))
}

function snapshotFromRows(rows: string[], cols = 80, cursorX = 0, cursorY = Math.max(0, rows.length - 1)) {
  return {
    cols,
    rows: Math.max(rows.length, 1),
    viewportY: 0,
    cursorX,
    cursorY,
    cells: rows.length > 0 ? rows.map(rowCells) : [[{ char: ' ', width: 1 }]],
  }
}

async function authoritativeCheckpoint(
  route: import('@playwright/test').Route,
  output: string,
  revisionOffset = 1,
) {
  const response = await route.fetch()
  const data = await response.json() as {
    session?: Record<string, unknown>
  }
  const session = data.session && typeof data.session === 'object' ? data.session : {}
  const outputSeq = Math.max(0, Number(session.outputSeq) || 0) + revisionOffset
  const stateRevision = Math.max(0, Number(session.stateRevision) || 0) + revisionOffset
  const cols = Math.max(40, Math.floor(Number(session.previewCols ?? session.cols) || 80))
  const rows = Math.max(10, Math.floor(Number(session.previewRows ?? session.rows) || 30))
  return {
    ...session,
    runtimeEpoch: String(session.runtimeEpoch || ''),
    output,
    renderOutput: output,
    outputSeq,
    stateRevision,
    previewCols: cols,
    previewRows: rows,
    previewSnapshot: snapshotFromRows(output.split('\n'), cols, 3, Math.max(0, output.split('\n').length - 1)),
  }
}

async function createControlAgent(page: import('@playwright/test').Page, command: string, workspace: string) {
  const response = await page.request.post('/farming/api/control/agents', {
    data: { command, workspace },
  })
  expect(response.ok()).toBeTruthy()
  const data = await response.json() as { agentId?: string }
  expect(data.agentId).toBeTruthy()
  return data.agentId as string
}

async function cleanupControlAgents(request: import('@playwright/test').APIRequestContext) {
  const response = await request.get('/farming/api/control/agents').catch(() => null)
  if (!response?.ok()) return
  const data = await response.json() as { agents?: Array<{ id?: string }> }
  await Promise.all((data.agents ?? [])
    .map(agent => agent.id)
    .filter((id): id is string => Boolean(id))
    .map(id => request.delete(`/farming/api/control/agents/${id}`).catch(() => null)))
}

function agentListItem(page: import('@playwright/test').Page, agentId: string) {
  return page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"], [data-testid="code-project-agent-compact"][data-agent-id="${agentId}"], [data-testid="code-pinned-agent-compact"][data-agent-id="${agentId}"]`)
}

async function revealAgentListItem(page: import('@playwright/test').Page, agentId: string) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (await agentListItem(page, agentId).first().isVisible().catch(() => false)) return
    const mobileMenu = page.getByTestId('code-mobile-menu')
    if (await mobileMenu.isVisible().catch(() => false)) {
      await mobileMenu.click()
      if (await agentListItem(page, agentId).first().isVisible().catch(() => false)) return
    }
    const showMoreButtons = page.getByTestId('code-agent-show-more')
    const count = await showMoreButtons.count()
    let clicked = false
    for (let index = 0; index < count; index += 1) {
      const button = showMoreButtons.nth(index)
      if (!await button.isVisible().catch(() => false)) continue
      await button.click()
      clicked = true
    }
    if (!clicked) return
  }
}

async function selectAgent(page: import('@playwright/test').Page, agentId: string) {
  let row = agentListItem(page, agentId)
  const terminalPane = page.locator(`[data-testid="code-terminal-pane"][data-agent-id="${agentId}"]`)
  if (
    await row.count() > 0
    && (await row.first().getAttribute('class'))?.includes('active')
    && await terminalPane.isVisible().catch(() => false)
  ) {
    return
  }
  await revealAgentListItem(page, agentId)
  row = agentListItem(page, agentId)
  await expect(row).toBeVisible({ timeout: 30_000 })
  const editorVisible = await page.getByTestId('code-file-editor').isVisible().catch(() => false)
  const terminalVisible = await terminalPane.isVisible().catch(() => false)
  const mobileSidebarOpen = await page.getByTestId('code-mobile-sidebar-backdrop')
    .isVisible()
    .catch(() => false)
  if (
    (await row.first().getAttribute('class'))?.includes('active')
    && !editorVisible
    && terminalVisible
    && !mobileSidebarOpen
  ) {
    return
  }
  await row.click()
  await expect(row).toHaveClass(/active/)
  await expect(terminalPane).toBeVisible({ timeout: 15_000 })
}

async function terminalDiagnostics(page: import('@playwright/test').Page, agentId: string) {
  return page.evaluate((id) => {
    return window.__farmingTerminalTest?.getBufferDiagnostics?.(id) ?? null
  }, agentId)
}

async function visibleTerminalText(page: import('@playwright/test').Page, agentId: string, rowCount = 60) {
  return (await terminalRows(page, agentId, rowCount)).join('\n')
}

async function forceHttpCheckpointFallback(
  page: import('@playwright/test').Page,
  agentId: string,
  poison: string,
) {
  await page.waitForFunction(
    id => Boolean(window.__farmingTerminalTest?.isReady(id)),
    agentId,
    { timeout: 15_000 },
  )
  const state = await page.evaluate((id) => ({
    runtimeEpoch: window.__farmingTerminalTest?.getRuntimeEpoch(id) ?? '',
    outputSeq: window.__farmingTerminalTest?.getLastOutputSeq(id) ?? 0,
    stateRevision: window.__farmingTerminalTest?.getStateRevision(id) ?? 0,
  }), agentId)
  await page.evaluate(async ({ id, runtimeEpoch, outputSeq, stateRevision, data }) => {
    await window.__farmingTerminalTest?.streamSequenced(
      id,
      data,
      outputSeq + 100,
      runtimeEpoch,
      stateRevision + 100,
    )
  }, { id: agentId, ...state, data: poison })
}

async function cellForText(
  page: import('@playwright/test').Page,
  agentId: string,
  text: string,
  offset = 1,
) {
  const rows = await terminalRows(page, agentId, 80)
  for (let row = 0; row < rows.length; row += 1) {
    const col = rows[row]?.indexOf(text) ?? -1
    if (col >= 0) {
      const cell = await page.evaluate(({ id, x, y }) => {
        return window.__farmingTerminalTest?.getCellCenter(id, x, y) ?? null
      }, { id: agentId, x: col + offset, y: row })
      if (cell) return { ...cell, row, col: col + offset }
    }
  }
  throw new Error(`Could not find terminal text ${text}: ${JSON.stringify(rows)}`)
}

async function dispatchTerminalModifierKey(
  page: import('@playwright/test').Page,
  type: 'keydown' | 'keyup',
) {
  await page.evaluate(({ eventType, isMac }) => {
    const modifierActive = eventType === 'keydown'
    window.dispatchEvent(new KeyboardEvent(eventType, {
      bubbles: true,
      key: isMac ? 'Meta' : 'Control',
      metaKey: isMac && modifierActive,
      ctrlKey: !isMac && modifierActive,
    }))
  }, { eventType: type, isMac: process.platform === 'darwin' })
}

async function dispatchTerminalModifierClick(
  page: import('@playwright/test').Page,
  agentId: string,
  x: number,
  y: number,
) {
  await page.evaluate(({ id, clientX, clientY, isMac }) => {
    const host = document.querySelector(`.terminal-session-host[data-agent-id="${CSS.escape(id)}"]`)
    if (!(host instanceof HTMLElement)) throw new Error(`Terminal host is missing for ${id}`)
    for (const eventType of ['mousedown', 'mouseup', 'click']) {
      host.dispatchEvent(new MouseEvent(eventType, {
        bubbles: true,
        cancelable: true,
        button: 0,
        buttons: eventType === 'mousedown' ? 1 : 0,
        clientX,
        clientY,
        metaKey: isMac,
        ctrlKey: !isMac,
      }))
    }
  }, { id: agentId, clientX: x, clientY: y, isMac: process.platform === 'darwin' })
}

async function hoverTerminalCell(
  page: import('@playwright/test').Page,
  x: number,
  y: number,
) {
  // Leave the terminal cell first so xterm runs a fresh link hit-test even
  // when consecutive fixtures render their targets at the same coordinates.
  await page.mouse.move(0, 0)
  await page.mouse.move(x, y)
}

async function cellForExactRowText(
  page: import('@playwright/test').Page,
  agentId: string,
  text: string,
  offset = 1,
) {
  const rows = await terminalRows(page, agentId, 80)
  for (let row = 0; row < rows.length; row += 1) {
    if (rows[row]?.trim() !== text) continue
    const col = rows[row]?.indexOf(text) ?? -1
    if (col < 0) continue
    const cell = await page.evaluate(({ id, x, y }) => {
      return window.__farmingTerminalTest?.getCellCenter(id, x, y) ?? null
    }, { id: agentId, x: col + offset, y: row })
    if (cell) return { ...cell, row, col: col + offset }
  }
  throw new Error(`Could not find exact terminal row ${text}: ${JSON.stringify(rows)}`)
}

function activeTerminalHostSelector(agentId: string) {
  return `[data-testid="code-terminal-pane"][data-agent-id="${agentId}"].active .terminal-session-host[data-agent-id="${agentId}"]`
}

async function sendActiveTerminalCommand(
  page: import('@playwright/test').Page,
  agentId: string,
  command: string,
) {
  const host = page.locator(activeTerminalHostSelector(agentId))
  await expect(host).toBeVisible({ timeout: 15_000 })
  await page.waitForFunction(
    id => Boolean(window.__farmingTerminalTest?.isReady(id)),
    agentId,
    { timeout: 15_000 },
  )
  const previousInputCount = await page.evaluate(
    id => window.__farmingTerminalTest?.getInputCount(id) || 0,
    agentId,
  )
  const input = host.locator('.xterm-helper-textarea')
  await input.focus()
  await page.keyboard.insertText(command)
  await input.press('Enter')
  await expect.poll(() => page.evaluate(
    id => window.__farmingTerminalTest?.getInputCount(id) || 0,
    agentId,
  )).toBeGreaterThan(previousInputCount)
}

async function dispatchTouchDrag(
  page: import('@playwright/test').Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
  steps = 8,
) {
  const client = await page.context().newCDPSession(page)
  await client.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ id: 1, x: from.x, y: from.y }],
  })
  for (let step = 1; step <= steps; step += 1) {
    const progress = step / steps
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{
        id: 1,
        x: from.x + (to.x - from.x) * progress,
        y: from.y + (to.y - from.y) * progress,
      }],
    })
  }
  await client.send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: [],
  })
  await client.detach()
}

async function pressTerminalScrollKey(
  page: import('@playwright/test').Page,
  agentId: string,
  key: 'PageUp' | 'PageDown',
) {
  await expectActiveTerminalFocus(page, agentId)
  await page.evaluate((agentId) => {
    const host = document.querySelector(`[data-testid="code-terminal-pane"][data-agent-id="${CSS.escape(agentId)}"].active .terminal-session-host[data-agent-id="${CSS.escape(agentId)}"]`)
    const textarea = host?.querySelector('textarea')
    if (textarea instanceof HTMLTextAreaElement) textarea.focus()
  }, agentId)
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  const beforeWindow = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }))
  await page.locator(`${activeTerminalHostSelector(agentId)} textarea`).first().press(key)
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  const afterWindow = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }))
  return { beforeWindow, afterWindow }
}

async function expectActiveTerminalFocus(page: import('@playwright/test').Page, agentId: string) {
  const hostSelector = activeTerminalHostSelector(agentId)
  await expect.poll(async () => page.evaluate((hostSelector) => {
    const host = document.querySelector(hostSelector)
    return host instanceof HTMLElement && host.contains(document.activeElement)
  }, hostSelector)).toBe(true)
}

async function installClipboardProbe(page: import('@playwright/test').Page) {
  await page.evaluate(() => {
    const target = window as unknown as { __copiedText?: string }
    target.__copiedText = ''
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          target.__copiedText = text
        },
        readText: async () => target.__copiedText ?? '',
      },
    })
  })
}

async function installDelayedClipboardProbe(page: import('@playwright/test').Page) {
  await page.evaluate(() => {
    const target = window as unknown as {
      __copiedText?: string
      __resolveClipboardWrite?: () => void
    }
    target.__copiedText = ''
    target.__resolveClipboardWrite = undefined
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          await new Promise<void>(resolve => {
            target.__resolveClipboardWrite = () => {
              target.__copiedText = text
              resolve()
            }
          })
        },
        readText: async () => target.__copiedText ?? '',
      },
    })
  })
}

async function installWindowOpenProbe(page: import('@playwright/test').Page) {
  await page.evaluate(() => {
    const target = window as unknown as {
      __openedTerminalUrls?: string[]
      __originalOpenForTerminalRegression?: typeof window.open
    }
    target.__openedTerminalUrls = []
    target.__originalOpenForTerminalRegression = window.open
    window.open = ((openedUrl?: string | URL) => {
      target.__openedTerminalUrls?.push(String(openedUrl ?? ''))
      return null
    }) as typeof window.open
  })
}

async function restoreWindowOpenProbe(page: import('@playwright/test').Page) {
  await page.evaluate(() => {
    const target = window as unknown as {
      __originalOpenForTerminalRegression?: typeof window.open
    }
    if (target.__originalOpenForTerminalRegression) {
      window.open = target.__originalOpenForTerminalRegression
    }
  })
}

function hasWrappedPromptFragments(text: string) {
  return text.includes('[agent@exam\nple-host /s') ||
    text.includes('rv/example/\nprojects/ma')
}

test.describe('terminal regression matrix', () => {
  test('covers 30+ desktop terminal, recovery, copy, and editor scenarios', async ({ page, workspaceRoot }) => {
    test.setTimeout(180_000)
    if (process.platform === 'darwin') {
      await page.addInitScript(() => {
        Object.defineProperty(navigator, 'platform', {
          configurable: true,
          get: () => 'MacIntel',
        })
      })
    }

    const checked: string[] = []
    const scenario: ScenarioRunner = async (name, fn) => {
      await test.step(`${String(checked.length + 1).padStart(2, '0')} ${name}`, async () => {
        await fn()
        checked.push(name)
      })
    }

    const projectDir = path.join(workspaceRoot, 'matrix-project')
    fs.mkdirSync(path.join(projectDir, 'src', 'long', 'single', 'path'), { recursive: true })
    fs.mkdirSync(path.join(projectDir, 'src', 'duplicates', 'a'), { recursive: true })
    fs.mkdirSync(path.join(projectDir, 'src', 'duplicates', 'b'), { recursive: true })
    fs.writeFileSync(path.join(projectDir, 'README.md'), ['# Matrix', 'alpha', 'beta target', 'gamma'].join('\n'))
    fs.writeFileSync(path.join(projectDir, 'src', 'long', 'single', 'path', 'leaf.txt'), 'leaf\n')
    fs.writeFileSync(path.join(projectDir, 'src', 'long', 'single', 'path', 'unique-only.log'), 'unique\n')
    fs.writeFileSync(path.join(projectDir, 'src', 'long', 'single', 'path', 'instant-only.log'), 'instant\n')
    fs.writeFileSync(path.join(projectDir, 'src', 'duplicates', 'a', 'duplicate.txt'), 'first\n')
    fs.writeFileSync(path.join(projectDir, 'src', 'duplicates', 'b', 'duplicate.txt'), 'second\n')

    await openFarming(page)
    await installClipboardProbe(page)
    await installWindowOpenProbe(page)

    const recoveringAgentId = await createControlAgent(page, 'bash', projectDir)
    let sessionViewCalls = 0
    await page.route(new RegExp(`/farming/api/agents/${recoveringAgentId}/session-view$`), async route => {
      sessionViewCalls += 1
      const wideRows = [
        '',
        '',
        '[agent@example-host /srv/example/projects/matrix]',
        '$  ',
        '',
      ]
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          session: await authoritativeCheckpoint(route, wideRows.join('\n'), sessionViewCalls * 100),
        }),
      })
    })

    const cursorRecoveringAgentId = await createControlAgent(page, 'bash', projectDir)
    let cursorCheckpointCalls = 0
    await page.route(new RegExp(`/farming/api/agents/${cursorRecoveringAgentId}/session-view$`), async route => {
      cursorCheckpointCalls += 1
      const renderRows = [
        '',
        '',
        'restored-cursor-prompt',
        '$  ',
        '',
      ]
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          session: await authoritativeCheckpoint(
            route,
            `${renderRows.join('\n')}\x1b[H`,
            cursorCheckpointCalls * 100,
          ),
        }),
      })
    })

    const bootstrapReconnectAgentId = await createControlAgent(page, 'bash', projectDir)
    let bootstrapReconnectCalls = 0
    await page.route(new RegExp(`/farming/api/agents/${bootstrapReconnectAgentId}/session-view$`), async route => {
      bootstrapReconnectCalls += 1
      if (bootstrapReconnectCalls === 1) {
        await page.evaluate(() => window.dispatchEvent(new Event('farming:backend-connected'))).catch(() => {})
        await new Promise(resolve => setTimeout(resolve, 350))
      }
      const output = bootstrapReconnectCalls === 1
        ? [
            '[agent@example-host /srv/example/projects/matrix]',
            '$ initial bootstrap',
            '$  ',
          ].join('\n')
        : [
            '[agent@example-host /srv/example/projects/matrix]',
            '$ initial bootstrap',
            'BOOTSTRAP_RECONNECT_OUTPUT',
            '$  ',
          ].join('\n')
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          session: await authoritativeCheckpoint(route, output, bootstrapReconnectCalls),
        }),
      })
    })

    const delayedCheckpointAgentId = await createControlAgent(page, 'bash', projectDir)
    let delayedCheckpointCalls = 0
    await page.route(new RegExp(`/farming/api/agents/${delayedCheckpointAgentId}/session-view$`), async route => {
      delayedCheckpointCalls += 1
      if (delayedCheckpointCalls === 1) {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            session: {
              output: '',
              renderOutput: '',
              outputSeq: null,
              stateRevision: null,
            },
          }),
        })
        return
      }
      const output = [
        '[agent@example-host /srv/example/projects/matrix]',
        'DELAYED_CHECKPOINT_RECOVERED',
        '$  ',
      ].join('\n')
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          session: await authoritativeCheckpoint(route, output, delayedCheckpointCalls),
        }),
      })
    })

    const bashAgentId = await createControlAgent(page, 'bash', projectDir)
    const reconnectOutputAgentId = await createControlAgent(page, 'bash', projectDir)
    const codexAgentId = await createControlAgent(page, 'codex', projectDir)
    const secondCodexAgentId = await createControlAgent(page, 'codex', projectDir)

    await scenario('recovered sessions use the required WebGL renderer', async () => {
      await selectAgent(page, recoveringAgentId)
      await expect(page.locator(`[data-agent-id="${recoveringAgentId}"] .xterm`)).toBeVisible({ timeout: 20_000 })
      await expect.poll(() => page.evaluate(
        id => window.__farmingTerminalTest?.getBufferDiagnostics(id)?.renderer,
        recoveringAgentId,
      )).toBe('webgl')
      await expect.poll(() => page.locator(`[data-agent-id="${recoveringAgentId}"] canvas`).count())
        .toBeGreaterThan(0)
      await forceHttpCheckpointFallback(page, recoveringAgentId, 'RECOVERY_CHECKPOINT_GAP\r\n')
      await expect.poll(() => sessionViewCalls, { timeout: 15_000 }).toBeGreaterThan(0)
      await expect.poll(() => visibleTerminalText(page, recoveringAgentId), { timeout: 15_000 })
        .toContain('[agent@example-host /srv/example/projects/matrix]')
    })

    await scenario('bootstrap checkpoint requests stay bounded after recovery settles', async () => {
      try {
        await page.waitForFunction(
          id => Boolean(window.__farmingTerminalTest?.isReady(id)),
          recoveringAgentId,
          { timeout: 15_000 },
        )
      } catch (error) {
        throw new Error(
          `Recovered terminal did not settle: ${JSON.stringify(await terminalDiagnostics(page, recoveringAgentId))}`,
          { cause: error },
        )
      }
      const settledCount = sessionViewCalls
      await page.waitForTimeout(750)
      expect(sessionViewCalls - settledCount).toBeLessThanOrEqual(2)
      expect(sessionViewCalls).toBeLessThanOrEqual(12)
    })

    await scenario('recovered prompt is not hard-wrapped into 10-column fragments', async () => {
      const text = await visibleTerminalText(page, recoveringAgentId)
      expect(text).toContain('[agent@example-host /srv/example/projects/matrix]')
      expect(hasWrappedPromptFragments(text)).toBe(false)
    })

    await scenario('recovered prompt stays near the top instead of the bottom of an empty viewport', async () => {
      const rows = await terminalRows(page, recoveringAgentId, 20)
      const firstNonBlank = rows.findIndex(row => row.trim())
      expect(firstNonBlank).toBeGreaterThanOrEqual(0)
      expect(firstNonBlank).toBeLessThanOrEqual(2)
    })

    await scenario('recovered cursor uses the screen snapshot position instead of the replay tail', async () => {
      await selectAgent(page, cursorRecoveringAgentId)
      await expect(page.locator(`[data-agent-id="${cursorRecoveringAgentId}"] .xterm`)).toBeVisible({ timeout: 20_000 })
      await forceHttpCheckpointFallback(page, cursorRecoveringAgentId, 'CURSOR_CHECKPOINT_GAP\r\n')
      await expect.poll(() => cursorCheckpointCalls, { timeout: 15_000 }).toBeGreaterThan(0)
      await expect.poll(() => visibleTerminalText(page, cursorRecoveringAgentId), { timeout: 15_000 })
        .toContain('restored-cursor-prompt')
      await expect.poll(async () => {
        return page.evaluate((id) => window.__farmingTerminalTest?.getCursor?.(id) ?? null, cursorRecoveringAgentId)
      }, { timeout: 15_000 }).toEqual(expect.objectContaining({ y: 0 }))
    })

    await scenario('recovered terminal has a wide fitted viewport', async () => {
      await selectAgent(page, recoveringAgentId)
      const diagnostics = await terminalDiagnostics(page, recoveringAgentId)
      expect(diagnostics?.engine).toBe('xterm')
      expect(diagnostics?.bufferLength).toBeGreaterThan(20)
    })

    await scenario('backend reconnect during bootstrap resumes from an authoritative checkpoint', async () => {
      await selectAgent(page, bootstrapReconnectAgentId)
      await page.waitForTimeout(3_000)
      const callsBeforeGap = bootstrapReconnectCalls
      const state = await page.evaluate((id) => ({
        runtimeEpoch: window.__farmingTerminalTest?.getRuntimeEpoch(id) ?? '',
        outputSeq: window.__farmingTerminalTest?.getLastOutputSeq(id) ?? 0,
        stateRevision: window.__farmingTerminalTest?.getStateRevision(id) ?? 0,
      }), bootstrapReconnectAgentId)
      await page.evaluate(async ({ id, runtimeEpoch, outputSeq, stateRevision }) => {
        await window.__farmingTerminalTest?.streamSequenced(
          id,
          'BOOTSTRAP_RECONNECT_GAP\r\n',
          outputSeq + 2,
          runtimeEpoch,
          stateRevision + 2,
        )
      }, { id: bootstrapReconnectAgentId, ...state })
      await expect.poll(() => bootstrapReconnectCalls, { timeout: 10_000 })
        .toBeGreaterThan(callsBeforeGap)
      await page.waitForFunction(
        id => Boolean(window.__farmingTerminalTest?.isReady(id)),
        bootstrapReconnectAgentId,
        { timeout: 15_000 },
      )
      await expect.poll(async () => await visibleTerminalText(page, bootstrapReconnectAgentId), { timeout: 15_000 })
        .toContain('BOOTSTRAP_RECONNECT_OUTPUT')
      await selectAgent(page, bashAgentId)
    })

    await scenario('restored Agent recovers from an initially unavailable HTTP checkpoint without a manual tab switch', async () => {
      await selectAgent(page, delayedCheckpointAgentId)
      await page.waitForTimeout(3_000)
      const callsBeforeGap = delayedCheckpointCalls
      const state = await page.evaluate((id) => ({
        runtimeEpoch: window.__farmingTerminalTest?.getRuntimeEpoch(id) ?? '',
        outputSeq: window.__farmingTerminalTest?.getLastOutputSeq(id) ?? 0,
        stateRevision: window.__farmingTerminalTest?.getStateRevision(id) ?? 0,
      }), delayedCheckpointAgentId)
      await page.evaluate(async ({ id, runtimeEpoch, outputSeq, stateRevision }) => {
        await window.__farmingTerminalTest?.streamSequenced(
          id,
          'DELAYED_CHECKPOINT_GAP\r\n',
          outputSeq + 2,
          runtimeEpoch,
          stateRevision + 2,
        )
      }, { id: delayedCheckpointAgentId, ...state })
      await page.waitForFunction(
        id => Boolean(window.__farmingTerminalTest?.isReady(id)),
        delayedCheckpointAgentId,
        { timeout: 15_000 },
      )
      await expect.poll(async () => await visibleTerminalText(page, delayedCheckpointAgentId), { timeout: 15_000 })
        .toContain('DELAYED_CHECKPOINT_RECOVERED')
      expect(delayedCheckpointCalls).toBeGreaterThan(callsBeforeGap)
    })

    await scenario('page reload keeps the active terminal attached and accepts keyboard input', async () => {
      await selectAgent(page, bashAgentId)
      await page.reload({ waitUntil: 'domcontentloaded' })
      await expect(page.getByTestId('app-shell')).toBeVisible()
      await installClipboardProbe(page)
      await installWindowOpenProbe(page)
      await selectAgent(page, bashAgentId)
      await expect(page.locator(activeTerminalHostSelector(bashAgentId))).toBeVisible({ timeout: 20_000 })
      try {
        await expect.poll(async () => page.evaluate((id) => {
          return window.__farmingTerminalTest?.isReady(id) ?? false
        }, bashAgentId)).toBe(true)
      } catch (error) {
        const diagnostics = await terminalDiagnostics(page, bashAgentId)
        const probe = await page.request.get(`/farming/api/agents/${bashAgentId}/session-view`)
          .then(async response => ({
            status: response.status(),
            body: await response.json().catch(() => null),
          }))
          .catch(probeError => ({
            error: probeError instanceof Error ? probeError.message : String(probeError),
          }))
        throw new Error(
          `Reloaded terminal did not become ready: ${JSON.stringify({ diagnostics, probe })}`,
          { cause: error },
        )
      }
      await page.locator(`${activeTerminalHostSelector(bashAgentId)} textarea`).first().click({ force: true })
      await page.locator(`${activeTerminalHostSelector(bashAgentId)} textarea`).first()
        .pressSequentially("printf 'MATRIX_RELOAD_UI_OK\\n'")
      await page.locator(`${activeTerminalHostSelector(bashAgentId)} textarea`).first().press('Enter')
      await expect.poll(async () => await visibleTerminalText(page, bashAgentId)).toContain('MATRIX_RELOAD_UI_OK')
      const diagnostics = await terminalHostDiagnostics(page)
      const visibleHosts = diagnostics.filter(host => host.visible && !host.inParkingLot)
      expect(visibleHosts).toEqual([
        expect.objectContaining({ agentId: bashAgentId, paneAgentId: bashAgentId, hostCountInMount: 1 }),
      ])
      expect(diagnostics.filter(host => host.inParkingLot).every(host => !host.recordAttached && !host.attachedMountMatchesParent)).toBe(true)
    })

    await scenario('clean bash session opens with its prompt at the first visible row', async () => {
      await selectAgent(page, bashAgentId)
      await expect.poll(async () => (await visibleTerminalText(page, bashAgentId)).trim().length, { timeout: 15_000 }).toBeGreaterThan(0)
      const rows = await terminalRows(page, bashAgentId, 20)
      expect(rows.findIndex(row => row.trim())).toBeLessThanOrEqual(1)
    })

    await scenario('clean bash prompt is readable at desktop width without 10-column fragments', async () => {
      const text = await visibleTerminalText(page, bashAgentId)
      expect(text.replace(/\n/g, '')).toContain('matrix-project')
      expect(hasWrappedPromptFragments(text)).toBe(false)
    })

    await scenario('backend reconnect restores an exact terminal cut without duplicate resize', async () => {
      const beforeCount = await page.evaluate((id) => window.__farmingTerminalTest?.getResizeNotificationCount(id) ?? 0, bashAgentId)
      await page.evaluate(() => window.dispatchEvent(new Event('farming:backend-connected')))
      await expect.poll(() => page.evaluate((id) => {
        const diagnostics = window.__farmingTerminalTest?.getBufferDiagnostics(id) as unknown as {
          needsReconnectOutputSync?: boolean
          resizeRequestInFlight?: { cols: number; rows: number } | null
          pendingResizeRequest?: { cols: number; rows: number } | null
        } | null
        return {
          recovering: diagnostics?.needsReconnectOutputSync ?? true,
          inFlight: diagnostics?.resizeRequestInFlight ?? null,
          pending: diagnostics?.pendingResizeRequest ?? null,
        }
      }, bashAgentId)).toEqual({ recovering: false, inFlight: null, pending: null })
      const result = await page.evaluate((id) => ({
        resizeCount: window.__farmingTerminalTest?.getResizeNotificationCount(id) ?? 0,
        diagnostics: window.__farmingTerminalTest?.getBufferDiagnostics(id) ?? null,
      }), bashAgentId)
      const sessionView = await (await page.request.get(`/farming/api/agents/${bashAgentId}/session-view`)).json() as {
        session?: { previewCols?: number; previewRows?: number }
      }
      expect(result.resizeCount).toBeGreaterThanOrEqual(beforeCount)
      expect(sessionView.session?.previewCols).toBe(result.diagnostics?.cols)
      expect(sessionView.session?.previewRows).toBe(result.diagnostics?.rows)
    })

    await scenario('long output creates scrollback without moving the whole page', async () => {
      await page.evaluate(async id => {
        await window.__farmingTerminalTest?.scrollToBottom(id)
      }, bashAgentId)
      await expect.poll(async () => (await terminalViewport(page, bashAgentId)).following).toBe(true)
      const before = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }))
      await sendActiveTerminalCommand(
        page,
        bashAgentId,
        'i=0; while [ "$i" -lt 180 ]; do printf "matrix-line-%03d\\n" "$i"; i=$((i + 1)); done',
      )
      await expect.poll(async () => {
        const [visibleText, diagnostics, outputResponse] = await Promise.all([
          visibleTerminalText(page, bashAgentId),
          terminalDiagnostics(page, bashAgentId),
          page.request.get(`/farming/api/control/agents/${bashAgentId}/output?tail=8000`),
        ])
        const backendText = outputResponse.ok() ? await outputResponse.text() : ''
        return {
          backendHasLastLine: backendText.includes('matrix-line-179'),
          visibleHasLastLine: visibleText.includes('matrix-line-179'),
          diagnostics,
        }
      }, { timeout: 15_000 }).toEqual(expect.objectContaining({
        backendHasLastLine: true,
        visibleHasLastLine: true,
      }))
      const viewport = await terminalViewport(page, bashAgentId)
      expect(viewport.scrollbackLength).toBeGreaterThan(0)
      const after = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }))
      expect(after).toEqual(before)
    })

    await scenario('user scroll position stays anchored while older output is being read', async () => {
      await sendActiveTerminalCommand(
        page,
        bashAgentId,
        'sleep 2; printf "matrix-new-background-output\\n"',
      )
      const outputSeqBefore = await page.evaluate(
        id => window.__farmingTerminalTest?.getLastOutputSeq(id) ?? 0,
        bashAgentId,
      )
      await page.evaluate(async ({ id }) => {
        await window.__farmingTerminalTest?.scrollToLine(id, 30)
      }, { id: bashAgentId })
      const scrolled = await terminalViewport(page, bashAgentId)
      expect(scrolled.following).toBe(false)
      expect(scrolled.viewportY).toBeGreaterThan(0)
      await expect.poll(async () => {
        const response = await page.request.get(`/farming/api/control/agents/${bashAgentId}/output?tail=2000`)
        return response.ok() ? (await response.text()).includes('matrix-new-background-output') : false
      }).toBe(true)
      await expect.poll(async () => page.evaluate(
        id => window.__farmingTerminalTest?.getLastOutputSeq(id) ?? 0,
        bashAgentId,
      )).toBeGreaterThan(outputSeqBefore)
      await expect(agentListItem(page, bashAgentId)).toHaveAttribute(
        'aria-label',
        /Last command: printf "matrix-new-background-output\\n"/,
      )
      await expect.poll(async () => await terminalViewport(page, bashAgentId))
        .toEqual(expect.objectContaining({
          following: false,
          hasUnreadOutput: true,
        }))
    })

    await scenario('opening a paused unread terminal keeps the agent unread until jumping to latest output', async () => {
      const bashRow = agentListItem(page, bashAgentId)
      const flagResponse = await page.request.patch(`/farming/api/agents/${bashAgentId}`, {
        data: { unread: true },
      })
      expect(flagResponse.ok()).toBeTruthy()
      await expect(bashRow).toHaveClass(/unread/)
      await selectAgent(page, reconnectOutputAgentId)
      await expect(bashRow).toHaveClass(/unread/)

      await selectAgent(page, bashAgentId)
      await expect(bashRow).toHaveClass(/unread/)
      await expect(page.getByTestId('code-terminal-jump-bottom')).toBeVisible()
    })

    await scenario('jump-to-bottom restores follow mode after anchored scrolling', async () => {
      const inputCountBeforeJump = await page.evaluate((id) => window.__farmingTerminalTest?.getInputCount(id) ?? 0, bashAgentId)
      await page.getByTestId('code-terminal-jump-bottom').click()
      await expect.poll(async () => (await terminalViewport(page, bashAgentId)).following).toBe(true)
      expect((await terminalViewport(page, bashAgentId)).viewportY).toBe(0)
      await expect.poll(async () => await visibleTerminalText(page, bashAgentId)).toContain('matrix-new-background-output')
      await expect(page.getByTestId('code-terminal-jump-bottom')).toHaveCount(0)
      await expect(agentListItem(page, bashAgentId)).not.toHaveClass(/unread/)
      const inputCountAfterJump = await page.evaluate((id) => window.__farmingTerminalTest?.getInputCount(id) ?? 0, bashAgentId)
      expect(inputCountAfterJump).toBe(inputCountBeforeJump)
    })

    await scenario('new live output remains readable after returning to bottom', async () => {
      await sendActiveTerminalCommand(page, bashAgentId, 'printf "matrix-after-bottom-output\\n"')
      await expect.poll(async () => {
        const response = await page.request.get(`/farming/api/control/agents/${bashAgentId}/output?tail=2000`)
        return response.ok() ? await response.text() : ''
      }, { timeout: 15_000 }).toContain('matrix-after-bottom-output')
      try {
        await page.waitForFunction(
          id => Boolean(window.__farmingTerminalTest?.isReady(id)),
          bashAgentId,
          { timeout: 15_000 },
        )
      } catch (error) {
        const diagnostics = await page.evaluate(
          id => window.__farmingTerminalTest?.getBufferDiagnostics(id) ?? null,
          bashAgentId,
        )
        throw new Error(`Terminal did not settle after live output: ${JSON.stringify(diagnostics)}`, {
          cause: error,
        })
      }
      await expect.poll(async () => await visibleTerminalText(page, bashAgentId)).toContain('matrix-after-bottom-output')
    })

    await scenario('PageUp scrolls terminal history without sending input to the PTY', async () => {
      const output = Array.from({ length: 160 }, (_, index) => `pageup-key-line-${String(index).padStart(3, '0')}`).join('\r\n')
      await writeTerminalFixture(page, bashAgentId, `${output}\r\nPAGEUP_KEY_SENTINEL\r\n`)
      await page.evaluate(async (id) => {
        await window.__farmingTerminalTest?.scrollToBottom(id)
      }, bashAgentId)
      await expect.poll(async () => (await terminalViewport(page, bashAgentId)).following).toBe(true)
      await expect.poll(async () => (await terminalViewport(page, bashAgentId)).scrollbackLength).toBeGreaterThan(0)
      const cell = await cellForText(page, bashAgentId, 'PAGEUP_KEY_SENTINEL', 4)
      await page.mouse.click(cell.x, cell.y)
      await expectActiveTerminalFocus(page, bashAgentId)
      const inputCountBeforePageUp = await page.evaluate((id) => window.__farmingTerminalTest?.getInputCount(id) ?? 0, bashAgentId)
      const pageUpResult = await pressTerminalScrollKey(page, bashAgentId, 'PageUp')
      expect(pageUpResult.afterWindow).toEqual(pageUpResult.beforeWindow)
      await expect.poll(async () => (await terminalViewport(page, bashAgentId)).viewportY).toBeGreaterThan(0)
      await expect.poll(async () => (await terminalViewport(page, bashAgentId)).following).toBe(false)
      const inputCountAfterPageUp = await page.evaluate((id) => window.__farmingTerminalTest?.getInputCount(id) ?? 0, bashAgentId)
      expect(inputCountAfterPageUp).toBe(inputCountBeforePageUp)
      await page.evaluate(async (id) => {
        await window.__farmingTerminalTest?.scrollToBottom(id)
      }, bashAgentId)
      await expect.poll(async () => (await terminalViewport(page, bashAgentId)).following).toBe(true)
    })

    await scenario('PageDown and jump-to-bottom update scrollback state without sending input to the PTY', async () => {
      const output = Array.from({ length: 160 }, (_, index) => `scroll-key-line-${String(index).padStart(3, '0')}`).join('\r\n')
      await writeTerminalFixture(page, bashAgentId, `${output}\r\nSCROLL_KEY_SENTINEL\r\n`)
      await page.evaluate(async (id) => {
        await window.__farmingTerminalTest?.scrollToBottom(id)
      }, bashAgentId)
      const cell = await cellForText(page, bashAgentId, 'SCROLL_KEY_SENTINEL', 4)
      await page.mouse.click(cell.x, cell.y)
      await expectActiveTerminalFocus(page, bashAgentId)

      const inputCountBeforeKeys = await page.evaluate((id) => window.__farmingTerminalTest?.getInputCount(id) ?? 0, bashAgentId)
      const pageUpResult = await pressTerminalScrollKey(page, bashAgentId, 'PageUp')
      expect(pageUpResult.afterWindow).toEqual(pageUpResult.beforeWindow)
      await expect.poll(async () => (await terminalViewport(page, bashAgentId)).viewportY).toBeGreaterThan(0)
      const afterPageUp = await terminalViewport(page, bashAgentId)
      await expect.poll(async () => (await terminalViewport(page, bashAgentId)).following).toBe(false)

      const pageDownResult = await pressTerminalScrollKey(page, bashAgentId, 'PageDown')
      expect(pageDownResult.afterWindow).toEqual(pageDownResult.beforeWindow)
      await expect.poll(async () => (await terminalViewport(page, bashAgentId)).viewportY).toBeLessThan(afterPageUp.viewportY)

      const secondPageUpResult = await pressTerminalScrollKey(page, bashAgentId, 'PageUp')
      expect(secondPageUpResult.afterWindow).toEqual(secondPageUpResult.beforeWindow)
      await expect.poll(async () => (await terminalViewport(page, bashAgentId)).viewportY).toBeGreaterThan(0)
      await writeTerminalRaw(page, bashAgentId, 'SCROLL_KEY_UNREAD_OUTPUT\r\n')
      await expect.poll(async () => (await terminalViewport(page, bashAgentId)).hasUnreadOutput).toBe(true)
      await expect(page.getByTestId('code-terminal-jump-bottom')).toBeVisible()
      await page.getByTestId('code-terminal-jump-bottom').click()
      await expect.poll(async () => (await terminalViewport(page, bashAgentId)).viewportY).toBe(0)
      expect((await terminalViewport(page, bashAgentId)).following).toBe(true)
      expect((await terminalViewport(page, bashAgentId)).hasUnreadOutput).toBe(false)
      await expect(page.getByTestId('code-terminal-jump-bottom')).toHaveCount(0)

      const inputCountAfterKeys = await page.evaluate((id) => window.__farmingTerminalTest?.getInputCount(id) ?? 0, bashAgentId)
      expect(inputCountAfterKeys).toBe(inputCountBeforeKeys)
    })

    await scenario('concurrent terminal output writes preserve scroll anchor and output order', async () => {
      const output = Array.from({ length: 160 }, (_, index) => `queued-line-${String(index).padStart(3, '0')}`).join('\r\n')
      await writeTerminalFixture(page, bashAgentId, `${output}\r\n`)
      await page.evaluate(async ({ id }) => {
        await window.__farmingTerminalTest?.scrollToLine(id, 30)
      }, { id: bashAgentId })
      const before = await terminalViewport(page, bashAgentId)
      expect(before.following).toBe(false)

      await page.evaluate(async ({ id }) => {
        const api = window.__farmingTerminalTest
        if (!api) throw new Error('terminal test API is missing')
        await Promise.all([
          api.writeRaw(id, 'QUEUE_WRITE_A\r\n'),
          api.writeRaw(id, 'QUEUE_WRITE_B\r\n'),
          api.writeRaw(id, 'QUEUE_WRITE_C\r\n'),
        ])
      }, { id: bashAgentId })

      const after = await terminalViewport(page, bashAgentId)
      expect(after.following).toBe(false)
      expect(after.hasUnreadOutput).toBe(true)
      expect(after.viewportY).toBeGreaterThanOrEqual(before.viewportY)

      await page.getByTestId('code-terminal-jump-bottom').click()
      await expect.poll(async () => (await terminalViewport(page, bashAgentId)).following).toBe(true)
      const visible = await visibleTerminalText(page, bashAgentId)
      expect(visible.indexOf('QUEUE_WRITE_A')).toBeLessThan(visible.indexOf('QUEUE_WRITE_B'))
      expect(visible.indexOf('QUEUE_WRITE_B')).toBeLessThan(visible.indexOf('QUEUE_WRITE_C'))
    })

    await scenario('plain terminal text can be double-click selected', async () => {
      await writeTerminalFixture(page, bashAgentId, 'matrix-copy-word\r\n')
      const cell = await cellForText(page, bashAgentId, 'matrix-copy-word', 3)
      await page.mouse.dblclick(cell.x, cell.y)
      await expect.poll(async () => page.evaluate(id => window.__farmingTerminalTest?.getSelection(id) ?? '', bashAgentId))
        .toBe('matrix-copy-word')
    })

    await scenario('context menu copies the selected terminal text', async () => {
      const cell = await cellForText(page, bashAgentId, 'matrix-copy-word', 3)
      await page.mouse.click(cell.x, cell.y, { button: 'right' })
      const menu = page.getByTestId('code-terminal-context-menu')
      await expect(menu).toBeVisible()
      await expect(menu.getByRole('menuitem', { name: /Paste|粘贴/ })).toBeVisible()
      await expect(menu.getByRole('menuitem', { name: /Select All|全选/ })).toBeVisible()
      await menu.getByRole('menuitem', { name: /Copy|复制/ }).click()
      await expect.poll(async () => page.evaluate(() => navigator.clipboard.readText())).toBe('matrix-copy-word')
    })

    await scenario('context menu paste sends clipboard text to the active terminal', async () => {
      await page.evaluate(async id => window.__farmingTerminalTest?.resumeLive(id), bashAgentId)
      try {
        await page.waitForFunction(
          id => Boolean(window.__farmingTerminalTest?.isReady(id)),
          bashAgentId,
          { timeout: 15_000 },
        )
      } catch (error) {
        throw new Error(
          `Fixture did not resume to the live checkpoint: ${JSON.stringify(await terminalDiagnostics(page, bashAgentId))}`,
          { cause: error },
        )
      }
      await page.evaluate(() => navigator.clipboard.writeText("printf 'MATRIX_CONTEXT_MENU_PASTE_OK\\n'\r"))
      await expect.poll(async () => page.evaluate(() => navigator.clipboard.readText()))
        .toContain('MATRIX_CONTEXT_MENU_PASTE_OK')
      const inputCountBeforePaste = await page.evaluate((id) => window.__farmingTerminalTest?.getInputCount(id) ?? 0, bashAgentId)
      await page.locator(activeTerminalHostSelector(bashAgentId)).click({
        button: 'right',
        position: { x: 240, y: 48 },
      })
      const menu = page.getByTestId('code-terminal-context-menu')
      await expect(menu).toBeVisible()
      await menu.getByRole('menuitem', { name: /Paste|粘贴/ }).click()
      try {
        await expect.poll(async () => page.evaluate((id) => window.__farmingTerminalTest?.getInputCount(id) ?? 0, bashAgentId))
          .toBeGreaterThan(inputCountBeforePaste)
      } catch (error) {
        const state = await page.evaluate((id) => ({
          clipboard: null as string | null,
          diagnostics: window.__farmingTerminalTest?.getBufferDiagnostics(id) ?? null,
          host: window.__farmingTerminalTest?.getHostDiagnostics().find(item => item.agentId === id) ?? null,
        }), bashAgentId)
        state.clipboard = await page.evaluate(() => navigator.clipboard.readText()).catch(() => null)
        const statusTitle = await page.getByTestId('code-terminal-status-card').getAttribute('title').catch(() => null)
        throw new Error(
          `Context-menu paste did not reach input: ${JSON.stringify({ ...state, statusTitle })}`,
          { cause: error },
        )
      }
      await expect.poll(async () => {
        const response = await page.request.get(`/farming/api/control/agents/${bashAgentId}/output?tail=2000`)
        return response.ok() ? await response.text() : ''
      }).toContain('MATRIX_CONTEXT_MENU_PASTE_OK')
      await expect.poll(async () => await visibleTerminalText(page, bashAgentId)).toContain('MATRIX_CONTEXT_MENU_PASTE_OK')
    })

    await scenario('context menu select all selects terminal scrollback text', async () => {
      await sendActiveTerminalCommand(
        page,
        bashAgentId,
        'printf "matrix-select-all-one\\nmatrix-select-all-two\\n"',
      )
      await expect.poll(async () => await visibleTerminalText(page, bashAgentId))
        .toContain('matrix-select-all-two')
      const cell = await cellForText(page, bashAgentId, 'matrix-select-all-two', 4)
      await page.mouse.click(cell.x, cell.y, { button: 'right' })
      const menu = page.getByTestId('code-terminal-context-menu')
      await expect(menu).toBeVisible()
      await menu.getByRole('menuitem', { name: /Select All|全选/ }).click()
      await expect.poll(async () => page.evaluate(id => window.__farmingTerminalTest?.getSelection(id) ?? '', bashAgentId))
        .toContain('matrix-select-all-one')
      await expect.poll(async () => page.evaluate(id => window.__farmingTerminalTest?.getSelection(id) ?? '', bashAgentId))
        .toContain('matrix-select-all-two')
    })

    await scenario('context menu clear removes visible and backend terminal scrollback', async () => {
      const cell = await cellForText(page, bashAgentId, 'matrix-select-all-two', 4)
      await page.mouse.click(cell.x, cell.y, { button: 'right' })
      const menu = page.getByTestId('code-terminal-context-menu')
      await expect(menu).toBeVisible()
      await menu.getByRole('menuitem', { name: /Clear|清除/ }).click()
      await expect(page.getByTestId('code-terminal-context-menu')).toHaveCount(0)
      await expect.poll(async () => await visibleTerminalText(page, bashAgentId)).not.toContain('matrix-select-all-one')
      await expect.poll(async () => {
        const response = await page.request.get(`/farming/api/control/agents/${bashAgentId}/output?tail=4000`)
        return response.ok() ? await response.text() : ''
      }).not.toContain('matrix-select-all-one')
      await sendActiveTerminalCommand(page, bashAgentId, 'printf "matrix-clear-after\\n"')
      await expect.poll(async () => await visibleTerminalText(page, bashAgentId)).toContain('matrix-clear-after')
    })

    if (process.platform === 'darwin') {
      await scenario('Cmd+K clears visible and backend terminal scrollback on macOS', async () => {
        await selectAgent(page, bashAgentId)
        await sendActiveTerminalCommand(page, bashAgentId, 'printf "matrix-cmd-k-clear-before\\n"')
        await expect.poll(async () => await visibleTerminalText(page, bashAgentId)).toContain('matrix-cmd-k-clear-before')
        const cell = await cellForText(page, bashAgentId, 'matrix-cmd-k-clear-before', 4)
        await page.mouse.click(cell.x, cell.y)
        await expectActiveTerminalFocus(page, bashAgentId)
        await page.locator(`${activeTerminalHostSelector(bashAgentId)} textarea`).first().press('Meta+K')
        await expect.poll(async () => await visibleTerminalText(page, bashAgentId)).not.toContain('matrix-cmd-k-clear-before')
        await expect.poll(async () => {
          const response = await page.request.get(`/farming/api/control/agents/${bashAgentId}/output?tail=4000`)
          return response.ok() ? await response.text() : ''
        }).not.toContain('matrix-cmd-k-clear-before')
        await sendActiveTerminalCommand(page, bashAgentId, 'printf "matrix-cmd-k-clear-after\\n"')
        await expect.poll(async () => await visibleTerminalText(page, bashAgentId)).toContain('matrix-cmd-k-clear-after')
      })
    }

    await scenario('keyboard copy uses the terminal selection without sending Ctrl-C to the PTY', async () => {
      await writeTerminalFixture(page, bashAgentId, 'matrix-keyboard-copy\r\n')
      const cell = await cellForText(page, bashAgentId, 'matrix-keyboard-copy', 3)
      await page.mouse.dblclick(cell.x, cell.y)
      await expect.poll(async () => page.evaluate(id => window.__farmingTerminalTest?.getSelection(id) ?? '', bashAgentId))
        .toBe('matrix-keyboard-copy')
      const inputCountBeforeCopy = await page.evaluate((id) => window.__farmingTerminalTest?.getInputCount(id) ?? 0, bashAgentId)
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+C' : 'Control+C')
      await expect.poll(async () => page.evaluate(() => navigator.clipboard.readText())).toBe('matrix-keyboard-copy')
      const inputCountAfterCopy = await page.evaluate((id) => window.__farmingTerminalTest?.getInputCount(id) ?? 0, bashAgentId)
      expect(inputCountAfterCopy).toBe(inputCountBeforeCopy)
    })

    await scenario('mixed Chinese and English terminal output renders without truncating wide characters', async () => {
      const selected = 'HashDelta alter 中文'
      await writeTerminalFixture(page, bashAgentId, `${selected}\r\n`)
      await expect.poll(async () => await visibleTerminalText(page, bashAgentId)).toContain(selected)
    })

    const url = 'https://example.test/path/to/review?from=matrix&to=main'
    const terminalFindShortcut = process.platform === 'darwin' ? 'Meta+F' : 'Control+F'
    await scenario('modifier-hovering a terminal URL exposes an open-target affordance', async () => {
      await writeTerminalFixture(page, bashAgentId, `${url}\r\n`)
      const cell = await cellForText(page, bashAgentId, 'example.test', 2)
      await hoverTerminalCell(page, cell.x, cell.y)
      await expect.poll(async () => {
        return page.evaluate((id) => {
          const host = document.querySelector(`.terminal-session-host[data-agent-id="${CSS.escape(id)}"]`)
          return host instanceof HTMLElement ? host.classList.contains('terminal-open-target-hover') : false
        }, bashAgentId)
      }).toBe(false)
      await dispatchTerminalModifierKey(page, 'keydown')
      await expect.poll(async () => {
        return page.evaluate((id) => {
          const host = document.querySelector(`.terminal-session-host[data-agent-id="${CSS.escape(id)}"]`)
          if (!(host instanceof HTMLElement)) return null
          const xterm = host.querySelector('.xterm')
          return {
            hover: host.classList.contains('terminal-open-target-hover'),
            target: host.dataset.terminalOpenTarget || '',
            cursor: xterm instanceof Element ? getComputedStyle(xterm).cursor : '',
          }
        }, bashAgentId)
      }).toEqual({
        hover: true,
        target: 'url',
        cursor: 'pointer',
      })
      await dispatchTerminalModifierKey(page, 'keyup')
      await expect.poll(async () => {
        return page.evaluate((id) => {
          const host = document.querySelector(`.terminal-session-host[data-agent-id="${CSS.escape(id)}"]`)
          return host instanceof HTMLElement ? host.classList.contains('terminal-open-target-hover') : false
        }, bashAgentId)
      }).toBe(false)
    })

    await scenario('modifier-clicking a terminal URL opens the exact URL', async () => {
      await writeTerminalFixture(page, bashAgentId, `${url}\r\n`)
      const cell = await cellForText(page, bashAgentId, 'example.test', 2)
      await page.mouse.click(cell.x, cell.y)
      await expect.poll(async () => page.evaluate(() => {
        return (window as unknown as { __openedTerminalUrls?: string[] }).__openedTerminalUrls ?? []
      })).toHaveLength(0)
      await expect.poll(async () => page.evaluate(({ id, col, row }) => {
        return window.__farmingTerminalTest?.getUrlAtCell(id, col, row) ?? null
      }, { id: bashAgentId, col: cell.col, row: cell.row })).toBe(url)
      await dispatchTerminalModifierClick(page, bashAgentId, cell.x, cell.y)
      await expect.poll(async () => page.evaluate(() => {
        return (window as unknown as { __openedTerminalUrls?: string[] }).__openedTerminalUrls ?? []
      })).toContain(url)
    })

    await scenario('right-clicking a terminal URL copies the exact URL', async () => {
      await writeTerminalFixture(page, bashAgentId, `${url}\r\n`)
      const cell = await cellForText(page, bashAgentId, 'example.test', 2)
      await page.mouse.click(cell.x, cell.y, { button: 'right' })
      const menu = page.getByTestId('code-terminal-context-menu')
      await expect(menu).toBeVisible()
      await menu.getByRole('menuitem', { name: /Copy|复制/ }).click()
      await expect.poll(async () => page.evaluate(() => navigator.clipboard.readText())).toBe(url)
    })

    await scenario('soft-wrapped URL is reconstructed and copied from terminal hit testing', async () => {
      const wrappedUrl = [
        'https://example.test/very/long/path',
        '?token=abcdef1234567890',
        '&segment=segment-000-segment-001-segment-002-segment-003-segment-004',
        '&mode=wrapped',
      ].join('')
      await writeTerminalFixture(page, bashAgentId, `${wrappedUrl}\r\n`)
      await expect.poll(async () => (await terminalRows(page, bashAgentId, 40)).join('\n'))
        .toContain('segment-002')
      const rows = await terminalRows(page, bashAgentId, 40)
      let hit: { row: number; col: number } | null = null
      for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
        const col = rows[rowIndex]?.indexOf('segment-002') ?? -1
        if (col < 0) continue
        const parsed = await page.evaluate(({ id, x, y }) => {
          return window.__farmingTerminalTest?.getUrlAtCell(id, x, y) ?? null
        }, { id: bashAgentId, x: col + 2, y: rowIndex })
        if (parsed === wrappedUrl) {
          hit = { row: rowIndex, col: col + 2 }
          break
        }
      }
      if (!hit) {
        throw new Error(`Soft-wrapped terminal URL fixture row is missing: ${JSON.stringify(rows)}`)
      }
      const cell = await page.evaluate(({ id, x, y }) => {
        return window.__farmingTerminalTest?.getCellCenter(id, x, y) ?? null
      }, { id: bashAgentId, x: hit.col, y: hit.row })
      if (!cell) throw new Error('Soft-wrapped terminal URL fixture cell is missing')
      await page.mouse.click(cell.x, cell.y, { button: 'right' })
      const menu = page.getByTestId('code-terminal-context-menu')
      await expect(menu).toBeVisible()
      await menu.getByRole('menuitem', { name: /Copy|复制/ }).click()
      await expect.poll(async () => page.evaluate(() => navigator.clipboard.readText())).toBe(wrappedUrl)
    })

    await scenario('terminal URL with trailing punctuation does not absorb the next line', async () => {
      const punctuatedUrl = 'https://example.test/path.'
      const trimmedUrl = 'https://example.test/path'
      await writeTerminalFixture(page, bashAgentId, `${punctuatedUrl}\r\nsegment-should-not-join\r\n`)
      const cell = await cellForText(page, bashAgentId, 'example.test', 2)
      await expect.poll(async () => page.evaluate(({ id, col, row }) => {
        return window.__farmingTerminalTest?.getUrlAtCell(id, col, row) ?? null
      }, { id: bashAgentId, col: cell.col, row: cell.row })).toBe(trimmedUrl)
      await page.mouse.click(cell.x, cell.y, { button: 'right' })
      const menu = page.getByTestId('code-terminal-context-menu')
      await expect(menu).toBeVisible()
      await menu.getByRole('menuitem', { name: /Copy|复制/ }).click()
      await expect.poll(async () => page.evaluate(() => navigator.clipboard.readText())).toBe(trimmedUrl)
    })

    await scenario('hovering a terminal path:line exposes a direct file open affordance', async () => {
      await writeTerminalFixture(page, bashAgentId, 'README.md:3:1 failed\r\n')
      const cell = await cellForText(page, bashAgentId, 'README.md', 2)
      await hoverTerminalCell(page, cell.x, cell.y)
      await expect.poll(async () => {
        return page.evaluate((id) => {
          const host = document.querySelector(`.terminal-session-host[data-agent-id="${CSS.escape(id)}"]`)
          if (!(host instanceof HTMLElement)) return null
          return {
            hover: host.classList.contains('terminal-open-target-hover'),
            target: host.dataset.terminalOpenTarget || '',
            title: host.getAttribute('title') || '',
          }
        }, bashAgentId)
      }).toEqual(expect.objectContaining({
        hover: true,
        target: 'path',
      }))
      const title = await page.evaluate((id) => {
        const host = document.querySelector(`.terminal-session-host[data-agent-id="${CSS.escape(id)}"]`)
        return host instanceof HTMLElement ? host.getAttribute('title') || '' : ''
      }, bashAgentId)
      expect(title).toMatch(/打开文件|open file/i)
      expect(title).not.toMatch(/Cmd|Ctrl/)
      const blankCell = await page.evaluate(({ id, row }) => {
        return window.__farmingTerminalTest?.getCellCenter(id, 30, row) ?? null
      }, { id: bashAgentId, row: cell.row })
      if (!blankCell) throw new Error('Terminal blank cell beside path fixture is missing')
      await hoverTerminalCell(page, blankCell.x, blankCell.y)
      await expect.poll(async () => {
        return page.evaluate((id) => {
          const host = document.querySelector(`.terminal-session-host[data-agent-id="${CSS.escape(id)}"]`)
          if (!(host instanceof HTMLElement)) return null
          return {
            hover: host.classList.contains('terminal-open-target-hover'),
            target: host.dataset.terminalOpenTarget || '',
            title: host.getAttribute('title') || '',
          }
        }, bashAgentId)
      }).toEqual({
        hover: false,
        target: '',
        title: '',
      })
      await page.mouse.click(blankCell.x, blankCell.y)
      await expect(page.getByTestId('code-file-editor')).toBeHidden()
      await page.mouse.move(0, 0)
      await expect.poll(async () => {
        return page.evaluate((id) => {
          const host = document.querySelector(`.terminal-session-host[data-agent-id="${CSS.escape(id)}"]`)
          return host instanceof HTMLElement ? host.classList.contains('terminal-open-target-hover') : false
        }, bashAgentId)
      }).toBe(false)
    })

    await scenario('plain-clicking a terminal path:line opens README in the file editor', async () => {
      await writeTerminalFixture(page, bashAgentId, 'README.md:3:1 failed\r\n')
      const cell = await cellForText(page, bashAgentId, 'README.md', 2)
      await page.mouse.click(cell.x, cell.y)
      await expect(page.getByTestId('code-file-editor')).toBeVisible()
      await expect(page.getByTestId('code-file-editor').getByRole('tab', { selected: true })).toContainText('README.md')
      await expect(page.getByTestId('code-file-editor-statusbar')).toContainText('Ln 3, Col 1')
      await page.getByTestId('code-file-editor-back').click()
      await expect(page.getByTestId('code-terminal-grid')).toBeVisible()
    })

    await scenario('plain-clicking a unique terminal filename opens the workspace file', async () => {
      await writeTerminalFixture(page, bashAgentId, 'unique-only.log unique terminal filename\r\n')
      const cell = await cellForText(page, bashAgentId, 'unique-only.log', 2)
      await hoverTerminalCell(page, cell.x, cell.y)
      await expect.poll(async () => {
        return page.evaluate((id) => {
          const host = document.querySelector(`.terminal-session-host[data-agent-id="${CSS.escape(id)}"]`)
          if (!(host instanceof HTMLElement)) return null
          return {
            hover: host.classList.contains('terminal-open-target-hover'),
            target: host.dataset.terminalOpenTarget || '',
          }
        }, bashAgentId)
      }).toEqual(expect.objectContaining({
        hover: true,
        target: 'path',
      }))
      await page.mouse.click(cell.x, cell.y)
      await expect(page.getByTestId('code-file-editor')).toBeVisible()
      await expect(page.getByTestId('code-file-editor').getByRole('tab', { selected: true })).toContainText('unique-only.log')
      await page.getByTestId('code-file-editor-back').click()
      await expect(page.getByTestId('code-terminal-grid')).toBeVisible()
    })

    await scenario('direct-clicking a unique terminal filename opens without waiting for hover resolution', async () => {
      await writeTerminalFixture(page, bashAgentId, 'instant-only.log instant terminal filename\r\n')
      const cell = await cellForText(page, bashAgentId, 'instant-only.log', 2)
      await page.mouse.click(cell.x, cell.y)
      await expect(page.getByTestId('code-file-editor')).toBeVisible()
      await expect(page.getByTestId('code-file-editor').getByRole('tab', { selected: true })).toContainText('instant-only.log')
      await page.getByTestId('code-file-editor-back').click()
      await expect(page.getByTestId('code-terminal-grid')).toBeVisible()
    })

    await scenario('hovering a missing terminal filename does not expose a file affordance', async () => {
      await writeTerminalFixture(page, bashAgentId, 'missing-file.txt missing terminal filename\r\n')
      const cell = await cellForText(page, bashAgentId, 'missing-file.txt', 2)
      await hoverTerminalCell(page, cell.x, cell.y)
      await expect.poll(async () => {
        return page.evaluate((id) => {
          const host = document.querySelector(`.terminal-session-host[data-agent-id="${CSS.escape(id)}"]`)
          if (!(host instanceof HTMLElement)) return null
          return {
            hover: host.classList.contains('terminal-open-target-hover'),
            target: host.dataset.terminalOpenTarget || '',
          }
        }, bashAgentId)
      }).toEqual(expect.objectContaining({
        hover: false,
        target: '',
      }))
      await page.mouse.click(cell.x, cell.y)
      await expect(page.getByTestId('code-file-editor')).toBeHidden()
    })

    await scenario('hovering an ambiguous terminal filename does not expose a file affordance', async () => {
      await writeTerminalFixture(page, bashAgentId, 'duplicate.txt ambiguous terminal filename\r\n')
      const cell = await cellForText(page, bashAgentId, 'duplicate.txt', 2)
      await hoverTerminalCell(page, cell.x, cell.y)
      await expect.poll(async () => {
        return page.evaluate((id) => {
          const host = document.querySelector(`.terminal-session-host[data-agent-id="${CSS.escape(id)}"]`)
          if (!(host instanceof HTMLElement)) return null
          return {
            hover: host.classList.contains('terminal-open-target-hover'),
            target: host.dataset.terminalOpenTarget || '',
          }
        }, bashAgentId)
      }).toEqual(expect.objectContaining({
        hover: false,
        target: '',
      }))
      await page.mouse.click(cell.x, cell.y)
      await expect(page.getByTestId('code-file-editor')).toBeHidden()
    })

    await scenario('drag-selecting a terminal path does not open the file editor', async () => {
      await writeTerminalFixture(page, bashAgentId, 'README.md:2:1 selectable terminal path\r\n')
      const cell = await cellForText(page, bashAgentId, 'README.md', 2)
      await page.mouse.move(cell.x, cell.y)
      await page.mouse.down()
      await page.mouse.move(cell.x + 180, cell.y, { steps: 6 })
      await page.mouse.up()
      await expect(page.getByTestId('code-file-editor')).toBeHidden()
      await expect.poll(async () => {
        return page.evaluate((id) => window.__farmingTerminalTest?.getSelection(id) ?? '', bashAgentId)
      }).toContain('.md:2:1 selectable')
    })

    await scenario('right-clicking a terminal path copies the exact path link text', async () => {
      await writeTerminalFixture(page, bashAgentId, 'README.md:4:1 copyable terminal path\r\n')
      const cell = await cellForText(page, bashAgentId, 'README.md', 2)
      await page.mouse.click(cell.x, cell.y, { button: 'right' })
      const menu = page.getByTestId('code-terminal-context-menu')
      await expect(menu).toBeVisible()
      await menu.getByRole('menuitem', { name: /Copy|复制/ }).click()
      await expect.poll(async () => page.evaluate(() => navigator.clipboard.readText())).toBe('README.md:4:1')
      await expect(page.getByTestId('code-file-editor')).toBeHidden()
    })

    await scenario('switching to Codex keeps bash terminal host parked and isolated', async () => {
      await selectAgent(page, codexAgentId)
      await expect(page.locator(`[data-testid="code-terminal-pane"][data-agent-id="${codexAgentId}"] .terminal-session-host[data-agent-id="${codexAgentId}"]`))
        .toBeVisible({ timeout: 15_000 })
      const diagnostics = await terminalHostDiagnostics(page)
      const visibleHosts = diagnostics.filter(host => host.visible && !host.inParkingLot)
      expect(visibleHosts).toEqual([
        expect.objectContaining({ agentId: codexAgentId, paneAgentId: codexAgentId, hostCountInMount: 1 }),
      ])
    })

      await scenario('Codex and bash panes do not visually mix output after switching', async () => {
        await writeTerminalRaw(page, codexAgentId, 'CODEX_MATRIX_ONLY\r\n')
        await selectAgent(page, bashAgentId)
        await expect.poll(async () => await visibleTerminalText(page, bashAgentId)).not.toContain('CODEX_MATRIX_ONLY')
        await selectAgent(page, codexAgentId)
        await expect.poll(async () => await visibleTerminalText(page, codexAgentId)).toContain('CODEX_MATRIX_ONLY')
      })

      await scenario('rapid switching between two Codex agents keeps host ownership and renderer cursor isolation', async () => {
        await selectAgent(page, codexAgentId)
        await writeTerminalRaw(page, codexAgentId, 'FIRST_CODEX_SENTINEL\r\n')
        await selectAgent(page, secondCodexAgentId)
        await writeTerminalRaw(page, secondCodexAgentId, 'SECOND_CODEX_SENTINEL\r\n')

        const sequence = Array.from({ length: 12 }, (_, index) => index % 2 === 0 ? codexAgentId : secondCodexAgentId)
        for (const targetAgentId of sequence) {
          await agentListItem(page, targetAgentId).click()
          await expect(agentListItem(page, targetAgentId)).toHaveClass(/active/)
          await expect.poll(async () => {
            return page.evaluate((id) => {
              const visibleHosts = Array.from(document.querySelectorAll('.terminal-session-host')).filter(host => {
                if (!(host instanceof HTMLElement)) return false
                if (host.closest('#terminal-session-parking-lot')) return false
                const rect = host.getBoundingClientRect()
                return rect.width > 0 && rect.height > 0
              }) as HTMLElement[]
              const host = visibleHosts[0] ?? null
              return {
                visibleCount: visibleHosts.length,
                agentId: host?.dataset.agentId || '',
                paneAgentId: host?.closest('[data-testid="code-terminal-pane"]')?.getAttribute('data-agent-id') || '',
                hostCountInMount: host?.parentElement?.querySelectorAll('.terminal-session-host').length ?? 0,
                xtermRootCount: host?.querySelectorAll(':scope > .xterm').length ?? 0,
                nestedXtermCount: host?.querySelectorAll('.xterm .xterm').length ?? 0,
                renderer: window.__farmingTerminalTest?.getBufferDiagnostics(id)?.renderer ?? '',
                cursorSuppressed: host?.classList.contains('terminal-renderer-cursor-suppressed') ?? false,
                activeRowId: document.querySelector('[data-testid="code-agent-row"].active, [data-testid="code-project-agent-compact"].active, [data-testid="code-pinned-agent-compact"].active')?.getAttribute('data-agent-id') || '',
                activePaneId: document.querySelector('[data-testid="code-terminal-pane"].active')?.getAttribute('data-agent-id') || '',
                expectedAgentId: id,
              }
            }, targetAgentId)
          }, { timeout: 10_000 }).toEqual({
            visibleCount: 1,
            agentId: targetAgentId,
            paneAgentId: targetAgentId,
            hostCountInMount: 1,
            xtermRootCount: 1,
            nestedXtermCount: 0,
            renderer: 'webgl',
            cursorSuppressed: false,
            activeRowId: targetAgentId,
            activePaneId: targetAgentId,
            expectedAgentId: targetAgentId,
          })
          await page.waitForTimeout(40)
        }

        await expect.poll(async () => await visibleTerminalText(page, secondCodexAgentId)).toContain('SECOND_CODEX_SENTINEL')
        await expect.poll(async () => await visibleTerminalText(page, secondCodexAgentId)).not.toContain('FIRST_CODEX_SENTINEL')
      })

      await scenario('background output to a parked following terminal clears unread once latest output is visible', async () => {
        await selectAgent(page, bashAgentId)
        await page.evaluate(async id => window.__farmingTerminalTest?.resumeLive(id), bashAgentId)
        await page.waitForFunction(
          id => Boolean(window.__farmingTerminalTest?.isReady(id)),
          bashAgentId,
          { timeout: 15_000 },
        )
        await page.evaluate(async (id) => {
          await window.__farmingTerminalTest?.scrollToBottom(id)
        }, bashAgentId)
        expect((await terminalViewport(page, bashAgentId)).following).toBe(true)
        expect((await terminalViewport(page, bashAgentId)).hasUnreadOutput).toBe(false)

        await sendActiveTerminalCommand(
          page,
          bashAgentId,
          'sleep 2; printf "PARKED_FOLLOWING_UNREAD_OUTPUT\\n"',
        )

        await selectAgent(page, codexAgentId)
        await expect.poll(async () => {
          const diagnostics = await terminalHostDiagnostics(page)
          const bashHost = diagnostics.find(host => host.agentId === bashAgentId)
          return bashHost
            ? { parked: bashHost.inParkingLot, attached: bashHost.recordAttached }
            : null
        }).toEqual({ parked: true, attached: false })
        await expect.poll(async () => {
          const response = await page.request.get(`/farming/api/control/agents/${bashAgentId}/output?tail=2000`)
          return response.ok() ? await response.text() : ''
        }, { timeout: 10_000 }).toContain('PARKED_FOLLOWING_UNREAD_OUTPUT')
        await expect.poll(async () => await terminalViewport(page, bashAgentId))
          .toEqual(expect.objectContaining({ following: false, hasUnreadOutput: true }))

        await selectAgent(page, bashAgentId)
        await expect.poll(async () => await visibleTerminalText(page, bashAgentId)).toContain('PARKED_FOLLOWING_UNREAD_OUTPUT')
        await expect.poll(async () => (await terminalViewport(page, bashAgentId)).hasUnreadOutput).toBe(false)
        await expect(page.getByTestId('code-terminal-jump-bottom')).toHaveCount(0)
      })

      await scenario('only one terminal host is visible in a single-pane terminal grid', async () => {
        const diagnostics = await terminalHostDiagnostics(page)
        expect(diagnostics.filter(host => host.visible && !host.inParkingLot)).toHaveLength(1)
        expect(diagnostics.filter(host => !host.visible || host.inParkingLot).length).toBeGreaterThanOrEqual(1)
        expect(diagnostics.filter(host => host.inParkingLot).every(host => !host.recordAttached && !host.attachedMountMatchesParent)).toBe(true)
        expect(diagnostics.filter(host => host.visible && !host.inParkingLot).every(host => host.recordAttached && host.attachedMountMatchesParent)).toBe(true)
      })

      await scenario('parked terminal resize events do not resize the backend PTY', async () => {
        await selectAgent(page, bashAgentId)
        await selectAgent(page, codexAgentId)
        await expect.poll(async () => {
          const diagnostics = await terminalHostDiagnostics(page)
          const bashHost = diagnostics.find(host => host.agentId === bashAgentId)
          return bashHost
            ? { parked: bashHost.inParkingLot, attached: bashHost.recordAttached }
            : null
        }).toEqual({ parked: true, attached: false })
        const beforeCount = await page.evaluate((id) => window.__farmingTerminalTest?.getResizeNotificationCount(id) ?? 0, bashAgentId)
        const afterCount = await page.evaluate((id) => window.__farmingTerminalTest?.notifyResizeForTest(id, 121, 33) ?? 0, bashAgentId)
        expect(afterCount).toBe(beforeCount)
      })

      await scenario('paste events on a parked terminal host do not reach the inactive PTY', async () => {
        await selectAgent(page, bashAgentId)
        const inputCountBeforePaste = await page.evaluate((id) => window.__farmingTerminalTest?.getInputCount(id) ?? 0, bashAgentId)
        await selectAgent(page, codexAgentId)
        await page.evaluate((id) => {
          const host = document.querySelector(`.terminal-session-host[data-agent-id="${CSS.escape(id)}"]`)
          const textarea = host?.querySelector('textarea')
          if (!(textarea instanceof HTMLTextAreaElement)) {
            throw new Error('parked terminal textarea is missing')
          }
          const data = new DataTransfer()
          data.setData('text/plain', 'SHOULD_NOT_REACH_PARKED_PTY')
          const pasteEvent = new ClipboardEvent('paste', {
            bubbles: true,
            cancelable: true,
            clipboardData: data,
          })
          textarea.dispatchEvent(pasteEvent)
        }, bashAgentId)
        const inputCountAfterPaste = await page.evaluate((id) => window.__farmingTerminalTest?.getInputCount(id) ?? 0, bashAgentId)
        expect(inputCountAfterPaste).toBe(inputCountBeforePaste)
        await expect.poll(async () => await visibleTerminalText(page, bashAgentId)).not.toContain('SHOULD_NOT_REACH_PARKED_PTY')
      })

    await scenario('active xterm paste events stay on the xterm native path without bracket leaks', async () => {
      await selectAgent(page, bashAgentId)
      const inputCountBeforePaste = await page.evaluate((id) => window.__farmingTerminalTest?.getInputCount(id) ?? 0, bashAgentId)
      await page.evaluate((id) => {
        return window.__farmingTerminalTest?.dispatchPasteToTextarea(id, "printf 'XTERM_NATIVE_PASTE_OK\\n'\r") ?? { prevented: true }
      }, bashAgentId)
      await expect.poll(async () => page.evaluate((id) => window.__farmingTerminalTest?.getInputCount(id) ?? 0, bashAgentId))
        .toBeGreaterThan(inputCountBeforePaste)
      await expect.poll(async () => await visibleTerminalText(page, bashAgentId)).toContain('XTERM_NATIVE_PASTE_OK')
      await expect.poll(async () => await visibleTerminalText(page, bashAgentId)).not.toContain('201~')
      await expect.poll(async () => await visibleTerminalText(page, bashAgentId)).not.toContain('200~')
    })

    await scenario('focus and typing route to the active terminal only', async () => {
      await selectAgent(page, bashAgentId)
      await page.waitForTimeout(1600)
      await page.getByTestId('code-composer').locator('textarea').fill('echo ACTIVE_BASH_ONLY')
      await page.getByTestId('code-composer-send').click()
      await expect.poll(async () => await visibleTerminalText(page, bashAgentId)).toContain('ACTIVE_BASH_ONLY')
      await selectAgent(page, codexAgentId)
      await expect.poll(async () => await visibleTerminalText(page, codexAgentId)).not.toContain('ACTIVE_BASH_ONLY')
    })

    await scenario('composer focus keeps the terminal find shortcut from stealing focus', async () => {
      await selectAgent(page, bashAgentId)
      const composer = page.getByTestId('code-composer').locator('textarea')
      await composer.fill('draft before terminal find')
      await composer.focus()
      await page.keyboard.press(terminalFindShortcut)
      await expect(page.getByTestId('code-terminal-search')).toHaveCount(0)
      await expect(composer).toBeFocused()
    })

    await scenario('composer focus hides the inactive terminal outline cursor', async () => {
      await selectAgent(page, bashAgentId)
      const composer = page.getByTestId('code-composer').locator('textarea')
      await composer.fill('draft while terminal cursor is inactive')
      await composer.focus()
      await expect(composer).toBeFocused()
      await expect.poll(async () => {
        return page.evaluate((id) => {
          const host = Array.from(document.querySelectorAll('.terminal-session-host')).find(element => {
            if (!(element instanceof HTMLElement)) return false
            if (element.closest('#terminal-session-parking-lot')) return false
            const rect = element.getBoundingClientRect()
            return rect.width > 0 && rect.height > 0
          })
          return {
            activeInComposer: Boolean(document.activeElement?.closest?.('.code-composer')),
            renderer: window.__farmingTerminalTest?.getBufferDiagnostics(id)?.renderer ?? '',
            cursorVisible: window.__farmingTerminalTest?.getCursor(id)?.visible ?? true,
            domCursorCount: host?.querySelectorAll('.xterm-cursor').length ?? 0,
          }
        }, bashAgentId)
      }).toEqual({
        activeInComposer: true,
        renderer: 'webgl',
        cursorVisible: false,
        domCursorCount: 0,
      })
    })

    await scenario('terminal focus still opens terminal find', async () => {
      const cell = await cellForText(page, bashAgentId, 'ACTIVE_BASH_ONLY', 4)
      await page.mouse.click(cell.x, cell.y)
      await page.keyboard.press(terminalFindShortcut)
      await expect(page.getByTestId('code-terminal-search')).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(page.getByTestId('code-terminal-search')).toHaveCount(0)
    })

    await scenario('terminal find pre-fills the current selection like VS Code', async () => {
      await writeTerminalFixture(page, bashAgentId, 'SELECTED_FIND_PREFILL first\r\nSELECTED_FIND_PREFILL second\r\n')
      const cell = await cellForText(page, bashAgentId, 'SELECTED_FIND_PREFILL first', 4)
      await page.mouse.dblclick(cell.x, cell.y)
      await expect.poll(async () => page.evaluate(id => window.__farmingTerminalTest?.getSelection(id) ?? '', bashAgentId))
        .toBe('SELECTED_FIND_PREFILL')
      const inputCountBeforeFind = await page.evaluate((id) => window.__farmingTerminalTest?.getInputCount(id) ?? 0, bashAgentId)
      await page.keyboard.press(terminalFindShortcut)
      const searchBox = page.getByTestId('code-terminal-search')
      const searchInput = page.getByTestId('code-terminal-search-input')
      await expect(searchBox).toBeVisible()
      await expect(searchInput).toHaveValue('SELECTED_FIND_PREFILL')
      await expect(searchBox.locator('.code-terminal-search-status')).toContainText('/2')
      const inputCountAfterFind = await page.evaluate((id) => window.__farmingTerminalTest?.getInputCount(id) ?? 0, bashAgentId)
      expect(inputCountAfterFind).toBe(inputCountBeforeFind)
      await page.keyboard.press('Escape')
      await expect(searchBox).toHaveCount(0)
    })

    await scenario('terminal find uses VS Code F3 shortcuts without sending input to the PTY', async () => {
      await writeTerminalFixture(page, bashAgentId, 'F3_FIND_TARGET first\r\nF3_FIND_TARGET second\r\n')
      const cell = await cellForText(page, bashAgentId, 'F3_FIND_TARGET first', 4)
      await page.mouse.click(cell.x, cell.y)
      await page.keyboard.press(terminalFindShortcut)
      const searchBox = page.getByTestId('code-terminal-search')
      const searchInput = page.getByTestId('code-terminal-search-input')
      await expect(searchBox).toBeVisible()
      await searchInput.fill('F3_FIND_TARGET')
      await expect(searchBox.locator('.code-terminal-search-status')).toContainText('/2')
      const inputCountBeforeFindNavigation = await page.evaluate((id) => window.__farmingTerminalTest?.getInputCount(id) ?? 0, bashAgentId)
      await page.keyboard.press('F3')
      await expect(searchBox.locator('.code-terminal-search-status')).toContainText('/2')
      await page.keyboard.press('Shift+F3')
      await expect(searchBox.locator('.code-terminal-search-status')).toContainText('/2')
      const inputCountAfterFindNavigation = await page.evaluate((id) => window.__farmingTerminalTest?.getInputCount(id) ?? 0, bashAgentId)
      expect(inputCountAfterFindNavigation).toBe(inputCountBeforeFindNavigation)
      await page.keyboard.press('Escape')
      await expect(searchBox).toHaveCount(0)
    })

    await scenario('terminal find supports VS Code-style case, word, and regex toggles', async () => {
      await writeTerminalFixture(page, bashAgentId, [
        'FindOption exact',
        'findoption lower',
        'FindOptionSuffix partial',
        'FindOption final',
        'REGEX123 marker',
        'REGEXabc marker',
        'REGEX456 marker',
      ].join('\r\n') + '\r\n')
      const cell = await cellForText(page, bashAgentId, 'FindOption exact', 4)
      await page.mouse.click(cell.x, cell.y)
      await page.keyboard.press(terminalFindShortcut)
      const searchBox = page.getByTestId('code-terminal-search')
      const searchInput = page.getByTestId('code-terminal-search-input')
      const searchStatus = searchBox.locator('.code-terminal-search-status')
      await expect(searchBox).toBeVisible()
      await searchInput.fill('FindOption')
      await expect(searchStatus).toContainText('/4')
      const inputCountBeforeOptions = await page.evaluate((id) => window.__farmingTerminalTest?.getInputCount(id) ?? 0, bashAgentId)

      const caseSensitive = page.getByTestId('code-terminal-search-case-sensitive')
      const wholeWord = page.getByTestId('code-terminal-search-whole-word')
      const regex = page.getByTestId('code-terminal-search-regex')
      await caseSensitive.click()
      await expect(caseSensitive).toHaveAttribute('aria-pressed', 'true')
      await expect(searchStatus).toContainText('/3')
      await wholeWord.click()
      await expect(wholeWord).toHaveAttribute('aria-pressed', 'true')
      await expect(searchStatus).toContainText('/2')

      await searchInput.fill('REGEX[0-9]+')
      await regex.click()
      await expect(regex).toHaveAttribute('aria-pressed', 'true')
      await expect(searchStatus).toContainText('/2')
      await searchInput.focus()
      await page.keyboard.press('Alt+C')
      await expect(caseSensitive).toHaveAttribute('aria-pressed', 'false')
      await expect(searchStatus).toContainText('/2')
      await page.keyboard.press('Alt+W')
      await expect(wholeWord).toHaveAttribute('aria-pressed', 'false')
      await expect(searchStatus).toContainText('/2')
      await page.keyboard.press('Alt+R')
      await expect(regex).toHaveAttribute('aria-pressed', 'false')
      await expect(searchStatus).toContainText(/No results|无结果/)
      const inputCountAfterOptions = await page.evaluate((id) => window.__farmingTerminalTest?.getInputCount(id) ?? 0, bashAgentId)
      expect(inputCountAfterOptions).toBe(inputCountBeforeOptions)
      await page.keyboard.press('Escape')
      await expect(searchBox).toHaveCount(0)
      await page.keyboard.press(terminalFindShortcut)
      await expect(searchBox).toBeVisible()
      await expect(searchInput).toHaveValue('REGEX[0-9]+')
      await page.keyboard.press('Escape')
      await expect(searchBox).toHaveCount(0)
    })

    await scenario('copy menu disappears after copy action', async () => {
      await selectAgent(page, bashAgentId)
      await writeTerminalFixture(page, bashAgentId, 'ACTIVE_BASH_ONLY\r\n')
      const cell = await cellForExactRowText(page, bashAgentId, 'ACTIVE_BASH_ONLY', 4)
      await page.mouse.dblclick(cell.x, cell.y)
      await page.mouse.click(cell.x, cell.y, { button: 'right' })
      await expect(page.getByTestId('code-terminal-context-menu')).toBeVisible()
      await page.getByTestId('code-terminal-context-menu').getByRole('menuitem', { name: /Copy|复制/ }).click()
      await expect(page.getByTestId('code-terminal-context-menu')).toHaveCount(0)
    })

    await scenario('delayed copy completion does not refocus a parked terminal host', async () => {
      await installDelayedClipboardProbe(page)
      await selectAgent(page, bashAgentId)
      await writeTerminalFixture(page, bashAgentId, 'ACTIVE_BASH_ONLY\r\n')
      const cell = await cellForExactRowText(page, bashAgentId, 'ACTIVE_BASH_ONLY', 4)
      await page.mouse.dblclick(cell.x, cell.y)
      await page.mouse.click(cell.x, cell.y, { button: 'right' })
      await expect(page.getByTestId('code-terminal-context-menu')).toBeVisible()
      await page.getByTestId('code-terminal-context-menu').getByRole('menuitem', { name: /Copy|复制/ }).click()
      await selectAgent(page, codexAgentId)
      // Establish the focus invariant before completing the old clipboard
      // promise. This scenario proves that the late callback cannot steal
      // focus; Agent-switch autofocus is covered independently.
      await page.locator(`${activeTerminalHostSelector(codexAgentId)} textarea`).focus()
      await expectActiveTerminalFocus(page, codexAgentId)
      await page.evaluate(() => {
        const target = window as unknown as { __resolveClipboardWrite?: () => void }
        target.__resolveClipboardWrite?.()
      })
      await expect.poll(async () => page.evaluate(() => navigator.clipboard.readText())).toBe('ACTIVE_BASH_ONLY')
      await expectActiveTerminalFocus(page, codexAgentId)
      await installClipboardProbe(page)
    })

    await scenario('terminal viewport reports follow mode after active command input', async () => {
      const viewport = await terminalViewport(page, bashAgentId)
      expect(viewport.following).toBe(true)
      expect(viewport.hasUnreadOutput).toBe(false)
    })

      await scenario('shared workspace keeps all live agents in one project group', async () => {
        const project = page.getByTestId('code-project-group').filter({ hasText: 'matrix-project' })
        await expect(project).toHaveCount(1)
        const showMore = project.getByTestId('code-agent-show-more')
        if (await showMore.isVisible().catch(() => false)) await showMore.click()
        await expect(project.locator('[data-testid="code-agent-row"], [data-testid="code-project-agent-compact"], [data-testid="code-pinned-agent-compact"]')).toHaveCount(8)
      })

    await scenario('active agent row returns from Open Editors back to its terminal', async () => {
      const openEditors = page.getByTestId('code-open-editors')
      const title = openEditors.locator('.code-open-editors-title')
      if (await title.getAttribute('aria-expanded') !== 'true') {
        await title.click()
      }
      await openEditors.getByTestId('code-open-editor-row').filter({ hasText: 'README.md' }).getByRole('button').first().click()
      await expect(page.getByTestId('code-file-editor')).toBeVisible()
      await selectAgent(page, bashAgentId)
      await expect(page.locator(`[data-testid="code-terminal-pane"][data-agent-id="${bashAgentId}"]`)).toBeVisible()
    })

    await scenario('Escape closes terminal copy menu and leaves the terminal usable', async () => {
      await writeTerminalFixture(page, bashAgentId, 'ESCAPE_MENU_WORD\r\n')
      const cell = await cellForText(page, bashAgentId, 'ESCAPE_MENU_WORD', 4)
      await page.mouse.dblclick(cell.x, cell.y)
      await page.mouse.click(cell.x, cell.y, { button: 'right' })
      await expect(page.getByTestId('code-terminal-context-menu')).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(page.getByTestId('code-terminal-context-menu')).toHaveCount(0)
      await writeTerminalRaw(page, bashAgentId, 'AFTER_ESCAPE_OUTPUT_OK\r\n')
      await expect.poll(async () => await visibleTerminalText(page, bashAgentId)).toContain('AFTER_ESCAPE_OUTPUT_OK')
    })

    await scenario('terminal accepts new output after editor and copy-menu round trips', async () => {
      await writeTerminalRaw(page, bashAgentId, 'ROUNDTRIP_OUTPUT_OK\r\n')
      await expect.poll(async () => await visibleTerminalText(page, bashAgentId)).toContain('ROUNDTRIP_OUTPUT_OK')
    })

    await scenario('no horizontal page drift after all desktop interactions', async () => {
      const metrics = await page.evaluate(() => {
        const workspace = document.querySelector('[data-testid="code-workspace"]') as HTMLElement | null
        return {
          windowScrollX: window.scrollX,
          documentScrollLeft: document.documentElement.scrollLeft,
          workspaceClientWidth: workspace?.clientWidth ?? 0,
          workspaceScrollWidth: workspace?.scrollWidth ?? 0,
        }
      })
      expect(metrics.windowScrollX).toBe(0)
      expect(metrics.documentScrollLeft).toBe(0)
      expect(metrics.workspaceScrollWidth).toBeLessThanOrEqual(metrics.workspaceClientWidth + 1)
    })

    await scenario('desktop matrix scenario count reaches at least 30 executed cases', async () => {
      expect(checked.length + 1).toBeGreaterThanOrEqual(30)
    })

    await restoreWindowOpenProbe(page)
    console.log(`terminal regression matrix executed ${checked.length} scenarios`)
  })

  test('page resume replaces buffered terminal history with one latest snapshot', async ({ page, workspaceRoot }) => {
    const projectDir = path.join(workspaceRoot, 'page-resume-terminal')
    fs.mkdirSync(projectDir, { recursive: true })
    await cleanupControlAgents(page.request)
    const agentId = await createControlAgent(page, 'bash', projectDir)

    try {
      await openFarming(page)
      await selectAgent(page, agentId)
      await page.waitForFunction(id => Boolean(window.__farmingTerminalTest?.isReady(id)), agentId)
      const initialState = await page.evaluate((id) => {
        const diagnostics = window.__farmingTerminalTest?.getBufferDiagnostics?.(id)
        return {
          cols: diagnostics?.cols ?? 80,
          rows: diagnostics?.rows ?? 24,
          runtimeEpoch: window.__farmingTerminalTest?.getRuntimeEpoch(id) ?? '',
          outputSeq: window.__farmingTerminalTest?.getLastOutputSeq(id) ?? 0,
          stateRevision: window.__farmingTerminalTest?.getStateRevision(id) ?? 0,
        }
      }, agentId)

      const latestOutput = [
        '[agent@example-host /srv/example/projects/page-resume-terminal]',
        '$ latest after page resume',
        'LATEST_PAGE_RESUME_SCREEN',
        '$  ',
      ].join('\n')
      const runtimeEpoch = initialState.runtimeEpoch
      const checkpointOutputSeq = initialState.outputSeq + 100
      const checkpointStateRevision = initialState.stateRevision + 100
      const sessionViewRoute = new RegExp(`/farming/api/agents/${agentId}/session-view$`)
      let snapshotRequests = 0
      const handler = async (route: import('@playwright/test').Route) => {
        snapshotRequests += 1
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            session: {
              runtimeEpoch,
              output: latestOutput,
              renderOutput: latestOutput,
              outputSeq: checkpointOutputSeq,
              stateRevision: checkpointStateRevision,
              previewCols: initialState.cols,
              previewRows: initialState.rows,
              previewSnapshot: snapshotFromRows(latestOutput.split('\n'), 100, 3, 3),
            },
          }),
        })
      }
      await page.route(sessionViewRoute, handler)
      try {
        await page.evaluate(() => window.dispatchEvent(new Event('pagehide')))
        await page.evaluate(async ({ id, epoch, outputSeq, stateRevision }) => {
          for (let offset = 1; offset <= 100; offset += 1) {
            await window.__farmingTerminalTest?.streamSequenced(
              id,
              `BUFFERED_HISTORY_${offset}\r\n`,
              outputSeq + offset,
              epoch,
              stateRevision + offset,
            )
          }
        }, {
          id: agentId,
          epoch: runtimeEpoch,
          outputSeq: initialState.outputSeq,
          stateRevision: initialState.stateRevision,
        })
        expect(await visibleTerminalText(page, agentId)).not.toContain('BUFFERED_HISTORY_')

        await page.evaluate(() => window.dispatchEvent(new Event('pageshow')))
        await expect.poll(() => snapshotRequests, { timeout: 5000 }).toBeGreaterThan(0)
        await expect.poll(async () => await visibleTerminalText(page, agentId), { timeout: 5000 })
          .toContain('LATEST_PAGE_RESUME_SCREEN')
        expect(await visibleTerminalText(page, agentId)).not.toContain('BUFFERED_HISTORY_')
        await expect.poll(async () => page.evaluate((id) => (
          window.__farmingTerminalTest?.getLastOutputSeq(id) ?? null
        ), agentId)).toBe(checkpointOutputSeq)
      } finally {
        await page.unroute(sessionViewRoute, handler)
      }
    } finally {
      await cleanupControlAgents(page.request)
    }
  })

  test('page resume installs the real authoritative checkpoint after missing live output', async ({ page, workspaceRoot }) => {
    const projectDir = path.join(workspaceRoot, 'real-page-resume-terminal')
    fs.mkdirSync(projectDir, { recursive: true })
    await cleanupControlAgents(page.request)
    const agentId = await createControlAgent(page, 'bash', projectDir)

    try {
      await openFarming(page)
      await selectAgent(page, agentId)
      await page.waitForFunction(
        id => Boolean(window.__farmingTerminalTest?.isReady(id)),
        agentId,
        { timeout: 15_000 },
      )
      const checkpointFetchCountBefore = Number(
        (await terminalDiagnostics(page, agentId))?.checkpointFetchCount || 0,
      )

      await page.evaluate(() => window.dispatchEvent(new Event('pagehide')))
      await expect.poll(async () => (
        await terminalDiagnostics(page, agentId)
      )?.pageOutputSuspended).toBe(true)

      let inputAccepted = false
      for (let attempt = 0; attempt < 20 && !inputAccepted; attempt += 1) {
        const response = await page.request.post(
          `/farming/api/control/agents/${agentId}/input`,
          { data: { input: 'printf "REAL_MISSED_RESUME_OUTPUT\\n"\r' } },
        )
        inputAccepted = response.ok()
        if (!inputAccepted) await page.waitForTimeout(50)
      }
      expect(inputAccepted).toBe(true)

      await expect.poll(async () => {
        const response = await page.request.get(`/farming/api/agents/${agentId}/session-view`)
        const payload = await response.json() as { session?: { renderOutput?: string } }
        return payload.session?.renderOutput || ''
      }).toContain('REAL_MISSED_RESUME_OUTPUT')

      await page.evaluate(() => window.dispatchEvent(new Event('farming:backend-connected')))
      await page.evaluate(() => window.dispatchEvent(new Event('pageshow')))
      await expect.poll(async () => await visibleTerminalText(page, agentId), { timeout: 15_000 })
        .toContain('REAL_MISSED_RESUME_OUTPUT')

      const diagnostics = await terminalDiagnostics(page, agentId)
      expect(Number(diagnostics?.checkpointFetchCount || 0) - checkpointFetchCountBefore)
        .toBeLessThanOrEqual(2)
      expect(diagnostics?.needsReconnectOutputSync).toBe(false)
      expect(diagnostics?.checkpointRequestInFlight).toBe(false)
    } finally {
      await cleanupControlAgents(page.request)
    }
  })

  test('page resume restarts an aborted initial checkpoint without manual reattach', async ({ page, workspaceRoot }) => {
    const projectDir = path.join(workspaceRoot, 'aborted-bootstrap-resume-terminal')
    fs.mkdirSync(projectDir, { recursive: true })
    await cleanupControlAgents(page.request)
    const agentId = await createControlAgent(page, 'bash', projectDir)
    const sessionViewRoute = new RegExp(`/farming/api/agents/${agentId}/session-view$`)
    let requestCount = 0
    let observeFirstRequest!: () => void
    let releaseFirstRequest!: () => void
    const firstRequestObserved = new Promise<void>(resolve => { observeFirstRequest = resolve })
    const firstRequestRelease = new Promise<void>(resolve => { releaseFirstRequest = resolve })
    const handler = async (route: import('@playwright/test').Route) => {
      requestCount += 1
      if (requestCount === 1) {
        observeFirstRequest()
        await firstRequestRelease
        await route.abort('aborted')
        return
      }
      await route.continue()
    }
    await page.route(sessionViewRoute, handler)

    try {
      await openFarming(page)
      const selecting = selectAgent(page, agentId)
      await firstRequestObserved
      await page.evaluate(() => window.dispatchEvent(new Event('pagehide')))
      await expect.poll(async () => (
        await terminalDiagnostics(page, agentId)
      )?.pageOutputSuspended).toBe(true)
      releaseFirstRequest()

      let inputAccepted = false
      for (let attempt = 0; attempt < 20 && !inputAccepted; attempt += 1) {
        const response = await page.request.post(
          `/farming/api/control/agents/${agentId}/input`,
          { data: { input: 'printf "ABORTED_BOOTSTRAP_RESUME_OUTPUT\\n"\r' } },
        )
        inputAccepted = response.ok()
        if (!inputAccepted) await page.waitForTimeout(50)
      }
      expect(inputAccepted).toBe(true)
      await expect.poll(async () => {
        const response = await page.request.get(`/farming/api/agents/${agentId}/session-view`)
        const payload = await response.json() as { session?: { renderOutput?: string } }
        return payload.session?.renderOutput || ''
      }).toContain('ABORTED_BOOTSTRAP_RESUME_OUTPUT')

      await page.evaluate(() => window.dispatchEvent(new Event('pageshow')))
      await selecting
      await page.waitForFunction(
        id => Boolean(window.__farmingTerminalTest?.isReady(id)),
        agentId,
        { timeout: 15_000 },
      )
      await expect.poll(async () => await visibleTerminalText(page, agentId), { timeout: 15_000 })
        .toContain('ABORTED_BOOTSTRAP_RESUME_OUTPUT')
      expect(requestCount).toBe(2)
    } finally {
      releaseFirstRequest()
      await page.unroute(sessionViewRoute, handler)
      await cleanupControlAgents(page.request)
    }
  })

  test('terminal checkpoint repairs a missing output sequence before later deltas render', async ({ page, workspaceRoot }) => {
    const projectDir = path.join(workspaceRoot, 'checkpoint-gap-terminal')
    fs.mkdirSync(projectDir, { recursive: true })
    await cleanupControlAgents(page.request)
    const agentId = await createControlAgent(page, 'bash', projectDir)

    try {
      await openFarming(page)
      await selectAgent(page, agentId)
      await page.waitForFunction(id => Boolean(window.__farmingTerminalTest?.isReady(id)), agentId)
      const checkpoint = await page.evaluate((id) => ({
        outputSeq: window.__farmingTerminalTest?.getLastOutputSeq(id) ?? null,
        runtimeEpoch: window.__farmingTerminalTest?.getRuntimeEpoch(id) ?? '',
        stateRevision: window.__farmingTerminalTest?.getStateRevision(id) ?? null,
        dimensions: (() => {
          const diagnostics = window.__farmingTerminalTest?.getBufferDiagnostics?.(id)
          return {
            cols: diagnostics?.cols ?? 80,
            rows: diagnostics?.rows ?? 24,
          }
        })(),
      }), agentId)
      expect(checkpoint.outputSeq).not.toBeNull()
      expect(checkpoint.runtimeEpoch).not.toBe('')
      expect(checkpoint.stateRevision).not.toBeNull()
      const baseSeq = checkpoint.outputSeq as number
      const baseRevision = checkpoint.stateRevision as number
      const runtimeEpoch = checkpoint.runtimeEpoch

      const contiguousCut = await page.evaluate(async ({ id, epoch }) => {
        const outputSeq = window.__farmingTerminalTest?.getLastOutputSeq(id) ?? 0
        const stateRevision = window.__farmingTerminalTest?.getStateRevision(id) ?? 0
        await window.__farmingTerminalTest?.streamSequenced(
          id,
          'DELTA_CONTIGUOUS\r\n',
          outputSeq + 1,
          epoch,
          stateRevision + 1,
        )
        return { outputSeq: outputSeq + 1, stateRevision: stateRevision + 1 }
      }, { id: agentId, epoch: runtimeEpoch })
      try {
        await expect.poll(async () => page.evaluate(id => ({
          outputSeq: window.__farmingTerminalTest?.getLastOutputSeq(id) ?? 0,
          stateRevision: window.__farmingTerminalTest?.getStateRevision(id) ?? 0,
        }), agentId)).toEqual(contiguousCut)
        await expect.poll(async () => await visibleTerminalText(page, agentId)).toContain('DELTA_CONTIGUOUS')
      } catch (error) {
        throw new Error(
          `Contiguous delta did not commit: ${JSON.stringify(await terminalDiagnostics(page, agentId))}`,
          { cause: error },
        )
      }

      const checkpointSeq = baseSeq + 3
      const checkpointRevision = baseRevision + 3
      const checkpointLabel = `CHECKPOINT_${checkpointRevision}`
      const sessionViewRoute = new RegExp(`/farming/api/agents/${agentId}/session-view$`)
      let snapshotRequests = 0
      const handler = async (route: import('@playwright/test').Route) => {
        snapshotRequests += 1
        const output = `${checkpointLabel}\r\n$ `
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            session: {
              runtimeEpoch,
              output,
              renderOutput: output,
              outputSeq: checkpointSeq,
              stateRevision: checkpointRevision,
              previewCols: checkpoint.dimensions.cols,
              previewRows: checkpoint.dimensions.rows,
              previewSnapshot: snapshotFromRows([checkpointLabel, '$ '], 100, 1, 2),
            },
          }),
        })
      }
      await page.route(sessionViewRoute, handler)
      try {
        await page.evaluate(async ({ id, epoch, outputSeq, stateRevision }) => {
          await window.__farmingTerminalTest?.streamSequenced(
            id,
            'UNPROVEN_GAP_DELTA\r\n',
            outputSeq,
            epoch,
            stateRevision,
          )
        }, {
          id: agentId,
          epoch: runtimeEpoch,
          outputSeq: checkpointSeq,
          stateRevision: checkpointRevision,
        })

        await expect.poll(() => snapshotRequests).toBeGreaterThan(0)
        await expect.poll(async () => await visibleTerminalText(page, agentId)).toContain(checkpointLabel)
        expect(await visibleTerminalText(page, agentId)).not.toContain('UNPROVEN_GAP_DELTA')
        await expect.poll(async () => page.evaluate((id) => (
          window.__farmingTerminalTest?.getLastOutputSeq(id) ?? null
        ), agentId)).toBe(checkpointSeq)

        await page.evaluate(async ({ id, epoch, outputSeq, stateRevision }) => {
          await window.__farmingTerminalTest?.streamSequenced(
            id,
            'DELTA_AFTER_CHECKPOINT\r\n',
            outputSeq + 1,
            epoch,
            stateRevision + 1,
          )
        }, {
          id: agentId,
          epoch: runtimeEpoch,
          outputSeq: checkpointSeq,
          stateRevision: checkpointRevision,
        })
        await expect.poll(async () => await visibleTerminalText(page, agentId)).toContain('DELTA_AFTER_CHECKPOINT')
      } finally {
        await page.unroute(sessionViewRoute, handler)
      }
    } finally {
      await cleanupControlAgents(page.request)
    }
  })

  test.describe('touch mobile terminal regression', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

    test('covers mobile terminal gestures, copy, and page stability scenarios', async ({ page, workspaceRoot }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    const checked: string[] = []
    const scenario: ScenarioRunner = async (name, fn) => {
      await test.step(`${String(checked.length + 1).padStart(2, '0')} mobile ${name}`, async () => {
        await fn()
        checked.push(name)
      })
    }

    const mobileDir = path.join(workspaceRoot, 'mobile-matrix')
    fs.mkdirSync(mobileDir, { recursive: true })
    const agentId = await createControlAgent(page, 'bash', mobileDir)
    await openFarming(page)
    await installClipboardProbe(page)
    await selectAgent(page, agentId)

    await scenario('mobile terminal uses the required WebGL renderer', async () => {
      await expect(page.locator(`[data-agent-id="${agentId}"] .xterm`)).toBeVisible()
      await expect.poll(() => page.evaluate(
        id => window.__farmingTerminalTest?.getBufferDiagnostics(id)?.renderer,
        agentId,
      )).toBe('webgl')
      await expect.poll(() => page.locator(`[data-agent-id="${agentId}"] canvas`).count())
        .toBeGreaterThan(0)
    })

    await scenario('mobile prompt starts at the top of the terminal viewport', async () => {
      await expect.poll(async () => (await visibleTerminalText(page, agentId, 20)).trim().length, { timeout: 15_000 }).toBeGreaterThan(0)
      const rows = await terminalRows(page, agentId, 20)
      expect(rows.findIndex(row => row.trim())).toBeLessThanOrEqual(1)
    })

    await scenario('mobile long output creates terminal scrollback', async () => {
      const output = Array.from({ length: 180 }, (_, index) => `mobile-matrix-line-${String(index).padStart(3, '0')}`).join('\r\n')
      await writeTerminalRaw(page, agentId, `${output}\r\n`)
      await expect.poll(async () => (await terminalViewport(page, agentId)).scrollbackLength)
        .toBeGreaterThan(0)
    })

    await scenario('mobile drag scrolls the terminal rather than the document', async () => {
      const result = await page.evaluate(async (id) => {
        const host = document.querySelector(`.terminal-session-host[data-agent-id="${CSS.escape(id)}"]`)
        const terminalSurface = host?.querySelector('.xterm-screen, canvas')
        const workspace = document.querySelector('[data-testid="code-workspace"]') as HTMLElement | null
        if (!(host instanceof HTMLElement) || !(terminalSurface instanceof HTMLElement) || !workspace) {
          throw new Error('Mobile terminal surface is missing')
        }
        const rect = terminalSurface.getBoundingClientRect()
        const pointerId = 9001
        const x = rect.left + rect.width / 2
        const startY = rect.top + rect.height * 0.4
        const dispatch = (type: string, y: number) => terminalSurface.dispatchEvent(new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          pointerId,
          pointerType: 'touch',
          isPrimary: true,
          clientX: x,
          clientY: y,
        }))
        const before = window.__farmingTerminalTest?.getViewport(id)
        dispatch('pointerdown', startY)
        for (let step = 1; step <= 8; step += 1) dispatch('pointermove', startY + step * 18)
        dispatch('pointerup', startY + 8 * 18)
        const afterRelease = window.__farmingTerminalTest?.getViewport(id)
        await new Promise<void>(resolve => setTimeout(resolve, 360))
        const afterMomentum = window.__farmingTerminalTest?.getViewport(id)
        return {
          before,
          afterRelease,
          afterMomentum,
          windowScrollX: window.scrollX,
          windowScrollY: window.scrollY,
          documentScrollLeft: document.documentElement.scrollLeft,
          documentScrollTop: document.documentElement.scrollTop,
          workspaceClientWidth: workspace.clientWidth,
          workspaceScrollWidth: workspace.scrollWidth,
          terminalTouchAction: getComputedStyle(host).touchAction,
        }
      }, agentId)
      expect(result.afterRelease?.viewportY ?? 0).toBeGreaterThan(result.before?.viewportY ?? 0)
      if ((result.afterRelease?.scrollbackLength ?? 0) - (result.afterRelease?.viewportY ?? 0) > 1) {
        expect(result.afterMomentum?.viewportY ?? 0).toBeGreaterThan(result.afterRelease?.viewportY ?? 0)
      }
      expect(result.windowScrollX).toBe(0)
      expect(result.windowScrollY).toBe(0)
      expect(result.documentScrollLeft).toBe(0)
      expect(result.documentScrollTop).toBe(0)
      expect(result.workspaceScrollWidth).toBeLessThanOrEqual(result.workspaceClientWidth + 1)
      expect(result.terminalTouchAction).toBe('pan-y')
    })

    await scenario('mobile terminal can jump back to latest output', async () => {
      await page.getByTestId('code-terminal-jump-bottom').click()
      await expect.poll(async () => (await terminalViewport(page, agentId)).following).toBe(true)
    })

    await scenario('mobile long press opens copy menu for a word', async () => {
      await writeTerminalRaw(page, agentId, 'mobile-matrix-copy\r\n')
      const cell = await cellForText(page, agentId, 'mobile-matrix-copy', 3)
      await page.evaluate(({ id, x, y }) => {
        const target = document.querySelector(`.terminal-session-host[data-agent-id="${CSS.escape(id)}"]`)
        if (!target) throw new Error('Mobile target missing')
        target.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          button: 2,
          clientX: x,
          clientY: y,
        }))
      }, { id: agentId, ...cell })
      await expect(page.getByTestId('code-terminal-context-menu')).toBeVisible()
    })

    await scenario('mobile copy menu writes selected text to clipboard', async () => {
      await page.getByTestId('code-terminal-context-menu').getByRole('menuitem', { name: /Copy|复制/ }).click()
      await expect.poll(async () => page.evaluate(() => navigator.clipboard.readText())).toBe('mobile-matrix-copy')
    })

    await scenario('mobile composer remains usable after terminal copy', async () => {
      const composer = page.getByTestId('code-composer-input')
      const terminalStatus = page.getByTestId('code-terminal-status-card')
      await expect(terminalStatus).toHaveCount(0)
      await composer.fill('echo MOBILE_AFTER_COPY')
      await page.getByTestId('code-composer-send').click()
      await page.waitForTimeout(100)
      if (await terminalStatus.isVisible().catch(() => false)) {
        const diagnostics = await terminalDiagnostics(page, agentId)
        throw new Error(
          `Mobile composer terminal input failed: ${await terminalStatus.getAttribute('title')}; `
          + `diagnostics=${JSON.stringify(diagnostics)}`,
        )
      }
      await expect.poll(async () => await visibleTerminalText(page, agentId)).toContain('MOBILE_AFTER_COPY')
    })

    await scenario('mobile scenario count reaches at least 8 executed cases', async () => {
      expect(checked.length + 1).toBeGreaterThanOrEqual(8)
    })

      console.log(`mobile terminal regression matrix executed ${checked.length} scenarios`)
    })
  })

  test('pins the coarse mobile shell to the visual viewport during repeated touch drags', async ({ browser, baseURL, workspaceRoot }) => {
    const context = await browser.newContext({
      baseURL,
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 3,
    })
    const page = await context.newPage()
    await page.addInitScript(() => {
      window.__FARMING_E2E__ = true
      Object.defineProperty(Navigator.prototype, 'maxTouchPoints', {
        configurable: true,
        get: () => 1,
      })
    })

    const mobileDir = path.join(workspaceRoot, 'coarse-mobile-shell')
    fs.mkdirSync(mobileDir, { recursive: true })

    const shellMetrics = async () => page.evaluate(() => {
      const rectFor = (selector: string) => {
        const element = document.querySelector(selector)
        if (!(element instanceof HTMLElement)) return null
        const rect = element.getBoundingClientRect()
        return {
          left: Math.round(rect.left),
          top: Math.round(rect.top),
          right: Math.round(rect.right),
          bottom: Math.round(rect.bottom),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        }
      }
      const workspace = document.querySelector('[data-testid="code-workspace"]') as HTMLElement | null
      const columns = workspace ? getComputedStyle(workspace).gridTemplateColumns.split(' ').filter(Boolean) : []
      return {
        viewport: {
          width: Math.round(window.visualViewport?.width ?? window.innerWidth),
          height: Math.round(window.visualViewport?.height ?? window.innerHeight),
        },
        windowScrollX: window.scrollX,
        windowScrollY: window.scrollY,
        documentScrollLeft: document.documentElement.scrollLeft,
        documentScrollTop: document.documentElement.scrollTop,
        documentClientWidth: document.documentElement.clientWidth,
        documentScrollWidth: document.documentElement.scrollWidth,
        bodyClientWidth: document.body.clientWidth,
        bodyScrollWidth: document.body.scrollWidth,
        workspaceClientWidth: workspace?.clientWidth ?? 0,
        workspaceScrollWidth: workspace?.scrollWidth ?? 0,
        gridTemplateColumnCount: columns.length,
        app: rectFor('[data-testid="app-shell"]'),
        workspace: rectFor('[data-testid="code-workspace"]'),
        main: rectFor('[data-testid="code-main"]'),
        terminalGrid: rectFor('[data-testid="code-terminal-grid"]'),
      }
    })

    const expectPinnedShell = async () => {
      const metrics = await shellMetrics()
      expect(metrics.windowScrollX).toBe(0)
      expect(metrics.windowScrollY).toBe(0)
      expect(metrics.documentScrollLeft).toBe(0)
      expect(metrics.documentScrollTop).toBe(0)
      expect(metrics.documentScrollWidth).toBeLessThanOrEqual(metrics.documentClientWidth + 1)
      expect(metrics.bodyScrollWidth).toBeLessThanOrEqual(metrics.bodyClientWidth + 1)
      expect(metrics.workspaceScrollWidth).toBeLessThanOrEqual(metrics.workspaceClientWidth + 1)
      expect(metrics.gridTemplateColumnCount).toBe(1)
      for (const rect of [metrics.app, metrics.workspace, metrics.main, metrics.terminalGrid]) {
        expect(rect).toBeTruthy()
        expect(rect?.left ?? 0).toBeGreaterThanOrEqual(0)
        expect(rect?.top ?? 0).toBeGreaterThanOrEqual(0)
        expect(rect?.right ?? 0).toBeLessThanOrEqual(metrics.viewport.width + 1)
        expect(rect?.bottom ?? 0).toBeLessThanOrEqual(metrics.viewport.height + 1)
        expect(rect?.width ?? 0).toBeGreaterThan(0)
        expect(rect?.height ?? 0).toBeGreaterThan(0)
      }
    }

    try {
      await cleanupControlAgents(context.request)
      const response = await context.request.post('/farming/api/control/agents', {
        data: { command: 'bash', workspace: mobileDir },
      })
      expect(response.ok()).toBeTruthy()
      const { agentId } = await response.json() as { agentId: string }

      await page.goto('/farming/', { waitUntil: 'domcontentloaded' })
      await expect(page.getByTestId('app-shell')).toBeVisible()
      await page.getByTestId('code-mobile-menu').click()
      await agentListItem(page, agentId).click({ timeout: 30_000 })
      await page.waitForFunction(id => Boolean(window.__farmingTerminalTest?.isReady(id)), agentId)
      const output = Array.from({ length: 220 }, (_, index) => `coarse-mobile-shell-${String(index).padStart(3, '0')}`).join('\r\n')
      await page.evaluate(async ({ id, text }) => window.__farmingTerminalTest?.writeFixture(id, `${text}\r\n$ `), { id: agentId, text: output })

      await expectPinnedShell()
      const terminalBox = await page.locator(`[data-testid="code-terminal-pane"][data-agent-id="${agentId}"] .xterm-screen`).boundingBox()
      expect(terminalBox).toBeTruthy()
      if (terminalBox) {
        for (let index = 0; index < 4; index += 1) {
          await dispatchTouchDrag(
            page,
            { x: terminalBox.x + terminalBox.width / 2, y: terminalBox.y + terminalBox.height * 0.35 },
            { x: terminalBox.x + terminalBox.width / 2, y: terminalBox.y + terminalBox.height * 0.75 },
          )
          await page.waitForTimeout(80)
        }
      }
      await expectPinnedShell()

      await page.getByTestId('code-mobile-menu').click()
      await expect(page.getByTestId('code-mobile-sidebar-backdrop')).toBeVisible()
      await expectPinnedShell()
      const backdropBox = await page.getByTestId('code-mobile-sidebar-backdrop').boundingBox()
      expect(backdropBox).toBeTruthy()
      if (backdropBox) {
        await dispatchTouchDrag(
          page,
          { x: backdropBox.x + backdropBox.width * 0.78, y: backdropBox.y + backdropBox.height * 0.7 },
          { x: backdropBox.x + backdropBox.width * 0.78, y: backdropBox.y + backdropBox.height * 0.18 },
        )
      }
      await expectPinnedShell()
      if (await page.getByTestId('code-mobile-sidebar-backdrop').count()) {
        const closeBackdropBox = await page.getByTestId('code-mobile-sidebar-backdrop').boundingBox()
        expect(closeBackdropBox).toBeTruthy()
        if (closeBackdropBox) {
          await page.mouse.click(
            closeBackdropBox.x + closeBackdropBox.width - 8,
            closeBackdropBox.y + closeBackdropBox.height / 2,
          )
        }
      }
      await expect(page.getByTestId('code-mobile-sidebar-backdrop')).toHaveCount(0)

      await page.setViewportSize({ width: 844, height: 390 })
      await page.waitForTimeout(120)
      await expectPinnedShell()
    } finally {
      await cleanupControlAgents(context.request)
      await context.close()
    }
  })
})
