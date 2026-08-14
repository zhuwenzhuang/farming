import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  expect,
  fileEditorPosition,
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
  await expect(page.getByTestId('code-file-editor-statusbar')).toBeVisible()
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
      languages: [
        { id: 'missing-zeta', language: 'Zeta', server: 'zeta-ls', status: 'missing', projects: [] },
        { id: 'typescript', language: 'TypeScript / JavaScript', server: 'typescript-language-server', status: 'available', projects: [] },
        { id: 'jdtls', language: 'Java', server: 'jdtls', status: 'installable', projects: [] },
        { id: 'missing-alpha', language: 'Alpha', server: 'alpha-ls', status: 'missing', projects: [] },
        { id: 'deno', language: 'Deno', server: 'deno', status: 'available', projects: [] },
        { id: 'clangd', language: 'C / C++', server: 'clangd', status: 'installable', projects: [] },
        { id: 'vue', language: 'Vue', server: 'vue-language-server', status: 'missing', projects: [] },
        { id: 'rust-analyzer', language: 'Rust', server: 'rust-analyzer', status: 'missing', projects: [] },
        { id: 'pyright', language: 'Python', server: 'pyright-langserver', status: 'missing', projects: [] },
      ],
    }),
  }))

  await openFarming(page)
  await page.getByTestId('code-nav-plugins').click()
  const card = page.getByTestId('code-plugin-language-server')
  await expect(card.getByText('0 running · 2 available · 2 auto-installable · 5 not installed', { exact: true })).toBeVisible()
  await expect(card.locator('thead')).toContainText('Language')
  await expect(card.locator('thead')).toContainText('Status')
  await expect(card.locator('tbody tr')).toHaveCount(7)
  await expect.poll(() => card.locator('tbody tr').evaluateAll(rows => rows.map(row => row.getAttribute('data-testid')))).toEqual([
    'code-plugin-language-server-language-deno',
    'code-plugin-language-server-language-typescript',
    'code-plugin-language-server-language-clangd',
    'code-plugin-language-server-language-jdtls',
    'code-plugin-language-server-language-missing-alpha',
    'code-plugin-language-server-language-pyright',
    'code-plugin-language-server-language-rust-analyzer',
  ])
  await expect(card.getByText('2 more languages', { exact: true })).toBeVisible()
  await card.getByRole('button', { name: 'Show all' }).click()
  await expect(card.locator('tbody tr')).toHaveCount(9)
  await expect(card.getByRole('button', { name: 'Collapse' })).toBeVisible()
  await expect(card.getByRole('button', { name: 'Retry' })).toHaveCount(0)
  await expect(card.getByRole('button', { name: 'Disable' })).toHaveAttribute('aria-pressed', 'true')
})

test('defaults Language Server to enabled and persists explicit enable and disable actions', async ({ page }) => {
  let enabled = true
  const persistedValues: boolean[] = []
  await page.route('**/api/language-server/capability**', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      enabled,
      status: 'ready',
      source: 'managed',
      detail: enabled ? '1 built-in language definition' : 'Language Server is disabled',
      features: ['definition', 'diagnostics'],
      workspaces: [],
      connections: [],
      languages: [
        { id: 'typescript', language: 'TypeScript / JavaScript', server: 'typescript-language-server', status: 'available', projects: [] },
      ],
    }),
  }))
  await page.route('**/api/settings', async route => {
    if (route.request().method() !== 'POST') {
      await route.continue()
      return
    }
    const patch = route.request().postDataJSON() as { languageServerEnabled?: boolean }
    enabled = patch.languageServerEnabled !== false
    persistedValues.push(enabled)
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ success: true, settings: { languageServerEnabled: enabled } }),
    })
  })

  await openFarming(page)
  await page.getByTestId('code-nav-plugins').click()
  const card = page.getByTestId('code-plugin-language-server')
  const disable = card.getByRole('button', { name: 'Disable' })
  await expect(disable).toHaveAttribute('aria-pressed', 'true')

  await disable.click()
  await expect(card.getByText('Disabled', { exact: true })).toBeVisible()
  const enable = card.getByRole('button', { name: 'Enable' })
  await expect(enable).toHaveAttribute('aria-pressed', 'false')
  await expect(card.locator('tbody tr')).toHaveCount(1)

  await enable.click()
  await expect(card.getByRole('button', { name: 'Disable' })).toHaveAttribute('aria-pressed', 'true')
  expect(persistedValues).toEqual([false, true])
})

