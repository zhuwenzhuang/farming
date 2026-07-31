import { expect, openFarming, test } from './fixtures'

test('Composer follow-up behavior refreshes from settings and persists Queue or Steer', async ({ page }) => {
  await openFarming(page)

  const seed = await page.request.post('/farming/api/settings', {
    data: { composerFollowUpBehavior: 'steer' },
  })
  expect(seed.ok()).toBeTruthy()

  await page.getByTestId('code-sidebar-options').click()
  const row = page.getByTestId('code-settings-follow-up-behavior')
  const queue = row.getByRole('button', { name: 'Queue', exact: true })
  const steer = row.getByRole('button', { name: 'Steer', exact: true })

  await expect(steer).toHaveAttribute('aria-pressed', 'true')
  await expect(queue).toHaveAttribute('aria-pressed', 'false')

  await queue.click()
  await expect(queue).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(async () => {
    const response = await page.request.get('/farming/api/settings')
    const data = await response.json() as { settings?: { composerFollowUpBehavior?: string } }
    return data.settings?.composerFollowUpBehavior
  }).toBe('queue')
})

test('Settings keeps loaded choices usable while refreshing', async ({ page }) => {
  await openFarming(page)
  await page.getByTestId('code-sidebar-options').click()

  const settings = page.getByTestId('code-settings-panel')
  const row = page.getByTestId('code-settings-follow-up-behavior')
  const queue = row.getByRole('button', { name: 'Queue', exact: true })
  await expect(queue).toBeEnabled()
  await settings.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(settings).toBeHidden()

  let releaseRefresh: (() => void) | null = null
  const refreshBlocked = new Promise<void>(resolve => {
    releaseRefresh = resolve
  })
  await page.route('**/farming/api/settings', async route => {
    if (route.request().method() === 'GET') await refreshBlocked
    await route.continue()
  })

  await page.getByTestId('code-sidebar-options').click()
  await expect(queue).toBeEnabled()
  await expect(settings.locator('.code-settings-status')).toHaveCount(0)

  releaseRefresh?.()
  await expect(queue).toBeEnabled()
})
