import { expect, openFarming, test } from './fixtures'
import type { Agent, CodexAppServerGoal } from '../../src/types/agent'

type FarmingState = {
  agents: Agent[]
  taskHistory: unknown[]
  mainPageSessionKeys: string[]
  mainAgentId: string | null
  systemStats: null
}

declare global {
  interface Window {
    __farmingEmitState?: (state: FarmingState) => void
    __farmingWsSent?: unknown[]
  }
}

const AGENT_ID = 'agent-goal-controls'
const PROVIDER_SESSION_KEY = 'agent-session:codex:thread-goal-controls'
const WORKSPACE = '/tmp/farming-goal-controls'

function goal(now: number): CodexAppServerGoal {
  return {
    threadId: 'thread-goal-controls',
    objective: [
      '完成并持续打磨。',
      '根据参考代码，搞定这个事情。',
      '未来 review、修改文件批量 diff 都要靠这个基础能力。',
    ].join('\n'),
    status: 'active',
    tokenBudget: null,
    tokensUsed: 80,
    timeUsedSeconds: 96,
    createdAt: now - 10_000,
    updatedAt: now,
  }
}

function baseAgent(now: number): Agent {
  return {
    id: AGENT_ID,
    command: 'codex',
    cwd: WORKSPACE,
    projectWorkspace: WORKSPACE,
    output: '',
    previewText: 'Codex fixture',
    status: 'running',
    isMain: false,
    activityLevel: 'warm',
    lastActivity: now,
    attentionScore: 0,
    isZombie: false,
    providerSessionProvider: 'codex',
    providerHomeId: 'default',
    providerHomePath: '/tmp/codex-home',
    providerSessionId: 'thread-goal-controls',
    providerSessionKey: PROVIDER_SESSION_KEY,
    providerSessionSource: 'agent-session',
  }
}

function cliWorkingState(now = Date.now()): FarmingState {
  return {
    agents: [{
      ...baseAgent(now),
      codexRuntimeMode: 'cli',
      terminalStatus: {
        kind: 'codex',
        activity: 'busy',
        busy: true,
        cwd: WORKSPACE,
        title: 'codex',
        runningCommand: 'codex',
        source: 'terminal-text',
      },
      terminalBusy: true,
    }],
    taskHistory: [],
    mainPageSessionKeys: [PROVIDER_SESSION_KEY],
    mainAgentId: null,
    systemStats: null,
  }
}

function appServerSteeringState(currentGoal: CodexAppServerGoal | null, now = Date.now()): FarmingState {
  return {
    agents: [{
      ...baseAgent(now),
      codexRuntimeMode: 'app-server',
      codexAppServerState: 'waiting-for-input',
      codexAppServerThreadId: 'thread-goal-controls',
      codexAppServerTurnId: 'turn-goal-controls',
      codexAppServerPendingRequestId: 'request-goal-controls',
      codexAppServerPendingRequestMethod: 'item/tool/requestUserInput',
      codexAppServerPendingRequest: {
        id: 'request-goal-controls',
        method: 'item/tool/requestUserInput',
        params: {
          questions: [{
            id: 'confirm',
            header: '确认',
            question: '继续按这个 goal 推进吗？',
            isSecret: false,
            options: [{ label: '继续', description: '保持当前方向' }],
          }],
        },
        receivedAt: new Date(now).toISOString(),
      },
      codexAppServerGoal: currentGoal,
      terminalStatus: {
        kind: 'codex',
        activity: 'busy',
        busy: true,
        cwd: WORKSPACE,
        title: 'codex app server',
        runningCommand: 'codex app-server',
        source: 'terminal-text',
      },
      terminalBusy: true,
    }],
    taskHistory: [],
    mainPageSessionKeys: [PROVIDER_SESSION_KEY],
    mainAgentId: null,
    systemStats: null,
  }
}

