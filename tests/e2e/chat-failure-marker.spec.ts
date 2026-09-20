import fs from 'node:fs'
import path from 'node:path'
import type { Locator, Page, TestInfo } from '@playwright/test'
import { expect, openFarming, test } from './fixtures'

async function createChat(page: Page, workspace: string, command = 'claude') {
  const response = await page.request.post('/farming/api/control/agents', {
    data: { command, workspace, agentRuntimeMode: 'chat' },
  })
  expect(response.ok()).toBeTruthy()
  const { agentId } = await response.json() as { agentId: string }
  return agentId
}
function row(page: Page, id: string) {
  return page.locator(`[data-testid="code-agent-row"][data-agent-id="${id}"]`)
}
async function send(page: Page, text: string) {
  const input = page.getByTestId('code-acp-composer-input')
  await input.fill(text)
  await page.getByTestId('code-acp-composer-send').click()
  await expect(input).toHaveValue('')
}

async function expectSeparate(first: Locator, second: Locator) {
  const a = await first.boundingBox()
  const b = await second.boundingBox()
  if (!a || !b) throw new Error('Status and adjacent controls must be visible')
  expect(a.x + a.width <= b.x || b.x + b.width <= a.x
    || a.y + a.height <= b.y || b.y + b.height <= a.y).toBe(true)
}

async function captureSidebar(page: Page, testInfo: TestInfo, name: string) {
  const body = await page.getByTestId('code-sidebar').screenshot({
    animations: 'disabled', path: testInfo.outputPath(name),
  })
  await testInfo.attach(name, { body, contentType: 'image/png' })
}

test('Chat failure marker survives reads and renders across appearances and layouts', {
  tag: ['@critical-behavior', '@behavior-CODE-CHAT-FAILURE-MARKER'],
}, async ({ page, workspaceRoot }, testInfo) => {
  test.setTimeout(120_000)
  const workspace = path.join(workspaceRoot, 'chat-failure-demo')
  fs.mkdirSync(workspace, { recursive: true })
  const id = await createChat(page, workspace)
  const peer = await createChat(page, workspace, 'qwen')
  expect((await page.request.patch(`/farming/api/agents/${id}`, {
    data: { customTitle: 'Investigate the interrupted Auto Cluster recommendation' },
  })).ok()).toBeTruthy()
  expect((await page.request.patch(`/farming/api/agents/${id}`, { data: { followUp: true } })).ok()).toBeTruthy()
  await openFarming(page)
  await row(page, id).click()
  await send(page, 'partial provider error')
  const marker = row(page, id).getByTestId('code-agent-chat-failure')
  await expect(marker).toBeVisible()
  await expect(marker).toHaveAttribute('aria-label', /stream disconnected before completion/)

  for (const appearance of ['light', 'dark', 'paper']) {
    expect((await page.request.post('/farming/api/settings', { data: { appearance } })).ok()).toBeTruthy()
    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.locator('body')).toHaveAttribute('data-appearance', appearance)
    await row(page, peer).click()
    await row(page, id).click()
    await expect(marker).toBeVisible()
    await row(page, id).hover()
    const geometry = await marker.evaluate(element => {
      const rect = element.getBoundingClientRect()
      return {
        width: rect.width, height: rect.height,
        unobscured: element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)),
      }
    })
    expect(geometry).toEqual({ width: 16, height: 16, unobscured: true })
    await captureSidebar(page, testInfo, `chat-failure-${appearance}.png`)
    await page.getByTestId('code-sidebar-toggle').click()
    const railMarker = page.locator(`[data-testid="code-agent-rail-item"][data-agent-id="${id}"]`).getByTestId('code-agent-chat-failure')
    await expect(railMarker).toBeVisible()
    await expectSeparate(railMarker, page.locator(`[data-testid="code-agent-rail-item"][data-agent-id="${id}"] .code-agent-rail-label`))
    await captureSidebar(page, testInfo, `chat-failure-rail-${appearance}.png`)
    await page.getByTestId('code-sidebar-toggle').click()
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(page.locator('body')).toHaveClass(/code-compact-layout/)
    await page.getByTestId('code-mobile-menu').click()
    await expect(marker).toBeVisible()
    await expectSeparate(marker, row(page, id).getByTestId('code-agent-row-more'))
    await captureSidebar(page, testInfo, `chat-failure-mobile-${appearance}.png`)
    await page.setViewportSize({ width: 1440, height: 900 })
    await expect(page.locator('body')).not.toHaveClass(/code-compact-layout/)
    if ((await page.getByTestId('code-sidebar').getAttribute('class'))?.includes('collapsed')) {
      await page.getByTestId('code-sidebar-toggle').click()
    }
  }
  await row(page, id).click()
  await send(page, 'failed tool')
  await expect(marker).toHaveCount(0)
  await expect(page.getByText('The check failed; no files were changed.', { exact: true })).toBeVisible()
  await send(page, 'cancel then provider error')
  await expect(page.getByTestId('code-acp-composer-send')).toHaveAttribute('data-action', 'interrupt')
  await page.getByTestId('code-acp-composer-send').click()
  await expect(page.getByTestId('code-acp-composer-send')).not.toHaveAttribute('data-action', 'interrupt')
  await expect(marker).toHaveCount(0)
})
