import fs from 'node:fs'
import path from 'node:path'
import {
  expect,
  openFarming,
  openNewAgentDialog,
  PLAYWRIGHT_WORKSPACE_ROOT,
  startAgentFromOpenDialog,
  test,
} from './fixtures'

test('keeps large expanded file trees off the warm file-switch render path', async ({ page }) => {
  const workspaceRoot = path.join(PLAYWRIGHT_WORKSPACE_ROOT, 'project-files-performance')
  fs.rmSync(workspaceRoot, { recursive: true, force: true })
  fs.mkdirSync(workspaceRoot, { recursive: true })
  for (let index = 0; index < 2_000; index += 1) {
    fs.writeFileSync(path.join(workspaceRoot, `file-${String(index).padStart(4, '0')}.txt`), `${index}\n`)
  }

  await openFarming(page)
  await openNewAgentDialog(page)
  await startAgentFromOpenDialog(page, 'bash', workspaceRoot)

  const project = page.getByTestId('code-project-group').filter({ hasText: path.basename(workspaceRoot) })
  await expect(project).toBeVisible({ timeout: 30_000 })
  const files = project.getByTestId('code-files-section')
  const filesTitle = files.locator('.code-files-title').first()
  if (await filesTitle.getAttribute('aria-expanded') !== 'true') await filesTitle.click()
  await expect(files.getByTestId('code-file-row')).toHaveCount(2_000)

  const firstPath = 'file-0000.txt'
  const secondPath = 'file-0001.txt'
  await files.locator(`[data-file-path="${firstPath}"]`).dblclick()
  await files.locator(`[data-file-path="${secondPath}"]`).dblclick()
  const editor = page.getByTestId('code-file-editor')
  const firstTab = editor.locator(`[role="tab"][title="${firstPath}"]`)
  const secondTab = editor.locator(`[role="tab"][title="${secondPath}"]`)
  await expect(firstTab).toBeVisible()
  await expect(secondTab).toBeVisible()

  await page.evaluate(() => window.__farmingPerformanceTest?.reset())
  await firstTab.click()
  await expect(firstTab).toHaveAttribute('aria-selected', 'true')
  await secondTab.click()
  await expect(secondTab).toHaveAttribute('aria-selected', 'true')
  const renderCounts = await page.evaluate(() => window.__farmingPerformanceTest?.snapshot())

  expect(renderCounts?.fileTreeRow).toBeLessThanOrEqual(12)
  await expect(files.locator(`[data-file-path="${firstPath}"]`)).not.toHaveClass(/active/)
  await expect(files.locator(`[data-file-path="${secondPath}"]`)).toHaveClass(/active/)
})
