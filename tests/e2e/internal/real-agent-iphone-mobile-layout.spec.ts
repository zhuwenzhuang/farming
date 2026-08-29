import fs from 'node:fs'
import path from 'node:path'
import type { Page, TestInfo } from '@playwright/test'
import { expect, openFarming, test } from '../fixtures'
import { createAcceptanceEvidence } from '../acceptance-evidence'

const IPHONE_VIEWPORT = { width: 390, height: 844 }
const AUDIT_DIR = path.resolve(
  process.env.FARMING_REAL_AGENT_IPHONE_AUDIT_DIR || '.tmp/real-agent-iphone-audit',
)
const AUDIT_WORKSPACE = path.join(process.cwd(), '.tmp', 'real-agent-iphone-workspace')
let realAgentEvidence: ReturnType<typeof createAcceptanceEvidence> | null = null

type PublicAgent = {
  id: string
  command?: string
  runtimeBinding?: { kind?: string, state?: string }
  status?: string
  acpState?: string
}

async function controlAgents(page: Page) {
  const response = await page.request.get('/farming/api/control/agents')
  expect(response.ok()).toBeTruthy()
  const body = await response.json() as { agents?: PublicAgent[] }
  return body.agents ?? []
}

async function waitForAgent(
  page: Page,
  agentId: string,
  predicate: (agent: PublicAgent) => boolean,
  timeout = 120_000,
) {
  await expect.poll(async () => {
    const current = (await controlAgents(page)).find(agent => agent.id === agentId)
    return Boolean(current && predicate(current))
  }, { timeout }).toBe(true)
}

async function createAgent(page: Page, command: string, runtime: 'terminal' | 'chat') {
  const response = await page.request.post('/farming/api/control/agents', {
    data: { command, workspace: AUDIT_WORKSPACE, agentRuntimeMode: runtime },
  })
  const body = await response.json() as { agentId?: string, error?: string }
  expect(response.ok(), body.error || `Failed to create real ${command} ${runtime} Agent`).toBeTruthy()
  expect(body.agentId).toBeTruthy()
  const agentId = body.agentId as string
  await waitForAgent(page, agentId, agent => (
    agent.status === 'running'
    && agent.runtimeBinding?.kind === (runtime === 'chat' ? 'acp' : 'terminal')
    && (runtime !== 'chat' || agent.runtimeBinding.state === 'idle')
  ))
  return agentId
}

async function assertCenterHitTarget(locator: ReturnType<Page['locator']>) {
  await expect.poll(async () => locator.evaluate(element => {
    const rect = element.getBoundingClientRect()
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
    return rect.width > 0 && rect.height > 0 && Boolean(hit && (hit === element || element.contains(hit)))
  }), {
    message: 'Composer center should be the topmost touch target',
  }).toBe(true)
}

async function assertMobileComposerTouchTarget(locator: ReturnType<Page['locator']>) {
  await expect(locator).toBeVisible()
  const box = await locator.boundingBox()
  expect(box).not.toBeNull()
  expect(box!.width).toBeGreaterThanOrEqual(44)
  expect(box!.height).toBeGreaterThanOrEqual(44)
  expect(box!.x).toBeGreaterThanOrEqual(0)
  expect(box!.y).toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width).toBeLessThanOrEqual(IPHONE_VIEWPORT.width)
  expect(box!.y + box!.height).toBeLessThanOrEqual(IPHONE_VIEWPORT.height)
  expect(await locator.evaluate(element => {
    const rect = element.getBoundingClientRect()
    const composer = element.closest<HTMLElement>('.code-composer')?.getBoundingClientRect()
    return Boolean(composer
      && rect.left >= composer.left
      && rect.right <= composer.right
      && rect.top >= composer.top
      && rect.bottom <= composer.bottom)
  })).toBe(true)
  await assertCenterHitTarget(locator)
}

async function assertMobileDrawerClosed(page: Page) {
  const sidebar = page.getByTestId('code-sidebar')
  await expect(sidebar).toHaveClass(/collapsed/)
  await expect(page.getByTestId('code-mobile-sidebar-backdrop')).toHaveCount(0)
  await expect(page.locator('.code-context-menu:visible')).toHaveCount(0)

  const geometry = () => sidebar.evaluate(element => {
    const rect = element.getBoundingClientRect()
    const workspaceLeft = document.querySelector<HTMLElement>('[data-testid="code-workspace"]')
      ?.getBoundingClientRect().left ?? 0
    return {
      left: Math.round(rect.left * 10) / 10,
      right: Math.round(rect.right * 10) / 10,
      width: Math.round(rect.width * 10) / 10,
      transform: getComputedStyle(element).transform,
      runningAnimations: element.getAnimations().filter(animation => animation.playState === 'running').length,
      closed: rect.right <= workspaceLeft - 1,
    }
  })
  await expect.poll(async () => {
    const current = await geometry()
    return current.closed && current.runningAnimations === 0
  }, {
    message: 'Mobile sidebar should finish translating outside the viewport',
  }).toBe(true)
  const before = await geometry()
  await page.evaluate(() => new Promise<void>(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  }))
  expect(await geometry()).toEqual(before)
}

