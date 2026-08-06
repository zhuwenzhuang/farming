import { expect, openFarming, test } from './fixtures'

test.describe('workspace sharing', () => {
  test('refuses to present an unsafe share when authentication is disabled', async ({ page }) => {
    const pageErrors: string[] = []
    page.on('pageerror', error => pageErrors.push(error.message))

    await page.setViewportSize({ width: 1000, height: 900 })
    await openFarming(page)
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(page.url()).origin })
    const shareButton = page.getByTestId('code-share-button')
    await expect(shareButton).toBeVisible()
    const ticketResponsePromise = page.waitForResponse(response => (
      response.request().method() === 'POST' && response.url().includes('/api/share/qr-ticket')
    ))
    await shareButton.click()
    const ticketResponse = await ticketResponsePromise
    expect(ticketResponse.status()).toBe(409)
    const ticketError = await ticketResponse.json() as { error?: string }
    expect(ticketError.error).toContain('requires token authentication')

    const popover = page.getByTestId('code-share-popover')
    await expect(popover).toBeVisible()
    await expect(popover.getByRole('status')).toContainText('Read-only sharing requires token authentication.')
    await expect(popover.getByTestId('code-share-copy-status')).toHaveCount(0)
    const tokenDisplay = page.getByTestId('code-share-token-display')
    await expect(tokenDisplay).toHaveCount(0)
    await expect(page.getByTestId('code-share-copy-link')).toHaveCount(0)
    await expect(popover.locator('svg[aria-label="QR code"]')).toHaveCount(0)
    await expect(page.getByTestId('app-shell')).toBeVisible()
    await expect.poll(() => pageErrors).toEqual([])
    await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(255, 255, 255)')

    await shareButton.click()
    await expect(popover).toHaveCount(0)
  })
})
