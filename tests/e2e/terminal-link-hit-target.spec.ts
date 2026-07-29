import fs from 'node:fs'
import path from 'node:path'
import { expect, openFarming, terminalRows, test, writeTerminalFixture } from './fixtures'

async function createControlAgent(page: import('@playwright/test').Page, command: string, workspace: string) {
  const response = await page.request.post('/farming/api/control/agents', {
    data: { command, workspace },
  })
  expect(response.ok()).toBeTruthy()
  const data = await response.json() as { agentId?: string }
  expect(data.agentId).toBeTruthy()
  return data.agentId as string
}

async function selectAgent(page: import('@playwright/test').Page, agentId: string) {
  const row = page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
  await expect(row).toBeVisible({ timeout: 30_000 })
  await row.click()
  await expect(row).toHaveClass(/active/)
  await expect(page.locator(`[data-testid="code-terminal-pane"][data-agent-id="${agentId}"]`)).toBeVisible()
}

async function cellForText(
  page: import('@playwright/test').Page,
  agentId: string,
  text: string,
  offset = 1,
) {
  const rows = await terminalRows(page, agentId, 40)
  for (let row = 0; row < rows.length; row += 1) {
    const col = rows[row]?.indexOf(text) ?? -1
    if (col < 0) continue
    const cell = await page.evaluate(({ id, x, y }) => {
      return window.__farmingTerminalTest?.getCellCenter(id, x, y) ?? null
    }, { id: agentId, x: col + offset, y: row })
    if (cell) return { ...cell, row, col: col + offset }
  }
  throw new Error(`Could not find terminal text ${text}: ${JSON.stringify(rows)}`)
}

async function terminalOpenTargetState(page: import('@playwright/test').Page, agentId: string) {
  return page.evaluate((id) => {
    const host = document.querySelector(`.terminal-session-host[data-agent-id="${CSS.escape(id)}"]`)
    if (!(host instanceof HTMLElement)) return null
    return {
      hover: host.classList.contains('terminal-open-target-hover'),
      target: host.dataset.terminalOpenTarget || '',
      title: host.getAttribute('title') || '',
    }
  }, agentId)
}

test('terminal path affordance clears on same-line blank cells', async ({ page, workspaceRoot }) => {
  const projectDir = path.join(workspaceRoot, 'terminal-link-hit-target')
  fs.mkdirSync(projectDir, { recursive: true })
  fs.writeFileSync(path.join(projectDir, 'README.md'), ['# Link Target', 'one', 'two'].join('\n'))

  const agentId = await createControlAgent(page, 'bash', projectDir)
  await openFarming(page)
  await selectAgent(page, agentId)
  await writeTerminalFixture(page, agentId, 'README.md:3:1 failed\r\n')

  const pathCell = await cellForText(page, agentId, 'README.md', 2)
  await page.mouse.move(pathCell.x, pathCell.y)
  await expect.poll(async () => terminalOpenTargetState(page, agentId)).toEqual(expect.objectContaining({
    hover: true,
    target: 'path',
  }))

  const blankCell = await page.evaluate(({ id, row }) => {
    return window.__farmingTerminalTest?.getCellCenter(id, 30, row) ?? null
  }, { id: agentId, row: pathCell.row })
  if (!blankCell) throw new Error('Terminal blank cell beside path fixture is missing')

  await page.mouse.move(blankCell.x, blankCell.y)
  await expect.poll(async () => terminalOpenTargetState(page, agentId)).toEqual({
    hover: false,
    target: '',
    title: '',
  })

  await page.mouse.click(blankCell.x, blankCell.y)
  await expect(page.getByTestId('code-file-editor')).toBeHidden()

  await page.mouse.click(pathCell.x, pathCell.y)
  await expect(page.getByTestId('code-file-editor')).toBeVisible()
  await expect(page.getByTestId('code-file-editor').getByRole('tab', { selected: true })).toContainText('README.md')
})

