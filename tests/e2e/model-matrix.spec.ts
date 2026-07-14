import fs from 'node:fs'
import path from 'node:path'
import type { Page, Route } from '@playwright/test'
import { expect, openFarming, test } from './fixtures'

type MatrixState = {
  model: string
  reasoning: string
  fast: boolean
}

const MODEL_OPTIONS = [
  { value: 'gpt-5.6-sol', name: 'GPT-5.6-Sol' },
  { value: 'gpt-5.6-terra', name: 'GPT-5.6-Terra' },
  { value: 'gpt-5.6-luna', name: 'GPT-5.6-Luna' },
]

const REASONING_OPTIONS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']
  .map(value => ({ value, name: value }))

const TERMINAL_MODEL_CATALOG = MODEL_OPTIONS.map(option => ({
  value: option.value,
  model: option.value,
  label: option.name.replace(/^GPT-/i, ''),
  displayName: option.name,
  defaultEffort: 'medium',
  reasoningLevels: REASONING_OPTIONS.map(reasoning => ({
    value: reasoning.value,
    effort: reasoning.value,
    label: reasoning.name,
  })),
  serviceTiers: [
    { value: 'default', label: 'Standard', description: 'Default speed' },
    { value: 'priority', label: 'Fast', description: 'Faster responses' },
  ],
  source: 'fixture',
}))

function sessionSnapshot(state: MatrixState) {
  return {
    provider: 'codex',
    sessionId: 'model-matrix-session',
    state: 'ready',
    error: '',
    stopReason: '',
    availableCommands: [],
    currentModeId: '',
    modes: null,
    configOptions: [
      { id: 'model', name: 'Model', type: 'select', currentValue: state.model, options: MODEL_OPTIONS },
      { id: 'reasoning', name: 'Reasoning', type: 'select', currentValue: state.reasoning, options: REASONING_OPTIONS },
      { id: 'fast-mode', name: 'Fast mode', type: 'boolean', currentValue: state.fast },
    ],
    usage: null,
  }
}

async function createAcpAgent(page: Page, workspace: string) {
  const response = await page.request.post('/farming/api/control/agents', {
    data: { command: 'codex', workspace, agentRuntimeMode: 'acp' },
  })
  expect(response.ok()).toBeTruthy()
  const payload = await response.json() as { agentId?: string }
  expect(payload.agentId).toBeTruthy()
  return payload.agentId as string
}

function requestedState(route: Route, current: MatrixState) {
  const body = route.request().postDataJSON() as {
    configId?: string
    value?: string | boolean
    configOptions?: Array<{ configId?: string; value?: string | boolean }>
  }
  const changes = Array.isArray(body.configOptions)
    ? body.configOptions
    : body.configId ? [{ configId: body.configId, value: body.value }] : []
  return changes.reduce((next, change) => {
    if (change.configId === 'model' && typeof change.value === 'string') next.model = change.value
    if (change.configId === 'reasoning' && typeof change.value === 'string') next.reasoning = change.value
    if (change.configId === 'fast-mode' && typeof change.value === 'boolean') next.fast = change.value
    return next
  }, { ...current })
}

