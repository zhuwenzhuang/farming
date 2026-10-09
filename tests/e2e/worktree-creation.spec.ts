import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import type { Page } from '@playwright/test'
import { expect, openFarming, test } from './fixtures'
import { projectFilesWorkspaceId } from '../../src/lib/project-workspaces'

function git(repository: string, ...args: string[]) {
  return execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8' }).trim()
}

async function repositoryFixture(page: Page, workspaceRoot: string) {
  const repository = path.join(workspaceRoot, 'example-project')
  fs.mkdirSync(path.join(repository, 'src'), { recursive: true })
  fs.writeFileSync(path.join(repository, 'README.md'), '# Example project\n')
  fs.writeFileSync(path.join(repository, 'src', 'index.ts'), 'export const example = 1\n')
  git(repository, 'init', '-q')
  git(repository, 'config', 'user.name', 'Farming Test')
  git(repository, 'config', 'user.email', 'farming@example.test')
  git(repository, 'config', 'core.hooksPath', path.join(workspaceRoot, 'hooks'))
  git(repository, 'add', '.')
  git(repository, 'commit', '-qm', 'Initial example')
  const response = await page.request.post('/farming/api/projects/mount', { data: { workspace: repository } })
  expect(response.ok()).toBeTruthy()
  return repository
}

async function openCreate(page: Page, repository: string) {
  const project = page.getByTestId('code-project-group').filter({
    has: page.locator(`[data-testid="code-project-title"][data-project-id="${repository}"]`),
  })
  await project.getByTestId('code-project-title').hover()
  await project.getByTestId('code-project-actions').click()
  await page.getByTestId('code-project-context-menu').getByRole('menuitem', { name: 'Create permanent worktree' }).click()
  const dialog = page.getByTestId('code-worktree-create-dialog')
  await expect(dialog).toBeVisible()
  return { dialog, project }
}

function checkoutGate(workspaceRoot: string) {
  const hooks = path.join(workspaceRoot, 'hooks')
  fs.mkdirSync(hooks)
  const entered = path.join(workspaceRoot, 'checkout-started')
  const released = path.join(workspaceRoot, 'checkout-released')
  fs.writeFileSync(path.join(hooks, 'post-checkout'), `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(entered)}, 'started');
const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(released)})) { clearInterval(timer); process.exit(0); } }, 50);
setTimeout(() => process.exit(1), 25000);
`, { mode: 0o755 })
  return { entered, release: () => fs.writeFileSync(released, 'released') }
}

