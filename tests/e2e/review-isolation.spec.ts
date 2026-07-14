import { expect, test } from '@playwright/test'

test('loads the standalone review bundle without loading the Farming app bundle', async ({ page }) => {
  const requestedAssets: string[] = []
  page.on('request', request => {
    if (request.url().includes('/assets/')) requestedAssets.push(request.url())
  })

  const reviewBundle = page.waitForRequest(request => request.url().includes('/assets/ReviewPage-'))
  const reviewStyles = page.waitForRequest(request => request.url().includes('/assets/review-'))
  await page.goto('/farming/review?fixture=1')
  await Promise.all([reviewBundle, reviewStyles])

  await expect(page.getByTestId('review-page')).toBeVisible()
  await expect(page.locator('body')).toHaveClass(/review-body/)
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

  await expect(page.locator('body')).not.toHaveClass(/review-body/)
  expect(requestedAssets.some(url => url.includes('/assets/ReviewPage-'))).toBe(false)
  expect(requestedAssets.some(url => url.includes('/assets/review-'))).toBe(false)
})
