import fs from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { expect, openFarming, test } from './fixtures'

async function createAcpAgent(page: Page, workspace: string) {
  const response = await page.request.post('/farming/api/control/agents', {
    data: { command: 'codex', workspace, agentRuntimeMode: 'acp' },
  })
  expect(response.ok()).toBeTruthy()
  const payload = await response.json() as { agentId?: string }
  expect(payload.agentId).toBeTruthy()
  return payload.agentId as string
}

async function setPageVisibility(page: Page, state: 'hidden' | 'visible') {
  await page.evaluate(nextState => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => nextState,
    })
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => nextState === 'hidden',
    })
    document.dispatchEvent(new Event('visibilitychange'))
  }, state)
}

test('keeps ACP Chat live while the browser page is hidden', async ({ page, workspaceRoot }) => {
  const workspace = path.join(workspaceRoot, 'background-chat-continuity')
  fs.mkdirSync(workspace, { recursive: true })
  const agentId = await createAcpAgent(page, workspace)
  let backendSocketClosed = 0

  page.on('websocket', socket => {
    if (!new URL(socket.url()).pathname.endsWith('/ws')) return
    socket.on('close', () => { backendSocketClosed += 1 })
  })

  await openFarming(page)
  const row = page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
  await expect(row).toBeVisible()
  await row.click()
  await expect(page.getByTestId('code-agent-chat-view')).toBeVisible()
  await expect(page.getByTestId('connection-status')).toHaveCount(0)

  const composerInput = page.getByTestId('code-acp-composer-input')
  await composerInput.fill('draft survives composer collapse')
  await page.locator('.code-composer-collapse-zone').hover()
  await page.getByTestId('code-composer-collapse').click()
  await expect(page.getByTestId('code-acp-composer')).toHaveCount(0)
  await expect(page.getByTestId('code-agent-chat-view')).toBeVisible()
  await page.getByTestId('code-composer-restore').click()
  await expect(composerInput).toHaveValue('draft survives composer collapse')
  await composerInput.fill('')

  await composerInput.fill('streaming thought')
  await page.getByTestId('code-acp-composer-send').click()
  await expect(page.getByText('Comparing the likely causes', { exact: false })).toBeVisible()

  await setPageVisibility(page, 'hidden')
  expect(await page.evaluate(() => document.visibilityState)).toBe('hidden')

  await page.waitForTimeout(1_800)
  expect(await page.evaluate(() => document.visibilityState)).toBe('hidden')
  expect(await page.getByText('Streaming thought complete.', { exact: true }).count()).toBe(1)
  expect(backendSocketClosed).toBe(0)

  await setPageVisibility(page, 'visible')
  expect(await page.evaluate(() => document.visibilityState)).toBe('visible')
  await expect(page.getByText('Streaming thought complete.', { exact: true })).toBeVisible()
  await expect(page.getByTestId('connection-status')).toHaveCount(0)
  expect(backendSocketClosed).toBe(0)
})

test('keeps a short ACP answer close to the Composer with compact copy affordance', async ({ page, workspaceRoot }) => {
  const workspace = path.join(workspaceRoot, 'compact-chat-tail')
  fs.mkdirSync(workspace, { recursive: true })
  const agentId = await createAcpAgent(page, workspace)

  await openFarming(page)
  const row = page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
  await expect(row).toBeVisible()
  await row.click()

  await page.getByTestId('code-acp-composer-input').fill('image attachment')
  await page.getByTestId('code-acp-composer-send').click()
  await expect(page.getByText('Received 0 image.', { exact: true })).toBeVisible()

  const geometry = await page.getByTestId('code-codex-transcript-copy-answer').evaluate(element => {
    const action = element.getBoundingClientRect()
    const icon = element.querySelector('svg')?.getBoundingClientRect()
    const composer = document.querySelector<HTMLElement>('.code-composer')?.getBoundingClientRect()
    if (!icon || !composer) throw new Error('Chat action or Composer geometry is unavailable')
    return {
      actionWidth: action.width,
      actionHeight: action.height,
      iconWidth: icon.width,
      iconHeight: icon.height,
      composerGap: composer.top - action.bottom,
    }
  })

  expect(geometry.composerGap).toBeGreaterThanOrEqual(32)
  expect(geometry.composerGap).toBeLessThanOrEqual(48)
  expect(geometry).toMatchObject({
    actionWidth: 20,
    actionHeight: 20,
    iconWidth: 14,
    iconHeight: 14,
  })
})

test('keeps a human reader stationary while an ACP answer streams below', async ({ page, workspaceRoot }) => {
  const workspace = path.join(workspaceRoot, 'streaming-reader-scroll-stability')
  fs.mkdirSync(workspace, { recursive: true })
  const agentId = await createAcpAgent(page, workspace)

  await openFarming(page)
  const row = page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
  await expect(row).toBeVisible()
  await row.click()

  const transcript = page.getByTestId('code-codex-transcript-scroll')
  await page.getByTestId('code-acp-composer-input').fill('scroll stability')
  await page.getByTestId('code-acp-composer-send').click()
  await expect(page.getByText('Reading paragraph 48', { exact: false })).toBeVisible()
  await expect.poll(async () => transcript.evaluate(element => (
    element.scrollHeight - element.clientHeight
  ))).toBeGreaterThan(1)

  const readingPosition = await transcript.evaluate(element => {
    const bottom = Math.max(0, element.scrollHeight - element.clientHeight)
    element.scrollTop = Math.max(0, bottom - 900)
    element.dispatchEvent(new Event('scroll', { bubbles: true }))
    return element.scrollTop
  })
  expect(await transcript.evaluate(element => (
    element.scrollHeight - element.clientHeight - element.scrollTop
  ))).toBeGreaterThan(1)
  await expect(page.getByTestId('code-codex-transcript-jump-bottom')).toBeVisible()

  for (let index = 1; index <= 6; index += 1) {
    await expect(page.getByText(`Streaming tail ${index}`, { exact: false })).toBeAttached({ timeout: 10_000 })
    const positionDelta = Math.abs(
      (await transcript.evaluate(element => element.scrollTop)) - readingPosition,
    )
    expect(positionDelta).toBeLessThanOrEqual(1)
  }

  await page.getByTestId('code-codex-transcript-jump-bottom').click()
  await expect.poll(async () => transcript.evaluate(element => (
    element.scrollHeight - element.clientHeight - element.scrollTop
  ))).toBeLessThanOrEqual(1)
})
