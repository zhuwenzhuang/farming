import fs from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import {
  expect,
  interceptWorkspaceRequests,
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

  const uncertainNames = new Set(['recovered.txt', 'recovered-directory'])
  await interceptWorkspaceRequests(page, request => {
    if (request.operation !== 'create-entry' || !uncertainNames.has(request.name)) return
    const name = request.name
    return {
      onResult: response => {
        expect(response.ok).toBe(true)
        uncertainNames.delete(name)
        return {
          type: 'workspace-result',
          requestId: response.requestId,
          ok: false,
          error: {
            code: 'SIMULATED_RESPONSE_LOSS',
            message: 'simulated response loss after create commit',
            status: 503,
            uncertain: true,
          },
        }
      },
    }
  })
  const files = await openWorkspaceFiles(page, workspaceRoot)

  const parentRow = files.locator('[data-testid="code-file-row"][data-file-path="existing"]')
  await expect(parentRow).toBeVisible()

  await parentRow.focus()
  await parentRow.dispatchEvent('keydown', {
    key: 'ContextMenu',
    bubbles: true,
    cancelable: true,
  })
  const keyboardFileMenu = page.getByTestId('code-file-context-menu')
  await expect(keyboardFileMenu).toBeVisible()
  await expect(keyboardFileMenu.getByRole('menuitem').first()).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(keyboardFileMenu).toHaveCount(0)

  await parentRow.click({ button: 'right' })
  const fileMenu = page.getByTestId('code-file-context-menu')
  await expect(fileMenu).toBeVisible()
  await expect(fileMenu.getByRole('menuitem').first()).not.toBeFocused()
  await fileMenu.getByRole('menuitem', { name: 'New File' }).click()
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
  let lateErrorSettled = false
  let releaseLateError!: () => void
  const lateErrorGate = new Promise<void>(resolve => {
    releaseLateError = resolve
  })

  await interceptWorkspaceRequests(page, async request => {
    if (request.operation !== 'create-entry') return
    if (request.name === 'single-submit.txt') {
      singleSubmitCount += 1
      await singleSubmitGate
      return
    }
    if (request.name === 'late-success.txt') {
      lateSuccessCount += 1
      await lateSuccessGate
      return
    }
    if (request.name === 'late-error.txt') {
      lateErrorCount += 1
      await lateErrorGate
      lateErrorSettled = true
      return {
        response: {
          ok: false,
          error: {
            code: 'SIMULATED_CREATE_CONFLICT',
            message: 'simulated late create conflict',
            status: 409,
          },
        },
      }
    }
  })

  const files = await openWorkspaceFiles(page, workspaceRoot)
  const parentRow = files.locator('[data-testid="code-file-row"][data-file-path="existing"]')
  await expect(parentRow).toBeVisible()

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
  await expect.poll(() => lateErrorSettled).toBe(true)
  await expect(latestInput).toHaveValue('latest-operation.txt')
  await expect(latestInput).toBeFocused()
  await expect(files.getByTestId('code-file-open-error')).toHaveCount(0)
})

