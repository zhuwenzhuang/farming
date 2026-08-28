import fs from 'node:fs'
import path from 'node:path'
import type { Page, Route } from '@playwright/test'
import { expect, openFarming, test } from './fixtures'

type MatrixState = {
  model: string
  reasoning: string
  fast: boolean
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(settle => {
    resolve = settle
  })
  return { promise, resolve }
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

function sessionSnapshot(state: MatrixState, runtimeState = 'ready') {
  return {
    provider: 'claude',
    sessionId: 'model-matrix-session',
    state: runtimeState,
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

async function createAcpAgent(page: Page, workspace: string, provider = 'claude') {
  const response = await page.request.post('/farming/api/control/agents', {
    data: { command: provider, workspace, agentRuntimeMode: 'chat' },
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

test('ACP model controls wait for the initial session configuration to become ready', async ({ page, workspaceRoot }) => {
  const workspace = path.join(workspaceRoot, 'model-matrix-connecting')
  fs.mkdirSync(workspace, { recursive: true })
  const agentId = await createAcpAgent(page, workspace)
  const state: MatrixState = { model: 'gpt-5.6-terra', reasoning: 'medium', fast: false }
  let patchCount = 0

  await page.route(/\/farming\/api\/agents\/[^/]+\/acp-session(?:\?includeEntries=0)?$/, async route => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: { session: sessionSnapshot(state, 'connecting') } })
      return
    }
    patchCount += 1
    await route.fulfill({ status: 409, json: { error: 'ACP Agent is not ready for configuration changes (connecting)' } })
  })

  await openFarming(page)
  await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
  await expect(page.getByTestId('code-acp-composer')).toBeVisible()
  const picker = page.getByTestId('code-acp-model-picker')
  await expect(picker).toBeVisible()
  await expect(picker).toBeDisabled()
  await picker.evaluate(button => (button as HTMLButtonElement).click())
  expect(patchCount).toBe(0)
  await expect(page.getByText('ACP Agent is not ready for configuration changes (connecting)')).toHaveCount(0)
})

test('keeps confirmed ACP controls visible while revalidating after an Agent switch', async ({ page, workspaceRoot }) => {
  const workspace = path.join(workspaceRoot, 'model-matrix-switch-cache')
  fs.mkdirSync(workspace, { recursive: true })
  const firstAgentId = await createAcpAgent(page, workspace)
  const secondAgentId = await createAcpAgent(page, workspace)
  const firstState: MatrixState = { model: 'gpt-5.6-sol', reasoning: 'high', fast: false }
  const secondState: MatrixState = { model: 'gpt-5.6-terra', reasoning: 'low', fast: false }
  const blockedRefresh = deferred()
  const refreshStarted = deferred()
  let blockNextFirstRefresh = false

  await page.route(/\/farming\/api\/agents\/([^/]+)\/acp-session(?:\?includeEntries=0)?$/, async route => {
    if (route.request().method() !== 'GET') {
      await route.continue()
      return
    }
    const match = new URL(route.request().url()).pathname.match(/\/api\/agents\/([^/]+)\/acp-session$/)
    const agentId = decodeURIComponent(match?.[1] || '')
    if (agentId === firstAgentId && blockNextFirstRefresh) {
      blockNextFirstRefresh = false
      refreshStarted.resolve()
      await blockedRefresh.promise
    }
    await route.fulfill({
      json: { session: sessionSnapshot(agentId === firstAgentId ? firstState : secondState) },
    })
  })

  await openFarming(page)
  const firstRow = page.locator(`[data-testid="code-agent-row"][data-agent-id="${firstAgentId}"]`)
  const secondRow = page.locator(`[data-testid="code-agent-row"][data-agent-id="${secondAgentId}"]`)
  const picker = page.getByTestId('code-acp-model-picker')

  await firstRow.click()
  await expect(picker).toHaveAttribute('data-agent-model-preset', 'gpt-5.6-sol:high')
  await secondRow.click()
  await expect(picker).toHaveAttribute('data-agent-model-preset', 'gpt-5.6-terra:low')

  blockNextFirstRefresh = true
  await firstRow.click()
  await refreshStarted.promise
  try {
    await page.evaluate(() => new Promise<void>(resolve => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    }))
    expect(await picker.isVisible()).toBe(true)
    expect(await picker.getAttribute('data-agent-model-preset')).toBe('gpt-5.6-sol:high')
    expect(await picker.isDisabled()).toBe(true)
    await picker.evaluate(button => (button as HTMLButtonElement).click())
    await expect(page.getByTestId('code-acp-model-menu')).toHaveCount(0)
  } finally {
    blockedRefresh.resolve()
  }
  await expect(picker).toHaveAttribute('data-agent-model-preset', 'gpt-5.6-sol:high')
  await expect(picker).toBeEnabled()
})

test('keeps an open ACP model picker usable while a Chat revision refreshes the session', async ({ page, workspaceRoot }) => {
  const workspace = path.join(workspaceRoot, 'model-matrix-live-revision')
  fs.mkdirSync(workspace, { recursive: true })
  const agentId = await createAcpAgent(page, workspace)
  let state: MatrixState = { model: 'gpt-5.6-terra', reasoning: 'medium', fast: false }
  const blockedRefresh = deferred()
  const refreshStarted = deferred()
  let blockNextRefresh = false

  await page.route(/\/farming\/api\/agents\/[^/]+\/acp-session(?:\?includeEntries=0)?$/, async route => {
    if (route.request().method() === 'GET') {
      if (blockNextRefresh) {
        blockNextRefresh = false
        refreshStarted.resolve()
        await blockedRefresh.promise
      }
      await route.fulfill({ json: { session: sessionSnapshot(state) } })
      return
    }
    if (route.request().method() !== 'PATCH') {
      await route.continue()
      return
    }
    state = requestedState(route, state)
    await route.fulfill({ json: {
      sessionId: 'model-matrix-session',
      configOptions: sessionSnapshot(state).configOptions,
    } })
  })

  await openFarming(page)
  await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
  const picker = page.getByTestId('code-acp-model-picker')
  await expect(picker).toBeEnabled()
  await picker.click()
  await expect(page.getByTestId('code-acp-model-menu')).toBeVisible()

  const controlResponse = await page.request.get('/farming/api/control/agents')
  expect(controlResponse.ok()).toBeTruthy()
  const controlBody = await controlResponse.json() as {
    agents?: Array<{ id?: string; runtimeBinding?: Record<string, unknown> }>
  }
  const runtimeBinding = controlBody.agents?.find(agent => agent.id === agentId)?.runtimeBinding
  expect(runtimeBinding?.kind).toBe('acp')

  blockNextRefresh = true
  await page.evaluate(({ id, binding }) => {
    window.__farmingAgentActivityTest?.update(id, {
      runtimeBinding: {
        ...binding,
        sessionRevision: Number(binding.sessionRevision || 0) + 1,
        sessionUpdatedAt: new Date().toISOString(),
      },
    })
  }, { id: agentId, binding: runtimeBinding as Record<string, unknown> })
  await refreshStarted.promise
  try {
    await expect(page.getByTestId('code-acp-model-menu')).toBeVisible()
    await expect(picker).toBeEnabled()
    await page.getByTestId('code-model-matrix-cell-sol-high').click()
    await expect(picker).toHaveAttribute('data-agent-model-preset', 'gpt-5.6-sol:high')
  } finally {
    blockedRefresh.resolve()
  }
})

test('keeps the ACP model picker open throughout a real streamed Chat turn', async ({ page, workspaceRoot }) => {
  const workspace = path.join(workspaceRoot, 'model-matrix-streaming-turn')
  fs.mkdirSync(workspace, { recursive: true })
  const agentId = await createAcpAgent(page, workspace)

  await openFarming(page)
  await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
  const input = page.getByTestId('code-acp-composer-input')
  await input.fill('streaming thought')
  await page.getByTestId('code-acp-composer-send').click()
  await expect(page.getByText('Comparing the likely causes', { exact: false }).first()).toBeVisible({ timeout: 10_000 })

  const picker = page.getByTestId('code-acp-model-picker')
  await expect(picker).toBeEnabled()
  await picker.click()
  const menu = page.getByTestId('code-acp-model-menu')
  await expect(menu).toBeVisible()

  await expect(page.getByText('Streaming thought complete.', { exact: true })).toBeVisible({ timeout: 15_000 })
  await expect(menu).toBeVisible()
  await expect(picker).toBeEnabled()
  await page.getByTestId('code-acp-model-submenu-trigger').click()
  await expect(page.getByTestId('code-acp-model-submenu')).toBeVisible()
})

test('ACP model matrix responds locally, settles once, and morphs Advanced without a layout jump', async ({ page, workspaceRoot }) => {
  const workspace = path.join(workspaceRoot, 'model-matrix')
  fs.mkdirSync(workspace, { recursive: true })
  fs.writeFileSync(path.join(workspace, 'README.md'), '# Model matrix fixture\n')
  const agentId = await createAcpAgent(page, workspace)
  let state: MatrixState = { model: 'gpt-5.6-terra', reasoning: 'medium', fast: false }
  let fastPatchCount = 0
  const patchGates: Array<ReturnType<typeof deferred>> = []

  await page.route(/\/farming\/api\/agents\/[^/]+\/acp-session(?:\?includeEntries=0)?$/, async route => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: { session: sessionSnapshot(state) } })
      return
    }
    if (route.request().method() !== 'PATCH') {
      await route.continue()
      return
    }
    const requestBody = route.request().postDataJSON() as {
      configId?: string
      configOptions?: Array<{ configId?: string }>
    }
    if (
      requestBody.configId === 'fast-mode'
      || requestBody.configOptions?.some(change => change.configId === 'fast-mode')
    ) fastPatchCount += 1
    const nextState = requestedState(route, state)
    const gate = deferred()
    patchGates.push(gate)
    await gate.promise
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
  const extraHighHeader = menu.locator('.code-model-matrix-head span').nth(3)
  await expect(extraHighHeader).toHaveCSS('white-space', 'nowrap')
  expect((await extraHighHeader.boundingBox())?.height ?? 99).toBeLessThan(12)

  const target = page.getByTestId('code-model-matrix-cell-sol-high')
  await target.click()
  await expect(page.locator('.code-model-matrix-current')).toHaveText('GPT-5.6-Sol · high')
  await expect(picker).toHaveAttribute('data-agent-model-preset', 'gpt-5.6-sol:high')
  await expect(target).toBeDisabled()
  await expect.poll(() => patchGates.length).toBe(1)
  patchGates[0]!.resolve()
  const thumb = page.locator('.code-model-matrix-thumb')
  await thumb.evaluate(async element => {
    await Promise.all(element.getAnimations().map(animation => animation.finished.catch(() => undefined)))
  })
  const optimisticThumb = await thumb.boundingBox()
  expect(optimisticThumb).not.toBeNull()
  await expect(target).toBeEnabled({ timeout: 2_000 })
  const settledThumb = await thumb.boundingBox()
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
  await expect.poll(() => patchGates.length).toBe(2)
  patchGates[1]!.resolve()
  await expect(adjacentTarget).toBeEnabled({ timeout: 2_000 })
  const rockerMutations = await page.evaluate(() => {
    const motion = (window as typeof window & { __matrixRockerMotion?: { observer: MutationObserver; mutations: string[] } }).__matrixRockerMotion
    motion?.observer.disconnect()
    return motion?.mutations || []
  })
  expect(rockerMutations).toEqual([])
  await target.click()
  await expect.poll(() => patchGates.length).toBe(3)
  patchGates[2]!.resolve()
  await expect(target).toBeEnabled({ timeout: 2_000 })

  const fill = page.locator('.code-model-matrix-fill')
  await expect(fill).toHaveCSS('color', 'rgb(242, 162, 75)')
  const ultra = page.getByRole('button', { name: 'Ultra reasoning' })
  await ultra.click()
  await expect(ultra).toHaveAttribute('aria-pressed', 'true')
  await expect(picker).toHaveAttribute('data-agent-model-preset', 'gpt-5.6-sol:ultra')
  await expect(page.getByTestId('code-model-matrix-picker')).toHaveAttribute('data-ultra', 'on')
  await expect(page.getByTestId('code-model-matrix-cell-sol-high')).toHaveAttribute('aria-checked', 'false')
  await expect(page.locator('.code-model-matrix-current')).toHaveText('GPT-5.6-Sol · ultra')
  await expect(fill).toHaveCSS('color', 'rgb(167, 117, 242)')
  const ultraControl = page.locator('.code-model-matrix-rocker-control')
  const ultraKnob = page.locator('.code-model-matrix-rocker-knob')
  await expect(ultraControl).toHaveClass(/is-kicked/)
  await expect(ultraKnob).toHaveClass(/is-kicked/)
  await expect.poll(() => patchGates.length).toBe(4)
  patchGates[3]!.resolve()
  const ultraMotion = await page.evaluate(() => {
    const control = document.querySelector('.code-model-matrix-rocker-control')
    const knob = document.querySelector('.code-model-matrix-rocker-knob')
    const knobPosition = document.querySelector('.code-model-matrix-rocker-knob-position')
    const fillElement = document.querySelector('.code-model-matrix-fill')
    const summarize = (element: Element | null) => element?.getAnimations().map(animation => ({
      name: (animation as CSSAnimation).animationName,
      delay: Number(animation.effect?.getTiming().delay || 0),
      duration: Number(animation.effect?.getTiming().duration || 0),
    })) || []
    const milliseconds = (value: string) => value.endsWith('ms')
      ? Number.parseFloat(value)
      : Number.parseFloat(value) * 1_000
    const summarizeStyle = (element: Element | null) => {
      if (!element) return null
      const style = getComputedStyle(element)
      return {
        name: style.animationName,
        delay: milliseconds(style.animationDelay),
        duration: milliseconds(style.animationDuration),
      }
    }
    return {
      control: summarizeStyle(control),
      knob: summarizeStyle(knob),
      travelDuration: knobPosition ? milliseconds(getComputedStyle(knobPosition).transitionDuration) : 0,
      fill: summarize(fillElement),
      fillShadow: fillElement ? getComputedStyle(fillElement).boxShadow : '',
    }
  })
  expect(ultraMotion.control).toEqual({ name: 'code-model-rocker-impact', delay: 190, duration: 120 })
  expect(ultraMotion.knob).toEqual({ name: 'code-model-rocker-kick', delay: 190, duration: 120 })
  expect(Number(ultraMotion.knob?.delay) + Number(ultraMotion.knob?.duration)).toBeLessThan(ultraMotion.travelDuration)
  expect(ultraMotion.fill).toContainEqual({ name: 'code-model-ultra-charge', delay: 0, duration: 620 })
  expect(ultraMotion.fillShadow).toContain('18px')
  await expect(ultra).toBeEnabled({ timeout: 2_000 })
  await expect(ultraControl).not.toHaveClass(/is-kicked/, { timeout: 1_500 })
  await ultra.click()
  await expect(ultra).toBeDisabled()
  await expect.poll(() => patchGates.length).toBe(5)
  patchGates[4]!.resolve()
  await expect(ultra).toHaveAttribute('aria-pressed', 'false')
  await expect(picker).toHaveAttribute('data-agent-model-preset', 'gpt-5.6-sol:high')
  await expect(page.locator('.code-model-matrix-current')).toHaveText('GPT-5.6-Sol · high')
  await expect(ultra).toBeEnabled({ timeout: 2_000 })

  const fast = page.getByRole('button', { name: 'Fast mode' })
  const fastPatchCountBeforeClick = fastPatchCount
  await fast.evaluate(button => {
    ;(button as HTMLButtonElement).click()
    ;(button as HTMLButtonElement).click()
  })
  await expect(fast).toHaveAttribute('aria-pressed', 'true')
  await expect(fast).toContainText('ON')
  await expect(picker.locator('.code-composer-speed-active')).toHaveCount(1)
  await expect.poll(() => patchGates.length).toBe(6)
  patchGates[5]!.resolve()
  await expect(fast).toBeEnabled({ timeout: 2_000 })
  expect(fastPatchCount - fastPatchCountBeforeClick).toBe(1)

  const desktopViewport = page.viewportSize()!
  await page.setViewportSize({ width: 390, height: 844 })
  await fast.hover()
  for (const appearance of ['light', 'dark', 'paper']) {
    await page.locator('body').evaluate((body, value) => {
      body.dataset.appearance = value
    }, appearance)
    const emphasis = await page.locator('body').evaluate(body => {
      const emphasisProbe = document.createElement('span')
      emphasisProbe.style.color = 'var(--code-text-on-emphasis)'
      body.append(emphasisProbe)
      const color = getComputedStyle(emphasisProbe).color
      emphasisProbe.remove()
      return color
    })
    await expect(fast).toHaveCSS('color', emphasis)
    await expect(fast.locator(':scope > span:nth-child(2)')).toHaveCSS('color', emphasis)
    await expect.poll(() => fast.evaluate(button => getComputedStyle(button).backgroundImage))
      .toContain('linear-gradient')
  }
  await page.setViewportSize(desktopViewport)
  await expect.poll(async () => Math.round((await menu.boundingBox())?.width ?? 0))
    .toBe(350)

  const matrixBox = await menu.boundingBox()
  expect(matrixBox?.width).toBeCloseTo(350, 0)
  const matrixStage = page.locator('.code-model-matrix-stage')
  const matrixStageBox = await matrixStage.boundingBox()
  await page.getByTestId('code-model-matrix-advanced-toggle').click()
  await expect.poll(async () => {
    const box = await menu.boundingBox()
    return (box?.width ?? 0) > 280 && (box?.width ?? Number.POSITIVE_INFINITY) < 350
  }, { message: 'advanced-toggle transition should expose an observable intermediate width' }).toBe(true)
  const morphingBox = await menu.boundingBox()
  const morphingStageBox = await matrixStage.boundingBox()
  expect(morphingBox?.width ?? 0).toBeGreaterThan(280)
  expect(morphingBox?.width ?? 999).toBeLessThan(350)
  expect(morphingStageBox?.height ?? 0).toBeGreaterThan(0)
  expect(morphingStageBox?.height ?? 0).not.toBeCloseTo(matrixStageBox?.height ?? 0, 1)
  await expect.poll(async () => Math.round((await menu.boundingBox())?.width ?? 0))
    .toBe(280)
  const advancedBox = await menu.boundingBox()
  expect(advancedBox?.width).toBeCloseTo(280, 0)
  await expect(menu.locator('.code-model-matrix')).toHaveAttribute('aria-hidden', 'true')
  await expect(page.getByTestId('code-model-matrix-advanced')).toHaveAttribute('aria-hidden', 'false')

  await page.getByTestId('code-model-matrix-advanced-toggle').click()
  await expect.poll(async () => Math.round((await menu.boundingBox())?.width ?? 0))
    .toBe(350)
  await expect(menu.locator('.code-model-matrix')).toHaveAttribute('aria-hidden', 'false')
  await expect(page.getByTestId('code-model-matrix-advanced')).toHaveAttribute('aria-hidden', 'true')
  await expect(page.locator('.code-model-matrix-current')).toHaveText('GPT-5.6-Sol · high')
  await expect(fast).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('code-model-matrix-cell-sol-high')).toHaveAttribute('aria-checked', 'true')
  if (process.env.FARMING_CAPTURE_MODEL_MATRIX) {
    await page.screenshot({ path: process.env.FARMING_CAPTURE_MODEL_MATRIX })
  }
})

