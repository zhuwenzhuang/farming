import { expect, openFarming, test } from './fixtures'

test('guides desktop users to install Farming and keeps fullscreen as a temporary choice', async ({ page }) => {
  await page.addInitScript(() => {
    let fullscreenElement: Element | null = null
    Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, get: () => true })
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => fullscreenElement })
    Object.defineProperty(Element.prototype, 'requestFullscreen', {
      configurable: true,
      value: async function requestFullscreen(this: Element) {
        fullscreenElement = this
        ;(window as typeof window & { __farmingFullscreenRequested?: boolean }).__farmingFullscreenRequested = true
        document.dispatchEvent(new Event('fullscreenchange'))
      },
    })
  })

  await openFarming(page)
  await page.evaluate(() => {
    const installEvent = new Event('beforeinstallprompt', { cancelable: true })
    Object.defineProperties(installEvent, {
      prompt: {
        value: async () => {
          const target = window as typeof window & { __farmingInstallPromptCount?: number }
          target.__farmingInstallPromptCount = (target.__farmingInstallPromptCount ?? 0) + 1
        },
      },
      userChoice: { value: Promise.resolve({ outcome: 'accepted' }) },
    })
    window.dispatchEvent(installEvent)
  })

  const entry = page.getByTestId('code-sidebar-focus-toggle')
  await expect(entry).toHaveAccessibleName('App mode and fullscreen')
  await entry.click()

  const dialog = page.getByTestId('code-app-mode-dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('heading', { name: 'Use Farming without browser controls' })).toBeVisible()
  await expect(dialog).toContainText('Cast, save and share')
  await expect(dialog).toContainText('Install page as app')
  await dialog.getByTestId('code-app-mode-install').click()
  await expect.poll(() => page.evaluate(() => (
    (window as typeof window & { __farmingInstallPromptCount?: number }).__farmingInstallPromptCount ?? 0
  ))).toBe(1)
  await expect(dialog).toHaveCount(0)

  await entry.click()
  await page.getByTestId('code-app-mode-dialog').getByTestId('code-app-mode-fullscreen').click()
  await expect.poll(() => page.evaluate(() => (
    (window as typeof window & { __farmingFullscreenRequested?: boolean }).__farmingFullscreenRequested === true
  ))).toBeTruthy()
  await expect(page.getByTestId('code-app-mode-dialog')).toHaveCount(0)
})

test('explains when this deployment cannot be installed instead of showing manual install steps', async ({ page }) => {
  await openFarming(page)

  await page.getByTestId('code-sidebar-focus-toggle').click()

  const dialog = page.getByTestId('code-app-mode-dialog')
  await expect(dialog.getByTestId('code-app-mode-install-unavailable')).toBeVisible()
  await expect(dialog).toContainText('Browser app installation is unavailable')
  await expect(dialog).not.toContainText('Cast, save and share')
  await expect(dialog.getByTestId('code-app-mode-install')).toHaveCount(0)
})

test('does not show the app-mode entry inside an installed Farming window', async ({ page }) => {
  await page.addInitScript(() => {
    const browserMatchMedia = window.matchMedia.bind(window)
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: (query: string) => {
        if (query !== '(display-mode: standalone)') return browserMatchMedia(query)
        return {
          matches: true,
          media: query,
          onchange: null,
          addListener: () => {},
          removeListener: () => {},
          addEventListener: () => {},
          removeEventListener: () => {},
          dispatchEvent: () => true,
        } satisfies MediaQueryList
      },
    })
  })

  await openFarming(page)
  await expect(page.getByTestId('code-sidebar-focus-toggle')).toHaveCount(0)
  await expect(page.getByTestId('code-app-mode-dialog')).toHaveCount(0)
})
