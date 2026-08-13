import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  expect,
  openFarming,
  openNewAgentDialog,
  startAgentFromOpenDialog,
  test,
} from './fixtures'

test('keeps an explicitly selected repository subdirectory as its own Project', async ({ page, workspaceRoot }) => {
  const repository = path.join(workspaceRoot, 'odps_src')
  const selectedModule = path.join(repository, 'odps-sql')
  fs.mkdirSync(selectedModule, { recursive: true })
  fs.writeFileSync(path.join(repository, 'README.md'), '# repository\n')
  fs.writeFileSync(path.join(selectedModule, 'README.md'), '# selected module\n')
  execFileSync('git', ['init'], { cwd: repository, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.email', 'farming-e2e@example.test'], { cwd: repository })
  execFileSync('git', ['config', 'user.name', 'Farming E2E'], { cwd: repository })
  execFileSync('git', ['add', 'README.md', 'odps-sql/README.md'], { cwd: repository })
  execFileSync('git', ['commit', '-m', 'seed repository'], { cwd: repository, stdio: 'ignore' })

  const mountResponse = await page.request.post('/farming/api/projects/mount', {
    data: { workspace: repository },
  })
  expect(mountResponse.ok()).toBeTruthy()

  await openFarming(page)
  await openNewAgentDialog(page)
  const agentId = await startAgentFromOpenDialog(page, 'bash', selectedModule)

  const parentProject = page.getByTestId('code-project-group').filter({
    has: page.getByTestId('code-project-title').filter({ hasText: 'odps_src' }),
  })
  const moduleProject = page.getByTestId('code-project-group').filter({
    has: page.getByTestId('code-project-title').filter({ hasText: 'odps-sql' }),
  })
  const agentSelector = `[data-testid="code-agent-row"][data-agent-id="${agentId}"]`

  await expect(parentProject).toHaveCount(1)
  await expect(moduleProject).toHaveCount(1)
  await expect(parentProject.locator(agentSelector)).toHaveCount(0)
  await expect(moduleProject.locator(agentSelector)).toHaveCount(1)
  await expect(page.locator(agentSelector)).toHaveAttribute('aria-label', new RegExp(
    selectedModule.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
  ))

  await expect.poll(async () => {
    const response = await page.request.get('/farming/api/settings')
    const data = await response.json() as { settings?: { projectWorkspaces?: string[] } }
    return data.settings?.projectWorkspaces ?? []
  }).toEqual(expect.arrayContaining([repository, selectedModule]))
})
