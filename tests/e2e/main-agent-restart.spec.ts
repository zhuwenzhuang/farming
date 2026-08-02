import type { Page } from '@playwright/test'
import { expect, openFarming, test } from './fixtures'

type PublicAgent = {
  command?: string
  id: string
  isMain?: boolean
  runtimeBinding?: { kind?: string, state?: string }
}

async function currentMainAgent(page: Page): Promise<PublicAgent | undefined> {
  const response = await page.request.get('/farming/api/control/agents')
  expect(response.ok()).toBeTruthy()
  const body = await response.json() as { agents?: PublicAgent[] }
  return body.agents?.find(agent => agent.isMain === true)
}

test('labels the Codex Main Agent restart as Chat and starts the fake ACP runtime', async ({ page }) => {
  await openFarming(page)

  let initialMainAgent: PublicAgent | undefined
  await expect.poll(async () => {
    initialMainAgent = await currentMainAgent(page)
    return initialMainAgent?.command
  }).toBe('bash')
  expect(initialMainAgent?.id).toBeTruthy()

  const usageToggle = page.getByTestId('code-usage-toggle')
  if (await usageToggle.getAttribute('aria-expanded') === 'false') await usageToggle.click()
  await page.getByTestId('code-main-agent-restart').click()

  const codexChatRestart = page.getByTestId('code-main-agent-restart-codex')
  await expect(codexChatRestart).toHaveText('Codex Chat')
  await codexChatRestart.click()

  await expect.poll(async () => {
    const replacement = await currentMainAgent(page)
    return {
      command: replacement?.command,
      isReplacement: Boolean(replacement?.id && replacement.id !== initialMainAgent?.id),
      runtimeKind: replacement?.runtimeBinding?.kind,
      runtimeState: replacement?.runtimeBinding?.state,
    }
  }, { timeout: 30_000 }).toEqual({
    command: 'codex',
    isReplacement: true,
    runtimeKind: 'acp',
    runtimeState: 'idle',
  })
})
