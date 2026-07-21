import fs from 'node:fs'
import path from 'node:path'
import { expect, openFarming, test } from './fixtures'

const IPHONE_AUDIT_DIR = path.resolve('.tmp/iphone-real-agent-audit')

async function captureIphoneAudit(page: import('@playwright/test').Page, name: string) {
  fs.mkdirSync(IPHONE_AUDIT_DIR, { recursive: true })
  await page.screenshot({
    path: path.join(IPHONE_AUDIT_DIR, name),
    fullPage: true,
    animations: 'disabled',
    scale: 'css',
  })
}

async function createControlAgent(
  page: import('@playwright/test').Page,
  command: string,
  workspace: string,
  agentRuntimeMode: 'terminal' | 'chat' = 'terminal',
) {
  const response = await page.request.post('/farming/api/control/agents', {
    data: { command, workspace, agentRuntimeMode },
  })
  expect(response.ok()).toBeTruthy()
  const data = await response.json() as { agentId?: string }
  expect(data.agentId).toBeTruthy()
  return data.agentId as string
}

test.describe('iPhone mobile layout', () => {
  test('keeps a long ACP model label outside the iPhone send-button hit target', async ({ page, workspaceRoot }, testInfo) => {
    test.skip(testInfo.project.name !== 'iphone-webkit', 'Runs only in the iPhone WebKit project')
    const projectDir = path.join(workspaceRoot, 'iphone-long-model-label')
    fs.mkdirSync(projectDir, { recursive: true })
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'maxTouchPoints', { value: 5, configurable: true })
    })
    await openFarming(page)

    const agentId = await createControlAgent(page, 'opencode', projectDir, 'chat')
    await page.getByTestId('code-mobile-menu').click()
    await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
    const modelPicker = page.getByTestId('code-acp-model-picker')
    await expect(modelPicker).toBeVisible({ timeout: 30_000 })
    await modelPicker.locator('.code-composer-model-label.mobile').evaluate(element => {
      element.textContent = 'OpenCode Zen/Big Pickle'
    })

    const input = page.getByTestId('code-acp-composer-input')
    const send = page.getByTestId('code-acp-composer-send')
    await input.tap()
    await page.keyboard.insertText('LONG_MODEL_HIT_TARGET_OK')
    await expect(send).toHaveAttribute('data-action', 'send')
    expect(await send.evaluate(element => {
      const rect = element.getBoundingClientRect()
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
      return hit === element || element.contains(hit)
    })).toBe(true)
    const touchTargets = await page.evaluate(() => {
      const rect = (selector: string) => {
        const value = document.querySelector<HTMLElement>(selector)?.getBoundingClientRect()
        return value ? { width: value.width, height: value.height } : null
      }
      return {
        add: rect('[data-testid="code-acp-composer-add"]'),
        model: rect('[data-testid="code-acp-model-picker"]'),
        send: rect('[data-testid="code-acp-composer-send"]'),
      }
    })
    for (const target of Object.values(touchTargets)) {
      expect(target?.width).toBeGreaterThanOrEqual(44)
      expect(target?.height).toBeGreaterThanOrEqual(44)
    }
    await captureIphoneAudit(page, 'iphone-webkit-long-model-label.png')
    await send.click()
    await expect(input).toHaveValue('')
  })

  test('keeps a real image attachment and its remove control inside the iPhone composer', async ({ page, workspaceRoot }, testInfo) => {
    test.skip(testInfo.project.name !== 'iphone-webkit', 'Runs only in the iPhone WebKit project')
    const projectDir = path.join(workspaceRoot, 'iphone-image-attachment')
    fs.mkdirSync(projectDir, { recursive: true })
    const imagePath = path.join(projectDir, 'attachment.png')
    fs.writeFileSync(imagePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=', 'base64'))
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'maxTouchPoints', { value: 5, configurable: true })
    })
    await openFarming(page)

    const agentId = await createControlAgent(page, 'opencode', projectDir, 'chat')
    await page.getByTestId('code-mobile-menu').click()
    await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
    await expect(page.getByTestId('code-acp-composer-input')).toBeVisible({ timeout: 30_000 })
    await page.getByTestId('code-acp-composer-file-input').setInputFiles(imagePath)

    const composer = page.getByTestId('code-acp-composer')
    const attachment = page.getByTestId('code-composer-attachment')
    const remove = attachment.getByRole('button', { name: 'Remove attachment.png' })
    const toolbar = page.getByTestId('code-acp-composer-toolbar')
    await expect(composer).toHaveClass(/has-attachments/)
    await expect(attachment).toHaveClass(/image/)
    await expect(attachment).toHaveClass(/ready/, { timeout: 15_000 })

    const geometry = await page.evaluate(() => {
      const composer = document.querySelector<HTMLElement>('[data-testid="code-acp-composer"]')?.getBoundingClientRect()
      const attachment = document.querySelector<HTMLElement>('[data-testid="code-composer-attachment"]')?.getBoundingClientRect()
      const remove = document.querySelector<HTMLElement>('[data-testid="code-composer-attachment"] button')?.getBoundingClientRect()
      const toolbar = document.querySelector<HTMLElement>('[data-testid="code-acp-composer-toolbar"]')?.getBoundingClientRect()
      if (!composer || !attachment || !remove || !toolbar) throw new Error('Attachment geometry is incomplete')
      const hit = document.elementFromPoint(remove.left + remove.width / 2, remove.top + remove.height / 2)
      return {
        composer: { top: composer.top, bottom: composer.bottom, height: composer.height },
        attachment: { top: attachment.top, bottom: attachment.bottom, height: attachment.height },
        toolbar: { top: toolbar.top, bottom: toolbar.bottom },
        remove: { width: remove.width, height: remove.height },
        removeIsHit: hit instanceof Element && Boolean(hit.closest('.code-composer-attachment-remove')),
        viewportHeight: window.innerHeight,
      }
    })
    expect(geometry.composer.height).toBeGreaterThanOrEqual(180)
    expect(geometry.composer.bottom).toBeLessThanOrEqual(geometry.viewportHeight)
    expect(geometry.attachment.top).toBeGreaterThanOrEqual(geometry.composer.top)
    expect(geometry.attachment.bottom).toBeLessThanOrEqual(geometry.toolbar.top)
    expect(geometry.toolbar.bottom).toBeLessThanOrEqual(geometry.composer.bottom)
    expect(geometry.remove.width).toBeGreaterThanOrEqual(44)
    expect(geometry.remove.height).toBeGreaterThanOrEqual(44)
    expect(geometry.removeIsHit).toBe(true)

    await captureIphoneAudit(page, 'iphone-webkit-image-attachment.png')
    await remove.click()
    await expect(attachment).toHaveCount(0)
    await expect(composer).not.toHaveClass(/has-attachments/)
    await expect.poll(async () => composer.evaluate(element => element.getBoundingClientRect().height)).toBeLessThanOrEqual(118)
  })

  test('does not let ACP slash commands consume iPhone IME composition keys', async ({ page, workspaceRoot }, testInfo) => {
    test.skip(testInfo.project.name !== 'iphone-webkit', 'Runs only in the iPhone WebKit project')
    const projectDir = path.join(workspaceRoot, 'iphone-acp-ime')
    fs.mkdirSync(projectDir, { recursive: true })
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'maxTouchPoints', { value: 5, configurable: true })
    })
    await openFarming(page)

    const agentId = await createControlAgent(page, 'opencode', projectDir, 'chat')
    await page.getByTestId('code-mobile-menu').click()
    await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
    await expect(page.getByTestId('code-acp-model-picker')).toBeVisible({ timeout: 30_000 })
    const input = page.getByTestId('code-acp-composer-input')
    await input.tap()
    await input.fill('rich timeline')
    await page.keyboard.press('Enter')
    await expect(page.getByText('Rich ACP timeline complete.', { exact: true })).toBeVisible({ timeout: 30_000 })
    await input.tap()
    await page.keyboard.insertText('/')
    await expect(page.getByTestId('code-acp-command-review')).toBeVisible({ timeout: 30_000 })

    await input.evaluate(element => {
      element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }))
      const composingEnter = new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        key: 'Enter',
        code: 'Enter',
        isComposing: true,
      })
      Object.defineProperty(composingEnter, 'keyCode', { value: 229 })
      element.dispatchEvent(composingEnter)
    })
    await expect(input).toHaveValue('/')
    await expect(page.getByTestId('code-acp-command-review')).toBeVisible()
    await captureIphoneAudit(page, 'iphone-webkit-ime-slash-menu.png')

    await input.evaluate(element => {
      element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中' }))
      element.dispatchEvent(new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        key: 'Enter',
        code: 'Enter',
      }))
    })
    await expect(input).toHaveValue('/')
    await expect(page.getByTestId('code-acp-command-review')).toBeVisible()
  })

  test('taps send and stop through a complete running ACP turn on iPhone', async ({ page, workspaceRoot }, testInfo) => {
    test.skip(testInfo.project.name !== 'iphone-webkit', 'Runs only in the iPhone WebKit project')
    const projectDir = path.join(workspaceRoot, 'iphone-acp-interrupt')
    fs.mkdirSync(projectDir, { recursive: true })
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'maxTouchPoints', { value: 5, configurable: true })
    })
    await openFarming(page)

    const agentId = await createControlAgent(page, 'opencode', projectDir, 'chat')
    await page.getByTestId('code-mobile-menu').tap()
    await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).tap()
    const input = page.getByTestId('code-acp-composer-input')
    const send = page.getByTestId('code-acp-composer-send')
    await expect(page.getByTestId('code-acp-model-picker')).toBeVisible({ timeout: 30_000 })
    await input.tap()
    await page.keyboard.insertText('mobile interrupt')
    await expect(send).toHaveAttribute('data-action', 'send')
    await expect(send).toHaveCSS('width', '44px')
    await expect(send).toHaveCSS('height', '44px')
    await send.tap()
    await expect(page.getByText('Mobile interrupt waiting.', { exact: true })).toBeVisible({ timeout: 15_000 })
    await expect(send).toHaveAttribute('data-action', 'interrupt')
    await captureIphoneAudit(page, 'iphone-webkit-acp-running.png')
    await send.tap()
    await expect(page.getByText('Mobile interrupt stopped.', { exact: true })).toBeVisible({ timeout: 15_000 })
    await expect(send).not.toHaveAttribute('data-action', 'interrupt')
    await captureIphoneAudit(page, 'iphone-webkit-acp-stopped.png')
  })

  test('keeps every ACP permission action visible and tappable on iPhone', async ({ page, workspaceRoot }, testInfo) => {
    test.skip(testInfo.project.name !== 'iphone-webkit', 'Runs only in the iPhone WebKit project')
    const projectDir = path.join(workspaceRoot, 'iphone-acp-permission')
    fs.mkdirSync(projectDir, { recursive: true })
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'maxTouchPoints', { value: 5, configurable: true })
    })
    await openFarming(page)

    const agentId = await createControlAgent(page, 'opencode', projectDir, 'chat')
    await page.getByTestId('code-mobile-menu').tap()
    await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).tap()
    const input = page.getByTestId('code-acp-composer-input')
    await expect(input).toBeVisible({ timeout: 30_000 })
    await input.tap()
    await page.keyboard.insertText('unicode permission')
    await page.getByTestId('code-acp-composer-send').tap()

    const composer = page.getByTestId('code-acp-composer')
    const permission = page.getByTestId('code-acp-permission-request')
    const actions = permission.locator('.code-acp-request-actions')
    await expect(permission).toBeVisible({ timeout: 15_000 })
    await expect(actions.getByLabel('Permission scope')).toBeVisible()
    await expect(actions.getByRole('button', { name: /Approve|Allow/ })).toBeVisible()
    await expect(actions.getByRole('button', { name: 'Deny' })).toBeVisible()
    await expect(actions.getByRole('button', { name: 'Cancel' })).toBeVisible()

    const geometry = await page.evaluate(() => {
      const composer = document.querySelector<HTMLElement>('[data-testid="code-acp-composer"]')?.getBoundingClientRect()
      const permission = document.querySelector<HTMLElement>('[data-testid="code-acp-permission-request"]')?.getBoundingClientRect()
      const actions = document.querySelector<HTMLElement>('[data-testid="code-acp-permission-request"] .code-acp-request-actions')?.getBoundingClientRect()
      const controls = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="code-acp-permission-request"] .code-acp-request-actions select, [data-testid="code-acp-permission-request"] .code-acp-request-actions button'))
      if (!composer || !permission || !actions || controls.length !== 4) throw new Error('Permission action geometry is incomplete')
      return {
        documentWidth: document.documentElement.scrollWidth,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        composer: { left: composer.left, right: composer.right, top: composer.top, bottom: composer.bottom },
        permission: { left: permission.left, right: permission.right, top: permission.top, bottom: permission.bottom },
        actions: { left: actions.left, right: actions.right, top: actions.top, bottom: actions.bottom },
        controls: controls.map(control => {
          const rect = control.getBoundingClientRect()
          const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
          return {
            label: control.getAttribute('aria-label') || control.textContent?.trim() || control.tagName,
            left: rect.left,
            right: rect.right,
            top: rect.top,
            bottom: rect.bottom,
            width: rect.width,
            height: rect.height,
            centerHitsControl: hit === control || control.contains(hit),
          }
        }),
      }
    })
    expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.viewport.width + 1)
    expect(geometry.permission.left).toBeGreaterThanOrEqual(geometry.composer.left)
    expect(geometry.permission.right).toBeLessThanOrEqual(geometry.composer.right)
    expect(geometry.actions.left).toBeGreaterThanOrEqual(geometry.permission.left)
    expect(geometry.actions.right).toBeLessThanOrEqual(geometry.permission.right)
    expect(geometry.actions.top).toBeGreaterThanOrEqual(geometry.permission.top)
    expect(geometry.actions.bottom).toBeLessThanOrEqual(geometry.permission.bottom)
    for (const control of geometry.controls) {
      expect(control.width, `${control.label} width`).toBeGreaterThanOrEqual(44)
      expect(control.height, `${control.label} height`).toBeGreaterThanOrEqual(44)
      expect(control.left, `${control.label} left edge`).toBeGreaterThanOrEqual(geometry.permission.left)
      expect(control.right, `${control.label} right edge`).toBeLessThanOrEqual(geometry.permission.right)
      expect(control.top, `${control.label} top edge`).toBeGreaterThanOrEqual(geometry.permission.top)
      expect(control.bottom, `${control.label} bottom edge`).toBeLessThanOrEqual(geometry.permission.bottom)
      expect(control.centerHitsControl, `${control.label} center hit`).toBe(true)
    }

    await captureIphoneAudit(page, 'iphone-webkit-acp-permission-request.png')
    await permission.evaluate(element => { element.scrollTop = element.scrollHeight })
    await expect(permission.getByTestId('code-acp-permission-risk')).toBeInViewport()
    await expect(actions.getByRole('button', { name: 'Cancel' })).toBeInViewport()
    expect(await actions.getByRole('button', { name: 'Cancel' }).evaluate(element => {
      const rect = element.getBoundingClientRect()
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
      return hit === element || element.contains(hit)
    })).toBe(true)
    await captureIphoneAudit(page, 'iphone-webkit-acp-permission-risk.png')
    await actions.getByRole('button', { name: 'Cancel' }).tap()
    await expect(permission).toBeHidden()
  })

  test('switches Agents and closes the drawer through iPhone touch targets', async ({ page, workspaceRoot }, testInfo) => {
    test.skip(testInfo.project.name !== 'iphone-webkit', 'Runs only in the iPhone WebKit project')
    const projectDir = path.join(workspaceRoot, 'iphone-drawer-touch')
    fs.mkdirSync(projectDir, { recursive: true })
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'maxTouchPoints', { value: 5, configurable: true })
    })
    await openFarming(page)

    const firstAgentId = await createControlAgent(page, 'bash', projectDir)
    const secondAgentId = await createControlAgent(page, 'bash', projectDir)
    const menu = page.getByTestId('code-mobile-menu')
    await expect(menu).toHaveCSS('width', '44px')
    await expect(menu).toHaveCSS('height', '44px')
    await menu.tap()
    await page.locator(`[data-testid="code-agent-row"][data-agent-id="${firstAgentId}"]`).tap()
    await expect(page.locator(`[data-testid="code-terminal-pane"][data-agent-id="${firstAgentId}"]`)).toBeVisible({ timeout: 30_000 })
    await menu.tap()
    await page.locator(`[data-testid="code-agent-row"][data-agent-id="${secondAgentId}"]`).tap()
    await expect(page.locator(`[data-testid="code-terminal-pane"][data-agent-id="${secondAgentId}"]`)).toBeVisible({ timeout: 30_000 })
    await menu.tap()
    await expect(page.getByTestId('code-sidebar')).not.toHaveClass(/collapsed/)
    const more = page.locator(`[data-testid="code-agent-row"][data-agent-id="${secondAgentId}"]`).getByTestId('code-agent-row-more')
    await expect(more).toHaveCSS('width', '44px')
    await expect(more).toHaveCSS('height', '44px')
    await captureIphoneAudit(page, 'iphone-webkit-agent-drawer.png')
    await page.getByTestId('code-mobile-sidebar-backdrop').tap({ position: { x: 380, y: 400 } })
    await expect(page.getByTestId('code-sidebar')).toHaveClass(/collapsed/)
  })

  test('reloads an iPhone terminal and executes the next touch submission exactly once', async ({ page, workspaceRoot }, testInfo) => {
    test.skip(testInfo.project.name !== 'iphone-webkit', 'Runs only in the iPhone WebKit project')
    const projectDir = path.join(workspaceRoot, 'iphone-terminal-reload')
    fs.mkdirSync(projectDir, { recursive: true })
    const outputPath = path.join(projectDir, 'after-mobile-reload.txt')
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'maxTouchPoints', { value: 5, configurable: true })
    })
    await openFarming(page)

    const agentId = await createControlAgent(page, 'bash', projectDir)
    await page.getByTestId('code-mobile-menu').tap()
    await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).tap()
    await page.waitForFunction(id => Boolean(window.__farmingTerminalTest?.isReady(id)), agentId, { timeout: 30_000 })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.locator('body')).toHaveClass(/code-compact-layout/)
    await page.getByTestId('code-mobile-menu').tap()
    await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).tap()
    await page.waitForFunction(id => Boolean(window.__farmingTerminalTest?.isReady(id)), agentId, { timeout: 30_000 })

    const input = page.getByTestId('code-composer-input')
    const send = page.getByTestId('code-composer-send')
    await input.tap()
    await page.keyboard.insertText("printf 'MOBILE_RELOAD_ONCE\\n' >> after-mobile-reload.txt; printf 'MOBILE_RELOAD_UI_%s\\n' 'OK'")
    await send.tap()
    await expect.poll(() => fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : '', { timeout: 15_000 })
      .toBe('MOBILE_RELOAD_ONCE\n')
    await expect.poll(async () => {
      const response = await page.request.get(`/farming/api/agents/${agentId}/session-view`)
      const data = await response.json()
      return String(data.session?.renderOutput || data.session?.output || '')
    }, { timeout: 15_000 }).toContain('MOBILE_RELOAD_UI_OK')
    await expect.poll(async () => page.evaluate(
      id => (window.__farmingTerminalTest?.getRows(id, 10_000) ?? []).join('\n'),
      agentId,
    ), { timeout: 15_000 }).toContain('MOBILE_RELOAD_UI_OK')
    await captureIphoneAudit(page, 'iphone-webkit-terminal-after-reload.png')
  })

  test('keeps the shared compact layout usable after iPhone landscape rotation', async ({ page, workspaceRoot }, testInfo) => {
    test.skip(testInfo.project.name !== 'iphone-webkit', 'Runs only in the iPhone WebKit project')
    const projectDir = path.join(workspaceRoot, 'iphone-landscape')
    fs.mkdirSync(projectDir, { recursive: true })
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'maxTouchPoints', { value: 5, configurable: true })
    })
    await openFarming(page)

    const agentId = await createControlAgent(page, 'bash', projectDir)
    await page.getByTestId('code-mobile-menu').tap()
    await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).tap()
    await page.setViewportSize({ width: 844, height: 390 })
    await expect(page.locator('body')).toHaveClass(/code-compact-layout/)
    await expect.poll(async () => page.evaluate(() => {
      const main = document.querySelector<HTMLElement>('[data-testid="code-main"]')?.getBoundingClientRect()
      return main ? { right: Math.round(main.right), viewportWidth: window.innerWidth } : null
    }), { timeout: 5_000 }).toEqual({ right: 844, viewportWidth: 844 })
    const geometry = await page.evaluate(() => {
      const composer = document.querySelector<HTMLElement>('[data-testid="code-composer"]')?.getBoundingClientRect()
      const main = document.querySelector<HTMLElement>('[data-testid="code-main"]')?.getBoundingClientRect()
      if (!composer || !main) throw new Error('Landscape compact layout is incomplete')
      return {
        bodyWidth: document.body.scrollWidth,
        main: { left: main.left, right: main.right },
        composer: { left: composer.left, right: composer.right, bottom: composer.bottom },
        viewport: { width: window.innerWidth, height: window.innerHeight },
      }
    })
    expect(geometry.bodyWidth).toBeLessThanOrEqual(geometry.viewport.width + 1)
    expect(geometry.main.left).toBe(0)
    expect(geometry.main.right).toBe(geometry.viewport.width)
    expect(geometry.composer.left).toBeGreaterThanOrEqual(4)
    expect(geometry.composer.right).toBeLessThanOrEqual(geometry.viewport.width - 4)
    expect(geometry.composer.bottom).toBeLessThanOrEqual(geometry.viewport.height)
    const input = page.getByTestId('code-composer-input')
    await input.tap()
    await page.keyboard.insertText("printf 'IPHONE_LANDSCAPE_%s\\n' 'OK'")
    await page.getByTestId('code-composer-send').tap()
    await expect.poll(async () => {
      const response = await page.request.get(`/farming/api/agents/${agentId}/session-view`)
      const data = await response.json()
      return String(data.session?.renderOutput || data.session?.output || '')
    }, { timeout: 15_000 }).toContain('IPHONE_LANDSCAPE_OK')
    await expect.poll(async () => page.evaluate(
      id => (window.__farmingTerminalTest?.getRows(id, 10_000) ?? []).join('\n'),
      agentId,
    ), { timeout: 15_000 }).toContain('IPHONE_LANDSCAPE_OK')
    await captureIphoneAudit(page, 'iphone-webkit-landscape.png')
  })

  test('uses the same compact structure at 390px for desktop and iPhone input modes', async ({ page, workspaceRoot }, testInfo) => {
    const projectDir = path.join(workspaceRoot, `compact-parity-${testInfo.project.name}`)
    fs.mkdirSync(projectDir, { recursive: true })
    await page.setViewportSize({ width: 390, height: 844 })

    if (testInfo.project.name === 'iphone-webkit') {
      await page.addInitScript(() => {
        Object.defineProperty(navigator, 'maxTouchPoints', { value: 5, configurable: true })
      })
    }

    await openFarming(page)
    const agentId = await createControlAgent(page, 'bash', projectDir)
    const agentRow = page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
    await page.getByTestId('code-mobile-menu').click()
    await expect(agentRow).toBeVisible({ timeout: 30_000 })
    await agentRow.click()
    await expect(page.getByTestId('code-sidebar')).toHaveClass(/collapsed/)
    await expect(page.locator(`[data-testid="code-terminal-pane"][data-agent-id="${agentId}"]`)).toBeVisible({ timeout: 30_000 })

    await expect(page.locator('body')).toHaveClass(/code-compact-layout/)
    await expect(page.getByTestId('code-mobile-menu')).toBeVisible()
    await expect(page.getByTestId('code-mobile-more')).toBeVisible()
    await expect(page.getByTestId('code-composer-input')).toHaveJSProperty('tagName', 'TEXTAREA')
    if (testInfo.project.name === 'iphone-webkit') {
      await expect(page.locator('body')).toHaveClass(/code-mobile-touch/)
    } else {
      await expect(page.locator('body')).not.toHaveClass(/code-mobile-touch/)
    }

    const geometry = await page.evaluate(() => {
      const main = document.querySelector('[data-testid="code-main"]')?.getBoundingClientRect()
      const topbar = document.querySelector('[data-testid="code-mobile-topbar"]')?.getBoundingClientRect()
      const composer = document.querySelector('[data-testid="code-composer"]')?.getBoundingClientRect()
      if (!main || !topbar || !composer) throw new Error('Compact layout geometry is incomplete')
      return {
        main: { left: Math.round(main.left), right: Math.round(main.right), width: Math.round(main.width) },
        topbar: { left: Math.round(topbar.left), right: Math.round(topbar.right), height: Math.round(topbar.height) },
        composer: { left: Math.round(composer.left), right: Math.round(composer.right), height: Math.round(composer.height) },
      }
    })
    expect(geometry.main).toEqual({ left: 0, right: 390, width: 390 })
    expect(geometry.topbar.left).toBe(0)
    expect(geometry.topbar.right).toBe(390)
    expect(geometry.composer.left).toBeGreaterThanOrEqual(4)
    expect(geometry.composer.right).toBeLessThanOrEqual(386)

    const input = page.getByTestId('code-composer-input')
    const composer = page.getByTestId('code-composer')
    const blankPoint = await composer.evaluate(element => {
      const rect = element.getBoundingClientRect()
      for (let y = rect.top + 4; y < rect.bottom - 4; y += 4) {
        for (let x = rect.left + 4; x < rect.right - 4; x += 4) {
          if (document.elementFromPoint(x, y) === element) return { x, y }
        }
      }
      return null
    })
    expect(blankPoint).not.toBeNull()
    await page.mouse.click(blankPoint!.x, blankPoint!.y)
    await expect(input).toBeFocused()
    const readyMarker = `COMPACT_PARITY_READY_${testInfo.project.name.replace(/\W+/g, '_')}`
    await input.click()
    await page.keyboard.insertText(`echo ${readyMarker}`)
    await expect(input).toHaveValue(`echo ${readyMarker}`)
    await page.keyboard.press('Enter')
    await expect(input).toHaveValue('')
    await expect.poll(async () => {
      const response = await page.request.get(`/farming/api/agents/${agentId}/session-view`)
      const data = await response.json()
      return [data.session?.output, data.session?.renderOutput, data.session?.previewText]
        .filter(Boolean)
        .join('\n')
    }, { timeout: 30_000 }).toContain(readyMarker)
    await page.waitForTimeout(400)

    await captureIphoneAudit(page, `${testInfo.project.name}-390px-compact-parity.png`)
  })

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
    expect(await composerInput.evaluate(element => element.tagName)).toBe('TEXTAREA')
    await expect(composerInput).toHaveAttribute('placeholder', 'Type a shell command')
    await expect(composerInput).toHaveAttribute('name', 'farming-chat-message')
    await expect(composerInput).toHaveAttribute('inputmode', 'text')
    await expect(composerInput).toHaveAttribute('autocomplete', 'off')
    expect(await composerInput.evaluate(element => element.getAttribute('role'))).toBeNull()
    await composerInput.tap()
    await expect(composerInput).toBeFocused()
    const tapInputMarker = `IPHONE_TAP_INPUT_${Date.now()}`
    await page.keyboard.insertText(`echo ${tapInputMarker}`)
    await expect(composerInput).toHaveValue(`echo ${tapInputMarker}`)
    await expect(page.getByTestId('code-composer-send')).toBeEnabled()
    await page.keyboard.press('Enter')
    await expect(composerInput).toHaveValue('')
    await expect.poll(async () => {
      const response = await page.request.get(`/farming/api/agents/${agentId}/session-view`)
      const data = await response.json()
      return [
        data.session?.output,
        data.session?.renderOutput,
        data.session?.previewText,
      ].filter(Boolean).join('\n')
    }).toContain(tapInputMarker)

    const keyboardMetrics = await composer.evaluate(async element => {
      const root = document.documentElement
      document.body.classList.add('code-mode', 'code-compact-layout', 'code-mobile-touch', 'code-mobile-ios')
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
