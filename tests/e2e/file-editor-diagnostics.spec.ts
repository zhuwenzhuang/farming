import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  expect,
  openFarming,
  openNewAgentDialog,
  PLAYWRIGHT_WORKSPACE_ROOT,
  startAgentFromOpenDialog,
  test,
} from './fixtures'

test('keeps TypeScript diagnostics syntax-only without project language service context', async ({ page }) => {
  const workspaceRoot = path.join(PLAYWRIGHT_WORKSPACE_ROOT, 'typescript-syntax-only')
  fs.rmSync(workspaceRoot, { recursive: true, force: true })
  fs.mkdirSync(workspaceRoot, { recursive: true })
  fs.writeFileSync(path.join(workspaceRoot, 'App.tsx'), [
    "import React from 'react'",
    "import { missing } from '@/missing'",
    'export const broken = (',
    '',
  ].join('\n'))

  await openFarming(page)
  await openNewAgentDialog(page)
  await startAgentFromOpenDialog(page, 'bash', workspaceRoot)

  const project = page.getByTestId('code-project-group').filter({ hasText: path.basename(workspaceRoot) })
  await expect(project).toHaveCount(1, { timeout: 30_000 })
  const files = project.getByTestId('code-files-section')
  const filesTitle = files.locator('.code-files-title').first()
  await filesTitle.click()
  await expect(filesTitle).toHaveAttribute('aria-expanded', 'true')
  await files.locator('[data-testid="code-file-row"][data-file-path="App.tsx"]').click()
  await expect(page.getByTestId('code-file-monaco')).toBeVisible()

  await expect.poll(async () => page.evaluate(() => (
    window.__farmingFileEditorTest?.getTypeScriptDiagnosticsOptions() ?? null
  ))).toMatchObject({
    noSemanticValidation: true,
    noSyntaxValidation: false,
    noSuggestionDiagnostics: true,
  })
  await expect.poll(async () => page.evaluate(() => (
    window.__farmingFileEditorTest?.getMarkers() ?? []
  ))).toEqual(expect.arrayContaining([
    expect.objectContaining({ severity: 8 }),
  ]))

  const markers = await page.evaluate(() => window.__farmingFileEditorTest?.getMarkers() ?? [])
  expect(markers.some(marker => marker.message.includes('Cannot find module'))).toBe(false)
})

test('shows Language Server readiness without inventing a connected project', async ({ page }) => {
  await page.route('**/api/language-server/capability**', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      status: 'ready',
      source: 'managed',
      detail: '33 built-in language definitions · servers start on demand',
      features: ['definition', 'diagnostics'],
      workspaces: [],
      connections: [],
    }),
  }))

  await openFarming(page)
  await page.getByTestId('code-nav-plugins').click()
  const card = page.getByTestId('code-plugin-language-server')
  await expect(card.getByText('Ready on demand', { exact: true })).toBeVisible()
  await expect(card.getByText('Connected', { exact: true })).toHaveCount(0)
  await expect(card).toContainText('No project language server is running')
})

test('lists live Language Server projects and roots', async ({ page }) => {
  const workspaceUri = pathToFileURL('/workspaces/managed-project').toString()
  const rootUri = pathToFileURL('/workspaces/managed-project/module').toString()
  await page.route('**/api/language-server/capability**', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      status: 'connected',
      source: 'managed',
      detail: '33 built-in language definitions · 1 active server · 1 project',
      features: ['definition', 'diagnostics'],
      workspaces: [workspaceUri],
      connections: [{ id: 'typescript', root: rootUri, workspace: workspaceUri }],
    }),
  }))

  await openFarming(page)
  await page.getByTestId('code-nav-plugins').click()
  const card = page.getByTestId('code-plugin-language-server')
  await expect(card.getByText('Connected', { exact: true })).toBeVisible()
  await expect(card).toContainText('typescript')
  await expect(card).toContainText('/workspaces/managed-project')
  await expect(card).toContainText('/workspaces/managed-project/module')
})

test('shows managed Language Server navigation and lazy call hierarchy for a saved file', async ({ page }) => {
  const workspaceRoot = path.join(PLAYWRIGHT_WORKSPACE_ROOT, 'managed-language-server-editor')
  fs.rmSync(workspaceRoot, { recursive: true, force: true })
  fs.mkdirSync(workspaceRoot, { recursive: true })
  fs.writeFileSync(path.join(workspaceRoot, 'App.ts'), 'export function root() { child() }\nfunction child() {}\n')
  const workspaceUri = pathToFileURL(fs.realpathSync(workspaceRoot)).toString()

  await page.route('**/api/language-server/capability**', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      status: 'connected',
      source: 'managed',
      detail: 'Managed Language Server',
      features: ['definition', 'callHierarchy', 'diagnostics'],
      workspaces: [workspaceUri],
      connections: [{ id: 'typescript', root: workspaceUri, workspace: workspaceUri }],
    }),
  }))
  await page.route('**/api/language-server/request', async route => {
    const body = route.request().postDataJSON() as { method: string; itemId?: string }
    const result = body.method === 'diagnostics' ? []
      : body.method === 'prepareCallHierarchy' ? [{
          id: 'root',
          name: 'root',
          detail: 'function',
          kind: 11,
          path: 'App.ts',
          range: { start: { line: 0, character: 16 }, end: { line: 0, character: 20 } },
          selectionRange: { start: { line: 0, character: 16 }, end: { line: 0, character: 20 } },
        }]
        : body.method === 'incomingCalls' && body.itemId === 'root' ? [{ item: {
            id: 'caller',
            name: 'caller',
            detail: 'incoming',
            kind: 11,
            path: 'App.ts',
            range: { start: { line: 1, character: 0 }, end: { line: 1, character: 8 } },
            selectionRange: { start: { line: 1, character: 0 }, end: { line: 1, character: 8 } },
          }, ranges: [] }]
          : []
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ result }) })
  })

  await openFarming(page)
  await openNewAgentDialog(page)
  await startAgentFromOpenDialog(page, 'bash', workspaceRoot)
  const project = page.getByTestId('code-project-group').filter({ hasText: path.basename(workspaceRoot) })
  const files = project.getByTestId('code-files-section')
  await files.locator('.code-files-title').first().click()
  await files.locator('[data-testid="code-file-row"][data-file-path="App.ts"]').click()
  await expect(page.getByTestId('code-file-monaco')).toBeVisible()

  await page.getByTestId('code-file-monaco').click({ button: 'right', position: { x: 220, y: 38 } })
  const menu = page.getByTestId('code-editor-context-menu')
  await expect(menu.getByRole('menuitem', { name: 'Go to Definition' })).toBeVisible()
  await menu.getByRole('menuitem', { name: 'Call Hierarchy' }).click()
  const panel = page.getByTestId('code-language-server-panel')
  await expect(panel).toContainText('root')
  await panel.getByRole('button', { name: 'Expand' }).click()
  await expect(panel).toContainText('caller')
  await panel.getByText('caller', { exact: true }).click()
  await expect(page.getByTestId('code-file-editor-statusbar')).toContainText('Ln 2, Col 1')
})
