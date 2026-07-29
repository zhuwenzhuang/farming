import { expect, openFarming, test } from './fixtures'

function updateStatus({
  current = '2.2.6',
  phase = 'idle',
  available = true,
  method = 'npm',
  receivedBytes,
  totalBytes,
  startedAt,
  preparedAt,
}: {
  current?: string
  phase?: string
  available?: boolean
  method?: string
  receivedBytes?: number
  totalBytes?: number
  startedAt?: string
  preparedAt?: string
} = {}) {
  return {
    method,
    current: { releaseVersion: current, packageVersion: current, type: method },
    latest: { version: '2.2.8', assetName: '2.2.8', blockedReason: '' },
    selected: { version: '2.2.8', assetName: '2.2.8', blockedReason: '' },
    versions: [{
      version: '2.2.8',
      assetName: '2.2.8',
      available,
      installable: true,
    }],
    available,
    installable: true,
    state: {
      phase,
      version: '2.2.8',
      previousVersion: '2.2.6',
      receivedBytes,
      totalBytes,
      startedAt,
      preparedAt,
    },
  }
}

test('update settings use a compact version summary and an explicit update button', async ({ page }) => {
  await page.route(/\/farming\/api\/update(?:\?.*)?$/, route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ update: updateStatus() }),
  }))

  await openFarming(page)
  await page.getByTestId('code-sidebar-options').click()

  const card = page.getByTestId('code-settings-update-card')
  const updateButton = page.getByTestId('code-settings-update-action')
  await expect(card).toContainText('2.2.6')
  await expect(card).toContainText('2.2.8')
  await expect(card).toContainText('npm · Update available')
  await expect(updateButton).toHaveText('Prepare 2.2.8')
  await expect(updateButton).toBeEnabled()
  await expect(card.getByRole('button', { name: 'Refresh' })).toBeVisible()
  await expect(card.getByRole('combobox', { name: 'Target' })).toHaveCount(0)
  await expect(card.getByRole('textbox')).toHaveCount(0)

  const metrics = await card.evaluate(element => {
    const cardRect = element.getBoundingClientRect()
    const actionRect = element.querySelector('[data-testid="code-settings-update-action"]')?.getBoundingClientRect()
    return {
      height: cardRect.height,
      actionWidth: actionRect?.width ?? 0,
      actionHeight: actionRect?.height ?? 0,
    }
  })
  expect(metrics.height).toBeLessThan(100)
  expect(metrics.actionWidth).toBeGreaterThanOrEqual(88)
  expect(metrics.actionHeight).toBeGreaterThanOrEqual(32)
})

test('update request errors stay inside the update card', async ({ page }) => {
  const message = 'request timed out for https://registry.npmjs.org/farming-code'
  await page.route(/\/farming\/api\/update(?:\?.*)?$/, route => route.fulfill({
    status: 504,
    contentType: 'application/json',
    body: JSON.stringify({ error: message }),
  }))

  await openFarming(page)
  await page.getByTestId('code-sidebar-options').click()

  const updateCard = page.getByTestId('code-settings-update-card')
  await expect(updateCard.getByRole('alert')).toHaveText(message)

  const agentHomesSection = page.locator('.code-settings-section').filter({
    has: page.getByRole('heading', { name: 'Agent Homes' }),
  })
  await expect(agentHomesSection.getByRole('alert')).toHaveCount(0)
})

test('non-npm installations expose no update source or enabled update action', async ({ page }) => {
  await page.route(/\/farming\/api\/update(?:\?.*)?$/, route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      update: {
        method: 'app-bundle',
        current: { releaseVersion: '2.2.6', packageVersion: '2.2.6', type: 'app-bundle' },
        latest: {
          version: '',
          assetName: '',
          source: '',
          blockedReason: 'App bundles update by reinstalling a release package or switching to npm',
        },
        selected: {
          version: '',
          assetName: '',
          blockedReason: 'App bundles update by reinstalling a release package or switching to npm',
        },
        versions: [],
        available: false,
        installable: false,
        state: { phase: 'idle' },
      },
    }),
  }))

  await openFarming(page)
  await page.getByTestId('code-sidebar-options').click()

  const card = page.getByTestId('code-settings-update-card')
  await expect(card).toContainText('App bundles update by reinstalling a release package or switching to npm')
  await expect(card.getByRole('textbox')).toHaveCount(0)
  await expect(page.getByTestId('code-settings-update-action')).toHaveCount(0)
})

test('prepared update waits for explicit restart, then reloads the new frontend', async ({ page }) => {
  let prepareStarted = false
  let restartStarted = false
  let installRequests = 0
  let restartRequests = 0
  await page.route(/\/farming\/api\/update(?:\?.*)?$/, route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      update: restartStarted
        ? updateStatus({ current: '2.2.8', phase: 'succeeded', available: false })
        : prepareStarted
          ? updateStatus({
            phase: 'ready-to-restart',
            startedAt: new Date(Date.now() - 8_000).toISOString(),
            preparedAt: new Date().toISOString(),
          })
          : updateStatus(),
    }),
  }))
  await page.route(/\/farming\/api\/update\/install$/, route => {
    prepareStarted = true
    installRequests += 1
    return route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({
        update: {
          state: { phase: 'installing', version: '2.2.8', previousVersion: '2.2.6' },
          blockingAgents: [],
        },
      }),
    })
  })
  await page.route(/\/farming\/api\/update\/restart$/, route => {
    restartStarted = true
    restartRequests += 1
    return route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({
        update: {
          state: { phase: 'restarting', version: '2.2.8', previousVersion: '2.2.6' },
          blockingAgents: [],
        },
      }),
    })
  })

  await openFarming(page)
  await page.getByTestId('code-sidebar-options').click()
  const panel = page.getByTestId('code-settings-panel')
  await page.getByTestId('code-settings-update-action').click()

  await expect(panel.getByText('Preparing update…')).toHaveCount(1)
  const card = page.getByTestId('code-settings-update-card')
  await expect(card).toContainText('Update ready. Restart to apply it.')
  const restartButton = page.getByTestId('code-settings-update-action')
  await expect(restartButton).toHaveText('Restart to update')
  await expect(restartButton).toBeEnabled()

  await page.setViewportSize({ width: 320, height: 720 })
  const bounds = await card.evaluate(element => ({
    scrollWidth: element.scrollWidth,
    clientWidth: element.clientWidth,
  }))
  expect(bounds.scrollWidth).toBeLessThanOrEqual(bounds.clientWidth)

  const navigation = page.waitForEvent('framenavigated', frame => frame === page.mainFrame())
  await restartButton.click()
  await expect(panel.getByText('The new version is installed. Restarting Farming.')).toHaveCount(1)
  await navigation
  await expect(page.getByTestId('app-shell')).toBeVisible()
  expect(installRequests).toBe(1)
  expect(restartRequests).toBe(1)

  await page.setViewportSize({ width: 1280, height: 800 })
  await page.getByTestId('code-sidebar-options').click()
  await expect(page.getByTestId('code-settings-update-card')).toContainText('2.2.8')
  await expect(page.getByTestId('code-settings-update-action')).toHaveText('Prepare update')
  await expect(page.getByTestId('code-settings-update-action')).toBeDisabled()
})