async function assertMobileDrawerOpen(page: Page, agentIds: string[]) {
  const sidebar = page.getByTestId('code-sidebar')
  const backdrop = page.getByTestId('code-mobile-sidebar-backdrop')
  await expect(sidebar).not.toHaveClass(/collapsed/)
  await expect(backdrop).toBeVisible()
  await expect.poll(async () => sidebar.evaluate(element => ({
    left: element.getBoundingClientRect().left,
    runningAnimations: element.getAnimations().filter(animation => animation.playState === 'running').length,
  }))).toEqual({ left: 0, runningAnimations: 0 })
  const sidebarBox = await sidebar.boundingBox()
  expect(sidebarBox).not.toBeNull()
  for (const agentId of agentIds) {
    const row = sidebar.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
    await expect(row).toBeVisible()
    const rowBox = await row.boundingBox()
    expect(rowBox).not.toBeNull()
    expect(rowBox!.height).toBeGreaterThanOrEqual(44)
    expect(rowBox!.x).toBeGreaterThanOrEqual(sidebarBox!.x)
    expect(rowBox!.x + rowBox!.width).toBeLessThanOrEqual(sidebarBox!.x + sidebarBox!.width)
    expect(rowBox!.y).toBeGreaterThanOrEqual(0)
    expect(rowBox!.y + rowBox!.height).toBeLessThanOrEqual(IPHONE_VIEWPORT.height)
    await row.click({ trial: true })
  }
}

async function activateAgent(page: Page, agentId: string, runtime: 'terminal' | 'chat') {
  const row = page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
  await page.getByTestId('code-mobile-menu').tap()
  await expect(row).toBeVisible({ timeout: 30_000 })
  await row.locator('.code-agent-row-copy').tap()
  const activePane = page.locator(`[data-testid="code-agent-work-pane"][data-agent-id="${agentId}"]`)
  await expect(activePane).toHaveClass(/active/)
  await expect(activePane).toBeVisible()
  await assertMobileDrawerClosed(page)
  if (runtime === 'chat') {
    await waitForAgent(page, agentId, agent => (
      agent.runtimeBinding?.kind === 'acp' && agent.runtimeBinding.state === 'idle'
    ))
  }
  const input = activeComposerInput(page)
  await expect(input).toBeVisible({ timeout: 60_000 })
  await assertCenterHitTarget(input)
}

async function reloadAndActivateAgent(
  page: Page,
  agentId: string,
  runtime: 'terminal' | 'chat',
  appearance?: 'light' | 'dark',
) {
  await page.goto('about:blank')
  await openFarming(page)
  await expect(page.locator('body')).toHaveClass(/code-compact-layout/)
  await expect(page.locator('body')).toHaveClass(/code-mobile-touch/)
  if (appearance) await page.evaluate(value => document.body.setAttribute('data-appearance', value), appearance)
  await activateAgent(page, agentId, runtime)
  if (runtime === 'terminal') await waitForTerminal(page, agentId)
}

async function waitForTerminal(page: Page, agentId: string) {
  await page.waitForFunction(id => Boolean(window.__farmingTerminalTest?.isReady(id)), agentId, { timeout: 60_000 })
  await expect.poll(async () => page.evaluate(
    id => window.__farmingTerminalTest?.getBufferDiagnostics(id)?.renderer ?? '',
    agentId,
  ), { timeout: 60_000 }).toBe('webgl')
  await expect(page.locator(`[data-testid="code-terminal-pane"][data-agent-id="${agentId}"]`)
    .getByTestId('code-terminal-status-card')).toHaveCount(0)
}

async function terminalRows(page: Page, agentId: string) {
  return page.evaluate(id => window.__farmingTerminalTest?.getRows(id, 10_000) ?? [], agentId)
}

function activeComposerInput(page: Page) {
  return page.locator('[data-testid="code-composer-input"]:visible, [data-testid="code-acp-composer-input"]:visible')
}

function activeComposerSend(page: Page) {
  return page.locator('[data-testid="code-composer-send"]:visible, [data-testid="code-acp-composer-send"]:visible')
}

