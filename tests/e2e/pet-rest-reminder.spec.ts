import fs from 'node:fs'
import path from 'node:path'
import {
  expect,
  openFarming,
  openNewAgentDialog,
  selectAgent,
  test,
} from './fixtures'
import type { Locator, Page, WebSocketRoute } from '@playwright/test'
import { projectFilesWorkspaceId } from '../../src/lib/project-workspaces'

const SETTINGS_KEY = 'farmingPetSettings'
const RUNTIME_KEY = 'farmingPetRestReminderRuntime'
const INVITATION_RUNTIME_KEY = 'farmingPetRestReminderInvitationRuntime'
const PET_SETUP_SCREENSHOT_DIR = process.env.FARMING_PET_SETUP_SCREENSHOT_DIR

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(settle => {
    resolve = settle
  })
  return { promise, resolve }
}

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

async function setBlackHoleElapsed(page: Page, elapsedSeconds: number, frameCount = 1) {
  await page.evaluate(async ({ value, frames }) => {
    const testWindow = window as Window & {
      __farmingBlackHoleElapsedSeconds?: number
      __farmingBlackHoleRenderFrames?: (count?: number) => Promise<void>
    }
    testWindow.__farmingBlackHoleElapsedSeconds = value
    await testWindow.__farmingBlackHoleRenderFrames?.(frames)
  }, { value: elapsedSeconds, frames: frameCount })
}

async function setBlackHoleExitProgress(page: Page, progress: number, frameCount = 1) {
  await page.evaluate(async ({ value, frames }) => {
    const testWindow = window as Window & {
      __farmingBlackHoleExitProgress?: number
      __farmingBlackHoleRenderFrames?: (count?: number) => Promise<void>
    }
    testWindow.__farmingBlackHoleExitProgress = value
    await testWindow.__farmingBlackHoleRenderFrames?.(frames)
  }, { value: progress, frames: frameCount })
}

async function renderBlackHoleFrames(page: Page, frameCount = 1) {
  await page.evaluate(async frames => {
    await (window as Window & {
      __farmingBlackHoleRenderFrames?: (count?: number) => Promise<void>
    }).__farmingBlackHoleRenderFrames?.(frames)
  }, frameCount)
}

async function settleAnimationFrames(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  }))
}

async function makeRestReminderInvitationReady(page: Page) {
  await page.addInitScript(({ invitationRuntimeKey }) => {
    sessionStorage.setItem(invitationRuntimeKey, JSON.stringify({
      version: 1,
      foregroundMs: 30 * 60_000,
      foregroundStartedAt: null,
    }))
  }, { invitationRuntimeKey: INVITATION_RUNTIME_KEY })
}

test('unconfigured reminder does not interrupt a new user on entry', async ({ page }) => {
  await openFarming(page)
  await expect(page.getByTestId('pet-rest-invitation')).toHaveCount(0)
})

test('explicit test URL can shorten the first-use invitation delay', async ({ page }) => {
  await page.goto('/farming/?petRestInvitationSeconds=1', { waitUntil: 'domcontentloaded' })
  await expect(page.getByTestId('app-shell')).toBeVisible()
  await expect(page.getByTestId('pet-rest-invitation')).toHaveCount(0)
  await expect(page.getByTestId('pet-rest-invitation')).toBeVisible({ timeout: 3_000 })
})

test('unconfigured reminder shows its invitation in narrow layouts', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await makeRestReminderInvitationReady(page)
  await openFarming(page)

  await expect(page.getByTestId('pet-rest-invitation')).toBeVisible()
  await page.getByTestId('code-mobile-menu').click()
  await expect(page.getByTestId('code-sidebar')).toBeVisible()
  await expect(page.getByTestId('pet-rest-invitation')).toBeVisible()
})

test('mobile reminder settings keep the value input clear of the slider', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.request.post('/farming/api/settings', {
    data: {
      appearance: 'light',
      language: 'zh',
      restReminderIntervalSeconds: 5,
    },
  })
  await openFarming(page)

  await page.getByTestId('code-mobile-menu').click()
  await page.getByTestId('code-sidebar-options').click()
  const settings = page.getByTestId('code-settings-panel')
  const slider = settings.getByRole('slider', { name: '休息提醒' })
  const value = settings.getByRole('spinbutton', { name: '自定义提醒间隔（分钟）' })
  await expect(value).toHaveAttribute('placeholder', '5 秒（仅用于观察效果）')
  const [sliderBox, valueBox] = await Promise.all([
    slider.boundingBox(),
    value.boundingBox(),
  ])
  expect(sliderBox).not.toBeNull()
  expect(valueBox).not.toBeNull()
  expect(valueBox!.y).toBeGreaterThanOrEqual(sliderBox!.y + sliderBox!.height)
})

test('mobile Pet preview closes navigation before capturing the scene', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.request.post('/farming/api/settings', {
    data: {
      appearance: 'dark',
      language: 'zh',
      restReminderIntervalSeconds: 50 * 60,
    },
  })
  await openFarming(page)

  await page.getByTestId('code-mobile-menu').click()
  await page.getByTestId('code-sidebar-options').click()
  const settings = page.getByTestId('code-settings-panel')
  await settings.getByRole('button', { name: '预览黑洞效果' }).click()

  await expect(page.getByTestId('code-workspace')).toHaveClass(/sidebar-collapsed/)
  await expect(page.getByTestId('code-mobile-sidebar-backdrop')).toHaveCount(0)
  await expect(page.getByTestId('pet-rest-scene'))
    .toHaveAttribute('data-pet-appearance', 'black-hole')
})

