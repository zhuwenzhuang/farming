import fs from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import {
  expect,
  openFarming,
  openNewAgentDialog,
  PLAYWRIGHT_WORKSPACE_ROOT,
  selectAgent,
  test,
} from './fixtures'

async function openWorkspaceFiles(page: Page, workspaceRoot: string) {
  await openFarming(page)
  await openNewAgentDialog(page)
  await selectAgent(page, 'bash')
  await page.getByTestId('workspace-input').fill(workspaceRoot)
  await page.getByTestId('workspace-start').click()
  await expect(page.getByTestId('input-dialog')).toBeHidden({ timeout: 30_000 })

  const project = page.getByTestId('code-project-group').filter({ hasText: path.basename(workspaceRoot) })
  await expect(project).toHaveCount(1, { timeout: 30_000 })
  const files = project.getByTestId('code-files-section')
  const filesTitle = files.locator('.code-files-title').first()
  if (await filesTitle.getAttribute('aria-expanded') !== 'true') await filesTitle.click()
  await expect(filesTitle).toHaveAttribute('aria-expanded', 'true')
  return files
}

test('converges uncertain file and directory creation from an authoritative parent reread', async ({ page }) => {
  const workspaceRoot = path.join(PLAYWRIGHT_WORKSPACE_ROOT, 'workspace-create-recovery')
  const parentPath = path.join(workspaceRoot, 'existing')
  fs.rmSync(workspaceRoot, { recursive: true, force: true })
  fs.mkdirSync(parentPath, { recursive: true })

  const files = await openWorkspaceFiles(page, workspaceRoot)

  const parentRow = files.locator('[data-testid="code-file-row"][data-file-path="existing"]')
  await expect(parentRow).toBeVisible()

  const uncertainNames = new Set(['recovered.txt', 'recovered-directory'])
  await page.route('**/farming/api/files/entry', async route => {
    const request = route.request()
    const body = request.method() === 'POST'
      ? request.postDataJSON() as { name?: string }
      : null
    if (!body?.name || !uncertainNames.has(body.name)) {
      await route.continue()
      return
    }
    const response = await route.fetch()
    expect(response.status()).toBe(201)
    uncertainNames.delete(body.name)
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'simulated response loss after create commit' }),
    })
  })

  await parentRow.click({ button: 'right' })
  await page.getByTestId('code-file-context-menu').getByRole('menuitem', { name: 'New File' }).click()
  const newFileInput = page.getByTestId('code-file-operation-input')
  await newFileInput.fill('recovered.txt')
  await newFileInput.press('Enter')

  await expect(page.getByTestId('code-file-operation-input')).toHaveCount(0)
  await expect(files.locator('[data-testid="code-file-row"][data-file-path="existing/recovered.txt"]')).toBeVisible()
  await expect(page.getByTestId('code-file-editor').getByRole('tab').filter({ hasText: 'recovered.txt' })).toHaveCount(1)
  expect(fs.statSync(path.join(parentPath, 'recovered.txt')).isFile()).toBe(true)

  await parentRow.click({ button: 'right' })
  await page.getByTestId('code-file-context-menu').getByRole('menuitem', { name: 'New Folder' }).click()
  const newFolderInput = page.getByTestId('code-file-operation-input')
  await newFolderInput.fill('recovered-directory')
  await newFolderInput.press('Enter')

  await expect(page.getByTestId('code-file-operation-input')).toHaveCount(0)
  await expect(files.locator('[data-testid="code-file-row"][data-file-path="existing/recovered-directory"]')).toBeVisible()
  expect(fs.statSync(path.join(parentPath, 'recovered-directory')).isDirectory()).toBe(true)
  expect(uncertainNames.size).toBe(0)
})