test('ACP model and permission changes show one deferred warning during an active turn', async ({ page, workspaceRoot }) => {
  const workspace = path.join(workspaceRoot, 'deferred-acp-settings')
  fs.mkdirSync(workspace, { recursive: true })
  const agentId = await createAcpAgent(page, workspace)
  const state: MatrixState = { model: 'gpt-5.6-terra', reasoning: 'medium', fast: false }
  const deferredConfigOptions: Array<{ configId: string; value: string | boolean }> = []
  let deferredModeId = ''

  await page.route(/\/farming\/api\/agents\/[^/]+\/acp-session(?:\?includeEntries=0)?$/, async route => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: { session: {
        ...sessionSnapshot(state),
        currentModeId: 'default',
        modes: {
          currentModeId: 'default',
          availableModes: [
            { id: 'default', name: 'Default' },
            { id: 'plan', name: 'Plan' },
          ],
        },
        deferredConfigOptions,
        deferredModeId,
      } } })
      return
    }
    const body = route.request().postDataJSON() as {
      modeId?: string
      configOptions?: Array<{ configId: string; value: string | boolean }>
    }
    if (body.modeId) deferredModeId = body.modeId
    if (body.configOptions) {
      deferredConfigOptions.splice(0, deferredConfigOptions.length, ...body.configOptions)
    }
    await route.fulfill({ json: {
      sessionId: 'model-matrix-session',
      deferred: true,
      ...(body.modeId ? { modeId: body.modeId, deferredModeId } : {}),
      configOptions: sessionSnapshot(state).configOptions,
      deferredConfigOptions,
    } })
  })

  await openFarming(page)
  await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
  await page.getByTestId('code-acp-model-picker').click()
  await page.getByTestId('code-model-matrix-cell-sol-high').click()
  const warning = page.getByTestId('code-acp-config-deferred')
  await expect(warning).toContainText('Model change will apply after the current turn finishes.')
  const feedbackMetrics = await warning.evaluate(element => {
    const feedback = element.getBoundingClientRect()
    const composer = element.parentElement?.querySelector<HTMLElement>('[data-testid="code-acp-composer"]')
      ?.getBoundingClientRect()
    return {
      feedbackWidth: feedback.width,
      feedbackHeight: feedback.height,
      composerWidth: composer?.width || 0,
    }
  })
  expect(feedbackMetrics.feedbackWidth).toBeLessThan(feedbackMetrics.composerWidth * 0.75)
  expect(feedbackMetrics.feedbackHeight).toBeLessThanOrEqual(36)

  await page.getByTestId('code-acp-mode').click()
  await page.getByTestId('code-acp-mode-menu').getByRole('menuitemradio').filter({ hasText: 'Plan' }).click()
  await expect(warning).toContainText('Session setting changes will apply after the current turn finishes.')
  await expect(page.getByTestId('code-acp-mode')).toHaveAttribute('data-acp-value', 'plan')
})

