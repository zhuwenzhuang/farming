import { expect, openFarming, terminalRows, test } from '../fixtures'

type TerminalSnapshotCell = {
  char: string
  width: number
}

function rowCells(text: string): TerminalSnapshotCell[] {
  return text.split('').map(char => ({ char, width: 1 }))
}

function snapshotFromRows(rows: string[], cols = 80) {
  return {
    cols,
    rows: Math.max(rows.length, 1),
    viewportY: 0,
    cursorX: 0,
    cursorY: Math.max(0, rows.length - 1),
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

async function selectAgent(page: import('@playwright/test').Page, agentId: string) {
  const row = page.locator(`[data-testid="codex-agent-row"][data-agent-id="${agentId}"]`)
  await expect(row).toBeVisible({ timeout: 30_000 })
  await row.click()
  await expect(page.locator(`[data-testid="codex-terminal-pane"][data-agent-id="${agentId}"]`))
    .toBeVisible({ timeout: 15_000 })
}

async function visibleTerminalText(page: import('@playwright/test').Page, agentId: string, rowCount = 40) {
  return (await terminalRows(page, agentId, rowCount)).join('\n')
}

function hasWrappedPromptFragments(text: string) {
  return text.includes('[dev@example\n /workspaces') ||
    text.includes('example-\nproject]')
}

test.describe('terminal recovery fixtures', () => {
  test('recovers a prompt without keeping narrow snapshot fragments', async ({ page, workspaceRoot }) => {
    const agentId = await createControlAgent(page, 'bash', workspaceRoot)
    let sessionViewCalls = 0
    await page.route(new RegExp(`/farming/api/agents/${agentId}/session-view$`), async route => {
      sessionViewCalls += 1
      const narrowRows = [
        '[dev@example',
        ' /workspaces',
        '/example-',
        'project]',
        '$  ',
      ]
      const wideRows = [
        '',
        '',
        '[dev@example /workspaces/example-project]',
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

    await openFarming(page)
    await selectAgent(page, agentId)
    await expect(page.locator(`[data-agent-id="${agentId}"] .xterm`)).toBeVisible({ timeout: 20_000 })
    await expect.poll(() => sessionViewCalls, { timeout: 15_000 }).toBe(1)

    const text = await visibleTerminalText(page, agentId)
    expect(text).toContain('[dev@example /workspaces/example-project]')
    expect(hasWrappedPromptFragments(text)).toBe(false)
  })
})