test('submits each file operation once and keeps newer operation UI when an older response arrives', async ({ page }) => {
  const workspaceRoot = path.join(PLAYWRIGHT_WORKSPACE_ROOT, 'workspace-create-browser-ownership')
  const parentPath = path.join(workspaceRoot, 'existing')
  fs.rmSync(workspaceRoot, { recursive: true, force: true })
  fs.mkdirSync(parentPath, { recursive: true })

  const files = await openWorkspaceFiles(page, workspaceRoot)
  const parentRow = files.locator('[data-testid="code-file-row"][data-file-path="existing"]')
  await expect(parentRow).toBeVisible()

  let singleSubmitCount = 0
  let releaseSingleSubmit!: () => void
  const singleSubmitGate = new Promise<void>(resolve => {
    releaseSingleSubmit = resolve
  })
  let lateSuccessCount = 0
  let releaseLateSuccess!: () => void
  const lateSuccessGate = new Promise<void>(resolve => {
    releaseLateSuccess = resolve
  })
  let lateErrorCount = 0
  let releaseLateError!: () => void
  const lateErrorGate = new Promise<void>(resolve => {
    releaseLateError = resolve
  })

  await page.route('**/farming/api/files/entry', async route => {
    const request = route.request()
    const body = request.method() === 'POST'
      ? request.postDataJSON() as { name?: string }
      : null
    if (body?.name === 'single-submit.txt') {
      singleSubmitCount += 1
      await singleSubmitGate
      await route.continue()
      return
    }
    if (body?.name === 'late-success.txt') {
      lateSuccessCount += 1
      await lateSuccessGate
      await route.continue()
      return
    }
    if (body?.name === 'late-error.txt') {
      lateErrorCount += 1
      await lateErrorGate
      await route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'simulated late create conflict' }),
      })
      return
    }
    await route.continue()
  })

  const startNewFile = async (name: string) => {
    await parentRow.click({ button: 'right' })
    await page.getByTestId('code-file-context-menu').getByRole('menuitem', { name: 'New File' }).click()
    const input = page.getByTestId('code-file-operation-input')
    await input.fill(name)
    return input
  }

  const singleSubmitInput = await startNewFile('single-submit.txt')
  await singleSubmitInput.evaluate(element => {
    const form = element.closest('form')
    if (!form) throw new Error('Missing file operation form')
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
  await expect.poll(() => singleSubmitCount).toBe(1)
  await page.waitForTimeout(100)
  expect(singleSubmitCount).toBe(1)
  await expect(singleSubmitInput).toBeDisabled()
  releaseSingleSubmit()
  await expect(page.getByTestId('code-file-operation-input')).toHaveCount(0)
  await expect(files.locator('[data-testid="code-file-row"][data-file-path="existing/single-submit.txt"]')).toBeVisible()

  const lateSuccessInput = await startNewFile('late-success.txt')
  await lateSuccessInput.press('Enter')
  await expect.poll(() => lateSuccessCount).toBe(1)
  await page.keyboard.press('Escape')
  await expect(lateSuccessInput).toHaveCount(0)

  const newerInput = await startNewFile('newer-operation.txt')
  await expect(newerInput).toBeFocused()
  releaseLateSuccess()
  await expect.poll(() => fs.existsSync(path.join(parentPath, 'late-success.txt'))).toBe(true)
  await expect(newerInput).toHaveValue('newer-operation.txt')
  await expect(newerInput).toBeFocused()
  await expect(page.getByTestId('code-file-editor').getByRole('tab').filter({ hasText: 'late-success.txt' })).toHaveCount(0)
  await newerInput.press('Escape')

  const lateErrorInput = await startNewFile('late-error.txt')
  await lateErrorInput.press('Enter')
  await expect.poll(() => lateErrorCount).toBe(1)
  await page.keyboard.press('Escape')
  await expect(lateErrorInput).toHaveCount(0)

  const latestInput = await startNewFile('latest-operation.txt')
  releaseLateError()
  await page.waitForTimeout(100)
  await expect(latestInput).toHaveValue('latest-operation.txt')
  await expect(latestInput).toBeFocused()
  await expect(files.getByTestId('code-file-open-error')).toHaveCount(0)
})

test('times out a lost create response and converges from a fresh authoritative reread', async ({ page }) => {
  const workspaceRoot = path.join(PLAYWRIGHT_WORKSPACE_ROOT, 'workspace-create-browser-timeout')
  const parentPath = path.join(workspaceRoot, 'existing')
  fs.rmSync(workspaceRoot, { recursive: true, force: true })
  fs.mkdirSync(parentPath, { recursive: true })

  const files = await openWorkspaceFiles(page, workspaceRoot)
  const parentRow = files.locator('[data-testid="code-file-row"][data-file-path="existing"]')
  await expect(parentRow).toBeVisible()
  await page.clock.install()

  let committed = false
  let releaseResponse!: () => void
  const responseGate = new Promise<void>(resolve => {
    releaseResponse = resolve
  })
  await page.route('**/farming/api/files/entry', async route => {
    const request = route.request()
    const body = request.method() === 'POST'
      ? request.postDataJSON() as { name?: string }
      : null
    if (body?.name !== 'timeout-recovered.txt') {
      await route.continue()
      return
    }
    const response = await route.fetch()
    expect(response.status()).toBe(201)
    committed = true
    await responseGate
    await route.fulfill({ response }).catch(() => {})
  })

  await parentRow.click({ button: 'right' })
  await page.getByTestId('code-file-context-menu').getByRole('menuitem', { name: 'New File' }).click()
  const input = page.getByTestId('code-file-operation-input')
  await input.fill('timeout-recovered.txt')
  await input.press('Enter')
  await expect.poll(() => committed).toBe(true)

  await page.clock.fastForward(15_001)
  await expect(page.getByTestId('code-file-operation-input')).toHaveCount(0)
  await expect(files.locator('[data-testid="code-file-row"][data-file-path="existing/timeout-recovered.txt"]')).toBeVisible()
  await expect(page.getByTestId('code-file-editor').getByRole('tab').filter({ hasText: 'timeout-recovered.txt' })).toHaveCount(1)
  releaseResponse()
})
