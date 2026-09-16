import fs from 'node:fs'
import path from 'node:path'
import { expect, openFarming, test } from './fixtures'

for (const appearance of ['light', 'dark', 'paper'] as const) {
  test(`Settings and About share modal keyboard ownership in ${appearance}`, async ({ page }, testInfo) => {
    await page.route('**/api/update*', route => route.fulfill({
      json: { update: { available: false, versions: [] } },
    }))
    await openFarming(page)
    await page.evaluate(value => {
      document.body.dataset.appearance = value
      document.documentElement.dataset.appearance = value
    }, appearance)
    for (const compact of [false, true]) {
      await page.setViewportSize(compact ? { width: 393, height: 852 } : { width: 1280, height: 900 })
      if (compact) await page.getByTestId('code-mobile-menu').click()
      const trigger = page.getByTestId('code-sidebar-options')
      await trigger.focus()
      await trigger.press('Enter')
      const settings = page.getByTestId('code-settings-panel')
      const close = settings.getByRole('button', { name: compact ? 'Back to navigation' : 'Close', exact: true })
      await expect(close).toBeFocused()
      await expect(page.locator('#root')).toHaveAttribute('inert', '')
      await expect(settings.locator('.code-settings-update-refresh')).toBeEnabled()
      await expect(settings.locator('.code-settings-panel')).toHaveCSS('transform', 'none')
      await page.keyboard.press('Shift+Tab')
      await expect.poll(() => settings.evaluate(el => el.contains(document.activeElement) ? 'inside' : document.activeElement?.outerHTML.slice(0, 500))).toBe('inside')
      await page.keyboard.press('Tab')
      await expect(close).toBeFocused()
      await close.dispatchEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true })
      await expect(settings).toBeVisible()
      await close.dispatchEvent('keydown', { key: 'Escape', repeat: true, bubbles: true })
      await expect(settings).toBeVisible()
      await page.screenshot({ path: testInfo.outputPath(`settings-${compact ? 'compact' : 'desktop'}-${appearance}.png`), animations: 'disabled' })
      await page.keyboard.press('Escape')
      await expect(settings).toBeHidden()
      await expect(trigger).toBeFocused()
      await expect(page.locator('#root')).not.toHaveAttribute('inert', '')
      await page.getByTestId('code-product-mark').click()
      const about = page.getByTestId('code-brand-dialog')
      const aboutClose = about.getByRole('button', { name: 'Close', exact: true })
      await expect(aboutClose).toBeFocused()
      await expect(aboutClose.locator('svg')).toHaveCount(1)
      await expect(aboutClose).toHaveCSS('border-radius', '6px')
      await page.keyboard.press('Shift+Tab')
      await expect.poll(() => about.evaluate(el => el.contains(document.activeElement))).toBe(true)
      await expect(about.locator('.code-brand-dialog')).toHaveScreenshot(`about-${compact ? 'compact' : 'desktop'}-${appearance}.png`)
      await aboutClose.click()
      await expect(about).toBeHidden()
      if (!compact) {
        await page.getByTestId('code-sidebar-focus-toggle').click()
        const appMode = page.getByTestId('code-app-mode-dialog')
        const appClose = appMode.getByRole('button', { name: 'Close', exact: true })
        await expect(appClose).toBeFocused()
        await expect(appClose.locator('svg')).toHaveCount(1)
        await expect(appClose).toHaveCSS('border-radius', '6px')
        await expect(appMode.getByRole('dialog')).toHaveScreenshot(`app-mode-${appearance}.png`)
        await appClose.click()
      } else {
        await page.route('**/api/share/qr-ticket', route => route.fulfill({ json: {
          code: 'UIAUDIT', expiresAt: Date.now() + 300_000, ttlMs: 300_000,
          shortPath: '/j/UIAUDIT', shortUrl: 'https://share.example.test/j/UIAUDIT',
          longUrl: 'https://share.example.test/farming?token=read-only',
          fullAccessUrl: 'https://share.example.test/farming?token=full-control',
          shortUrlAccessMode: 'owner', longUrlAccessMode: 'read-only', tokenLabel: 'UI fixture',
        } }))
        await page.getByTestId('code-nav-history').click()
        await expect(page.getByTestId('code-history-panel')).toBeVisible()
        await expect(page.getByTestId('code-history-loading')).toBeHidden()
        await page.getByTestId('code-mobile-more').click()
        await page.getByRole('menuitem', { name: 'Share current page', exact: true }).click()
        const share = page.getByTestId('code-mobile-share-sheet')
        const shareClose = share.getByRole('button', { name: 'Close', exact: true })
        await expect(shareClose).toBeFocused()
        await expect(shareClose.locator('svg')).toHaveCount(1)
        await expect(shareClose).toHaveCSS('border-radius', '6px')
        await expect(share.locator('.code-mobile-share-header')).toHaveScreenshot(`share-header-${appearance}.png`)
        await shareClose.click()
        await expect(share).toBeHidden()
      }
    }
  })

  test(`Home fields and actions share visual states and compact targets in ${appearance}`, async ({ page }) => {
    await page.route('**/farming/api/agent-extensions', route => route.fulfill({ json: { agents: [{
      id: 'codex', name: 'Codex', description: '', available: true, discoverySupported: true,
      acpExecutablePolicy: 'managed', supportsChat: true,
      launchDefaults: { homeId: 'default', runtimeMode: 'chat' },
      homes: ['default', 'work'].map((id, order) => ({
        id, order, path: `/workspace/agent-homes/${id}`,
        acpRuntime: { mode: 'managed', executable: '' },
        newAgentDefaults: { model: 'inherit', reasoning: 'inherit', fast: 'inherit' },
        configuration: { exists: true, filePath: `/workspace/agent-homes/${id}/config.toml`, rootId: id, summary: [{ key: 'model', value: 'example-model' }] },
        extensions: [],
      })),
    }] } }))
    await openFarming(page)
    await page.getByTestId('code-nav-plugins').click()
    const panel = page.getByTestId('code-plugins-panel')
    await panel.getByTestId('code-plugin-tab-homes').click()
    await panel.getByRole('button', { name: 'Add Agent', exact: true }).click()
    const form = panel.getByTestId('code-plugin-agent-form')
    const home = panel.getByTestId('code-plugin-section-agent-codex-default')
    await page.evaluate(value => {
      document.body.dataset.appearance = value
      document.documentElement.dataset.appearance = value
    }, appearance)
    for (const compact of [false, true]) {
      await page.setViewportSize(compact ? { width: 393, height: 852 } : { width: 1280, height: 900 })
      const provider = form.getByRole('combobox')
      const input = form.getByLabel('Home path')
      for (const property of ['height', 'border-radius', 'background-color', 'font-size', 'line-height'] as const) {
        await expect(input).toHaveCSS(property, await provider.evaluate((el, key) => getComputedStyle(el).getPropertyValue(key), property))
      }
      await expect(input).toHaveCSS('border-radius', '6px')
      const edit = home.getByRole('button', { name: 'Edit configuration', exact: true })
      await input.click()
      await edit.hover()
      await expect(edit).not.toBeFocused()
      await expect(edit).toHaveCSS('outline-style', 'none')
      await page.keyboard.press('Tab')
      await edit.focus()
      await expect(edit).toHaveCSS('outline-style', 'solid')
      await page.mouse.move(0, 0)
      const drag = home.getByRole('button', { name: 'Drag to reorder Agents', exact: true })
      if (compact) {
        for (const control of [edit, drag, home.getByRole('combobox'), panel.getByRole('button', { name: 'Add Agent', exact: true }), form.getByRole('button', { name: 'Save', exact: true })]) {
          const box = await control.boundingBox()
          expect(box!.width).toBeGreaterThanOrEqual(44)
          expect(box!.height).toBeGreaterThanOrEqual(44)
        }
        await expect.poll(() => home.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
      }
      await expect(form).toHaveScreenshot(`home-form-${compact ? 'compact' : 'desktop'}-${appearance}.png`)
      await expect(home).toHaveScreenshot(`home-actions-${compact ? 'compact' : 'desktop'}-${appearance}.png`)
    }
  })
}