async function sendComposerText(page: Page, text: string, useTap = true) {
  const input = activeComposerInput(page)
  const send = activeComposerSend(page)
  if (useTap) await input.tap()
  else await input.click()
  await page.keyboard.insertText(text)
  await expect(input).toHaveValue(text)
  await expect(send).toHaveAttribute('data-action', 'send', { timeout: 60_000 })
  if (useTap) await send.tap()
  else await send.click()
  await expect(input).toHaveValue('')
}

async function sendLongComposerText(page: Page, text: string) {
  const input = activeComposerInput(page)
  const send = activeComposerSend(page)
  await input.tap()
  await input.fill(text)
  await expect(input).toHaveValue(text)
  await expect(send).toHaveAttribute('data-action', 'send', { timeout: 60_000 })
  expect(await send.evaluate(element => {
    const rect = element.getBoundingClientRect()
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
    return hit === element || element.contains(hit)
  })).toBe(true)
  await send.click()
  await expect(input).toHaveValue('')
}

async function waitForChatAnswer(page: Page, anchor: string, timeout = 180_000) {
  const answer = page.locator('.code-agent-transcript-assistant.code-markdown-preview')
    .filter({ hasText: anchor })
    .last()
  await expect(answer).toBeVisible({ timeout })
  await expect(activeComposerSend(page)).not.toHaveAttribute('data-action', 'interrupt', { timeout })
}

async function assertTranscriptOverflows(page: Page) {
  const scroller = page.locator('.code-agent-work-pane.active').getByTestId('code-agent-transcript-scroll')
  await expect(scroller).toBeVisible()
  expect(await scroller.evaluate(element => element.scrollHeight > element.clientHeight + 1)).toBe(true)
}

