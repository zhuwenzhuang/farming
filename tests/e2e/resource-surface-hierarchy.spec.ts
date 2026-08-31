import fs from 'node:fs'
import path from 'node:path'
import type { Locator, Page, TestInfo } from '@playwright/test'
import { expect, openFarming, openNewAgentDialog, startAgentFromOpenDialog, test } from './fixtures'
import { setupComputerRoutes } from './computer-surface-fixture'

const { PNG: ScreenshotPng } = require('playwright-core/lib/utilsBundle') as {
  PNG: {
    sync: {
      read: (buffer: Buffer) => { width: number; height: number; data: Uint8Array }
    }
  }
}

type Appearance = 'light' | 'dark' | 'paper'


async function setAppearance(page: Page, appearance: Appearance) {
  await page.emulateMedia({
    colorScheme: appearance === 'dark' ? 'dark' : 'light',
    reducedMotion: 'reduce',
  })
  await page.evaluate(nextAppearance => {
    document.documentElement.dataset.appearance = nextAppearance
    document.body.dataset.appearance = nextAppearance
  }, appearance)
  await page.waitForTimeout(150)
}

/**
 * Resolve a CSS custom property exactly where a component consumes it.
 *
 * The probe element is appended inside the target element, so it inherits the
 * scoped token value at that point in the cascade. A body-level probe would
 * miss the `.code-workspace` compact override of `--code-navigation-surface`
 * and any row-local custom property such as `--code-agent-row-surface`.
 */
async function tokenColorAt(target: Locator, cssVariable: string) {
  return target.evaluate((element, variable) => {
    const probe = document.createElement('span')
    probe.style.position = 'absolute'
    probe.style.visibility = 'hidden'
    probe.style.color = `var(${variable})`
    element.appendChild(probe)
    const color = getComputedStyle(probe).color
    probe.remove()
    return color
  }, cssVariable)
}

async function background(locator: Locator) {
  return locator.evaluate(element => getComputedStyle(element).backgroundColor)
}

async function color(locator: Locator) {
  return locator.evaluate(element => getComputedStyle(element).color)
}

async function cursorOf(locator: Locator) {
  return locator.evaluate(element => getComputedStyle(element).cursor)
}

function parseColor(value: string) {
  const match = value.match(/rgba?\(([^)]+)\)/)
  if (!match) throw new Error(`Unparseable color: ${value}`)
  const channels = match[1].split(',').map(part => Number(part.trim()))
  return {
    r: channels[0] ?? 0,
    g: channels[1] ?? 0,
    b: channels[2] ?? 0,
    a: channels.length > 3 ? (channels[3] ?? 1) : 1,
  }
}

/** Alpha-composite `over` on top of `under` and return the final rgb() string. */
function compositeOver(over: string, under: string) {
  const top = parseColor(over)
  const bottom = parseColor(under)
  const alpha = Math.max(0, Math.min(1, top.a))
  const blend = (channelTop: number, channelBottom: number) =>
    Math.round(channelTop * alpha + channelBottom * (1 - alpha))
  return `rgb(${blend(top.r, bottom.r)}, ${blend(top.g, bottom.g)}, ${blend(top.b, bottom.b)})`
}

function samplePixel(screenshot: Buffer, x: number, y: number) {
  const image = ScreenshotPng.sync.read(screenshot)
  const clampedX = Math.max(0, Math.min(image.width - 1, Math.round(x)))
  const clampedY = Math.max(0, Math.min(image.height - 1, Math.round(y)))
  const offset = (clampedY * image.width + clampedX) * 4
  return {
    r: image.data[offset] ?? 0,
    g: image.data[offset + 1] ?? 0,
    b: image.data[offset + 2] ?? 0,
  }
}

function expectChannelsClose(actual: { r: number; g: number; b: number }, expected: string, tolerance: number, label: string) {
  const target = parseColor(expected)
  expect(Math.abs(actual.r - target.r), `${label}: red channel`).toBeLessThanOrEqual(tolerance)
  expect(Math.abs(actual.g - target.g), `${label}: green channel`).toBeLessThanOrEqual(tolerance)
  expect(Math.abs(actual.b - target.b), `${label}: blue channel`).toBeLessThanOrEqual(tolerance)
}

