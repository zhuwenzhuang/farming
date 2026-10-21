import type { Page } from '@playwright/test'
import { expect, openFarming, test } from './fixtures'

const readOnlyUrl = 'https://share.example.test/farming/s/read-only-demo'

declare global {
  interface Window {
    __shareCopyTest: {
      mode: 'denied' | 'success' | 'pending'
      writes: Array<{ text: string; active: boolean }>
      fallbackCalls: number
      finish?: () => void
    }
  }
}

async function prepareShare(page: Page, options: { missingClipboard?: boolean; delay?: Promise<void>; language?: 'en' | 'zh' } = {}) {
  let requests = 0
  await page.addInitScript(({ missingClipboard }) => {
    window.__shareCopyTest = { mode: 'denied', writes: [], fallbackCalls: 0 }
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: missingClipboard ? undefined : {
      writeText: async (text: string) => {
        const state = window.__shareCopyTest
        state.writes.push({ text, active: navigator.userActivation.isActive })
        if (state.mode === 'pending') await new Promise<void>((_, reject) => {
          state.finish = () => reject(new DOMException('Clipboard denied', 'NotAllowedError'))
        })
        if (state.mode === 'denied') throw new DOMException('Clipboard denied', 'NotAllowedError')
      },
    } })
    document.execCommand = () => { window.__shareCopyTest.fallbackCalls += 1; return false }
  }, { missingClipboard: options.missingClipboard ?? false })
  await page.route('**/api/share/qr-ticket**', async route => {
    if (route.request().method() === 'DELETE') {
      await route.fulfill({ json: { revoked: true } })
      return
    }
    requests += 1
    await options.delay
    await route.fulfill({ json: {
      code: `CLIPBOARD${requests}`,
      expiresAt: Date.now() + 300_000,
      readOnlyExpiresAt: Date.UTC(2030, 0, 1),
      ttlMs: 300_000,
      shortPath: `/j/CLIPBOARD${requests}`,
      shortUrl: `https://share.example.test/j/CLIPBOARD${requests}`,
      readOnlyUrl,
      fullAccessUrl: 'https://share.example.test/farming/?token=owner-demo',
      shortUrlAccessMode: 'owner',
      longUrlAccessMode: 'read-only',
      tokenLabel: '春风轻拂柳-细雨静落庭前树-一枝梅初开',
    } })
  })
  await page.setViewportSize({ width: 1100, height: 900 })
  await page.request.post('/farming/api/settings', { data: { language: options.language ?? 'en' } })
  await openFarming(page)
  return () => requests
}

test('retains a manually selectable read-only link and retries in the click gesture after a delayed response', async ({ page }) => {
  let release: () => void = () => {}
  const delay = new Promise<void>(resolve => { release = resolve })
  const requests = await prepareShare(page, { delay })
  try {
    await page.getByTestId('code-share-button').click()
    await expect.poll(requests).toBe(1)
    await expect(page.getByTestId('code-share-read-only-url')).toHaveCount(0)
  } finally {
    release()
  }
  const status = page.getByTestId('code-share-copy-status')
  await expect(status).toHaveAttribute('data-copy-state', 'failed')
  await expect(status).toContainText('Link ready. Copy failed')
  await expect(status).not.toContainText('read-only link copied')
  const url = page.getByTestId('code-share-read-only-url')
  await expect(url).toHaveValue(readOnlyUrl)
  await url.focus()
  expect(await url.evaluate((element: HTMLInputElement) => element.value.slice(element.selectionStart!, element.selectionEnd!))).toBe(readOnlyUrl)
  await page.evaluate(() => { window.__shareCopyTest.mode = 'success' })
  await page.getByTestId('code-share-copy-read-only').focus()
  await page.keyboard.press('Enter')
  await expect(status).toHaveAttribute('data-copy-state', 'copied')
  await expect(status).toContainText('Current page read-only link copied')
  await expect(status).not.toContainText('Copy failed')
  expect(requests()).toBe(1)
  expect(await page.evaluate(() => window.__shareCopyTest.writes.at(-1))).toEqual({ text: readOnlyUrl, active: true })
})

