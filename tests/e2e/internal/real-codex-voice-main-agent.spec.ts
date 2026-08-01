import fs from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { expect, openFarming, test } from '../fixtures'

const DISPATCH_MARKER = 'VOICE_MAIN_DISPATCH_READY_6E31'
const MAIN_AGENT_MODEL = process.env.FARMING_E2E_VOICE_MAIN_MODEL || 'gpt-5.6-terra'
const MAIN_AGENT_EFFORT = process.env.FARMING_E2E_VOICE_MAIN_EFFORT || 'low'

type PublicAgent = {
  id: string
  command?: string
  cwd?: string
  projectWorkspace?: string
  parentAgentId?: string
  task?: string
  isMain?: boolean
  status?: string
  runtimeBinding?: { kind?: string, state?: string }
}

async function agents(page: Page) {
  const response = await page.request.get('/farming/api/control/agents')
  expect(response.ok()).toBeTruthy()
  const body = await response.json() as { agents?: PublicAgent[] }
  return body.agents ?? []
}

test.describe('real Codex Voice Main Agent', () => {
  test.describe.configure({ timeout: 180_000 })

  test.skip(
    process.env.FARMING_E2E_REAL_CODEX !== '1',
    'Set FARMING_E2E_REAL_CODEX=1 to use the authenticated local Codex runtime.',
  )

  test('connects Realtime and turns its handoff into an observable Farming child Agent', async ({ page, workspaceRoot }) => {
    const childWorkspace = path.join(workspaceRoot, 'voice-main-dispatch')
    fs.mkdirSync(childWorkspace, { recursive: true })

    const settingsResponse = await page.request.post('/farming/api/settings', {
      data: {
        dangerouslySkipAgentPermissionsByDefault: true,
        codexApprovalMode: 'full',
        codexModel: MAIN_AGENT_MODEL,
        codexReasoningEffort: MAIN_AGENT_EFFORT,
        codexServiceTier: 'default',
        codexModelPreset: `${MAIN_AGENT_MODEL}:${MAIN_AGENT_EFFORT}`,
        agentLaunchProfiles: {
          codex: {
            approvalMode: 'full',
            model: MAIN_AGENT_MODEL,
            reasoningEffort: MAIN_AGENT_EFFORT,
            serviceTier: 'default',
            modelPreset: `${MAIN_AGENT_MODEL}:${MAIN_AGENT_EFFORT}`,
          },
        },
      },
    })
    expect(settingsResponse.ok()).toBeTruthy()

    await openFarming(page)
    await expect.poll(async () => (await agents(page)).some(agent => agent.isMain === true), {
      timeout: 30_000,
    }).toBe(true)

    const usageToggle = page.getByTestId('code-usage-toggle')
    if (await usageToggle.getAttribute('aria-expanded') === 'false') await usageToggle.click()
    await page.getByTestId('code-main-agent-restart').click()
    await page.getByTestId('code-main-agent-restart-codex').click()

    let mainAgent: PublicAgent | undefined
    await expect.poll(async () => {
      mainAgent = (await agents(page)).find(agent => (
        agent.isMain === true
        && agent.command === 'codex'
        && agent.runtimeBinding?.kind === 'acp'
      ))
      return mainAgent?.runtimeBinding?.state
    }, { timeout: 90_000 }).toBe('idle')
    expect(mainAgent?.id).toBeTruthy()

    await page.evaluate(() => {
      const audioContext = new AudioContext()
      const oscillator = audioContext.createOscillator()
      const destination = audioContext.createMediaStreamDestination()
      oscillator.connect(destination)
      oscillator.start()
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
        configurable: true,
        value: async () => destination.stream,
      })
      Object.assign(window, { __farmingVoiceSmokeAudio: { audioContext, oscillator } })
    })
    const voice = page.getByTestId('code-acp-composer-mic')
    await expect(voice).toHaveAttribute('data-voice-mode', 'realtime')
    await voice.click()
    await expect.poll(async () => {
      const className = await voice.getAttribute('class') || ''
      const pressed = await voice.getAttribute('aria-pressed')
      if (pressed === 'true' && !className.includes('connecting')) return 'connected'
      const status = await page.getByTestId('code-acp-voice-status').textContent().catch(() => '')
      return status && pressed === 'false' ? `failed: ${status}` : 'connecting'
    }, { timeout: 30_000 }).toBe('connected')
    await expect(voice).toHaveClass(/listening/)
    await voice.click()
    await expect(voice).toHaveAttribute('aria-pressed', 'false')

    const childTask = `printf '${DISPATCH_MARKER}\\n'`
    const handoff = [
      '<realtime_delegation>',
      '  <input>',
      '    Act now as the Farming Main Agent; do not merely explain the command.',
      `    Use the exact Farming CLI from your environment to spawn exactly one bash child Agent in ${childWorkspace}.`,
      `    Set its task exactly to: ${childTask}`,
      '    Do not create a Codex subagent and do not perform any other mutation.',
      '    After Farming accepts the spawn, report the child Agent id.',
      '  </input>',
      `  <transcript_delta>user: delegate the ${DISPATCH_MARKER} verification task</transcript_delta>`,
      '</realtime_delegation>',
    ].join('\n')
    const requestId = `voice-main-dispatch-${Date.now()}`
    const messageResponse = await page.request.post(
      `/farming/api/control/agents/${encodeURIComponent(mainAgent?.id || '')}/messages`,
      { data: { message: handoff, requestId, delivery: 'prompt' } },
    )
    const messageBody = await messageResponse.json() as { error?: string }
    expect(messageResponse.ok(), messageBody.error || 'Main Agent rejected the Realtime handoff').toBeTruthy()

    let childAgent: PublicAgent | undefined
    await expect.poll(async () => {
      childAgent = (await agents(page)).find(agent => (
        agent.parentAgentId === mainAgent?.id
        && agent.command === 'bash'
        && agent.task === childTask
      ))
      return childAgent?.id || ''
    }, { timeout: 90_000 }).not.toBe('')

    expect(childAgent).toMatchObject({
      isMain: false,
      parentAgentId: mainAgent?.id,
      command: 'bash',
      task: childTask,
    })
    expect(path.resolve(childAgent?.projectWorkspace || childAgent?.cwd || '')).toBe(path.resolve(childWorkspace))
  })
})