async function attachScreenshot(testInfo: TestInfo, name: string, screenshot: Buffer) {
  const image = ScreenshotPng.sync.read(screenshot)
  await testInfo.attach(`${name} (${image.width}x${image.height})`, {
    body: screenshot,
    contentType: 'image/png',
  })
  // Disk persistence is opt-in for acceptance runs only; ordinary runs keep
  // the attachment in the reporter, matching appearance-color-regression.
  const evidenceRoot = process.env.FARMING_VISUAL_EVIDENCE_DIR
  if (evidenceRoot) {
    const evidenceDir = path.join(evidenceRoot, testInfo.title.replace(/[^a-z0-9]+/gi, '-'))
    fs.mkdirSync(evidenceDir, { recursive: true })
    fs.writeFileSync(path.join(evidenceDir, `${name}.png`), screenshot)
  }
  return { width: image.width, height: image.height }
}


/**
 * Real creation flow: the resources toggle only exists once the Agent owns a
 * resource, so this follows computer-resources.spec.ts and creates the Desktop
 * through the Agent context menu instead of assuming a pre-seeded toggle.
 * Creation opens the Computer viewer and marks the row active.
 */
async function createDesktopThroughContextMenu(page: Page, agentRow: Locator) {
  await expect(agentRow.getByTestId('code-agent-resources-toggle')).toHaveCount(0)
  await agentRow.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Create Desktop in Docker (Experimental)' }).click()
  const resourcesToggle = agentRow.getByTestId('code-agent-resources-toggle')
  await expect(resourcesToggle).toBeVisible({ timeout: 10_000 })
  // Row actions only take pointer events while the row is hovered.
  await agentRow.hover()
  await resourcesToggle.click()
}

async function createSecondAgent(page: Page, workspace: string) {
  fs.mkdirSync(workspace, { recursive: true })
  const response = await page.request.post('/farming/api/control/agents', {
    data: { command: 'bash', workspace },
  })
  expect(response.ok()).toBeTruthy()
  const payload = await response.json() as { agentId?: string }
  expect(payload.agentId).toBeTruthy()
  const row = page.locator(`[data-testid="code-agent-row"][data-agent-id="${payload.agentId}"]`)
  await expect(row).toBeVisible({ timeout: 15_000 })
  return row
}

