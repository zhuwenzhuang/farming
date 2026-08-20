import fs from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { expect, openFarming, test } from './fixtures'
import { encodeProviderSessionKey } from '../../shared/provider-session-identity'

async function resizeSidebar(page: Page, width: number) {
  const sidebar = page.getByTestId('code-sidebar')
  const sidebarBox = await sidebar.boundingBox()
  const resizerBox = await page.getByTestId('code-sidebar-resizer').boundingBox()
  if (!sidebarBox || !resizerBox) throw new Error('Sidebar resize handles are unavailable')

  const pointerY = resizerBox.y + Math.min(120, resizerBox.height / 2)
  await page.mouse.move(resizerBox.x + resizerBox.width / 2, pointerY)
  await page.mouse.down()
  await page.mouse.move(sidebarBox.x + width, pointerY)
  await page.mouse.up()
  await expect.poll(async () => Math.round((await sidebar.boundingBox())?.width ?? 0)).toBe(width)
}

test('ends sidebar resize when a released mouse re-enters without pointerup', async ({ page }) => {
  await openFarming(page)
  const sidebar = page.getByTestId('code-sidebar')
  const resizer = page.getByTestId('code-sidebar-resizer')
  const resizerBox = await resizer.boundingBox()
  if (!resizerBox) throw new Error('Sidebar resize handle is unavailable')
  const pointerY = resizerBox.y + Math.min(120, resizerBox.height / 2)
  await resizer.evaluate(element => {
    element.addEventListener('pointerdown', event => {
      element.setAttribute('data-test-pointer-id', String(event.pointerId))
    }, { once: true })
  })
  await page.mouse.move(resizerBox.x + resizerBox.width / 2, pointerY)
  await page.mouse.down()
  const pointerId = Number(await resizer.getAttribute('data-test-pointer-id'))
  expect(await resizer.evaluate((element, id) => element.hasPointerCapture(id), pointerId)).toBe(true)

  await resizer.dispatchEvent('pointermove', {
    pointerId,
    pointerType: 'mouse',
    isPrimary: true,
    buttons: 0,
    clientX: resizerBox.x + 80,
    clientY: pointerY,
  })
  await expect(page.locator('body')).not.toHaveClass(/code-resizing-sidebar/)
  const releasedWidth = Math.round((await sidebar.boundingBox())?.width ?? 0)

  await resizer.dispatchEvent('pointermove', {
    pointerId,
    pointerType: 'mouse',
    isPrimary: true,
    buttons: 0,
    clientX: resizerBox.x - 80,
    clientY: pointerY,
  })
  await expect.poll(async () => Math.round((await sidebar.boundingBox())?.width ?? 0)).toBe(releasedWidth)
  await page.mouse.up()
})

async function rowProjection(row: ReturnType<Page['locator']>) {
  return row.evaluate(element => {
    const title = element.querySelector<HTMLElement>('.code-agent-name')
    const provider = element.querySelector<HTMLElement>('.code-agent-row-provider-icon')
    const age = element.querySelector<HTMLElement>('.code-agent-relative-age')
    const detail = element.querySelector<HTMLElement>('.code-agent-meta')
    const sidebar = element.closest<HTMLElement>('.code-sidebar')
    if (!title || !provider || !age || !detail) throw new Error('Responsive Agent row fields are missing')
    const titleStyle = getComputedStyle(title)
    const providerIcon = provider.querySelector<HTMLElement>('.agent-launch-icon')
    const rowRect = (element as HTMLElement).getBoundingClientRect()
    const sidebarRect = sidebar?.getBoundingClientRect()
    return {
      rowHeight: Math.round(rowRect.height),
      rowRightGap: sidebarRect ? Math.round(sidebarRect.right - rowRect.right) : Number.POSITIVE_INFINITY,
      title: title.textContent,
      titleClientWidth: Math.round(title.getBoundingClientRect().width),
      titleScrollWidth: title.scrollWidth,
      titleTextOverflow: titleStyle.textOverflow,
      titleMaskImage: titleStyle.maskImage || titleStyle.getPropertyValue('-webkit-mask-image'),
      providerDisplay: getComputedStyle(provider).display,
      providerIconSize: providerIcon ? Math.round(providerIcon.getBoundingClientRect().width) : 0,
      titleFontSize: Number.parseFloat(titleStyle.fontSize),
      ageDisplay: getComputedStyle(age).display,
      detailDisplay: getComputedStyle(detail).display,
      detail: detail.textContent,
    }
  })
}