test('settings sliders stage locally and save only the released value', async ({ page }) => {
  await page.request.post('/farming/api/settings', {
    data: {
      appearance: 'light',
      language: 'zh',
      restReminderIntervalSeconds: 50 * 60,
    },
  })
  await openFarming(page)
  await page.getByTestId('code-sidebar-options').click()
  const settings = page.getByTestId('code-settings-panel')
  const slider = settings.getByRole('slider', { name: '休息提醒' })
  const writes = { reminder: 0, contentFontSize: 0, searchTimeout: 0 }
  page.on('request', request => {
    if (request.method() !== 'POST' || !request.url().endsWith('/api/settings')) return
    try {
      const body = request.postDataJSON() as {
        restReminderIntervalSeconds?: number
        codeContentFontSize?: number
        searchTimeoutMs?: number
      }
      if (body.restReminderIntervalSeconds !== undefined) writes.reminder += 1
      if (body.codeContentFontSize !== undefined) writes.contentFontSize += 1
      if (body.searchTimeoutMs !== undefined) writes.searchTimeout += 1
    } catch {
      // Ignore unrelated non-JSON requests.
    }
  })

  const dragToMaximum = async (target: Locator, whileDragging?: () => Promise<void>) => {
    await target.scrollIntoViewIfNeeded()
    const [box, range] = await Promise.all([
      target.boundingBox(),
      target.evaluate(element => {
        const input = element as HTMLInputElement
        return {
          min: Number(input.min),
          max: Number(input.max),
          value: Number(input.value),
        }
      }),
    ])
    expect(box).not.toBeNull()
    const ratio = (range.value - range.min) / (range.max - range.min)
    await page.mouse.move(
      box!.x + box!.width * ratio,
      box!.y + box!.height / 2,
    )
    await page.mouse.down()
    await page.mouse.move(
      box!.x + box!.width / 2,
      box!.y + box!.height / 2,
      { steps: 10 },
    )
    await whileDragging?.()
    await page.mouse.move(
      box!.x + box!.width - 2,
      box!.y + box!.height / 2,
      { steps: 20 },
    )
    await page.mouse.up()
  }

  await dragToMaximum(slider, async () => {
    await expect(settings.getByRole('spinbutton', { name: '自定义提醒间隔（分钟）' }))
      .toHaveValue('30')
    expect(writes.reminder).toBe(0)
  })

  await expect(settings.getByRole('spinbutton', { name: '自定义提醒间隔（分钟）' }))
    .toHaveValue('90')
  await expect.poll(() => writes.reminder).toBe(1)
  await expect.poll(async () => {
    const response = await page.request.get('/farming/api/settings')
    return (await response.json()).settings?.restReminderIntervalSeconds
  }).toBe(90 * 60)

  await dragToMaximum(settings.getByRole('slider', { name: '正文字号' }))
  await expect.poll(() => writes.contentFontSize).toBe(1)
  await expect.poll(async () => {
    const response = await page.request.get('/farming/api/settings')
    return (await response.json()).settings?.codeContentFontSize
  }).toBe(20)

  await dragToMaximum(settings.getByRole('slider', { name: '搜索超时' }))
  await expect.poll(() => writes.searchTimeout).toBe(1)
  await expect.poll(async () => {
    const response = await page.request.get('/farming/api/settings')
    return (await response.json()).settings?.searchTimeoutMs
  }).toBe(180_000)
})

