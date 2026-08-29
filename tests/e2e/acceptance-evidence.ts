import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Locator, Page, TestInfo } from '@playwright/test'
import { expect } from '@playwright/test'

type AcceptanceEvidenceOptions = {
  manifestFileName: string
}

type CaptureOptions = {
  page: Page
  testInfo: TestInfo
  screenshotName: string
  scenario: string
  settledAssertion: string
  assertReady?: () => Promise<void>
  theme?: string
  proofLocator?: Locator
  expectedTestId?: string
  expectedHeading?: string | RegExp
  stableLocators?: Locator[]
  target?: Locator
  fullPage?: boolean
}

type ScreenshotEvidence = {
  runId: string
  packageVersion: string
  gitSha: string
  gitTreeSha: string
  dirty: boolean
  repositoryStateSha: string
  baseUrlClass: string
  playwrightProject: string
  browserName: string
  testTitle: string
  viewport: { width: number, height: number }
  theme: string
  scenario: string
  screenshotName: string
  screenshotSha256: string
  screenshotBytes: number
  pngWidth: number
  pngHeight: number
  settledAssertion: string
  timestamp: string
}

type EvidenceManifest = {
  schemaVersion: number
  runId: string
  screenshots: ScreenshotEvidence[]
}

function gitOutput(args: string[], encoding: 'utf8'): string
function gitOutput(args: string[], encoding: 'buffer'): Buffer
function gitOutput(args: string[], encoding: 'utf8' | 'buffer') {
  return execFileSync('git', args, {
    encoding,
    maxBuffer: 64 * 1024 * 1024,
  })
}

function repositoryStateSha(trackedDiff: Buffer, untrackedPaths: string[]) {
  const hash = createHash('sha256')
  hash.update(trackedDiff)
  for (const filePath of untrackedPaths) {
    hash.update('\0untracked\0')
    hash.update(filePath)
    const stat = fs.lstatSync(filePath)
    hash.update(`\0${stat.mode}\0`)
    if (stat.isSymbolicLink()) hash.update(fs.readlinkSync(filePath))
    else hash.update(fs.readFileSync(filePath))
  }
  return hash.digest('hex')
}

function repositoryIdentity() {
  const packageJson = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8')) as {
    version?: string
  }
  if (!packageJson.version) throw new Error('Acceptance evidence requires a package version')
  const gitSha = gitOutput(['rev-parse', 'HEAD'], 'utf8').trim()
  if (!/^[0-9a-f]{40}$/.test(gitSha)) {
    throw new Error(`Acceptance evidence requires a full git SHA, received ${gitSha || 'nothing'}`)
  }
  const gitTreeSha = gitOutput(['rev-parse', 'HEAD^{tree}'], 'utf8').trim()
  if (!/^[0-9a-f]{40}$/.test(gitTreeSha)) {
    throw new Error(`Acceptance evidence requires a full git tree SHA, received ${gitTreeSha || 'nothing'}`)
  }
  const trackedDiff = gitOutput(['diff', '--binary', 'HEAD', '--'], 'buffer')
  const untrackedPaths = gitOutput(
    ['ls-files', '--others', '--exclude-standard', '-z'],
    'buffer',
  ).toString('utf8').split('\0').filter(Boolean).sort()
  return {
    packageVersion: packageJson.version,
    gitSha,
    gitTreeSha,
    dirty: trackedDiff.length > 0 || untrackedPaths.length > 0,
    repositoryStateSha: repositoryStateSha(trackedDiff, untrackedPaths),
  }
}

function sameRepositoryIdentity(
  before: ReturnType<typeof repositoryIdentity>,
  after: ReturnType<typeof repositoryIdentity>,
) {
  return Object.entries(before).every(([key, value]) => (
    after[key as keyof typeof after] === value
  ))
}