test('reveals more Agent row information as the sidebar widens', async ({ page, workspaceRoot }) => {
  const projectDir = path.join(workspaceRoot, 'responsive-agent-row')
  fs.mkdirSync(projectDir, { recursive: true })
  const longTitle = 'public static void main(String[] args) — verify adaptive Agent row information'

  await openFarming(page)
  const createResponse = await page.request.post('/farming/api/control/agents', {
    data: { command: 'bash', workspace: projectDir },
  })
  expect(createResponse.ok()).toBeTruthy()
  const { agentId } = await createResponse.json() as { agentId: string }
  expect(agentId).toBeTruthy()

  const renameResponse = await page.request.patch(`/farming/api/agents/${agentId}`, {
    data: { customTitle: longTitle },
  })
  expect(renameResponse.ok()).toBeTruthy()

  const row = page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
  const title = row.locator('.code-agent-name')
  await expect(title).toHaveText(longTitle)
  await expect(row.getByTestId('code-agent-row-age')).toHaveCount(1)

  const compact = await rowProjection(row)
  expect(compact.titleScrollWidth).toBeGreaterThan(compact.titleClientWidth)
  expect(compact.titleTextOverflow).toBe('clip')
  expect(compact.titleMaskImage).toContain('linear-gradient')
  expect(compact.providerDisplay).toBe('none')
  expect(compact.ageDisplay).toBe('none')
  expect(compact.detailDisplay).toBe('none')

  await row.hover()
  const actionCover = await row.locator('.code-agent-row-actions').evaluate(element => {
    const style = getComputedStyle(element)
    return {
      backgroundImage: style.backgroundImage,
      maskImage: style.maskImage || style.getPropertyValue('-webkit-mask-image'),
    }
  })
  expect(actionCover.backgroundImage.match(/linear-gradient/g)).toHaveLength(1)
  expect(actionCover.maskImage).toBe('none')
  const titleCard = page.getByTestId('code-agent-hover-title-card')
  const agentPreview = page.getByTestId('code-agent-hover-preview')
  await expect(titleCard).toBeVisible()
  await expect(agentPreview.getByTestId('code-agent-hover-preview-home')).toHaveCount(0)
  await expect(titleCard).toHaveText(longTitle)
  await expect(titleCard).toHaveCSS('font-size', '14px')
  await expect(titleCard).toHaveCSS('font-weight', '400')
  expect(await agentPreview.evaluate(element => {
    const probe = document.createElement('span')
    probe.style.color = getComputedStyle(element).getPropertyValue('--code-bg-raised')
    element.append(probe)
    const expected = getComputedStyle(probe).color
    probe.remove()
    return getComputedStyle(element).backgroundColor === expected
  })).toBe(true)
  const previewBox = await agentPreview.boundingBox()
  const titleCardBox = await titleCard.boundingBox()
  expect(previewBox).not.toBeNull()
  expect(titleCardBox).not.toBeNull()
  expect(titleCardBox!.x).toBeGreaterThanOrEqual(previewBox!.x - 1)
  expect(titleCardBox!.y).toBeGreaterThan(previewBox!.y + previewBox!.height)
  expect(titleCardBox!.y - (previewBox!.y + previewBox!.height)).toBeLessThan(12)
  await expect(titleCard).toHaveCSS('background-color', await agentPreview.evaluate(element => getComputedStyle(element).backgroundColor))
  await page.mouse.move(1000, 100)
  await expect(titleCard).toHaveCount(0)

  const projectGroup = page.getByTestId('code-project-group').filter({ has: row })
  const projectRow = projectGroup.locator('.code-project-row')
  await projectGroup.getByTestId('code-project-title').hover()
  await projectGroup.getByTestId('code-project-actions').click()
  const projectMenu = page.getByTestId('code-project-context-menu')
  await expect(projectMenu).toBeVisible()
  const pinProject = projectMenu.getByRole('menuitem', { name: 'Pin project' })
  await expect(pinProject).not.toBeFocused()
  await expect(pinProject.locator('svg[data-icon-kind="pin"]')).toHaveCount(1)
  await page.keyboard.press('ArrowDown')
  await expect(pinProject).toBeFocused()
  await row.hover()
  // The preview must remain suppressed for the menu's full hover-suppression window.
  await page.waitForTimeout(1700)
  await expect(page.getByTestId('code-agent-hover-title-card')).toHaveCount(0)
  await expect(page.getByTestId('code-agent-hover-preview')).toHaveCount(0)
  await projectGroup.getByTestId('code-project-title').hover()
  // The project preview uses the same deliberate hover-suppression window.
  await page.waitForTimeout(1700)
  await expect(page.getByTestId('code-project-hover-preview')).toHaveCount(0)
  await page.keyboard.press('Escape')
  const projectActions = projectGroup.getByTestId('code-project-actions')
  await expect(projectActions).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(projectMenu).toBeVisible()
  await expect(pinProject).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(projectActions).toBeFocused()
  await page.keyboard.press('Space')
  await expect(projectMenu).toBeVisible()
  await expect(pinProject).toBeFocused()
  await page.keyboard.press('Escape')
  const mountResponse = await page.request.post('/farming/api/projects/mount', {
    data: { workspace: projectDir },
  })
  expect(mountResponse.ok()).toBeTruthy()
  const pinResponse = await page.request.post('/farming/api/projects/pin', {
    data: { workspace: projectDir, pinned: true },
  })
  expect(pinResponse.ok()).toBeTruthy()
  await expect.poll(async () => {
    const response = await page.request.get('/farming/api/settings')
    const data = await response.json()
    return data.settings?.pinnedProjectWorkspaces?.includes(projectDir) === true
  }).toBe(true)
  await projectGroup.getByTestId('code-project-actions').click()
  const unpinProject = page.getByTestId('code-project-context-menu').getByRole('menuitem', { name: 'Unpin project' })
  await expect(unpinProject).toBeVisible()
  await expect(unpinProject.locator('svg[data-icon-kind="unpin"]')).toHaveCount(1)
  await page.keyboard.press('Escape')
  const unpinResponse = await page.request.post('/farming/api/projects/pin', {
    data: { workspace: projectDir, pinned: false },
  })
  expect(unpinResponse.ok()).toBeTruthy()
  await expect.poll(async () => {
    const response = await page.request.get('/farming/api/settings')
    const data = await response.json()
    return data.settings?.pinnedProjectWorkspaces?.includes(projectDir) === true
  }).toBe(false)
  await page.evaluate(id => {
    const testWindow = window as typeof window & {
      __farmingAgentActivityTest?: { update: (agentId: string, patch: unknown) => void }
    }
    testWindow.__farmingAgentActivityTest?.update(id, {
      runtimeObservation: {
        kind: 'shell',
        phase: 'working',
        confidence: 'authoritative',
        source: 'structured-runtime',
        observerVersion: 'project-hover-test',
        observedAt: Date.now(),
      },
    })
  }, agentId)
  await expect(row).not.toHaveClass(/unread/)
  await expect(row.locator('.code-agent-dot.turn-active')).toHaveCount(1)
  const activeTitlePresentation = await row.evaluate(element => {
    const title = element.querySelector<HTMLElement>('.code-agent-name')
    if (!title) throw new Error('Active Agent row presentation is missing')
    const titleStyle = getComputedStyle(title)
    return {
      textOverflow: titleStyle.textOverflow,
      maskImage: titleStyle.maskImage || titleStyle.getPropertyValue('-webkit-mask-image'),
    }
  })
  expect(activeTitlePresentation.textOverflow).toBe('clip')
  expect(activeTitlePresentation.maskImage).toContain('linear-gradient')
  await row.hover()
  const hoverActionLayers = await row.evaluate(element => {
    const dot = element.querySelector<HTMLElement>('.code-agent-dot.turn-active')
    const actions = element.querySelector<HTMLElement>('.code-agent-row-actions')
    if (!dot || !actions) throw new Error('Active Agent row actions are missing')
    return {
      actionsZIndex: getComputedStyle(actions).zIndex,
      dotOpacity: getComputedStyle(dot).opacity,
    }
  })
  expect(hoverActionLayers.actionsZIndex).toBe('3')
  expect(hoverActionLayers.dotOpacity).toBe('0')
  await page.mouse.move(1000, 100)
  await projectGroup.getByTestId('code-project-title').hover()
  const projectPreview = page.getByTestId('code-project-hover-preview')
  await expect(projectPreview).toBeVisible()
  await expect(projectPreview).toContainText(path.basename(projectDir))
  await expect(projectPreview).toContainText('1 Agent · 0 unread · 1 running')
  await expect(projectPreview).toContainText(projectDir)
  expect(await projectPreview.evaluate(element => {
    const probe = document.createElement('span')
    probe.style.color = getComputedStyle(element).getPropertyValue('--code-bg-raised')
    element.append(probe)
    const expected = getComputedStyle(probe).color
    probe.remove()
    return getComputedStyle(element).backgroundColor === expected
  })).toBe(true)
  await expect(projectPreview.locator('.code-project-hover-preview-workspace')).toHaveCSS('font-size', '12px')
  await page.mouse.move(1000, 100)
  await expect(projectPreview).toHaveCount(0)
  await page.evaluate(id => {
    const testWindow = window as typeof window & {
      __farmingAgentActivityTest?: { update: (agentId: string, patch: unknown) => void }
    }
    testWindow.__farmingAgentActivityTest?.update(id, {
      unread: false,
      runtimeObservation: {
        kind: 'shell',
        phase: 'idle',
        confidence: 'authoritative',
        source: 'structured-runtime',
        observerVersion: 'project-hover-test',
        observedAt: Date.now(),
      },
    })
  }, agentId)
  await expect(row).not.toHaveClass(/unread/)
  await expect(row.getByTestId('code-agent-row-age')).toHaveCount(1)

  await resizeSidebar(page, 480)
  const roomy = await rowProjection(row)
  expect(roomy.title).toBe(longTitle)
  expect(roomy.rowHeight).toBe(compact.rowHeight)
  expect(roomy.titleClientWidth).toBeGreaterThan(compact.titleClientWidth + 100)
  expect(roomy.providerDisplay).not.toBe('none')
  expect(roomy.providerIconSize).toBe(roomy.titleFontSize)
  expect(roomy.rowRightGap).toBeLessThanOrEqual(14)
  expect(roomy.ageDisplay).not.toBe('none')
  expect(roomy.detailDisplay).toBe('none')

  await resizeSidebar(page, 700)
  const wide = await rowProjection(row)
  expect(wide.rowHeight).toBe(compact.rowHeight)
  expect(wide.providerDisplay).not.toBe('none')
  expect(wide.ageDisplay).not.toBe('none')
  expect(wide.detailDisplay).toBe('block')
  expect(wide.detail).toBe('bash')
})

