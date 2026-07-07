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
