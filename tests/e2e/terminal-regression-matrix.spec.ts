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
  if ((await row.first().getAttribute('class'))?.includes('active') && !editorVisible) {
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
      const narrowRows = [
        '[agent@exam',
        'ple-host /s',
        'rv/example/',
        'projects/ma',
        'trix]',
        '$  ',
      ]
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
          session: {
            output: wideRows.join('\n'),
            renderOutput: wideRows.join('\n'),
            previewSnapshot: snapshotFromRows(narrowRows, 10),
          },
        }),
      })
    })

    const cursorRecoveringAgentId = await createControlAgent(page, 'bash', projectDir)
    await page.route(new RegExp(`/farming/api/agents/${cursorRecoveringAgentId}/session-view$`), async route => {
      const renderRows = [
        '',
        '',
        'restored-cursor-prompt',
        '$  ',
        '',
      ]
      const diagnostics = await page.evaluate((id) => {
        return window.__farmingTerminalTest?.getBufferDiagnostics?.(id) ?? null
      }, cursorRecoveringAgentId).catch(() => null)
      const cols = diagnostics?.cols && diagnostics.cols > 0 ? diagnostics.cols : 80
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          session: {
            output: renderRows.join('\n'),
            renderOutput: renderRows.join('\n'),
            previewSnapshot: snapshotFromRows(renderRows, cols, 3, 2),
          },
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
          session: {
            output,
            renderOutput: output,
            outputSeq: 777000 + bootstrapReconnectCalls,
            previewSnapshot: snapshotFromRows(output.split('\n'), 100, 3, output.split('\n').length - 1),
          },
        }),
      })
    })

    const bashAgentId = await createControlAgent(page, 'bash', projectDir)
    const reconnectOutputAgentId = await createControlAgent(page, 'bash', projectDir)
    const parkedReconnectAgentId = await createControlAgent(page, 'bash', projectDir)
    const staleReconnectAgentId = await createControlAgent(page, 'bash', projectDir)
    const codexAgentId = await createControlAgent(page, 'codex', projectDir)
    const secondCodexAgentId = await createControlAgent(page, 'codex', projectDir)

    await scenario('xterm is the default renderer for recovered sessions', async () => {
      await selectAgent(page, recoveringAgentId)
      await expect(page.locator(`[data-agent-id="${recoveringAgentId}"] .xterm`)).toBeVisible({ timeout: 20_000 })
      await expect(page.locator(`[data-agent-id="${recoveringAgentId}"] canvas`)).toHaveCount(0)
    })

    await scenario('bootstrap fetches a single session view for recovered output', async () => {
      await expect.poll(() => sessionViewCalls, { timeout: 15_000 }).toBe(1)
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

    await scenario('backend reconnect during bootstrap retries output sync after replay', async () => {
      await selectAgent(page, bootstrapReconnectAgentId)
      await expect.poll(async () => await visibleTerminalText(page, bootstrapReconnectAgentId), { timeout: 15_000 })
        .toContain('BOOTSTRAP_RECONNECT_OUTPUT')
      expect(bootstrapReconnectCalls).toBeGreaterThanOrEqual(2)
      await selectAgent(page, bashAgentId)
    })

    await scenario('page reload keeps the active terminal attached and accepts keyboard input', async () => {
      await selectAgent(page, bashAgentId)
      await page.reload({ waitUntil: 'networkidle' })
      await installClipboardProbe(page)
      await installWindowOpenProbe(page)
      await selectAgent(page, bashAgentId)
      await expect(page.locator(activeTerminalHostSelector(bashAgentId))).toBeVisible({ timeout: 20_000 })
      await expect.poll(async () => page.evaluate((id) => {
        return window.__farmingTerminalTest?.isReady(id) ?? false
      }, bashAgentId)).toBe(true)
      await page.locator(`${activeTerminalHostSelector(bashAgentId)} textarea`).first().click({ force: true })
      await page.keyboard.type("printf 'MATRIX_RELOAD_UI_OK\\n'\n")
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
      expect(rows.findIndex(row => row.trim())).toBe(0)
    })

    await scenario('clean bash prompt is readable at desktop width without 10-column fragments', async () => {
      const text = await visibleTerminalText(page, bashAgentId)
      expect(text.replace(/\n/g, '')).toContain('matrix-project')
      expect(hasWrappedPromptFragments(text)).toBe(false)
    })

    await scenario('backend reconnect resynchronizes the visible terminal size', async () => {
      const beforeCount = await page.evaluate((id) => window.__farmingTerminalTest?.getResizeNotificationCount(id) ?? 0, bashAgentId)
      await page.evaluate(() => window.dispatchEvent(new Event('farming:backend-connected')))
      await expect.poll(async () => {
        return page.evaluate((id) => window.__farmingTerminalTest?.getResizeNotificationCount(id) ?? 0, bashAgentId)
      }, { timeout: 5000 }).toBeGreaterThan(beforeCount)
      const result = await page.evaluate((id) => ({
        notified: window.__farmingTerminalTest?.getLastNotifiedResize(id) ?? null,
        diagnostics: window.__farmingTerminalTest?.getBufferDiagnostics(id) ?? null,
      }), bashAgentId)
      expect(result.notified).toEqual({
        cols: result.diagnostics?.cols,
        rows: result.diagnostics?.rows,
      })
    })

    await scenario('backend reconnect repairs missed terminal output from session view', async () => {
      await selectAgent(page, reconnectOutputAgentId)
      const missedOutput = [
        '[agent@example-host /srv/example/projects/matrix]',
        '$ echo reconnect',
        'MISSED_RECONNECT_OUTPUT',
        '$  ',
      ].join('\n')
      const reconnectSessionViewRoute = new RegExp(`/farming/api/agents/${reconnectOutputAgentId}/session-view$`)
      const handler = async (route: import('@playwright/test').Route) => {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            session: {
              output: missedOutput,
              renderOutput: missedOutput,
              outputSeq: 999999,
              previewSnapshot: snapshotFromRows(missedOutput.split('\n'), 100, 3, 3),
            },
          }),
        })
      }
      await page.route(reconnectSessionViewRoute, handler)
      try {
        await page.evaluate(() => window.dispatchEvent(new Event('farming:backend-connected')))
        await expect.poll(async () => await visibleTerminalText(page, reconnectOutputAgentId)).toContain('MISSED_RECONNECT_OUTPUT')
      } finally {
        await page.unroute(reconnectSessionViewRoute, handler)
        await selectAgent(page, bashAgentId)
      }
    })

    await scenario('parked terminal repairs missed reconnect output when attached again', async () => {
      await selectAgent(page, parkedReconnectAgentId)
      await expect(page.locator(`[data-agent-id="${parkedReconnectAgentId}"] .xterm`)).toBeVisible({ timeout: 15_000 })
      await selectAgent(page, bashAgentId)
      const parkedOutput = [
        '[agent@example-host /srv/example/projects/matrix]',
        '$ echo parked reconnect',
        'PARKED_RECONNECT_OUTPUT',
        '$  ',
      ].join('\n')
      const parkedSessionViewRoute = new RegExp(`/farming/api/agents/${parkedReconnectAgentId}/session-view$`)
      const handler = async (route: import('@playwright/test').Route) => {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            session: {
              output: parkedOutput,
              renderOutput: parkedOutput,
              outputSeq: 888888,
              previewSnapshot: snapshotFromRows(parkedOutput.split('\n'), 100, 3, 3),
            },
          }),
        })
      }
      await page.route(parkedSessionViewRoute, handler)
      try {
        await page.evaluate(() => window.dispatchEvent(new Event('farming:backend-connected')))
        await expect.poll(async () => await visibleTerminalText(page, bashAgentId)).not.toContain('PARKED_RECONNECT_OUTPUT')
        await selectAgent(page, parkedReconnectAgentId)
        await expect.poll(async () => await visibleTerminalText(page, parkedReconnectAgentId)).toContain('PARKED_RECONNECT_OUTPUT')
      } finally {
        await page.unroute(parkedSessionViewRoute, handler)
        await selectAgent(page, bashAgentId)
      }
    })

    await scenario('stale reconnect snapshot does not overwrite newer live output', async () => {
      await selectAgent(page, staleReconnectAgentId)
      const staleOutput = [
        '[agent@example-host /srv/example/projects/matrix]',
        '$ stale reconnect',
        'STALE_RECONNECT_SNAPSHOT',
        '$  ',
      ].join('\n')
      const staleSessionViewRoute = new RegExp(`/farming/api/agents/${staleReconnectAgentId}/session-view$`)
      let staleSessionViewRequests = 0
      const handler = async (route: import('@playwright/test').Route) => {
        staleSessionViewRequests += 1
        await new Promise(resolve => setTimeout(resolve, 2000))
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            session: {
              output: staleOutput,
              renderOutput: staleOutput,
              outputSeq: 1000,
              previewSnapshot: snapshotFromRows(staleOutput.split('\n'), 100, 3, 3),
            },
          }),
        })
      }
      await page.route(staleSessionViewRoute, handler)
      try {
        await page.evaluate(() => window.dispatchEvent(new Event('farming:backend-connected')))
        await expect.poll(() => staleSessionViewRequests, { timeout: 5000 }).toBeGreaterThan(0)
        await page.evaluate(async ({ id }) => {
          await window.__farmingTerminalTest?.writeSequenced(id, 'NEWER_LIVE_OUTPUT\r\n', 1001)
        }, { id: staleReconnectAgentId })
        await expect.poll(async () => page.evaluate((id) => (
          window.__farmingTerminalTest?.getLastOutputSeq(id) ?? null
        ), staleReconnectAgentId)).toBe(1001)
        await expect.poll(async () => await visibleTerminalText(page, staleReconnectAgentId)).toContain('NEWER_LIVE_OUTPUT')
        await page.waitForTimeout(2200)
        expect(await visibleTerminalText(page, staleReconnectAgentId)).not.toContain('STALE_RECONNECT_SNAPSHOT')
      } finally {
        await page.unroute(staleSessionViewRoute, handler)
        await selectAgent(page, bashAgentId)
      }
    })

    await scenario('long output creates scrollback without moving the whole page', async () => {
      const before = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }))
      const output = Array.from({ length: 180 }, (_, index) => `matrix-line-${String(index).padStart(3, '0')}`).join('\r\n')
      await writeTerminalRaw(page, bashAgentId, `${output}\r\n`)
      const viewport = await terminalViewport(page, bashAgentId)
      expect(viewport.scrollbackLength).toBeGreaterThan(0)
      const after = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }))
      expect(after).toEqual(before)
    })

    await scenario('user scroll position stays anchored while older output is being read', async () => {
      await page.evaluate(async ({ id }) => {
        await window.__farmingTerminalTest?.scrollToLine(id, 30)
      }, { id: bashAgentId })
      const scrolled = await terminalViewport(page, bashAgentId)
      expect(scrolled.following).toBe(false)
      expect(scrolled.viewportY).toBeGreaterThan(0)
      await writeTerminalRaw(page, bashAgentId, 'matrix-new-background-output\r\n')
      const after = await terminalViewport(page, bashAgentId)
      expect(after.following).toBe(false)
      expect(after.hasUnreadOutput).toBe(true)
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
      await writeTerminalRaw(page, bashAgentId, 'matrix-after-bottom-output\r\n')
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
      await page.evaluate(() => navigator.clipboard.writeText("printf 'MATRIX_CONTEXT_MENU_PASTE_OK\\n'\r"))
      await expect.poll(async () => page.evaluate(() => navigator.clipboard.readText()))
        .toContain('MATRIX_CONTEXT_MENU_PASTE_OK')
      const cell = await cellForText(page, bashAgentId, 'matrix-copy-word', 3)
      const inputCountBeforePaste = await page.evaluate((id) => window.__farmingTerminalTest?.getInputCount(id) ?? 0, bashAgentId)
      await page.mouse.click(cell.x + 220, cell.y, { button: 'right' })
      const menu = page.getByTestId('code-terminal-context-menu')
      await expect(menu).toBeVisible()
      await menu.getByRole('menuitem', { name: /Paste|粘贴/ }).click()
      await expect.poll(async () => page.evaluate((id) => window.__farmingTerminalTest?.getInputCount(id) ?? 0, bashAgentId))
        .toBeGreaterThan(inputCountBeforePaste)
      await expect.poll(async () => {
        const response = await page.request.get(`/farming/api/control/agents/${bashAgentId}/output?tail=2000`)
        return response.ok() ? await response.text() : ''
      }).toContain('MATRIX_CONTEXT_MENU_PASTE_OK')
      await expect.poll(async () => await visibleTerminalText(page, bashAgentId)).toContain('MATRIX_CONTEXT_MENU_PASTE_OK')
    })

    await scenario('context menu select all selects terminal scrollback text', async () => {
      await writeTerminalFixture(page, bashAgentId, 'matrix-select-all-one\r\nmatrix-select-all-two\r\n')
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
      await writeTerminalFixture(page, bashAgentId, 'matrix-clear-after\r\n')
      await expect.poll(async () => await visibleTerminalText(page, bashAgentId)).toContain('matrix-clear-after')
    })

    if (process.platform === 'darwin') {
      await scenario('Cmd+K clears visible and backend terminal scrollback on macOS', async () => {
        await selectAgent(page, bashAgentId)
        await writeTerminalFixture(page, bashAgentId, 'matrix-cmd-k-clear-before\r\n')
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
        await writeTerminalFixture(page, bashAgentId, 'matrix-cmd-k-clear-after\r\n')
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
    const urlOpenModifier = process.platform === 'darwin' ? 'Meta' : 'Control'
    const terminalFindShortcut = process.platform === 'darwin' ? 'Meta+F' : 'Control+F'
    await scenario('modifier-hovering a terminal URL exposes an open-target affordance', async () => {
      await writeTerminalFixture(page, bashAgentId, `${url}\r\n`)
      const cell = await cellForText(page, bashAgentId, 'example.test', 2)
      await page.mouse.move(cell.x, cell.y)
      await expect.poll(async () => {
        return page.evaluate((id) => {
          const host = document.querySelector(`.terminal-session-host[data-agent-id="${CSS.escape(id)}"]`)
          return host instanceof HTMLElement ? host.classList.contains('terminal-open-target-hover') : false
        }, bashAgentId)
      }).toBe(false)
      await page.keyboard.down(urlOpenModifier)
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
      await page.keyboard.up(urlOpenModifier)
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
      await page.keyboard.down(urlOpenModifier)
      await page.mouse.click(cell.x, cell.y)
      await page.keyboard.up(urlOpenModifier)
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
      await page.mouse.move(cell.x, cell.y)
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
      await page.mouse.move(blankCell.x, blankCell.y)
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
      await page.mouse.move(cell.x, cell.y)
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
      await page.mouse.move(cell.x, cell.y)
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
      await page.mouse.move(cell.x, cell.y)
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
              const cursor = host?.querySelector('.xterm-cursor') ?? null
              const cursorStyle = cursor instanceof HTMLElement ? getComputedStyle(cursor) : null
              return {
                visibleCount: visibleHosts.length,
                agentId: host?.dataset.agentId || '',
                paneAgentId: host?.closest('[data-testid="code-terminal-pane"]')?.getAttribute('data-agent-id') || '',
                hostCountInMount: host?.parentElement?.querySelectorAll('.terminal-session-host').length ?? 0,
                xtermRootCount: host?.querySelectorAll(':scope > .xterm').length ?? 0,
                nestedXtermCount: host?.querySelectorAll('.xterm .xterm').length ?? 0,
                cursorSuppressed: host?.classList.contains('terminal-renderer-cursor-suppressed') ?? false,
                cursorLooksHidden: !cursorStyle || cursorStyle.opacity === '0',
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
            cursorSuppressed: true,
            cursorLooksHidden: true,
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
        await page.evaluate(async (id) => {
          await window.__farmingTerminalTest?.scrollToBottom(id)
        }, bashAgentId)
        expect((await terminalViewport(page, bashAgentId)).following).toBe(true)
        expect((await terminalViewport(page, bashAgentId)).hasUnreadOutput).toBe(false)

        await selectAgent(page, codexAgentId)
        await expect.poll(async () => {
          const diagnostics = await terminalHostDiagnostics(page)
          const bashHost = diagnostics.find(host => host.agentId === bashAgentId)
          return bashHost
            ? { parked: bashHost.inParkingLot, attached: bashHost.recordAttached }
            : null
        }).toEqual({ parked: true, attached: false })
        await writeTerminalRaw(page, bashAgentId, 'PARKED_FOLLOWING_UNREAD_OUTPUT\r\n')
        const parkedViewport = await terminalViewport(page, bashAgentId)
        expect(parkedViewport.following).toBe(false)
        expect(parkedViewport.hasUnreadOutput).toBe(true)

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
        await expect(project.locator('[data-testid="code-agent-row"], [data-testid="code-project-agent-compact"], [data-testid="code-pinned-agent-compact"]')).toHaveCount(9)
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

    await scenario('xterm mobile surface is present without Ghostty canvas', async () => {
      await expect(page.locator(`[data-agent-id="${agentId}"] .xterm`)).toBeVisible()
      await expect(page.locator(`[data-agent-id="${agentId}"] canvas`)).toHaveCount(0)
    })

    await scenario('mobile prompt starts at the top of the terminal viewport', async () => {
      await expect.poll(async () => (await visibleTerminalText(page, agentId, 20)).trim().length, { timeout: 15_000 }).toBeGreaterThan(0)
      const rows = await terminalRows(page, agentId, 20)
      expect(rows.findIndex(row => row.trim())).toBeLessThanOrEqual(1)
    })

    await scenario('mobile long output creates terminal scrollback', async () => {
      const output = Array.from({ length: 180 }, (_, index) => `mobile-matrix-line-${String(index).padStart(3, '0')}`).join('\r\n')
      await writeTerminalRaw(page, agentId, `${output}\r\n`)
      expect((await terminalViewport(page, agentId)).scrollbackLength).toBeGreaterThan(0)
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
      expect(result.terminalTouchAction).toBe('none')
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
      const composer = page.getByTestId('code-composer').locator('textarea')
      await composer.fill('echo MOBILE_AFTER_COPY')
      await page.getByTestId('code-composer-send').click()
      await expect.poll(async () => await visibleTerminalText(page, agentId)).toContain('MOBILE_AFTER_COPY')
    })

    await scenario('mobile scenario count reaches at least 8 executed cases', async () => {
      expect(checked.length + 1).toBeGreaterThanOrEqual(8)
    })

    console.log(`mobile terminal regression matrix executed ${checked.length} scenarios`)
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

      await page.goto('/farming/', { waitUntil: 'networkidle' })
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
