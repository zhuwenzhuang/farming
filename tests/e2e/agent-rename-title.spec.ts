import fs from 'node:fs'
import path from 'node:path'
import { expect, openFarming, test } from './fixtures'

test('rename preserves the complete title through cancel and unchanged save in every appearance', async ({ page, workspaceRoot }, testInfo) => {
  const workspace = path.join(workspaceRoot, 'rename-title')
  fs.mkdirSync(workspace, { recursive: true })
  const created = await page.request.post('/farming/api/control/agents', {
    data: { command: 'bash', workspace },
  })
  expect(created.ok()).toBeTruthy()
  const { agentId } = await created.json() as { agentId: string }
  const title = '验证反复 ALTER 与 auto cluster 写入兼容性：完整标题不会丢失'
  const renamed = await page.request.patch(`/farming/api/agents/${agentId}`, {
    data: { customTitle: title },
  })
  expect(renamed.ok()).toBeTruthy()
  await openFarming(page)
  const row = page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
  const input = page.getByTestId('code-rename-input')
  const dialog = page.getByTestId('code-rename-dialog')
  for (const appearance of ['light', 'dark', 'paper']) {
    await page.evaluate(value => {
      document.documentElement.dataset.appearance = value
      document.body.dataset.appearance = value
    }, appearance)
    await row.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Rename Agent', exact: true }).click()
    await expect(input).toHaveValue(title)
    await expect(input).toBeFocused()
    await dialog.screenshot({ path: testInfo.outputPath(`rename-${appearance}.png`), animations: 'disabled' })
    await input.fill('cancelled edit')
    await input.press('Escape')
    await expect(row.locator('.code-agent-name')).toHaveText(title)

    await row.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Rename Agent', exact: true }).click()
    await expect(input).toHaveValue(title)
    const saved = page.waitForResponse(response => response.url().endsWith(`/api/agents/${agentId}`)
      && response.request().method() === 'PATCH')
    await dialog.getByRole('button', { name: 'Save', exact: true }).click()
    expect((await saved).ok()).toBeTruthy()
    await expect(dialog).toBeHidden()
    await page.reload()
    await expect(row.locator('.code-agent-name')).toHaveText(title)
  }
})
