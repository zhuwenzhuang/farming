import { expect, openFarming, test } from './fixtures'
import type { Locator, Page, WebSocketRoute } from '@playwright/test'

const SETTINGS_KEY = 'farmingPetSettings'
const RUNTIME_KEY = 'farmingPetRestReminderRuntime'
const PET_SETUP_SCREENSHOT_DIR = process.env.FARMING_PET_SETUP_SCREENSHOT_DIR

async function capturePetSetupStep(page: Page, name: string) {
  if (!PET_SETUP_SCREENSHOT_DIR) return
  await page.screenshot({
    path: `${PET_SETUP_SCREENSHOT_DIR}/${name}.png`,
    animations: 'disabled',
    fullPage: false,
  })
}

async function readBlackHoleOuterInk(canvas: Locator) {
  return canvas.evaluate(element => {
    return {
      inkPixels: Number(element.getAttribute('data-radiation-ink-pixels') ?? '0'),
      coveredSectors: Number(element.getAttribute('data-radiation-covered-sectors') ?? '0'),
    }
  })
}

test('unconfigured reminder shows its invitation in narrow layouts', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await openFarming(page)

  await expect(page.getByTestId('pet-rest-invitation')).toBeVisible()
  await page.getByTestId('code-mobile-menu').click()
  await expect(page.getByTestId('code-sidebar')).toBeVisible()
  await expect(page.getByTestId('pet-rest-invitation')).toBeVisible()
})

test('break reminder keeps its English status copy compact', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
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
        phase: 'due',
        intervalSeconds: 50 * 60,
        cycleStartedAt: now - 50 * 60_000,
        lastActivityAt: now,
        snoozedUntil: null,
        restStartsAt: now + 30_000,
        restUntil: null,
        snoozeUsed: false,
      },
    }))
  }, { settingsKey: SETTINGS_KEY, runtimeKey: RUNTIME_KEY })

  await openFarming(page)
  const reminder = page.getByTestId('pet-rest-reminder')
  const body = reminder.locator('p')
  await expect(reminder).toBeVisible()
  await expect(body).toContainText('Focused for 50 min.')
  await expect(body).toContainText(/Pause \d+ sec for a 5 min break\./)
  const cancelButton = reminder.getByRole('button', { name: 'Cancel', exact: true })
  const snoozeButton = reminder.getByRole('button', { name: 'In 10 min', exact: true })
  const [cancelBox, snoozeBox] = await Promise.all([
    cancelButton.boundingBox(),
    snoozeButton.boundingBox(),
  ])
  expect(cancelBox).not.toBeNull()
  expect(snoozeBox).not.toBeNull()
  expect(Math.abs(cancelBox!.y - snoozeBox!.y)).toBeLessThan(1)
  expect(snoozeBox!.x).toBeGreaterThan(cancelBox!.x + cancelBox!.width)
  const renderedLines = await body.evaluate(element => {
    const style = getComputedStyle(element)
    return element.getBoundingClientRect().height / Number.parseFloat(style.lineHeight)
  })
  expect(renderedLines).toBeLessThanOrEqual(2.05)
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

test('first-use Pet setup walks from invitation to explicit style selection', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.request.post('/farming/api/settings', {
    data: { appearance: 'light', language: 'zh' },
  })
  await page.addInitScript(({ settingsKey, runtimeKey }) => {
    localStorage.removeItem(settingsKey)
    sessionStorage.removeItem(runtimeKey)
  }, { settingsKey: SETTINGS_KEY, runtimeKey: RUNTIME_KEY })

  await openFarming(page)
  const invitation = page.getByTestId('pet-rest-invitation')
  await expect(invitation).toBeVisible()
  await expect(invitation).toContainText('需要长时使用休息提醒吗？')
  await expect(invitation.getByRole('button', { name: '试用一下', exact: true })).toBeVisible()
  await expect(invitation.locator('.code-pet-close')).toBeVisible()
  await capturePetSetupStep(page, '01-invitation')

  await invitation.getByRole('button', { name: '试用一下', exact: true }).click()
  const appearanceChoice = page.getByTestId('pet-appearance-choice')
  await expect(appearanceChoice).toBeVisible()
  await expect(invitation).toHaveCount(0)
  await expect(appearanceChoice.getByRole('button', { name: /^柔光/ }))
    .toHaveAttribute('aria-pressed', 'true')
  await expect(appearanceChoice.getByRole('button', { name: /^黑洞/ }))
    .toHaveAttribute('aria-pressed', 'false')
  await expect.poll(() => page.evaluate(key => (
    JSON.parse(localStorage.getItem(key) ?? 'null')?.capabilities?.restReminder?.intervalSeconds
  ), SETTINGS_KEY)).toBe(50 * 60)
  await expect.poll(() => page.evaluate(key => (
    JSON.parse(localStorage.getItem(key) ?? 'null')?.appearance ?? null
  ), SETTINGS_KEY)).toBeNull()
  await capturePetSetupStep(page, '02-style-choice')

  await appearanceChoice.getByRole('button', { name: /^黑洞/ }).click()
  await expect(appearanceChoice).toHaveCount(0)
  await expect.poll(() => page.evaluate(key => {
    const settings = JSON.parse(localStorage.getItem(key) ?? 'null')
    return {
      intervalSeconds: settings?.capabilities?.restReminder?.intervalSeconds ?? null,
      appearance: settings?.appearance ?? null,
    }
  }, SETTINGS_KEY)).toEqual({
    intervalSeconds: 50 * 60,
    appearance: 'black-hole',
  })

  await page.getByTestId('code-sidebar-options').click()
  const settings = page.getByTestId('code-settings-panel')
  await expect(settings).toBeVisible()
  await expect(settings.getByRole('group', { name: '提醒样式' })
    .getByRole('button', { name: '黑洞', exact: true }))
    .toHaveAttribute('aria-pressed', 'true')
  await expect(settings.getByRole('slider', { name: '休息提醒' }))
    .toHaveAttribute('aria-valuetext', '每 50 分钟')
  await capturePetSetupStep(page, '03-selected-black-hole')
})

