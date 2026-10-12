import fs from 'node:fs'
import path from 'node:path'
import { expect, openFarming, test } from './fixtures'

for (const appearance of ['light', 'dark', 'paper']) {
  test(`hands off to another provider and Home with a read-first prompt in ${appearance}`, async ({ page, workspaceRoot }) => {
    if (appearance === 'light') {
      // LAN HTTP does not expose the secure-context randomUUID API. The same
      // request identity must still survive the uncertain-response retry below.
      await page.addInitScript(() => {
        Object.defineProperty(Crypto.prototype, 'randomUUID', { value: undefined, configurable: true })
      })
    }
    const workspace = path.join(workspaceRoot, 'handoff-demo')
    const targetHome = path.join(workspaceRoot, `handoff-home-${appearance}`)
    const homeId = `handoff-${appearance}`
    fs.mkdirSync(workspace, { recursive: true })
    fs.mkdirSync(targetHome, { recursive: true })
    const settings = (await (await page.request.get('/farming/api/settings')).json()).settings
    const configured = await page.request.post('/farming/api/settings', { data: {
      appearance,
      agentHomes: {
        ...settings.agentHomes,
        claude: [...settings.agentHomes.claude, { id: homeId, path: targetHome, order: 10 }],
      },
    } })
    expect(configured.ok(), await configured.text()).toBeTruthy()
    const created = await page.request.post('/farming/api/control/agents', { data: {
      command: 'codex', workspace, agentRuntimeMode: 'chat',
    } })
    expect(created.ok()).toBeTruthy()
    const sourceId = (await created.json()).agentId as string
    const submitted = await page.request.post(`/farming/api/control/agents/${sourceId}/messages`, { data: {
      message: '请先检查项目，暂时不要修改文件。', requestId: `source-${appearance}`,
    } })
    expect(submitted.ok(), await submitted.text()).toBeTruthy()
    await openFarming(page)
    const sourceRow = page.locator(`[data-testid="code-agent-row"][data-agent-id="${sourceId}"]`)
    await expect(sourceRow).toBeVisible()
    await sourceRow.click({ button: 'right' })
    const menu = page.getByTestId('code-agent-context-menu')
    const handoff = menu.getByRole('menuitem', { name: 'Hand off to new Agent', exact: true })
    await expect(handoff).toBeEnabled()
    await expect(menu).toHaveScreenshot(`handoff-menu-${appearance}.png`)
    await handoff.click()
    const dialog = page.getByTestId('input-dialog')
    await expect(dialog.getByTestId('handoff-source-name')).toContainText('From:')
    await expect(dialog.getByTestId('agent-option-bash')).toHaveCount(0)
    await dialog.getByTestId('agent-option-claude').click()
    await dialog.getByTestId('agent-home-select').click()
    await dialog.getByRole('option').filter({ hasText: homeId }).click()
    await dialog.getByRole('button', { name: 'Chat', exact: true }).click()
    await expect(dialog.locator('input[name="workspace-path"]')).toHaveAttribute('readonly', '')
    await expect(dialog.getByTestId('workspace-directory-picker')).toHaveCount(0)
    await expect(dialog).toHaveScreenshot(`handoff-picker-${appearance}.png`, {
      mask: [dialog.locator('input[name="workspace-path"]'), dialog.locator('.workspace-home-trigger-copy > span')],
    })
    let uncertainAgentId: string | undefined
    if (appearance === 'light') {
      await page.route('**/api/control/agents', async route => {
        const delivered = await route.fetch()
        uncertainAgentId = (await delivered.json()).agentId
        await route.abort('failed')
      }, { times: 1 })
      await dialog.getByTestId('workspace-start').click()
      await expect(dialog.getByTestId('input-dialog-start-error')).toContainText('Could not confirm the handoff')
      expect(uncertainAgentId).toBeTruthy()
    }
    const responsePromise = page.waitForResponse(response => response.url().endsWith('/api/control/agents') && response.request().method() === 'POST')
    await dialog.getByTestId('workspace-start').click()
    const response = await responsePromise
    expect(response.ok(), await response.text()).toBeTruthy()
    const result = await response.json() as { agentId: string }
    if (uncertainAgentId) expect(result.agentId).toBe(uncertainAgentId)
    await expect(dialog).toBeHidden()
    const inventory = (await (await page.request.get('/farming/api/control/agents')).json()).agents
    const destination = inventory.find((agent: { id: string }) => agent.id === result.agentId)
    expect(destination).toMatchObject({
      providerSessionProvider: 'claude', providerHomeId: homeId, cwd: workspace, parentAgentId: sourceId,
    })
    expect(inventory.some((agent: { id: string }) => agent.id === sourceId)).toBeTruthy()
    expect(inventory.filter((agent: { parentAgentId: string }) => agent.parentAgentId === sourceId)).toHaveLength(1)
    const transcript = await page.request.get(`/farming/api/agents/${result.agentId}/acp-transcript?maxTurns=10`)
    const record = await transcript.text()
    expect(record).toContain('wait for the user')
    expect(record).toContain('primary language')
    expect(record).not.toMatch(/quota|exhaust/)
    const context = page.getByTestId('code-agent-handoff-context')
    await expect(context).toBeVisible()
    await expect(context).not.toHaveAttribute('open')
    await expect(context.locator('summary')).toHaveScreenshot(`handoff-context-${appearance}.png`)
    await expect(page.locator('.code-agent-transcript-user').filter({ has: context })).toHaveCount(0)
    await context.locator('summary').focus()
    await page.keyboard.press('Enter')
    await expect(context).toHaveAttribute('open', '')
    await expect(context.locator('.detail')).toContainText('wait for the user')
    await context.locator('summary').click()
    await expect(context).not.toHaveAttribute('open')
    await page.reload()
    await expect(page.getByTestId('code-agent-handoff-context')).toBeVisible()
    await expect(page.getByTestId('code-agent-handoff-context')).not.toHaveAttribute('open')
  })
}