test('asks for a restart when the backend does not provide language inventory', async ({ page }) => {
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
  await expect(card.getByText('Restart Farming to load language status', { exact: true })).toBeVisible()
  await expect(card.getByText('Unavailable', { exact: true })).toHaveCount(0)
  await expect(card.getByRole('button', { name: 'Retry' })).toHaveCount(0)
})

test('keeps plugin scrolling local until the scroll burst settles', async ({ page }) => {
  await page.route('**/api/language-server/capability**', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      status: 'ready',
      source: 'managed',
      detail: '33 built-in language definitions · servers start on demand',
      features: ['definition', 'diagnostics'],
      workspaces: [],
      connections: [],
      languages: Array.from({ length: 33 }, (_, index) => ({
        id: `language-${index}`,
        language: `Language ${String(index).padStart(2, '0')}`,
        server: `language-server-${index}`,
        status: 'missing',
        projects: [],
      })),
    }),
  }))

  await openFarming(page)
  await page.getByTestId('code-nav-plugins').click()
  const panel = page.getByTestId('code-plugins-panel')
  await panel.getByTestId('code-plugin-tab-extensions').click()
  await expect(panel.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled()
  await panel.getByTestId('code-plugin-tab-farming').click()
  const card = page.getByTestId('code-plugin-language-server')
  await card.getByRole('button', { name: 'Show all' }).click()
  const scroller = page.locator('.code-plugins-view')
  await expect.poll(() => scroller.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true)
  await scroller.evaluate(element => {
    element.scrollTop = 0
    element.dispatchEvent(new Event('scroll'))
  })
  const persistedScrollTop = () => page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem('farming.code.workspaceViewState.v1') || '{}') as {
      pluginsNavigationState?: { scrollTop?: number }
    }
    return state.pluginsNavigationState?.scrollTop ?? 0
  })
  await expect.poll(persistedScrollTop).toBe(0)

  const burst = await scroller.evaluate(async element => {
    const maxScrollTop = element.scrollHeight - element.clientHeight
    for (let step = 1; step <= 12; step += 1) {
      element.scrollTop = Math.round((maxScrollTop * step) / 12)
      element.dispatchEvent(new Event('scroll'))
      await new Promise(resolve => window.setTimeout(resolve, 16))
    }
    const state = JSON.parse(localStorage.getItem('farming.code.workspaceViewState.v1') || '{}') as {
      pluginsNavigationState?: { scrollTop?: number }
    }
    return {
      finalScrollTop: element.scrollTop,
      persistedDuringBurst: state.pluginsNavigationState?.scrollTop ?? 0,
    }
  })
  expect(burst.persistedDuringBurst).not.toBe(burst.finalScrollTop)
  await expect.poll(persistedScrollTop).toBe(burst.finalScrollTop)
})

test('lists live Language Servers by language and Project', async ({ page }) => {
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
      languages: [
        { id: 'gopls', language: 'Go', server: 'gopls', status: 'missing', projects: [] },
        { id: 'clangd', language: 'C / C++', server: 'clangd', status: 'installable', projects: [] },
        { id: 'pyright', language: 'Python', server: 'pyright-langserver', status: 'available', projects: [] },
        { id: 'typescript', language: 'TypeScript / JavaScript', server: 'typescript-language-server', status: 'running', projects: [workspaceUri] },
      ],
    }),
  }))

  await openFarming(page)
  await page.getByTestId('code-nav-plugins').click()
  const card = page.getByTestId('code-plugin-language-server')
  await expect(card.getByText('1 running · 1 available · 1 auto-installable · 1 not installed', { exact: true })).toBeVisible()
  const typescript = card.getByTestId('code-plugin-language-server-language-typescript')
  await expect(typescript).toContainText('TypeScript / JavaScript')
  await expect(typescript).toContainText('typescript-language-server')
  await expect(typescript).toContainText('Running')
  await expect(typescript).toContainText('managed-project')
})

