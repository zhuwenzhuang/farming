import fs from 'node:fs'
import path from 'node:path'
import { expect, openFarming, test } from './fixtures'

for (const provider of ['codex', 'claude'] as const) {
  for (const appearance of ['light', 'dark', 'paper'] as const) {
    test(`defers and answers live questions (${provider}, ${appearance})`, async ({ page, workspaceRoot }, testInfo) => {
      const workspace = path.join(workspaceRoot, 'service-demo')
      fs.mkdirSync(workspace, { recursive: true })
      await page.request.post('/farming/api/settings', { data: { language: 'zh', appearance } })
      const create = async (command: string = provider) => {
        const response = await page.request.post('/farming/api/control/agents', { data: { command, workspace, agentRuntimeMode: command === 'bash' ? 'terminal' : 'chat' } })
        expect(response.ok()).toBeTruthy()
        return (await response.json() as { agentId: string }).agentId
      }
      const agentId = await create()
      const otherId = await create('bash')
      await openFarming(page)
      const row = page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
      await row.locator('.code-agent-name').click()
      const input = page.getByTestId('code-acp-composer-input')
      await input.fill('补充登录流程测试')
      await page.getByTestId('code-acp-composer-send').click()
      const panel = page.getByTestId('code-acp-questions')
      const card = page.getByTestId('code-acp-elicitation')
      const badge = row.getByTestId('code-agent-row-question')
      await expect(card).toBeVisible()
      await expect(panel.getByTestId('code-acp-questions-running')).toHaveText('运行中')
      await expect(page.locator('.code-agent-transcript').last()).toContainText('找到 3 个')
      await expect(badge).toHaveAccessibleName('1 个待回答问题')
      await expect(card.getByRole('radio', { name: '核心登录流程', exact: true })).not.toBeChecked()
      await card.getByRole('radio', { name: '包含异常与边界情况', exact: true }).check()
      await card.getByRole('textbox', { name: '其他要求' }).fill('优先覆盖会话过期')
      let responses = 0
      page.on('request', request => { if (request.url().endsWith('/acp-elicitation')) responses++ })
      const capture = async (state: string) => {
        await page.mouse.move(900, 100)
        const file = testInfo.outputPath(`${provider}-${appearance}-${state}.png`)
        await page.screenshot({ path: file })
        await testInfo.attach(state, { path: file, contentType: 'image/png' })
      }
      await capture('expanded')
      await card.getByRole('button', { name: '稍后回答' }).click()
      await expect(card).toBeHidden()
      await expect(panel.getByRole('button', { name: '展开' })).toBeFocused()
      await expect(badge).toBeVisible()
      await capture('collapsed')
      expect(responses).toBe(0)
      await page.locator(`[data-testid="code-agent-row"][data-agent-id="${otherId}"]`).click()
      await expect(panel).toHaveCount(0)
      await row.locator('.code-agent-name').click()
      await expect(card).toBeHidden()
      await badge.hover()
      await badge.click()
      await expect(page.getByTestId('code-subagent-panel')).toHaveCount(0)
      await expect(card).toBeVisible()
      await expect(card.getByRole('textbox', { name: '其他要求' })).toHaveValue('优先覆盖会话过期')
      await expect(card.getByRole('radio', { name: '包含异常与边界情况', exact: true })).toBeChecked()
      await card.getByRole('button', { name: '提交回答', exact: true }).click()
      await expect(panel).toHaveCount(0)
      await expect(badge).toHaveCount(0)
      await expect(page.locator('.code-agent-transcript-assistant').last()).toContainText('"scope":"full"')
      expect(responses).toBe(1)
      await input.fill('pending question design fixture again')
      await page.getByTestId('code-acp-composer-send').click()
      await expect(card).toBeVisible()
      await card.getByRole('button', { name: '跳过', exact: true }).click()
      await expect(panel).toHaveCount(0)
      await expect(badge).toHaveCount(0)
      await expect(page.locator('.code-agent-transcript-assistant').last()).toContainText('"action":"decline"')
    })
  }
}

