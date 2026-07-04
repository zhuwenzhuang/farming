import { test as base, expect, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const PLAYWRIGHT_WORKSPACE_ROOT = path.join(os.tmpdir(), `farming-playwright-workspaces-${process.pid}`)

function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

declare global {
  interface Window {
    __FARMING_E2E__?: boolean
    __farmingFileEditorTest?: {
      focus: () => boolean
      insertText: (text: string) => boolean
      getValue: () => string
    }
    __farmingTerminalTest?: {
      getCellCenter: (agentId: string, col: number, row: number) => { x: number; y: number } | null
      getRows: (agentId: string, rowCount?: number) => string[]
      getViewport: (agentId: string) => {
        viewportY: number
        scrollbackLength: number
        following: boolean
        hasUnreadOutput: boolean
      } | null
      getInputCount: (agentId: string) => number
      getCursor: (agentId: string) => { x: number; y: number; visible?: boolean } | null
      getBufferDiagnostics: (agentId: string) => {
        engine?: string
        cols: number
        rows: number
        viewportY: number
        scrollbackLength: number
        visibleBufferBase: number
        bufferViewportY?: number
        bufferBaseY?: number
        bufferLength?: number
      } | null
      getHostDiagnostics: () => Array<{
        agentId: string
        paneAgentId: string
        inParkingLot: boolean
        recordAttached: boolean
        attachedMountMatchesParent: boolean
        visible: boolean
        hostCountInMount: number
      }>
      getCanvasInkPixelCount: (agentId: string) => number
      scrollToLine: (agentId: string, line: number) => Promise<void>
      writeFixture: (agentId: string, text: string) => Promise<void>
      writeRaw: (agentId: string, text: string) => Promise<void>
      writeSequenced: (agentId: string, text: string, outputSeq: number) => Promise<void>
      writeRawAndSampleViewport: (agentId: string, text: string) => Promise<{
        before: number
        during: number
        after: number
        beforeScrollbackLength: number
        afterScrollbackLength: number
        following: boolean
        hasUnreadOutput: boolean
      }>
      getSelection: (agentId: string) => string
      search: (agentId: string, term: string, direction?: 'next' | 'previous') => Promise<{
        found: boolean
        resultIndex?: number
        resultCount?: number
      }>
      clearSearch: (agentId: string) => Promise<void>
      getUrlAtCell: (agentId: string, col: number, row: number) => string | null
      isReady: (agentId: string) => boolean
    }
  }
}

async function cleanupAgents(page: Page) {
  try {
    const response = await page.request.get('/farming/api/control/agents')
    if (!response.ok()) return
    const data = await response.json() as { agents?: Array<{ id?: string }> }
    await Promise.all((data.agents ?? [])
      .map(agent => agent.id)
      .filter((id): id is string => Boolean(id))
      .map(id => page.request.delete(`/farming/api/control/agents/${id}`).catch(() => null)))
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const nextResponse = await page.request.get('/farming/api/control/agents').catch(() => null)
      if (!nextResponse?.ok()) return
      const nextData = await nextResponse.json() as { agents?: Array<{ id?: string }> }
      const remainingIds = (nextData.agents ?? [])
        .map(agent => agent.id)
        .filter((id): id is string => Boolean(id))
      if (remainingIds.length === 0) return
      await Promise.all(remainingIds.map(id => page.request.delete(`/farming/api/control/agents/${id}`).catch(() => null)))
      await delay(100)
    }
  } catch {
    // Best effort isolation; each test still asserts the visible starting state.
  }
}

async function resetSettings(page: Page) {
  try {
    await page.request.post('/farming/api/settings', {
      data: {
        lastMainWorkspace: '~/.farming',
        workspaceHistory: [],
        mainPageSessionKeys: [],
        appearance: 'light',
        language: 'en',
        codexApprovalMode: 'approve',
        codexModel: 'gpt-5.5',
        codexReasoningEffort: 'xhigh',
        codexServiceTier: 'default',
        codexModelPreset: 'gpt-5.5:xhigh',
        agentLaunchProfiles: {
          codex: {
            approvalMode: 'approve',
            model: 'gpt-5.5',
            reasoningEffort: 'xhigh',
            serviceTier: 'default',
            modelPreset: 'gpt-5.5:xhigh',
          },
          claude: {
            permissionMode: 'default',
            model: 'config',
            effort: 'config',
          },
        },
      },
    })
  } catch {
    // Best effort isolation; failures surface through normal UI assertions.
  }
}

export const test = base.extend<{ workspaceRoot: string }>({
  workspaceRoot: async ({}, use) => {
    fs.rmSync(PLAYWRIGHT_WORKSPACE_ROOT, { recursive: true, force: true })
    fs.mkdirSync(PLAYWRIGHT_WORKSPACE_ROOT, { recursive: true })
    await use(PLAYWRIGHT_WORKSPACE_ROOT)
    fs.rmSync(PLAYWRIGHT_WORKSPACE_ROOT, { recursive: true, force: true })
  },
  page: async ({ page, workspaceRoot }, use) => {
    void workspaceRoot
    await page.addInitScript(() => {
      window.__FARMING_E2E__ = true
    })
    await cleanupAgents(page)
    await resetSettings(page)
    await use(page)
    await cleanupAgents(page)
    await resetSettings(page)
  },
})

export { expect }

