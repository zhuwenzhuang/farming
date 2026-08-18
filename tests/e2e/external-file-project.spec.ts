import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import {
  expect,
  openFarming,
  openNewAgentDialog,
  startAgentFromOpenDialog,
  terminalRows,
  test,
  writeTerminalFixture,
} from './fixtures'
import type { Page, Response } from '@playwright/test'

function git(cwd: string, args: string[]) {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

function createRepositoryFile(workspaceRoot: string, name: string) {
  const repository = path.join(workspaceRoot, name)
  const filePath = path.join(repository, 'compiler', 'src', 'SmartOpen.java')
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, 'class SmartOpen {\n  int value = 1;\n}\n')
  git(repository, ['init'])
  git(repository, ['config', 'user.email', 'farming-e2e@example.test'])
  git(repository, ['config', 'user.name', 'Farming E2E'])
  git(repository, ['add', '.'])
  git(repository, ['commit', '-m', 'Seed smart external file'])
  return { filePath, repository }
}

async function expectBlameAvailable(page: Parameters<typeof openFarming>[0]) {
  const monaco = page.getByTestId('code-file-monaco')
  await monaco.click({ button: 'right', position: { x: 42, y: 38 } })
  const menu = page.getByTestId('code-editor-context-menu')
  await expect(menu.getByRole('menuitem', { name: 'Annotate with Blame' })).toBeVisible()
  await menu.getByRole('menuitem', { name: 'Annotate with Blame' }).click()
  await expect(page.locator('.code-file-inline-blame')).toHaveCount(3)
  await expect(page.locator('.code-file-inline-blame').first()).toContainText('Farming E2E')
}

async function createChatAgent(page: Page, workspace: string) {
  const response = await page.request.post('/farming/api/control/agents', {
    data: { command: 'codex', workspace, agentRuntimeMode: 'chat' },
  })
  expect(response.ok()).toBeTruthy()
  const payload = await response.json() as { agentId?: string }
  expect(payload.agentId).toBeTruthy()
  return payload.agentId as string
}

test('opens an external repository file from its nearest Git Project with blame', async ({ page, workspaceRoot }) => {
  const { filePath, repository } = createRepositoryFile(workspaceRoot, 'nearest-git-project')

  const mounted = page.waitForResponse(response => (
    response.request().method() === 'POST'
    && new URL(response.url()).pathname.endsWith('/api/projects/mount-file')
  ))
  const params = new URLSearchParams({
    ftarget: 'file',
    path: filePath,
    line: '2',
  })
  await page.goto(`/farming/?${params.toString()}`, { waitUntil: 'domcontentloaded' })
  await expect(page.getByTestId('app-shell')).toBeVisible()
  const mountResponse = await mounted
  expect(mountResponse.status()).toBe(200)
  expect((await mountResponse.json()).workspace).toBe(fs.realpathSync(repository))

  const project = page.getByTestId('code-project-group').filter({ hasText: path.basename(repository) })
  await expect(project).toBeVisible()
  await expect(page.getByTestId('code-file-editor')).toBeVisible()
  await expect(page.getByRole('tab', { name: 'SmartOpen.java' })).toBeVisible()

  await expectBlameAvailable(page)
})

