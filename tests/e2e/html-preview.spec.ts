import fs from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { expect, interceptWorkspaceRequests, openFarming, test } from './fixtures'

async function createControlAgent(page: Page, workspace: string) {
  const response = await page.request.post('/farming/api/control/agents', {
    data: { command: 'bash', workspace },
  })
  expect(response.ok()).toBeTruthy()
  const body = await response.json() as { agentId?: string }
  expect(body.agentId).toBeTruthy()
  return body.agentId as string
}

async function openProjectFile(page: Page, projectName: string, filePath: string) {
  const project = page.getByTestId('code-project-group').filter({ hasText: projectName })
  await expect(project).toBeVisible({ timeout: 30_000 })
  const files = project.getByTestId('code-files-section')
  const filesTitle = files.locator('.code-files-title').first()
  if (await filesTitle.getAttribute('aria-expanded') !== 'true') await filesTitle.click()

  const segments = filePath.split('/')
  for (let index = 0; index < segments.length - 1; index += 1) {
    const directoryPath = segments.slice(0, index + 1).join('/')
    const directory = files.locator(`[data-testid="code-file-row"][data-file-path="${directoryPath}"]`)
    await expect(directory).toBeVisible()
    if (await directory.getAttribute('aria-expanded') !== 'true') await directory.click()
  }

  const file = files.locator(`[data-testid="code-file-row"][data-file-path="${filePath}"]`)
  await expect(file).toBeVisible()
  await file.dblclick()
}

