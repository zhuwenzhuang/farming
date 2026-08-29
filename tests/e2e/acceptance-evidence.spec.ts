import assert from 'node:assert/strict'
import fs from 'node:fs'
import type { Page, TestInfo } from '@playwright/test'
import { expect, test } from './fixtures'
import { createAcceptanceEvidence } from './acceptance-evidence'

type ScreenshotMethod = Page['screenshot']

function manifestScreenshotCount(manifestPath: string) {
  if (!fs.existsSync(manifestPath)) return 0
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { screenshots?: unknown[] }
  return manifest.screenshots?.length ?? 0
}

function temporaryScreenshotCount(outputDir: string) {
  if (!fs.existsSync(outputDir)) return 0
  return fs.readdirSync(outputDir).filter(fileName => fileName.endsWith('.tmp.png')).length
}

async function mutateAfterScreenshot(
  page: Page,
  mutation: () => Promise<void>,
  capture: () => Promise<string>,
) {
  const mutablePage = page as Page & { screenshot: ScreenshotMethod }
  const originalScreenshot = page.screenshot.bind(page) as ScreenshotMethod
  mutablePage.screenshot = (async options => {
    const result = await originalScreenshot(options)
    await mutation()
    return result
  }) as ScreenshotMethod
  try {
    return await capture()
  } finally {
    mutablePage.screenshot = originalScreenshot
  }
}

function evidenceForTest(testInfo: TestInfo) {
  return createAcceptanceEvidence(testInfo.outputPath('acceptance-evidence'), {
    manifestFileName: 'manifest.json',
  })
}

test.describe('acceptance evidence capture state', () => {
  test('runs scenario readiness and proof before and after a successful capture', async ({ page }, testInfo) => {
    await page.setContent('<main data-testid="proof" data-ready="true">ready</main>')
    const evidence = evidenceForTest(testInfo)
    const proof = page.getByTestId('proof')
    let readyChecks = 0

    await evidence.capture({
      page,
      testInfo,
      screenshotName: 'ready.png',
      scenario: 'ready state',
      settledAssertion: 'The scenario stayed ready across capture',
      proofLocator: proof,
      expectedTestId: 'proof',
      assertReady: async () => {
        readyChecks += 1
        expect(await proof.getAttribute('data-ready')).toBe('true')
      },
      stableLocators: [proof],
    })

    expect(readyChecks).toBe(2)
    expect(manifestScreenshotCount(evidence.manifestPath)).toBe(1)
  })

  test('rejects a full-page capture when its proof disappears during capture', async ({ page }, testInfo) => {
    await page.setContent('<main data-testid="proof">ready</main>')
    const evidence = evidenceForTest(testInfo)
    const proof = page.getByTestId('proof')

    await assert.rejects(
      mutateAfterScreenshot(
        page,
        () => proof.evaluate(element => element.remove()),
        () => evidence.capture({
          page,
          testInfo,
          screenshotName: 'proof-changed.png',
          scenario: 'proof changes',
          settledAssertion: 'The proof remains visible across capture',
          proofLocator: proof,
          fullPage: true,
        }),
      ),
      /proof is no longer visible/,
    )

    expect(manifestScreenshotCount(evidence.manifestPath)).toBe(0)
    expect(fs.existsSync(testInfo.outputPath('acceptance-evidence', 'proof-changed.png'))).toBe(false)
    expect(temporaryScreenshotCount(testInfo.outputPath('acceptance-evidence'))).toBe(0)
  })

  test('rejects a capture when scenario readiness changes during capture', async ({ page }, testInfo) => {
    await page.setContent('<main data-testid="proof" data-ready="true">ready</main>')
    const evidence = evidenceForTest(testInfo)
    const proof = page.getByTestId('proof')
    const assertReady = async () => {
      if (await proof.getAttribute('data-ready') !== 'true') throw new Error('scenario is no longer ready')
    }

    await assert.rejects(
      mutateAfterScreenshot(
        page,
        () => proof.evaluate(element => { element.setAttribute('data-ready', 'false') }),
        () => evidence.capture({
          page,
          testInfo,
          screenshotName: 'state-changed.png',
          scenario: 'scenario state changes',
          settledAssertion: 'The scenario remains ready across capture',
          proofLocator: proof,
          assertReady,
        }),
      ),
      /scenario is no longer ready/,
    )

    expect(manifestScreenshotCount(evidence.manifestPath)).toBe(0)
  })

  test('rejects a capture when stable geometry transforms during capture', async ({ page }, testInfo) => {
    await page.setContent('<main data-testid="proof" style="width: 120px; height: 80px">ready</main>')
    const evidence = evidenceForTest(testInfo)
    const proof = page.getByTestId('proof')

    await assert.rejects(
      mutateAfterScreenshot(
        page,
        () => proof.evaluate(element => { element.style.transform = 'translateX(24px)' }),
        () => evidence.capture({
          page,
          testInfo,
          screenshotName: 'transform-changed.png',
          scenario: 'stable geometry transforms',
          settledAssertion: 'Stable geometry remains unchanged across capture',
          proofLocator: proof,
          stableLocators: [proof],
        }),
      ),
      /capture state changed/,
    )

    expect(manifestScreenshotCount(evidence.manifestPath)).toBe(0)
  })

  test('rejects a capture when page scroll changes during capture', async ({ page }, testInfo) => {
    await page.setContent([
      '<main data-testid="proof" style="position: fixed; inset: 0 auto auto 0">ready</main>',
      '<div style="height: 2000px"></div>',
    ].join(''))
    const evidence = evidenceForTest(testInfo)
    const proof = page.getByTestId('proof')

    await assert.rejects(
      mutateAfterScreenshot(
        page,
        () => page.evaluate(() => window.scrollTo(0, 120)),
        () => evidence.capture({
          page,
          testInfo,
          screenshotName: 'scroll-changed.png',
          scenario: 'page scroll changes',
          settledAssertion: 'Page scroll remains unchanged across capture',
          proofLocator: proof,
        }),
      ),
      /capture state changed/,
    )

    expect(manifestScreenshotCount(evidence.manifestPath)).toBe(0)
  })
})
