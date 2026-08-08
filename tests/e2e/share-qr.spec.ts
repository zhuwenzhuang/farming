import { expect, openFarming, test } from './fixtures'

test.describe('workspace sharing', () => {
  test('keeps read-only and full-control copy actions distinct', async ({ page }) => {
    const readOnlyUrl = 'https://share.example.test/workspace?token=read-only'
    const fullAccessUrl = 'https://share.example.test/workspace?token=full-control'
    await page.route('**/api/share/qr-ticket', async route => {
      if (route.request().method() === 'DELETE') {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ revoked: true }) })
        return
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 'SHARECODE1',
          expiresAt: Date.now() + 5 * 60 * 1000,
          ttlMs: 5 * 60 * 1000,
          shortPath: '/j/SHARECODE1',
          shortUrl: 'https://share.example.test/j/SHARECODE1',
          longUrl: readOnlyUrl,
          fullAccessUrl,
          shortUrlAccessMode: 'owner',
          longUrlAccessMode: 'read-only',
          tokenLabel: '春风轻拂长堤岸边-轻落庭前幽静深处-一枝梅花悄然盛开',
        }),
      })
    })

    await page.setViewportSize({ width: 1000, height: 900 })
    await openFarming(page)
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(page.url()).origin })
    await page.getByTestId('code-share-button').click()

    await expect.poll(async () => page.evaluate(() => navigator.clipboard.readText())).toBe(readOnlyUrl)
    await expect(page.getByTestId('code-share-copy-status')).toContainText(/Current page read-only link copied|当前页面只读链接已复制/)

    const fullAccessButton = page.getByTestId('code-share-copy-link')
    await expect(fullAccessButton).toBeVisible()
    await expect(fullAccessButton.locator('.code-share-token-line')).toHaveCount(3)
    await expect(fullAccessButton).toContainText(/Copy full-control passphrase link|复制完整控制口令链接/)
    await fullAccessButton.click()

    await expect.poll(async () => page.evaluate(() => navigator.clipboard.readText())).toBe(fullAccessUrl)
    await expect(fullAccessButton).toContainText(/Full-control passphrase link copied|完整控制口令链接已复制/)
  })

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
