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

test('labels Codex Main Agent as Chat and rejects a saturated fake ACP voice fence', async ({ page }) => {
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

  let replacementMainAgent: PublicAgent | undefined
  await expect.poll(async () => {
    replacementMainAgent = await currentMainAgent(page)
    return {
      command: replacementMainAgent?.command,
      isReplacement: Boolean(replacementMainAgent?.id && replacementMainAgent.id !== initialMainAgent?.id),
      runtimeKind: replacementMainAgent?.runtimeBinding?.kind,
      runtimeState: replacementMainAgent?.runtimeBinding?.state,
    }
  }, { timeout: 30_000 }).toEqual({
    command: 'codex',
    isReplacement: true,
    runtimeKind: 'acp',
    runtimeState: 'idle',
  })
  expect(replacementMainAgent?.id).toBeTruthy()

  const stopIds = Array.from({ length: 257 }, (_, index) => `saturation-stop-${index}`)
  for (let offset = 0; offset < stopIds.length; offset += 32) {
    const responses = await Promise.all(stopIds.slice(offset, offset + 32).map(operationId => (
      page.request.post(
        `/farming/api/agents/${encodeURIComponent(replacementMainAgent?.id || '')}/acp-realtime/stop`,
        { data: { operationId } },
      )
    )))
    expect(responses.every(response => response.ok())).toBe(true)
  }

  const saturatedStart = await page.request.post(
    `/farming/api/agents/${encodeURIComponent(replacementMainAgent?.id || '')}/acp-realtime/start`,
    { data: { operationId: 'saturation-start-fresh', sdp: 'v=0\r\nfake-offer' } },
  )
  expect(saturatedStart.status()).toBe(409)
  const saturatedBody = await saturatedStart.json()
  expect(saturatedBody).toMatchObject({
    outcome: 'rejected',
    error: expect.stringMatching(/Restart Codex Chat/),
  })
})