for (const appearance of ['light', 'dark', 'paper']) {
  test(`names, tracks, minimizes and restores a real Worktree in ${appearance}`, async ({ page, workspaceRoot }, testInfo) => {
    // Trusted HTTP exposes getRandomValues but not the secure-context randomUUID API.
    await page.addInitScript(() => {
      Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true })
    })
    const repository = await repositoryFixture(page, workspaceRoot)
    git(repository, 'branch', 'feature/taken')
    await openFarming(page)
    await page.locator('body').evaluate((body, value) => { body.dataset.appearance = value }, appearance)
    const { dialog, project } = await openCreate(page, repository)
    const name = dialog.getByRole('textbox', { name: 'Branch name' })
    await expect(name).toHaveValue(/^farming\/worktree-\d{8}$/)
    const initialName = await name.inputValue()
    git(repository, 'branch', initialName)
    fs.mkdirSync(path.join(workspaceRoot, `example-project-${initialName.replace(/\//g, '-')}-2`))
    await name.fill('feature/taken')
    await expect(dialog.getByRole('alert')).toContainText('already in use')
    await expect(dialog.getByRole('button', { name: 'Create', exact: true })).toBeDisabled()
    await name.fill('../invalid')
    await expect(dialog.getByRole('alert')).toContainText('invalid')
    await dialog.getByRole('button', { name: 'Use available default name' }).click()
    await expect(name).toHaveValue(`${initialName}-3`)
    await name.fill('feature/friendly')
    await expect(dialog.getByRole('button', { name: 'Create', exact: true })).toBeEnabled()
    await dialog.screenshot({ path: testInfo.outputPath(`worktree-name-${appearance}.png`), animations: 'disabled' })
    const gate = checkoutGate(workspaceRoot)
    const createRequests: string[] = []
    page.on('request', request => {
      if (request.method() === 'POST' && request.url().endsWith('/api/projects/create-worktree')) {
        createRequests.push((request.postDataJSON() as { requestId: string }).requestId)
      }
    })
    try {
      await dialog.getByRole('button', { name: 'Create', exact: true }).click()
      await expect.poll(() => fs.existsSync(gate.entered)).toBeTruthy()
      await expect(dialog.getByTestId('code-worktree-create-status')).toContainText('Checking out files')
      await dialog.dispatchEvent('submit')
      await page.keyboard.press('/')
      await page.keyboard.press('Escape')
      await expect(dialog).toBeVisible()
      expect(createRequests).toHaveLength(1)
      expect(createRequests[0]).toMatch(/^[a-f0-9]{32}$/)
      await dialog.screenshot({ path: testInfo.outputPath(`worktree-progress-${appearance}.png`), animations: 'disabled' })
      await dialog.getByRole('button', { name: 'Minimize' }).click()
      await expect(dialog).toHaveCount(0)
      await expect(project.getByTestId('code-project-worktree-creation')).toContainText('Checking out files')
      await page.reload()
      await expect(project.getByTestId('code-project-worktree-creation')).toBeVisible()
      await project.getByTestId('code-project-worktree-creation').click()
      await expect(dialog.getByTestId('code-worktree-create-status')).toContainText('Checking out files')
      gate.release()
      await expect(dialog).toHaveCount(0)
      const created = path.join(workspaceRoot, 'example-project-feature-friendly')
      await expect(page.locator(`[data-testid="code-project-title"][data-project-id="${created}"]`)).toBeVisible()
      expect(git(created, 'branch', '--show-current')).toBe('feature/friendly')
      expect(fs.readFileSync(path.join(created, 'src', 'index.ts'), 'utf8')).toContain('example = 1')
      expect(createRequests).toHaveLength(1)
      await openCreate(page, repository)
      await expect(name).toHaveValue(`${initialName}-3`)
      await dialog.getByRole('button', { name: 'Cancel' }).click()
    } finally {
      gate.release()
      if (createRequests[0]) await expect.poll(async () => {
        const result = await page.request.get('/farming/api/projects/worktree-operation', {
          params: { rootId: projectFilesWorkspaceId(repository), requestId: createRequests[0] },
        })
        return result.ok() ? (await result.json() as { state: string }).state : 'missing'
      }).not.toBe('pending')
    }
  })

  test(`Worktree naming supports a compact viewport in ${appearance}`, async ({ page, workspaceRoot }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 })
    const repository = await repositoryFixture(page, workspaceRoot)
    await openFarming(page)
    await page.locator('body').evaluate((body, value) => { body.dataset.appearance = value }, appearance)
    const navigation = page.getByTestId('code-mobile-menu')
    if (await navigation.isVisible()) await navigation.click()
    const { dialog } = await openCreate(page, repository)
    await expect(dialog.getByRole('textbox', { name: 'Branch name' })).toHaveValue(/^farming\/worktree-\d{8}$/)
    await expect(dialog.getByRole('button', { name: 'Create', exact: true })).toBeEnabled()
    const bounds = await dialog.boundingBox()
    expect(bounds!.x).toBeGreaterThanOrEqual(0)
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390)
    await dialog.screenshot({ path: testInfo.outputPath(`worktree-name-compact-${appearance}.png`), animations: 'disabled' })
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    expect(git(repository, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1)
    await openCreate(page, repository)
    await expect(dialog.getByRole('button', { name: 'Create', exact: true })).toBeEnabled()
    const gate = checkoutGate(workspaceRoot)
    try {
      await dialog.getByRole('button', { name: 'Create', exact: true }).click()
      await expect.poll(() => fs.existsSync(gate.entered)).toBeTruthy()
      await expect(dialog.getByTestId('code-worktree-create-status')).toContainText('Checking out files')
      await expect(dialog.getByRole('button', { name: 'Creating…', exact: true })).toBeDisabled()
      expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBeTruthy()
      await dialog.screenshot({ path: testInfo.outputPath(`worktree-progress-compact-${appearance}.png`), animations: 'disabled' })
      gate.release()
      await expect(dialog).toHaveCount(0)
    } finally { gate.release() }
  })
}