test('reminder uses compact tick markers and pending restores the setup invitation', async ({ page }) => {
  await page.request.post('/farming/api/settings', {
    data: {
      appearance: 'light',
      language: 'zh',
      restReminderIntervalSeconds: 50 * 60,
    },
  })
  await openFarming(page)
  await page.getByTestId('code-sidebar-options').click()
  const settings = page.getByTestId('code-settings-panel')
  const slider = settings.getByRole('slider', { name: '休息提醒' })
  const markerTicks = settings.locator('.code-settings-pet-rest-markers span')

  await expect(markerTicks).toHaveCount(5)
  await expect(settings.locator('.code-settings-pet-rest-markers')).toHaveText('')

  await slider.focus()
  await slider.evaluate(element => {
    const input = element as HTMLInputElement
    const valueSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set
    valueSetter?.call(input, '1')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await expect(settings.getByRole('spinbutton', { name: '自定义提醒间隔（分钟）' }))
    .toHaveAttribute('placeholder', '待定')
  await expect(slider).toHaveAttribute('aria-valuetext', '待定')
  await slider.dispatchEvent('pointerup')
  await expect.poll(async () => {
    const response = await page.request.get('/farming/api/settings')
    return (await response.json()).settings?.restReminderIntervalSeconds
  }).toBeNull()
  await expect.poll(() => page.evaluate(key => (
    JSON.parse(localStorage.getItem(key) ?? 'null')
      ?.capabilities?.restReminder?.intervalSeconds ?? null
  ), SETTINGS_KEY)).toBeNull()

  await settings.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(page.getByTestId('pet-rest-invitation')).toBeVisible()
  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(page.getByTestId('app-shell')).toBeVisible()
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
  await expect(body).toContainText('Farming has been active for 50 min.')
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
  await makeRestReminderInvitationReady(page)
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
  await page.addInitScript(({ settingsKey, runtimeKey, invitationRuntimeKey }) => {
    localStorage.removeItem(settingsKey)
    sessionStorage.removeItem(runtimeKey)
    sessionStorage.setItem(invitationRuntimeKey, JSON.stringify({
      version: 1,
      foregroundMs: 30 * 60_000,
      foregroundStartedAt: null,
    }))
  }, {
    settingsKey: SETTINGS_KEY,
    runtimeKey: RUNTIME_KEY,
    invitationRuntimeKey: INVITATION_RUNTIME_KEY,
  })
  const firstSettingsMutation = deferred()
  let holdFirstSettingsMutation = true
  let heldSettingsMutation = false
  await page.route('**/farming/api/settings', async route => {
    if (route.request().method() !== 'POST') {
      await route.continue()
      return
    }
    if (holdFirstSettingsMutation) {
      holdFirstSettingsMutation = false
      heldSettingsMutation = true
      await firstSettingsMutation.promise
    }
    await route.continue()
  })

  await openFarming(page)
  const invitation = page.getByTestId('pet-rest-invitation')
  await expect(invitation).toBeVisible()
  await expect(invitation).toContainText('需要长时使用休息提醒吗？')
  await expect(invitation.getByRole('button', { name: '试用一下', exact: true })).toBeVisible()
  await expect(invitation.locator('.code-pet-close')).toBeVisible()
  await capturePetSetupStep(page, '01-invitation')

  await invitation.getByRole('button', { name: '试用一下', exact: true }).click()
  const appearanceChoice = page.getByTestId('pet-appearance-choice')
  await expect.poll(() => heldSettingsMutation).toBe(true)
  await expect(appearanceChoice).toBeVisible({ timeout: 500 })
  await expect(invitation).toHaveCount(0)
  await expect(appearanceChoice.getByRole('button', { name: /^柔光/ }))
    .toHaveAttribute('aria-pressed', 'true')
  await expect(appearanceChoice.getByRole('button', { name: /^黑洞/ }))
    .toHaveAttribute('aria-pressed', 'false')
  const softGlowPreviewButton = appearanceChoice.getByRole('button', { name: '预览柔光效果' })
  await expect(softGlowPreviewButton).toHaveText('')
  await expect(softGlowPreviewButton.locator('svg')).toHaveCount(1)
  await expect.poll(() => page.evaluate(key => (
    JSON.parse(localStorage.getItem(key) ?? 'null')?.appearance ?? null
  ), SETTINGS_KEY)).toBeNull()
  firstSettingsMutation.resolve()
  await expect.poll(() => page.evaluate(key => (
    JSON.parse(localStorage.getItem(key) ?? 'null')?.capabilities?.restReminder?.intervalSeconds
  ), SETTINGS_KEY)).toBe(50 * 60)
  const blackHoleIconAnimation = await appearanceChoice
    .locator('.code-pet-appearance-icon.black-hole')
    .evaluate(element => {
      const style = getComputedStyle(element, '::before')
      return { name: style.animationName, state: style.animationPlayState }
    })
  expect(blackHoleIconAnimation).toEqual({
    name: 'code-pet-black-hole-disk-flow',
    state: 'running',
  })
  const blackHoleIcon = appearanceChoice.locator('.code-pet-appearance-icon.black-hole')
  const idleSpinDuration = await blackHoleIcon.evaluate(element => (
    getComputedStyle(element, '::before').animationDuration
  ))
  await appearanceChoice.getByRole('button', { name: /^黑洞/ }).hover()
  await expect.poll(() => blackHoleIcon.evaluate(element => (
    getComputedStyle(element, '::before').animationDuration
  ))).toBe(idleSpinDuration)
  await appearanceChoice.getByRole('button', { name: '预览柔光效果' }).click()
  const preview = page.getByTestId('pet-rest-scene')
  await expect(preview).toHaveAttribute('data-pet-appearance', 'glass')
  await expect(preview).toContainText('休息一下')
  await expect(preview).toContainText('让眼睛和注意力暂停片刻。')
  await preview.getByRole('button', { name: '结束休息' }).click()
  await expect(preview).toHaveCount(0)
  await expect(appearanceChoice).toBeVisible()
  await expect.poll(() => page.evaluate(key => (
    JSON.parse(localStorage.getItem(key) ?? 'null')?.appearance ?? null
  ), SETTINGS_KEY)).toBeNull()
  await capturePetSetupStep(page, '02-style-choice')

  await appearanceChoice.getByRole('button', { name: /^黑洞/ }).click()
  await expect(appearanceChoice).toHaveCount(0)
  const setupSuccess = page.getByTestId('pet-setup-success')
  await expect(setupSuccess).toBeVisible()
  await expect(setupSuccess).toContainText('休息提醒已设置为黑洞样式')
  await expect(setupSuccess.locator('svg')).toHaveCount(1)
  await capturePetSetupStep(page, '03-setup-success')
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
  await expect(setupSuccess).toHaveCount(0, { timeout: 4_000 })

  await page.getByTestId('code-sidebar-options').click()
  const settings = page.getByTestId('code-settings-panel')
  await expect(settings).toBeVisible()
  await expect(settings.getByRole('group', { name: '提醒样式' })
    .getByRole('button', { name: '黑洞', exact: true }))
    .toHaveAttribute('aria-pressed', 'true')
  await expect(settings.getByRole('button', { name: '预览柔光效果' })).toBeVisible()
  await expect(settings.getByRole('button', { name: '预览黑洞效果' })).toBeVisible()
  await settings.getByRole('button', { name: '预览柔光效果' }).click()
  await expect(settings).toHaveCount(0)
  const settingsPreview = page.getByTestId('pet-rest-scene')
  await expect(settingsPreview).toHaveAttribute('data-pet-appearance', 'glass')
  await expect(settingsPreview).toContainText('休息一下')
  await expect(settingsPreview).toContainText('让眼睛和注意力暂停片刻。')
  await settingsPreview.getByRole('button', { name: '结束休息' }).click()
  await expect(settingsPreview).toHaveCount(0)
  await expect(settings).toBeVisible()
  await expect(settings.getByRole('slider', { name: '休息提醒' }))
    .toHaveAttribute('aria-valuetext', '每 50 分钟')

  await page.clock.install()
  await settings.getByRole('button', { name: '预览黑洞效果' }).click()
  await expect(settings).toHaveCount(0)
  await expect(settingsPreview).toHaveAttribute('data-pet-appearance', 'black-hole')
  await expect(settingsPreview.locator('.code-pet-black-hole-canvas'))
    .not.toHaveAttribute('data-showcase-preset', 'gargantua')
  await expect(settingsPreview.locator('.code-pet-black-hole-canvas'))
    .toHaveAttribute('data-macro-phase', 'birth')
  await expect(settingsPreview).toContainText('休息中')
  const lightEndBreak = settingsPreview.getByRole('button', { name: '结束休息' })
  await expect(lightEndBreak).toBeVisible()
  await expect(lightEndBreak).toHaveCSS('border-color', 'rgba(31, 35, 40, 0.12)')
  await expect(lightEndBreak).toHaveCSS('color', 'rgba(27, 35, 31, 0.92)')
  await lightEndBreak.hover()
  await expect(lightEndBreak).toHaveCSS('color', 'rgba(27, 35, 31, 0.92)')
  await expect(settingsPreview.locator('.code-pet-black-hole-canvas'))
    .toHaveAttribute('data-birth-preset', 'gargantua')
  await page.clock.fastForward(4 * 60_000 + 1)
  await expect(settingsPreview).toBeVisible()
  await page.clock.fastForward(60_000)
  await expect(settingsPreview).toHaveCount(0)
  await expect(settings).toBeVisible()
  await capturePetSetupStep(page, '03-selected-black-hole')
})

test('black-hole lifecycle stays fluid across every macro phase', async ({ page }) => {
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
  await expect(canvas).toHaveAttribute('data-home-attraction', '0.0000')
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
  expect(cycleOrder).toHaveLength(lifecycle.length)
  expect(new Set(cycleOrder)).toEqual(new Set(lifecycle))
  expect(cycleOrder[0]).toBe('gargantua')
  expect(new Set(cycleOrder.slice(1, 3))).toEqual(new Set(['zen', 'm87']))
  expect(cycleOrder[3]).toBe('ember')
  expect(cycleOrder[4]).toBe('inferno')
  expect(new Set(cycleOrder.slice(5, 7))).toEqual(new Set(['quasar', 'blazar']))
  expect(cycleOrder[7]).toBe('cooling')
  expectReasonableEvolution(nextCycleOrder)
  expect(nextCycleOrder).not.toEqual(cycleOrder)
  expect(await canvas.getAttribute('data-birth-preset')).toBe('gargantua')
  await setBlackHoleElapsed(page, 15.05)
  await expect(canvas).toHaveAttribute('data-macro-phase', 'gargantua')
  const blazarSlot = cycleOrder.indexOf('blazar')
  const slotSeconds = 90 / lifecycle.length
  await setBlackHoleElapsed(page, 15 + blazarSlot * slotSeconds + 0.05)
  await expect(canvas).toHaveAttribute('data-macro-phase', 'blazar')
  await expect.poll(() => canvas.getAttribute('data-gpu-timer'), {
    timeout: 5_000,
  }).toMatch(/^(sampled|unavailable)$/)
  const gpuTimerState = await canvas.getAttribute('data-gpu-timer')
  await expect.poll(() => canvas.evaluate(element => (
    (element as HTMLCanvasElement).width
  ))).toBe(1792)
  if (gpuTimerState === 'sampled') {
    const gpuTiming = await canvas.evaluate(element => ({
      samples: Number((element as HTMLCanvasElement).dataset.gpuSamples),
      p95Ms: Number((element as HTMLCanvasElement).dataset.gpuP95Ms),
    }))
    expect(gpuTiming.samples).toBeGreaterThanOrEqual(24)
    // This timer is a regression guard, not a promised display refresh rate.
    expect(gpuTiming.p95Ms).toBeLessThan(12.5)
  }

  const observedPhases: string[] = []
  const observedTemperatures: number[] = []
  const observedInclinations: number[] = []
  const observedOuterRadii: number[] = []
  for (let slot = 0; slot < lifecycle.length; slot += 1) {
    const phase = cycleOrder[slot]!
    const elapsed = 15 + slot * slotSeconds + 0.05
    await setBlackHoleElapsed(page, elapsed)
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
    await setBlackHoleElapsed(page, elapsed)
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
  const compositor = scene.locator('.code-pet-black-hole-compositor')
  await expect(compositor).toHaveAttribute('data-refresh-state', 'idle')
  const captureState = {
    luminance: Number(await compositor.getAttribute('data-corner-luminance')),
    background: await compositor.getAttribute('data-cloned-body-background'),
    engine: await compositor.getAttribute('data-capture-engine'),
    scale: Number(await compositor.getAttribute('data-capture-scale')),
    sampling: await compositor.getAttribute('data-scene-sampling'),
    captureWidth: Number(await compositor.getAttribute('data-capture-width')),
    captureHeight: Number(await compositor.getAttribute('data-capture-height')),
    backing: await compositor.evaluate(element => ({
      width: (element as HTMLCanvasElement).width,
      height: (element as HTMLCanvasElement).height,
    })),
  }
  expect(captureState.background).toBe('rgb(24, 24, 24)')
  expect(captureState.engine).toBe('snapdom')
  expect(captureState.scale).toBeGreaterThanOrEqual(1)
  expect(captureState.scale).toBeLessThanOrEqual(2)
  expect(captureState.sampling).toBe('single-sample-gradient-filtered-lens')
  expect(captureState.backing).toEqual({
    width: captureState.captureWidth,
    height: captureState.captureHeight,
  })
  expect(captureState.luminance).toBeLessThan(80)
  await expect(scene.locator('.code-pet-black-hole-canvas'))
    .toHaveAttribute('data-filament-sampling', 'cartesian-value-noise')
  await expect(compositor)
    .toHaveAttribute('data-scene-composition', 'single-refracted-sample')
  await expect(label).toHaveCSS('color', 'rgba(226, 235, 229, 0.82)')
  await expect(clock).toHaveCSS('color', 'rgb(231, 238, 233)')
  await expect(endBreak).toHaveCSS('color', 'rgba(238, 245, 240, 0.9)')

  await endBreak.click()
  await expect(scene).toHaveClass(/exiting/)
  await setBlackHoleExitProgress(page, 0.55, 30)
  await expect(compositor).toHaveAttribute('data-exit-progress', '0.5500')
  await expect(scene.locator('.code-pet-black-hole-compositor'))
    .toHaveAttribute('data-evaporation-phase', 'blue-shift')
  const midEvaporation = await compositor.evaluate(element => ({
    diskFeed: Number(element.getAttribute('data-disk-feed')),
    bodyOpacity: Number(element.getAttribute('data-body-opacity')),
    lensOpacity: Number(element.getAttribute('data-lens-opacity')),
  }))
  expect(midEvaporation.diskFeed).toBeGreaterThan(0.45)
  expect(midEvaporation.diskFeed).toBeLessThan(0.85)
  expect(midEvaporation.bodyOpacity).toBeGreaterThan(0.6)
  expect(midEvaporation.bodyOpacity).toBeLessThan(0.9)
  expect(midEvaporation.lensOpacity).toBeGreaterThan(0.25)
  expect(midEvaporation.lensOpacity).toBeLessThan(0.65)
  await expect(scene.locator('.code-pet-black-hole-canvas'))
    .toHaveAttribute('data-radiation-probe', 'sampled')
  const exitCanvas = scene.locator('.code-pet-black-hole-canvas')
  await expect.poll(() => exitCanvas.getAttribute('data-gpu-timer'))
    .toMatch(/^(sampled|unavailable)$/)
  const exitGpuTimerState = await exitCanvas.getAttribute('data-gpu-timer')
  if (exitGpuTimerState === 'sampled') {
    const exitGpuP95 = Number(await exitCanvas.getAttribute('data-gpu-p95-ms'))
    expect(exitGpuP95).toBeGreaterThan(0)
    expect(exitGpuP95).toBeLessThan(1000 / 120)
  }
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
  await setBlackHoleExitProgress(page, 1)
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
  await expect(clock).toBeVisible()
  await expect(body).toBeVisible()
  await expect(endBreak).toBeVisible()
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
    await settleAnimationFrames(page)
    const before = await clock.getAttribute('aria-label') ?? await clock.textContent()
    // This is the product's paused-clock interval, not a UI-settle delay.
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
    if (appearance === 'black-hole') {
      await expect(scene).toHaveClass(/exiting/)
      await setBlackHoleExitProgress(page, 1)
    }
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
  await expect(scene).toHaveClass(/exiting/)
  await setBlackHoleExitProgress(page, 1)
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
  const connectionStatus = page.getByTestId('connection-status')
  await expect(connectionStatus).toBeVisible()
  await expect(connectionStatus).toHaveClass(/connecting/)
  await expect(connectionStatus).toContainText('Loading')
  await expect.poll(async () => (
    await clock.getAttribute('aria-label') ?? await clock.textContent()
  )).not.toBe(beforeDisconnect)
  await expect(scene).toHaveCount(1)
  await expect(scene.locator('.code-pet-black-hole-compositor')).toHaveCount(1)
  await expect(scene.locator('.code-pet-black-hole-canvas')).toHaveCount(1)

  outage = false
  await expect(page.getByTestId('connection-status')).toHaveCount(0, { timeout: 7_000 })
  await expect(scene).toHaveCount(1)
  await expect(scene.locator('.code-pet-black-hole-canvas')).toHaveCount(1)
  await scene.getByRole('button', { name: 'End break' }).click()
  await expect(scene).toHaveClass(/exiting/)
  await setBlackHoleExitProgress(page, 1)
  await expect(scene).toHaveCount(0, { timeout: 7_000 })
})

test('an action attempted during reconnect uses a neutral recoverable notice', async ({ page, workspaceRoot }) => {
  let outage = false
  let activeSocket: WebSocketRoute | null = null
  await page.routeWebSocket(/\/farming\/ws(?:\?|$)/, async socket => {
    if (outage) {
      await socket.close({ code: 1012, reason: 'Recoverable notice regression' })
      return
    }
    activeSocket = socket
    socket.connectToServer()
  })

  await openFarming(page)
  await openNewAgentDialog(page)
  await selectAgent(page, 'bash')
  await page.getByTestId('workspace-input').fill(workspaceRoot)
  await expect.poll(() => Boolean(activeSocket)).toBe(true)

  outage = true
  await activeSocket?.close({ code: 1012, reason: 'Recoverable notice regression' })
  await expect(page.getByTestId('connection-status')).toHaveClass(/connecting/)
  await page.getByTestId('workspace-start').click()

  const notice = page.getByTestId('app-toast')
  await expect(notice).toHaveClass(/recovering/)
  await expect(notice).not.toHaveClass(/error/)
  await expect(notice).toContainText('Still reconnecting')

  outage = false
  await expect(page.getByTestId('connection-status')).toHaveCount(0, { timeout: 7_000 })
})

test('reports a failed business probe without calling the WebSocket disconnected', async ({ page }) => {
  let dropBusinessHealth = true
  await page.routeWebSocket(/\/farming\/ws(?:\?|$)/, socket => {
    const server = socket.connectToServer()
    server.onMessage(message => {
      try {
        const parsed = JSON.parse(String(message)) as { type?: string }
        if (dropBusinessHealth && parsed.type === 'business-health-result') return
      } catch {
        // Non-JSON protocol frames remain part of the live connection.
      }
      socket.send(message)
    })
  })

  await openFarming(page)
  const status = page.getByTestId('connection-status')
  await expect(status).toHaveClass(/business-unavailable/, { timeout: 12_000 })
  await expect(status).not.toHaveClass(/connecting|lost/)
  await expect(status).toContainText('business state is not responding')

  dropBusinessHealth = false
  await expect(status).toHaveCount(0, { timeout: 8_000 })
  await expect(page.getByTestId('app-shell')).toBeVisible()
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
    ;(window as Window & {
      __farmingBlackHoleElapsedSeconds?: number
    }).__farmingBlackHoleElapsedSeconds = 82.55
  }, { settingsKey: SETTINGS_KEY, runtimeKey: RUNTIME_KEY })

  await openFarming(page)
  const scene = page.getByTestId('pet-rest-scene')
  const compositor = scene.locator('.code-pet-black-hole-compositor')
  const canvas = scene.locator('.code-pet-black-hole-canvas')
  await expect(scene).toHaveClass(/exiting/)
  await renderBlackHoleFrames(page)
  await expect.poll(async () => Number(
    await canvas.getAttribute('data-home-attraction') ?? '0',
  )).toBeGreaterThan(0.85)
  const homeDistanceRatio = await canvas.evaluate(element => {
    const home = document.querySelector('.code-product-mark')
      ?? document.querySelector('.code-product-pet-anchor')
    if (!home) return Number.POSITIVE_INFINITY
    const canvasRect = element.getBoundingClientRect()
    const homeRect = home.getBoundingClientRect()
    const distance = Math.hypot(
      canvasRect.left + canvasRect.width / 2 - (homeRect.left + homeRect.width / 2),
      canvasRect.top + canvasRect.height / 2 - (homeRect.top + homeRect.height / 2),
    )
    return distance / Math.hypot(window.innerWidth, window.innerHeight)
  })
  expect(homeDistanceRatio).toBeLessThan(0.12)
  // The real elapsed phase boundary is the behavior under test here: the
  // compositor must advance from disk-quench into blue-shift over wall time.
  await page.waitForTimeout(700)
  await renderBlackHoleFrames(page)
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
  await settleAnimationFrames(page)
  const progressBeforeHide = Number(
    await compositor.getAttribute('data-exit-progress') ?? '0',
  )
  // Hidden time must not advance the compositor's absolute-time progress.
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
  await renderBlackHoleFrames(page)
  await expect.poll(async () => Number(
    await compositor.getAttribute('data-exit-progress') ?? '0',
  )).toBeGreaterThan(progressBeforeHide + 0.05)
  await expect(compositor).toHaveAttribute('data-evaporation-phase', 'blue-shift')
  await setBlackHoleExitProgress(page, 1)
  await expect(scene).toHaveCount(0, { timeout: 16_000 })
})

test('black-hole waits for its initial snapshot and refreshes after a resize', async ({ page }) => {
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
    ;(window as Window & {
      __farmingBlackHoleCaptureDelayMs?: number
    }).__farmingBlackHoleCaptureDelayMs = 750
  }, { settingsKey: SETTINGS_KEY, runtimeKey: RUNTIME_KEY })

  await openFarming(page)
  const scene = page.getByTestId('pet-rest-scene')
  const compositor = scene.locator('.code-pet-black-hole-compositor')
  const canvas = scene.locator('.code-pet-black-hole-canvas')
  await expect(compositor).toHaveAttribute('data-refresh-state', 'initial-capturing')
  await expect(canvas).toHaveCSS('opacity', '0')
  await expect(canvas).not.toHaveAttribute('data-macro-phase')
  await expect(scene).toHaveCount(1)
  await expect(scene.locator('.code-pet-black-hole-compositor')).toHaveCount(1)
  await expect(scene.locator('.code-pet-black-hole-canvas')).toHaveCount(1)
  await expect(scene.locator('.code-pet-black-hole-status')).toHaveCount(1)
  await expect(scene.locator('.code-pet-black-hole-error')).toHaveCount(0)
  await expect(compositor).toHaveAttribute('data-refresh-state', 'idle')
  await expect(compositor).toHaveAttribute('data-capture-engine', 'snapdom')
  await expect(compositor).toHaveAttribute(
    'data-scene-sampling',
    'single-sample-gradient-filtered-lens',
  )
  await expect(compositor)
    .toHaveAttribute('data-scene-composition', 'single-refracted-sample')

  const initialGeneration = Number(
    await compositor.getAttribute('data-scene-generation') ?? '0',
  )
  expect(initialGeneration).toBe(1)
  await renderBlackHoleFrames(page)
  const positionBeforeResize = await canvas.evaluate(element => {
    const rect = element.getBoundingClientRect()
    return {
      x: (rect.left + rect.width / 2) / window.innerWidth,
      y: (rect.top + rect.height / 2) / window.innerHeight,
    }
  })
  await page.setViewportSize({ width: 1280, height: 840 })
  await expect(compositor).toHaveAttribute('data-refresh-state', 'resize-wait')
  await expect(canvas).toHaveCSS('opacity', '0')
  await expect(compositor).toHaveAttribute('data-scene-generation', '2', {
    timeout: 15_000,
  })
  await expect(compositor).toHaveAttribute('data-refresh-state', 'idle')
  await renderBlackHoleFrames(page)
  const positionAfterResize = await canvas.evaluate(element => {
    const rect = element.getBoundingClientRect()
    return {
      x: (rect.left + rect.width / 2) / window.innerWidth,
      y: (rect.top + rect.height / 2) / window.innerHeight,
    }
  })
  expect(positionAfterResize.x).toBeCloseTo(positionBeforeResize.x, 1)
  expect(positionAfterResize.y).toBeCloseTo(positionBeforeResize.y, 1)
  expect(Number(
    await compositor.getAttribute('data-scene-generation') ?? '0',
  )).toBe(2)
  await expect(compositor).toHaveAttribute('data-remaining-pet-elements', '0')
  await expect(scene).toHaveCount(1)
  await expect(scene.locator('.code-pet-black-hole-canvas')).toHaveCount(1)
  await expect(scene.locator('.code-pet-black-hole-compositor')).toHaveCount(1)

  await scene.getByRole('button', { name: 'End break' }).click()
  await expect(scene).toHaveClass(/exiting/)
  await setBlackHoleExitProgress(page, 1)
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
  await expect(scene).toHaveClass(/exiting/)
  await setBlackHoleExitProgress(page, 1)
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
  await setBlackHoleExitProgress(page, 1)
  await expect(scene).toHaveCount(0, { timeout: 7_000 })
})