test('renders document highlights, semantic tokens, and inlay hints only for the current saved model', async ({ page }) => {
  const workspaceRoot = path.join(PLAYWRIGHT_WORKSPACE_ROOT, 'managed-language-server-reading')
  fs.rmSync(workspaceRoot, { recursive: true, force: true })
  fs.mkdirSync(workspaceRoot, { recursive: true })
  fs.writeFileSync(path.join(workspaceRoot, 'Demo.java'), [
    'class Demo {',
    '  void run(String value) {',
    '    consume(value);',
    '  }',
    '  void consume(String value) {}',
    '}',
    '',
  ].join('\n'))
  const workspaceUri = pathToFileURL(fs.realpathSync(workspaceRoot)).toString()
  const requestCounts = new Map<string, number>()
  let lastInlayRange: unknown = null

  await page.route('**/api/language-server/capability**', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      status: 'connected',
      source: 'managed',
      detail: 'Managed Language Server',
      features: ['documentHighlights', 'semanticTokens', 'inlayHints', 'diagnostics'],
      workspaces: [workspaceUri],
      connections: [{ id: 'jdtls', root: workspaceUri, workspace: workspaceUri }],
    }),
  }))
  await page.route('**/api/language-server/request', async route => {
    const body = route.request().postDataJSON() as { method: string; range?: unknown }
    requestCounts.set(body.method, (requestCounts.get(body.method) || 0) + 1)
    if (body.method === 'documentHighlights') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          result: [{
            range: { start: { line: 1, character: 18 }, end: { line: 1, character: 23 } },
            kind: 2,
          }, {
            range: { start: { line: 2, character: 12 }, end: { line: 2, character: 17 } },
            kind: 3,
          }],
        }),
      })
      return
    }
    if (body.method === 'semanticTokens') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          result: {
            resultId: 'java-semantic-1',
            data: [0, 6, 4, 1, 2],
            legend: {
              tokenTypes: ['variable', 'class'],
              tokenModifiers: ['readonly', 'declaration'],
            },
          },
        }),
      })
      return
    }
    if (body.method === 'inlayHints') {
      lastInlayRange = body.range
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          result: [{
            position: { line: 2, character: 12 },
            label: [{ value: 'value:', tooltip: { kind: 'markdown', value: '**parameter name**' } }],
            kind: 2,
            paddingRight: true,
          }],
        }),
      })
      return
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ result: [] }) })
  })

  await openFarming(page)
  await openNewAgentDialog(page)
  await startAgentFromOpenDialog(page, 'bash', workspaceRoot)
  const project = page.getByTestId('code-project-group').filter({ hasText: path.basename(workspaceRoot) })
  const files = project.getByTestId('code-files-section')
  await files.locator('.code-files-title').first().click()
  await files.locator('[data-testid="code-file-row"][data-file-path="Demo.java"]').click()
  await expect(page.getByTestId('code-file-monaco')).toBeVisible()
  await expect.poll(async () => page.evaluate(() => (
    window.__farmingFileEditorTest?.getLanguageId() ?? null
  ))).toBe('java')
  await expect(page.getByTestId('code-file-editor-diagnostics')).toHaveCount(0)
  await expect(page.getByTestId('code-file-editor-statusbar')).toHaveCount(0)

  await expect.poll(() => requestCounts.get('semanticTokens') || 0).toBeGreaterThan(0)
  await expect.poll(() => requestCounts.get('inlayHints') || 0).toBeGreaterThan(0)
  expect(lastInlayRange).toMatchObject({
    start: { line: expect.any(Number), character: expect.any(Number) },
    end: { line: expect.any(Number), character: expect.any(Number) },
  })
  await expect(page.locator('.monaco-editor .view-lines')).toContainText('value:')
  await expect.poll(async () => page.evaluate(() => {
    const token = [...document.querySelectorAll<HTMLElement>('.monaco-editor .view-line span')]
      .find(element => element.textContent === 'Demo')
    return token ? getComputedStyle(token).color : ''
  })).toBe('rgb(38, 127, 153)')

  const highlightRequestsBeforeReset = requestCounts.get('documentHighlights') || 0
  await page.locator('.monaco-editor .view-line').first().click({ position: { x: 55, y: 8 } })
  await page.keyboard.press('ArrowLeft')
  await expect.poll(() => requestCounts.get('documentHighlights') || 0).toBeGreaterThan(highlightRequestsBeforeReset)
  const highlightRequestsBeforeCursorMove = requestCounts.get('documentHighlights') || 0
  await page.locator('.monaco-editor .view-line').nth(1).click({ position: { x: 150, y: 8 } })
  await page.keyboard.press('ArrowLeft')
  await expect.poll(() => requestCounts.get('documentHighlights') || 0).toBeGreaterThan(highlightRequestsBeforeCursorMove)
  await expect(page.locator('.monaco-editor .wordHighlight')).toHaveCount(1)
  await expect(page.locator('.monaco-editor .wordHighlightStrong')).toHaveCount(1)

  expect(await page.evaluate(() => window.__farmingFileEditorTest?.insertText(' ') === true)).toBe(true)
  await expect(page.locator('.monaco-editor .view-lines')).not.toContainText('value:')
  await page.getByRole('button', { name: 'Save file' }).click()
  await expect(page.locator('.monaco-editor .view-lines')).toContainText('value:')
})

