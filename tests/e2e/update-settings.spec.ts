import { expect, openFarming, test } from './fixtures'

function updateStatus({
  current = '2.2.6',
  phase = 'idle',
  available = true,
}: {
  current?: string
  phase?: string
  available?: boolean
} = {}) {
  return {
    method: 'npm',
    current: { releaseVersion: current, packageVersion: current, type: 'npm' },
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
  await expect(updateButton).toHaveText('Update to 2.2.8')
  await expect(updateButton).toBeEnabled()
  await expect(card.getByRole('button', { name: 'Refresh' })).toBeVisible()
  await expect(card.getByRole('combobox', { name: 'Target' })).toHaveCount(0)

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

test('successful in-page update reloads the new frontend and does not duplicate progress text', async ({ page }) => {
  let installStarted = false
  let installRequests = 0
  await page.route(/\/farming\/api\/update(?:\?.*)?$/, route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      update: installStarted
        ? updateStatus({ current: '2.2.8', phase: 'succeeded', available: false })
        : updateStatus(),
    }),
  }))
  await page.route(/\/farming\/api\/update\/install$/, route => {
    installStarted = true
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

  await openFarming(page)
  await page.getByTestId('code-sidebar-options').click()
  const panel = page.getByTestId('code-settings-panel')
  const navigation = page.waitForEvent('framenavigated', frame => frame === page.mainFrame())
  await page.getByTestId('code-settings-update-action').click()

  await expect(panel.getByText('Upgrade started. The server will restart automatically.')).toHaveCount(1)
  await navigation
  await expect(page.getByTestId('app-shell')).toBeVisible()
  expect(installRequests).toBe(1)

  await page.getByTestId('code-sidebar-options').click()
  await expect(page.getByTestId('code-settings-update-card')).toContainText('2.2.8')
  await expect(page.getByTestId('code-settings-update-action')).toHaveText('Update')
  await expect(page.getByTestId('code-settings-update-action')).toBeDisabled()
})
