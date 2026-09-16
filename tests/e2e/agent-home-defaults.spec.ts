import fs from 'node:fs'
import path from 'node:path'
import { expect, openFarming, test } from './fixtures'

for (const { provider, appearance } of [
  ...['light', 'dark', 'paper'].map(appearance => ({ provider: 'codex', appearance })),
  ...['claude', 'opencode', 'qoder', 'qwen', 'pi'].map(provider => ({ provider, appearance: 'light' })),
]) {
  test(`${provider} Composer remembers model and Fast for new Agents in ${appearance}`, async ({ page, workspaceRoot }) => {
    const workspace = path.join(workspaceRoot, 'home-defaults')
    fs.mkdirSync(workspace, { recursive: true })
    fs.writeFileSync(path.join(workspace, '.fake-acp-model-matrix'), '')
    expect((await page.request.post('/farming/api/settings', { data: { appearance } })).ok()).toBeTruthy()
    async function createAgent() {
      const response = await page.request.post('/farming/api/control/agents', {
        data: { command: provider, workspace, agentRuntimeMode: 'chat' },
      })
      expect(response.ok()).toBeTruthy()
      return (await response.json() as { agentId: string }).agentId
    }
    async function profile(agentId: string) {
      const response = await page.request.get(`/farming/api/agents/${agentId}/acp-session?includeEntries=0`)
      expect(response.ok()).toBeTruthy()
      const body = await response.json() as { session: { configOptions: Array<{ id: string; currentValue: unknown }> } }
      return Object.fromEntries(body.session.configOptions.map(option => [option.id, option.currentValue]))
    }
    const existing = await createAgent()
    const original = await profile(existing)
    const selected = await createAgent()
    await openFarming(page)
    await page.locator(`[data-testid="code-agent-row"][data-agent-id="${selected}"]`).click()
    const picker = page.getByTestId('code-acp-model-picker')
    await expect(picker).toBeEnabled()
    await picker.click()
    await page.getByTestId('code-acp-model-menu').getByRole('radio', { name: /gpt.?5\.6.?luna, high/i }).click()
    await expect(picker).toHaveAttribute('data-agent-model-preset', 'gpt-5.6-luna:high')
    const fast = page.getByRole('button', { name: 'Fast mode', exact: true })
    await fast.click()
    await expect(fast).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(async () => {
      const response = await page.request.get('/farming/api/settings')
      const body = await response.json()
      return body.settings.agentHomes[provider].find((home: { id: string }) => home.id === 'default').newAgentDefaults
    }).toEqual({ model: 'gpt-5.6-luna', reasoning: 'high', fast: 'on' })
    const newFast = await createAgent()
    await expect.poll(() => profile(newFast)).toMatchObject({ model: 'gpt-5.6-luna', reasoning: 'high', 'fast-mode': true })
    await fast.click()
    await expect(fast).toHaveAttribute('aria-pressed', 'false')
    await expect.poll(async () => {
      const response = await page.request.get('/farming/api/settings')
      const body = await response.json()
      return body.settings.agentHomes[provider].find((home: { id: string }) => home.id === 'default').newAgentDefaults.fast
    }).toBe('off')
    const newStandard = await createAgent()
    await expect.poll(() => profile(newStandard)).toMatchObject({ model: 'gpt-5.6-luna', reasoning: 'high', 'fast-mode': false })
    expect(await profile(existing)).toEqual(original)
    expect(await profile(newFast)).toMatchObject({ 'fast-mode': true })
    if (provider === 'codex') await expect(page.getByTestId('code-acp-model-menu')).toHaveScreenshot(`home-defaults-${appearance}.png`)
  })
}
