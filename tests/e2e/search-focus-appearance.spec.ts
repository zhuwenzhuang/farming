import fs from 'node:fs'
import path from 'node:path'
import type { Locator } from '@playwright/test'
import { expect, openFarming, openNewAgentDialog, test } from './fixtures'

async function expectTextFocus(input: Locator) {
  await expect(input).toBeFocused()
  await expect(input).toHaveCSS('box-shadow', 'none')
  await expect(input).toHaveCSS('outline-style', 'none')
  await expect.poll(() => input.evaluate(element => {
    const style = getComputedStyle(element)
    return style.caretColor !== 'transparent'
      && style.caretColor !== 'rgba(0, 0, 0, 0)'
      && style.caretColor !== style.backgroundColor
  })).toBe(true)
}

async function expectCaretOnlyFocus(box: Locator) {
  const input = box.locator('input')
  await expectTextFocus(input)
  for (const element of [box, input]) {
    await expect(element).toHaveCSS('box-shadow', 'none')
    await expect(element).toHaveCSS('outline-style', 'none')
  }
  await expect(box).toHaveCSS('border-top-color', 'rgba(0, 0, 0, 0)')
}

for (const appearance of ['light', 'dark', 'paper'] as const) {
  test(`workspace and file editing keep caret-only focus in ${appearance}`, async ({ page, workspaceRoot }) => {
    const workspace = path.join(workspaceRoot, 'focus-inputs')
    fs.mkdirSync(workspace, { recursive: true })
    fs.writeFileSync(path.join(workspace, 'notes.txt'), 'Focus review\n')
    const response = await page.request.post('/farming/api/control/agents', {
      data: { command: 'bash', workspace, name: 'Focus review' },
    })
    expect(response.ok()).toBeTruthy()
    await openFarming(page)
    await page.emulateMedia({ colorScheme: appearance === 'dark' ? 'dark' : 'light', reducedMotion: 'reduce' })
    await page.evaluate(value => {
      document.documentElement.dataset.appearance = value
      document.body.dataset.appearance = value
    }, appearance)

    // Discovery can include sessions from earlier tests and change the centered
    // dialog's height. Keep its unrelated recent-workspace list deterministic.
    await page.route('**/api/workspaces/discovered?**', route => route.fulfill({
      json: { workspaces: [{ path: '/workspace/example' }] },
    }))
    await openNewAgentDialog(page)
    await page.getByTestId('agent-option-bash').click()
    await expect(page.getByTestId('workspace-history-item')).toHaveCount(1)
    await expect(page.getByTestId('workspace-history-item')).toContainText('/workspace/example')
    const workspaceInput = page.getByTestId('workspace-input')
    const completion = page.waitForResponse(response => {
      const url = new URL(response.url())
      return url.pathname.endsWith('/api/workspaces/complete')
        && url.searchParams.get('path') === '/workspace/example'
    })
    await workspaceInput.fill('/workspace/example')
    // Wait for the field's debounced completion cycle (and initial autofocus)
    // before testing Tab, rather than racing the dialog's delayed entry focus.
    await completion
    await expectTextFocus(workspaceInput)
    const focusedBorder = await workspaceInput.evaluate(element => getComputedStyle(element).borderColor)
    await page.keyboard.press('Tab')
    await expect(workspaceInput).not.toBeFocused()
    await expect(workspaceInput).toHaveCSS('border-color', focusedBorder)
    await page.keyboard.press('Shift+Tab')
    await expectTextFocus(workspaceInput)
    await page.keyboard.press('ArrowRight')
    await expect.poll(() => workspaceInput.evaluate((input: HTMLInputElement) => input.selectionStart === input.selectionEnd)).toBe(true)
    await expect(workspaceInput).toHaveScreenshot(`workspace-input-focus-${appearance}.png`)
    await page.getByTestId('input-dialog-close').click()

    const project = page.getByTestId('code-project-group').filter({ hasText: 'focus-inputs' })
    const files = project.getByTestId('code-files-section')
    const filesTitle = files.locator('.code-files-title')
    if (await filesTitle.getAttribute('aria-expanded') !== 'true') await filesTitle.click()
    const fileRow = files.locator('[data-testid="code-file-row"][data-file-path="notes.txt"]')
    await fileRow.click()
    await expect(page.locator('.monaco-editor textarea.inputarea')).toBeFocused()
    await fileRow.click({ button: 'right' })
    await page.getByTestId('code-file-context-menu').getByRole('menuitem', { name: 'Rename', exact: true }).click()
    const renameInput = fileRow.getByTestId('code-file-operation-input')
    await expectTextFocus(renameInput)
    await renameInput.fill('renamed.txt')
    await expect(renameInput).toHaveValue('renamed.txt')
    await expectTextFocus(renameInput)
    await expect(renameInput).toHaveCSS('border-color', 'rgba(0, 0, 0, 0)')
    await page.mouse.move(0, 0)
    await expect(fileRow).toHaveScreenshot(`file-rename-focus-${appearance}.png`)
    await renameInput.press('Escape')
    await expect(renameInput).toHaveCount(0)
    expect(fs.existsSync(path.join(workspace, 'notes.txt'))).toBe(true)
    expect(fs.existsSync(path.join(workspace, 'renamed.txt'))).toBe(false)
  })

  for (const view of ['history', 'search'] as const) {
    test(`${view} text focus uses a caret without a frame in ${appearance}`, async ({ page, workspaceRoot }) => {
      // Keep a real Project and Agent beside the panel, not just an isolated input.
      const response = await page.request.post('/farming/api/control/agents', {
        data: { command: 'bash', workspace: workspaceRoot, name: 'Focus review' },
      })
      expect(response.ok()).toBeTruthy()
      await openFarming(page)
      await page.emulateMedia({ colorScheme: appearance === 'dark' ? 'dark' : 'light', reducedMotion: 'reduce' })
      await page.evaluate(value => {
        document.documentElement.dataset.appearance = value
        document.body.dataset.appearance = value
      }, appearance)
      await page.getByTestId(`code-nav-${view}`).click()
      const panel = page.getByTestId(`code-${view}-panel`)
      const box = page.getByTestId(view === 'history' ? 'code-history-search-box' : 'code-search-box')
      const input = box.locator('input')
      await expect(panel).toBeVisible()

      await input.click()
      await expectCaretOnlyFocus(box)
      await input.pressSequentially('focus review')
      await expect(input).toHaveValue('focus review')
      await expectCaretOnlyFocus(box)

      // Return to the input through actual keyboard navigation as well.
      await page.keyboard.press('Tab')
      await expect(box.getByRole('button', { name: 'Clear search' })).toBeFocused()
      await page.keyboard.press('Shift+Tab')
      await expectCaretOnlyFocus(box)
      await input.fill('')
      await page.mouse.move(0, 0)
      await expect(box).toHaveScreenshot(`${view}-focus-${appearance}.png`)
      if (view === 'history') {
        await expect(panel.locator('.code-history-panel-header')).toHaveScreenshot(`history-header-focus-${appearance}.png`)
        await page.getByTestId('code-history-back').focus()
        await page.keyboard.press('Tab')
        await expectCaretOnlyFocus(box)
        await page.keyboard.press('Shift+Tab')
        await expect(page.getByTestId('code-history-back')).toHaveCSS('outline-style', 'solid')
      }
    })
  }
}
