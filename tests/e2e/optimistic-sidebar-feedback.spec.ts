import fs from 'node:fs'
import path from 'node:path'
import type { Page, Route, Locator, TestInfo } from '@playwright/test'
import { expect, openFarming, test } from './fixtures'

async function frames(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

async function captureAppearances(page: Page, locator: Locator, info: TestInfo, name: string) {
  for (const appearance of ['light', 'dark', 'paper']) {
    await page.evaluate(value => {
      document.documentElement.dataset.appearance = value
      document.body.dataset.appearance = value
    }, appearance)
    await locator.screenshot({ path: info.outputPath(`${name}-${appearance}.png`), animations: 'disabled' })
  }
}

async function holdWrite(page: Page, pattern: RegExp, matches: (body: Record<string, unknown>) => boolean) {
  let held: Route | undefined
  let accept!: () => void
  const admitted = new Promise<void>(resolve => { accept = resolve })
  await page.route(pattern, route => {
    const request = route.request()
    if (['POST', 'PATCH'].includes(request.method()) && matches(request.postDataJSON() ?? {})) {
      held = route
      accept()
      return
    }
    return route.continue()
  })
  return {
    admitted,
    save: async () => {
      if (!held) return
      const route = held
      held = undefined
      await route.continue()
    },
    reject: async (status = 409) => {
      if (!held) return
      const route = held
      held = undefined
      await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ error: 'Test: confirmed rejection' }) })
      await frames(page)
    },
  }
}

async function createAgent(page: Page, workspaceRoot: string) {
  const workspace = path.join(workspaceRoot, 'feedback-audit')
  fs.mkdirSync(workspace, { recursive: true })
  const response = await page.request.post('/farming/api/control/agents', { data: { command: 'bash', workspace } })
  expect(response.ok()).toBeTruthy()
  const { agentId } = await response.json() as { agentId: string }
  const updated = await page.request.patch(`/farming/api/agents/${agentId}`, { data: { customTitle: 'Audit original' } })
  expect(updated.ok()).toBeTruthy()
  const read = await page.request.patch(`/farming/api/agents/${agentId}`, { data: { unread: false } })
  expect(read.ok()).toBeTruthy()
  await openFarming(page)
  const row = page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
  await expect(row.locator('.code-agent-name')).toHaveText('Audit original')
  return { agentId, row }
}

for (const flag of ['pinned', 'followUp', 'unread'] as const) {
  test(`optimistic: ${flag} changes before saving and restores after rejection`, async ({ page, workspaceRoot }, testInfo) => {
    const { agentId, row } = await createAgent(page, workspaceRoot)
    const className = flag === 'followUp' ? 'follow-up' : flag
    await expect(row).not.toHaveClass(new RegExp(`\\b${className}\\b`))
    const write = await holdWrite(page, new RegExp(`/api/agents/${agentId}$`), body => body[flag] === true)
    try {
      if (flag === 'unread') {
        await row.click({ button: 'right' })
        await page.getByRole('menuitem', { name: 'Mark as unread', exact: true }).click()
      } else {
        await row.hover()
        await row.getByTestId(flag === 'pinned' ? 'code-agent-row-pin' : 'code-agent-row-follow-up').click()
      }
      await write.admitted
      await frames(page)
      await expect(row).toHaveClass(new RegExp(`\\b${className}\\b`))
      await captureAppearances(page, row, testInfo, `${flag}-pending`)
    } finally { await write.reject() }
    await expect(row).not.toHaveClass(new RegExp(`\\b${className}\\b`))
    await expect(page.getByTestId('app-toast')).toHaveClass(/recovering/)
    await captureAppearances(page, page.getByTestId('app-toast'), testInfo, `${flag}-restored`)
  })
}