test('mobile ACP keeps one compact Composer state and exposes model selection before keyboard focus', async ({ page, workspaceRoot }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'maxTouchPoints', { value: 1, configurable: true })
  })
  await page.setViewportSize({ width: 390, height: 844 })

  const workspace = path.join(workspaceRoot, 'mobile-acp-composer')
  fs.mkdirSync(workspace, { recursive: true })
  const agentId = await createAcpAgent(page, workspace)
  const state: MatrixState = { model: 'gpt-5.6-terra', reasoning: 'medium', fast: false }

  await page.route(/\/farming\/api\/agents\/[^/]+\/acp-session(?:\?includeEntries=0)?$/, async route => {
    await route.fulfill({ json: { session: sessionSnapshot(state) } })
  })

  await page.goto(`/farming/?agent=${encodeURIComponent(agentId)}`, { waitUntil: 'domcontentloaded' })
  await expect(page.getByTestId('app-shell')).toBeVisible()
  const composer = page.getByTestId('code-acp-composer')
  const input = page.getByTestId('code-acp-composer-input')
  const picker = page.getByTestId('code-acp-model-picker')
  await expect(composer).toBeVisible()
  await input.blur()
  await expect(picker).toBeVisible()

  const compactHeight = await composer.evaluate(element => element.getBoundingClientRect().height)
  expect(compactHeight).toBeLessThanOrEqual(72)
  await picker.click()
  await expect(page.getByTestId('code-acp-model-menu')).toBeVisible()
  await page.keyboard.press('Escape')

  await input.click()
  await expect(input).toBeFocused()
  const focusedHeight = await composer.evaluate(element => element.getBoundingClientRect().height)
  expect(Math.abs(focusedHeight - compactHeight)).toBeLessThanOrEqual(2)

  await input.fill('line one\nline two\nline three\nline four')
  await expect.poll(() => composer.evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThan(compactHeight)
  const measured = await composer.evaluate(element => {
    const main = element.closest('.code-main') as HTMLElement | null
    return {
      composerHeight: Math.ceil(element.getBoundingClientRect().height),
      publishedHeight: Number.parseFloat(main ? getComputedStyle(main).getPropertyValue('--mobile-composer-current-height') : ''),
    }
  })
  expect(measured.publishedHeight).toBe(measured.composerHeight)
})