test('promotes an external terminal file link to its nearest Git Project', async ({ page, workspaceRoot }) => {
  const launcherWorkspace = path.join(workspaceRoot, 'terminal-link-launcher')
  fs.mkdirSync(launcherWorkspace, { recursive: true })
  const { filePath, repository } = createRepositoryFile(workspaceRoot, 'terminal-link-git-project')
  for (let index = 0; index < 24; index += 1) {
    const beforeDirectory = path.join(repository, `a-before-${String(index).padStart(2, '0')}`)
    const afterDirectory = path.join(repository, `z-after-${String(index).padStart(2, '0')}`)
    fs.mkdirSync(beforeDirectory)
    fs.mkdirSync(afterDirectory)
    fs.writeFileSync(path.join(beforeDirectory, 'fixture.txt'), 'before target\n')
    fs.writeFileSync(path.join(afterDirectory, 'fixture.txt'), 'after target\n')
  }
  git(repository, ['add', '.'])
  git(repository, ['commit', '--amend', '--no-edit'])

  await openFarming(page)
  await openNewAgentDialog(page)
  const agentId = await startAgentFromOpenDialog(page, 'bash', launcherWorkspace)
  await writeTerminalFixture(page, agentId, `$ javac\r\n${filePath}:2:1 error\r\n$ `)
  const rows = await terminalRows(page, agentId)
  const hit = rows
    .map((row, rowIndex) => {
      const match = /SmartOpen\.java:2:1/.exec(row)
      return match ? { row: rowIndex, col: match.index + 2 } : null
    })
    .find((candidate): candidate is { row: number; col: number } => Boolean(candidate))
  if (!hit) throw new Error(`External terminal path fixture is missing: ${JSON.stringify(rows)}`)
  const cell = await page.evaluate(({ id, col, row }) => (
    window.__farmingTerminalTest?.getCellCenter(id, col, row) ?? null
  ), { id: agentId, col: hit.col, row: hit.row })
  if (!cell) throw new Error('External terminal path cell is missing')
  await expect.poll(() => page.evaluate(({ id, col, row }) => (
    window.__farmingTerminalTest?.getPathAtCell(id, col, row)?.path ?? ''
  ), { id: agentId, col: hit.col, row: hit.row })).toBe(filePath)

  const mounted = page.waitForResponse(response => (
    response.request().method() === 'POST'
    && new URL(response.url()).pathname.endsWith('/api/projects/mount-file')
  ))
  await page.mouse.click(cell.x, cell.y)
  expect((await (await mounted).json()).workspace).toBe(fs.realpathSync(repository))
  const project = page.getByTestId('code-project-group').filter({ hasText: path.basename(repository) })
  await expect(project).toBeVisible()
  await expect(page.getByRole('tab', { name: 'SmartOpen.java' })).toBeVisible()
  const targetRow = project.locator('[data-testid="code-file-row"][data-file-path="compiler/src/SmartOpen.java"]')
  await expect(targetRow).toBeVisible()
  await expect.poll(async () => targetRow.evaluate(element => {
    const scroller = element.closest<HTMLElement>('.code-project-list')
    const projectGroup = element.closest<HTMLElement>('.code-project-group')
    const filesSection = element.closest<HTMLElement>('.code-files-section')
    if (!scroller || !projectGroup || !filesSection) return false
    const scrollerRect = scroller.getBoundingClientRect()
    const visibleTop = [
      projectGroup.querySelector<HTMLElement>('.code-project-row'),
      projectGroup.querySelector<HTMLElement>('.code-agents-section'),
      projectGroup.querySelector<HTMLElement>('[data-testid="code-open-editors"]'),
      filesSection.querySelector<HTMLElement>('.code-files-header'),
      filesSection.querySelector<HTMLElement>('.code-file-sticky-stack'),
    ].reduce((top, sticky) => {
      if (!sticky) return top
      const rect = sticky.getBoundingClientRect()
      if (rect.height <= 0 || rect.bottom <= scrollerRect.top || rect.top >= scrollerRect.bottom) return top
      return Math.max(top, rect.bottom)
    }, scrollerRect.top)
    const rowRect = element.getBoundingClientRect()
    const ratio = (rowRect.top + rowRect.height / 2 - visibleTop) / (scrollerRect.bottom - visibleTop)
    return ratio >= 0.3 && ratio <= 0.45
  })).toBe(true)
  await expectBlameAvailable(page)

  const sourceProject = page.getByTestId('code-project-group').filter({ hasText: path.basename(launcherWorkspace) })
  await sourceProject.hover()
  await sourceProject.getByTestId('code-project-agent-visibility').click({ force: true })
  await expect(sourceProject.getByTestId('code-project-agent-visibility')).toHaveAttribute('aria-expanded', 'false')
  await sourceProject.getByTestId('code-project-title').click({ force: true })
  await expect(sourceProject).toHaveAttribute('data-collapsed', 'true')
  await page.getByTestId('code-project-list').evaluate(scroller => {
    scroller.scrollTop = scroller.scrollHeight
  })

  await page.getByTestId('code-file-editor-back').click()
  await expect(sourceProject).toHaveAttribute('data-collapsed', 'false')
  await expect(sourceProject.getByTestId('code-project-agent-visibility')).toHaveAttribute('aria-expanded', 'true')
  const sourceAgentRow = sourceProject.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
  await expect(sourceAgentRow).toBeVisible()
  await expect(sourceAgentRow).toHaveClass(/active/)
  await expect.poll(async () => sourceAgentRow.evaluate(element => {
    const scroller = element.closest<HTMLElement>('.code-project-list')
    if (!scroller) return false
    const rowRect = element.getBoundingClientRect()
    const scrollerRect = scroller.getBoundingClientRect()
    return rowRect.top >= scrollerRect.top - 1 && rowRect.bottom <= scrollerRect.bottom + 1
  })).toBe(true)
})