test('captures Chinese handoff walkthrough', async ({ page, workspaceRoot }, testInfo) => {
  await page.route('**/api/workspaces/discovered?*', route => route.fulfill({ json: { workspaces: [] } }))
  const workspace = path.join(workspaceRoot, 'demo-project')
  const sourceHome = path.join(workspaceRoot, 'demo-source-home')
  const targetHome = path.join(workspaceRoot, 'demo-agent-home')
  fs.mkdirSync(workspace, { recursive: true })
  fs.mkdirSync(sourceHome, { recursive: true })
  fs.mkdirSync(targetHome, { recursive: true })
  const settings = (await (await page.request.get('/farming/api/settings')).json()).settings
  const configured = await page.request.post('/farming/api/settings', { data: {
    appearance: 'paper', language: 'zh',
    agentHomes: {
      ...settings.agentHomes,
      codex: [...settings.agentHomes.codex, { id: 'demo-source', path: sourceHome, order: 10 }],
      claude: [...settings.agentHomes.claude, { id: 'demo-home', path: targetHome, order: 10 }],
    },
  } })
  expect(configured.ok(), await configured.text()).toBeTruthy()
  const created = await page.request.post('/farming/api/control/agents', { data: {
    command: 'codex', workspace, providerHomeId: 'demo-source', agentRuntimeMode: 'chat', initialInput: '继续检查错误处理',
  } })
  expect(created.ok(), await created.text()).toBeTruthy()
  const sourceId = (await created.json()).agentId as string
  expect((await page.request.post(`/farming/api/control/agents/${sourceId}/title`, { data: { title: '原会话 · Codex' } })).ok()).toBeTruthy()
  await openFarming(page)
  const sourceRow = page.locator(`[data-testid="code-agent-row"][data-agent-id="${sourceId}"]`)
  await sourceRow.click()
  await expect(page.getByText('已继续检查：继续检查错误处理', { exact: true })).toBeVisible()
  await sourceRow.click({ button: 'right' })
  const menu = page.getByTestId('code-agent-context-menu')
  const handoff = menu.getByRole('menuitem', { name: '交接给新 Agent', exact: true })
  await expect(handoff).toBeEnabled()
  await menu.screenshot({ path: testInfo.outputPath('01-context-menu.png'), animations: 'disabled' })
  await handoff.click()
  const dialog = page.getByTestId('input-dialog')
  await expect(dialog.getByTestId('agent-option-claude')).toBeVisible()
  await expect(dialog.getByTestId('handoff-source-name')).toHaveText('来源：原会话 · Codex')
  await expect(dialog.getByText('编程 Agent', { exact: true })).toBeVisible()
  await expect(dialog.getByTestId('agent-option-bash')).toHaveCount(0)
  await dialog.screenshot({ path: testInfo.outputPath('02-agent-type.png'), animations: 'disabled' })
  await dialog.getByTestId('agent-option-claude').click()
  await dialog.getByTestId('agent-home-select').click()
  const home = dialog.getByRole('option').filter({ hasText: 'demo-home' })
  await expect(home).toBeVisible()
  await dialog.screenshot({ path: testInfo.outputPath('03-agent-home.png'), animations: 'disabled' })
  await home.click()
  await dialog.getByRole('button', { name: 'Chat', exact: true }).click()
  await expect(dialog.getByRole('group', { name: 'Claude Code 运行方式' })).toBeVisible()
  await expect(dialog.locator('input[name="workspace-path"]')).toHaveAttribute('readonly', '')
  await expect(dialog.getByTestId('workspace-directory-picker')).toHaveCount(0)
  await dialog.screenshot({ path: testInfo.outputPath('04-confirm.png'), animations: 'disabled' })
  const responsePromise = page.waitForResponse(response => response.url().endsWith('/api/control/agents') && response.request().method() === 'POST')
  await dialog.getByTestId('workspace-start').click()
  const response = await responsePromise
  expect(response.ok(), await response.text()).toBeTruthy()
  const destinationId = (await response.json()).agentId as string
  await expect(dialog).toBeHidden()
  await expect(page.getByText('这是界面演示响应：交接提示已送达。新 Agent 应先阅读原会话，说明理解，再等待你的指示。', { exact: true })).toBeVisible()
  expect((await page.request.post(`/farming/api/control/agents/${destinationId}/title`, { data: { title: '交接会话 · Claude' } })).ok()).toBeTruthy()
  await expect(page.locator(`[data-testid="code-agent-row"][data-agent-id="${destinationId}"]`)).toContainText('交接会话 · Claude')
  await expect(sourceRow).toBeVisible()
  const context = page.getByTestId('code-agent-handoff-context')
  await expect(context.locator('summary')).toHaveText('交接上下文')
  await expect(context).not.toHaveAttribute('open')
  await page.screenshot({ path: testInfo.outputPath('05-new-conversation.png'), animations: 'disabled' })
  await context.locator('summary').click()
  await expect(context.locator('.detail')).toContainText('Read the source conversation')
  await page.screenshot({ path: testInfo.outputPath('06-expanded-context.png'), animations: 'disabled' })
  await page.getByTestId('code-new-agent').click()
  await expect(dialog.getByTestId('handoff-source-name')).toHaveCount(0)
  await expect(dialog.getByText('编程 Agent', { exact: true })).toBeVisible()
  await expect(dialog.getByTestId('agent-option-bash')).toBeVisible()
  await dialog.getByTestId('agent-option-claude').click()
  await expect(dialog.getByRole('group', { name: 'Claude Code 运行方式' })).toBeVisible()
  await dialog.getByTestId('agent-home-select').click()
  await dialog.getByRole('option').filter({ hasText: 'demo-home' }).click()
  await dialog.getByRole('button', { name: 'Chat', exact: true }).click()
  await expect(dialog.locator('input[name="workspace-path"]')).toBeEnabled()
  await expect(dialog.locator('input[name="workspace-path"]')).not.toHaveAttribute('readonly')
  await dialog.screenshot({ path: testInfo.outputPath('07-ordinary-new-agent.png'), animations: 'disabled' })
  await dialog.getByTestId('input-dialog-close').click()
})
