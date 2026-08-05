import { expect, openFarming, test } from './fixtures'

test.describe('workspace sharing', () => {
  test('opens the QR popover without blanking the workspace', async ({ page }) => {
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
    const ticket = await (await ticketResponsePromise).json() as { longUrl: string }

    const popover = page.getByTestId('code-share-popover')
    await expect(popover).toBeVisible()
    await expect.poll(async () => page.evaluate(() => navigator.clipboard.readText())).toBe(ticket.longUrl)
    const copiedStatus = page.getByTestId('code-share-copy-status')
    await expect(copiedStatus).toContainText(/Public link copied to clipboard|公开链接已复制到剪贴板/)
    await expect(copiedStatus).toContainText(/Anyone with this link|任何拥有此链接的人/)
    await expect(popover.getByTestId('code-share-copy-status')).toHaveCount(1)
    const tokenDisplay = page.getByTestId('code-share-token-display')
    await expect(tokenDisplay).toBeVisible()
    await expect(tokenDisplay).not.toContainText(/Haiku passphrase|俳句口令|Short link|分享短链/)
    await expect(tokenDisplay).not.toHaveAttribute('role', 'button')
    await expect(page.getByTestId('code-share-copy-link')).toHaveCount(0)
    const qrCode = popover.locator('svg[aria-label="QR code"]')
    await expect(qrCode).toBeVisible()
    await expect(qrCode.locator('image')).toHaveAttribute('href', /farming-2\/app-icon-v2-180\.png/)
    await expect(page.getByTestId('app-shell')).toBeVisible()
    await expect.poll(() => pageErrors).toEqual([])
    await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(255, 255, 255)')

    await shareButton.click()
    await expect(popover).toHaveCount(0)
  })
})
