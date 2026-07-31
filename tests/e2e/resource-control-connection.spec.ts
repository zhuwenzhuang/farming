import fs from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

async function openCodePage(page: Page) {
  const resourceEventRequests: string[] = []
  const websocketUrls: string[] = []
  const resourceSnapshotTypes = new Set<string>()
  const activeRequests = new Set<string>()
  page.on('request', request => {
    activeRequests.add(request.url())
    if (/\/api\/(?:browsers|computers)\/events(?:\?|$)/.test(request.url())) {
      resourceEventRequests.push(request.url())
    }
  })
  page.on('requestfinished', request => activeRequests.delete(request.url()))
  page.on('requestfailed', request => activeRequests.delete(request.url()))
  page.on('websocket', socket => {
    websocketUrls.push(socket.url())
    if (!/\/farming\/ws(?:\?|$)/.test(socket.url())) return
    socket.on('framereceived', frame => {
      if (typeof frame.payload !== 'string') return
      try {
        const message = JSON.parse(frame.payload) as { type?: string }
        if (message.type === 'browser-resource-snapshot' || message.type === 'computer-resource-snapshot') {
          resourceSnapshotTypes.add(message.type)
        }
      } catch {
        // Other main-socket frames are outside this connection-shape assertion.
      }
    })
  })
  await page.route('**/api/browsers/capability', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      enabled: true,
      available: true,
      browser: { kind: 'chrome', path: '/mock/chrome' },
      installation: {
        state: 'ready',
        agentBrowserVersion: 'test',
        installedVersion: 'test',
        updateAvailable: false,
        error: '',
      },
      message: 'Browser is available',
    }),
  }))
  await page.route('**/api/computers/capability', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      available: true,
      enabled: true,
      dockerAvailable: true,
      imageReady: true,
      image: 'test/computer:latest',
      imageDigest: 'sha256:test',
      driverVersion: 'test',
      compatibilityMode: false,
      error: '',
    }),
  }))
  await page.addInitScript(() => {
    window.__FARMING_E2E__ = true
  })
  await page.goto('/farming/', { waitUntil: 'domcontentloaded' })
  await expect(page.getByTestId('app-shell')).toBeVisible()
  await expect.poll(() => websocketUrls.filter(url => /\/farming\/ws(?:\?|$)/.test(url)).length)
    .toBe(1)
  await expect.poll(() => [...resourceSnapshotTypes].sort()).toEqual([
    'browser-resource-snapshot',
    'computer-resource-snapshot',
  ])
  return { activeRequests, resourceEventRequests, resourceSnapshotTypes, websocketUrls }
}

async function openTerminal(page: Page, agentId: string) {
  const row = page.locator(
    `[data-testid="code-agent-row"][data-agent-id="${agentId}"], `
    + `[data-testid="code-project-agent-compact"][data-agent-id="${agentId}"]`,
  ).first()
  await expect(row).toBeVisible({ timeout: 30_000 })
  await row.click()
  await expect(page.locator(`.terminal-session-host[data-agent-id="${agentId}"]`))
    .toBeVisible({ timeout: 15_000 })
  await page.waitForFunction(id => window.__farmingTerminalTest?.isReady(id) === true, agentId)
}

test('three Farming pages keep one control WebSocket and do not starve terminal checkpoints', async ({
  context,
  page,
  workspaceRoot,
}) => {
  const workspace = path.join(workspaceRoot, 'resource-control-connection')
  fs.mkdirSync(workspace, { recursive: true })
  const created = await page.request.post('/farming/api/control/agents', {
    data: { command: 'bash', workspace },
  })
  expect(created.ok()).toBeTruthy()
  const { agentId } = await created.json() as { agentId?: string }
  expect(agentId).toBeTruthy()

  const pages = [page, await context.newPage(), await context.newPage()]
  const observations = await Promise.all(pages.map(openCodePage))
  await Promise.all(pages.map(current => openTerminal(current, agentId!)))

  await Promise.all(observations.map(observation => expect.poll(
    () => [...observation.activeRequests].filter(url => /\/api\/(?:usage|agent-sessions)(?:\?|$)/.test(url)),
    { timeout: 2_000 },
  ).toEqual([])))
  const activeBeforeCheckpoints = observations.map(observation => [...observation.activeRequests])

  const checkpointResults = await Promise.all(pages.map(current => current.evaluate(async id => {
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), 5_000)
    const startedAt = performance.now()
    try {
      const response = await fetch(`/farming/api/agents/${encodeURIComponent(id)}/session-view`, {
        cache: 'no-store',
        signal: controller.signal,
      })
      return {
        elapsedMs: performance.now() - startedAt,
        ok: response.ok,
      }
    } catch (caught) {
      return {
        elapsedMs: performance.now() - startedAt,
        error: caught instanceof Error ? caught.message : String(caught),
        ok: false,
      }
    } finally {
      window.clearTimeout(timeout)
    }
  }, agentId!)))

  for (const observation of observations) {
    expect(observation.resourceEventRequests).toEqual([])
    expect([...observation.resourceSnapshotTypes].sort()).toEqual([
      'browser-resource-snapshot',
      'computer-resource-snapshot',
    ])
    expect(observation.websocketUrls.filter(url => /\/farming\/ws(?:\?|$)/.test(url))).toHaveLength(1)
  }
  for (const checkpoint of checkpointResults) {
    expect(checkpoint, JSON.stringify({ activeBeforeCheckpoints, checkpointResults }, null, 2)).toMatchObject({ ok: true })
    expect(checkpoint.elapsedMs).toBeLessThan(2_000)
  }

  await Promise.all(pages.slice(1).map(current => current.close()))
})