test('Codex model matrix responds locally, settles once, and morphs Advanced without a layout jump', async ({ page, workspaceRoot }) => {
  const workspace = path.join(workspaceRoot, 'model-matrix')
  fs.mkdirSync(workspace, { recursive: true })
  fs.writeFileSync(path.join(workspace, 'README.md'), '# Model matrix fixture\n')
  const agentId = await createAcpAgent(page, workspace)
  let state: MatrixState = { model: 'gpt-5.6-terra', reasoning: 'medium', fast: false }

  await page.route(/\/farming\/api\/agents\/[^/]+\/acp-session(?:\?includeEntries=0)?$/, async route => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: { session: sessionSnapshot(state) } })
      return
    }
    if (route.request().method() !== 'PATCH') {
      await route.continue()
      return
    }
    const nextState = requestedState(route, state)
    await new Promise(resolve => setTimeout(resolve, 700))
    state = nextState
    await route.fulfill({ json: {
      sessionId: 'model-matrix-session',
      configOptions: sessionSnapshot(state).configOptions,
    } })
  })

  await openFarming(page)
  const row = page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
  await expect(row).toBeVisible()
  await row.click()
  await expect(page.getByTestId('code-acp-composer')).toBeVisible()
  const picker = page.getByTestId('code-acp-model-picker')
  await picker.click()
  const menu = page.getByTestId('code-acp-model-menu')
  await expect(menu).toBeVisible()
  await expect(menu.locator('.code-model-matrix')).toHaveCount(1)
  await expect(page.getByTestId('code-model-matrix-advanced')).toHaveCount(1)

  const target = page.getByTestId('code-model-matrix-cell-sol-high')
  await target.click()
  await expect(page.locator('.code-model-matrix-current')).toHaveText('GPT-5.6-Sol · high')
  await expect(picker).toHaveAttribute('data-agent-model-preset', 'gpt-5.6-sol:high')
  await expect(target).toBeDisabled()
  await page.waitForTimeout(260)
  const optimisticThumb = await page.locator('.code-model-matrix-thumb').boundingBox()
  expect(optimisticThumb).not.toBeNull()
  await expect(target).toBeEnabled({ timeout: 2_000 })
  const settledThumb = await page.locator('.code-model-matrix-thumb').boundingBox()
  expect(settledThumb?.x).toBeCloseTo(optimisticThumb?.x ?? 0, 1)
  expect(settledThumb?.y).toBeCloseTo(optimisticThumb?.y ?? 0, 1)

  await page.evaluate(() => {
    const rocker = document.querySelector('.code-model-matrix-rocker')
    const knob = document.querySelector('.code-model-matrix-rocker-knob-position')
    const mutations: string[] = []
    const observer = new MutationObserver(() => {
      mutations.push(`${rocker?.className || ''}|${knob?.getAttribute('style') || ''}`)
    })
    if (rocker) observer.observe(rocker, { attributes: true, attributeFilter: ['class', 'style'] })
    if (knob) observer.observe(knob, { attributes: true, attributeFilter: ['class', 'style'] })
    ;(window as typeof window & { __matrixRockerMotion?: { observer: MutationObserver; mutations: string[] } }).__matrixRockerMotion = {
      observer,
      mutations,
    }
  })
  const adjacentTarget = page.getByTestId('code-model-matrix-cell-sol-xhigh')
  await adjacentTarget.click()
  await expect(adjacentTarget).toBeEnabled({ timeout: 2_000 })
  const rockerMutations = await page.evaluate(() => {
    const motion = (window as typeof window & { __matrixRockerMotion?: { observer: MutationObserver; mutations: string[] } }).__matrixRockerMotion
    motion?.observer.disconnect()
    return motion?.mutations || []
  })
  expect(rockerMutations).toEqual([])
  await target.click()
  await expect(target).toBeEnabled({ timeout: 2_000 })

  const ultra = page.getByRole('button', { name: 'Ultra reasoning' })
  await ultra.click()
  await expect(ultra).toHaveAttribute('aria-pressed', 'true')
  await expect(picker).toHaveAttribute('data-agent-model-preset', 'gpt-5.6-sol:ultra')
  await expect(page.locator('.code-model-matrix-current')).toHaveText('GPT-5.6-Sol · ultra')
  await expect(ultra).toBeEnabled({ timeout: 2_000 })

  const fast = page.getByRole('button', { name: 'Fast mode' })
  await fast.click()
  await expect(fast).toHaveAttribute('aria-pressed', 'true')
  await expect(fast).toContainText('ON')
  await expect(picker.locator('.code-composer-speed-active')).toHaveCount(1)
  await expect(fast).toBeEnabled({ timeout: 2_000 })

  const matrixBox = await menu.boundingBox()
  expect(matrixBox?.width).toBeCloseTo(350, 0)
  const matrixStage = page.locator('.code-model-matrix-stage')
  const matrixStageBox = await matrixStage.boundingBox()
  await page.getByTestId('code-model-matrix-advanced-toggle').click()
  await page.waitForTimeout(80)
  const morphingBox = await menu.boundingBox()
  const morphingStageBox = await matrixStage.boundingBox()
  expect(morphingBox?.width ?? 0).toBeGreaterThan(280)
  expect(morphingBox?.width ?? 999).toBeLessThan(350)
  expect(morphingStageBox?.height ?? 0).toBeGreaterThan(0)
  expect(morphingStageBox?.height ?? 0).not.toBeCloseTo(matrixStageBox?.height ?? 0, 1)
  await page.waitForTimeout(220)
  const advancedBox = await menu.boundingBox()
  expect(advancedBox?.width).toBeCloseTo(280, 0)
  await expect(menu.locator('.code-model-matrix')).toHaveAttribute('aria-hidden', 'true')
  await expect(page.getByTestId('code-model-matrix-advanced')).toHaveAttribute('aria-hidden', 'false')

  await page.getByTestId('code-model-matrix-advanced-toggle').click()
  await page.waitForTimeout(300)
  await expect(menu.locator('.code-model-matrix')).toHaveAttribute('aria-hidden', 'false')
  await expect(page.getByTestId('code-model-matrix-advanced')).toHaveAttribute('aria-hidden', 'true')
  await expect(page.locator('.code-model-matrix-current')).toHaveText('GPT-5.6-Sol · ultra')
  await expect(fast).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('code-model-matrix-cell-sol-high')).toHaveAttribute('aria-checked', 'true')
  if (process.env.FARMING_CAPTURE_MODEL_MATRIX) {
    await page.screenshot({ path: process.env.FARMING_CAPTURE_MODEL_MATRIX })
  }
})