function writePreviewWorkspace(workspace: string) {
  fs.mkdirSync(path.join(workspace, 'site', 'assets'), { recursive: true })
  fs.writeFileSync(path.join(workspace, 'root.css'), '.root-style { color: rgb(7, 8, 9); }\n')
  fs.writeFileSync(
    path.join(workspace, 'root-pixel.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="blue"/></svg>\n',
  )
  fs.writeFileSync(
    path.join(workspace, 'site', 'assets', 'site.css'),
    [
      '@import url("https://preview-external.invalid/import.css");',
      '.relative-style { color: rgb(4, 5, 6); background-image: url("https://preview-external.invalid/background.png"); }',
      '',
    ].join('\n'),
  )
  fs.writeFileSync(
    path.join(workspace, 'site', 'assets', 'pixel.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="red"/></svg>\n',
  )
  fs.writeFileSync(
    path.join(workspace, 'site', 'index.html'),
    [
      '<!doctype html>',
      '<html><head>',
      '<link rel="stylesheet" href="assets/site.css">',
      '<link rel="stylesheet" href="/root.css">',
      '</head><body>',
      '<h1 class="relative-style">Relative CSS</h1>',
      '<p class="root-style">Root CSS</p>',
      '<img id="relative-image" src="assets/pixel.svg">',
      '<img id="root-image" src="/root-pixel.svg">',
      '<img id="missing-image" src="assets/missing.svg">',
      '<img id="external-image" src="https://preview-external.invalid/pixel.svg">',
      '<img id="data-image" src="data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'2\' height=\'2\'%3E%3C/svg%3E">',
      '<iframe id="nested-frame" src="https://preview-external.invalid/frame.html"></iframe>',
      '<form id="external-form" action="https://preview-external.invalid/submit"><button type="submit">Submit</button></form>',
      '<button id="inline-handler" onclick="document.body.dataset.inlineHandler = \'ran\'">Click</button>',
      '<a id="next-page" href="pages/second.html">Next page</a>',
      '<script>document.body.dataset.script = "ran"</script>',
      '</body></html>',
      '',
    ].join('\n'),
  )
  fs.mkdirSync(path.join(workspace, 'site', 'pages'), { recursive: true })
  fs.writeFileSync(
    path.join(workspace, 'site', 'pages', 'second.html'),
    [
      '<!doctype html><html><head>',
      '<link rel="stylesheet" href="../assets/site.css">',
      '<link rel="stylesheet" href="/root.css">',
      '</head><body>',
      '<h2 class="relative-style">Second page</h2>',
      '<p class="root-style">Second root style</p>',
      '<script>document.body.dataset.script = "ran"</script>',
      '</body></html>',
    ].join('\n'),
  )
  fs.writeFileSync(
    path.join(workspace, 'site', 'fragment.HTML'),
    '<main><h2 id="fragment-title">你好，Farming</h2><img src="/root-pixel.svg"></main>\n',
  )
  fs.writeFileSync(path.join(workspace, 'site', 'error.html'), '<h1>Error retry</h1>\n')
}

test.describe('HTML Preview', () => {
  test('renders relative and root assets while keeping active content sandboxed', async ({ page, workspaceRoot }) => {
    const workspace = path.join(workspaceRoot, 'html-preview-matrix')
    writePreviewWorkspace(workspace)
    await createControlAgent(page, workspace)
    const deletedPreviewIds: string[] = []
    await interceptWorkspaceRequests(page, request => {
      if (request.operation === 'delete-preview') deletedPreviewIds.push(request.previewId)
    })

    const externalResponses: string[] = []
    let externalRouteHits = 0
    await page.route('https://preview-external.invalid/**', async route => {
      externalRouteHits += 1
      await route.fulfill({ status: 200, contentType: 'text/plain', body: 'unexpected external response' })
    })
    page.on('response', response => {
      if (response.url().startsWith('https://preview-external.invalid/')) externalResponses.push(response.url())
    })

    await openFarming(page)
    await openProjectFile(page, 'html-preview-matrix', 'site/index.html')

    const iframe = page.getByTestId('code-file-html-preview')
    await expect(iframe).toBeVisible()
    await expect(iframe).toHaveAttribute('sandbox', '')
    await expect(page.getByTestId('code-file-editor').locator('.code-file-editor-bar')).toHaveCount(0)

    await page.getByTestId('code-file-editor').locator('.code-file-editor-action.source-preview').click()
    await expect(page.getByTestId('code-file-editor').locator('.code-file-editor-bar')).toBeVisible()
    await page.getByTestId('code-file-editor').locator('.code-file-editor-action.source-preview').click()
    await expect(iframe).toBeVisible()
    await expect(iframe).toHaveAttribute('referrerpolicy', 'no-referrer')
    const frame = page.frameLocator('[data-testid="code-file-html-preview"]')
    await expect(frame.locator('h1')).toHaveText('Relative CSS')
    await expect.poll(() => frame.locator('h1').evaluate(element => getComputedStyle(element).color)).toBe('rgb(4, 5, 6)')
    await expect.poll(() => frame.locator('.root-style').evaluate(element => getComputedStyle(element).color)).toBe('rgb(7, 8, 9)')
    await expect.poll(() => frame.locator('#relative-image').evaluate((element: HTMLImageElement) => element.naturalWidth)).toBeGreaterThan(0)
    await expect.poll(() => frame.locator('#root-image').evaluate((element: HTMLImageElement) => element.naturalWidth)).toBeGreaterThan(0)
    await expect.poll(() => frame.locator('#missing-image').evaluate((element: HTMLImageElement) => element.complete)).toBe(true)
    await expect.poll(() => frame.locator('#external-image').evaluate((element: HTMLImageElement) => element.complete)).toBe(true)
    await expect.poll(() => frame.locator('#external-image').evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(0)
    await expect.poll(() => frame.locator('#data-image').evaluate((element: HTMLImageElement) => element.naturalWidth)).toBeGreaterThan(0)
    await expect(frame.locator('#nested-frame')).toHaveJSProperty('contentDocument', null)
    await expect(frame.locator('body')).not.toHaveAttribute('data-script', 'ran')
    await frame.locator('#inline-handler').click()
    await expect(frame.locator('body')).not.toHaveAttribute('data-inline-handler', 'ran')
    await frame.locator('#external-form button').click()
    expect(externalResponses).toEqual([])
    expect(externalRouteHits).toBe(0)
    await frame.locator('#next-page').click()
    await expect(frame.locator('h2')).toHaveText('Second page')
    await expect.poll(() => frame.locator('h2').evaluate(element => getComputedStyle(element).color)).toBe('rgb(4, 5, 6)')
    await expect.poll(() => frame.locator('.root-style').evaluate(element => getComputedStyle(element).color)).toBe('rgb(7, 8, 9)')
    await expect(frame.locator('body')).not.toHaveAttribute('data-script', 'ran')

    await page.getByRole('button', { name: 'Show source' }).click()
    await expect(page.getByTestId('code-file-monaco')).toBeVisible()
    await page.evaluate(() => {
      if (!window.__farmingFileEditorTest?.insertText('<p id="draft-update">Unsaved draft</p>')) {
        throw new Error('Failed to update HTML draft')
      }
    })
    await page.getByRole('button', { name: 'Open preview' }).click()
    await expect(page.frameLocator('[data-testid="code-file-html-preview"]').locator('#draft-update')).toHaveText('Unsaved draft')
    await expect.poll(() => deletedPreviewIds.length).toBeGreaterThan(0)

    await openProjectFile(page, 'html-preview-matrix', 'site/fragment.HTML')
    await expect(page.frameLocator('[data-testid="code-file-html-preview"]').locator('#fragment-title')).toHaveText('你好，Farming')
    await expect.poll(() => deletedPreviewIds.length).toBeGreaterThan(1)
  })

  test('cleans a delayed creation and recovers from a visible creation failure', async ({ page, workspaceRoot }) => {
    const workspace = path.join(workspaceRoot, 'html-preview-lifecycle')
    writePreviewWorkspace(workspace)
    await createControlAgent(page, workspace)

    let createdPreviewId = ''
    let releaseResponse = () => {}
    const responseGate = new Promise<void>(resolve => { releaseResponse = resolve })
    const deletedPreviewIds: string[] = []
    let delayNextCreation = true
    let forceNextCreationFailure = false
    await interceptWorkspaceRequests(page, request => {
      if (request.operation === 'delete-preview') {
        deletedPreviewIds.push(request.previewId)
        return
      }
      if (request.operation !== 'create-preview') return
      if (forceNextCreationFailure) {
        forceNextCreationFailure = false
        return {
          response: {
            ok: false,
            error: {
              code: 'FORCED_PREVIEW_CREATION_FAILURE',
              message: 'Forced preview creation failure',
              status: 503,
            },
          },
        }
      }
      if (!delayNextCreation) return
      delayNextCreation = false
      return {
        onResult: async response => {
          const preview = response.result as { id?: string } | undefined
          createdPreviewId = preview?.id ?? ''
          await responseGate
          return response
        },
      }
    })

    await openFarming(page)
    await openProjectFile(page, 'html-preview-lifecycle', 'site/index.html')
    await expect.poll(() => createdPreviewId).not.toBe('')
    await page.getByRole('button', { name: 'Show source' }).click()
    releaseResponse()
    await expect.poll(() => deletedPreviewIds).toContain(createdPreviewId)
    const deletedSessionResponse = await page.request.get(`/farming/api/files/previews/${createdPreviewId}/base/index.html`)
    expect(deletedSessionResponse.status()).toBe(404)

    forceNextCreationFailure = true
    await openProjectFile(page, 'html-preview-lifecycle', 'site/error.html')
    await expect(page.getByTestId('code-file-html-preview-panel')).toContainText('Forced preview creation failure')
    await page.getByRole('button', { name: 'Show source' }).click()
    await page.getByRole('button', { name: 'Open preview' }).click()
    await expect(page.frameLocator('[data-testid="code-file-html-preview"]').locator('h1')).toHaveText('Error retry')
  })

  test('opens an exact external HTML path from a shared URL with only its local assets', async ({ page }) => {
    const externalWorkspace = fs.mkdtempSync('/tmp/farming-external-html-preview-')
    fs.mkdirSync(path.join(externalWorkspace, 'assets'), { recursive: true })
    const externalHtml = path.join(externalWorkspace, 'index.html')
    fs.writeFileSync(
      externalHtml,
      '<link rel="stylesheet" href="assets/site.css"><h1>External HTML</h1><script>document.body.dataset.script = "ran"</script>\n',
    )
    fs.writeFileSync(path.join(externalWorkspace, 'assets', 'site.css'), 'h1 { color: rgb(10, 11, 12); }\n')

    const workspaceRequests: Array<{ operation: string; exactExternal?: boolean; path?: string }> = []
    await interceptWorkspaceRequests(page, request => {
      if (request.operation !== 'read-file' && request.operation !== 'create-preview') return
      workspaceRequests.push({
        operation: request.operation,
        path: request.path,
        ...(request.exactExternal ? { exactExternal: true } : {}),
      })
    })
    const params = new URLSearchParams({
      ftarget: 'file',
      path: externalHtml,
      view: 'editor',
    })
    await page.goto(`/farming/?${params.toString()}`, { waitUntil: 'domcontentloaded' })
    await expect(page.getByTestId('app-shell')).toBeVisible()
    await expect(page.getByTestId('code-file-html-preview')).toBeVisible({ timeout: 30_000 })

    const frame = page.frameLocator('[data-testid="code-file-html-preview"]')
    await expect(frame.locator('h1')).toHaveText('External HTML')
    await expect.poll(() => frame.locator('h1').evaluate(element => getComputedStyle(element).color)).toBe('rgb(10, 11, 12)')
    await expect(frame.locator('body')).not.toHaveAttribute('data-script', 'ran')
    expect(workspaceRequests).toEqual(expect.arrayContaining([
      expect.objectContaining({ operation: 'read-file', exactExternal: true }),
      expect.objectContaining({ operation: 'create-preview', exactExternal: true }),
    ]))
    expect(workspaceRequests.find(request => request.operation === 'create-preview')?.path)
      .toBe(fs.realpathSync(externalHtml).replace(/^\/+/, ''))
  })

  test('renews an expiring session without losing the rendered draft', async ({ page, workspaceRoot }) => {
    const workspace = path.join(workspaceRoot, 'html-preview-renewal')
    writePreviewWorkspace(workspace)
    await createControlAgent(page, workspace)

    const createdPreviewIds: string[] = []
    const deletedPreviewIds: string[] = []
    await interceptWorkspaceRequests(page, request => {
      if (request.operation === 'delete-preview') {
        deletedPreviewIds.push(request.previewId)
        return
      }
      if (request.operation !== 'create-preview') return
      return {
        onResult: response => {
          const preview = response.result as { id: string; expiresAt: number }
          createdPreviewIds.push(preview.id)
          return createdPreviewIds.length === 1
            ? { ...response, result: { ...preview, expiresAt: Date.now() + 1_200 } }
            : response
        },
      }
    })

    await openFarming(page)
    await openProjectFile(page, 'html-preview-renewal', 'site/index.html')
    await expect(page.frameLocator('[data-testid="code-file-html-preview"]').locator('h1')).toHaveText('Relative CSS')
    await expect.poll(() => createdPreviewIds.length).toBeGreaterThan(1)
    await expect.poll(() => deletedPreviewIds).toContain(createdPreviewIds[0])
    await expect(page.frameLocator('[data-testid="code-file-html-preview"]').locator('h1')).toHaveText('Relative CSS')
  })
})
