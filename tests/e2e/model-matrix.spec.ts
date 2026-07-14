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
  await page.getByTestId('code-model-matrix-advanced-toggle').click()
  await page.waitForTimeout(80)
  const morphingBox = await menu.boundingBox()
  expect(morphingBox?.width ?? 0).toBeGreaterThan(280)
  expect(morphingBox?.width ?? 999).toBeLessThan(350)
  await page.waitForTimeout(220)
  const advancedBox = await menu.boundingBox()
  expect(advancedBox?.width).toBeCloseTo(280, 0)

  await page.getByTestId('code-model-matrix-advanced-toggle').click()
  await page.waitForTimeout(300)
  await expect(page.locator('.code-model-matrix-current')).toHaveText('GPT-5.6-Sol · ultra')
  await expect(fast).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('code-model-matrix-cell-sol-high')).toHaveAttribute('aria-checked', 'true')
})
