import { expect, test } from '@playwright/test'

test('failed reconnects eventually leave the initial loading state', {
  tag: ['@critical-behavior', '@behavior-CODE-BACKEND-CONNECTION-RECOVERY'],
}, async ({ page }) => {
  await page.routeWebSocket(/\/farming\/ws(?:\?|$)/, socket => {
    socket.onMessage(() => undefined)
    socket.close({ code: 1012, reason: 'backend unavailable' })
  })

  await page.goto('/farming/')

  const status = page.getByTestId('connection-status')
  await expect(status).toContainText('Loading')
  await expect(status).toHaveClass(/lost/, { timeout: 12_000 })
  await expect(status).toContainText('still unavailable')
})