test('a lost creation response reconciles the original operation without another POST', async ({ page, workspaceRoot }) => {
  const repository = await repositoryFixture(page, workspaceRoot)
  let creates = 0
  await page.route('**/api/projects/create-worktree', async route => {
    creates += 1
    await route.fetch()
    await route.abort()
  })
  await openFarming(page)
  const { dialog } = await openCreate(page, repository)
  await expect(dialog.getByRole('button', { name: 'Create', exact: true })).toBeEnabled()
  const branch = await dialog.getByRole('textbox', { name: 'Branch name' }).inputValue()
  git(repository, 'branch', branch)
  await dialog.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByTestId('code-copy-toast')).toContainText('Permanent worktree created')
  expect(creates).toBe(1)
  expect(git(repository, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(2)
  expect(git(path.join(workspaceRoot, `example-project-${branch.replace(/\//g, '-')}-2`), 'branch', '--show-current')).toBe(`${branch}-2`)
})

test('an unobserved creation stays uncertain across reload and never replays', async ({ page, workspaceRoot }) => {
  await page.clock.install()
  const repository = await repositoryFixture(page, workspaceRoot)
  let creates = 0
  await page.route('**/api/projects/create-worktree', async route => { creates += 1; await route.abort() })
  await page.route('**/api/projects/worktree-operation?*', route => route.fulfill({ status: 404, json: { error: 'Not observed' } }))
  await openFarming(page)
  const { dialog, project } = await openCreate(page, repository)
  await expect(dialog.getByRole('button', { name: 'Create', exact: true })).toBeEnabled()
  await dialog.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(dialog.getByTestId('code-worktree-create-status')).toContainText('Confirming creation result')
  await dialog.getByRole('button', { name: 'Minimize' }).click()
  await page.reload()
  await project.getByTestId('code-project-worktree-creation').click()
  await expect(dialog.getByTestId('code-worktree-create-status')).toContainText('Confirming creation result')
  await page.clock.fastForward(121_000)
  await expect(dialog.getByTestId('code-worktree-create-status')).toContainText('Creation result is not yet confirmed')
  await dialog.getByRole('button', { name: 'Check status' }).click()
  await expect(dialog.getByRole('button', { name: 'Create', exact: true })).toHaveCount(0)
  expect(creates).toBe(1)
  expect(git(repository, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1)
})

for (const appearance of ['light', 'dark', 'paper']) {
  test(`updates the Worktree directory immediately while validation is pending in ${appearance}`, async ({ page, workspaceRoot }, testInfo) => {
    const repository = await repositoryFixture(page, workspaceRoot)
    await openFarming(page)
    await page.locator('body').evaluate((body, value) => { body.dataset.appearance = value }, appearance)
    const { dialog } = await openCreate(page, repository)
    const name = dialog.getByRole('textbox', { name: 'Branch name' })
    const create = dialog.getByRole('button', { name: 'Create', exact: true })
    const directory = dialog.getByTestId('code-worktree-create-directory')
    await expect(create).toBeEnabled()
    const source = await dialog.locator('dd').first().textContent()
    const pending: Array<{ release: () => void; done: Promise<void> }> = []
    await page.route('**/api/projects/worktree-preview?**', async route => {
      let release!: () => void
      let finish!: () => void
      const gate = new Promise<void>(resolve => { release = resolve })
      const done = new Promise<void>(resolve => { finish = resolve })
      pending.push({ release, done })
      try {
        const response = await route.fetch()
        await gate
        await route.fulfill({ response })
      } catch { /* Superseded requests are deliberately aborted by the dialog. */ }
      finally { finish() }
    })
    try {
      await name.fill('feature/first')
      await expect(directory).toHaveText(path.join(workspaceRoot, 'example-project-feature-first'))
      await expect(create).toBeDisabled()
      await expect.poll(() => pending.length).toBe(1)
      await name.fill('feature/another-reference')
      await expect(directory).toHaveText(path.join(workspaceRoot, 'example-project-feature-another-reference'))
      await expect(dialog.locator('dd').first()).toHaveText(source!)
      await expect(create).toBeDisabled()
      await expect.poll(() => pending.length).toBe(2)
      pending[0]!.release()
      await pending[0]!.done
      await expect(directory).toHaveText(path.join(workspaceRoot, 'example-project-feature-another-reference'))
      await expect(create).toBeDisabled()
      await dialog.screenshot({ path: testInfo.outputPath(`worktree-live-name-${appearance}.png`), animations: 'disabled' })
      pending[1]!.release()
      await expect(create).toBeEnabled()
      await expect(directory).toHaveText(path.join(workspaceRoot, 'example-project-feature-another-reference'))
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    } finally {
      for (const request of pending) request.release()
      await Promise.all(pending.map(request => request.done))
      await page.unroute('**/api/projects/worktree-preview?**')
    }
  })
}
