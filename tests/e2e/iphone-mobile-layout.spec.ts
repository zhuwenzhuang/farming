import fs from 'node:fs'
import path from 'node:path'
import { expect, openFarming, test } from './fixtures'

async function createControlAgent(page: import('@playwright/test').Page, command: string, workspace: string) {
  const response = await page.request.post('/farming/api/control/agents', {
    data: { command, workspace },
  })
  expect(response.ok()).toBeTruthy()
  const data = await response.json() as { agentId?: string }
  expect(data.agentId).toBeTruthy()
  return data.agentId as string
}

test.describe('iPhone mobile layout', () => {
  test('keeps composer, mic, and terminal surfaces usable under iPhone WebKit emulation', async ({ page, workspaceRoot }, testInfo) => {
    test.skip(testInfo.project.name !== 'iphone-webkit', 'Runs only in the iPhone WebKit project')

    const projectDir = path.join(workspaceRoot, 'iphone-layout')
    fs.mkdirSync(projectDir, { recursive: true })
    fs.writeFileSync(path.join(projectDir, 'README.md'), [
      '# iPhone layout',
      '',
      'This file exercises the mobile Markdown reading surface.',
      '',
      ...Array.from({ length: 32 }, (_, index) => `- Mobile reading line ${String(index + 1).padStart(2, '0')}`),
      '',
    ].join('\n'))
    fs.mkdirSync(path.join(projectDir, 'src'), { recursive: true })
    fs.writeFileSync(path.join(projectDir, 'src', 'mobile-app.ts'), 'export const app = true\n')
    fs.writeFileSync(path.join(projectDir, 'src', 'mobile-view.ts'), 'export const mobile = true\n')

    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'maxTouchPoints', { value: 5, configurable: true })
      delete (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition
      delete (window as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition
    })

    await openFarming(page)
    const userAgent = await page.evaluate(() => navigator.userAgent)
    expect(userAgent).toContain('iPhone')

    const agentId = await createControlAgent(page, 'bash', projectDir)
    await createControlAgent(page, 'bash', projectDir)
    await createControlAgent(page, 'bash', projectDir)
    await page.getByTestId('code-mobile-menu').click()
    const productMark = page.getByTestId('code-product-mark')
    await expect(productMark.locator('.code-product-logo')).toBeVisible()
    await productMark.click()
    const brandDialog = page.getByTestId('code-brand-dialog')
    await expect(brandDialog).toBeVisible()
    await expect(brandDialog.getByRole('link', { name: 'GitHub' })).toHaveAttribute('href', 'https://github.com/zhuwenzhuang/farming')
    const brandMetrics = await brandDialog.locator('.code-brand-dialog').evaluate(element => {
      const rect = element.getBoundingClientRect()
      const logo = element.querySelector('.code-brand-logo')?.getBoundingClientRect()
      return {
        width: rect.width,
        bottomGap: window.innerHeight - rect.bottom,
        viewportWidth: window.innerWidth,
        logoWidth: logo?.width ?? 0,
      }
    })
    expect(brandMetrics.width).toBeLessThanOrEqual(brandMetrics.viewportWidth - 16)
    expect(brandMetrics.bottomGap).toBeLessThanOrEqual(10)
    expect(brandMetrics.logoWidth).toBeGreaterThanOrEqual(80)
    await brandDialog.getByRole('button', { name: 'Cancel' }).click()
    const agentRow = page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
    await expect(agentRow).toBeVisible({ timeout: 30_000 })
    await agentRow.click()

    const terminalPane = page.locator(`[data-testid="code-terminal-pane"][data-agent-id="${agentId}"]`)
    await expect(terminalPane).toBeVisible({ timeout: 30_000 })

    const touchScrollMetrics = await page.evaluate(async id => {
      const fixture = Array.from({ length: 180 }, (_, index) => `iphone-touch-line-${index}`).join('\r\n')
      await window.__farmingTerminalTest?.writeFixture(id, `${fixture}\r\n`)
      const host = document.querySelector(`.terminal-session-host[data-agent-id="${CSS.escape(id)}"]`)
      const surface = host?.querySelector('.xterm-screen')
      if (!(surface instanceof HTMLElement)) throw new Error('iPhone terminal touch surface is missing')
      const rect = surface.getBoundingClientRect()
      const x = rect.left + rect.width / 2
      const startY = rect.top + rect.height * 0.42
      const dispatch = (type: string, pointerId: number, y: number) => surface.dispatchEvent(new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        pointerId,
        pointerType: 'touch',
        isPrimary: true,
        clientX: x,
        clientY: y,
      }))

      dispatch('pointerdown', 181, startY)
      for (let step = 1; step <= 6; step += 1) {
        await new Promise(resolve => window.setTimeout(resolve, 12))
        dispatch('pointermove', 181, startY + step * 16)
      }
      dispatch('pointerup', 181, startY + 96)
      const afterRelease = window.__farmingTerminalTest?.getViewport(id)
      await new Promise(resolve => window.setTimeout(resolve, 220))
      const afterMomentum = window.__farmingTerminalTest?.getViewport(id)

      dispatch('pointerdown', 182, startY)
      dispatch('pointermove', 182, startY + 3_000)
      const beforeEdge = window.__farmingTerminalTest?.getViewport(id)
      dispatch('pointermove', 182, startY + 3_044)
      const afterEdge = window.__farmingTerminalTest?.getViewport(id)
      const edgeTransform = surface.style.transform
      dispatch('pointerup', 182, startY + 3_044)
      await new Promise(resolve => window.setTimeout(resolve, 300))
      return {
        afterRelease,
        afterMomentum,
        beforeEdge,
        afterEdge,
        edgeTransform,
        settledTransform: surface.style.transform,
        pageScrollY: window.scrollY,
      }
    }, agentId)
    expect(touchScrollMetrics.afterRelease?.viewportY ?? 0).toBeGreaterThan(0)
    expect(touchScrollMetrics.afterMomentum?.viewportY ?? 0).toBeGreaterThan(touchScrollMetrics.afterRelease?.viewportY ?? 0)
    expect(touchScrollMetrics.afterEdge?.viewportY).toBe(touchScrollMetrics.beforeEdge?.viewportY)
    expect(touchScrollMetrics.edgeTransform).toContain('translate3d')
    expect(touchScrollMetrics.settledTransform).toBe('')
    expect(touchScrollMetrics.pageScrollY).toBe(0)

    const terminalBackgrounds = await terminalPane.evaluate(element => {
      const pane = element as HTMLElement
      const container = pane.querySelector('[data-testid="code-terminal-container"]') as HTMLElement | null
      const screen = pane.querySelector('.xterm-screen') as HTMLElement | null
      const viewport = pane.querySelector('.xterm-viewport') as HTMLElement | null
      return {
        pane: getComputedStyle(pane).backgroundColor,
        container: container ? getComputedStyle(container).backgroundColor : '',
        screen: screen ? getComputedStyle(screen).backgroundColor : '',
        viewport: viewport ? getComputedStyle(viewport).backgroundColor : '',
      }
    })
    expect(terminalBackgrounds).toEqual({
      pane: 'rgb(255, 255, 255)',
      container: 'rgb(255, 255, 255)',
      screen: 'rgb(255, 255, 255)',
      viewport: 'rgb(255, 255, 255)',
    })

    const composer = page.getByTestId('code-composer')
    const composerInput = page.getByTestId('code-composer-input')
    await expect(composerInput).toHaveAttribute('aria-disabled', 'false')
    await expect(composerInput).toHaveAttribute('contenteditable', 'true')
    await expect(composerInput).toHaveAttribute('data-placeholder', 'Type a shell command')
    expect(await composerInput.evaluate(element => element.getAttribute('role'))).toBeNull()
    expect(await composerInput.evaluate(element => element.getAttribute('autocomplete'))).toBeNull()
    expect(await composerInput.evaluate(element => element.getAttribute('inputmode'))).toBeNull()
    await composerInput.focus()
    await expect(composerInput).toBeFocused()

    const keyboardMetrics = await composer.evaluate(async element => {
      const root = document.documentElement
      document.body.classList.add('code-mode', 'code-mobile-touch', 'code-mobile-ios')
      document.body.classList.add('code-mobile-keyboard-active')
      root.style.setProperty('--app-visual-height', '430px')
      root.style.setProperty('--app-visual-offset-top', '0px')
      root.style.setProperty('--app-visual-offset-left', '0px')
      root.style.setProperty('--mobile-keyboard-offset', '520px')
      await new Promise(resolve => window.setTimeout(resolve, 220))
      const rect = (element as HTMLElement).getBoundingClientRect()
      const visualBottom = Number.parseFloat(root.style.getPropertyValue('--app-visual-height')) || 0
      return {
        composerHeight: rect.height,
        composerBottomBeyondVisualViewport: rect.bottom - visualBottom,
        visualViewportBottomGap: visualBottom - rect.bottom,
      }
    })
    expect(keyboardMetrics.composerHeight).toBeLessThanOrEqual(130)
    expect(keyboardMetrics.composerBottomBeyondVisualViewport).toBeLessThanOrEqual(0)
    expect(keyboardMetrics.visualViewportBottomGap).toBeGreaterThanOrEqual(0)
    expect(keyboardMetrics.visualViewportBottomGap).toBeLessThanOrEqual(32)

    await page.evaluate(() => {
      const root = document.documentElement
      const visualViewport = window.visualViewport
      root.style.setProperty('--app-visual-height', `${Math.round(visualViewport?.height ?? window.innerHeight)}px`)
      root.style.setProperty('--app-visual-offset-top', `${Math.round(visualViewport?.offsetTop ?? 0)}px`)
      root.style.setProperty('--app-visual-offset-left', `${Math.round(visualViewport?.offsetLeft ?? 0)}px`)
      root.style.setProperty('--mobile-keyboard-offset', '0px')
      document.body.classList.remove('code-mobile-keyboard-active')
    })

    const restingComposerMetrics = await composer.evaluate(element => {
      const composerRect = (element as HTMLElement).getBoundingClientRect()
      const main = document.querySelector('[data-testid="code-main"]') as HTMLElement | null
      if (!main) throw new Error('Mobile main surface is missing')
      const mainRect = main.getBoundingClientRect()
      return {
        bottomGap: Math.round(mainRect.bottom - composerRect.bottom),
        leftGap: Math.round(composerRect.left - mainRect.left),
        rightGap: Math.round(mainRect.right - composerRect.right),
        overflowRight: Math.round(composerRect.right - mainRect.right),
      }
    })
    expect(restingComposerMetrics.bottomGap).toBeGreaterThanOrEqual(4)
    expect(restingComposerMetrics.bottomGap).toBeLessThanOrEqual(32)
    expect(Math.abs(restingComposerMetrics.leftGap - restingComposerMetrics.rightGap)).toBeLessThanOrEqual(2)
    expect(restingComposerMetrics.overflowRight).toBeLessThanOrEqual(0)

    const standaloneComposerGap = await composer.evaluate(element => {
      document.body.classList.add('code-mobile-standalone')
      const composerRect = (element as HTMLElement).getBoundingClientRect()
      const main = document.querySelector('[data-testid="code-main"]') as HTMLElement | null
      if (!main) throw new Error('Mobile main surface is missing')
      const gap = Math.round(main.getBoundingClientRect().bottom - composerRect.bottom)
      document.body.classList.remove('code-mobile-standalone')
      return gap
    })
    expect(standaloneComposerGap).toBeLessThanOrEqual(restingComposerMetrics.bottomGap)

    const mic = page.getByTestId('code-composer-mic')
    await expect(mic).toHaveCount(0)
    await expect(page.getByTestId('code-composer-dictation-hint')).toHaveCount(0)
    await expect(page.getByTestId('code-composer-recording')).toHaveCount(0)

    // Switching attention back to the main surface must dismiss the mobile
    // keyboard focus; tapping the composer again should restore it cleanly.
    await terminalPane.tap({ position: { x: 24, y: 24 } })
    await expect(composerInput).not.toBeFocused()
    await composerInput.tap()
    await expect(composerInput).toBeFocused()

    await page.getByTestId('code-mobile-menu').click()
    const activeAgentRow = page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
    const providerIcon = activeAgentRow.locator('.code-agent-row-provider-icon')
    await expect(providerIcon).toBeVisible()
    const agentRowLayout = await activeAgentRow.evaluate(element => {
      const row = (element as HTMLElement).getBoundingClientRect()
      const copy = element.querySelector('.code-agent-row-copy')?.getBoundingClientRect()
      const icon = element.querySelector('.code-agent-row-provider-icon')?.getBoundingClientRect()
      return {
        copyInset: copy ? Math.round(copy.left - row.left) : -1,
        iconRight: icon?.right ?? Number.POSITIVE_INFINITY,
        copyLeft: copy?.left ?? Number.NEGATIVE_INFINITY,
      }
    })
    expect(agentRowLayout.copyInset).toBe(7)
    expect(agentRowLayout.iconRight).toBeLessThanOrEqual(agentRowLayout.copyLeft)
    await page.getByTestId('code-sidebar-options').click()
    const settingsPanel = page.getByTestId('code-settings-panel')
    await expect(settingsPanel).toBeVisible()
    await expect(page.getByTestId('code-mobile-share-sheet')).toHaveCount(0)
    await page.waitForTimeout(220)
    const settingsDrawerMetrics = await settingsPanel.locator('.code-settings-panel').evaluate(element => {
      const rect = (element as HTMLElement).getBoundingClientRect()
      return { left: Math.round(rect.left), width: Math.round(rect.width), viewportWidth: window.innerWidth }
    })
    expect(settingsDrawerMetrics.left).toBe(0)
    expect(settingsDrawerMetrics.width).toBeLessThan(settingsDrawerMetrics.viewportWidth)
    await settingsPanel.getByRole('button', { name: /Back to navigation|返回导航/ }).click()
    await expect(settingsPanel).toHaveCount(0)
    await expect(page.getByTestId('code-sidebar')).toBeVisible()
    await page.getByTestId('code-mobile-sidebar-backdrop').dispatchEvent('pointerdown', {
      pointerType: 'touch',
      isPrimary: true,
    })

    await page.getByTestId('code-mobile-more').click()
    const optionsMenu = page.getByTestId('code-options-menu')
    await expect(optionsMenu).toBeVisible()
    await page.evaluate(() => document.body.setAttribute('data-appearance', 'dark'))
    const shareMenuItem = optionsMenu.getByRole('menuitem', { name: /Share page|分享页面/ })
    await expect(shareMenuItem).toHaveCSS('color', 'rgb(230, 237, 243)')
    await shareMenuItem.click()
    const mobileShareSheet = page.getByTestId('code-mobile-share-sheet')
    await expect(mobileShareSheet).toBeVisible()
    await expect(mobileShareSheet.getByRole('heading', { name: /Share page|分享页面/ })).toBeVisible()
    await expect(mobileShareSheet.getByRole('heading', { name: /Send this page|转发当前页面/ })).toBeVisible()
    const copyShareAction = mobileShareSheet.getByTestId('code-mobile-share-copy-action')
    await expect(copyShareAction).toBeVisible()
    await copyShareAction.click()
    await expect(copyShareAction).toHaveText(/Copied|已复制/)
    await expect(mobileShareSheet.getByRole('heading', { name: /Add to Home Screen|添加到主屏幕/ })).toBeVisible()
    await expect(mobileShareSheet.getByText(/system browser or Chrome|系统浏览器或 Chrome/)).toBeVisible()
    await expect(mobileShareSheet.getByText(/tap •••|点 •••/i)).toBeVisible()
    await expect(mobileShareSheet.locator('.code-mobile-install-step')).toHaveCount(2)
    await expect(mobileShareSheet.getByTestId('code-mobile-share-system-action')).toHaveCount(0)
    await expect(mobileShareSheet.locator('.code-mobile-share-sheet')).toHaveCSS('color', 'rgb(230, 237, 243)')
    await mobileShareSheet.getByRole('button', { name: /Cancel|取消/ }).click()
    await page.evaluate(() => document.body.setAttribute('data-appearance', 'light'))

    await page.getByTestId('code-mobile-menu').click()
    const filesSection = page.getByTestId('code-files-section').first()
    const filesToggle = filesSection.getByRole('button', { name: /^Files$/ })
    if (await filesToggle.getAttribute('aria-expanded') === 'false') {
      await filesToggle.click()
    }
    const projectGroup = filesSection.locator('xpath=ancestor::section[contains(@class, "code-project-group")]')
    await expect(projectGroup.getByTestId('code-project-agent-strip')).toBeVisible()
    await expect(projectGroup.getByTestId('code-project-agent-compact')).toHaveCount(3)
    await expect(projectGroup.locator('[data-testid="code-agent-row"][data-agent-id]')).toHaveCount(0)
    const fileSearch = filesSection.getByPlaceholder('Search or path:line')
    const mobileSidebarBackdrop = page.getByTestId('code-mobile-sidebar-backdrop')
    const sidebarScrollBeforeSearchFocus = await page.getByTestId('code-project-list').evaluate(element => element.scrollTop)
    await fileSearch.tap()
    await expect(fileSearch).toBeFocused()
    await expect(page.getByTestId('code-sidebar')).toBeVisible()
    expect(await page.getByTestId('code-project-list').evaluate(element => element.scrollTop)).toBe(sidebarScrollBeforeSearchFocus)
    await mobileSidebarBackdrop.dispatchEvent('click')
    await expect(page.getByTestId('code-sidebar')).toBeVisible()
    await expect(fileSearch).toBeVisible()
    await fileSearch.fill('mobile')
    const touchSearchResults = page.getByTestId('code-file-search-results')
    await expect(touchSearchResults.getByRole('option').nth(1)).toBeVisible()
    const activeOptionBeforeTouchMove = await fileSearch.getAttribute('aria-activedescendant')
    await touchSearchResults.getByRole('option').nth(1).dispatchEvent('pointermove', {
      pointerType: 'touch',
      isPrimary: true,
    })
    await expect(fileSearch).toHaveAttribute('aria-activedescendant', activeOptionBeforeTouchMove || '')
    await fileSearch.fill('README.md')
    const fileSearchResults = page.getByTestId('code-file-search-results')
    await expect(fileSearchResults).toBeVisible()
    const fileSearchLayout = await fileSearchResults.evaluate(element => {
      const rect = (element as HTMLElement).getBoundingClientRect()
      const sidebar = document.querySelector('[data-testid="code-sidebar"]') as HTMLElement | null
      const sidebarRect = sidebar?.getBoundingClientRect()
      const visualViewport = window.visualViewport
      return {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        sidebarLeft: sidebarRect?.left ?? 0,
        sidebarRight: sidebarRect?.right ?? window.innerWidth,
        viewportTop: visualViewport?.offsetTop ?? 0,
        viewportBottom: (visualViewport?.offsetTop ?? 0) + (visualViewport?.height ?? window.innerHeight),
      }
    })
    expect(fileSearchLayout.left).toBeGreaterThanOrEqual(fileSearchLayout.sidebarLeft)
    expect(fileSearchLayout.right).toBeLessThanOrEqual(fileSearchLayout.sidebarRight)
    expect(fileSearchLayout.top).toBeGreaterThanOrEqual(fileSearchLayout.viewportTop)
    expect(fileSearchLayout.bottom).toBeLessThanOrEqual(fileSearchLayout.viewportBottom + 1)
    await fileSearchResults.getByRole('option', { name: /README\.md/ }).click()
    await expect(page.getByTestId('code-file-editor')).toBeVisible()
    await expect(page.locator('.code-file-preview-panel.markdown')).toBeVisible()

    const markdownReadingMetrics = await page.locator('.code-file-preview-panel.markdown').evaluate(element => {
      const panel = element as HTMLElement
      const article = panel.querySelector('.code-markdown-preview') as HTMLElement | null
      const main = document.querySelector('[data-testid="code-main"]') as HTMLElement | null
      if (!article || !main) throw new Error('Markdown reading layout is missing required elements')
      const panelRect = panel.getBoundingClientRect()
      const mainRect = main.getBoundingClientRect()
      return {
        articlePaddingBottom: Number.parseFloat(getComputedStyle(article).paddingBottom),
        mainPaddingBottom: Number.parseFloat(getComputedStyle(main).paddingBottom),
        panelBottomGap: Math.round(mainRect.bottom - panelRect.bottom),
        scrollable: panel.scrollHeight > panel.clientHeight + 4,
      }
    })
    expect(markdownReadingMetrics.mainPaddingBottom).toBe(0)
    expect(markdownReadingMetrics.panelBottomGap).toBeLessThanOrEqual(2)
    expect(markdownReadingMetrics.articlePaddingBottom).toBeLessThanOrEqual(40)
    expect(markdownReadingMetrics.scrollable).toBe(true)

    await page.getByTestId('code-mobile-back').click()
    await expect(terminalPane).toBeVisible()
    await expect(page.getByTestId('code-mobile-menu')).toBeVisible()
  })
})