async function assertCompactVisualBounds(
  page: Page,
  expectedAgentId: string,
  expectedAgentTitle: string,
  expectedDrawer: 'closed' | 'open',
  expectedSurface: 'terminal' | 'chat',
) {
  await expect(page.locator('.code-agent-work-pane.active')).toHaveAttribute('data-agent-id', expectedAgentId)
  const metrics = await page.evaluate(surface => {
    const main = document.querySelector('[data-testid="code-main"]')?.getBoundingClientRect()
    const topbarElement = document.querySelector<HTMLElement>('[data-testid="code-mobile-topbar"]')
    const topbar = topbarElement?.getBoundingClientRect()
    const topbarTitle = topbarElement?.querySelector<HTMLElement>('.code-mobile-topbar-title strong')
    const composer = Array.from(document.querySelectorAll<HTMLElement>('.code-composer'))
      .find(element => element.getBoundingClientRect().width > 0)
      ?.getBoundingClientRect()
    const composerElement = Array.from(document.querySelectorAll<HTMLElement>('.code-composer'))
      .find(element => element.getBoundingClientRect().width > 0)
    const input = composerElement?.querySelector<HTMLElement>('textarea')?.getBoundingClientRect()
    const toolbar = composerElement?.querySelector<HTMLElement>('.code-composer-toolbar')?.getBoundingClientRect()
    const menu = topbarElement?.querySelector<HTMLElement>('[data-testid="code-mobile-menu"]')
    const more = topbarElement?.querySelector<HTMLElement>('[data-testid="code-mobile-more"]')
    const add = composerElement?.querySelector<HTMLElement>('[data-testid="code-composer-add"], [data-testid="code-acp-composer-add"]')
    const permission = composerElement?.querySelector<HTMLElement>('[data-testid="code-composer-approval"], [data-testid="code-acp-mode"]')
    const send = composerElement?.querySelector<HTMLElement>('[data-testid="code-composer-send"], [data-testid="code-acp-composer-send"]')
    const model = composerElement?.querySelector<HTMLElement>('[data-testid="code-composer-model-picker"], [data-testid="code-acp-model-picker"]')
    if (
      !main || !topbar || !topbarElement || !topbarTitle || !composer || !composerElement
      || !input || !toolbar || !menu || !more || !send
      || (surface === 'chat' && (!add || !permission || !model))
    ) {
      throw new Error('Compact iPhone surface is incomplete')
    }
    const rect = (element: HTMLElement) => {
      const value = element.getBoundingClientRect()
      return {
        left: value.left,
        top: value.top,
        right: value.right,
        bottom: value.bottom,
        width: value.width,
        height: value.height,
      }
    }
    const centerIsHitTarget = (element: HTMLElement) => {
      const value = element.getBoundingClientRect()
      const hit = document.elementFromPoint(value.left + value.width / 2, value.top + value.height / 2)
      return Boolean(hit && (hit === element || element.contains(hit)))
    }
    const sidebar = document.querySelector<HTMLElement>('[data-testid="code-sidebar"]')
    const sidebarClosed = sidebar?.classList.contains('collapsed') ?? false
    const backdrop = document.querySelector<HTMLElement>('[data-testid="code-mobile-sidebar-backdrop"]')
    const visibleAgentRows = sidebar
      ? Array.from(sidebar.querySelectorAll<HTMLElement>('[data-testid="code-agent-row"][data-agent-id]'))
        .filter(element => element.getBoundingClientRect().width > 0)
      : []
    const composerControls = surface === 'chat'
      ? [add!, permission!, model!, send]
      : [send]
    return {
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      bodyScrollWidth: document.body.scrollWidth,
      rootScrollWidth: document.documentElement.scrollWidth,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      mainLeft: main.left,
      mainRight: main.right,
      composerLeft: composer.left,
      composerRight: composer.right,
      composerBottom: composer.bottom,
      topbar: rect(topbarElement),
      title: topbarTitle.textContent?.trim() ?? '',
      input: rect(composerElement.querySelector<HTMLElement>('textarea')!),
      toolbar: rect(composerElement.querySelector<HTMLElement>('.code-composer-toolbar')!),
      menu: rect(menu),
      more: rect(more),
      composerControls: composerControls.map(rect),
      sidebarClosed,
      backdropVisible: Boolean(backdrop && backdrop.getBoundingClientRect().width > 0),
      visibleAgentRowCount: visibleAgentRows.length,
      mainControlsAreHitTargets: [menu, more, ...composerControls]
        .every(centerIsHitTarget),
    }
  }, expectedSurface)
  expect(metrics.viewportWidth).toBe(IPHONE_VIEWPORT.width)
  expect(metrics.viewportHeight).toBe(IPHONE_VIEWPORT.height)
  expect(metrics.bodyScrollWidth).toBeLessThanOrEqual(IPHONE_VIEWPORT.width + 1)
  expect(metrics.rootScrollWidth).toBeLessThanOrEqual(IPHONE_VIEWPORT.width + 1)
  expect(metrics.scrollX).toBe(0)
  expect(metrics.scrollY).toBe(0)
  expect(metrics.mainLeft).toBeCloseTo(0, 2)
  expect(metrics.mainRight).toBeCloseTo(IPHONE_VIEWPORT.width, 2)
  expect(metrics.topbar.left).toBeCloseTo(0, 2)
  expect(metrics.topbar.right).toBeCloseTo(IPHONE_VIEWPORT.width, 2)
  expect(metrics.topbar.top).toBeGreaterThanOrEqual(0)
  expect(metrics.topbar.bottom).toBeLessThanOrEqual(52)
  expect(metrics.title).toBe(expectedAgentTitle)
  expect(metrics.menu.width).toBeGreaterThanOrEqual(44)
  expect(metrics.menu.height).toBeGreaterThanOrEqual(44)
  expect(metrics.more.width).toBeGreaterThanOrEqual(44)
  expect(metrics.more.height).toBeGreaterThanOrEqual(44)
  expect(metrics.composerLeft).toBeGreaterThanOrEqual(3.99)
  expect(metrics.composerRight).toBeLessThanOrEqual(IPHONE_VIEWPORT.width - 3.99)
  expect(metrics.composerBottom).toBeLessThanOrEqual(metrics.viewportHeight)
  expect(metrics.input.height).toBeGreaterThanOrEqual(22)
  expect(metrics.toolbar.height).toBeGreaterThanOrEqual(44)
  for (const control of metrics.composerControls) {
    expect(control.width).toBeGreaterThanOrEqual(44)
    expect(control.height).toBeGreaterThanOrEqual(44)
    expect(control.left).toBeGreaterThanOrEqual(metrics.composerLeft)
    expect(control.right).toBeLessThanOrEqual(metrics.composerRight)
    expect(control.top).toBeGreaterThanOrEqual(0)
    expect(control.bottom).toBeLessThanOrEqual(metrics.viewportHeight)
  }
  if (expectedDrawer === 'closed') {
    expect(metrics.sidebarClosed).toBe(true)
    expect(metrics.backdropVisible).toBe(false)
    expect(metrics.mainControlsAreHitTargets).toBe(true)
  } else {
    expect(metrics.sidebarClosed).toBe(false)
    expect(metrics.backdropVisible).toBe(true)
    expect(metrics.visibleAgentRowCount).toBe(3)
  }
}

type CaptureScenario = {
  agentId: string
  agentTitle: string
  appearance: 'light' | 'dark'
  surface: 'terminal' | 'chat-empty' | 'chat'
  drawer?: 'closed' | 'open'
  assertReady: () => Promise<void>
  stableLocators?: ReturnType<Page['locator']>[]
}