test('expanded Agent resources consume the navigation and active-item tokens in Light/Dark/Paper, regular and compact', async ({
  page,
  workspaceRoot,
}, testInfo) => {
  const workspace = path.join(workspaceRoot, 'resource-surface-hierarchy')
  fs.mkdirSync(workspace, { recursive: true })
  const { routes } = setupComputerRoutes(page, workspace)
  await routes.install()

  await openFarming(page)
  await openNewAgentDialog(page)
  const agentId = await startAgentFromOpenDialog(page, 'bash', workspace)
  const agentRow = page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
  await createDesktopThroughContextMenu(page, agentRow)

  const resourceSlot = page.locator(`[data-testid="code-agent-resource-slot"][data-agent-id="${agentId}"]`)
  const computerSection = resourceSlot.getByTestId('farming-computer-section')
  const computerRow = computerSection.getByTestId('farming-computer-row')
  const resourceHeader = computerSection.locator('.code-sidebar-resource-header')
  const resourceActions = computerRow.locator('.farming-computer-actions')
  const sidebar = page.getByTestId('code-sidebar')
  const workspaceEl = page.getByTestId('code-workspace')
  const viewer = page.getByTestId('farming-computer-viewer')

  await expect(computerSection).toBeVisible()
  await expect(computerRow).toHaveClass(/code-sidebar-resource-row/)
  await expect(computerRow).toContainText('Hierarchy Desktop')
  await expect(computerRow).toHaveCSS('border-radius', '8px')

  // Creation opens the viewer: the row starts selected (active).
  await expect(viewer).toBeVisible({ timeout: 10_000 })
  await expect(computerRow).toHaveClass(/active/)

  // A second Agent row provides a genuine idle row in the same collection.
  const idleAgentRow = await createSecondAgent(page, path.join(workspaceRoot, 'resource-surface-hierarchy-b'))

  // Return through the real Back path so the Computer row becomes idle again.
  await viewer.getByRole('button', { name: 'Back to Agent' }).click()
  await expect(viewer).toBeHidden({ timeout: 10_000 })
  await expect(computerRow).not.toHaveClass(/active/)
  await page.mouse.move(5, 5)

  for (const appearance of ['light', 'dark', 'paper'] as const) {
    await setAppearance(page, appearance)

    // Scoped token reads: the probe lives inside the real element, so the
    // workspace-level navigation-surface mapping is what gets resolved.
    const navigationSurface = await tokenColorAt(workspaceEl, '--code-navigation-surface')
    const chromeSurface = await tokenColorAt(workspaceEl, '--code-bg-chrome')
    const activeItemSurface = await tokenColorAt(workspaceEl, '--code-active-item-surface')
    const textRole = await tokenColorAt(computerRow, '--code-text')
    const mutedRole = await tokenColorAt(computerRow, '--code-text-muted')
    expect(navigationSurface, `${appearance} regular navigation maps to chrome`).toBe(chromeSurface)

    // Sidebar, section header, and idle rows share one navigation surface.
    expect(await background(sidebar), `${appearance} sidebar must sit on the navigation surface`).toBe(navigationSurface)
    expect(await background(resourceHeader), `${appearance} resource header must not paint a second surface`).toBe(navigationSurface)
    expect(await background(computerRow), `${appearance} idle resource row must stay transparent on the navigation surface`).toBe('rgba(0, 0, 0, 0)')

    // Idle text hierarchy: the muted Agent-row baseline
    // (agent-list.css `.code-agent-row` idle color contract), verified
    // against a real idle Agent row in the same collection.
    expect(await color(computerRow), `${appearance} idle resource row text must use the muted baseline`).toBe(mutedRole)
    expect(await color(computerRow), `${appearance} idle resource row must match the idle Agent row hierarchy`).toBe(await color(idleAgentRow))
    expect(mutedRole).not.toBe(textRole)

    // Row-local action variables resolve on the row itself. Assert the
    // resolved colors, never the raw var() serialization: browsers substitute
    // custom properties at computed-value time, so the returned string is an
    // implementation detail. Resolved tokens + painted gradient layers +
    // rendered pixels are the product contract.
    expect(await tokenColorAt(computerRow, '--code-sidebar-resource-row-action-surface'), 'row action surface must resolve to the navigation token').toBe(navigationSurface)
    expect(await tokenColorAt(computerRow, '--code-sidebar-resource-row-action-overlay'), 'idle overlay must resolve to transparent').toBe('rgba(0, 0, 0, 0)')
    const idleComposited = await resourceActions.evaluate(element => getComputedStyle(element).backgroundImage)
    const idleLayers = [...idleComposited.matchAll(/linear-gradient\((rgba?\([^)]+\))/g)].map(match => match[1])
    expect(idleLayers.length, 'idle actions must keep the two-layer surface composition').toBe(2)
    expect(idleLayers[0], 'idle overlay layer must resolve to transparent').toBe('rgba(0, 0, 0, 0)')
    expect(idleLayers[1], 'idle surface layer must resolve to the navigation surface').toBe(navigationSurface)

    // Hover uses the shared opaque active-item surface (same as Agent rows).
    await computerRow.hover()
    expect(await background(computerRow), `${appearance} hover surface must be the active-item token`).toBe(activeItemSurface)
    expect(await color(computerRow), `${appearance} hover text must strengthen to the text role`).toBe(textRole)
    await idleAgentRow.hover()
    expect(await background(idleAgentRow), `${appearance} Agent hover must share the same active-item surface`).toBe(activeItemSurface)
    await page.mouse.move(5, 5)

    // Composited actions layer. Parse complete rgb() tokens (never split on
    // commas inside rgb()), then prove the final composited color: overlay
    // alpha-composited onto the surface layer must equal the row's own hover
    // background, and a rendered pixel inside the actions zone must match.
    await computerRow.hover()
    await expect(resourceActions).toBeVisible()
    expect(await tokenColorAt(computerRow, '--code-sidebar-resource-row-action-overlay'), 'hover overlay must resolve to the active-item surface').toBe(activeItemSurface)
    const composited = await resourceActions.evaluate(element => getComputedStyle(element).backgroundImage)
    const layerColors = [...composited.matchAll(/linear-gradient\((rgba?\([^)]+\))/g)].map(match => match[1])
    expect(layerColors.length, `${appearance} actions must keep the two-layer surface composition`).toBe(2)
    const [overlayPaint, surfacePaint] = layerColors as [string, string]
    expect(overlayPaint, `${appearance} overlay layer must resolve to the active-item surface`).toBe(activeItemSurface)
    expect(surfacePaint, `${appearance} surface layer must resolve to the navigation surface`).toBe(navigationSurface)
    const compositedFinal = compositeOver(overlayPaint, surfacePaint)
    expect(compositedFinal, `${appearance} final composited actions color must equal the row hover surface`).toBe(activeItemSurface)
    expect(compositedFinal).toBe(await background(computerRow))

    const rowBox = await computerRow.boundingBox()
    const actionsBox = await resourceActions.boundingBox()
    expect(rowBox && actionsBox, 'row and actions boxes must exist').toBeTruthy()
    if (rowBox && actionsBox) {
      expect(actionsBox.x).toBeGreaterThanOrEqual(rowBox.x)
      expect(actionsBox.y).toBeGreaterThanOrEqual(rowBox.y)
      expect(actionsBox.x + actionsBox.width).toBeLessThanOrEqual(rowBox.x + rowBox.width + 0.5)
      expect(actionsBox.y + actionsBox.height).toBeLessThanOrEqual(rowBox.y + rowBox.height + 0.5)
    }

    // Rendered pixel proof: sample inside the actions zone's button-free left
    // band (actions are 65px wide at right:4; buttons occupy the right 47px).
    const rowShot = await computerRow.screenshot()
    const shotSize = ScreenshotPng.sync.read(rowShot)
    const scale = rowBox ? shotSize.width / rowBox.width : 1
    const sampleX = rowBox ? (rowBox.width - 60) * scale : 0
    const sampleY = rowBox ? (rowBox.height / 2) * scale : 0
    expectChannelsClose(samplePixel(rowShot, sampleX, sampleY), compositedFinal, 8, `${appearance} rendered actions pixel`)
    await attachScreenshot(testInfo, `resource-row-hover-${appearance}-regular`, rowShot)
    await page.mouse.move(5, 5)

    // Selected row (real click): same opaque surface, same text role, no accent text.
    await computerRow.click()
    await expect(viewer).toBeVisible({ timeout: 10_000 })
    await expect(computerRow).toHaveClass(/active/)
    expect(await background(computerRow), `${appearance} selected surface must equal the hover surface`).toBe(activeItemSurface)
    expect(await color(computerRow), `${appearance} selected text must use the text role, not the accent`).toBe(textRole)

    // Evidence: expanded section with the selected row per appearance.
    const sectionShot = await computerSection.screenshot()
    await attachScreenshot(testInfo, `resource-section-${appearance}-regular-active`, sectionShot)
    const sidebarShot = await sidebar.screenshot()
    await attachScreenshot(testInfo, `sidebar-${appearance}-regular-active`, sidebarShot)

    // Back to idle for the next appearance.
    await viewer.getByRole('button', { name: 'Back to Agent' }).click()
    await expect(viewer).toBeHidden({ timeout: 10_000 })
    await expect(computerRow).not.toHaveClass(/active/)
  }

  // Compact layout: the workspace remaps navigation-surface to panel-surface.
  // Every consumer must follow that scoped remap (this is the reported
  // "pure white bar" regression: header/rows previously pinned bg-chrome).
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.locator('body')).toHaveClass(/code-compact-layout/, { timeout: 10_000 })
  await page.getByTestId('code-mobile-menu').click()
  await expect(sidebar).toBeVisible()

  for (const appearance of ['light', 'dark', 'paper'] as const) {
    await setAppearance(page, appearance)
    const navigationSurface = await tokenColorAt(workspaceEl, '--code-navigation-surface')
    const panelSurface = await tokenColorAt(workspaceEl, '--code-panel-surface')
    const chromeSurface = await tokenColorAt(workspaceEl, '--code-bg-chrome')
    const activeItemSurface = await tokenColorAt(workspaceEl, '--code-active-item-surface')
    expect(navigationSurface, `${appearance} compact navigation must remap to the panel surface`).toBe(panelSurface)
    if (panelSurface !== chromeSurface) {
      expect(navigationSurface).not.toBe(chromeSurface)
    }
    expect(await background(sidebar), `${appearance} compact sidebar must sit on the panel surface`).toBe(navigationSurface)
    expect(await background(resourceHeader), `${appearance} compact header must follow the panel remap, not chrome`).toBe(navigationSurface)
    expect(await background(computerRow)).toBe('rgba(0, 0, 0, 0)')
    expect(await color(computerRow), `${appearance} compact idle text must keep the muted baseline`).toBe(await tokenColorAt(computerRow, '--code-text-muted'))
    await computerRow.hover()
    expect(await background(computerRow), `${appearance} compact hover must stay on the active-item surface`).toBe(activeItemSurface)
    expect(await color(computerRow)).toBe(await tokenColorAt(computerRow, '--code-text'))
    await page.mouse.move(5, 5)

    const compactShot = await sidebar.screenshot()
    await attachScreenshot(testInfo, `sidebar-${appearance}-compact`, compactShot)
  }
})

