import fs from 'node:fs'
import path from 'node:path'
import { expect, openFarming, test } from './fixtures'

for (const { surface, appearance } of [
  { surface: 'code', appearance: 'light' },
  { surface: 'code', appearance: 'dark' },
  { surface: 'code', appearance: 'paper' },
  { surface: 'crt', appearance: 'default' },
] as const) {
  test(`streaming table links keep column widths stable in ${surface} ${appearance}`, async ({ page, workspaceRoot }, testInfo) => {
    const workspace = path.join(workspaceRoot, 'table-links')
    fs.mkdirSync(workspace, { recursive: true })
    const gate = path.join(workspace, '.table-link-stage')
    const response = await page.request.post('/farming/api/control/agents', {
      data: { command: 'claude', workspace, agentRuntimeMode: 'chat' },
    })
    expect(response.ok()).toBeTruthy()
    const { agentId } = await response.json() as { agentId: string }
    await openFarming(page)
    if (surface === 'crt') {
      await page.goto(`/farming/crt/?agent=${encodeURIComponent(agentId)}`)
      await page.locator('#crt-structured-input').fill('streaming table links')
      await page.locator('#crt-structured-input').press('Enter')
    } else {
      if (await page.getByTestId('code-mobile-menu').isVisible()) await page.getByTestId('code-mobile-menu').click()
      await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
      await page.evaluate(value => { document.body.dataset.appearance = value }, appearance)
      await page.getByTestId('code-acp-composer-input').fill('streaming table links')
      await page.getByTestId('code-acp-composer-send').click()
    }
    const answer = surface === 'code' ? page.locator('.code-agent-transcript-assistant').last() : page.locator('.crt-structured-transcript')
    const table = answer.locator('table')
    try {
      await expect(table).toContainText('customer_address')
      await expect(table).not.toContainText('https://')
      const widths = () => table.locator('th').evaluateAll(cells => cells.map(cell => cell.getBoundingClientRect().width))
      const initial = await widths()
      fs.writeFileSync(gate, '1')
      await expect.poll(() => fs.existsSync(gate + '.ack') ? fs.readFileSync(gate + '.ack', 'utf8') : '').toBe('1')
      await expect(table).not.toContainText('query=')
      await expect.poll(widths).toEqual(initial)
      await testInfo.attach(`pending-${appearance}`, { body: await table.screenshot({ path: testInfo.outputPath(`table-${appearance}-pending.png`) }), contentType: 'image/png' })
      fs.writeFileSync(gate, '2')
      await expect(table.getByRole('link', { name: '34.44 s' })).toHaveAttribute('href', /query=x{240}$/)
      await testInfo.attach(`closed-${appearance}`, { body: await table.screenshot({ path: testInfo.outputPath(`table-${appearance}-closed.png`) }), contentType: 'image/png' })
    } finally {
      fs.writeFileSync(gate, '2')
    }
  })
}