test('optimistic: rename updates the row before saving and restores after rejection', async ({ page, workspaceRoot }, testInfo) => {
  const { agentId, row } = await createAgent(page, workspaceRoot)
  const write = await holdWrite(page, new RegExp(`/api/agents/${agentId}$`), body => body.customTitle === 'Audit renamed')
  try {
    await row.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Rename Agent', exact: true }).click()
    await page.getByTestId('code-rename-input').fill('Audit renamed')
    await page.getByTestId('code-rename-dialog').getByRole('button', { name: 'Save', exact: true }).click()
    await write.admitted
    await frames(page)
    await expect(page.getByTestId('code-rename-dialog')).toBeHidden()
    await expect(row.locator('.code-agent-name')).toHaveText('Audit renamed')
    await captureAppearances(page, row, testInfo, 'rename-pending')
  } finally { await write.reject() }
  await expect(row.locator('.code-agent-name')).toHaveText('Audit original')
})

test('optimistic: Project pin changes its menu state before saving', async ({ page, workspaceRoot }, testInfo) => {
  const { row } = await createAgent(page, workspaceRoot)
  const project = page.getByTestId('code-project-group').filter({ has: row })
  const title = project.getByTestId('code-project-title')
  const write = await holdWrite(page, /\/api\/projects\/pin$/, body => body.pinned === true)
  try {
    await title.click({ button: 'right' })
    await page.getByTestId('code-project-context-menu').getByRole('menuitem', { name: 'Pin project', exact: true }).click()
    await write.admitted
    await frames(page)
    await title.click({ button: 'right' })
    const menu = page.getByTestId('code-project-context-menu')
    await expect(menu.getByRole('menuitem', { name: 'Unpin project', exact: true })).toBeVisible()
    await captureAppearances(page, menu, testInfo, 'project-pin-pending')
    await page.keyboard.press('Escape')
  } finally { await write.reject() }
  await title.click({ button: 'right' })
  await expect(page.getByTestId('code-project-context-menu').getByRole('menuitem', { name: 'Pin project', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('code-copy-toast')).not.toHaveClass(/error/)
})

test('optimistic: dropping an Agent moves it before saving and restores after rejection', async ({ page, workspaceRoot }, testInfo) => {
  const first = await createAgent(page, workspaceRoot)
  const second = await createAgent(page, workspaceRoot)
  const third = await createAgent(page, workspaceRoot)
  const project = page.getByTestId('code-project-group').filter({ has: first.row })
  const order = () => project.getByTestId('code-agent-row').evaluateAll(rows => rows.map(row => row.getAttribute('data-agent-id')))
  await expect.poll(order).toEqual([third.agentId, second.agentId, first.agentId])
  const write = await holdWrite(page, new RegExp(`/api/agents/${first.agentId}/reorder$`), () => true)
  try {
    await first.row.dragTo(third.row, { targetPosition: { x: 80, y: 2 } })
    await write.admitted
    await frames(page)
    await expect.poll(order).toEqual([first.agentId, third.agentId, second.agentId])
    await captureAppearances(page, project, testInfo, 'agent-drop-pending')
  } finally { await write.reject() }
  await expect.poll(order).toEqual([third.agentId, second.agentId, first.agentId])
  await expect(page.getByTestId('app-toast')).toHaveClass(/recovering/)
})

test('optimistic: an older pin rejection preserves a later unpin and the new focus', async ({ page, workspaceRoot }) => {
  const first = await createAgent(page, workspaceRoot)
  const second = await createAgent(page, workspaceRoot)
  const write = await holdWrite(page, new RegExp(`/api/agents/${first.agentId}$`), body => body.pinned === true)
  try {
    await first.row.hover()
    await first.row.getByTestId('code-agent-row-pin').click()
    await write.admitted
    await expect(first.row).toHaveClass(/\bpinned\b/)
    await first.row.hover()
    await first.row.getByTestId('code-agent-row-pin').click()
    await expect(first.row).not.toHaveClass(/\bpinned\b/)
    await first.row.press('ArrowUp')
    await expect(second.row).toBeFocused()
    const settled = page.waitForResponse(response => response.url().endsWith(`/api/agents/${first.agentId}`)
      && response.request().postDataJSON()?.pinned === false)
    await write.reject()
    expect((await settled).ok()).toBeTruthy()
    await frames(page)
    await expect(first.row).not.toHaveClass(/\bpinned\b/)
    await expect(second.row).toBeFocused()
    await expect(page.getByTestId('app-toast')).toBeHidden()
  } finally { await write.reject() }
})

test('optimistic: Pinned drops use the displayed order before saving and after reload', async ({ page, workspaceRoot }, testInfo) => {
  const first = await createAgent(page, workspaceRoot)
  const second = await createAgent(page, workspaceRoot)
  const third = await createAgent(page, workspaceRoot)
  for (const agent of [first, second, third]) {
    const response = await page.request.patch(`/farming/api/agents/${agent.agentId}`, { data: { pinned: true } })
    expect(response.ok()).toBeTruthy()
  }
  const pinned = page.getByTestId('code-pinned-section')
  const order = () => pinned.getByTestId('code-agent-row').evaluateAll(rows => rows.map(row => row.getAttribute('data-agent-id')))
  await expect.poll(order).toEqual([first.agentId, second.agentId, third.agentId])
  const write = await holdWrite(page, new RegExp(`/api/agents/${third.agentId}/reorder$`), () => true)
  try {
    await third.row.dragTo(first.row, { targetPosition: { x: 80, y: 2 } })
    await write.admitted
    await expect.poll(order).toEqual([third.agentId, first.agentId, second.agentId])
    await captureAppearances(page, pinned, testInfo, 'pinned-drop-pending')
    const settled = page.waitForResponse(response => response.url().endsWith(`/api/agents/${third.agentId}/reorder`))
    await write.save()
    expect((await settled).ok()).toBeTruthy()
    await expect.poll(order).toEqual([third.agentId, first.agentId, second.agentId])
    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect.poll(order).toEqual([third.agentId, first.agentId, second.agentId])
    await expect(page.getByTestId('app-toast')).toBeHidden()
  } finally { await write.reject() }
})

test('optimistic: a saved pin with a lost response settles silently without repeating the write', async ({ page, workspaceRoot }) => {
  const { agentId, row } = await createAgent(page, workspaceRoot)
  let writes = 0
  let accept!: () => void
  const reconciled = new Promise<void>(resolve => { accept = resolve })
  await page.route(new RegExp(`/api/agents/${agentId}$`), async route => {
    if (route.request().method() !== 'PATCH' || route.request().postDataJSON()?.pinned !== true) return route.continue()
    writes += 1
    expect((await route.fetch()).ok()).toBeTruthy()
    await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Test: response lost after commit"}' })
  })
  await page.route(/\/api\/control\/agents$/, async route => {
    const response = await route.fetch()
    await route.fulfill({ response })
    accept()
  })
  await row.hover()
  await row.getByTestId('code-agent-row-pin').click()
  await reconciled
  await frames(page)
  await expect(row).toHaveClass(/\bpinned\b/)
  await expect(page.getByTestId('app-toast')).toBeHidden()
  expect(writes).toBe(1)
})

test('optimistic: default Agent runtime changes before saving and restores after rejection', async ({ page }, testInfo) => {
  await openFarming(page)
  await page.getByTestId('code-nav-plugins').click()
  const panel = page.getByTestId('code-plugins-panel')
  await panel.getByTestId('code-plugin-tab-homes').click()
  const runtime = panel.getByTestId('code-plugin-agent-runtime-default-codex')
  await expect(runtime).toBeEnabled()
  const previous = await runtime.inputValue()
  const target = previous === 'terminal' ? 'chat' : 'terminal'
  const write = await holdWrite(page, /\/api\/settings$/, body => Boolean(body.agentHomes && body.agentLaunchProfiles))
  try {
    await runtime.selectOption(target)
    await write.admitted
    await expect(runtime).toHaveValue(target)
    await expect(runtime).toBeDisabled()
    await captureAppearances(page, panel.getByTestId('code-plugin-section-agent-codex-default'), testInfo, 'default-runtime-pending')
  } finally { await write.reject() }
  await expect(runtime).toHaveValue(previous)
  await expect(runtime).toBeEnabled()
  await expect(panel.getByRole('status')).toHaveText('Not saved. Previous setting restored.')
  await expect(panel.getByRole('alert')).toHaveCount(0)
})

test('optimistic: share duration keeps the selected value while saving', async ({ page }, testInfo) => {
  await openFarming(page)
  await page.getByTestId('code-sidebar-options').click()
  const slider = page.getByTestId('code-settings-read-only-share-duration')
  await expect(slider).toBeEnabled()
  const previous = await slider.inputValue()
  const target = previous === '168' ? '1' : '168'
  const write = await holdWrite(page, /\/api\/settings$/, body => body.readOnlyShareHours === Number(target))
  try {
    await slider.focus()
    await slider.press(target === '168' ? 'End' : 'Home')
    await write.admitted
    await frames(page)
    await expect(slider).toBeDisabled()
    await expect(slider).toHaveValue(target)
    await captureAppearances(page, slider.locator('xpath=ancestor::section'), testInfo, 'share-duration-pending')
  } finally { await write.reject() }
  await expect(slider).toHaveValue(previous)
  await expect(slider).toBeEnabled()
})

test('optimistic: search timeout restores a rejected value without waiting for another read', async ({ page }, testInfo) => {
  await openFarming(page)
  await page.getByTestId('code-sidebar-options').click()
  // This control reflects the panel's initial settings read; the search slider
  // itself stays enabled while that read is pending.
  await expect(page.getByTestId('code-settings-read-only-share-duration')).toBeEnabled()
  const slider = page.getByRole('slider', { name: 'Search timeout', exact: true })
  await expect(slider).toBeEnabled()
  const previous = await slider.inputValue()
  const target = previous === '6' ? '0' : '6'
  let reads = 0
  page.on('request', request => { if (request.method() === 'GET' && request.url().endsWith('/api/settings')) reads += 1 })
  const write = await holdWrite(page, /\/api\/settings$/, body => body.searchTimeoutMs === (target === '6' ? 180000 : 3000))
  try {
    await slider.press(target === '6' ? 'End' : 'Home')
    await write.admitted
    await expect(slider).toHaveValue(target)
    await captureAppearances(page, slider.locator('xpath=ancestor::section'), testInfo, 'search-timeout-pending')
  } finally { await write.reject() }
  await expect(slider).toHaveValue(previous)
  expect(reads).toBe(0)
})

test('optimistic: a definite preference rejection restores without waiting for settings reads', async ({ page }) => {
  await openFarming(page)
  await page.getByTestId('code-sidebar-options').click()
  await expect(page.getByTestId('code-settings-read-only-share-duration')).toBeEnabled()
  const pendingReads: Route[] = []
  const settingsPattern = /\/api\/settings$/
  const holdReads = (route: Route) => {
    if (route.request().method() === 'GET') { pendingReads.push(route); return }
    return route.fallback()
  }
  const write = await holdWrite(page, /\/api\/settings$/, body => body.appearance === 'dark')
  try {
    await page.locator('button[data-theme-choice="dark"]').click()
    await write.admitted
    await expect(page.locator('body')).toHaveAttribute('data-appearance', 'dark')
    // Appearance changes also refresh unrelated Settings consumers. Hold their
    // reads too: restoration itself must complete without any of those replies.
    await page.route(settingsPattern, holdReads)
    await write.reject()
    await expect(page.locator('body')).toHaveAttribute('data-appearance', 'light')
    await expect(page.getByTestId('app-toast')).toHaveClass(/recovering/)
  } finally {
    await page.unroute(settingsPattern, holdReads)
    await Promise.all(pendingReads.map(route => route.continue()))
    await write.reject()
  }
})

test('optimistic: appearance reconciles a JSON HTTP rejection and restores the stored value', async ({ page }) => {
  await openFarming(page)
  await page.getByTestId('code-sidebar-options').click()
  await expect(page.getByTestId('code-settings-read-only-share-duration')).toBeEnabled()
  const write = await holdWrite(page, /\/api\/settings$/, body => body.appearance === 'dark')
  try {
    await page.locator('button[data-theme-choice="dark"]').click()
    await write.admitted
    await expect(page.locator('body')).toHaveAttribute('data-appearance', 'dark')
    const settled = page.waitForResponse(response => response.url().endsWith('/api/settings') && response.request().postDataJSON()?.appearance === 'dark')
    await write.reject(503)
    expect((await settled).status()).toBe(503)
    await frames(page)
    await expect(page.locator('body')).toHaveAttribute('data-appearance', 'light')
    const persisted = await page.request.get('/farming/api/settings')
    expect((await persisted.json()).settings.appearance).toBe('light')
  } finally { await write.reject() }
})