test('closing the first-use invitation defers the choice until reload', async ({ page }) => {
  await makeRestReminderInvitationReady(page)
  await openFarming(page)

  const invitation = page.getByTestId('pet-rest-invitation')
  await expect(invitation).toBeVisible()
  await invitation.locator('.code-pet-close').click()
  await expect(invitation).toBeHidden()

  const settingsResponse = await page.request.get('/farming/api/settings')
  const settingsData = await settingsResponse.json() as {
    settings?: { restReminderIntervalSeconds?: number | null }
  }
  expect(settingsData.settings?.restReminderIntervalSeconds).toBeNull()

  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(page.getByTestId('app-shell')).toBeVisible()
  await expect(page.getByTestId('pet-rest-invitation')).toBeVisible()
})

test('choosing not to use reminders persists the reminder as off', async ({ page }) => {
  await makeRestReminderInvitationReady(page)
  await openFarming(page)

  const invitation = page.getByTestId('pet-rest-invitation')
  await expect(invitation).toBeVisible()
  await invitation.getByRole('button', { name: 'Don’t use reminders', exact: true }).click()
  await expect(invitation).toHaveCount(0)

  await expect.poll(async () => {
    const response = await page.request.get('/farming/api/settings')
    const data = await response.json() as {
      settings?: { restReminderIntervalSeconds?: number | null }
    }
    return data.settings?.restReminderIntervalSeconds
  }).toBe(0)
  await expect.poll(() => page.evaluate(key => (
    JSON.parse(localStorage.getItem(key) ?? 'null')
      ?.capabilities?.restReminder?.intervalSeconds
  ), SETTINGS_KEY)).toBe(0)

  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(page.getByTestId('app-shell')).toBeVisible()
  await expect(page.getByTestId('pet-rest-invitation')).toHaveCount(0)
})

