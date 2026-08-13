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
  await expectBlameAvailable(page)
})