test('shows only non-default Agent Homes in the Agent hover preview', async ({ page, workspaceRoot }) => {
  const projectDir = path.join(workspaceRoot, 'agent-home-hover-preview')
  const sessionId = 'agent-home-hover-session'
  fs.mkdirSync(projectDir, { recursive: true })
  await page.route(/\/farming\/api\/agent-sessions(?:\?.*)?$/, route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      sessions: [{
        provider: 'codex',
        providerName: 'Codex',
        providerHomeId: 'review',
        id: sessionId,
        title: 'Review Home Agent',
        workspace: projectDir,
        updatedAt: new Date().toISOString(),
        archived: false,
        pinned: false,
        unread: false,
        projectless: false,
      }],
      nextCursor: '',
      hasMore: false,
      total: 1,
    }),
  }))
  const membershipResponse = await page.request.post('/farming/api/main-page-agent-sessions', {
    data: {
      operation: 'add',
      sessionKeys: [encodeProviderSessionKey('codex', sessionId, 'review')],
    },
  })
  expect(membershipResponse.ok()).toBeTruthy()

  await openFarming(page)
  const row = page.getByTestId('code-active-session-row').filter({ hasText: 'Review Home Agent' })
  await expect(row).toBeVisible()
  await row.hover()

  const home = page.getByTestId('code-agent-hover-preview-home')
  await expect(home).toBeVisible()
  await expect(home).toHaveText('review')
})

test('hides Agent row actions after a clicked row loses hover', async ({ page, workspaceRoot }) => {
  const projectDir = path.join(workspaceRoot, 'agent-row-actions')
  fs.mkdirSync(projectDir, { recursive: true })

  await openFarming(page)
  const createResponse = await page.request.post('/farming/api/control/agents', {
    data: { command: 'bash', workspace: projectDir },
  })
  expect(createResponse.ok()).toBeTruthy()
  const { agentId } = await createResponse.json() as { agentId: string }
  const row = page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
  const actions = row.locator('.code-agent-row-actions')

  await expect(row).toBeVisible()
  await row.click()
  await expect(actions).toHaveCSS('opacity', '1')
  await expect(actions).toHaveCSS('z-index', '3')

  await page.mouse.move(1000, 100)
  await row.evaluate(element => (element as HTMLElement).focus())
  await expect(row).toBeFocused()
  await expect(actions).toHaveCSS('opacity', '0')

  await page.keyboard.press('Tab')
  await expect(row.getByTestId('code-agent-row-pin')).toBeFocused()
  await expect(actions).toHaveCSS('opacity', '1')
})
