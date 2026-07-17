import fs from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

async function createBashAgent(page: Page, workspace: string) {
  const response = await page.request.post('/farming/api/control/agents', {
    data: { command: 'bash', workspace },
  })
  expect(response.ok()).toBeTruthy()
  const data = await response.json() as { agentId?: string }
  expect(data.agentId).toBeTruthy()
  return data.agentId as string
}

function codeAgentRow(page: Page, agentId: string) {
  return page.locator(
    `[data-testid="code-agent-row"][data-agent-id="${agentId}"], ` +
    `[data-testid="code-project-agent-compact"][data-agent-id="${agentId}"], ` +
    `[data-testid="code-pinned-agent-compact"][data-agent-id="${agentId}"]`,
  ).first()
}

function codeTerminalHost(page: Page, agentId: string) {
  return page.locator(`.terminal-session-host[data-agent-id="${agentId}"]`)
}

async function openCodeOwner(page: Page, agentId: string) {
  await page.goto('/farming/', { waitUntil: 'domcontentloaded' })
  await expect(page.getByTestId('app-shell')).toBeVisible()
  await expect(codeAgentRow(page, agentId)).toBeVisible({ timeout: 30_000 })
  await codeAgentRow(page, agentId).click()
  await expect(codeTerminalHost(page, agentId))
    .toHaveAttribute('data-controller-status', 'owner', { timeout: 15_000 })
  await page.waitForFunction(id => Boolean(window.__farmingTerminalTest?.isReady(id)), agentId)
}

async function sessionView(page: Page, agentId: string) {
  const response = await page.request.get(`/farming/api/agents/${agentId}/session-view`)
  expect(response.ok()).toBeTruthy()
  const body = await response.json() as {
    session?: {
      outputSeq?: number
      renderOutput?: string
    }
  }
  return body.session || {}
}

async function expectFileText(file: string, expected: string) {
  await expect.poll(() => (
    fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  ), { timeout: 10_000 }).toBe(expected)
}

test('a healthy CRT takeover releases renderer backpressure left by a stalled Code owner', async ({
  page,
  context,
  workspaceRoot,
}) => {
  const workspace = path.join(workspaceRoot, 'terminal-output-flow-takeover')
  fs.mkdirSync(workspace, { recursive: true })
  const resultFile = path.join(workspace, 'takeover-live.txt')
  const marker = `FLOW_RESUMED_${Date.now()}`
  const agentId = await createBashAgent(page, workspace)

  await openCodeOwner(page, agentId)
  expect(await page.evaluate(id => (
    window.__farmingTerminalTest?.setOutputAckSuppressed(id, true) || false
  ), agentId)).toBe(true)
  const initial = await sessionView(page, agentId)

  const crtPage = await context.newPage()
  await crtPage.addInitScript(() => {
    window.__FARMING_E2E__ = true
  })
  try {
    await crtPage.goto(`/farming/crt/?agent=${encodeURIComponent(agentId)}`, {
      waitUntil: 'domcontentloaded',
    })
    await expect(crtPage.locator('#session-modal')).toHaveClass(/active/, { timeout: 30_000 })
    const takeover = crtPage.locator('.crt-terminal-takeover')
    await expect(takeover).toBeVisible({ timeout: 15_000 })

    const script = [
      'let i=0',
      'const timer=setInterval(()=>{',
      "if(i++<100){process.stdout.write('x'.repeat(5000));return}",
      'clearInterval(timer)',
      `process.stdout.write(${JSON.stringify(`\n${marker}\n`)})`,
      '},10)',
    ].join(';')
    const response = await page.request.post(`/farming/api/control/agents/${agentId}/input`, {
      data: { input: `node -e ${JSON.stringify(script)}\n` },
    })
    expect(response.ok()).toBeTruthy()

    await expect.poll(async () => (
      (await sessionView(page, agentId)).outputSeq || 0
    ), { timeout: 10_000 }).toBeGreaterThan((initial.outputSeq || 0) + 10)
    await page.waitForTimeout(500)
    expect((await sessionView(page, agentId)).renderOutput || '').not.toContain(marker)

    await takeover.click()
    await expect(takeover).toBeHidden({ timeout: 15_000 })
    await expect(codeTerminalHost(page, agentId))
      .toHaveAttribute('data-controller-status', 'observer', { timeout: 15_000 })
    await expect.poll(async () => (
      (await sessionView(page, agentId)).renderOutput || ''
    ), { timeout: 15_000 }).toContain(marker)

    const input = crtPage.locator('#terminal-output .xterm-helper-textarea')
    await input.focus()
    await input.pressSequentially(
      `printf 'takeover-live\\n' > ${JSON.stringify(resultFile)}`,
    )
    await input.press('Enter')
    await expectFileText(resultFile, 'takeover-live\n')
  } finally {
    await crtPage.close()
  }
})