async function installStateSocket(page: import('@playwright/test').Page, initialState: FarmingState) {
  await page.addInitScript((state) => {
    const sockets = new Set<{
      readyState: number
      onopen: ((event: Event) => void) | null
      onmessage: ((event: MessageEvent) => void) | null
      onclose: ((event: CloseEvent) => void) | null
      send: (data: string) => void
      close: () => void
    }>()

    class MockWebSocket {
      static CONNECTING = 0
      static OPEN = 1
      static CLOSING = 2
      static CLOSED = 3

      readyState = MockWebSocket.CONNECTING
      onopen: ((event: Event) => void) | null = null
      onmessage: ((event: MessageEvent) => void) | null = null
      onclose: ((event: CloseEvent) => void) | null = null

      constructor() {
        sockets.add(this)
        window.setTimeout(() => {
          this.readyState = MockWebSocket.OPEN
          this.onopen?.(new Event('open'))
          this.onmessage?.({ data: JSON.stringify({ type: 'state', state }) } as MessageEvent)
        }, 0)
      }

      send(data: string) {
        window.__farmingWsSent = [...(window.__farmingWsSent || []), JSON.parse(data)]
      }

      close() {
        this.readyState = MockWebSocket.CLOSED
        this.onclose?.(new CloseEvent('close'))
        sockets.delete(this)
      }
    }

    window.__farmingWsSent = []
    window.__farmingEmitState = nextState => {
      for (const socket of sockets) {
        if (socket.readyState === MockWebSocket.OPEN) {
          socket.onmessage?.({ data: JSON.stringify({ type: 'state', state: nextState }) } as MessageEvent)
        }
      }
    }
    window.WebSocket = MockWebSocket as unknown as typeof WebSocket
  }, initialState)
}

async function mockGoalApi(page: import('@playwright/test').Page, initialGoal: CodexAppServerGoal) {
  let currentGoal: CodexAppServerGoal | null = initialGoal
  const patches: unknown[] = []

  await page.route(new RegExp(`/farming/api/agents/${AGENT_ID}/codex-goal$`), async route => {
    const request = route.request()
    if (request.method() === 'GET') {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ goal: currentGoal }) })
      return
    }
    if (request.method() === 'PATCH') {
      const patch = request.postDataJSON() as Partial<CodexAppServerGoal>
      patches.push(patch)
      currentGoal = {
        ...(currentGoal || initialGoal),
        ...patch,
        updatedAt: Date.now(),
      }
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ goal: currentGoal }) })
      return
    }
    if (request.method() === 'DELETE') {
      currentGoal = null
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, goal: null }) })
      return
    }
    await route.fallback()
  })

  return {
    patches,
    currentGoal: () => currentGoal,
  }
}

async function mockAgentSideApis(page: import('@playwright/test').Page) {
  await page.route(new RegExp(`/farming/api/agents/${AGENT_ID}/codex-app-server-transcript(?:\\?.*)?$`), async route => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        transcript: {
          available: true,
          sessionId: 'thread-goal-controls',
          updatedAt: new Date().toISOString(),
          source: 'goal-controls-fixture',
          turns: [{
            id: 'running-turn',
            userMessage: '继续实现 goal 管理交互。',
            finalMessage: '',
            startedAt: Date.now() - 60_000,
            status: 'inProgress',
            processItems: [
              { id: 'edited', type: 'patch', title: 'Edited 3 files', detail: 'CodexGoalControls.tsx +20 -10', status: 'running' },
            ],
          }],
        },
      }),
    })
  })
  await page.route(new RegExp(`/farming/api/agents/${AGENT_ID}/session-view$`), async route => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        agentId: AGENT_ID,
        output: '',
        snapshot: null,
        cols: 80,
        rows: 24,
        outputSeq: 1,
      }),
    })
  })
}

async function openAgentIfNeeded(page: import('@playwright/test').Page) {
  if (await page.getByTestId('code-composer').isVisible().catch(() => false)) return
  const mobileMenu = page.getByTestId('code-mobile-menu')
  if (await mobileMenu.isVisible().catch(() => false)) {
    await mobileMenu.click()
  }
  const row = page.locator(`[data-testid="code-agent-row"][data-agent-id="${AGENT_ID}"]`)
  await expect(row).toBeVisible()
  await row.click()
}

async function queueFollowUpThenSwitchToAppServer(page: import('@playwright/test').Page, nextState: FarmingState) {
  await openAgentIfNeeded(page)
  const input = page.getByTestId('code-composer-input')
  await expect(input).toBeVisible()
  await input.fill('排队消息：保持这个方向继续')
  await page.getByTestId('code-composer-send').click()
  await expect(page.getByTestId('code-pending-followup')).toBeVisible()
  await page.evaluate(state => window.__farmingEmitState?.(state), nextState)
}

async function layoutMetrics(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const rect = (testId: string) => {
      const element = document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null
      if (!element) return null
      const box = element.getBoundingClientRect()
      return {
        top: box.top,
        right: box.right,
        bottom: box.bottom,
        left: box.left,
        width: box.width,
        height: box.height,
      }
    }
    return {
      innerWidth: window.innerWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      goal: rect('code-codex-goal-bar'),
      composer: rect('code-composer'),
      request: rect('code-app-server-request'),
      pending: rect('code-pending-followup'),
    }
  })
}