test('black-hole lifecycle changes shape within the 120 FPS GPU budget', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1200 })
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
    ;(window as Window & {
      __farmingBlackHoleElapsedSeconds?: number
      __farmingBlackHoleEvolutionSeed?: number
    }).__farmingBlackHoleEvolutionSeed = 1
    ;(window as Window & {
      __farmingBlackHoleElapsedSeconds?: number
    }).__farmingBlackHoleElapsedSeconds = 82.55
  }, { settingsKey: SETTINGS_KEY, runtimeKey: RUNTIME_KEY })

  await openFarming(page)
  const canvas = page.getByTestId('pet-rest-scene')
    .locator('.code-pet-black-hole-canvas')
  await expect(canvas).toHaveAttribute('data-intro-seconds', '15')
  await expect(canvas).toHaveAttribute('data-cycle-seconds', '90')
  const lifecycle = [
    'zen',
    'm87',
    'ember',
    'gargantua',
    'inferno',
    'quasar',
    'blazar',
    'cooling',
  ] as const
  const cycleOrder = (
    await canvas.getAttribute('data-cycle-order') ?? ''
  ).split(',')
  const nextCycleOrder = (
    await canvas.getAttribute('data-next-cycle-order') ?? ''
  ).split(',')
  const expectReasonableEvolution = (order: string[]) => {
    expect(order).toHaveLength(lifecycle.length)
    expect(new Set(order)).toEqual(new Set(lifecycle))
    expect(new Set(order.slice(0, 2))).toEqual(new Set(['zen', 'm87']))
    expect(new Set(order.slice(2, 4))).toEqual(new Set(['ember', 'gargantua']))
    expect(order[4]).toBe('inferno')
    expect(new Set(order.slice(5, 7))).toEqual(new Set(['quasar', 'blazar']))
    expect(order[7]).toBe('cooling')
  }
  expectReasonableEvolution(cycleOrder)
  expectReasonableEvolution(nextCycleOrder)
  expect(nextCycleOrder).not.toEqual(cycleOrder)
  expect(['zen', 'm87']).toContain(
    await canvas.getAttribute('data-birth-preset'),
  )
  const blazarSlot = cycleOrder.indexOf('blazar')
  const slotSeconds = 90 / lifecycle.length
  await page.evaluate(value => {
    ;(window as Window & {
      __farmingBlackHoleElapsedSeconds?: number
    }).__farmingBlackHoleElapsedSeconds = value
  }, 15 + blazarSlot * slotSeconds + 0.05)
  await expect(canvas).toHaveAttribute('data-macro-phase', 'blazar')
  await expect(canvas).toHaveAttribute('data-gpu-timer', 'sampled', {
    timeout: 5_000,
  })
  await expect.poll(() => canvas.evaluate(element => (
    (element as HTMLCanvasElement).width
  ))).toBe(1792)
  const gpuTiming = await canvas.evaluate(element => ({
    samples: Number((element as HTMLCanvasElement).dataset.gpuSamples),
    p95Ms: Number((element as HTMLCanvasElement).dataset.gpuP95Ms),
  }))
  expect(gpuTiming.samples).toBeGreaterThanOrEqual(24)
  expect(gpuTiming.p95Ms).toBeLessThan(1000 / 120)

  const observedPhases: string[] = []
  const observedTemperatures: number[] = []
  const observedInclinations: number[] = []
  const observedOuterRadii: number[] = []
  for (let slot = 0; slot < lifecycle.length; slot += 1) {
    const phase = cycleOrder[slot]!
    const elapsed = 15 + slot * slotSeconds + 0.05
    await page.evaluate(value => {
      ;(window as Window & {
        __farmingBlackHoleElapsedSeconds?: number
      }).__farmingBlackHoleElapsedSeconds = value
    }, elapsed)
    await expect(canvas).toHaveAttribute('data-macro-phase', phase)
    const preset = await canvas.evaluate(element => ({
      temperature: Number((element as HTMLCanvasElement).dataset.macroTemperature),
      inclination: Number((element as HTMLCanvasElement).dataset.macroInclination),
      outerRadius: Number((element as HTMLCanvasElement).dataset.macroOuterRadius),
    }))
    observedPhases.push(phase)
    observedTemperatures.push(preset.temperature)
    observedInclinations.push(preset.inclination)
    observedOuterRadii.push(preset.outerRadius)
  }
  expect(new Set(observedPhases)).toEqual(new Set(lifecycle))
  expect(Math.max(...observedTemperatures) - Math.min(...observedTemperatures))
    .toBeGreaterThan(14_000)
  expect(Math.max(...observedInclinations) - Math.min(...observedInclinations))
    .toBeGreaterThan(1.1)
  expect(Math.max(...observedOuterRadii) - Math.min(...observedOuterRadii))
    .toBeGreaterThan(3.5)

  for (let slot = 0; slot < nextCycleOrder.length; slot += 1) {
    const phase = nextCycleOrder[slot]!
    const elapsed = 15 + 90 + slot * slotSeconds + 0.05
    await page.evaluate(value => {
      ;(window as Window & {
        __farmingBlackHoleElapsedSeconds?: number
      }).__farmingBlackHoleElapsedSeconds = value
    }, elapsed)
    await expect(canvas).toHaveAttribute('data-macro-phase', phase)
  }
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
    .toHaveAttribute('data-evaporation-phase', 'blue-shift')
  await expect(scene.locator('.code-pet-black-hole-canvas'))
    .toHaveAttribute('data-radiation-probe', 'sampled')
  const exitCanvas = scene.locator('.code-pet-black-hole-canvas')
  await expect(exitCanvas).toHaveAttribute('data-gpu-timer', 'sampled')
  const exitGpuP95 = Number(await exitCanvas.getAttribute('data-gpu-p95-ms'))
  expect(exitGpuP95).toBeGreaterThan(0)
  expect(exitGpuP95).toBeLessThan(1000 / 120)
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
  await expect(compositor).toHaveAttribute('data-evaporation-phase', 'blue-shift')
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
  await expect(compositor).toHaveAttribute('data-evaporation-phase', 'blue-shift')
  await expect(scene).toHaveCount(0, { timeout: 16_000 })
})