function pngMetadata(filePath: string) {
  const contents = fs.readFileSync(filePath)
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  if (
    contents.length < 24
    || !contents.subarray(0, signature.length).equals(signature)
    || contents.toString('ascii', 12, 16) !== 'IHDR'
  ) {
    throw new Error(`Acceptance screenshot is not a valid PNG: ${filePath}`)
  }
  return {
    screenshotSha256: createHash('sha256').update(contents).digest('hex'),
    screenshotBytes: contents.length,
    pngWidth: contents.readUInt32BE(16),
    pngHeight: contents.readUInt32BE(20),
  }
}

function acceptanceRunId(testInfo: TestInfo) {
  const outputDir = path.resolve(testInfo.project.outputDir)
  const markerPath = path.join(outputDir, '.acceptance-evidence-run-id')
  fs.mkdirSync(outputDir, { recursive: true })
  try {
    fs.writeFileSync(markerPath, `${randomUUID()}\n`, { flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  const runId = fs.readFileSync(markerPath, 'utf8').trim()
  if (!/^[0-9a-f-]{36}$/.test(runId)) {
    throw new Error(`Acceptance evidence run marker is invalid: ${markerPath}`)
  }
  return runId
}

function emptyManifest(runId: string): EvidenceManifest {
  return { schemaVersion: 2, runId, screenshots: [] }
}

function readManifest(manifestPath: string, runId: string): EvidenceManifest {
  if (!fs.existsSync(manifestPath)) return emptyManifest(runId)
  const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Partial<EvidenceManifest>
  if (
    parsed.schemaVersion !== 2
    || parsed.runId !== runId
    || !Array.isArray(parsed.screenshots)
  ) {
    if (Array.isArray(parsed.screenshots)) {
      for (const screenshot of parsed.screenshots) {
        const screenshotName = screenshot?.screenshotName
        if (typeof screenshotName !== 'string' || path.basename(screenshotName) !== screenshotName) continue
        fs.rmSync(path.join(path.dirname(manifestPath), screenshotName), { force: true })
      }
    }
    return emptyManifest(runId)
  }
  for (const screenshot of parsed.screenshots) {
    if (
      !screenshot
      || screenshot.runId !== runId
      || typeof screenshot.screenshotName !== 'string'
      || typeof screenshot.screenshotSha256 !== 'string'
      || typeof screenshot.repositoryStateSha !== 'string'
      || typeof screenshot.playwrightProject !== 'string'
      || typeof screenshot.browserName !== 'string'
      || typeof screenshot.testTitle !== 'string'
      || !Number.isInteger(screenshot.pngWidth)
      || !Number.isInteger(screenshot.pngHeight)
    ) {
      throw new Error(`Acceptance evidence manifest has an invalid screenshot entry: ${manifestPath}`)
    }
  }
  return parsed as EvidenceManifest
}

async function acquireManifestLock(lockPath: string) {
  const deadline = Date.now() + 15_000
  while (true) {
    try {
      fs.mkdirSync(lockPath)
      return () => fs.rmdirSync(lockPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for acceptance evidence manifest lock: ${lockPath}`)
      }
      await new Promise(resolve => setTimeout(resolve, 25))
    }
  }
}

function baseUrlClass(rawUrl: string) {
  const url = new URL(rawUrl)
  const protocol = url.protocol.replace(/:$/, '')
  const hostname = url.hostname.toLowerCase()
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
    return `${protocol}-loopback`
  }
  const octets = hostname.split('.').map(value => Number.parseInt(value, 10))
  const privateIpv4 = octets.length === 4 && octets.every(value => Number.isInteger(value)) && (
    octets[0] === 10
    || (octets[0] === 172 && (octets[1] ?? 0) >= 16 && (octets[1] ?? 0) <= 31)
    || (octets[0] === 192 && octets[1] === 168)
  )
  if (privateIpv4 || hostname.endsWith('.local')) return `${protocol}-private-network`
  return `${protocol}-public-network`
}

function roundedLayoutValue(value: number) {
  return Math.round(value * 1000) / 1000
}

async function captureState(page: Page, stableLocators: Locator[]) {
  const viewportAndScroll = await page.evaluate(() => {
    const rounded = (value: number) => Math.round(value * 1000) / 1000
    const visualViewport = window.visualViewport
    return {
      windowScroll: {
        x: rounded(window.scrollX),
        y: rounded(window.scrollY),
      },
      documentScroll: {
        x: rounded(document.documentElement.scrollLeft),
        y: rounded(document.documentElement.scrollTop),
      },
      bodyScroll: {
        x: rounded(document.body.scrollLeft),
        y: rounded(document.body.scrollTop),
      },
      visualViewport: visualViewport ? {
        offsetLeft: rounded(visualViewport.offsetLeft),
        offsetTop: rounded(visualViewport.offsetTop),
        pageLeft: rounded(visualViewport.pageLeft),
        pageTop: rounded(visualViewport.pageTop),
        width: rounded(visualViewport.width),
        height: rounded(visualViewport.height),
        scale: rounded(visualViewport.scale),
      } : null,
    }
  })
  const stableGeometry = []
  for (let index = 0; index < stableLocators.length; index += 1) {
    const locator = stableLocators[index]!
    const count = await locator.count()
    if (count !== 1) {
      throw new Error(`Acceptance screenshot stable locator ${index + 1} matched ${count} elements`)
    }
    const geometry = await locator.evaluate(element => {
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      return {
        rect: {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        },
        transform: style.transform,
        position: style.position,
        scroll: {
          left: element.scrollLeft,
          top: element.scrollTop,
          width: element.scrollWidth,
          height: element.scrollHeight,
          clientWidth: element.clientWidth,
          clientHeight: element.clientHeight,
        },
      }
    })
    stableGeometry.push({
      rect: Object.fromEntries(Object.entries(geometry.rect).map(([key, value]) => (
        [key, roundedLayoutValue(value)]
      ))),
      transform: geometry.transform,
      position: geometry.position,
      scroll: Object.fromEntries(Object.entries(geometry.scroll).map(([key, value]) => (
        [key, roundedLayoutValue(value)]
      ))),
    })
  }
  return { ...viewportAndScroll, stableGeometry }
}

export function createAcceptanceEvidence(outputDir: string, options: AcceptanceEvidenceOptions) {
  fs.mkdirSync(outputDir, { recursive: true })
  const manifestPath = path.join(outputDir, options.manifestFileName)
  let writeSequence = 0

  const writeManifest = async (screenshot: ScreenshotEvidence, temporaryScreenshotPath: string) => {
    const releaseLock = await acquireManifestLock(`${manifestPath}.lock`)
    let temporaryManifestPath = ''
    try {
      const manifest = readManifest(manifestPath, screenshot.runId)
      const previousIdentity = manifest.screenshots[0]
      if (
        previousIdentity
        && (
          previousIdentity.packageVersion !== screenshot.packageVersion
          || previousIdentity.gitSha !== screenshot.gitSha
          || previousIdentity.gitTreeSha !== screenshot.gitTreeSha
          || previousIdentity.dirty !== screenshot.dirty
          || previousIdentity.repositoryStateSha !== screenshot.repositoryStateSha
        )
      ) {
        throw new Error(`Repository identity changed within acceptance evidence run ${screenshot.runId}`)
      }
      const screenshots = new Map(manifest.screenshots.map(entry => [entry.screenshotName, entry]))
      screenshots.set(screenshot.screenshotName, screenshot)
      writeSequence += 1
      temporaryManifestPath = `${manifestPath}.${process.pid}.${writeSequence}.tmp`
      fs.renameSync(temporaryScreenshotPath, path.join(outputDir, screenshot.screenshotName))
      fs.writeFileSync(temporaryManifestPath, `${JSON.stringify({
        schemaVersion: 2,
        runId: screenshot.runId,
        screenshots: [...screenshots.values()],
      }, null, 2)}\n`)
      fs.renameSync(temporaryManifestPath, manifestPath)
    } finally {
      if (temporaryManifestPath) fs.rmSync(temporaryManifestPath, { force: true })
      releaseLock()
    }
  }

  return {
    manifestPath,
    async capture({
      page,
      testInfo,
      screenshotName,
      scenario,
      settledAssertion,
      assertReady,
      theme,
      proofLocator,
      expectedTestId,
      expectedHeading,
      stableLocators = [],
      target,
      fullPage = false,
    }: CaptureOptions) {
      if (!/\.png$/i.test(screenshotName) || path.basename(screenshotName) !== screenshotName) {
        throw new Error(`Acceptance screenshot name must be a plain PNG filename: ${screenshotName}`)
      }
      if (!settledAssertion.trim()) throw new Error('Acceptance screenshot requires a settled assertion')
      if (expectedTestId && !proofLocator) {
        throw new Error(`Acceptance screenshot ${screenshotName} is missing its proof locator`)
      }
      const playwrightProject = testInfo.project.name.trim()
      const testTitle = testInfo.title.trim()
      const browserName = page.context().browser()?.browserType().name() ?? ''
      const runId = acceptanceRunId(testInfo)
      if (!playwrightProject || !browserName || !testTitle) {
        throw new Error(`Acceptance screenshot ${screenshotName} is missing its Playwright identity`)
      }
      const repositoryBefore = repositoryIdentity()
      const assertProof = async (postCapture = false) => {
        if (!proofLocator) return
        if (postCapture) {
          if (!await proofLocator.isVisible()) {
            throw new Error(`Acceptance screenshot ${screenshotName} proof is no longer visible`)
          }
          if (expectedTestId && await proofLocator.getAttribute('data-testid') !== expectedTestId) {
            throw new Error(`Acceptance screenshot ${screenshotName} proof test ID changed`)
          }
          if (
            expectedHeading
            && !await proofLocator.getByRole('heading', { name: expectedHeading }).isVisible()
          ) {
            throw new Error(`Acceptance screenshot ${screenshotName} proof heading is no longer visible`)
          }
          return
        }
        await expect(proofLocator).toBeVisible()
        if (expectedTestId) {
          await expect(proofLocator).toHaveAttribute('data-testid', expectedTestId)
        }
        if (expectedHeading) {
          await expect(proofLocator.getByRole('heading', { name: expectedHeading }))
            .toBeVisible()
        }
      }
      await page.evaluate(() => new Promise<void>(resolve => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      }))

      const screenshotPath = path.join(outputDir, screenshotName)
      writeSequence += 1
      const temporaryScreenshotPath = `${screenshotPath}.${process.pid}.${writeSequence}.tmp.png`
      try {
        let stateBeforeCapture: Awaited<ReturnType<typeof captureState>>
        if (target) {
          await expect(target).toBeVisible()
          const centerTargetInScrollableAncestors = () => target.evaluate(element => {
            for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
              const style = getComputedStyle(ancestor)
              if (!/(auto|scroll)/.test(style.overflowY) || ancestor.scrollHeight <= ancestor.clientHeight) continue
              const elementRect = element.getBoundingClientRect()
              const ancestorRect = ancestor.getBoundingClientRect()
              const relativeTop = elementRect.top - ancestorRect.top + ancestor.scrollTop
              ancestor.scrollTop = Math.max(
                0,
                relativeTop - Math.max(0, (ancestor.clientHeight - elementRect.height) / 2),
              )
            }
          })
          let previousBox = ''
          let stableSamples = 0
          await expect.poll(async () => {
            await centerTargetInScrollableAncestors()
            const box = await target.boundingBox()
            const viewport = page.viewportSize()
            const insideViewport = Boolean(
              box
              && viewport
              && box.width <= viewport.width + 1
              && box.height <= viewport.height + 1
              && box.x >= 0
              && box.y >= 0
              && box.x + box.width <= viewport.width + 1
              && box.y + box.height <= viewport.height + 1,
            )
            if (!insideViewport) {
              previousBox = ''
              stableSamples = 0
              return stableSamples
            }
            const serialized = box
              ? [box.x, box.y, box.width, box.height].map(value => Math.round(value * 10) / 10).join(',')
              : ''
            stableSamples = serialized && serialized === previousBox ? stableSamples + 1 : 0
            previousBox = serialized
            return stableSamples
          }).toBeGreaterThanOrEqual(2)
          const targetBox = await target.boundingBox()
          const targetViewport = page.viewportSize()
          if (!targetBox || !targetViewport) {
            throw new Error(`Acceptance screenshot ${screenshotName} target is not measurable`)
          }
          if (
            targetBox.width > targetViewport.width + 1
            || targetBox.height > targetViewport.height + 1
            || targetBox.x < 0
            || targetBox.y < 0
            || targetBox.x + targetBox.width > targetViewport.width + 1
            || targetBox.y + targetBox.height > targetViewport.height + 1
          ) {
            throw new Error(
              `Acceptance screenshot ${screenshotName} target is outside the viewport: ${JSON.stringify(targetBox)}`,
            )
          }
          await assertReady?.()
          await assertProof()
          stateBeforeCapture = await captureState(page, stableLocators)
          const pageOffset = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }))
          await page.screenshot({
            path: temporaryScreenshotPath,
            clip: {
              x: targetBox.x + pageOffset.x,
              y: targetBox.y + pageOffset.y,
              width: targetBox.width,
              height: targetBox.height,
            },
            animations: 'disabled',
            scale: 'css',
          })
          const finalBox = await target.boundingBox()
          expect(finalBox && [finalBox.x, finalBox.y, finalBox.width, finalBox.height]
            .map(value => Math.round(value * 10) / 10),
          ).toEqual(
            [targetBox.x, targetBox.y, targetBox.width, targetBox.height]
              .map(value => Math.round(value * 10) / 10),
          )
        } else {
          await assertReady?.()
          await assertProof()
          stateBeforeCapture = await captureState(page, stableLocators)
          await page.screenshot({
            path: temporaryScreenshotPath,
            fullPage,
            animations: 'disabled',
            scale: 'css',
          })
        }

        await assertReady?.()
        await assertProof(true)
        if (target && !await target.isVisible()) {
          throw new Error(`Acceptance screenshot ${screenshotName} target is no longer visible`)
        }
        const stateAfterCapture = await captureState(page, stableLocators)
        expect(
          stateAfterCapture,
          `Acceptance screenshot ${screenshotName} capture state changed`,
        ).toEqual(stateBeforeCapture)

        const repositoryAfter = repositoryIdentity()
        if (!sameRepositoryIdentity(repositoryBefore, repositoryAfter)) {
          throw new Error(`Repository identity changed while capturing acceptance screenshot ${screenshotName}`)
        }
        const viewport = page.viewportSize()
        if (!viewport) throw new Error(`Acceptance screenshot ${screenshotName} has no viewport metadata`)
        const resolvedTheme = theme
          ?? await page.locator('body').getAttribute('data-appearance')
          ?? 'light'
        await writeManifest({
          runId,
          ...repositoryAfter,
          ...pngMetadata(temporaryScreenshotPath),
          baseUrlClass: baseUrlClass(page.url()),
          playwrightProject,
          browserName,
          testTitle,
          viewport,
          theme: resolvedTheme,
          scenario,
          screenshotName,
          settledAssertion,
          timestamp: new Date().toISOString(),
        }, temporaryScreenshotPath)
        return screenshotPath
      } finally {
        fs.rmSync(temporaryScreenshotPath, { force: true })
      }
    },
  }
}