test('resource row focus feedback, Space activation, cursor parity, and touch targets', async ({
  page,
  workspaceRoot,
}, testInfo) => {
  const workspace = path.join(workspaceRoot, 'resource-interaction-audit')
  fs.mkdirSync(workspace, { recursive: true })
  const { routes } = setupComputerRoutes(page, workspace)
  await routes.install()

  await openFarming(page)
  await openNewAgentDialog(page)
  const agentId = await startAgentFromOpenDialog(page, 'bash', workspace)
  const agentRow = page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
  await createDesktopThroughContextMenu(page, agentRow)

  const resourceSlot = page.locator(`[data-testid="code-agent-resource-slot"][data-agent-id="${agentId}"]`)
  const computerSection = resourceSlot.getByTestId('farming-computer-section')
  const computerRow = computerSection.getByTestId('farming-computer-row')
  const sectionToggle = computerSection.locator('.code-sidebar-resource-section-toggle')
  const sidebar = page.getByTestId('code-sidebar')
  const viewer = page.getByTestId('farming-computer-viewer')
  await expect(computerRow).toBeVisible()

  // Creation opens the viewer with the row active. Restore a true idle state
  // through the real Back path BEFORE any focus-visibility comparison, so a
  // selected-row background cannot masquerade as focus feedback.
  await expect(viewer).toBeVisible({ timeout: 10_000 })
  await viewer.getByRole('button', { name: 'Back to Agent' }).click()
  await expect(viewer).toBeHidden({ timeout: 10_000 })
  await expect(computerRow).not.toHaveClass(/active/)
  await page.mouse.move(5, 5)

  // --- Clickable row cursor: shared pointer contract with Agent rows -------
  expect(await cursorOf(computerRow), 'clickable resource row must use the pointer cursor').toBe('pointer')
  expect(await cursorOf(computerRow)).toBe(await cursorOf(agentRow))

  // --- focus-visible fill feedback on an idle row --------------------------
  // Keyboard focus keeps the shared active-item surface + text hierarchy used
  // by hover and selection, without a competing perimeter in any appearance.
  // Compare the exact same row before/after.
  const idleAgentRow = await createSecondAgent(page, path.join(workspaceRoot, 'resource-interaction-audit-b'))
  for (const appearance of ['light', 'dark', 'paper'] as const) {
    await setAppearance(page, appearance)

    const before = {
      background: await background(computerRow),
      color: await color(computerRow),
    }
    expect(before.background, `${appearance} row must be idle (transparent) before focus`).toBe('rgba(0, 0, 0, 0)')

    await sectionToggle.focus()
    await page.keyboard.press('Tab')
    await expect(computerRow).toBeFocused()

    const activeItemSurface = await tokenColorAt(computerRow, '--code-active-item-surface')
    const textRole = await tokenColorAt(computerRow, '--code-text')
    const after = {
      background: await background(computerRow),
      color: await color(computerRow),
    }
    expect(after.background, `${appearance} focus must paint the shared active-item surface`).toBe(activeItemSurface)
    expect(after.color, `${appearance} focus must strengthen to the text role`).toBe(textRole)
    expect(after.background).not.toBe(before.background)
    expect(after.color).not.toBe(before.color)
    await expect(computerRow).toHaveCSS('outline-style', 'none')
    await expect(computerRow).toHaveCSS('box-shadow', 'none')
    const focusShot = await computerRow.screenshot()
    await attachScreenshot(testInfo, `resource-row-focus-${appearance}`, focusShot)
    await computerRow.evaluate(element => element.blur())
    await page.mouse.move(5, 5)

    // Same-collection parity: an idle Agent row gets the identical focus fill.
    expect(await background(idleAgentRow), `${appearance} idle Agent row starts transparent`).toBe('rgba(0, 0, 0, 0)')
    await page.keyboard.press('Tab')
    await idleAgentRow.evaluate(element => element.focus())
    await expect(idleAgentRow).toBeFocused()
    expect(await background(idleAgentRow), `${appearance} idle Agent row focus must paint the same active-item surface`).toBe(activeItemSurface)
    expect(await color(idleAgentRow), `${appearance} focused Agent row text must use the text role`).toBe(textRole)
    const agentFocusShot = await idleAgentRow.screenshot()
    await attachScreenshot(testInfo, `agent-row-focus-${appearance}`, agentFocusShot)
    await idleAgentRow.evaluate(element => element.blur())
    await page.mouse.move(5, 5)
  }

  // --- Space key: activation must not scroll (BrowserRow parity) ----------
  await sectionToggle.focus()
  await page.keyboard.press('Tab')
  await expect(computerRow).toBeFocused()
  const scrollProbe = await computerRow.evaluate(element => {
    let current: HTMLElement | null = element
    while (current) {
      if (current.scrollHeight > current.clientHeight + 1) {
        return { found: true, scrollTop: current.scrollTop }
      }
      current = current.parentElement
    }
    return { found: false, scrollTop: 0 }
  })
  await page.evaluate(() => {
    const target = document.documentElement
    target.dataset.spaceAudit = JSON.stringify({ sawSpace: false, defaultPrevented: false })
    document.addEventListener('keydown', event => {
      if (event.key !== ' ') return
      target.dataset.spaceAudit = JSON.stringify({ sawSpace: true, defaultPrevented: event.defaultPrevented })
    }, { capture: false })
  })
  await page.keyboard.press(' ')
  await expect(viewer).toBeVisible({ timeout: 10_000 })
  const spaceAudit = JSON.parse(await page.evaluate(() => document.documentElement.dataset.spaceAudit || '')) as {
    sawSpace: boolean
    defaultPrevented: boolean
  }
  expect(spaceAudit.sawSpace).toBe(true)
  expect(spaceAudit.defaultPrevented, 'Space activation must call preventDefault so the page does not scroll (BrowserRow parity)').toBe(true)
  if (scrollProbe.found) {
    const scrollTopAfter = await computerRow.evaluate(element => {
      let current: HTMLElement | null = element
      while (current) {
        if (current.scrollHeight > current.clientHeight + 1) return current.scrollTop
        current = current.parentElement
      }
      return 0
    })
    expect(scrollTopAfter, 'scroll container must not move on Space activation').toBe(scrollProbe.scrollTop)
  }

  // --- Touch targets: rows meet WCAG AA minimum; density stays consistent --
  await viewer.getByRole('button', { name: 'Back to Agent' }).click()
  await expect(viewer).toBeHidden({ timeout: 10_000 })
  const rowBox = await computerRow.boundingBox()
  expect(rowBox?.height ?? 0, 'resource row must meet the 24px WCAG 2.5.8 minimum').toBeGreaterThanOrEqual(24)
  const toggleBox = await sectionToggle.boundingBox()
  const agentActionBox = await agentRow.locator('.code-agent-row-action').first().boundingBox()
  if (toggleBox && agentActionBox) {
    testInfo.annotations.push({
      type: 'measured-density',
      description: `regular: section toggle ${toggleBox.height}px vs Agent row action ${agentActionBox.height}px`,
    })
  }

  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.locator('body')).toHaveClass(/code-compact-layout/, { timeout: 10_000 })
  await page.getByTestId('code-mobile-menu').click()
  await expect(sidebar).toBeVisible()
  const compactRowBox = await computerRow.boundingBox()
  expect(compactRowBox?.height ?? 0, 'compact resource row must use the shared 44px touch target').toBeGreaterThanOrEqual(44)
  const compactAgentBox = await agentRow.boundingBox()
  testInfo.annotations.push({
    type: 'measured-density',
    description: `compact: resource row ${compactRowBox?.height}px, Agent row ${compactAgentBox?.height}px (Agent and Resource rows share the 44px touch contract; dense file rows keep their separate 28px variant)`,
  })

  // Compact density focus check: the same fill contract holds in the drawer.
  for (const appearance of ['light', 'dark', 'paper'] as const) {
    await setAppearance(page, appearance)
    await page.mouse.move(5, 5)
    expect(await background(computerRow), `${appearance} compact row must be idle before focus`).toBe('rgba(0, 0, 0, 0)')
    await sectionToggle.focus()
    await page.keyboard.press('Tab')
    await expect(computerRow).toBeFocused()
    expect(await background(computerRow), `${appearance} compact focus must paint the active-item surface`).toBe(await tokenColorAt(computerRow, '--code-active-item-surface'))
    expect(await color(computerRow), `${appearance} compact focus text must use the text role`).toBe(await tokenColorAt(computerRow, '--code-text'))
    const compactFocusShot = await computerRow.screenshot()
    await attachScreenshot(testInfo, `resource-row-focus-${appearance}-compact`, compactFocusShot)
    await computerRow.evaluate(element => element.blur())
    await page.mouse.move(5, 5)
  }
})