test.describe('compact questions', () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } })
  for (const appearance of ['light', 'dark', 'paper'] as const) {
    test(`keeps questions and composer reachable (${appearance})`, async ({ page, workspaceRoot }, testInfo) => {
      const workspace = path.join(workspaceRoot, 'service-demo')
      fs.mkdirSync(workspace, { recursive: true })
      await page.request.post('/farming/api/settings', { data: { language: 'zh', appearance } })
      const response = await page.request.post('/farming/api/control/agents', { data: { command: 'codex', workspace, agentRuntimeMode: 'chat' } })
      const { agentId } = await response.json() as { agentId: string }
      await openFarming(page)
      await page.getByTestId('code-mobile-menu').tap()
      const row = page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
      await row.locator('.code-agent-name').tap()
      await page.getByTestId('code-acp-composer-input').fill('补充登录流程测试')
      await page.getByTestId('code-acp-composer-send').tap()
      const card = page.getByTestId('code-acp-elicitation')
      const panel = page.getByTestId('code-acp-questions')
      await expect(card).toBeVisible()
      await expect(page.getByTestId('code-acp-questions-running')).toHaveText('运行中')
      await expect(page.locator('.code-agent-transcript').last()).toContainText('找到 3 个')
      const panelBounds = await panel.boundingBox()
      const composerBounds = await page.getByTestId('code-acp-composer').boundingBox()
      expect(panelBounds!.x).toBeGreaterThanOrEqual(0)
      expect(panelBounds!.x + panelBounds!.width).toBeLessThanOrEqual(390)
      expect(panelBounds!.y + panelBounds!.height).toBeLessThanOrEqual(composerBounds!.y)
      for (const state of ['expanded', 'collapsed']) {
        if (state === 'collapsed') await card.getByRole('button', { name: '稍后回答' }).tap()
        const file = testInfo.outputPath(`compact-${appearance}-${state}.png`)
        await page.screenshot({ path: file, animations: 'disabled' })
        await testInfo.attach(state, { path: file, contentType: 'image/png' })
      }
      await page.getByTestId('code-mobile-menu').tap()
      await row.getByTestId('code-agent-row-question').tap()
      await expect(card).toBeVisible()
      await card.getByRole('button', { name: '跳过', exact: true }).tap()
      await expect(panel).toHaveCount(0)
    })
  }
})

test('keeps an uncertain answer explicit and never replays it', async ({ page, workspaceRoot }) => {
  const workspace = path.join(workspaceRoot, 'question-failure')
  fs.mkdirSync(workspace, { recursive: true })
  const response = await page.request.post('/farming/api/control/agents', { data: { command: 'codex', workspace, agentRuntimeMode: 'chat' } })
  const { agentId } = await response.json() as { agentId: string }
  await openFarming(page)
  const row = page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
  await row.locator('.code-agent-name').click()
  await page.getByTestId('code-acp-composer-input').fill('补充登录流程测试')
  await page.getByTestId('code-acp-composer-send').click()
  const card = page.getByTestId('code-acp-elicitation')
  await expect(card).toBeVisible()
  let attempts = 0
  await page.route(`**/api/agents/${agentId}/acp-elicitation`, route => {
    attempts++
    return route.abort('failed')
  })
  await card.getByRole('button', { name: 'Skip', exact: true }).click()
  await expect(card.getByRole('alert')).toContainText('unconfirmed')
  await expect(card.getByRole('button', { name: 'Skip', exact: true })).toBeDisabled()
  await card.getByRole('button', { name: 'Answer later' }).click()
  await row.getByTestId('code-agent-row-question').focus()
  await page.keyboard.press('Enter')
  await expect(card.getByRole('alert')).toContainText('unconfirmed')
  expect(attempts).toBe(1)
  await page.unroute(`**/api/agents/${agentId}/acp-elicitation`)
  await page.getByTestId('code-acp-composer-send').click()
  await expect(page.getByTestId('code-acp-questions')).toHaveCount(0)
  await expect(row.getByTestId('code-agent-row-question')).toHaveCount(0)
})