test('black-hole snapshot refresh rasterizes file icons, excludes Pet UI, and keeps one renderer', async ({ page }) => {
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
  await page.evaluate(async () => {
    const icon = document.createElement('img')
    icon.className = 'code-file-type-icon'
    icon.src = '/farming/vendor/material-icons/markdown.svg'
    icon.alt = ''
    icon.dataset.testSnapshotFileIcon = ''
    Object.assign(icon.style, {
      position: 'fixed',
      left: '8px',
      top: '8px',
    })
    document.body.append(icon)
    await icon.decode()
  })
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
  await expect(compositor).toHaveAttribute('data-visible-file-icons', '1')
  await expect(compositor).toHaveAttribute('data-rasterized-file-icons', '1')
  await expect(scene).toHaveCount(1)
  await expect(scene.locator('.code-pet-black-hole-canvas')).toHaveCount(1)
  await expect(scene.locator('.code-pet-black-hole-compositor')).toHaveCount(1)

  await page.evaluate(() => {
    document.querySelector('[data-test-snapshot-file-icon]')?.remove()
  })
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

test('custom reminder minutes sit between fixed slider stops', async ({ page }) => {
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
  const slider = settings.getByRole('slider', { name: 'Break reminder' })
  const customMinutes = settings.getByRole('spinbutton', {
    name: 'Custom reminder interval in minutes',
  })

  await expect(customMinutes).toHaveValue('50')
  await expect(slider).toHaveValue('5')

  await customMinutes.fill('37')
  await expect(slider).toHaveValue('3.7')

  await slider.fill('7.4')
  await expect(customMinutes).toHaveValue('90')
  await expect(slider).toHaveValue('7')
  await expect.poll(() => page.evaluate(key => (
    JSON.parse(localStorage.getItem(key) ?? 'null')
      ?.capabilities?.restReminder?.intervalSeconds
  ), SETTINGS_KEY)).toBe(90 * 60)
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