async function capture(
  page: Page,
  testInfo: TestInfo,
  name: string,
  scenario: CaptureScenario,
) {
  const expectedDrawer = scenario.drawer ?? 'closed'
  const assertCaptureReady = async () => {
    await expect(page.locator('body')).toHaveAttribute('data-appearance', scenario.appearance)
    await assertCompactVisualBounds(
      page,
      scenario.agentId,
      scenario.agentTitle,
      expectedDrawer,
      scenario.surface === 'terminal' ? 'terminal' : 'chat',
    )
    await scenario.assertReady()
  }
  await assertCaptureReady()
  await page.waitForTimeout(350)
  if (!realAgentEvidence) throw new Error('Real Agent iPhone evidence recorder was not initialized')
  const stableLocators = [
    page.getByTestId('code-mobile-topbar'),
    page.locator('.code-composer:visible'),
    page.locator('.code-agent-work-pane.active'),
    page.locator('.code-agent-work-view.active'),
    ...(scenario.surface === 'terminal'
      ? [page.locator('.code-agent-work-pane.active .xterm-viewport')]
      : scenario.surface === 'chat-empty'
        ? [page.locator('.code-agent-work-pane.active').getByTestId('code-agent-transcript')]
        : [page.locator('.code-agent-work-pane.active').getByTestId('code-agent-transcript-scroll')]),
    ...(expectedDrawer === 'open'
      ? [page.getByTestId('code-sidebar'), page.getByTestId('code-mobile-sidebar-backdrop')]
      : []),
    ...(scenario.stableLocators ?? []),
  ]
  const screenshotPath = await realAgentEvidence.capture({
    page,
    testInfo,
    screenshotName: name,
    scenario: name.replace(/\.png$/i, ''),
    settledAssertion: 'Real Agent scenario reached its asserted state and compact visual bounds passed',
    assertReady: assertCaptureReady,
    proofLocator: page.getByTestId('code-main'),
    expectedTestId: 'code-main',
    stableLocators,
  })
  await testInfo.attach(name, { path: screenshotPath, contentType: 'image/png' })
}