test('modifier-click releases xterm selection tracking after opening a URL', async ({ page, workspaceRoot }) => {
  const projectDir = path.join(workspaceRoot, 'terminal-modifier-click-release')
  fs.mkdirSync(projectDir, { recursive: true })

  const agentId = await createControlAgent(page, 'bash', projectDir)
  await openFarming(page)
  await selectAgent(page, agentId)

  const url = 'https://example.test/path'
  await page.evaluate(() => {
    const target = window as unknown as {
      __openedTerminalUrls?: string[]
      __originalOpenForTerminalReleaseTest?: typeof window.open
    }
    target.__openedTerminalUrls = []
    target.__originalOpenForTerminalReleaseTest = window.open
    window.open = ((openedUrl?: string | URL) => {
      target.__openedTerminalUrls?.push(String(openedUrl ?? ''))
      return null
    }) as typeof window.open
  })

  try {
    await writeTerminalFixture(page, agentId, `${url}\r\n`)
    const urlCell = await cellForText(page, agentId, 'example.test', 2)
    await expect.poll(async () => page.evaluate(({ id, col, row }) => {
      return window.__farmingTerminalTest?.getUrlAtCell(id, col, row) ?? null
    }, { id: agentId, col: urlCell.col, row: urlCell.row })).toBe(url)

    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
    await page.keyboard.down(modifier)
    try {
      await page.mouse.click(urlCell.x, urlCell.y)
    } finally {
      await page.keyboard.up(modifier)
    }
    await expect.poll(async () => page.evaluate(() => {
      return (window as unknown as { __openedTerminalUrls?: string[] }).__openedTerminalUrls ?? []
    })).toEqual([url])

    const cols = await page.evaluate((id) => (
      window.__farmingTerminalTest?.getBufferDiagnostics(id)?.cols ?? 0
    ), agentId)
    expect(cols).toBeGreaterThan(40)
    const linePrefix = '- CR: '
    const reviewUrlPrefix = 'https://example.test/review/'
    const reviewUrl = reviewUrlPrefix + '2'.repeat(Math.max(1, cols - 2 - linePrefix.length - reviewUrlPrefix.length))
    await writeTerminalFixture(page, agentId, [
      `${linePrefix}${reviewUrl}`,
      '- final commit: abc',
      '- commit message: fixed',
      '- review comment: 123',
      '- rollback confirmed',
      '',
    ].join('\r\n'))
    const reviewUrlCell = await cellForText(page, agentId, 'example.test', 2)
    await expect.poll(async () => page.evaluate(({ id, col, row }) => {
      return window.__farmingTerminalTest?.getUrlAtCell(id, col, row) ?? null
    }, { id: agentId, col: reviewUrlCell.col, row: reviewUrlCell.row })).toBe(reviewUrl)

    await page.keyboard.down(modifier)
    try {
      await page.mouse.click(reviewUrlCell.x, reviewUrlCell.y)
    } finally {
      await page.keyboard.up(modifier)
    }
    await expect.poll(async () => page.evaluate(() => {
      return (window as unknown as { __openedTerminalUrls?: string[] }).__openedTerminalUrls ?? []
    })).toEqual([url, reviewUrl])

    const softWrappedUrl = `https://example.test/${Array.from(
      { length: 48 },
      (_, index) => `segment-${String(index).padStart(2, '0')}`,
    ).join('/')}`
    await writeTerminalFixture(page, agentId, `${softWrappedUrl}\r\n`)
    const wrappedCell = await cellForText(page, agentId, 'segment-30', 2)
    expect(wrappedCell.row).toBeGreaterThan(0)
    await expect.poll(async () => page.evaluate(({ id, col, row }) => {
      return window.__farmingTerminalTest?.getUrlAtCell(id, col, row) ?? null
    }, { id: agentId, col: wrappedCell.col, row: wrappedCell.row })).toBe(softWrappedUrl)

    const releaseProbe = await page.evaluate(({ id, row }) => {
      return window.__farmingTerminalTest?.getCellCenter(id, 0, row) ?? null
    }, { id: agentId, row: wrappedCell.row })
    if (!releaseProbe) throw new Error('Terminal mouse-release probe cell is missing')
    await page.mouse.move(releaseProbe.x, releaseProbe.y)
    await expect.poll(async () => page.evaluate((id) => {
      return window.__farmingTerminalTest?.getSelection(id) ?? ''
    }, agentId)).toBe('')
  } finally {
    await page.evaluate(() => {
      const target = window as unknown as {
        __originalOpenForTerminalReleaseTest?: typeof window.open
      }
      if (target.__originalOpenForTerminalReleaseTest) {
        window.open = target.__originalOpenForTerminalReleaseTest
      }
    })
  }
})

test('terminal word fallback opens Project Files search only with the open modifier', async ({ page, workspaceRoot }) => {
  const projectDir = path.join(workspaceRoot, 'terminal-word-search')
  fs.mkdirSync(projectDir, { recursive: true })
  fs.writeFileSync(path.join(projectDir, 'needle-result.txt'), 'needle-result\n')

  const agentId = await createControlAgent(page, 'bash', projectDir)
  await openFarming(page)
  await selectAgent(page, agentId)
  await writeTerminalFixture(page, agentId, 'needle-result\r\n')

  const wordCell = await cellForText(page, agentId, 'needle-result', 2)
  await page.mouse.move(wordCell.x, wordCell.y)
  await expect.poll(async () => terminalOpenTargetState(page, agentId)).toEqual({
    hover: false,
    target: '',
    title: '',
  })

  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
  await page.keyboard.down(modifier)
  try {
    await page.mouse.move(wordCell.x, wordCell.y)
    await expect.poll(async () => terminalOpenTargetState(page, agentId)).toEqual(expect.objectContaining({
      hover: true,
      target: 'search',
    }))
    await page.mouse.click(wordCell.x, wordCell.y)
  } finally {
    await page.keyboard.up(modifier)
  }

  await expect(page.getByPlaceholder('Search or path:line')).toHaveValue('needle-result')
})

test('terminal multiline diagnostics bind numeric results to the preceding file', async ({ page, workspaceRoot }) => {
  const projectDir = path.join(workspaceRoot, 'terminal-multiline-link')
  const fileName = 'parser with spaces.ts'
  fs.mkdirSync(projectDir, { recursive: true })
  fs.writeFileSync(path.join(projectDir, fileName), ['one', 'two value', 'three'].join('\n'))

  const agentId = await createControlAgent(page, 'bash', projectDir)
  await openFarming(page)
  await selectAgent(page, agentId)
  await writeTerminalFixture(page, agentId, `${fileName}\r\n  2:3  error Unexpected token\r\n`)

  const diagnosticCell = await cellForText(page, agentId, '2:3', 1)
  await expect.poll(async () => page.evaluate(({ id, col, row }) => {
    return window.__farmingTerminalTest?.getPathAtCell(id, col, row) ?? null
  }, {
    id: agentId,
    col: diagnosticCell.col,
    row: diagnosticCell.row,
  })).toEqual({
    path: fileName,
    lineNumber: 2,
    column: 3,
  })

  await page.mouse.click(diagnosticCell.x, diagnosticCell.y)
  await expect(page.getByTestId('code-file-editor')).toBeVisible()
  await expect(page.getByTestId('code-file-editor').getByRole('tab', { selected: true })).toContainText(fileName)
  await expect(page.getByTestId('code-file-editor-statusbar')).toContainText('Ln 2, Col 3')
})