test('times out a lost create response and converges from a fresh authoritative reread', async ({ page }) => {
  const workspaceRoot = path.join(PLAYWRIGHT_WORKSPACE_ROOT, 'workspace-create-browser-timeout')
  const parentPath = path.join(workspaceRoot, 'existing')
  fs.rmSync(workspaceRoot, { recursive: true, force: true })
  fs.mkdirSync(parentPath, { recursive: true })

  let committed = false
  let releaseResponse!: () => void
  const responseGate = new Promise<void>(resolve => {
    releaseResponse = resolve
  })
  await interceptWorkspaceRequests(page, request => {
    if (request.operation !== 'create-entry' || request.name !== 'timeout-recovered.txt') return
    return {
      onResult: async response => {
        expect(response.ok).toBe(true)
        committed = true
        await responseGate
        return response
      },
    }
  })

  const files = await openWorkspaceFiles(page, workspaceRoot)
  const parentRow = files.locator('[data-testid="code-file-row"][data-file-path="existing"]')
  await expect(parentRow).toBeVisible()
  await page.clock.install()

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

test('converges uncertain rename and delete outcomes from the authoritative parent', async ({ page }) => {
  const workspaceRoot = path.join(PLAYWRIGHT_WORKSPACE_ROOT, 'workspace-mutation-recovery')
  const parentPath = path.join(workspaceRoot, 'existing')
  fs.rmSync(workspaceRoot, { recursive: true, force: true })
  fs.mkdirSync(parentPath, { recursive: true })
  fs.writeFileSync(path.join(parentPath, 'rename-me.txt'), 'rename recovery\n')
  fs.writeFileSync(path.join(parentPath, 'delete-me.txt'), 'delete recovery\n')

  const uncertainOperations = new Set(['rename-entry', 'delete-entry'])
  await interceptWorkspaceRequests(page, request => {
    if (!uncertainOperations.has(request.operation)) return
    const operation = request.operation
    return {
      onResult: response => {
        expect(response.ok).toBe(true)
        uncertainOperations.delete(operation)
        return {
          type: 'workspace-result',
          requestId: response.requestId,
          ok: false,
          error: {
            code: 'SIMULATED_RESPONSE_LOSS',
            message: `simulated response loss after ${operation} commit`,
            status: 503,
            uncertain: true,
          },
        }
      },
    }
  })
  const files = await openWorkspaceFiles(page, workspaceRoot)
  const parentRow = files.locator('[data-testid="code-file-row"][data-file-path="existing"]')
  await parentRow.click()
  const renameRow = files.locator('[data-testid="code-file-row"][data-file-path="existing/rename-me.txt"]')
  const deleteRow = files.locator('[data-testid="code-file-row"][data-file-path="existing/delete-me.txt"]')
  await expect(renameRow).toBeVisible()
  await expect(deleteRow).toBeVisible()
  await renameRow.click()
  await expect(page.getByTestId('code-file-editor')).not.toHaveClass(/fallback/)
  const originalRenameTab = page.locator('.code-file-editor-tab[title="existing/rename-me.txt"]')
  await expect(originalRenameTab).toHaveCount(1)
  await expect(originalRenameTab).toHaveAttribute('data-preview', 'true')
  await originalRenameTab.dblclick()
  await expect(originalRenameTab).not.toHaveAttribute('data-preview', 'true')
  await deleteRow.click()
  const originalDeleteTab = page.locator('.code-file-editor-tab[title="existing/delete-me.txt"]')
  await expect(originalDeleteTab).toHaveCount(1)
  await expect(originalDeleteTab).toHaveAttribute('data-preview', 'true')
  await originalDeleteTab.dblclick()
  await expect(originalDeleteTab).not.toHaveAttribute('data-preview', 'true')

  await renameRow.click({ button: 'right' })
  await page.getByTestId('code-file-context-menu').getByRole('menuitem', { name: 'Rename' }).click()
  const renameInput = renameRow.getByTestId('code-file-operation-input')
  await renameInput.fill('renamed-after-loss.txt')
  await renameInput.press('Enter')
  const renamedRow = files.locator('[data-testid="code-file-row"][data-file-path="existing/renamed-after-loss.txt"]')
  await expect(renamedRow).toBeVisible()
  await expect(renameRow).toHaveCount(0)
  await expect(page.locator('.code-file-editor-tab[title="existing/renamed-after-loss.txt"]')).toHaveCount(1)
  expect(fs.existsSync(path.join(parentPath, 'rename-me.txt'))).toBe(false)
  expect(fs.existsSync(path.join(parentPath, 'renamed-after-loss.txt'))).toBe(true)

  await deleteRow.click({ button: 'right' })
  await page.getByTestId('code-file-context-menu').getByRole('menuitem', { name: 'Delete' }).click()
  await page.getByTestId('code-file-operation-dialog').getByRole('button', { name: 'Delete' }).click()
  await expect(deleteRow).toHaveCount(0)
  await expect(page.locator('.code-file-editor-tab[title="existing/delete-me.txt"]')).toHaveCount(0)
  expect(fs.existsSync(path.join(parentPath, 'delete-me.txt'))).toBe(false)
  expect(uncertainOperations.size).toBe(0)
})

test('keeps conflicting rename and delete operations available for an explicit retry', async ({ page }) => {
  const workspaceRoot = path.join(PLAYWRIGHT_WORKSPACE_ROOT, 'workspace-mutation-retry')
  fs.rmSync(workspaceRoot, { recursive: true, force: true })
  fs.mkdirSync(workspaceRoot, { recursive: true })
  fs.writeFileSync(path.join(workspaceRoot, 'rename-conflict.txt'), 'rename retry\n')
  fs.writeFileSync(path.join(workspaceRoot, 'delete-conflict.txt'), 'delete retry\n')

  let rejectRename = true
  let rejectDelete = true
  let renameRequestCount = 0
  let deleteRequestCount = 0
  await interceptWorkspaceRequests(page, request => {
    if (request.operation === 'rename-entry') {
      renameRequestCount += 1
      if (rejectRename) {
        rejectRename = false
        return {
          response: {
            ok: false,
            error: {
              code: 'SIMULATED_RENAME_CONFLICT',
              message: 'simulated rename conflict',
              status: 409,
            },
          },
        }
      }
    }
    if (request.operation === 'delete-entry') {
      deleteRequestCount += 1
      if (rejectDelete) {
        rejectDelete = false
        return {
          response: {
            ok: false,
            error: {
              code: 'SIMULATED_DELETE_CONFLICT',
              message: 'simulated delete conflict',
              status: 409,
            },
          },
        }
      }
    }
  })

  const files = await openWorkspaceFiles(page, workspaceRoot)
  const renameRow = files.locator('[data-testid="code-file-row"][data-file-path="rename-conflict.txt"]')
  const deleteRow = files.locator('[data-testid="code-file-row"][data-file-path="delete-conflict.txt"]')

  await renameRow.click({ button: 'right' })
  await page.getByTestId('code-file-context-menu').getByRole('menuitem', { name: 'Rename' }).click()
  const renameInput = renameRow.getByTestId('code-file-operation-input')
  await renameInput.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
  await renameInput.pressSequentially('renamed-after-retry.txt')
  await renameInput.press('Enter')
  await expect(files.getByTestId('code-file-open-error')).toContainText('simulated rename conflict')
  await expect(renameInput).toBeEnabled()
  await expect(renameInput).toHaveValue('renamed-after-retry.txt')
  await renameInput.press('Enter')
  await expect(files.locator('[data-testid="code-file-row"][data-file-path="renamed-after-retry.txt"]')).toBeVisible()
  expect(renameRequestCount).toBe(2)

  await deleteRow.click({ button: 'right' })
  await page.getByTestId('code-file-context-menu').getByRole('menuitem', { name: 'Delete' }).click()
  const deleteDialog = page.getByTestId('code-file-operation-dialog')
  const deleteButton = deleteDialog.getByRole('button', { name: 'Delete' })
  await deleteButton.click()
  await expect(files.getByTestId('code-file-open-error')).toContainText('simulated delete conflict')
  await expect(deleteDialog).toBeVisible()
  await expect(deleteButton).toBeEnabled()
  await deleteButton.click()
  await expect(deleteRow).toHaveCount(0)
  expect(deleteRequestCount).toBe(2)
})
