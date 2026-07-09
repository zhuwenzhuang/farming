import { expect, openFarming, test } from './fixtures'

test.describe('workspace sharing', () => {
  test('opens the QR popover without blanking the workspace', async ({ page }) => {
    const pageErrors: string[] = []
    page.on('pageerror', error => pageErrors.push(error.message))

    await openFarming(page)
    const shareButton = page.getByTestId('code-share-button')
    await expect(shareButton).toBeVisible()
    await shareButton.click()

    const popover = page.getByTestId('code-share-popover')
    await expect(popover).toBeVisible()
    await expect(popover.locator('svg[aria-label="QR code"]')).toBeVisible()
    await expect(page.getByTestId('app-shell')).toBeVisible()
    await expect.poll(() => pageErrors).toEqual([])
    await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(255, 255, 255)')

    await shareButton.click()
    await expect(popover).toHaveCount(0)
  })
})
