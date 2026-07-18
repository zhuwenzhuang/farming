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