for (const provider of ['claude', 'opencode', 'qoder', 'qwen']) {
  test(`${provider} ACP exposes and updates its advertised profile controls`, async ({ page, workspaceRoot }) => {
    const workspace = path.join(workspaceRoot, `acp-controls-${provider}`)
    fs.mkdirSync(workspace, { recursive: true })
    const agentId = await createAcpAgent(page, workspace, provider)

    await openFarming(page)
    await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
    await expect(page.getByTestId('code-acp-composer')).toBeVisible()

    const picker = page.getByTestId('code-acp-model-picker')
    await expect(picker).toBeVisible()
    await expect(picker).toHaveAttribute('data-agent-model-preset', 'gpt-5.5:high')
    await picker.click()

    await expect(page.getByTestId('code-acp-model-menu')).toBeVisible()
    await expect(page.getByTestId('code-acp-model-submenu-trigger')).toContainText('gpt-5.5')
    await page.getByTestId('code-acp-speed-submenu-trigger').click()
    await page.getByTestId('code-acp-speed-submenu').getByRole('menuitemradio').last().click()
    await expect.poll(async () => {
      const sessionResponse = await page.request.get(`/farming/api/agents/${agentId}/acp-session?includeEntries=0`)
      const body = await sessionResponse.json() as { session?: ReturnType<typeof sessionSnapshot> }
      return body.session?.configOptions.find(option => option.id === 'fast-mode')?.currentValue
    }).toBe(true)
  })
}