test.describe('Codex goal controls', () => {
  test('keeps desktop goal controls compact while queued follow-up and app-server request are visible', async ({ page }) => {
    const currentGoal = goal(Date.now())
    const goalApi = await mockGoalApi(page, currentGoal)
    await mockAgentSideApis(page)
    await installStateSocket(page, cliWorkingState())
    await page.setViewportSize({ width: 1280, height: 800 })
    await openFarming(page)

    await queueFollowUpThenSwitchToAppServer(page, appServerSteeringState(currentGoal))

    await expect(page.getByTestId('code-agent-chat-view')).toBeVisible()
    await expect(page.getByTestId('code-agent-terminal-view')).toHaveCount(0)
    await expect(page.getByTestId('code-codex-goal-bar')).toBeVisible()
    await expect(page.getByTestId('code-codex-goal-input')).toContainText('完成并持续打磨')
    await expect(page.getByTestId('code-pending-followup')).toBeVisible()
    await expect(page.getByTestId('code-app-server-request')).toBeVisible()

    const metrics = await layoutMetrics(page)
    expect(metrics.documentScrollWidth).toBe(metrics.innerWidth)
    expect(metrics.goal?.width).toBeLessThanOrEqual(520)
    expect(metrics.goal?.bottom ?? 0).toBeLessThanOrEqual((metrics.composer?.top ?? 0) + 1)
    expect(metrics.request?.top ?? 0).toBeGreaterThanOrEqual(metrics.composer?.top ?? 0)
    expect(metrics.request?.bottom ?? 0).toBeLessThanOrEqual((metrics.composer?.bottom ?? 0) + 1)
    expect(metrics.pending?.bottom ?? 0).toBeLessThanOrEqual((metrics.composer?.bottom ?? 0) + 1)

    await page.getByTestId('code-codex-goal-edit').click()
    await page.getByTestId('code-codex-goal-input').fill('更新后的目标')
    await page.getByTestId('code-codex-goal-edit').click()
    await expect.poll(() => goalApi.patches.length).toBeGreaterThanOrEqual(1)
    expect(goalApi.patches).toContainEqual(expect.objectContaining({ objective: '更新后的目标', status: 'active' }))

    await page.getByTestId('code-codex-goal-toggle').click()
    await expect.poll(() => goalApi.currentGoal()?.status).toBe('paused')
    await page.getByTestId('code-codex-goal-delete').click()
    await expect(page.getByTestId('code-codex-goal-bar')).toBeHidden()
  })

  test('keeps mobile goal card above the composer with queued follow-up and steering request expanded', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'maxTouchPoints', { value: 1, configurable: true })
    })
    const currentGoal = goal(Date.now())
    await mockGoalApi(page, currentGoal)
    await mockAgentSideApis(page)
    await installStateSocket(page, cliWorkingState())
    await page.setViewportSize({ width: 390, height: 844 })
    await openFarming(page)

    await queueFollowUpThenSwitchToAppServer(page, appServerSteeringState(currentGoal))

    await expect(page.getByTestId('code-codex-goal-bar')).toBeVisible()
    await expect(page.getByTestId('code-pending-followup')).toBeVisible()
    await expect(page.getByTestId('code-app-server-request')).toBeVisible()

    const metrics = await layoutMetrics(page)
    expect(metrics.documentScrollWidth).toBe(metrics.innerWidth)
    expect(metrics.goal?.left ?? 0).toBeGreaterThanOrEqual(12)
    expect(metrics.goal?.right ?? 0).toBeLessThanOrEqual(metrics.innerWidth - 12)
    expect(metrics.goal?.bottom ?? 0).toBeLessThanOrEqual((metrics.composer?.top ?? 0) + 1)
    expect(metrics.composer?.height ?? 0).toBeGreaterThan(112)
    expect(metrics.request?.bottom ?? 0).toBeLessThanOrEqual((metrics.composer?.bottom ?? 0) + 1)
    expect(metrics.pending?.bottom ?? 0).toBeLessThanOrEqual((metrics.composer?.bottom ?? 0) + 1)

    await page.getByTestId('code-codex-goal-toggle').click()
    await expect(page.getByTestId('code-codex-goal-toggle')).toBeVisible()
  })
})