export async function openFarming(page: Page) {
  await page.goto('/farming/', { waitUntil: 'networkidle' })
  await expect(page.getByTestId('app-shell')).toBeVisible()
}

export async function selectAgent(page: Page, name: string) {
  await expect(page.getByTestId('agent-list-status')).toBeHidden({ timeout: 30_000 })
  const agentOption = page.getByTestId(`agent-option-${name}`)
  await expect(agentOption).toBeEnabled({ timeout: 30_000 })
  await agentOption.click()
  await expect(page.getByTestId('workspace-step')).toBeVisible()
}

export async function startAgentFromOpenDialog(page: Page, name: string, workspace: string) {
  const previousIds = new Set(await getAgentRowIds(page))
  await selectAgent(page, name)
  await page.getByTestId('workspace-input').fill(workspace)
  await page.getByTestId('workspace-start').click()
  await expect(page.getByTestId('input-dialog')).toBeHidden({ timeout: 30_000 })
  await expect.poll(async () => {
    const ids = await getAgentRowIds(page)
    return ids.find(id => !previousIds.has(id)) ?? ''
  }, { timeout: 30_000 }).not.toBe('')
  const agentId = (await getAgentRowIds(page)).find(id => !previousIds.has(id))
  if (!agentId) {
    throw new Error('New agent row is missing after launch')
  }
  const row = page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
  await expect(row).toHaveClass(/active/, { timeout: 30_000 })
  await expect(page.locator(`[data-testid="code-terminal-pane"][data-agent-id="${agentId}"]`)).toBeVisible({ timeout: 30_000 })
  return agentId
}

export async function openNewAgentDialog(page: Page) {
  await page.getByTestId('code-new-agent').click()
  await expect(page.getByTestId('input-dialog')).toBeVisible()
}

export async function getFirstAgentRow(page: Page) {
  const row = page.getByTestId('code-agent-row').first()
  await expect(row).toBeVisible({ timeout: 30_000 })
  return row
}

export async function getAgentRowIds(page: Page) {
  return page.getByTestId('code-agent-row').evaluateAll(rows => rows
    .map(row => row.getAttribute('data-agent-id'))
    .filter((id): id is string => Boolean(id)))
}

export async function getFirstAgentId(page: Page) {
  const row = page.getByTestId('code-agent-row').first()
  await expect(row).toHaveCount(1, { timeout: 30_000 })
  const agentId = await row.getAttribute('data-agent-id')
  if (!agentId) {
    throw new Error('Agent row is missing data-agent-id')
  }
  return agentId
}

export async function getAgentIdFromRow(page: Page) {
  const row = await getFirstAgentRow(page)
  const agentId = await row.getAttribute('data-agent-id')
  if (!agentId) {
    throw new Error('Agent row is missing data-agent-id')
  }
  return { row, agentId }
}

export async function writeTerminalFixture(page: Page, agentId: string, text: string) {
  await page.waitForFunction(
    (id) => Boolean(window.__farmingTerminalTest?.isReady(id) && window.__farmingTerminalTest?.getCellCenter(id, 0, 0)),
    agentId,
    { timeout: 15_000 }
  )
  await page.evaluate(
    async ({ id, fixture }) => {
      await window.__farmingTerminalTest?.writeFixture(id, fixture)
    },
    { id: agentId, fixture: text }
  )
}

export async function writeTerminalRaw(page: Page, agentId: string, text: string) {
  await page.waitForFunction(
    (id) => Boolean(window.__farmingTerminalTest?.isReady(id)),
    agentId,
    { timeout: 15_000 }
  )
  await page.evaluate(
    async ({ id, fixture }) => {
      await window.__farmingTerminalTest?.writeRaw(id, fixture)
    },
    { id: agentId, fixture: text }
  )
}

export async function writeTerminalRawAndSampleViewport(page: Page, agentId: string, text: string) {
  const sample = await page.evaluate(
    async ({ id, fixture }) => {
      return window.__farmingTerminalTest?.writeRawAndSampleViewport(id, fixture) ?? null
    },
    { id: agentId, fixture: text }
  )
  if (!sample) throw new Error(`Terminal viewport sample is missing for ${agentId}`)
  return sample
}

export async function terminalRows(page: Page, agentId: string, rowCount = 8) {
  return page.evaluate(({ id, rows }) => window.__farmingTerminalTest?.getRows(id, rows) ?? [], {
    id: agentId,
    rows: rowCount,
  })
}

export async function expectTerminalCanvasToHaveInk(page: Page, agentId: string) {
  await expect.poll(
    () => page.evaluate((id) => window.__farmingTerminalTest?.getCanvasInkPixelCount(id) ?? 0, agentId),
    { timeout: 15_000 }
  ).toBeGreaterThan(100)
}

export async function terminalViewport(page: Page, agentId: string) {
  const viewport = await page.evaluate((id) => window.__farmingTerminalTest?.getViewport(id) ?? null, agentId)
  if (!viewport) throw new Error(`Terminal viewport is missing for ${agentId}`)
  return viewport
}

export async function terminalHostDiagnostics(page: Page) {
  return page.evaluate(() => window.__farmingTerminalTest?.getHostDiagnostics() ?? [])
}

export async function scrollTerminalToLine(page: Page, agentId: string, line: number) {
  await page.evaluate(
    async ({ id, targetLine }) => {
      await window.__farmingTerminalTest?.scrollToLine(id, targetLine)
    },
    { id: agentId, targetLine: line }
  )
}