test('promotes an external Chat file link to its nearest Git Project', async ({ page, workspaceRoot }) => {
  const launcherWorkspace = path.join(workspaceRoot, 'chat-link-launcher')
  fs.mkdirSync(launcherWorkspace, { recursive: true })
  const { filePath, repository } = createRepositoryFile(workspaceRoot, 'chat link git project 发布')
  const agentId = await createChatAgent(page, launcherWorkspace)
  let forceGlobalFallback = true
  const navigationResponses: Response[] = []
  page.on('response', response => {
    const pathname = new URL(response.url()).pathname
    if (pathname.endsWith('/api/projects/mount-file') || pathname.endsWith('/api/files/file')) {
      navigationResponses.push(response)
    }
  })

  await page.route(/\/farming\/api\/projects\/mount-file$/, async route => {
    if (forceGlobalFallback) {
      await route.fulfill({ status: 404, json: { error: 'No Git repository found for file' } })
      return
    }
    await route.continue()
  })

  await page.route(new RegExp(`/farming/api/agents/${agentId}/acp-transcript(?:\\?.*)?$`), async route => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        transcript: {
          sessionId: 'external-chat-file-link',
          state: 'idle',
          revision: 1,
          entries: [
            {
              id: 'external-chat-file-link-user',
              type: 'message',
              role: 'user',
              content: [{ type: 'text', text: 'Open the referenced file.' }],
            },
            {
              id: 'external-chat-file-link-answer',
              type: 'message',
              role: 'assistant',
              _meta: { codex: { phase: 'final_answer' } },
              content: [{ type: 'text', text: `[SmartOpen.java:2](${encodeURI(filePath)}:2)` }],
            },
          ],
        },
      }),
    })
  })

  await openFarming(page)
  await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
  const fileLink = page.locator('.code-agent-transcript-markdown-file-link', { hasText: 'SmartOpen.java:2' })
  await expect(fileLink).toBeVisible()
  await fileLink.click()
  await expect(page.locator('[data-testid="code-project-title"][data-project-id="/"]')).toBeVisible()
  const activeTab = page.locator('[role="tab"][aria-selected="true"]', { hasText: 'SmartOpen.java' })
  await expect(activeTab).toHaveAttribute('title', filePath.replace(/^\/+/, ''))

  forceGlobalFallback = false
  await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
  await expect(fileLink).toBeVisible()
  const responseStart = navigationResponses.length
  await fileLink.click()
  await expect.poll(() => navigationResponses.slice(responseStart).map(response => {
    const pathname = new URL(response.url()).pathname
    return `${response.request().method()} ${pathname} ${response.status()}`
  }), { timeout: 5_000 }).toEqual(expect.arrayContaining([
    'POST /farming/api/projects/mount-file 200',
    'GET /farming/api/files/file 200',
  ]))
  const mounted = navigationResponses.slice(responseStart).find(response => (
    response.request().method() === 'POST'
    && new URL(response.url()).pathname.endsWith('/api/projects/mount-file')
  ))
  const projectFileReadResponse = navigationResponses.slice(responseStart).find(response => (
    new URL(response.url()).pathname.endsWith('/api/files/file')
  ))
  if (!mounted || !projectFileReadResponse) throw new Error('Expected bounded mount and file responses')
  expect((await mounted.json()).workspace).toBe(fs.realpathSync(repository))
  const projectFileReadUrl = new URL(projectFileReadResponse.url())
  expect({
    ok: projectFileReadResponse.ok(),
    path: projectFileReadUrl.searchParams.get('path'),
    exact: projectFileReadUrl.searchParams.get('exact'),
  }).toEqual({ ok: true, path: 'compiler/src/SmartOpen.java', exact: null })

  const project = page.getByTestId('code-project-group').filter({ hasText: path.basename(repository) })
  await expect(project).toBeVisible()
  await expect(activeTab).toHaveAttribute('title', 'compiler/src/SmartOpen.java')
  await expect(page.getByTestId('code-file-editor-back')).toBeVisible()
  await expect(page.getByTestId('code-resource-agent-toggle')).toBeVisible()
  const sourceAgentRow = page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
  await expect(sourceAgentRow).not.toHaveClass(/active/)
  await expectBlameAvailable(page)

  await page.getByTestId('code-file-editor-back').click()
  await expect(sourceAgentRow).toHaveClass(/active/)
  await expect(fileLink).toBeVisible()
})