test('closing a due reminder cancels only the current break', async ({ page }) => {
  await page.request.post('/farming/api/settings', {
    data: { restReminderIntervalSeconds: 60 },
  })
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
        phase: 'due',
        intervalSeconds: 60,
        cycleStartedAt: now - 60_000,
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
  await expect(reminder).toBeVisible()
  await reminder.locator('.code-pet-close').click()
  await expect(reminder).toHaveCount(0)

  const response = await page.request.get('/farming/api/settings')
  const data = await response.json() as {
    settings?: { restReminderIntervalSeconds?: number | null }
  }
  expect(data.settings?.restReminderIntervalSeconds).toBe(60)
})

test('an overdue Browser click starts a fresh rest-entry countdown', async ({
  page,
  workspaceRoot,
}) => {
  const workspace = path.join(workspaceRoot, 'pet-overdue-browser-click')
  fs.mkdirSync(workspace, { recursive: true })
  const settingsResponse = await page.request.post('/farming/api/settings', {
    data: {
      browserExtensionEnabled: true,
      restReminderIntervalSeconds: 60,
    },
  })
  expect(settingsResponse.ok()).toBeTruthy()
  const mountResponse = await page.request.post('/farming/api/projects/mount', {
    data: { workspace },
  })
  expect(mountResponse.ok()).toBeTruthy()
  const browserResponse = await page.request.post('/farming/api/browsers', {
    data: { rootId: projectFilesWorkspaceId(workspace) },
  })
  expect(browserResponse.ok()).toBeTruthy()

  await page.addInitScript(({ settingsKey, runtimeKey }) => {
    const now = Date.now()
    localStorage.setItem(settingsKey, JSON.stringify({
      version: 1,
      appearance: 'glass',
      capabilities: { restReminder: { intervalSeconds: 60 } },
    }))
    sessionStorage.setItem(runtimeKey, JSON.stringify({
      version: 2,
      state: {
        phase: 'working',
        intervalSeconds: 60,
        cycleStartedAt: now,
        backgroundedAt: null,
        snoozedUntil: null,
        restStartsAt: null,
        restUntil: null,
        snoozeUsed: false,
      },
    }))
  }, { settingsKey: SETTINGS_KEY, runtimeKey: RUNTIME_KEY })

  await openFarming(page)
  const project = page.getByTestId('code-project-group').filter({
    hasText: path.basename(workspace),
  })
  const browserRow = project.getByTestId('farming-browser-row')
  await expect(browserRow).toBeVisible()

  const interactionAt = await page.evaluate(() => {
    const overdueNow = Date.now() + 4 * 60_000
    Date.now = () => overdueNow
    return overdueNow
  })
  await browserRow.click()
  await expect(page.getByTestId('pet-rest-reminder')).toBeVisible({ timeout: 3_000 })

  const runtime = await page.evaluate(runtimeKey => (
    JSON.parse(sessionStorage.getItem(runtimeKey) ?? 'null')?.state
  ), RUNTIME_KEY)
  expect(runtime.phase).toBe('due')
  expect(runtime.restStartsAt).toBe(interactionAt + 30_000)
  expect(runtime.restUntil).toBeNull()
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
    .getByRole('button', { name: 'Black hole', exact: true })
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
  expect(restored.cycleStartedAt).toBeGreaterThanOrEqual(originalCycleStartedAt)
  expect(restored.cycleStartedAt - originalCycleStartedAt).toBeLessThan(5_000)
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
  await expect(slider).toHaveValue('6')

  await customMinutes.fill('37')
  await expect(slider).toHaveValue('4.7')

  await slider.fill('8')
  await slider.blur()
  await expect(customMinutes).toHaveValue('90')
  await expect(slider).toHaveValue('8')
  await expect.poll(() => page.evaluate(key => (
    JSON.parse(localStorage.getItem(key) ?? 'null')
      ?.capabilities?.restReminder?.intervalSeconds
  ), SETTINGS_KEY)).toBe(90 * 60)
})