test('file edits and search retain composition and consume Escape once', async ({ page, workspaceRoot }) => {
  const workspace = path.join(workspaceRoot, 'sample-ui-consistency')
  fs.mkdirSync(workspace)
  fs.writeFileSync(path.join(workspace, 'sample.txt'), 'Sample content\n')
  const response = await page.request.post('/farming/api/control/agents', { data: { command: 'bash', workspace } })
  expect(response.ok()).toBeTruthy()
  await openFarming(page)
  const project = page.getByTestId('code-project-group').filter({ hasText: 'sample-ui-consistency' })
  const files = project.getByTestId('code-files-section')
  const title = files.locator('.code-files-title')
  if (await title.getAttribute('aria-expanded') !== 'true') await title.click()
  const row = files.locator('[data-testid="code-file-row"][data-file-path="sample.txt"]')
  await row.click({ button: 'right' })
  await page.getByTestId('code-file-context-menu').getByRole('menuitem', { name: 'Rename', exact: true }).click()
  const input = page.getByTestId('code-file-operation-input')
  await input.fill('draft-name.txt')
  for (const key of ['Escape', 'Enter']) {
    await input.dispatchEvent('keydown', { key, isComposing: true, bubbles: true, cancelable: true })
    await expect(input).toHaveValue('draft-name.txt')
  }
  await input.dispatchEvent('keydown', { key: 'Escape', repeat: true, bubbles: true, cancelable: true })
  await expect(input).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(input).toBeHidden()
  expect(fs.existsSync(path.join(workspace, 'sample.txt'))).toBe(true)
  expect(fs.existsSync(path.join(workspace, 'draft-name.txt'))).toBe(false)
  const search = files.locator('.code-file-search-box input')
  await search.fill('sample')
  await search.dispatchEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true, cancelable: true })
  await expect(search).toHaveValue('sample')
  await page.getByTestId('code-sidebar-options').click()
  await page.keyboard.down('Escape')
  await expect(page.getByTestId('code-settings-panel')).toBeHidden()
  await page.keyboard.down('Escape')
  await expect(search).toHaveValue('sample')
  await page.keyboard.up('Escape')
  await page.keyboard.press('Escape')
  await expect(search).toHaveValue('')
})
