import fs from 'node:fs'
import path from 'node:path'
import {
  expect,
  getAgentRowIds,
  openFarming,
  openNewAgentDialog,
  scrollTerminalToLine,
  startAgentFromOpenDialog,
  terminalHostDiagnostics,
  terminalRows,
  terminalViewport,
  test,
  writeTerminalFixture,
  writeTerminalRaw,
} from './fixtures'

async function sessionText(page: import('@playwright/test').Page, agentId: string) {
  const response = await page.request.get(`/farming/api/agents/${agentId}/session-text`)
  expect(response.ok()).toBeTruthy()
  return response.text()
}

async function terminalCellCenter(page: import('@playwright/test').Page, agentId: string, col: number, row: number) {
  const cell = await page.evaluate(({ id, x, y }) => {
    return window.__farmingTerminalTest?.getCellCenter(id, x, y) ?? null
  }, { id: agentId, x: col, y: row })
  if (!cell) throw new Error(`Terminal cell is missing: ${agentId} ${col}:${row}`)
  return cell
}

test.describe('human Farming Agent story', () => {
  test('defaults the desktop Terminal Composer closed and remembers the manual choice without hiding it on mobile', async ({ page, workspaceRoot }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'maxTouchPoints', { value: 1, configurable: true })
    })
    await page.setViewportSize({ width: 1280, height: 800 })
    const response = await page.request.post('/farming/api/control/agents', {
      data: { command: 'bash', workspace: workspaceRoot },
    })
    expect(response.ok()).toBeTruthy()
    const payload = await response.json() as { agentId?: string }
    expect(payload.agentId).toBeTruthy()

    await openFarming(page)
    const row = page.locator(`[data-testid="code-agent-row"][data-agent-id="${payload.agentId}"]`)
    await expect(row).toBeVisible()
    await row.click()

    const imePresentation = await page.locator(`[data-testid="code-terminal-pane"][data-agent-id="${payload.agentId}"] .composition-view`).evaluate(element => {
      const style = window.getComputedStyle(element)
      return {
        backgroundColor: style.backgroundColor,
        borderBottomColor: style.borderBottomColor,
        borderBottomStyle: style.borderBottomStyle,
        borderBottomWidth: style.borderBottomWidth,
        borderRadius: style.borderRadius,
        boxShadow: style.boxShadow,
      }
    })
    expect(imePresentation).toMatchObject({
      backgroundColor: 'rgba(0, 0, 0, 0)',
      borderBottomColor: 'rgb(9, 105, 218)',
      borderBottomStyle: 'solid',
      borderBottomWidth: '2px',
      borderRadius: '0px',
      boxShadow: 'none',
    })

    await expect(page.getByTestId('code-composer')).toHaveCount(0)
    await expect(page.getByTestId('code-composer-restore')).toBeVisible()
    await page.getByTestId('code-composer-restore').click()
    await expect(page.getByTestId('code-composer-input')).toBeVisible()

    await page.reload({ waitUntil: 'networkidle' })
    await expect(page.getByTestId('code-composer-input')).toBeVisible()
    await page.locator('.code-composer-collapse-zone').hover()
    await page.getByTestId('code-composer-collapse').click()
    await page.reload({ waitUntil: 'networkidle' })
    await expect(page.getByTestId('code-composer')).toHaveCount(0)

    await page.setViewportSize({ width: 390, height: 844 })
    await page.reload({ waitUntil: 'networkidle' })
    await expect(page.getByTestId('code-composer-input')).toBeVisible()
    await expect(page.getByTestId('code-composer-restore')).toHaveCount(0)
  })

  test('restores the selected Agent after reloading with multiple live Agents', async ({ page, workspaceRoot }) => {
    await openFarming(page)
    await openNewAgentDialog(page)
    const firstAgentId = await startAgentFromOpenDialog(page, 'bash', workspaceRoot)
    await openNewAgentDialog(page)
    const secondAgentId = await startAgentFromOpenDialog(page, 'bash', workspaceRoot)

    const firstAgentRow = page.locator(`[data-testid="code-agent-row"][data-agent-id="${firstAgentId}"]`)
    await firstAgentRow.click()
    await expect(firstAgentRow).toHaveClass(/active/)
    await expect(page.locator(`[data-testid="code-terminal-pane"][data-agent-id="${firstAgentId}"]`)).toBeVisible()

    await page.reload({ waitUntil: 'networkidle' })
    await expect(firstAgentRow).toHaveClass(/active/)
    await expect(page.locator(`[data-testid="code-terminal-pane"][data-agent-id="${firstAgentId}"]`)).toBeVisible()
    await expect(page.locator(`[data-testid="code-terminal-pane"][data-agent-id="${secondAgentId}"]`)).toBeHidden()

    const terminalComposerInput = page.getByTestId('code-composer-input')
    await terminalComposerInput.fill('terminal draft survives composer collapse')
    await page.locator('.code-composer-collapse-zone').hover()
    await page.getByTestId('code-composer-collapse').click()
    await expect(page.getByTestId('code-composer')).toHaveCount(0)
    await page.getByTestId('code-composer-restore').click()
    await expect(terminalComposerInput).toHaveValue('terminal draft survives composer collapse')
  })

  test('starts a Code-style agent, queues follow-ups while busy, and survives reopening the page', async ({ page, workspaceRoot }) => {
    await openFarming(page)
    await openNewAgentDialog(page)

    await expect(page.getByTestId('input-dialog')).toBeVisible()
    const agentId = await startAgentFromOpenDialog(page, 'codex', workspaceRoot)

    await expect(page.getByTestId('code-composer').locator('textarea')).toBeEnabled()

    await page.getByTestId('code-composer').locator('textarea').fill('add greeting to app.js')
    await page.getByTestId('code-composer-send').click()
    await expect(page.getByTestId('code-pending-followup')).toBeVisible()
    await expect(page.getByTestId('code-pending-followup')).toContainText('add greeting to app.js')

    expect(await sessionText(page, agentId)).not.toContain('add greeting to app.js')

    await page.getByTestId('code-composer').locator('textarea').fill('follow up: make greeting excited')
    await page.getByTestId('code-composer-send').click()
    await expect(page.getByTestId('code-pending-followup-row')).toHaveCount(2)
    await expect(page.getByTestId('code-pending-followup')).toContainText('follow up: make greeting excited')

    await page.getByTestId('code-pending-followup-steer').nth(1).click()
    await expect(page.getByTestId('code-pending-followup')).toContainText('add greeting to app.js')
    await expect(page.getByTestId('code-pending-followup')).not.toContainText('follow up: make greeting excited')
    await page.getByTestId('code-pending-followup-discard').click()
    await expect(page.getByTestId('code-pending-followup')).toBeHidden()
    await expect.poll(() => sessionText(page, agentId)).toContain('follow up: make greeting excited')
    expect(await sessionText(page, agentId)).not.toContain('add greeting to app.js')
    await expect.poll(() => sessionText(page, agentId)).toContain('Done · follow-up applied')

    await page.reload({ waitUntil: 'networkidle' })
    const reloadedAgentId = await page.getByTestId('code-agent-row').getAttribute('data-agent-id')
    expect(reloadedAgentId).toBe(agentId)

    await expect(page.getByTestId('code-composer').locator('textarea')).toBeEnabled()
    await page.getByTestId('code-composer').locator('textarea').fill('follow up after reopen')
    await page.getByTestId('code-composer-send').click()
    await expect(page.getByTestId('code-pending-followup')).toContainText('follow up after reopen')
  })

  test('keeps terminal scroll anchored until the user jumps to latest output', async ({ page, workspaceRoot }) => {
    await openFarming(page)
    await openNewAgentDialog(page)
    const agentId = await startAgentFromOpenDialog(page, 'codex', workspaceRoot)

    await expect.poll(
      () => page.evaluate((id) => Boolean(window.__farmingTerminalTest?.getViewport(id)), agentId),
      { timeout: 15_000 }
    ).toBe(true)

    const output = Array.from({ length: 120 }, (_, index) => `scroll-lock-line-${String(index).padStart(3, '0')}`).join('\r\n')
    await writeTerminalRaw(page, agentId, `${output}\r\n`)
    await expect.poll(async () => (await terminalViewport(page, agentId)).scrollbackLength).toBeGreaterThan(20)
    await scrollTerminalToLine(page, agentId, 20)

    const scrolled = await terminalViewport(page, agentId)
    expect(scrolled.following).toBe(false)
    expect(scrolled.viewportY).toBeGreaterThan(0)

    await writeTerminalRaw(page, agentId, 'new output while user is reading older terminal lines\r\n')
    const afterOutput = await terminalViewport(page, agentId)
    expect(afterOutput.following).toBe(false)
    expect(afterOutput.hasUnreadOutput).toBe(true)
    expect(afterOutput.viewportY).toBeGreaterThan(0)
    await expect(page.getByTestId('code-terminal-jump-bottom')).toBeVisible()

    const inputCountBeforeJump = await page.evaluate((id) => window.__farmingTerminalTest?.getInputCount(id) ?? 0, agentId)
    await page.getByTestId('code-terminal-jump-bottom').click()
    await expect.poll(async () => (await terminalViewport(page, agentId)).following).toBe(true)
    expect((await terminalViewport(page, agentId)).viewportY).toBe(0)
    const inputCountAfterJump = await page.evaluate((id) => window.__farmingTerminalTest?.getInputCount(id) ?? 0, agentId)
    expect(inputCountAfterJump).toBe(inputCountBeforeJump)
    await expect.poll(async () => (await terminalRows(page, agentId, 80)).join('\n')).toContain('new output while user is reading older terminal lines')
  })

  test('finds text inside the active terminal', async ({ page, workspaceRoot }) => {
    await openFarming(page)
    await openNewAgentDialog(page)
    const agentId = await startAgentFromOpenDialog(page, 'codex', workspaceRoot)

    await expect.poll(
      () => page.evaluate((id) => Boolean(window.__farmingTerminalTest?.getViewport(id)), agentId),
      { timeout: 15_000 }
    ).toBe(true)

    await writeTerminalFixture(page, agentId, [
      '$ echo terminal search',
      'alpha beta-needle gamma',
      'another beta-needle row',
      '$ ',
    ].join('\r\n'))

    const browserPlatform = await page.evaluate(() => navigator.platform.toLowerCase())
    const modifier = browserPlatform.includes('mac') ? 'Meta' : 'Control'
    await page.locator(`[data-testid="code-terminal-pane"][data-agent-id="${agentId}"]`).click()
    await page.keyboard.down(modifier)
    await page.keyboard.press('f')
    await page.keyboard.up(modifier)

    const searchBox = page.getByTestId('code-terminal-search')
    const searchInput = page.getByTestId('code-terminal-search-input')
    await expect(searchBox).toBeVisible()
    await searchInput.fill('beta-needle')
    await expect.poll(async () => {
      return page.evaluate((id) => window.__farmingTerminalTest?.search(id, 'beta-needle'), agentId)
    }).toMatchObject({ found: true, resultCount: 2 })
    await expect(searchBox).toContainText('/2')

    await searchInput.press('Enter')
    await searchInput.fill('missing-terminal-result')
    await expect(searchBox).toContainText(/No results|无结果/)

    await searchInput.press('Escape')
    await expect(searchBox).toHaveCount(0)
    await expect.poll(() => page.evaluate((id) => window.__farmingTerminalTest?.getSelection(id), agentId)).toBe('')
  })

  test.describe('touch mobile terminal', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

    test('supports mobile terminal drag scroll and copy without page drift', async ({ page, workspaceRoot }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await openFarming(page)
    if ((await page.getByTestId('code-workspace').getAttribute('class'))?.includes('sidebar-collapsed')) {
      await page.getByTestId('code-mobile-menu').click()
    }
    await openNewAgentDialog(page)
    const agentId = await startAgentFromOpenDialog(page, 'codex', workspaceRoot)

    await expect.poll(
      () => page.evaluate((id) => Boolean(window.__farmingTerminalTest?.getViewport(id)), agentId),
      { timeout: 15_000 }
    ).toBe(true)

    const output = Array.from({ length: 160 }, (_, index) => `mobile-scroll-line-${String(index).padStart(3, '0')}`).join('\r\n')
    await writeTerminalFixture(page, agentId, `${output}\r\n$ `)
    const dragMetrics = await page.evaluate(async (id) => {
      const host = document.querySelector(`.terminal-session-host[data-agent-id="${CSS.escape(id)}"]`)
      const terminalSurface = host?.querySelector('.xterm-screen, canvas')
      const workspace = document.querySelector('[data-testid="code-workspace"]')
      if (!(host instanceof HTMLElement) || !(terminalSurface instanceof HTMLElement) || !(workspace instanceof HTMLElement)) {
        throw new Error('Mobile terminal elements are missing')
      }

      const rect = terminalSurface.getBoundingClientRect()
      const pointerId = 7001
      const clientX = rect.left + rect.width / 2
      const startY = rect.top + rect.height * 0.42
      const dispatchTouch = (type: string, clientY: number) => {
        terminalSurface.dispatchEvent(new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          pointerId,
          pointerType: 'touch',
          isPrimary: true,
          clientX,
          clientY,
        }))
      }

      const before = window.__farmingTerminalTest?.getViewport(id)
      dispatchTouch('pointerdown', startY)
      for (let step = 1; step <= 7; step += 1) {
        dispatchTouch('pointermove', startY + step * 18)
      }
      dispatchTouch('pointerup', startY + 7 * 18)
      await new Promise<void>(resolve => setTimeout(resolve, 180))
      const after = window.__farmingTerminalTest?.getViewport(id)

      return {
        before,
        after,
        windowScrollX: window.scrollX,
        windowScrollY: window.scrollY,
        documentScrollLeft: document.documentElement.scrollLeft,
        documentScrollTop: document.documentElement.scrollTop,
        workspaceClientWidth: workspace.clientWidth,
        workspaceScrollWidth: workspace.scrollWidth,
        terminalTouchAction: getComputedStyle(host).touchAction,
      }
    }, agentId)

    expect(dragMetrics.before?.viewportY).toBe(0)
    expect(dragMetrics.after?.viewportY ?? 0).toBeGreaterThan(0)
    expect(dragMetrics.windowScrollX).toBe(0)
    expect(dragMetrics.windowScrollY).toBe(0)
    expect(dragMetrics.documentScrollLeft).toBe(0)
    expect(dragMetrics.documentScrollTop).toBe(0)
    expect(dragMetrics.workspaceScrollWidth).toBeLessThanOrEqual(dragMetrics.workspaceClientWidth + 1)
    expect(dragMetrics.terminalTouchAction).toBe('pan-y')

    const copyTarget = 'mobile-copy-target'
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
    await writeTerminalFixture(page, agentId, `$ echo ${copyTarget}\r\n${copyTarget}\r\n$ `)
    const rows = await terminalRows(page, agentId, 40)
    const copyHit = rows
      .map((row, rowIndex) => {
        const col = row.indexOf(copyTarget)
        return col >= 0 ? { row: rowIndex, col: col + 2 } : null
      })
      .find((hit): hit is { row: number; col: number } => Boolean(hit))
    if (!copyHit) {
      throw new Error(`Mobile copy fixture row is missing: ${JSON.stringify(rows)}`)
    }

    const copyCell = await terminalCellCenter(page, agentId, copyHit.col, copyHit.row)
    await page.evaluate(({ id, x, y }) => {
      const target = document.querySelector(`.terminal-session-host[data-agent-id="${CSS.escape(id)}"]`)
      if (!target) throw new Error('Mobile terminal copy target is missing')
      target.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        button: 2,
        clientX: x,
        clientY: y,
      }))
    }, { id: agentId, ...copyCell })
    const terminalContextMenu = page.getByTestId('code-terminal-context-menu')
    await expect(terminalContextMenu).toBeVisible()
    await terminalContextMenu.getByRole('menuitem', { name: /Copy|复制/ }).click()
    await expect.poll(async () => page.evaluate(() => {
      return (window as unknown as { __copiedText?: string }).__copiedText
    })).toBe(copyTarget)
    })
  })

  test('opens terminal URLs and copies selected terminal text after right click', async ({ page, workspaceRoot }) => {
    const url = 'https://example.test/t'
    const copyTarget = 'copy-target'

    await openFarming(page)
    await openNewAgentDialog(page)
    const agentId = await startAgentFromOpenDialog(page, 'codex', workspaceRoot)

    await expect.poll(
      () => page.evaluate((id) => Boolean(window.__farmingTerminalTest?.getViewport(id)), agentId),
      { timeout: 15_000 }
    ).toBe(true)

    await page.evaluate(() => {
      const target = window as unknown as {
        __originalOpenForTerminalUrlTest?: typeof window.open
        __openedTerminalUrls?: string[]
      }
      target.__originalOpenForTerminalUrlTest = window.open
      target.__openedTerminalUrls = []
      window.open = ((openedUrl?: string | URL) => {
        target.__openedTerminalUrls?.push(String(openedUrl ?? ''))
        return null
      }) as typeof window.open
    })

    await page.getByTestId('code-terminal-pane').click()
    await page.keyboard.type(`${url} ${copyTarget}`)
    await page.keyboard.press('Enter')

    await expect.poll(async () => (await terminalRows(page, agentId, 40)).join('\n'))
      .toContain(`${url} ${copyTarget}`)
    const findParsedUrlHit = async () => {
      const rows = await terminalRows(page, agentId, 40)
      for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
        const col = rows[rowIndex]?.indexOf('example.test') ?? -1
        if (col < 0) continue

        const parsed = await page.evaluate(({ id, x, y }) => {
          return window.__farmingTerminalTest?.getUrlAtCell(id, x, y) ?? null
        }, { id: agentId, x: col, y: rowIndex })
        if (parsed === url) {
          return { row: rowIndex, col }
        }
      }
      return null
    }
    await expect.poll(async () => Boolean(await findParsedUrlHit())).toBe(true)
    const urlHit = await findParsedUrlHit()
    const rows = await terminalRows(page, agentId, 40)
    const copyHit = rows
      .map((row, rowIndex) => {
        const col = row.indexOf(copyTarget)
        return col >= 0 ? { row: rowIndex, col: col + 2 } : null
      })
      .find((hit): hit is { row: number; col: number } => Boolean(hit))
    if (!urlHit || !copyHit) {
      throw new Error(`Terminal URL/copy fixture rows are missing: ${JSON.stringify(rows)}`)
    }

    const urlCell = await terminalCellCenter(page, agentId, urlHit.col, urlHit.row)
    await page.mouse.click(urlCell.x, urlCell.y)
    await expect.poll(async () => page.evaluate(() => {
      return (window as unknown as { __openedTerminalUrls?: string[] }).__openedTerminalUrls ?? []
    })).toHaveLength(0)
    const urlOpenModifier = process.platform === 'darwin' ? 'Meta' : 'Control'
    await page.keyboard.down(urlOpenModifier)
    await page.mouse.click(urlCell.x, urlCell.y)
    await page.keyboard.up(urlOpenModifier)
    await expect.poll(async () => page.evaluate(() => {
      return (window as unknown as { __openedTerminalUrls?: string[] }).__openedTerminalUrls ?? []
    })).toContain(url)

    const copyCell = await terminalCellCenter(page, agentId, copyHit.col, copyHit.row)
    await page.mouse.dblclick(copyCell.x, copyCell.y)
    await expect.poll(async () => page.evaluate((id) => {
      return window.__farmingTerminalTest?.getSelection(id) ?? ''
    }, agentId)).toBe(copyTarget)

    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(page.url()).origin })
    await page.mouse.click(copyCell.x, copyCell.y, { button: 'right' })

    const terminalContextMenu = page.getByTestId('code-terminal-context-menu')
    await expect(terminalContextMenu).toBeVisible()
    await expect(terminalContextMenu.getByRole('menuitem', { name: /Copy|复制/ })).toBeFocused()
    await terminalContextMenu.getByRole('menuitem', { name: /Copy|复制/ }).click()
    await expect.poll(async () => page.evaluate(() => navigator.clipboard.readText())).toBe(copyTarget)
    await expect(page.getByTestId('code-terminal-context-menu')).toHaveCount(0)

    await page.evaluate(() => {
      const target = window as unknown as { __originalOpenForTerminalUrlTest?: typeof window.open }
      if (target.__originalOpenForTerminalUrlTest) {
        window.open = target.__originalOpenForTerminalUrlTest
      }
    })
  })

  test('copies dragged mixed-language terminal selection after right click', async ({ page, workspaceRoot }) => {
    const selectedText = 'MetaInfoGen.visit(AlterTableClustered) 区分 range append delta 与 hash delta;'
    const fixtureLine = `- ${selectedText}`

    await openFarming(page)
    await openNewAgentDialog(page)
    const agentId = await startAgentFromOpenDialog(page, 'codex', workspaceRoot)

    await expect.poll(
      () => page.evaluate((id) => Boolean(window.__farmingTerminalTest?.getViewport(id)), agentId),
      { timeout: 15_000 }
    ).toBe(true)

    await writeTerminalFixture(page, agentId, `${fixtureLine}\r\n`)
    await expect.poll(async () => (await terminalRows(page, agentId, 40)).join('\n')).toContain(selectedText)

    const rows = await terminalRows(page, agentId, 40)
    const rowIndex = rows.findIndex(row => row.includes(selectedText))
    if (rowIndex < 0) throw new Error(`Mixed-language copy fixture row is missing: ${JSON.stringify(rows)}`)

    const startCol = rows[rowIndex].indexOf('MetaInfoGen')
    const startCell = await terminalCellCenter(page, agentId, startCol, rowIndex)
    const endCell = await terminalCellCenter(page, agentId, startCol + selectedText.length + 16, rowIndex)

    await page.mouse.move(startCell.x, startCell.y)
    await page.mouse.down()
    await page.mouse.move(endCell.x, endCell.y, { steps: 12 })
    await page.mouse.up()

    await expect.poll(async () => page.evaluate((id) => {
      return window.__farmingTerminalTest?.getSelection(id) ?? ''
    }, agentId)).toContain('MetaInfoGen.visit')

    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(page.url()).origin })
    await page.mouse.click(endCell.x, endCell.y, { button: 'right' })
    const terminalContextMenu = page.getByTestId('code-terminal-context-menu')
    await expect(terminalContextMenu).toBeVisible()
    await terminalContextMenu.getByRole('menuitem', { name: /Copy|复制/ }).click()
    await expect.poll(async () => page.evaluate(() => navigator.clipboard.readText().then(text => text.trimEnd())))
      .toBe(selectedText)
  })

  test('opens and copies hard-wrapped terminal URLs', async ({ page, workspaceRoot }) => {
    const url = 'http://example.internal:39401/farming/?token=example-token'
    const splitAt = url.indexOf('example-token') + 'example'.length
    const hardWrappedUrl = `${url.slice(0, splitAt + 2)}\r\n${url.slice(splitAt + 2)}`

    await openFarming(page)
    await openNewAgentDialog(page)
    const agentId = await startAgentFromOpenDialog(page, 'codex', workspaceRoot)

    await expect.poll(
      () => page.evaluate((id) => Boolean(window.__farmingTerminalTest?.getViewport(id)), agentId),
      { timeout: 15_000 }
    ).toBe(true)

    await page.evaluate(() => {
      const target = window as unknown as {
        __originalOpenForTerminalUrlTest?: typeof window.open
        __openedTerminalUrls?: string[]
      }
      target.__originalOpenForTerminalUrlTest = window.open
      target.__openedTerminalUrls = []
      window.open = ((openedUrl?: string | URL) => {
        target.__openedTerminalUrls?.push(String(openedUrl ?? ''))
        return null
      }) as typeof window.open
    })

    await writeTerminalFixture(page, agentId, `> echo link\r\n${hardWrappedUrl}\r\n`)
    const rows = await terminalRows(page, agentId, 40)
    const wrappedHit = rows
      .map((row, rowIndex) => {
        const fragment = row.includes('example-t') ? 'example-t' : ''
        return fragment ? { row: rowIndex, col: row.indexOf(fragment) + 2 } : null
      })
      .find((hit): hit is { row: number; col: number } => Boolean(hit))
    if (!wrappedHit) {
      throw new Error(`Hard-wrapped terminal URL fixture row is missing: ${JSON.stringify(rows)}`)
    }

    const urlCell = await terminalCellCenter(page, agentId, wrappedHit.col, wrappedHit.row)
    const urlOpenModifier = process.platform === 'darwin' ? 'Meta' : 'Control'
    await page.keyboard.down(urlOpenModifier)
    await page.mouse.click(urlCell.x, urlCell.y)
    await page.keyboard.up(urlOpenModifier)
    await expect.poll(async () => page.evaluate(() => {
      return (window as unknown as { __openedTerminalUrls?: string[] }).__openedTerminalUrls ?? []
    })).toContain(url)

    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(page.url()).origin })
    await page.mouse.click(urlCell.x, urlCell.y, { button: 'right' })
    const terminalContextMenu = page.getByTestId('code-terminal-context-menu')
    await expect(terminalContextMenu).toBeVisible()
    await terminalContextMenu.getByRole('menuitem', { name: /Copy|复制/ }).click()
    await expect.poll(async () => page.evaluate(() => navigator.clipboard.readText())).toBe(url)

    await page.evaluate(() => {
      const target = window as unknown as { __originalOpenForTerminalUrlTest?: typeof window.open }
      if (target.__originalOpenForTerminalUrlTest) {
        window.open = target.__originalOpenForTerminalUrlTest
      }
    })
  })

  test('delivers background shell output while another agent stays active', async ({ page, workspaceRoot }) => {
    const firstWorkspace = path.join(workspaceRoot, 'first-agent')
    const secondWorkspace = path.join(workspaceRoot, 'second-agent')
    fs.mkdirSync(firstWorkspace, { recursive: true })
    fs.mkdirSync(secondWorkspace, { recursive: true })

    await openFarming(page)
    const createAgent = async (workspace: string) => {
      const response = await page.request.post('/farming/api/control/agents', {
        data: { command: 'bash', workspace },
      })
      expect(response.ok()).toBeTruthy()
      const data = await response.json() as { agentId?: string }
      expect(data.agentId).toBeTruthy()
      return data.agentId as string
    }

    const firstAgentId = await createAgent(firstWorkspace)
    const secondAgentId = await createAgent(secondWorkspace)
    const firstRow = page.locator(`[data-testid="code-agent-row"][data-agent-id="${firstAgentId}"]`)
    const secondRow = page.locator(`[data-testid="code-agent-row"][data-agent-id="${secondAgentId}"]`)

    await expect(firstRow).toBeVisible()
    await expect(secondRow).toBeVisible()
    await page.goto(`/farming/?agent=${encodeURIComponent(secondAgentId)}`, { waitUntil: 'networkidle' })
    await expect(secondRow).toHaveClass(/active/)
    const inputResponse = await page.request.post(`/farming/api/control/agents/${firstAgentId}/input`, {
      data: { input: 'echo first-agent-output\r' },
    })
    expect(inputResponse.ok()).toBeTruthy()

    await expect.poll(async () => {
      const response = await page.request.get(`/farming/api/control/agents/${firstAgentId}/output?tail=2000`)
      return response.ok() ? (await response.text()).includes('first-agent-output') : false
    }).toBe(true)
    await expect(secondRow).toHaveClass(/active/)
    await expect(firstRow).not.toHaveClass(/active/)

  })

  test('keeps rename input selection stable while typing', async ({ page, workspaceRoot }) => {
    await openFarming(page)
    const response = await page.request.post('/farming/api/control/agents', {
      data: { command: 'bash', workspace: workspaceRoot },
    })
    expect(response.ok()).toBeTruthy()

    const row = page.getByTestId('code-agent-row').first()
    await expect(row).toBeVisible()
    await row.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Rename Agent' }).click()

    const input = page.getByTestId('code-rename-input')
    await expect(input).toBeFocused()
    await page.keyboard.type('X')
    await expect(input).toHaveValue('X')
    await expect.poll(() => input.evaluate(element => {
      const textInput = element as HTMLInputElement
      return `${textInput.selectionStart}:${textInput.selectionEnd}`
    })).toBe('1:1')

    await page.keyboard.type('Y')
    await expect(input).toHaveValue('XY')
  })

  test('keeps Codex skin shortcut hints and global captures off by default', async ({ page, workspaceRoot }) => {
    await openFarming(page)
    await openNewAgentDialog(page)
    const agentId = await startAgentFromOpenDialog(page, 'codex', workspaceRoot)

    await expect(page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)).toBeVisible()
    await expect(page.locator('[data-testid="code-sidebar"] kbd')).toHaveCount(0)

    const textarea = page.getByTestId('code-composer').locator('textarea')
    await textarea.focus()
    await page.keyboard.type('n/01[]')
    await expect(textarea).toHaveValue('n/01[]')
    await expect(page.getByTestId('input-dialog')).toBeHidden()
    await expect(page.getByTestId('code-search-box')).toHaveCount(0)

    await textarea.evaluate(element => (element as HTMLTextAreaElement).blur())
    await page.keyboard.press('n')
    await page.keyboard.press('/')
    await expect(page.getByTestId('input-dialog')).toBeHidden()
    await expect(page.getByTestId('code-search-box')).toHaveCount(0)
  })

  test('inserts Codex slash commands from the composer and sends them through the terminal', async ({ page, workspaceRoot }) => {
    const skillDir = path.join(workspaceRoot, '.agents', 'skills', 'pdf')
    fs.mkdirSync(skillDir, { recursive: true })
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), [
      '---',
      'name: pdf',
      'description: Read, create, render, and verify PDF files',
      '---',
      'PDF skill body should stay server-side.',
      '',
    ].join('\n'))

    await openFarming(page)
    await openNewAgentDialog(page)
    const agentId = await startAgentFromOpenDialog(page, 'codex', workspaceRoot)

    const textarea = page.getByTestId('code-composer').locator('textarea')
    await textarea.fill('Use $pd')
    await expect(page.getByTestId('code-slash-menu')).toBeVisible()
    await expect(page.getByTestId('code-slash-menu')).toContainText('Skills')
    await expect(page.getByTestId('code-slash-command-pdf')).toBeVisible()
    await expect(page.getByTestId('code-slash-command-goal')).toHaveCount(0)
    await expect(page.getByTestId('code-slash-menu')).not.toContainText('PDF skill body')
    await textarea.press('Enter')
    await expect(textarea).toHaveValue('Use $pdf ')
    await textarea.fill('')

    await textarea.fill('/g')
    await expect(page.getByTestId('code-slash-menu')).toBeVisible()
    await expect(page.getByTestId('code-slash-menu')).toContainText('Commands')
    await expect(page.getByTestId('code-slash-command-goal')).toBeVisible()
    await expect(page.getByTestId('code-slash-command-permissions')).toHaveCount(0)
    await textarea.press('Enter')
    await expect(textarea).toHaveValue('/goal ')
    await expect(page.getByTestId('code-slash-menu')).toBeHidden()

    await textarea.fill('/goal ship slash commands')
    await expect(textarea).toHaveValue('/goal ship slash commands')
    await page.getByTestId('code-composer-send').click()
    if (await page.getByTestId('code-pending-followup').count() > 0) {
      await page.getByTestId('code-pending-followup-steer').first().click()
    }
    await expect.poll(() => sessionText(page, agentId)).toContain('/goal ship slash commands')
  })

  test('shows Claude Code as an available launch option without starting it', async ({ page }) => {
    await openFarming(page)
    await openNewAgentDialog(page)
    await expect(page.getByTestId('agent-option-codex').locator('.agent-launch-icon-codex')).toBeVisible()
    await expect(page.getByTestId('agent-option-claude')).toContainText('Claude Code')
    await expect(page.getByTestId('agent-option-claude').locator('.agent-launch-icon-claude')).toBeVisible()
    await expect(page.getByTestId('agent-option-bash').locator('.agent-launch-icon-bash')).toBeVisible()
    await expect(page.getByTestId('agent-option-zsh').locator('.agent-launch-icon-zsh')).toBeVisible()
    await expect(page.getByTestId('code-agent-row')).toHaveCount(0)
  })

  test('keeps a newly created shell active when another agent is already open', async ({ page, workspaceRoot }) => {
    await openFarming(page)
    const projectDir = path.join(workspaceRoot, 'selection-race')
    fs.mkdirSync(projectDir, { recursive: true })

    await openNewAgentDialog(page)
    const bashAgentId = await startAgentFromOpenDialog(page, 'bash', projectDir)
    await expect(page.locator(`[data-testid="code-agent-row"][data-agent-id="${bashAgentId}"]`)).toHaveClass(/active/)

    await openNewAgentDialog(page)
    const secondBashAgentId = await startAgentFromOpenDialog(page, 'bash', projectDir)
    await expect(page.locator(`[data-testid="code-agent-row"][data-agent-id="${secondBashAgentId}"]`)).toHaveClass(/active/)
    await expect(page.locator(`[data-testid="code-terminal-pane"][data-agent-id="${secondBashAgentId}"]`)).toBeVisible()
    await expect(page.locator(`[data-testid="code-agent-row"][data-agent-id="${bashAgentId}"]`)).not.toHaveClass(/active/)
  })

  test('activates a same-worktree fork instead of falling back to the previously active shell', async ({ page, workspaceRoot }) => {
    await openFarming(page)
    const projectDir = path.join(workspaceRoot, 'fork-selection-race')
    fs.mkdirSync(projectDir, { recursive: true })

    await openNewAgentDialog(page)
    const bashAgentId = await startAgentFromOpenDialog(page, 'bash', projectDir)
    await openNewAgentDialog(page)
    const secondBashAgentId = await startAgentFromOpenDialog(page, 'bash', projectDir)
    const beforeIds = new Set(await getAgentRowIds(page))

    await page.locator(`[data-testid="code-agent-row"][data-agent-id="${bashAgentId}"]`).click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Fork into same worktree' }).click()
    await expect.poll(async () => (
      (await getAgentRowIds(page)).find(agentId => !beforeIds.has(agentId)) ?? ''
    ), { timeout: 30_000 }).not.toBe('')

    const createdAgentId = (await getAgentRowIds(page)).find(agentId => !beforeIds.has(agentId))
    if (!createdAgentId) throw new Error('Forked agent row is missing')
    await expect(page.locator(`[data-testid="code-agent-row"][data-agent-id="${createdAgentId}"]`)).toHaveClass(/active/)
    await expect(page.locator(`[data-testid="code-terminal-pane"][data-agent-id="${createdAgentId}"]`)).toBeVisible()
    await expect(page.locator(`[data-testid="code-agent-row"][data-agent-id="${secondBashAgentId}"]`)).not.toHaveClass(/active/)
  })

  test('opens an existing project agent and completes a real file edit through the terminal', async ({ page, workspaceRoot }) => {
    const projectDir = path.join(workspaceRoot, 'tiny-feature')
    fs.mkdirSync(projectDir, { recursive: true })
    const appFile = path.join(projectDir, 'app.js')
    fs.writeFileSync(appFile, [
      'function greet(name) {',
      '  return `hello ${name}`',
      '}',
      '',
      'module.exports = { greet }',
      '',
    ].join('\n'))

    await openFarming(page)
    await openNewAgentDialog(page)
    const codexAgentId = await startAgentFromOpenDialog(page, 'codex', projectDir)
    await expect(page.locator(`[data-testid="code-agent-row"][data-agent-id="${codexAgentId}"]`)).toBeVisible()

    await openNewAgentDialog(page)
    const bashAgentId = await startAgentFromOpenDialog(page, 'bash', projectDir)

    await expect.poll(() => page.getByTestId('code-agent-row').count()).toBeGreaterThanOrEqual(2)
    await page.locator(`[data-testid="code-agent-row"][data-agent-id="${bashAgentId}"]`).click()
    await expect(page.locator(`[data-testid="code-agent-row"][data-agent-id="${bashAgentId}"]`)).toHaveClass(/active/)
    await expect(page.locator(`[data-testid="code-terminal-pane"][data-agent-id="${bashAgentId}"]`)).toBeVisible()
    await expect(page.getByTestId('code-composer').locator('textarea')).toBeEnabled()
    await expect.poll(async () => (await terminalRows(page, bashAgentId, 20)).join('\n')).toContain('$')

    const command = [
      'node -e "',
      "const fs=require('fs');",
      "fs.appendFileSync('app.js', '\\nconsole.log(greet(\\\"Farming\\\"))\\n');",
      '"',
    ].join(' ')
    await page.getByTestId('code-composer').locator('textarea').fill(command)
    await page.getByTestId('code-composer-send').click()

    await expect.poll(() => fs.readFileSync(appFile, 'utf8')).toContain('console.log(greet("Farming"))')
    const text = await sessionText(page, bashAgentId)
    expect(text).toContain('node -e')
    expect(text).toContain('Farming')
  })

  test('keeps pooled terminal hosts isolated while switching agents', async ({ page, workspaceRoot }) => {
    const projectDir = path.join(workspaceRoot, 'terminal-isolation')
    fs.mkdirSync(projectDir, { recursive: true })

    await openFarming(page)
    await openNewAgentDialog(page)
    const codexAgentId = await startAgentFromOpenDialog(page, 'codex', projectDir)

    const codexMarker = `CODEX_ONLY_PANEL_${Date.now()}`
    await writeTerminalFixture(page, codexAgentId, [
      'OpenAI Codex fixture banner',
      `${codexMarker} ${'right-edge-codex'.repeat(8)}`,
      '',
    ].join('\r\n'))

    await openNewAgentDialog(page)
    const bashAgentId = await startAgentFromOpenDialog(page, 'bash', projectDir)
    await expect.poll(() => page.getByTestId('code-agent-row').count()).toBeGreaterThanOrEqual(2)

    const bashMarker = `BASH_ONLY_PANEL_${Date.now()}`
    await writeTerminalFixture(page, bashAgentId, [
      '[admin@test terminal-isolation]',
      `$ git status --short ${bashMarker}`,
      'nothing added to commit but untracked files present',
      '',
    ].join('\r\n'))

    async function expectIsolatedActiveHost(activeAgentId: string) {
      await expect(page.locator(
        `[data-testid="code-terminal-pane"][data-agent-id="${activeAgentId}"] .terminal-session-host[data-agent-id="${activeAgentId}"]`
      )).toBeVisible({ timeout: 15_000 })
      const diagnostics = await terminalHostDiagnostics(page)
      const visibleHosts = diagnostics.filter(host => host.visible && !host.inParkingLot)
      expect(visibleHosts).toEqual([
        expect.objectContaining({
          agentId: activeAgentId,
          paneAgentId: activeAgentId,
          hostCountInMount: 1,
        }),
      ])
    }

    await page.locator(`[data-testid="code-agent-row"][data-agent-id="${codexAgentId}"]`).click()
    await expectIsolatedActiveHost(codexAgentId)
    const codexRows = (await terminalRows(page, codexAgentId, 40)).join('\n')
    expect(codexRows).toContain(codexMarker)
    expect(codexRows).not.toContain(bashMarker)

    await page.locator(`[data-testid="code-agent-row"][data-agent-id="${bashAgentId}"]`).click()
    await expectIsolatedActiveHost(bashAgentId)
    const bashRows = (await terminalRows(page, bashAgentId, 40)).join('\n')
    expect(bashRows).toContain(bashMarker)
    expect(bashRows).not.toContain(codexMarker)
  })
})
