import { expect, test } from '@playwright/test'

test('loads the standalone review bundle without loading the Farming app bundle', async ({ page }) => {
  const requestedAssets: string[] = []
  page.on('request', request => {
    if (request.url().includes('/assets/')) requestedAssets.push(request.url())
  })

  const reviewBundle = page.waitForRequest(request => request.url().includes('/assets/ReviewDemoPage-'))
  const reviewStyles = page.waitForRequest(request => request.url().includes('/assets/review-demo-'))
  await page.goto('/farming/review-demo')
  await Promise.all([reviewBundle, reviewStyles])

  await expect(page.getByTestId('review-demo-page')).toBeVisible()
  await expect(page.locator('body')).toHaveClass(/review-demo-body/)
  expect(requestedAssets.some(url => url.includes('/assets/App-'))).toBe(false)
  expect(requestedAssets.some(url => url.includes('/assets/main-'))).toBe(false)
})

test('loads the Farming app bundle without loading the standalone review bundle', async ({ page }) => {
  const requestedAssets: string[] = []
  page.on('request', request => {
    if (request.url().includes('/assets/')) requestedAssets.push(request.url())
  })

  const appBundle = page.waitForRequest(request => request.url().includes('/assets/App-'))
  const mainStyles = page.waitForRequest(request => request.url().includes('/assets/main-'))
  await page.goto('/farming/')
  await Promise.all([appBundle, mainStyles])

  await expect(page.locator('body')).not.toHaveClass(/review-demo-body/)
  expect(requestedAssets.some(url => url.includes('/assets/ReviewDemoPage-'))).toBe(false)
  expect(requestedAssets.some(url => url.includes('/assets/review-demo-'))).toBe(false)
})