test('Terminal Codex uses the live matrix and applies profile changes immediately', async ({ page, workspaceRoot }) => {
  const workspace = path.join(workspaceRoot, 'terminal-model-matrix')
  fs.mkdirSync(workspace, { recursive: true })
  fs.writeFileSync(path.join(workspace, 'README.md'), '# Terminal model matrix fixture\n')

  await page.route('**/farming/api/codex/models**', route => route.fulfill({
    json: { catalog: TERMINAL_MODEL_CATALOG, source: 'fixture' },
  }))
  const terminalProfiles: MatrixState[] = []
  const profileGates: Array<ReturnType<typeof deferred>> = []
  await page.route(/\/farming\/api\/agents\/[^/]+\/codex-terminal-profile$/, async route => {
    const body = route.request().postDataJSON() as { model: string; effort: string; serviceTier: string }
    terminalProfiles.push({
      model: body.model,
      reasoning: body.effort,
      fast: body.serviceTier === 'priority',
    })
    const gate = deferred()
    profileGates.push(gate)
    await gate.promise
    await route.fulfill({ json: { profile: body } })
  })
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
    data: { command: 'codex --farming-fixture-idle-profile', workspace, agentRuntimeMode: 'terminal' },
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
  await expect(target).toBeDisabled()
  await expect.poll(() => profileGates.length).toBe(1)
  profileGates[0]!.resolve()
  await expect(page.locator('.code-model-matrix-current')).toHaveText('5.6-Luna · max')
  await expect(picker).toHaveAttribute('data-agent-model-preset', 'gpt-5.6-luna:max')
  await expect(target).toBeEnabled()

  const fast = page.getByRole('button', { name: 'Fast mode' })
  await fast.click()
  await expect(fast).toBeDisabled()
  await expect(fast).toHaveAttribute('aria-pressed', 'true')
  await expect(picker.locator('.code-composer-speed-active')).toHaveCount(1)
  await expect.poll(() => profileGates.length).toBe(2)
  profileGates[1]!.resolve()
  await expect(fast).toBeEnabled()
  expect(terminalProfiles).toEqual([
    { model: 'gpt-5.6-luna', reasoning: 'max', fast: false },
    { model: 'gpt-5.6-luna', reasoning: 'max', fast: true },
  ])

  await page.getByTestId('code-model-matrix-advanced-toggle').click()
  await expect(page.getByTestId('code-model-matrix-advanced')).toHaveAttribute('aria-hidden', 'false')
  await page.getByTestId('code-model-matrix-advanced-toggle').click()
  await expect(menu.locator('.code-model-matrix')).toHaveAttribute('aria-hidden', 'false')
  await expect(picker).toHaveAttribute('data-agent-model-preset', 'gpt-5.6-luna:max')
})

