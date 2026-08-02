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
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
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

test('desktop enters focus mode directly without browser installation guidance', async ({ page }) => {
  await page.addInitScript(() => {
    let fullscreenElement: Element | null = null
    Object.defineProperty(window, 'farmingDesktop', { configurable: true, value: {} })
    Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, get: () => true })
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => fullscreenElement })
    Object.defineProperty(Element.prototype, 'requestFullscreen', {
      configurable: true,
      value: async function requestFullscreen(this: Element) {
        fullscreenElement = this
        ;(window as typeof window & { __farmingFullscreenRequested?: number }).__farmingFullscreenRequested =
          ((window as typeof window & { __farmingFullscreenRequested?: number }).__farmingFullscreenRequested ?? 0) + 1
        document.dispatchEvent(new Event('fullscreenchange'))
      },
    })
    Object.defineProperty(document, 'exitFullscreen', {
      configurable: true,
      value: async () => {
        fullscreenElement = null
        document.dispatchEvent(new Event('fullscreenchange'))
      },
    })
  })

  await openFarming(page)
  const entry = page.getByTestId('code-sidebar-focus-toggle')
  await expect(entry).toHaveAccessibleName('Focus mode')
  await entry.click()
  await expect.poll(() => page.evaluate(() => (
    (window as typeof window & { __farmingFullscreenRequested?: number }).__farmingFullscreenRequested ?? 0
  ))).toBe(1)
  await expect(page.getByTestId('code-app-mode-dialog')).toHaveCount(0)

  await entry.click()
  await page.getByTestId('code-empty-home-focus').click()
  await expect.poll(() => page.evaluate(() => (
    (window as typeof window & { __farmingFullscreenRequested?: number }).__farmingFullscreenRequested ?? 0
  ))).toBe(2)
  await expect(page.getByTestId('code-app-mode-dialog')).toHaveCount(0)
})

test('desktop connections are an embedded Farming plugin section, not a separate page', async ({ page }) => {
  await page.addInitScript(() => {
    const remoteProfile = (id: string, name: string, sshHost: string) => ({
      id,
      kind: 'remote' as const,
      name,
      transport: 'ssh' as const,
      sshHost,
      remoteHost: '127.0.0.1',
      remotePort: 0,
      basePath: '/farming',
      directUrl: '',
      farmingHome: '~/.farming-desktop',
      hasToken: false,
    })
    let state = {
      activeBackendId: 'local',
      profiles: [{
        id: 'local',
        kind: 'local' as const,
        name: 'This Mac',
        transport: 'direct' as const,
        sshHost: '',
        remoteHost: '127.0.0.1',
        remotePort: 0,
        basePath: '/farming',
        directUrl: 'http://127.0.0.1:43121',
        farmingHome: '/tmp/farming-desktop',
        hasToken: true,
      }, remoteProfile('remote-a', 'Build host', 'build-host'), remoteProfile('remote-b', 'GPU host', 'gpu-host')],
      connections: [{
        backendId: 'local',
        generation: 1,
        status: 'ready' as const,
        error: '',
        message: 'Connected',
        server: null,
      }, {
        backendId: 'remote-a',
        generation: 0,
        status: 'disconnected' as const,
        error: '',
        message: 'Disconnected',
        server: null,
      }, {
        backendId: 'remote-b',
        generation: 0,
        status: 'disconnected' as const,
        error: '',
        message: 'Disconnected',
        server: null,
      }],
    }
    const listeners = new Set<(next: typeof state) => void>()
    const activateBackend = async (backendId: string) => {
      state = {
        ...state,
        activeBackendId: backendId,
        connections: state.connections.map(connection => ({
          ...connection,
          status: connection.backendId === backendId ? 'ready' as const : connection.status,
          message: connection.backendId === backendId ? 'Connected' : connection.message,
        })),
      }
      listeners.forEach(listener => listener(state))
      return state
    }
    Object.defineProperty(window, 'farmingDesktop', {
      configurable: true,
      value: {
        getState: async () => state,
        saveAndActivateBackend: async () => state,
        removeBackend: async () => state,
        connectBackend: async () => state,
        disconnectBackend: async () => state,
        activateBackend,
        showNotification: async () => {},
        onStateChanged: (listener: (next: typeof state) => void) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      },
    })
  })

  await openFarming(page)
  await page.getByTestId('code-nav-remote-connections').click()

  await expect(page.getByTestId('code-plugins-panel')).toBeVisible()
  await expect(page.getByTestId('code-plugin-tab-farming')).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByTestId('desktop-connections-panel')).toBeVisible()
  await expect(page.getByTestId('desktop-connection-local')).toContainText('This Mac')
  await expect(page.getByTestId('desktop-connections-panel')).toContainText('Using: This Mac')
  await expect(page.getByRole('button', { name: 'Back to Plugins' })).toHaveCount(0)
  await expect(page.getByTestId('code-plugin-browser')).toBeVisible()

  await page.getByRole('switch', { name: 'Use Build host' }).click()
  await expect(page.getByTestId('desktop-connections-panel')).toContainText('Using: Build host')
  await page.getByRole('switch', { name: 'Use This Mac' }).click()
  await expect(page.getByTestId('desktop-connections-panel')).toContainText('Using: This Mac')
  await page.getByRole('switch', { name: 'Use GPU host' }).click()
  await expect(page.getByTestId('desktop-connections-panel')).toContainText('Using: GPU host')
})
