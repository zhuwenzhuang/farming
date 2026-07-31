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