test('Terminal Codex keeps live profile controls disabled while a turn is active', async ({ page, workspaceRoot }) => {
  const workspace = path.join(workspaceRoot, 'terminal-model-matrix-busy')
  fs.mkdirSync(workspace, { recursive: true })
  await page.route('**/farming/api/codex/models**', route => route.fulfill({
    json: { catalog: TERMINAL_MODEL_CATALOG, source: 'fixture' },
  }))
  await page.request.post('/farming/api/settings', {
    data: {
      codexModel: 'gpt-5.6-sol',
      codexReasoningEffort: 'high',
      codexServiceTier: 'default',
      codexModelPreset: 'gpt-5.6-sol:high',
    },
  })
  const response = await page.request.post('/farming/api/control/agents', {
    data: { command: 'codex', workspace, agentRuntimeMode: 'terminal' },
  })
  expect(response.ok()).toBeTruthy()
  const payload = await response.json() as { agentId?: string }
  expect(payload.agentId).toBeTruthy()

  await openFarming(page)
  await page.locator(`[data-testid="code-agent-row"][data-agent-id="${payload.agentId}"]`).click()
  const picker = page.getByTestId('code-composer-model-picker')
  await picker.click()
  const fast = page.getByRole('button', { name: 'Fast mode' })
  await expect(fast).toBeDisabled()
  await expect(page.getByTestId('code-model-matrix-cell-sol-high')).toBeDisabled()
})