test.describe('real Agent iPhone visual audit', () => {
  test.beforeAll(() => {
    if (process.env.FARMING_REAL_AGENT_IPHONE_AUDIT !== '1') {
      throw new Error('Set FARMING_REAL_AGENT_IPHONE_AUDIT=1 to run the real iPhone Agent audit')
    }
    if (process.env.FARMING_E2E_REAL_CODEX !== '1') {
      throw new Error('The real iPhone Agent audit cannot run with fake executables')
    }
    realAgentEvidence = createAcceptanceEvidence(AUDIT_DIR, {
      manifestFileName: 'manifest-real-agent-iphone-mobile-layout.json',
    })
    fs.mkdirSync(AUDIT_DIR, { recursive: true })
    fs.rmSync(AUDIT_WORKSPACE, { recursive: true, force: true })
    fs.mkdirSync(AUDIT_WORKSPACE, { recursive: true })
    fs.writeFileSync(path.join(AUDIT_WORKSPACE, 'README.md'), '# Real Agent iPhone visual audit\n')
    fs.copyFileSync(
      path.resolve('public/farming-2/app-icon-v2-180.png'),
      path.join(AUDIT_WORKSPACE, 'attachment.png'),
    )
  })

  test.afterAll(() => {
    fs.rmSync(AUDIT_WORKSPACE, { recursive: true, force: true })
  })

  test('captures terminal and Chat states from real bash, Codex, and OpenCode Agents', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'iphone-webkit', 'Runs only in the iPhone WebKit project')
    test.setTimeout(12 * 60_000)
    await page.setViewportSize(IPHONE_VIEWPORT)
    await openFarming(page)
    await expect(page.locator('body')).toHaveClass(/code-compact-layout/)
    await expect(page.locator('body')).toHaveClass(/code-mobile-touch/)

    const bashAgentId = await createAgent(page, 'bash', 'terminal')
    await activateAgent(page, bashAgentId, 'terminal')
    await waitForTerminal(page, bashAgentId)
    await capture(page, testInfo, '01-bash-terminal-idle-light.png', {
      agentId: bashAgentId,
      agentTitle: 'bash',
      appearance: 'light',
      surface: 'terminal',
      assertReady: async () => {
        await waitForTerminal(page, bashAgentId)
        await expect(activeComposerInput(page)).toHaveValue('')
        await assertMobileDrawerClosed(page)
      },
    })
    await reloadAndActivateAgent(page, bashAgentId, 'terminal')

    const bashShort = 'IPHONE_BASH_SHORT_OK'
    await sendComposerText(page, "printf 'IPHONE_BASH_SHORT_%s\\n' 'OK'")
    await expect.poll(async () => (await terminalRows(page, bashAgentId)).join('\n')).toContain(bashShort)
    await capture(page, testInfo, '02-bash-terminal-short-light.png', {
      agentId: bashAgentId,
      agentTitle: 'bash',
      appearance: 'light',
      surface: 'terminal',
      assertReady: async () => {
        expect((await terminalRows(page, bashAgentId)).join('\n')).toContain(bashShort)
        await assertMobileDrawerClosed(page)
      },
    })
    await reloadAndActivateAgent(page, bashAgentId, 'terminal')

    const bashDenseEnd = 'IPHONE_BASH_DENSE_END'
    await sendLongComposerText(page, "for i in $(seq -w 1 36); do echo IPHONE_BASH_LINE_$i; done; printf '中文终端正常\\nIPHONE_BASH_DENSE_%s\\n' 'END'")
    await expect.poll(async () => (await terminalRows(page, bashAgentId)).join('\n')).toContain(bashDenseEnd)
    await capture(page, testInfo, '03-bash-terminal-dense-light.png', {
      agentId: bashAgentId,
      agentTitle: 'bash',
      appearance: 'light',
      surface: 'terminal',
      assertReady: async () => {
        expect((await terminalRows(page, bashAgentId)).join('\n')).toContain(bashDenseEnd)
        await assertMobileDrawerClosed(page)
      },
    })
    await reloadAndActivateAgent(page, bashAgentId, 'terminal')

    const bashDraft = "printf 'draft line one'\nprintf 'draft line two 中文'"
    const bashInput = activeComposerInput(page)
    await bashInput.tap()
    await bashInput.fill(bashDraft)
    await expect(bashInput).toBeFocused()
    await capture(page, testInfo, '04-bash-terminal-focused-draft-light.png', {
      agentId: bashAgentId,
      agentTitle: 'bash',
      appearance: 'light',
      surface: 'terminal',
      assertReady: async () => {
        await expect(activeComposerInput(page)).toBeFocused()
        await expect(activeComposerInput(page)).toHaveValue(bashDraft)
        expect((await terminalRows(page, bashAgentId)).join('\n')).toContain(bashDenseEnd)
        await assertMobileDrawerClosed(page)
      },
    })
    await bashInput.fill('')
    await reloadAndActivateAgent(page, bashAgentId, 'terminal')

    const codexAgentId = await createAgent(page, 'codex', 'chat')
    await activateAgent(page, codexAgentId, 'chat')
    await expect(page.getByTestId('code-agent-transcript')).toBeVisible({ timeout: 60_000 })
    await expect(page.getByTestId('code-agent-transcript').getByRole('status')).toContainText('No conversation yet.')
    await capture(page, testInfo, '05-codex-chat-empty-light.png', {
      agentId: codexAgentId,
      agentTitle: 'Codex',
      appearance: 'light',
      surface: 'chat-empty',
      assertReady: async () => {
        const transcript = page.locator(`.code-agent-work-pane.active[data-agent-id="${codexAgentId}"]`)
          .getByTestId('code-agent-transcript')
        await expect(transcript.locator('.code-agent-transcript-blank')).toHaveText('No conversation yet.')
        await expect(activeComposerSend(page)).not.toHaveAttribute('data-action', 'interrupt')
        await assertMobileDrawerClosed(page)
      },
    })
    await reloadAndActivateAgent(page, codexAgentId, 'chat')

    const codexShort = 'IPHONE_CODEX_SHORT_OK'
    await sendComposerText(page, `Do not use tools. Reply with only ${codexShort}.`)
    await waitForChatAnswer(page, codexShort)
    await capture(page, testInfo, '06-codex-chat-short-light.png', {
      agentId: codexAgentId,
      agentTitle: 'Codex',
      appearance: 'light',
      surface: 'chat',
      assertReady: async () => {
        await expect(page.locator('.code-agent-transcript-assistant.code-markdown-preview')
          .filter({ hasText: codexShort }).last()).toBeVisible()
        await expect(activeComposerSend(page)).not.toHaveAttribute('data-action', 'interrupt')
        await assertMobileDrawerClosed(page)
      },
    })
    await reloadAndActivateAgent(page, codexAgentId, 'chat')

    const codexDenseEnd = 'IPHONE_CODEX_DENSE_END'
    const codexDensePrompt = `Do not use tools or inspect files. Return only Markdown. Start with # iPhone Codex Audit. Include one short paragraph, a three-item bullet list, a two-row table, one fenced JSON block, the line 中文聊天正常, then 60 separate lines CODEX_MOBILE_LINE_01 through CODEX_MOBILE_LINE_60. Do not abbreviate or combine lines. End with ${codexDenseEnd}.`
    await sendLongComposerText(page, codexDensePrompt)
    await expect(activeComposerSend(page)).toHaveAttribute('data-action', 'interrupt', { timeout: 60_000 })
    const codexRunningTranscript = page.locator(`.code-agent-work-pane.active[data-agent-id="${codexAgentId}"]`)
      .getByTestId('code-agent-transcript')
    let codexRunningSnapshot: string | null = null
    await capture(page, testInfo, '07-codex-chat-running-light.png', {
      agentId: codexAgentId,
      agentTitle: 'Codex',
      appearance: 'light',
      surface: 'chat',
      assertReady: async () => {
        await expect(activeComposerSend(page)).toHaveAttribute('data-action', 'interrupt')
        await expect(codexRunningTranscript.getByText('Processing', { exact: true })).toBeVisible()
        const current = await codexRunningTranscript.innerText()
        if (codexRunningSnapshot === null) codexRunningSnapshot = current
        else expect(current).toBe(codexRunningSnapshot)
        await assertMobileDrawerClosed(page)
      },
    })
    await waitForChatAnswer(page, codexDenseEnd, 240_000)
    await reloadAndActivateAgent(page, codexAgentId, 'chat')
    await page.evaluate(() => document.body.setAttribute('data-appearance', 'dark'))
    await capture(page, testInfo, '08-codex-chat-dense-dark.png', {
      agentId: codexAgentId,
      agentTitle: 'Codex',
      appearance: 'dark',
      surface: 'chat',
      assertReady: async () => {
        const answer = page.locator('.code-agent-transcript-assistant.code-markdown-preview')
          .filter({ hasText: codexDenseEnd }).last()
        await expect(answer).toBeVisible()
        await expect(answer).toContainText('CODEX_MOBILE_LINE_01')
        await expect(answer).toContainText('CODEX_MOBILE_LINE_30')
        await expect(answer).toContainText('CODEX_MOBILE_LINE_60')
        await expect(answer.getByRole('heading', { name: 'iPhone Codex Audit' })).toHaveCount(1)
        await expect(answer.locator('table')).toHaveCount(1)
        await expect(answer.locator('pre')).toHaveCount(1)
        await assertTranscriptOverflows(page)
        await expect(activeComposerSend(page)).not.toHaveAttribute('data-action', 'interrupt')
        await expect(page.locator('body')).toHaveAttribute('data-appearance', 'dark')
        await assertMobileDrawerClosed(page)
      },
    })
    await reloadAndActivateAgent(page, codexAgentId, 'chat', 'dark')

    const openCodeAgentId = await createAgent(page, 'opencode', 'chat')
    await activateAgent(page, openCodeAgentId, 'chat')
    const assertOpenCodeEmptyReady = async () => {
      await waitForAgent(page, openCodeAgentId, agent => (
        agent.runtimeBinding?.kind === 'acp' && agent.runtimeBinding.state === 'idle'
      ))
      const transcript = page.getByTestId('code-agent-transcript')
      const emptyState = transcript.locator('.code-agent-transcript-blank')
      await expect(transcript).toBeVisible({ timeout: 60_000 })
      await expect(emptyState).toHaveCount(1)
      await expect(emptyState).toHaveText('No conversation yet.')
      await expect(page.getByTestId('code-acp-composer')).toBeVisible()
      await expect(page.getByTestId('code-acp-model-picker')).toBeVisible()
      await expect(activeComposerInput(page)).toBeVisible()
      await assertMobileDrawerClosed(page)
      await assertCenterHitTarget(activeComposerInput(page))
    }
    await assertOpenCodeEmptyReady()
    await capture(page, testInfo, '09-opencode-chat-empty-dark.png', {
      agentId: openCodeAgentId,
      agentTitle: 'OpenCode',
      appearance: 'dark',
      surface: 'chat-empty',
      assertReady: assertOpenCodeEmptyReady,
    })
    await reloadAndActivateAgent(page, openCodeAgentId, 'chat', 'dark')

    await page.getByTestId('code-acp-composer-add').tap()
    const plusMenu = page.getByTestId('code-acp-plus-menu')
    await expect(plusMenu).toBeVisible()
    const fileChooserPromise = page.waitForEvent('filechooser')
    await page.getByTestId('code-acp-composer-attach-file').tap()
    const fileChooser = await fileChooserPromise
    await fileChooser.setFiles(path.join(AUDIT_WORKSPACE, 'attachment.png'))
    const attachment = page.getByTestId('code-composer-attachment')
    const removeAttachment = attachment.getByRole('button', { name: 'Remove attachment.png' })
    await expect(attachment).toHaveClass(/image/)
    await expect(attachment).toHaveClass(/ready/, { timeout: 15_000 })
    await assertMobileComposerTouchTarget(removeAttachment)
    await capture(page, testInfo, '10-opencode-chat-image-attachment-dark.png', {
      agentId: openCodeAgentId,
      agentTitle: 'OpenCode',
      appearance: 'dark',
      surface: 'chat-empty',
      stableLocators: [attachment],
      assertReady: async () => {
        await expect(attachment).toHaveCount(1)
        await expect(attachment).toHaveClass(/image/)
        await expect(attachment).toHaveClass(/ready/)
        await expect(removeAttachment).toBeVisible()
        await assertMobileComposerTouchTarget(removeAttachment)
        await assertMobileDrawerClosed(page)
      },
    })
    await reloadAndActivateAgent(page, openCodeAgentId, 'chat', 'dark')
    const restoredAttachment = page.getByTestId('code-composer-attachment')
    await expect(restoredAttachment).toHaveCount(1)
    await restoredAttachment.getByRole('button', { name: 'Remove attachment.png' }).tap()
    await expect(restoredAttachment).toHaveCount(0)

    const openCodeShort = 'IPHONE_OPENCODE_SHORT_OK'
    await sendComposerText(page, `Do not use tools. Reply with only ${openCodeShort}.`)
    await waitForChatAnswer(page, openCodeShort)
    await capture(page, testInfo, '11-opencode-chat-short-dark.png', {
      agentId: openCodeAgentId,
      agentTitle: 'OpenCode',
      appearance: 'dark',
      surface: 'chat',
      assertReady: async () => {
        await expect(page.locator('.code-agent-transcript-assistant.code-markdown-preview')
          .filter({ hasText: openCodeShort }).last()).toBeVisible()
        await expect(activeComposerSend(page)).not.toHaveAttribute('data-action', 'interrupt')
        await assertMobileDrawerClosed(page)
      },
    })
    await reloadAndActivateAgent(page, openCodeAgentId, 'chat', 'dark')

    const openCodeDenseEnd = 'IPHONE_OPENCODE_DENSE_END'
    const openCodeDensePrompt = `Do not use tools or inspect files. Print 36 separate lines OPENCODE_MOBILE_LINE_01 through OPENCODE_MOBILE_LINE_36, then print 中文显示正常, and finish with ${openCodeDenseEnd}. Do not abbreviate or combine lines.`
    await sendLongComposerText(page, openCodeDensePrompt)
    await waitForChatAnswer(page, openCodeDenseEnd, 240_000)
    await capture(page, testInfo, '12-opencode-chat-dense-dark.png', {
      agentId: openCodeAgentId,
      agentTitle: 'OpenCode',
      appearance: 'dark',
      surface: 'chat',
      assertReady: async () => {
        const answer = page.locator('.code-agent-transcript-assistant.code-markdown-preview')
          .filter({ hasText: openCodeDenseEnd }).last()
        await expect(answer).toBeVisible()
        await expect(answer).toContainText('OPENCODE_MOBILE_LINE_01')
        await expect(answer).toContainText('OPENCODE_MOBILE_LINE_18')
        await expect(answer).toContainText('OPENCODE_MOBILE_LINE_36')
        await assertTranscriptOverflows(page)
        await expect(activeComposerSend(page)).not.toHaveAttribute('data-action', 'interrupt')
        await assertMobileDrawerClosed(page)
      },
    })
    await reloadAndActivateAgent(page, openCodeAgentId, 'chat', 'dark')

    await page.getByTestId('code-mobile-menu').click()
    await expect(page.getByTestId('code-sidebar')).not.toHaveClass(/collapsed/)
    await expect(page.locator('[data-testid="code-agent-row"][data-agent-id]')).toHaveCount(3)
    await capture(page, testInfo, '13-multi-agent-drawer-dark.png', {
      agentId: openCodeAgentId,
      agentTitle: 'OpenCode',
      appearance: 'dark',
      surface: 'chat',
      drawer: 'open',
      stableLocators: [
        page.locator(`[data-testid="code-agent-row"][data-agent-id="${bashAgentId}"]`),
        page.locator(`[data-testid="code-agent-row"][data-agent-id="${codexAgentId}"]`),
        page.locator(`[data-testid="code-agent-row"][data-agent-id="${openCodeAgentId}"]`),
      ],
      assertReady: async () => {
        await assertMobileDrawerOpen(page, [bashAgentId, codexAgentId, openCodeAgentId])
        await expect(page.locator(`[data-testid="code-agent-row"][data-agent-id="${openCodeAgentId}"]`))
          .toHaveClass(/active/)
      },
    })
  })
})