test('shows nested, cached, and retryable call/type hierarchy trees for a saved file', async ({ page }) => {
  const workspaceRoot = path.join(PLAYWRIGHT_WORKSPACE_ROOT, 'managed-language-server-editor')
  fs.rmSync(workspaceRoot, { recursive: true, force: true })
  fs.mkdirSync(workspaceRoot, { recursive: true })
  fs.writeFileSync(path.join(workspaceRoot, 'App.ts'), [
    'export function root() { callerA() }',
    'function callerA() { callerB() }',
    'function callerB() { callerC() }',
    'function callerC() {}',
    'class Base {}',
    'class Child extends Base {}',
    'class GrandChild extends Child {}',
    '',
  ].join('\n'))
  fs.writeFileSync(path.join(workspaceRoot, 'Other.ts'), [
    'export class Planner {}',
    'export function usePlanner() { return new Planner() }',
    '',
  ].join('\n'))
  const workspaceUri = pathToFileURL(fs.realpathSync(workspaceRoot)).toString()
  const hierarchyRequestCounts = new Map<string, number>()
  let firstDiagnosticsStartedResolve: (() => void) | null = null
  let releaseFirstDiagnosticsResolve: (() => void) | null = null
  let firstDiagnosticsReturnedResolve: (() => void) | null = null
  const firstDiagnosticsStarted = new Promise<void>(resolve => { firstDiagnosticsStartedResolve = resolve })
  const releaseFirstDiagnostics = new Promise<void>(resolve => { releaseFirstDiagnosticsResolve = resolve })
  const firstDiagnosticsReturned = new Promise<void>(resolve => { firstDiagnosticsReturnedResolve = resolve })
  let diagnosticsRequestCount = 0
  let workspaceSymbolRequest: { filePath?: string; query?: string } | null = null

  await page.route('**/api/language-server/capability**', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      status: 'connected',
      source: 'managed',
      detail: 'Managed Language Server',
      features: ['hover', 'definition', 'references', 'implementation', 'documentSymbols', 'workspaceSymbols', 'callHierarchy', 'typeHierarchy', 'diagnostics'],
      workspaces: [workspaceUri],
      connections: [{ id: 'typescript', root: workspaceUri, workspace: workspaceUri }],
    }),
  }))
  await page.route('**/api/language-server/request', async route => {
    const body = route.request().postDataJSON() as { method: string; itemId?: string; filePath?: string; query?: string }
    const requestKey = `${body.method}:${body.itemId || ''}`
    hierarchyRequestCounts.set(requestKey, (hierarchyRequestCounts.get(requestKey) || 0) + 1)
    if (body.method === 'diagnostics') {
      diagnosticsRequestCount += 1
      if (body.filePath === 'Other.ts') {
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ result: [] }) })
        return
      }
      if (diagnosticsRequestCount === 1) {
        firstDiagnosticsStartedResolve?.()
        await releaseFirstDiagnostics
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            result: [{
              message: 'stale diagnostic must stay cleared',
              severity: 0,
              source: 'test-lsp',
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } },
            }],
          }),
        })
        firstDiagnosticsReturnedResolve?.()
        return
      }
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          result: [{
            message: 'saved diagnostic is current',
            severity: 1,
            source: 'test-lsp',
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } },
          }],
        }),
      })
      return
    }
    if (body.method === 'hover') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          result: [{
            contents: ['**Farming hover**', '`root(): void`'],
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } },
          }],
        }),
      })
      return
    }
    if (body.method === 'outgoingCalls' && body.itemId === 'call-root' && hierarchyRequestCounts.get(requestKey) === 1) {
      await route.fulfill({
        status: 502,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Temporary hierarchy failure', code: 'TEST_HIERARCHY_FAILURE' }),
      })
      return
    }
    const hierarchyItem = (id: string, name: string, detail: string, kind: number, line: number, filePath = 'App.ts') => ({
      id,
      name,
      detail,
      kind,
      path: filePath,
      range: { start: { line, character: 0 }, end: { line, character: name.length } },
      selectionRange: { start: { line, character: 0 }, end: { line, character: name.length } },
    })
    const codeLocation = (filePath: string, line: number, character: number) => ({
      path: filePath,
      range: {
        start: { line, character },
        end: { line, character: character + 7 },
      },
    })
    if (body.method === 'definition') {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ result: [codeLocation('Other.ts', 0, 13)] }) })
      return
    }
    if (body.method === 'references') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ result: [codeLocation('App.ts', 0, 16), codeLocation('Other.ts', 1, 37)] }),
      })
      return
    }
    if (body.method === 'implementation') {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ result: [codeLocation('Other.ts', 1, 16)] }) })
      return
    }
    if (body.method === 'workspaceSymbols') {
      workspaceSymbolRequest = { filePath: body.filePath, query: body.query }
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          result: [{
            name: 'Planner',
            detail: 'Other',
            kind: 5,
            path: 'Other.ts',
            range: { start: { line: 1, character: 16 }, end: { line: 1, character: 26 } },
            selectionRange: { start: { line: 1, character: 16 }, end: { line: 1, character: 26 } },
          }],
        }),
      })
      return
    }
    const result = body.method === 'prepareCallHierarchy' ? [{
          ...hierarchyItem('call-root', 'root', 'function', 12, 0),
        }]
        : body.method === 'incomingCalls' && body.itemId === 'call-root'
          ? [{ item: hierarchyItem('caller-a', 'callerA', 'incoming', 12, 1, 'Other.ts'), ranges: [] }]
        : body.method === 'incomingCalls' && body.itemId === 'caller-a'
          ? [{ item: hierarchyItem('caller-b', 'callerB', 'incoming', 12, 2), ranges: [] }]
        : body.method === 'incomingCalls' && body.itemId === 'caller-b'
          ? [{ item: hierarchyItem('caller-c', 'callerC', 'incoming', 12, 3), ranges: [] }]
        : body.method === 'outgoingCalls' && body.itemId === 'call-root'
          ? [{ item: hierarchyItem('callee-a', 'calleeA', 'outgoing', 12, 1), ranges: [] }]
        : body.method === 'prepareTypeHierarchy'
          ? [hierarchyItem('type-root', 'Base', 'class', 5, 4)]
        : body.method === 'subtypes' && body.itemId === 'type-root'
          ? [hierarchyItem('type-child', 'Child', 'class', 5, 0, 'Other.ts')]
        : body.method === 'subtypes' && body.itemId === 'type-child'
          ? [hierarchyItem('type-grandchild', 'GrandChild', 'class', 5, 6)]
        : body.method === 'supertypes' && body.itemId === 'type-root'
          ? [hierarchyItem('type-object', 'Object', 'class', 5, 4)]
        : body.method === 'documentSymbols'
          ? [{
              ...hierarchyItem('symbol-project', 'Project', 'namespace', 3, 0),
              children: [{
                ...hierarchyItem('symbol-class', 'OptimizerConfig', 'class', 5, 4),
                children: [{
                  ...hierarchyItem('symbol-method', 'optimize', 'method', 6, 0),
                  children: [],
                }],
              }],
            }]
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

  await firstDiagnosticsStarted
  expect(await page.evaluate(() => window.__farmingFileEditorTest?.insertText(' ') === true)).toBe(true)
  releaseFirstDiagnosticsResolve?.()
  await firstDiagnosticsReturned
  await expect.poll(async () => page.evaluate(() => (
    window.__farmingFileEditorTest?.getMarkers().some(marker => marker.message === 'stale diagnostic must stay cleared') ?? false
  ))).toBe(false)
  await expect(page.getByTestId('code-file-editor-diagnostics')).toHaveCount(0)
  await expect(page.getByTestId('code-file-editor-statusbar')).toHaveCount(0)
  await page.getByRole('button', { name: 'Save file' }).click()
  await expect(page.getByRole('button', { name: 'Save file' })).toHaveCount(0)
  await expect.poll(async () => page.evaluate(() => (
    window.__farmingFileEditorTest?.getMarkers().some(marker => marker.message === 'saved diagnostic is current') ?? false
  ))).toBe(true)
  await expect(page.getByTestId('code-file-editor-language')).toHaveText('TypeScript')
  await expect(page.getByTestId('code-file-editor-diagnostics')).toHaveText('1 warning')
  await expect(page.getByTestId('code-file-editor-statusbar')).toBeVisible()

  await page.locator('.monaco-editor .view-line').first().hover({ position: { x: 100, y: 8 } })
  await expect(page.locator('.monaco-hover').filter({ hasText: 'Farming hover' })).toBeVisible()

  const menu = page.getByTestId('code-editor-context-menu')
  const runEditorAction = async (name: string) => {
    expect(await page.evaluate(() => window.__farmingFileEditorTest?.revealLine(1, 18) === true)).toBe(true)
    await page.getByTestId('code-file-monaco').click({ button: 'right', position: { x: 220, y: 38 } })
    await menu.getByRole('menuitem', { name, exact: true }).click()
  }
  await runEditorAction('Go to Definition')
  await expect.poll(() => hierarchyRequestCounts.get('definition:') || 0).toBe(1)
  await expect(page.getByRole('tab', { name: /Other\.ts/ })).toHaveAttribute('aria-selected', 'true')
  await expect.poll(() => fileEditorPosition(page)).toEqual({ lineNumber: 1, column: 14 })
  await expect(page.getByTestId('code-file-editor-statusbar')).toHaveCount(0)
  await expect(page.getByTestId('code-file-editor-diagnostics')).toHaveCount(0)
  await page.getByRole('tab', { name: /App\.ts/ }).click()
  await expect(page.getByTestId('code-file-editor-diagnostics')).toHaveText('1 warning')

  await runEditorAction('Find References')
  const referencesPanel = page.getByTestId('code-language-server-panel')
  await expect(referencesPanel).toHaveAccessibleName('Find References')
  await expect(referencesPanel).toContainText('Other.ts:2')
  await referencesPanel.getByRole('button', { name: 'Close' }).click()

  await runEditorAction('Go to Implementation')
  await expect(page.getByRole('tab', { name: /Other\.ts/ })).toHaveAttribute('aria-selected', 'true')
  await expect.poll(() => fileEditorPosition(page)).toEqual({ lineNumber: 2, column: 17 })
  await expect(page.getByTestId('code-file-editor-statusbar')).toHaveCount(0)
  await page.getByRole('tab', { name: /App\.ts/ }).click()

  await page.getByTestId('code-file-monaco').click({ button: 'right', position: { x: 220, y: 38 } })
  await expect(menu.getByRole('menuitem', { name: 'Go to Definition' })).toBeVisible()
  const editorWidthBeforeHierarchy = (await page.getByTestId('code-file-monaco').boundingBox())?.width || 0
  await menu.getByRole('menuitem', { name: 'Call Hierarchy' }).click()
  const panel = page.getByTestId('code-language-server-panel')
  await expect(panel).toContainText('root')
  await expect(panel.getByText('Root', { exact: true })).toBeVisible()
  await expect.poll(async () => page.evaluate(() => {
    const host = document.querySelector<HTMLElement>('[data-testid="code-file-monaco"]')?.getBoundingClientRect()
    const inner = document.querySelector<HTMLElement>('[data-testid="code-file-monaco"] > .monaco-editor')?.getBoundingClientRect()
    const statusbar = document.querySelector<HTMLElement>('[data-testid="code-file-editor-statusbar"]')?.getBoundingClientRect()
    const dock = document.querySelector<HTMLElement>('[data-testid="code-language-server-panel"]')?.getBoundingClientRect()
    if (!host || !inner || !statusbar || !dock) return null
    return {
      separateEditor: host.right <= dock.left + 1,
      separateStatusbar: statusbar.right <= dock.left + 1,
      monacoLaidOut: Math.abs(inner.width - host.width) <= 2,
    }
  })).toEqual({
    separateEditor: true,
    separateStatusbar: true,
    monacoLaidOut: true,
  })
  await expect.poll(async () => (await page.getByTestId('code-file-monaco').boundingBox())?.width || 0)
    .toBeLessThan(editorWidthBeforeHierarchy - 200)

  await page.setViewportSize({ width: 680, height: 800 })
  await expect.poll(async () => page.evaluate(() => {
    const workbench = document.querySelector<HTMLElement>('[data-testid="code-file-editor-workbench"]')?.getBoundingClientRect()
    const main = document.querySelector<HTMLElement>('[data-testid="code-file-editor-main"]')?.getBoundingClientRect()
    const dock = document.querySelector<HTMLElement>('[data-testid="code-language-server-panel"]')?.getBoundingClientRect()
    if (!workbench || !main || !dock) return null
    return {
      stacked: main.bottom <= dock.top + 1,
      aligned: Math.abs(workbench.left - dock.left) <= 1 && Math.abs(workbench.width - dock.width) <= 2,
      editorUsable: main.height > 120,
      dockUsable: dock.height >= 150,
    }
  })).toEqual({ stacked: true, aligned: true, editorUsable: true, dockUsable: true })
  await page.setViewportSize({ width: 1024, height: 800 })
  await expect.poll(async () => page.evaluate(() => {
    const main = document.querySelector<HTMLElement>('[data-testid="code-file-editor-main"]')?.getBoundingClientRect()
    const dock = document.querySelector<HTMLElement>('[data-testid="code-language-server-panel"]')?.getBoundingClientRect()
    return Boolean(main && dock && main.bottom <= dock.top + 1)
  })).toBe(true)
  await page.setViewportSize({ width: 1440, height: 900 })
  await expect.poll(async () => page.evaluate(() => {
    const main = document.querySelector<HTMLElement>('[data-testid="code-file-editor-main"]')?.getBoundingClientRect()
    const dock = document.querySelector<HTMLElement>('[data-testid="code-language-server-panel"]')?.getBoundingClientRect()
    return Boolean(main && dock && main.right <= dock.left + 1)
  })).toBe(true)
  const rootTreeItem = panel.locator('[role="treeitem"][data-node-key="call-root"]')
  await rootTreeItem.focus()
  await rootTreeItem.press('ArrowRight')
  await expect(panel).toContainText('callerA')
  const callerATreeItem = panel.locator('[role="treeitem"][data-node-key="call-root/caller-a"]')
  await rootTreeItem.focus()
  await rootTreeItem.press('ArrowRight')
  await expect(callerATreeItem).toBeFocused()
  await callerATreeItem.press('Enter')
  await expect(page.getByRole('tab', { name: /Other\.ts/ })).toHaveAttribute('aria-selected', 'true')
  await expect(panel).toBeVisible()
  await expect(callerATreeItem).toContainText('Other.ts:2')
  await callerATreeItem.focus()
  await callerATreeItem.press('ArrowRight')
  await expect(panel).toContainText('callerB')
  await panel.getByRole('button', { name: 'Expand callerB' }).click()
  await expect(panel).toContainText('callerC')
  await panel.getByRole('button', { name: 'Expand callerC' }).click()
  await expect(panel.getByText('No related items.', { exact: true })).toBeVisible()

  await panel.getByRole('button', { name: 'Collapse callerA' }).click()
  await expect(panel.getByText('callerB', { exact: true })).not.toBeVisible()
  await panel.getByRole('button', { name: 'Expand callerA' }).click()
  await expect(panel.getByText('callerB', { exact: true })).toBeVisible()
  expect(hierarchyRequestCounts.get('incomingCalls:caller-a')).toBe(1)

  await panel.getByRole('button', { name: 'Incoming Calls' }).click()
  await expect(panel.getByText('callerB', { exact: true })).toBeVisible()
  expect(hierarchyRequestCounts.get('incomingCalls:caller-a')).toBe(1)

  await panel.getByRole('button', { name: 'Outgoing Calls' }).click()
  await panel.getByRole('button', { name: 'Expand root' }).click()
  await expect(panel.getByText('Temporary hierarchy failure', { exact: true })).toBeVisible()
  await panel.getByRole('button', { name: 'Retry' }).click()
  await expect(panel.getByText('calleeA', { exact: true })).toBeVisible()
  expect(hierarchyRequestCounts.get('outgoingCalls:call-root')).toBe(2)

  await panel.getByRole('button', { name: 'Close' }).click()
  await expect.poll(async () => (await page.getByTestId('code-file-monaco').boundingBox())?.width || 0)
    .toBeGreaterThanOrEqual(editorWidthBeforeHierarchy - 2)
  await page.getByRole('tab', { name: /App\.ts/ }).click()
  await page.getByTestId('code-file-monaco').click({ button: 'right', position: { x: 220, y: 38 } })
  await page.getByTestId('code-editor-context-menu').getByRole('menuitem', { name: 'Type Hierarchy' }).click()
  await expect(panel).toContainText('Base')
  await panel.getByRole('button', { name: 'Expand Base' }).click()
  await expect(panel.getByText('Child', { exact: true })).toBeVisible()
  await expect(panel).toContainText('Other.ts:1')
  await panel.getByText('Child', { exact: true }).click()
  await expect(page.getByRole('tab', { name: /Other\.ts/ })).toHaveAttribute('aria-selected', 'true')
  await expect(panel).toBeVisible()
  await panel.getByRole('button', { name: 'Expand Child' }).click()
  await expect(panel.getByText('GrandChild', { exact: true })).toBeVisible()
  await panel.getByText('GrandChild', { exact: true }).click()
  await expect(page.getByRole('tab', { name: /App\.ts/ })).toHaveAttribute('aria-selected', 'true')
  await expect(panel).toBeVisible()
  await panel.getByRole('button', { name: 'Expand GrandChild' }).click()
  await expect(panel.getByText('No related items.', { exact: true })).toBeVisible()

  await panel.getByRole('button', { name: 'Supertypes' }).click()
  await panel.getByRole('button', { name: 'Expand Base' }).click()
  await expect(panel.getByText('Object', { exact: true })).toBeVisible()
  await panel.getByText('Object', { exact: true }).click()
  await expect.poll(() => fileEditorPosition(page)).toEqual({ lineNumber: 5, column: 1 })

  await files.locator('[data-testid="code-file-row"][data-file-path="Other.ts"]').click()
  await expect(panel).toHaveCount(0)
  await files.locator('[data-testid="code-file-row"][data-file-path="App.ts"]').click()
  await expect(page.getByRole('tab', { name: /App\.ts/ })).toHaveAttribute('aria-selected', 'true')
  await page.getByTestId('code-file-monaco').click({ button: 'right', position: { x: 220, y: 38 } })
  await page.getByTestId('code-editor-context-menu').getByRole('menuitem', { name: 'Document Symbols' }).click()
  await expect(panel.getByText('Project', { exact: true })).toBeVisible()
  await expect(panel.getByText('OptimizerConfig', { exact: true })).toBeVisible()
  await expect(panel.getByText('optimize', { exact: true })).not.toBeVisible()
  await panel.getByRole('button', { name: 'Expand OptimizerConfig' }).click()
  await expect(panel.getByText('optimize', { exact: true })).toBeVisible()
  await panel.getByRole('button', { name: 'Collapse Project' }).click()
  await expect(panel.getByText('OptimizerConfig', { exact: true })).not.toBeVisible()

  await panel.getByRole('button', { name: 'Close' }).click()
  expect(await page.evaluate(() => window.__farmingFileEditorTest?.revealLine(8) === true)).toBe(true)
  await page.getByTestId('code-file-monaco').click({ button: 'right', position: { x: 220, y: 38 } })
  await page.getByTestId('code-editor-context-menu').getByRole('menuitem', { name: 'Workspace Symbols' }).click()
  await expect(panel.getByText('Enter a symbol name to search this project.', { exact: true })).toBeVisible()
  const symbolSearch = panel.getByRole('searchbox', { name: 'Search workspace symbols' })
  await expect(panel.getByRole('button', { name: 'Search' })).toBeDisabled()
  await symbolSearch.fill('Plan')
  await symbolSearch.press('Enter')
  await expect(panel.getByText('Planner', { exact: true })).toBeVisible()
  await expect(panel).toContainText('Other.ts:2')
  expect(workspaceSymbolRequest).toEqual({ filePath: 'App.ts', query: 'Plan' })
  await panel.getByText('Planner', { exact: true }).click()
  await expect.poll(() => fileEditorPosition(page)).toEqual({ lineNumber: 2, column: 17 })
  await expect(page.locator('.monaco-editor textarea.inputarea')).toHaveAttribute('aria-label', 'Editor for Other.ts')
})