test('Settings blocks rest entry and closing it starts a fresh entry countdown', async ({ page }) => {
  test.slow()
  await page.clock.install()
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

  await page.clock.fastForward(20_000)
  await expect(page.getByTestId('pet-rest-scene')).toHaveCount(0)
  await expect(page.getByTestId('pet-rest-reminder')).toHaveCount(0)
  await expect(closeSettings).toBeVisible()
  await expect(closeSettings).toBeEnabled()
  expect(await page.locator('#root').evaluate(element => (element as HTMLElement).inert))
    .toBe(false)

  const closedAt = await page.evaluate(() => Date.now())
  await closeSettings.click()
  const reminder = page.getByTestId('pet-rest-reminder')
  await expect(reminder).toBeVisible()
  await expect(page.getByTestId('pet-rest-scene')).toHaveCount(0)
  const restStartsAt = await page.evaluate(key => (
    JSON.parse(sessionStorage.getItem(key) ?? 'null')?.state?.restStartsAt
  ), RUNTIME_KEY)
  expect(restStartsAt).toBeGreaterThanOrEqual(closedAt + 29_000)

  const scene = page.getByTestId('pet-rest-scene')
  await page.clock.fastForward(30_000)
  await expect(scene).toBeVisible()
  await scene.getByRole('button', { name: 'End break' }).click()
  await expect(scene).toHaveCount(0)
})

test('input bursts extend a due countdown at most once per second', async ({ page }) => {
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
