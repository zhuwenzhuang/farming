import fs from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { expect, openFarming, test } from './fixtures'
import { AGENT_COMPLETION_NOTIFICATIONS_STORAGE_KEY } from '../../src/lib/agent-completion-notifications'

async function installNotificationFixture(
  page: Page,
  options: { permission: NotificationPermission; enabled?: boolean; requestResult?: NotificationPermission | 'error' | 'pending' },
) {
  await page.addInitScript(({ storageKey, initialPermission, enabled, requestResult }) => {
    const permissionStorageKey = '__farmingNotificationPermissionFixture'
    let permission = (localStorage.getItem(permissionStorageKey) as NotificationPermission | null)
      ?? initialPermission
    const notifications: Array<{
      title: string
      body: string
      tag: string
      closed: boolean
      onclick: (() => void) | null
      close: () => void
    }> = []
    class FakeNotification {
      static get permission() {
        return permission
      }

      static async requestPermission() {
        const state = window as Window & { __farmingNotificationPermissionRequests?: number }
        state.__farmingNotificationPermissionRequests = (state.__farmingNotificationPermissionRequests ?? 0) + 1
        if (requestResult === 'error') throw new Error('Permission request failed')
        if (requestResult === 'pending') {
          await new Promise<void>(resolve => {
            Object.assign(window, { __farmingResolveNotificationPermission: resolve })
          })
        }
        permission = requestResult === 'pending' ? 'granted' : requestResult
        localStorage.setItem(permissionStorageKey, permission)
        return permission
      }

      title: string
      body: string
      tag: string
      closed = false
      onclick: (() => void) | null = null

      constructor(title: string, options: NotificationOptions = {}) {
        this.title = title
        this.body = options.body ?? ''
        this.tag = options.tag ?? ''
        notifications.push(this)
      }

      close() {
        this.closed = true
      }
    }
    Object.defineProperty(window, 'Notification', {
      configurable: true,
      value: FakeNotification,
    })
    const state = window as Window & {
      __farmingNotifications?: typeof notifications
      __farmingNotificationPermissionRequests?: number
    }
    state.__farmingNotifications = notifications
    state.__farmingNotificationPermissionRequests = 0
    Object.assign(window, {
      __farmingSetNotificationPermission: (value: NotificationPermission) => { permission = value },
    })
    if (enabled) localStorage.setItem(storageKey, 'true')
  }, {
    storageKey: AGENT_COMPLETION_NOTIFICATIONS_STORAGE_KEY,
    initialPermission: options.permission,
    enabled: options.enabled === true,
    requestResult: options.requestResult ?? 'granted',
  })
}

async function createAcpAgent(page: Page, workspace: string, command = 'claude') {
  const response = await page.request.post('/farming/api/control/agents', {
    data: { command, workspace, agentRuntimeMode: 'chat' },
  })
  expect(response.ok()).toBeTruthy()
  const data = await response.json() as { agentId?: string }
  expect(data.agentId).toBeTruthy()
  return data.agentId as string
}