test('keeps copy recovery usable without Clipboard API in every appearance and a short viewport', async ({ page }) => {
  await prepareShare(page, { missingClipboard: true, language: 'zh' })
  await page.getByTestId('code-share-button').click()
  const status = page.getByTestId('code-share-copy-status')
  await expect(status).toHaveAttribute('data-copy-state', 'failed')
  const popover = page.getByTestId('code-share-popover')
  await expect(popover.locator('svg[aria-label="QR code"]')).toBeVisible()
  await page.addStyleTag({ content: '.code-share-countdown { visibility: hidden !important; }' })
  for (const appearance of ['light', 'dark', 'paper']) {
    await page.evaluate(value => {
      document.documentElement.dataset.appearance = value
      document.body.dataset.appearance = value
    }, appearance)
    await expect(popover).toHaveScreenshot(`share-copy-recovery-${appearance}.png`, { animations: 'disabled' })
  }
  await page.setViewportSize({ width: 1100, height: 480 })
  const url = page.getByTestId('code-share-read-only-url')
  await url.click()
  expect(await url.evaluate((element: HTMLInputElement) => element.selectionEnd! - element.selectionStart!)).toBe(readOnlyUrl.length)
  await page.getByTestId('code-share-copy-read-only').click()
  await expect(status).toHaveAttribute('data-copy-state', 'failed')
  const bounds = await popover.boundingBox()
  expect(bounds!.y).toBeGreaterThanOrEqual(8)
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(472)
  expect(await page.evaluate(() => window.__shareCopyTest.fallbackCalls)).toBe(2)
})

test('bounds a pending copy and ignores its late failure after a newer successful copy', async ({ page }) => {
  const requests = await prepareShare(page)
  await page.clock.install()
  await page.evaluate(() => { window.__shareCopyTest.mode = 'pending' })
  await page.getByTestId('code-share-button').click()
  const status = page.getByTestId('code-share-copy-status')
  await expect(status).toHaveAttribute('data-copy-state', 'copying')
  await expect(page.getByTestId('code-share-copy-read-only')).toBeDisabled()
  await expect(page.getByTestId('code-share-read-only-url')).toHaveValue(readOnlyUrl)
  await page.clock.fastForward(5100)
  await expect(status).toHaveAttribute('data-copy-state', 'uncertain')
  await expect(status).toContainText('Copy unconfirmed')
  await page.evaluate(() => { window.__shareCopyTest.mode = 'success' })
  await page.getByTestId('code-share-copy-read-only').click()
  await expect(status).toHaveAttribute('data-copy-state', 'copied')
  await page.evaluate(() => window.__shareCopyTest.finish?.())
  await expect(status).toHaveAttribute('data-copy-state', 'copied')
  expect(await page.evaluate(() => window.__shareCopyTest.fallbackCalls)).toBe(0)
  expect(requests()).toBe(1)
})

test('dismissal invalidates the pending copy before a replacement ticket is shown', async ({ page }) => {
  const requests = await prepareShare(page)
  await page.evaluate(() => { window.__shareCopyTest.mode = 'pending' })
  await page.getByTestId('code-share-button').click()
  const status = page.getByTestId('code-share-copy-status')
  await expect(status).toHaveAttribute('data-copy-state', 'copying')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('code-share-popover')).toHaveCount(0)
  await page.evaluate(() => { window.__shareCopyTest.mode = 'success' })
  await page.getByTestId('code-share-button').click()
  await expect(status).toHaveAttribute('data-copy-state', 'copied')
  await page.evaluate(() => window.__shareCopyTest.finish?.())
  await expect(status).toHaveAttribute('data-copy-state', 'copied')
  expect(await page.evaluate(() => window.__shareCopyTest.fallbackCalls)).toBe(0)
  expect(requests()).toBe(2)
})