test('Terminal Codex expires its browser catalog and reports refresh failure without stale choices', async ({ page, workspaceRoot }) => {
  const workspace = path.join(workspaceRoot, 'terminal-model-catalog-expiry')
  fs.mkdirSync(workspace, { recursive: true })
  await page.addInitScript(() => {
    const realNow = Date.now.bind(Date)
    let offset = 0
    Date.now = () => realNow() + offset
    ;(window as typeof window & { __advanceCodexCatalogClock?: (ms: number) => void }).__advanceCodexCatalogClock = ms => {
      offset += ms
    }
  })

  let catalogRequests = 0
  await page.route('**/farming/api/codex/models**', route => {
    catalogRequests += 1
    if (catalogRequests === 1) {
      return route.fulfill({ json: { catalog: TERMINAL_MODEL_CATALOG, source: 'fixture' } })
    }
    return route.fulfill({
      status: 504,
      contentType: 'application/json',
      body: JSON.stringify({
        error: 'Codex model catalog timed out after 15000ms',
        code: 'CODEX_MODELS_TIMEOUT',
      }),
    })
  })

  const response = await page.request.post('/farming/api/control/agents', {
    data: { command: 'codex', workspace, agentRuntimeMode: 'terminal' },
  })
  const { agentId } = await response.json() as { agentId: string }
  await page.request.post('/farming/api/settings', {
    data: {
      codexModel: 'gpt-5.6-terra',
      codexReasoningEffort: 'medium',
      codexServiceTier: 'default',
      codexModelPreset: 'gpt-5.6-terra:medium',
      agentLaunchProfiles: {
        codex: {
          model: 'gpt-5.6-terra',
          reasoningEffort: 'medium',
          serviceTier: 'default',
          modelPreset: 'gpt-5.6-terra:medium',
        },
      },
    },
  })
  await openFarming(page)
  await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()

  const picker = page.getByTestId('code-composer-model-picker')
  await picker.click()
  await expect(page.getByTestId('code-model-matrix-picker')).toBeVisible()
  await picker.click()
  await page.evaluate(() => {
    ;(window as typeof window & { __advanceCodexCatalogClock?: (ms: number) => void })
      .__advanceCodexCatalogClock?.(5 * 60_000 + 1)
  })
  await picker.click()

  await expect(page.getByTestId('code-copy-toast')).toHaveText('Codex model catalog timed out after 15000ms')
  await expect(page.getByTestId('code-model-matrix-picker')).toHaveCount(0)
  expect(catalogRequests).toBe(2)
})