async function createTerminalAgent(page: Page, workspace: string, command = 'bash') {
  const response = await page.request.post('/farming/api/control/agents', {
    data: { command, workspace },
  })
  expect(response.ok()).toBeTruthy()
  const data = await response.json() as { agentId?: string }
  expect(data.agentId).toBeTruthy()
  return data.agentId as string
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

test('requests notification permission only from the explicit Settings toggle', async ({ page }) => {
  await installNotificationFixture(page, { permission: 'default' })
  await openFarming(page)

  await page.getByTestId('code-sidebar-options').click()
  const row = page.getByTestId('code-settings-agent-completion-notifications')
  const agentSection = row.locator('xpath=ancestor::section')
  await expect(agentSection.getByRole('heading', { name: 'Agent' })).toBeVisible()
  await expect(agentSection.getByTestId('code-settings-follow-up-behavior')).toBeVisible()
  const permissionToggle = agentSection.getByRole('checkbox', { name: 'Skip all agent permission checks by default' })
  await expect(permissionToggle).toBeVisible()
  await page.locator('body').evaluate(body => { body.dataset.appearance = 'paper' })
  await expect(permissionToggle).not.toHaveClass(/active/)
  await expect(permissionToggle).toHaveCSS('border-top-style', 'solid')
  await expect(permissionToggle).toHaveCSS('border-top-width', '1px')
  await expect(permissionToggle).toHaveCSS('border-top-color', 'rgb(136, 135, 125)')
  const selectedReminderStyle = await page.locator('.code-settings-pet-appearance-select.selected').evaluate(element => {
    const style = getComputedStyle(element)
    return { backgroundColor: style.backgroundColor, color: style.color }
  })
  const unselectedReminderBackground = await page.locator('.code-settings-pet-appearance-select:not(.selected)').evaluate(
    element => getComputedStyle(element).backgroundColor,
  )
  const preferenceGroupBackgrounds = await page.locator('.code-settings-segmented').evaluateAll(
    elements => elements.map(element => getComputedStyle(element).backgroundColor),
  )
  const selectedPreferenceStyles = await page.locator('.code-settings-segmented button.active').evaluateAll(elements => (
    elements.map(element => {
      const style = getComputedStyle(element)
      return { backgroundColor: style.backgroundColor, color: style.color }
    })
  ))
  expect(selectedPreferenceStyles.length).toBeGreaterThan(0)
  expect(preferenceGroupBackgrounds).toEqual(
    Array.from({ length: preferenceGroupBackgrounds.length }, () => unselectedReminderBackground),
  )
  expect(selectedPreferenceStyles).toEqual(
    Array.from({ length: selectedPreferenceStyles.length }, () => selectedReminderStyle),
  )
  const toggle = row.getByRole('switch', { name: 'Allow message notifications' })
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  expect(await page.evaluate(() => (
    window as Window & { __farmingNotificationPermissionRequests?: number }
  ).__farmingNotificationPermissionRequests)).toBe(0)

  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
  expect(await page.evaluate(() => (
    window as Window & { __farmingNotificationPermissionRequests?: number }
  ).__farmingNotificationPermissionRequests)).toBe(1)
  expect(await page.evaluate(key => localStorage.getItem(key), AGENT_COMPLETION_NOTIFICATIONS_STORAGE_KEY)).toBe('true')

  await page.reload()
  await page.getByTestId('code-sidebar-options').click()
  await expect(page.getByRole('switch', { name: 'Allow message notifications' })).toHaveAttribute('aria-checked', 'true')
  expect(await page.evaluate(() => (
    window as Window & { __farmingNotificationPermissionRequests?: number }
  ).__farmingNotificationPermissionRequests)).toBe(0)
})

test('guides blocked permission recovery and reflects grants and revocations without reloading', async ({ page }, testInfo) => {
  await installNotificationFixture(page, { permission: 'denied' })
  await openFarming(page)
  await page.getByTestId('code-sidebar-options').click()
  const row = page.getByTestId('code-settings-agent-completion-notifications')
  const toggle = row.getByRole('switch', { name: 'Allow message notifications' })
  await expect(toggle).toBeDisabled()
  await expect(row).toContainText('this page cannot show another permission prompt')
  await expect(row).toContainText('Site settings / Permissions → Notifications → Allow')
  await expect(row.locator('small').first()).toHaveCSS('white-space', 'normal')
  for (const appearance of ['light', 'dark', 'paper']) {
    await page.evaluate(value => {
      document.documentElement.dataset.appearance = value
      document.body.dataset.appearance = value
    }, appearance)
    await expect(row.getByRole('button', { name: 'Check permission again' })).toBeVisible()
    await row.screenshot({ path: testInfo.outputPath(`notification-recovery-${appearance}.png`) })
  }
  await page.getByRole('button', { name: '中文', exact: true }).click()
  await expect(row).toContainText('站点设置／权限 → 通知 → 允许')
  await row.screenshot({ path: testInfo.outputPath('notification-recovery-zh-paper.png') })
  await page.setViewportSize({ width: 390, height: 844 })
  for (const appearance of ['light', 'dark', 'paper']) {
    await page.evaluate(value => {
      document.documentElement.dataset.appearance = value
      document.body.dataset.appearance = value
    }, appearance)
    expect(await row.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    await row.screenshot({ path: testInfo.outputPath(`notification-recovery-zh-mobile-${appearance}.png`) })
  }
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.getByRole('button', { name: 'English', exact: true }).click()
  await page.evaluate(() => {
    (window as Window & { __farmingSetNotificationPermission: (value: NotificationPermission) => void })
      .__farmingSetNotificationPermission('granted')
  })
  await row.getByRole('button', { name: 'Check permission again' }).click()
  await expect(toggle).toBeEnabled()
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
  await row.getByRole('button', { name: 'Send test notification' }).click()
  await expect(row).toContainText('Do Not Disturb / Focus mode')
  expect(await page.evaluate(() => (window as Window & {
    __farmingNotifications: Array<{ title: string; closed: boolean }>
  }).__farmingNotifications.map(({ title, closed }) => ({ title, closed })))).toEqual([{ title: 'Farming', closed: false }])
  for (const appearance of ['light', 'dark', 'paper']) {
    await page.evaluate(value => {
      document.documentElement.dataset.appearance = value
      document.body.dataset.appearance = value
    }, appearance)
    await row.screenshot({ path: testInfo.outputPath(`notification-enabled-${appearance}.png`) })
  }
  await page.evaluate(() => (window as Window & {
    __farmingNotifications: Array<{ onerror?: () => void }>
  }).__farmingNotifications[0]?.onerror?.())
  await expect(row).toContainText('The test notification failed')
  await page.evaluate(() => {
    (window as Window & { __farmingSetNotificationPermission: (value: NotificationPermission) => void })
      .__farmingSetNotificationPermission('denied')
    window.dispatchEvent(new Event('focus'))
  })
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  await expect(toggle).toBeDisabled()
  await page.getByRole('button', { name: 'Close', exact: true }).click()
  expect(await page.evaluate(() => (window as Window & {
    __farmingNotifications: Array<{ closed: boolean }>
  }).__farmingNotifications[0]?.closed)).toBe(true)
  expect(await page.evaluate(() => (window as Window & {
    __farmingNotificationPermissionRequests: number
  }).__farmingNotificationPermissionRequests)).toBe(0)
})

for (const result of ['denied', 'default', 'error'] as const) {
  test(`notification permission ${result} leaves setup off with actionable feedback`, async ({ page }) => {
    await installNotificationFixture(page, { permission: 'default', requestResult: result })
    await openFarming(page)
    await page.getByTestId('code-sidebar-options').click()
    const row = page.getByTestId('code-settings-agent-completion-notifications')
    const toggle = row.getByRole('switch', { name: 'Allow message notifications' })
    await expect(row).toContainText('HTTPS does not grant permission automatically')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await expect(row).toContainText(result === 'denied'
      ? 'this page cannot show another permission prompt'
      : result === 'default' ? 'Permission was not granted' : 'Could not enable notifications')
    expect(await page.evaluate(key => localStorage.getItem(key), AGENT_COMPLETION_NOTIFICATIONS_STORAGE_KEY)).toBe('false')
  })
}

test('suppresses concurrent permission requests and ignores a grant after Settings closes', async ({ page }) => {
  await installNotificationFixture(page, { permission: 'default', requestResult: 'pending' })
  await openFarming(page)
  await page.getByTestId('code-sidebar-options').click()
  const toggle = page.getByRole('switch', { name: 'Allow message notifications' })
  await toggle.click()
  await expect(toggle).toBeDisabled()
  await expect(toggle).toHaveAttribute('aria-busy', 'true')
  await page.getByRole('button', { name: 'Close', exact: true }).click()
  await page.evaluate(() => (window as Window & {
    __farmingResolveNotificationPermission: () => void
  }).__farmingResolveNotificationPermission())
  await page.getByTestId('code-sidebar-options').click()
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  expect(await page.evaluate(key => localStorage.getItem(key), AGENT_COMPLETION_NOTIFICATIONS_STORAGE_KEY)).not.toBe('true')
  expect(await page.evaluate(() => (window as Window & {
    __farmingNotificationPermissionRequests: number
  }).__farmingNotificationPermissionRequests)).toBe(1)
})

test('bounds an unanswered browser prompt and ignores a grant after the deadline', async ({ page }) => {
  await installNotificationFixture(page, { permission: 'default', requestResult: 'pending' })
  await openFarming(page)
  await page.getByTestId('code-sidebar-options').click()
  await page.clock.install()
  const toggle = page.getByRole('switch', { name: 'Allow message notifications' })
  await toggle.click()
  await expect(toggle).toBeDisabled()
  await page.clock.fastForward(30_000)
  await expect(toggle).toBeEnabled()
  await expect(page.getByTestId('code-settings-agent-completion-notifications')).toContainText('Permission was not granted')
  await page.evaluate(() => (window as Window & {
    __farmingResolveNotificationPermission: () => void
  }).__farmingResolveNotificationPermission())
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  expect(await page.evaluate(key => localStorage.getItem(key), AGENT_COMPLETION_NOTIFICATIONS_STORAGE_KEY)).toBe('false')
})

test('notifies once for a background Agent completion and opens that Agent on click', async ({ page, workspaceRoot }) => {
  await installNotificationFixture(page, { permission: 'granted', enabled: true })
  const workspace = path.join(workspaceRoot, 'agent-completion-notifications')
  fs.mkdirSync(workspace, { recursive: true })
  const completedAgentId = await createAcpAgent(page, workspace)
  const foregroundAgentId = await createAcpAgent(page, workspace, 'opencode')

  await openFarming(page)
  const completedRow = page.locator(`[data-testid="code-agent-row"][data-agent-id="${completedAgentId}"]`)
  const foregroundRow = page.locator(`[data-testid="code-agent-row"][data-agent-id="${foregroundAgentId}"]`)
  await completedRow.click()
  const input = page.getByTestId('code-acp-composer-input')
  await input.fill('streaming thought')
  await page.getByTestId('code-acp-composer-send').click()
  await expect(page.getByText('streaming thought', { exact: true })).toBeVisible()

  await setPageVisibility(page, 'hidden')
  await foregroundRow.click()
  await expect(foregroundRow).toHaveClass(/active/)
  await page.getByTestId('code-sidebar-options').click()
  await expect(page.getByTestId('code-settings-panel')).toBeVisible()

  await expect.poll(async () => page.evaluate(() => (
    window as Window & { __farmingNotifications?: Array<unknown> }
  ).__farmingNotifications?.length ?? 0), { timeout: 15_000 }).toBe(1)
  await expect(completedRow).toHaveClass(/unread/)

  const notification = await page.evaluate(() => {
    const first = (window as Window & {
      __farmingNotifications?: Array<{ title: string; body: string; tag: string }>
    }).__farmingNotifications?.[0]
    return first ? { title: first.title, body: first.body, tag: first.tag } : null
  })
  expect(notification?.title).toBeTruthy()
  expect(notification?.body).toContain('Streaming thought complete.')
  expect(notification?.tag).toBe(`farming-agent-${completedAgentId}`)

  await page.evaluate(() => {
    const first = (window as Window & {
      __farmingNotifications?: Array<{ onclick: (() => void) | null }>
    }).__farmingNotifications?.[0]
    first?.onclick?.()
  })
  await expect(completedRow).toHaveClass(/active/)
  await expect(page.getByTestId('code-settings-panel')).toBeHidden()
  await expect(page.getByText('Streaming thought complete.', { exact: true })).toBeVisible()
  // Keep the silence window: this proves the click cannot schedule a duplicate completion notification.
  await page.waitForTimeout(500)
  expect(await page.evaluate(() => (
    window as Window & { __farmingNotifications?: Array<unknown> }
  ).__farmingNotifications?.length ?? 0)).toBe(1)
})

test('uses Terminal-native notification requests instead of inferred command completion', async ({ page, workspaceRoot }) => {
  await installNotificationFixture(page, { permission: 'granted', enabled: true })
  const workspace = path.join(workspaceRoot, 'terminal-native-notifications')
  fs.mkdirSync(workspace, { recursive: true })
  const agentId = await createTerminalAgent(page, workspace)

  await openFarming(page)
  await setPageVisibility(page, 'hidden')
  const ordinaryCommand = await page.request.post(`/farming/api/control/agents/${agentId}/input`, {
    data: { input: "printf 'ordinary completion\\n'\r" },
  })
  expect(ordinaryCommand.ok()).toBeTruthy()
  // Terminal output settles asynchronously; this is the negative-notification silence boundary.
  await page.waitForTimeout(600)
  expect(await page.evaluate(() => (
    window as Window & { __farmingNotifications?: Array<unknown> }
  ).__farmingNotifications?.length ?? 0)).toBe(0)

  const shellBell = await page.request.post(`/farming/api/control/agents/${agentId}/input`, {
    data: { input: "printf '\\007'\r" },
  })
  expect(shellBell.ok()).toBeTruthy()
  // Ordinary Shell BEL is line-editor feedback, not an attention request.
  await page.waitForTimeout(600)
  expect(await page.evaluate(() => (
    window as Window & { __farmingNotifications?: Array<unknown> }
  ).__farmingNotifications?.length ?? 0)).toBe(0)

  const nativeNotification = await page.request.post(`/farming/api/control/agents/${agentId}/input`, {
    data: { input: "printf '\\033]9;Explicit shell notification\\007'\r" },
  })
  expect(nativeNotification.ok()).toBeTruthy()
  await expect.poll(async () => page.evaluate(() => (
    window as Window & { __farmingNotifications?: Array<unknown> }
  ).__farmingNotifications?.length ?? 0), { timeout: 10_000 }).toBe(1)

  const body = await page.evaluate(() => (
    window as Window & { __farmingNotifications?: Array<{ body: string }> }
  ).__farmingNotifications?.[0]?.body ?? '')
  expect(body).toContain('Explicit shell notification')
})
