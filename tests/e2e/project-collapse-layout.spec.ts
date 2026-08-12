import fs from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { expect, openFarming, test } from './fixtures'

async function createAgent(page: Page, workspace: string) {
  const response = await page.request.post('/farming/api/control/agents', {
    data: { command: 'bash', workspace },
  })
  expect(response.ok()).toBeTruthy()
}

test('removes the sticky Project tail when a Project is collapsed', async ({ page, workspaceRoot }) => {
  const firstWorkspace = path.join(workspaceRoot, 'collapse-layout-first')
  const secondWorkspace = path.join(workspaceRoot, 'collapse-layout-second')
  fs.mkdirSync(firstWorkspace, { recursive: true })
  fs.mkdirSync(secondWorkspace, { recursive: true })
  await createAgent(page, firstWorkspace)
  await createAgent(page, secondWorkspace)
  await openFarming(page)

  const firstProject = page.getByTestId('code-project-group').filter({
    has: page.getByTestId('code-project-title').filter({ hasText: path.basename(firstWorkspace) }),
  })
  const secondProject = page.getByTestId('code-project-group').filter({
    has: page.getByTestId('code-project-title').filter({ hasText: path.basename(secondWorkspace) }),
  })
  const firstTitle = firstProject.getByTestId('code-project-title')
  await expect(firstTitle).toHaveAttribute('aria-expanded', 'true')

  await firstTitle.click()
  await expect(firstTitle).toHaveAttribute('aria-expanded', 'false')
  await expect(firstProject).toHaveAttribute('data-collapsed', 'true')
  await expect(firstProject.locator('.code-project-expanded')).toHaveCount(0)

  const groupBox = await firstProject.boundingBox()
  const rowBox = await firstProject.locator('.code-project-row').boundingBox()
  const nextProjectBox = await secondProject.boundingBox()
  if (!groupBox || !rowBox || !nextProjectBox) throw new Error('Collapsed Project rows must have measurable bounds')
  await expect(firstProject.locator('.code-project-row')).toHaveCSS('padding-bottom', '0px')
  expect(Math.abs(groupBox.height - rowBox.height)).toBeLessThanOrEqual(1)
  expect(nextProjectBox.y - (groupBox.y + groupBox.height)).toBeLessThanOrEqual(8)

  await firstTitle.click()
  await expect(firstTitle).toHaveAttribute('aria-expanded', 'true')
  await expect(firstProject).toHaveAttribute('data-collapsed', 'false')
  await expect(firstProject.locator('.code-project-expanded')).toBeVisible()
})