test('Terminal picker follows the active footer instead of the global launch profile', async ({ page, workspaceRoot }) => {
  const workspace = path.join(workspaceRoot, 'terminal-live-model-profile')
  fs.mkdirSync(workspace, { recursive: true })
  await page.route('**/farming/api/codex/models**', route => route.fulfill({
    json: { catalog: TERMINAL_MODEL_CATALOG, source: 'fixture' },
  }))
  const terminalProfiles: MatrixState[] = []
  await page.route(/\/farming\/api\/agents\/[^/]+\/codex-terminal-profile$/, async route => {
    const body = route.request().postDataJSON() as { model: string; effort: string; serviceTier: string }
    terminalProfiles.push({
      model: body.model,
      reasoning: body.effort,
      fast: body.serviceTier === 'priority',
    })
    await route.fulfill({ json: { profile: body } })
  })
  await page.request.post('/farming/api/settings', {
    data: {
      codexModel: 'gpt-5.5',
      codexReasoningEffort: 'medium',
      codexServiceTier: 'default',
      codexModelPreset: 'gpt-5.5:medium',
      agentLaunchProfiles: {
        codex: {
          model: 'gpt-5.5',
          reasoningEffort: 'medium',
          serviceTier: 'default',
          modelPreset: 'gpt-5.5:medium',
        },
      },
    },
  })
  const response = await page.request.post('/farming/api/control/agents', {
    data: { command: 'codex --farming-fixture-live-profile', workspace, agentRuntimeMode: 'terminal' },
  })
  const { agentId } = await response.json() as { agentId: string }

  await openFarming(page)
  await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
  const picker = page.getByTestId('code-composer-model-picker')
  await expect(picker).toHaveAttribute('data-agent-model-preset', 'gpt-5.6-sol:xhigh')
  await expect(picker.locator('.code-composer-speed-active')).toHaveCount(1)
  await picker.click()
  await expect(page.getByTestId('code-model-matrix-picker')).toBeVisible()
  await expect(page.getByTestId('code-model-matrix-cell-sol-xhigh')).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByRole('button', { name: 'Fast mode' })).toHaveAttribute('aria-pressed', 'true')

  await page.getByTestId('code-model-matrix-cell-sol-high').click()
  await expect.poll(() => terminalProfiles).toEqual([
    { model: 'gpt-5.6-sol', reasoning: 'high', fast: true },
  ])
})

for (const { provider, command } of [
  { provider: 'claude', command: 'claude' },
  { provider: 'opencode', command: 'opencode' },
  { provider: 'qoder', command: 'qodercli' },
  { provider: 'qwen', command: 'qwen' },
] as const) {
  test(`Terminal ${provider} hides model controls because it has no live profile adapter`, async ({ page, workspaceRoot }) => {
    const workspace = path.join(workspaceRoot, `terminal-model-capabilities-${provider}`)
    fs.mkdirSync(workspace, { recursive: true })
    const response = await page.request.post('/farming/api/control/agents', {
      data: { command, workspace, agentRuntimeMode: 'terminal' },
    })
    expect(response.ok()).toBeTruthy()
    const { agentId } = await response.json() as { agentId: string }

    await openFarming(page)
    const row = page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
    await expect(row).toBeVisible()
    await row.click()
    await expect(page.locator('.code-composer')).toBeVisible()
    await expect(page.getByTestId('code-composer-model-picker')).toHaveCount(0)
  })
}

test('Terminal matrix explains unavailable Fast and Ultra without changing layout', async ({ page, workspaceRoot }) => {
  const workspace = path.join(workspaceRoot, 'terminal-model-matrix-limited')
  fs.mkdirSync(workspace, { recursive: true })
  const limitedCatalog = TERMINAL_MODEL_CATALOG.map(model => ({
    ...model,
    reasoningLevels: model.reasoningLevels.filter(reasoning => reasoning.value !== 'ultra'),
    serviceTiers: model.serviceTiers.filter(tier => tier.value !== 'priority'),
  }))
  await page.route('**/farming/api/codex/models**', route => route.fulfill({
    json: { catalog: limitedCatalog, source: 'fixture' },
  }))
  await page.request.post('/farming/api/settings', {
    data: {
      codexModel: 'gpt-5.6-sol',
      codexReasoningEffort: 'xhigh',
      codexServiceTier: 'default',
      agentLaunchProfiles: {
        codex: {
          model: 'gpt-5.6-sol',
          reasoningEffort: 'xhigh',
          serviceTier: 'default',
        },
      },
    },
  })
  const response = await page.request.post('/farming/api/control/agents', {
    data: { command: 'codex', workspace, agentRuntimeMode: 'terminal' },
  })
  const { agentId } = await response.json() as { agentId: string }

  await openFarming(page)
  await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
  await page.getByTestId('code-composer-model-picker').click()

  const ultra = page.getByRole('button', { name: /Ultra reasoning unavailable/ })
  const fast = page.getByRole('button', { name: /Fast mode unavailable/ })
  await expect(ultra).toBeDisabled()
  await expect(fast).toBeDisabled()
  await expect(ultra.locator('xpath=..')).toHaveAttribute(
    'title',
    'Ultra is not offered for this model by the active Codex CLI.'
  )
  await expect(fast).toHaveAttribute(
    'title',
    'Fast is not offered for this model by the active Codex CLI.'
  )
  await expect(page.getByTestId('code-model-matrix-picker')).toHaveAttribute('data-ultra', 'off')
  await expect(page.getByTestId('code-model-matrix-picker')).toHaveAttribute('data-fast', 'off')
})
