import { expect, openFarming, test } from './fixtures'
import type { Locator, WebSocketRoute } from '@playwright/test'

const SETTINGS_KEY = 'farmingPetSettings'
const RUNTIME_KEY = 'farmingPetRestReminderRuntime'

async function readBlackHoleOuterInk(canvas: Locator) {
  return canvas.evaluate(element => {
    return {
      inkPixels: Number(element.getAttribute('data-radiation-ink-pixels') ?? '0'),
      coveredSectors: Number(element.getAttribute('data-radiation-covered-sectors') ?? '0'),
    }
  })
}

test('narrow layouts do not proactively show the first-use invitation', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await openFarming(page)

  await expect(page.getByTestId('pet-rest-invitation')).toHaveCount(0)
  await page.getByTestId('code-mobile-menu').click()
  await expect(page.getByTestId('code-sidebar')).toBeVisible()
  await expect(page.getByTestId('pet-rest-invitation')).toHaveCount(0)
})

test('dark appearance defaults an unconfigured Pet to the black hole', async ({ page }) => {
  await openFarming(page)

  const invitation = page.getByTestId('pet-rest-invitation')
  await expect(invitation).toBeVisible()
  await page.getByTestId('code-sidebar-options').click()
  const settings = page.getByTestId('code-settings-panel')
  await settings.getByRole('group', { name: 'Appearance' })
    .getByRole('button', { name: 'Dark', exact: true })
    .click()
  await expect(
    settings.getByRole('group', { name: 'Reminder style' })
      .getByRole('button', { name: 'Black hole', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true')
  await settings.getByRole('button', { name: 'Close', exact: true }).click()

  await invitation.getByRole('button', { name: 'Try it', exact: true }).click()
  const appearanceChoice = page.getByTestId('pet-appearance-choice')
  const blackHoleOption = appearanceChoice.getByRole('button', { name: /^Black hole/ })
  await expect(appearanceChoice).toBeVisible()
  await expect(blackHoleOption).toHaveAttribute('aria-pressed', 'true')
  await expect(blackHoleOption.locator('em')).toHaveText('Default')
  await expect.poll(() => page.evaluate(key => (
    JSON.parse(localStorage.getItem(key) ?? 'null')?.appearance ?? null
  ), SETTINGS_KEY)).toBeNull()
})

test('dark black-hole status stays readable and manual exit fully evaporates in place', async ({ page }) => {
  await page.request.post('/farming/api/settings', {
    data: { appearance: 'dark' },
  })
  await page.addInitScript(({ settingsKey, runtimeKey }) => {
    localStorage.setItem(settingsKey, JSON.stringify({
      version: 1,
      appearance: 'black-hole',
      capabilities: { restReminder: { intervalSeconds: 50 * 60 } },
    }))
    sessionStorage.setItem(runtimeKey, JSON.stringify({
      version: 1,
      state: {
        phase: 'resting',
        intervalSeconds: 50 * 60,
        cycleStartedAt: null,
        lastActivityAt: null,
        snoozedUntil: null,
        restStartsAt: null,
        restUntil: Date.now() + 5 * 60_000,
        snoozeUsed: false,
      },
    }))
  }, { settingsKey: SETTINGS_KEY, runtimeKey: RUNTIME_KEY })

  await openFarming(page)
  await expect(page.locator('body')).toHaveAttribute('data-appearance', 'dark')
  const scene = page.getByTestId('pet-rest-scene')
  const label = scene.locator('.code-pet-black-hole-status-label')
  const clock = scene.locator('.code-pet-seven-segment-time')
  const endBreak = scene.getByRole('button', { name: 'End break' })
  await expect(scene).toBeVisible()
  await expect(scene.locator('.code-pet-black-hole-error')).toHaveCount(0)
  await expect(label).toHaveCSS('color', 'rgba(226, 235, 229, 0.82)')
  await expect(clock).toHaveCSS('color', 'rgb(231, 238, 233)')
  await expect(endBreak).toHaveCSS('color', 'rgba(238, 245, 240, 0.9)')

  await endBreak.click()
  await expect(scene).toHaveClass(/exiting/)
  await expect.poll(async () => Number(
    await scene.locator('.code-pet-black-hole-compositor')
      .getAttribute('data-exit-progress') ?? '0',
  )).toBeGreaterThan(0.52)
  await expect(scene.locator('.code-pet-black-hole-compositor'))
    .toHaveAttribute('data-evaporation-phase', 'radiation')
  await expect(scene.locator('.code-pet-black-hole-canvas'))
    .toHaveAttribute('data-radiation-probe', 'sampled')
  await expect(scene).toBeVisible()
  await expect(page.locator('.code-pet-black-hole-compositor')).toHaveCount(1)
  await expect.poll(async () => {
    const radiationInk = await readBlackHoleOuterInk(
      scene.locator('.code-pet-black-hole-canvas'),
    )
    return radiationInk.inkPixels > 20 && radiationInk.coveredSectors > 8
      ? 'visible'
      : `ink=${radiationInk.inkPixels}, sectors=${radiationInk.coveredSectors}`
  }, { timeout: 2_000 }).toBe('visible')
  await expect(scene).toHaveCount(0, { timeout: 7_000 })
})

test('dark soft-glow rest scene stays readable and retains modal keyboard behavior', async ({ page }) => {
  await page.request.post('/farming/api/settings', {
    data: { appearance: 'dark' },
  })
  await page.addInitScript(({ settingsKey, runtimeKey }) => {
    localStorage.setItem(settingsKey, JSON.stringify({
      version: 1,
      appearance: 'glass',
      capabilities: { restReminder: { intervalSeconds: 50 * 60 } },
    }))
    sessionStorage.setItem(runtimeKey, JSON.stringify({
      version: 1,
      state: {
        phase: 'resting',
        intervalSeconds: 50 * 60,
        cycleStartedAt: null,
        lastActivityAt: null,
        snoozedUntil: null,
        restStartsAt: null,
        restUntil: Date.now() + 5 * 60_000,
        snoozeUsed: false,
      },
    }))
  }, { settingsKey: SETTINGS_KEY, runtimeKey: RUNTIME_KEY })

  await openFarming(page)
  await expect(page.locator('body')).toHaveAttribute('data-appearance', 'dark')
  const scene = page.getByTestId('pet-rest-scene')
  const clock = scene.locator('.code-pet-glass-rest-time')
  const body = scene.locator('.code-pet-glass-rest-content p')
  const endBreak = scene.getByRole('button', { name: 'End break' })
  await expect(scene).toHaveAttribute('data-pet-appearance', 'glass')
  await expect(scene).toHaveCSS('color', 'rgb(227, 233, 229)')
  await expect(clock).toHaveCSS('color', 'rgb(237, 242, 239)')
  await expect(body).toHaveCSS('color', 'rgba(227, 233, 229, 0.62)')
  await expect(endBreak).toHaveCSS('color', 'rgb(240, 246, 242)')
  await expect(endBreak).toBeFocused()
  await expect(page.locator('#root')).toHaveAttribute('aria-hidden', 'true')

  await page.keyboard.press('Escape')
  await expect(scene).toHaveCount(0)
  await expect(page.locator('#root')).not.toHaveAttribute('aria-hidden', 'true')
})

for (const appearance of ['glass', 'black-hole'] as const) {
  test(`${appearance} pauses in the background and resumes from absolute time`, async ({ page }) => {
    await page.addInitScript(({ settingsKey, runtimeKey, selectedAppearance }) => {
      const now = Date.now()
      localStorage.setItem(settingsKey, JSON.stringify({
        version: 1,
        appearance: selectedAppearance,
        capabilities: { restReminder: { intervalSeconds: 50 * 60 } },
      }))
      sessionStorage.setItem(runtimeKey, JSON.stringify({
        version: 1,
        state: {
          phase: 'resting',
          intervalSeconds: 50 * 60,
          cycleStartedAt: null,
          lastActivityAt: null,
          snoozedUntil: null,
          restStartsAt: null,
          restUntil: now + 30_000,
          snoozeUsed: false,
        },
      }))
    }, {
      settingsKey: SETTINGS_KEY,
      runtimeKey: RUNTIME_KEY,
      selectedAppearance: appearance,
    })
    await openFarming(page)
    await page.evaluate(() => {
      const testDocument = document as Document & {
        __petVisibilityState?: DocumentVisibilityState
      }
      const testWindow = window as Window & {
        __setPetVisibility?: (state: DocumentVisibilityState) => void
      }
      testDocument.__petVisibilityState = 'visible'
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => testDocument.__petVisibilityState,
      })
      Object.defineProperty(document, 'hidden', {
        configurable: true,
        get: () => testDocument.__petVisibilityState === 'hidden',
      })
      testWindow.__setPetVisibility = state => {
        testDocument.__petVisibilityState = state
        document.dispatchEvent(new Event('visibilitychange'))
      }
    })
    const scene = page.getByTestId('pet-rest-scene')
    const clock = scene.locator('time')
    await expect(scene).toHaveAttribute('data-pet-appearance', appearance)
    await page.evaluate(() => (
      (window as Window & {
        __setPetVisibility?: (state: DocumentVisibilityState) => void
      }).__setPetVisibility?.('hidden')
    ))
    await page.waitForTimeout(100)
    const before = await clock.getAttribute('aria-label') ?? await clock.textContent()
    await page.waitForTimeout(2_200)
    const whileHidden = await clock.getAttribute('aria-label') ?? await clock.textContent()
    expect(whileHidden).toBe(before)
    await page.evaluate(() => (
      (window as Window & {
        __setPetVisibility?: (state: DocumentVisibilityState) => void
      }).__setPetVisibility?.('visible')
    ))

    await expect.poll(async () => (
      await clock.getAttribute('aria-label') ?? await clock.textContent()
    )).not.toBe(before)
    if (appearance === 'black-hole') {
      await expect(scene.locator('.code-pet-black-hole-canvas')).toHaveCount(1)
    }
    await scene.getByRole('button', { name: 'End break' }).click()
    await expect(scene).toHaveCount(0, {
      timeout: appearance === 'black-hole' ? 7_000 : 1_000,
    })
  })
}

test('reloading an active black-hole break keeps one Pet renderer', async ({ page }) => {
  await page.addInitScript(({ settingsKey, runtimeKey }) => {
    localStorage.setItem(settingsKey, JSON.stringify({
      version: 1,
      appearance: 'black-hole',
      capabilities: { restReminder: { intervalSeconds: 50 * 60 } },
    }))
    if (sessionStorage.getItem(runtimeKey)) return
    sessionStorage.setItem(runtimeKey, JSON.stringify({
      version: 1,
      state: {
        phase: 'resting',
        intervalSeconds: 50 * 60,
        cycleStartedAt: null,
        lastActivityAt: null,
        snoozedUntil: null,
        restStartsAt: null,
        restUntil: Date.now() + 5 * 60_000,
        snoozeUsed: false,
      },
    }))
  }, { settingsKey: SETTINGS_KEY, runtimeKey: RUNTIME_KEY })

  await openFarming(page)
  const scene = page.getByTestId('pet-rest-scene')
  await expect(scene).toHaveCount(1)
  await expect(scene.locator('.code-pet-black-hole-canvas')).toHaveCount(1)
  await expect(scene.locator('.code-pet-black-hole-compositor')).toHaveCount(1)
  await expect(page.locator('html')).toHaveAttribute('data-farming-pet-owner', /.+/)

  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(page.getByTestId('app-shell')).toBeVisible()
  await expect(scene).toHaveCount(1)
  await expect(scene.locator('.code-pet-black-hole-canvas')).toHaveCount(1)
  await expect(scene.locator('.code-pet-black-hole-compositor')).toHaveCount(1)

  await scene.getByRole('button', { name: 'End break' }).click()
  await expect(scene).toHaveCount(0, { timeout: 7_000 })
})

test('backend disconnect does not reset or duplicate an active black-hole break', async ({ page }) => {
  let outage = false
  let activeSocket: WebSocketRoute | null = null
  await page.routeWebSocket(/\/farming\/ws(?:\?|$)/, async socket => {
    if (outage) {
      await socket.close({ code: 1012, reason: 'Pet reconnect regression' })
      return
    }
    activeSocket = socket
    socket.connectToServer()
  })
  await page.addInitScript(({ settingsKey, runtimeKey }) => {
    localStorage.setItem(settingsKey, JSON.stringify({
      version: 1,
      appearance: 'black-hole',
      capabilities: { restReminder: { intervalSeconds: 50 * 60 } },
    }))
    sessionStorage.setItem(runtimeKey, JSON.stringify({
      version: 1,
      state: {
        phase: 'resting',
        intervalSeconds: 50 * 60,
        cycleStartedAt: null,
        lastActivityAt: null,
        snoozedUntil: null,
        restStartsAt: null,
        restUntil: Date.now() + 5 * 60_000,
        snoozeUsed: false,
      },
    }))
  }, { settingsKey: SETTINGS_KEY, runtimeKey: RUNTIME_KEY })

  await openFarming(page)
  const scene = page.getByTestId('pet-rest-scene')
  const clock = scene.locator('time')
  await expect(scene).toBeVisible()
  await expect(scene.locator('.code-pet-black-hole-canvas')).toHaveCount(1)
  await expect.poll(() => Boolean(activeSocket)).toBe(true)
  const beforeDisconnect = await clock.getAttribute('aria-label') ?? await clock.textContent()

  outage = true
  await activeSocket?.close({ code: 1012, reason: 'Pet reconnect regression' })
  await expect(page.getByTestId('connection-status')).toBeVisible()
  await page.waitForTimeout(2_200)
  const duringDisconnect = await clock.getAttribute('aria-label') ?? await clock.textContent()
  expect(duringDisconnect).not.toBe(beforeDisconnect)
  await expect(scene).toHaveCount(1)
  await expect(scene.locator('.code-pet-black-hole-compositor')).toHaveCount(1)
  await expect(scene.locator('.code-pet-black-hole-canvas')).toHaveCount(1)

  outage = false
  await expect(page.getByTestId('connection-status')).toHaveCount(0, { timeout: 7_000 })
  await expect(scene).toHaveCount(1)
  await expect(scene.locator('.code-pet-black-hole-canvas')).toHaveCount(1)
  await scene.getByRole('button', { name: 'End break' }).click()
  await expect(scene).toHaveCount(0, { timeout: 7_000 })
})

test('natural black-hole evaporation resumes at the absolute-time progress', async ({ page }) => {
  await page.addInitScript(({ settingsKey, runtimeKey }) => {
    localStorage.setItem(settingsKey, JSON.stringify({
      version: 1,
      appearance: 'black-hole',
      capabilities: { restReminder: { intervalSeconds: 50 * 60 } },
    }))
    sessionStorage.setItem(runtimeKey, JSON.stringify({
      version: 1,
      state: {
        phase: 'resting',
        intervalSeconds: 50 * 60,
        cycleStartedAt: null,
        lastActivityAt: null,
        snoozedUntil: null,
        restStartsAt: null,
        restUntil: Date.now() + 13_000,
        snoozeUsed: false,
      },
    }))
  }, { settingsKey: SETTINGS_KEY, runtimeKey: RUNTIME_KEY })

  await openFarming(page)
  const scene = page.getByTestId('pet-rest-scene')
  const compositor = scene.locator('.code-pet-black-hole-compositor')
  await expect(scene).toHaveClass(/exiting/)
  await expect.poll(async () => Number(
    await compositor.getAttribute('data-exit-progress') ?? '0',
  )).toBeGreaterThan(0.18)
  await expect(compositor).toHaveAttribute('data-evaporation-phase', 'radiation')
  await page.evaluate(() => {
    const testDocument = document as Document & {
      __petVisibilityState?: DocumentVisibilityState
    }
    testDocument.__petVisibilityState = 'hidden'
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => testDocument.__petVisibilityState,
    })
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => testDocument.__petVisibilityState === 'hidden',
    })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await page.waitForTimeout(100)
  const progressBeforeHide = Number(
    await compositor.getAttribute('data-exit-progress') ?? '0',
  )
  await page.waitForTimeout(1_200)
  const progressWhileHidden = Number(
    await compositor.getAttribute('data-exit-progress') ?? '0',
  )
  expect(progressWhileHidden).toBeLessThanOrEqual(progressBeforeHide + 0.005)
  await page.evaluate(() => {
    const testDocument = document as Document & {
      __petVisibilityState?: DocumentVisibilityState
    }
    testDocument.__petVisibilityState = 'visible'
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await expect.poll(async () => Number(
    await compositor.getAttribute('data-exit-progress') ?? '0',
  )).toBeGreaterThan(progressBeforeHide + 0.05)
  await expect(compositor).toHaveAttribute('data-evaporation-phase', 'radiation')
  await expect(scene).toHaveCount(0, { timeout: 16_000 })
})

test('black-hole snapshot refresh excludes Pet UI and keeps one renderer', async ({ page }) => {
  test.slow()
  await page.addInitScript(({ settingsKey, runtimeKey }) => {
    localStorage.setItem(settingsKey, JSON.stringify({
      version: 1,
      appearance: 'black-hole',
      capabilities: { restReminder: { intervalSeconds: 50 * 60 } },
    }))
    sessionStorage.setItem(runtimeKey, JSON.stringify({
      version: 1,
      state: {
        phase: 'resting',
        intervalSeconds: 50 * 60,
        cycleStartedAt: null,
        lastActivityAt: null,
        snoozedUntil: null,
        restStartsAt: null,
        restUntil: Date.now() + 5 * 60_000,
        snoozeUsed: false,
      },
    }))
  }, { settingsKey: SETTINGS_KEY, runtimeKey: RUNTIME_KEY })

  await openFarming(page)
  const scene = page.getByTestId('pet-rest-scene')
  const compositor = scene.locator('.code-pet-black-hole-compositor')
  await expect(scene).toHaveCount(1)
  await expect(scene.locator('.code-pet-black-hole-compositor')).toHaveCount(1)
  await expect(scene.locator('.code-pet-black-hole-canvas')).toHaveCount(1)
  await expect(scene.locator('.code-pet-black-hole-status')).toHaveCount(1)
  await expect(scene.locator('.code-pet-black-hole-error')).toHaveCount(0)
  await expect(compositor).toHaveAttribute('data-refresh-state', 'idle')

  await page.getByTestId('code-sidebar-options').click()
  const settings = page.getByTestId('code-settings-panel')
  await expect(settings).toBeVisible()
  await expect(settings).toHaveAttribute('data-pet-snapshot-exclude', 'true')
  const previousGeneration = Number(
    await compositor.getAttribute('data-scene-generation') ?? '0',
  )
  await page.evaluate(() => (
    (window as Window & {
      __farmingBlackHolePetTest?: { refreshScene: () => void }
    }).__farmingBlackHolePetTest?.refreshScene()
  ))
  await expect.poll(async () => Number(
    await compositor.getAttribute('data-scene-generation') ?? '0',
  )).toBeGreaterThan(previousGeneration)
  await expect(compositor).toHaveAttribute('data-refresh-state', 'idle')
  await expect(compositor).toHaveAttribute('data-remaining-pet-elements', '0')
  await expect(scene).toHaveCount(1)
  await expect(scene.locator('.code-pet-black-hole-canvas')).toHaveCount(1)
  await expect(scene.locator('.code-pet-black-hole-compositor')).toHaveCount(1)

  await settings.getByRole('button', { name: 'Close', exact: true }).click()
  await scene.getByRole('button', { name: 'End break' }).click()
  await expect(scene).toHaveCount(0, { timeout: 7_000 })
})

test('initial black-hole snapshot failure retries and clears the visible error', async ({ page }) => {
  await page.addInitScript(({ settingsKey, runtimeKey }) => {
    localStorage.setItem(settingsKey, JSON.stringify({
      version: 1,
      appearance: 'black-hole',
      capabilities: { restReminder: { intervalSeconds: 50 * 60 } },
    }))
    sessionStorage.setItem(runtimeKey, JSON.stringify({
      version: 1,
      state: {
        phase: 'resting',
        intervalSeconds: 50 * 60,
        cycleStartedAt: null,
        lastActivityAt: null,
        snoozedUntil: null,
        restStartsAt: null,
        restUntil: Date.now() + 5 * 60_000,
        snoozeUsed: false,
      },
    }))
    ;(window as Window & {
      __farmingBlackHoleCaptureFailures?: number
    }).__farmingBlackHoleCaptureFailures = 3
  }, { settingsKey: SETTINGS_KEY, runtimeKey: RUNTIME_KEY })

  await openFarming(page)
  const scene = page.getByTestId('pet-rest-scene')
  const compositor = scene.locator('.code-pet-black-hole-compositor')
  await expect(scene.locator('.code-pet-black-hole-error')).toHaveCount(1)
  await expect(compositor).toHaveAttribute(
    'data-refresh-state',
    'initial-retry-wait',
  )
  await expect(compositor).toHaveAttribute(
    'data-refresh-error',
    'Synthetic initial black-hole snapshot failure.',
  )
  await expect(compositor).toHaveAttribute(
    'data-refresh-state',
    'idle',
    { timeout: 15_000 },
  )
  await expect(scene.locator('.code-pet-black-hole-error')).toHaveCount(0)
  await expect(scene.locator('.code-pet-black-hole-canvas')).toBeVisible()

  await scene.getByRole('button', { name: 'End break' }).click()
  await expect(scene).toHaveCount(0, { timeout: 7_000 })
})

test('ending a break remains bounded while the first snapshot is unavailable', async ({ page }) => {
  await page.addInitScript(({ settingsKey, runtimeKey }) => {
    localStorage.setItem(settingsKey, JSON.stringify({
      version: 1,
      appearance: 'black-hole',
      capabilities: { restReminder: { intervalSeconds: 50 * 60 } },
    }))
    sessionStorage.setItem(runtimeKey, JSON.stringify({
      version: 1,
      state: {
        phase: 'resting',
        intervalSeconds: 50 * 60,
        cycleStartedAt: null,
        lastActivityAt: null,
        snoozedUntil: null,
        restStartsAt: null,
        restUntil: Date.now() + 5 * 60_000,
        snoozeUsed: false,
      },
    }))
    ;(window as Window & {
      __farmingBlackHoleCaptureFailures?: number
    }).__farmingBlackHoleCaptureFailures = 100
  }, { settingsKey: SETTINGS_KEY, runtimeKey: RUNTIME_KEY })

  await openFarming(page)
  const scene = page.getByTestId('pet-rest-scene')
  await expect(scene.locator('.code-pet-black-hole-error')).toHaveCount(1)
  await scene.getByRole('button', { name: 'End break' }).click()
  await expect(scene).toHaveClass(/exiting/)
  await expect(scene).toHaveCount(0, { timeout: 7_000 })
})

test('closing the first-use invitation keeps the reminder off after reload', async ({ page }) => {
  await openFarming(page)

  const invitation = page.getByTestId('pet-rest-invitation')
  await expect(invitation).toBeVisible()
  await invitation.locator('.code-pet-close').click()
  await expect(invitation).toBeHidden()

  await expect.poll(() => page.evaluate(key => {
    const settings = JSON.parse(localStorage.getItem(key) ?? 'null')
    return settings?.capabilities?.restReminder?.intervalSeconds
  }, SETTINGS_KEY)).toBe(0)

  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(page.getByTestId('app-shell')).toBeVisible()
  await expect(page.getByTestId('pet-rest-invitation')).toHaveCount(0)
})

test('appearance changes preserve the active cycle and reload restores it', async ({ page }) => {
  await page.addInitScript(({ settingsKey, runtimeKey }) => {
    if (sessionStorage.getItem(runtimeKey)) return
    const now = Date.now()
    localStorage.setItem(settingsKey, JSON.stringify({
      version: 1,
      appearance: 'glass',
      capabilities: { restReminder: { intervalSeconds: 50 * 60 } },
    }))
    sessionStorage.setItem(runtimeKey, JSON.stringify({
      version: 1,
      state: {
        phase: 'working',
        intervalSeconds: 50 * 60,
        cycleStartedAt: now - 10 * 60_000,
        lastActivityAt: now,
        snoozedUntil: null,
        restStartsAt: null,
        restUntil: null,
        snoozeUsed: false,
      },
    }))
  }, { settingsKey: SETTINGS_KEY, runtimeKey: RUNTIME_KEY })

  await openFarming(page)
  const originalCycleStartedAt = await page.evaluate(key => (
    JSON.parse(sessionStorage.getItem(key) ?? 'null')?.state?.cycleStartedAt
  ), RUNTIME_KEY)

  await page.getByTestId('code-sidebar-options').click()
  const settings = page.getByTestId('code-settings-panel')
  await expect(settings).toBeVisible()
  await settings.getByRole('group', { name: 'Reminder style' })
    .getByRole('button', { name: 'Black hole' })
    .click()

  await expect.poll(() => page.evaluate(key => (
    JSON.parse(sessionStorage.getItem(key) ?? 'null')?.state?.cycleStartedAt
  ), RUNTIME_KEY)).toBe(originalCycleStartedAt)

  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(page.getByTestId('app-shell')).toBeVisible()
  const restored = await page.evaluate(key => (
    JSON.parse(sessionStorage.getItem(key) ?? 'null')?.state
  ), RUNTIME_KEY)
  expect(restored.phase).toBe('working')
  expect(restored.cycleStartedAt).toBe(originalCycleStartedAt)
})

test('Settings blocks rest entry and closing it starts a fresh entry countdown', async ({ page }) => {
  test.slow()
  await page.addInitScript(({ settingsKey, runtimeKey }) => {
    const now = Date.now()
    localStorage.setItem(settingsKey, JSON.stringify({
      version: 1,
      appearance: 'glass',
      capabilities: { restReminder: { intervalSeconds: 60 } },
    }))
    sessionStorage.setItem(runtimeKey, JSON.stringify({
      version: 1,
      state: {
        phase: 'working',
        intervalSeconds: 60,
        cycleStartedAt: now - 45_000,
        lastActivityAt: now,
        snoozedUntil: null,
        restStartsAt: null,
        restUntil: null,
        snoozeUsed: false,
      },
    }))
  }, { settingsKey: SETTINGS_KEY, runtimeKey: RUNTIME_KEY })

  await openFarming(page)
  await page.getByTestId('code-sidebar-options').click()
  const settings = page.getByTestId('code-settings-panel')
  const closeSettings = settings.getByRole('button', { name: 'Close', exact: true })
  await expect(settings).toBeVisible()

  await page.waitForTimeout(20_000)
  await expect(page.getByTestId('pet-rest-scene')).toHaveCount(0)
  await expect(page.getByTestId('pet-rest-reminder')).toHaveCount(0)
  await expect(closeSettings).toBeVisible()
  await expect(closeSettings).toBeEnabled()
  expect(await page.locator('#root').evaluate(element => (element as HTMLElement).inert))
    .toBe(false)

  const closedAt = Date.now()
  await closeSettings.click()
  const reminder = page.getByTestId('pet-rest-reminder')
  await expect(reminder).toBeVisible()
  await expect(page.getByTestId('pet-rest-scene')).toHaveCount(0)
  const restStartsAt = await page.evaluate(key => (
    JSON.parse(sessionStorage.getItem(key) ?? 'null')?.state?.restStartsAt
  ), RUNTIME_KEY)
  expect(restStartsAt).toBeGreaterThanOrEqual(closedAt + 29_000)

  const scene = page.getByTestId('pet-rest-scene')
  await expect(scene).toBeVisible({ timeout: 32_000 })
  await scene.getByRole('button', { name: 'End break' }).click()
  await expect(scene).toHaveCount(0)
})

test('input bursts commit activity at most once per second', async ({ page }) => {
  await page.addInitScript(({ settingsKey, runtimeKey }) => {
    const now = Date.now()
    localStorage.setItem(settingsKey, JSON.stringify({
      version: 1,
      appearance: 'glass',
      capabilities: { restReminder: { intervalSeconds: 50 * 60 } },
    }))
    sessionStorage.setItem(runtimeKey, JSON.stringify({
      version: 1,
      state: {
        phase: 'working',
        intervalSeconds: 50 * 60,
        cycleStartedAt: now,
        lastActivityAt: now,
        snoozedUntil: null,
        restStartsAt: null,
        restUntil: null,
        snoozeUsed: false,
      },
    }))
    const originalSetItem = Storage.prototype.setItem
    ;(window as Window & { __petRuntimeWriteCount?: number }).__petRuntimeWriteCount = 0
    Storage.prototype.setItem = function setItem(key, value) {
      if (this === sessionStorage && key === runtimeKey) {
        const state = window as Window & { __petRuntimeWriteCount?: number }
        state.__petRuntimeWriteCount = (state.__petRuntimeWriteCount ?? 0) + 1
      }
      return originalSetItem.call(this, key, value)
    }
  }, { settingsKey: SETTINGS_KEY, runtimeKey: RUNTIME_KEY })

  await openFarming(page)
  const writesBeforeBurst = await page.evaluate(() => (
    (window as Window & { __petRuntimeWriteCount?: number }).__petRuntimeWriteCount ?? 0
  ))
  await page.evaluate(() => {
    for (let index = 0; index < 100; index += 1) {
      document.body.dispatchEvent(new InputEvent('input', { bubbles: true }))
    }
  })
  const writesImmediatelyAfterBurst = await page.evaluate(() => (
    (window as Window & { __petRuntimeWriteCount?: number }).__petRuntimeWriteCount ?? 0
  ))
  expect(writesImmediatelyAfterBurst).toBe(writesBeforeBurst)

  await expect.poll(() => page.evaluate(() => (
    (window as Window & { __petRuntimeWriteCount?: number }).__petRuntimeWriteCount ?? 0
  ))).toBe(writesBeforeBurst + 1)
})

test('the soft-glow rest scene owns focus and Escape ends the break', async ({ page }) => {
  await page.addInitScript(({ settingsKey, runtimeKey }) => {
    localStorage.setItem(settingsKey, JSON.stringify({
      version: 1,
      appearance: 'glass',
      capabilities: { restReminder: { intervalSeconds: 50 * 60 } },
    }))
    sessionStorage.setItem(runtimeKey, JSON.stringify({
      version: 1,
      state: {
        phase: 'resting',
        intervalSeconds: 50 * 60,
        cycleStartedAt: null,
        lastActivityAt: null,
        snoozedUntil: null,
        restStartsAt: null,
        restUntil: Date.now() + 5 * 60_000,
        snoozeUsed: false,
      },
    }))
  }, { settingsKey: SETTINGS_KEY, runtimeKey: RUNTIME_KEY })

  await openFarming(page)
  const scene = page.getByTestId('pet-rest-scene')
  await expect(scene).toBeVisible()
  await expect(scene).toHaveAttribute('aria-modal', 'true')
  await expect(page.locator('#root')).toHaveAttribute('aria-hidden', 'true')
  await expect(scene.getByRole('button', { name: 'End break' })).toBeFocused()
  await page.evaluate(() => {
    const testWindow = window as Window & { __petEscapeLeakCount?: number }
    testWindow.__petEscapeLeakCount = 0
    window.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        testWindow.__petEscapeLeakCount = (testWindow.__petEscapeLeakCount ?? 0) + 1
      }
    })
  })

  await page.keyboard.press('Escape')
  await expect(scene).toHaveCount(0)
  await expect(page.locator('#root')).not.toHaveAttribute('aria-hidden', 'true')
  expect(await page.locator('#root').evaluate(element => (element as HTMLElement).inert)).toBe(false)
  expect(await page.evaluate(() => (
    (window as Window & { __petEscapeLeakCount?: number }).__petEscapeLeakCount
  ))).toBe(0)
})

test('Escape commits a valid custom interval before closing Settings', async ({ page }) => {
  await page.addInitScript(settingsKey => {
    localStorage.setItem(settingsKey, JSON.stringify({
      version: 1,
      appearance: 'glass',
      capabilities: { restReminder: { intervalSeconds: 50 * 60 } },
    }))
  }, SETTINGS_KEY)

  await openFarming(page)
  await page.getByTestId('code-sidebar-options').click()
  const settings = page.getByTestId('code-settings-panel')
  await expect(settings).toBeVisible()
  const customInterval = settings.getByRole('spinbutton', {
    name: 'Custom reminder interval in minutes',
  })
  await customInterval.fill('37')
  await customInterval.press('Escape')
  await expect(settings).toBeHidden()

  await page.getByTestId('code-sidebar-options').click()
  await expect(settings).toBeVisible()
  await expect(customInterval).toHaveValue('37')
  await expect(settings.getByRole('slider', { name: 'Break reminder' }))
    .toHaveAttribute('aria-valuetext', 'Every 37 min')
})