test('Terminal Codex uses the same live matrix in dark mode and queues profile changes locally', async ({ page, workspaceRoot }) => {
  const workspace = path.join(workspaceRoot, 'terminal-model-matrix')
  fs.mkdirSync(workspace, { recursive: true })
  fs.writeFileSync(path.join(workspace, 'README.md'), '# Terminal model matrix fixture\n')

  await page.route('**/farming/api/codex/models', route => route.fulfill({
    json: { catalog: TERMINAL_MODEL_CATALOG, source: 'fixture' },
  }))
  const settingsResponse = await page.request.post('/farming/api/settings', {
    data: {
      appearance: 'dark',
      codexModel: 'gpt-5.6-terra',
      codexReasoningEffort: 'medium',
      codexServiceTier: 'default',
      codexModelPreset: 'gpt-5.6-terra:medium',
      agentLaunchProfiles: {
        codex: {
          approvalMode: 'approve',
          model: 'gpt-5.6-terra',
          reasoningEffort: 'medium',
          serviceTier: 'default',
          modelPreset: 'gpt-5.6-terra:medium',
        },
      },
    },
  })
  expect(settingsResponse.ok()).toBeTruthy()
  const agentResponse = await page.request.post('/farming/api/control/agents', {
    data: { command: 'codex', workspace, agentRuntimeMode: 'terminal' },
  })
  expect(agentResponse.ok()).toBeTruthy()
  const agentPayload = await agentResponse.json() as { agentId?: string }
  expect(agentPayload.agentId).toBeTruthy()
  const agentId = agentPayload.agentId as string

  await openFarming(page)
  const row = page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
  await expect(row).toBeVisible()
  await row.click()
  await expect(page.locator('body')).toHaveAttribute('data-appearance', 'dark')

  const picker = page.getByTestId('code-composer-model-picker')
  await expect(picker).toHaveAttribute('data-agent-model-preset', 'gpt-5.6-terra:medium')
  await picker.click()
  const menu = page.getByTestId('code-model-menu')
  await expect(menu).toBeVisible()
  await expect(page.getByTestId('code-model-matrix-picker')).toHaveAttribute('data-advanced', 'closed')

  const target = page.getByTestId('code-model-matrix-cell-luna-max')
  await target.click()
  await expect(picker).toHaveAttribute('data-agent-model-preset', 'gpt-5.6-luna:max')
  await expect(page.locator('.code-model-matrix-current')).toHaveText('5.6-Luna · max')

  const fast = page.getByRole('button', { name: 'Fast mode' })
  await fast.click()
  await expect(fast).toHaveAttribute('aria-pressed', 'true')
  await expect(picker.locator('.code-composer-speed-active')).toHaveCount(1)

  await page.getByTestId('code-model-matrix-advanced-toggle').click()
  await expect(page.getByTestId('code-model-matrix-advanced')).toHaveAttribute('aria-hidden', 'false')
  await page.getByTestId('code-model-matrix-advanced-toggle').click()
  await expect(menu.locator('.code-model-matrix')).toHaveAttribute('aria-hidden', 'false')
  await expect(picker).toHaveAttribute('data-agent-model-preset', 'gpt-5.6-luna:max')
})
