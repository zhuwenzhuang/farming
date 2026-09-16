import fs from 'node:fs'
import path from 'node:path'
import type { Locator } from '@playwright/test'
import { expect, openFarming, test } from './fixtures'

async function cardContract(card: Locator) {
  await expect(card).toBeVisible()
  await expect(card).toHaveCSS('border-radius', '16px')
  await expect(card).toHaveCSS('padding', '12px 14px')
  await expect(card).toHaveCSS('gap', '8px')
  await expect(card).toHaveCSS('font-size', '14px')
  await expect(card).toHaveCSS('line-height', '20px')
  await expect(card.locator('strong')).toHaveCSS('font-size', '15px')
  await expect(card.locator('strong')).toHaveCSS('font-weight', '500')
  await expect(card.locator('.code-info-card-row').first()).toHaveCSS('grid-template-columns', /16px /)
  const bounds = await card.evaluate(el => {
    const rect = el.getBoundingClientRect()
    return { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom, width: innerWidth, height: innerHeight, overflow: el.scrollWidth > el.clientWidth }
  })
  expect(bounds.x).toBeGreaterThanOrEqual(8)
  expect(bounds.y).toBeGreaterThanOrEqual(8)
  expect(bounds.right).toBeLessThanOrEqual(bounds.width - 8)
  expect(bounds.bottom).toBeLessThanOrEqual(bounds.height - 8)
  expect(bounds.overflow).toBe(false)
  return card.evaluate(el => {
    const style = getComputedStyle(el)
    return { background: style.backgroundColor, shadow: style.boxShadow, border: style.border, font: style.fontFamily }
  })
}

test('Project and Agent information cards share geometry, long-content and dismissal rules in every appearance', async ({ page, workspaceRoot }, testInfo) => {
  testInfo.setTimeout(120_000)
  const workspace = path.join(workspaceRoot, 'sample-project-with-a-long-descriptive-name')
  fs.mkdirSync(workspace, { recursive: true })
  fs.writeFileSync(path.join(workspace, 'README.md'), '# Example project\n')
  const title = 'Inspect shared information cards with a long Agent title and metadata'
  const response = await page.request.post('/farming/api/control/agents', { data: { command: 'bash', workspace } })
  expect(response.ok()).toBeTruthy()
  const { agentId } = await response.json() as { agentId: string }
  const renamed = await page.request.patch(`/farming/api/agents/${agentId}`, { data: { customTitle: title } })
  expect(renamed.ok()).toBeTruthy()
  await openFarming(page)
  const row = page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
  const project = page.getByTestId('code-project-group').filter({ has: row })
  const projectTitle = project.getByTestId('code-project-title')
  const projectCard = page.getByTestId('code-project-hover-preview')
  const agentCard = page.getByTestId('code-agent-hover-preview')
  for (const appearance of ['light', 'dark', 'paper'] as const) {
    await page.emulateMedia({ colorScheme: appearance === 'dark' ? 'dark' : 'light', reducedMotion: 'reduce' })
    await page.evaluate(value => {
      document.documentElement.dataset.appearance = value
      document.body.dataset.appearance = value
    }, appearance)
    await projectTitle.hover()
    const projectStyle = await cardContract(projectCard)
    await expect(projectCard).toContainText(workspace)
    await expect(projectCard.getByTestId('code-project-hover-preview-workspace')).toHaveCSS('font-size', '13px')
    await expect(projectCard).toHaveScreenshot(`project-info-${appearance}.png`, {
      mask: [projectCard.getByTestId('code-project-hover-preview-workspace').locator('span').last()],
    })
    const composed = testInfo.outputPath(`project-context-${appearance}.png`)
    await page.screenshot({ path: composed, clip: { x: 0, y: 0, width: 700, height: 400 },
      mask: [projectCard.getByTestId('code-project-hover-preview-workspace').locator('span').last()] })
    await testInfo.attach(`project-context-${appearance}`, { path: composed, contentType: 'image/png' })
    await row.hover()
    expect(await cardContract(agentCard)).toEqual(projectStyle)
    await expect(projectCard).toHaveCount(0)
    await expect(agentCard.locator('strong')).toHaveText(title)
    await expect(page.getByTestId('code-agent-hover-title-card')).toHaveCount(0)
    const titleSize = await agentCard.locator('strong').boundingBox()
    expect(titleSize!.height).toBeGreaterThan(20)
    await expect(agentCard).toHaveScreenshot(`agent-info-${appearance}.png`, { mask: [agentCard.locator('.code-info-card-meta')] })
    // The pointer can cross the anchor gap to read/select long content.
    await agentCard.hover()
    await agentCard.locator('strong').click()
    await expect(agentCard).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(agentCard).toHaveCount(0)
    await page.mouse.move(1000, 100)
  }
  // Keyboard inspection keeps focus on the invoking title and Escape stays closed.
  await page.keyboard.press('Tab')
  await projectTitle.focus()
  await expect(projectCard).toBeVisible()
  await expect(projectTitle).toBeFocused()
  await expect(projectTitle).toHaveAttribute('aria-describedby', await projectCard.getAttribute('id') as string)
  await page.keyboard.press('Escape')
  await expect(projectCard).toHaveCount(0)
  await expect(projectTitle).toBeFocused()
  await expect(projectTitle).not.toHaveAttribute('aria-describedby')
  await row.focus()
  await expect(agentCard).toBeVisible()
  await expect(row).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(agentCard).toHaveCount(0)
  // Real sidebar content at a short viewport exercises measured vertical bounds.
  await page.setViewportSize({ width: 1000, height: 300 })
  await row.hover()
  await cardContract(agentCard)
  await page.setViewportSize({ width: 1000, height: 260 })
  await cardContract(agentCard)
  await page.mouse.move(900, 200)
  await expect(agentCard).toHaveCount(0)
  // A cancelled initial delay must not resurrect a card over subsequent work.
  await row.hover()
  await page.mouse.move(900, 200)
  await projectTitle.click({ button: 'right' })
  await expect(page.getByTestId('code-project-context-menu')).toBeVisible()
  await expect(page.locator('.code-info-card')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await row.hover()
  await expect(agentCard).toBeVisible()
  await page.setViewportSize({ width: 393, height: 852 })
  await expect(agentCard).toHaveCount(0)
  await page.getByTestId('code-mobile-menu').click()
  await page.clock.install()
  await projectTitle.hover()
  await page.clock.fastForward(1600)
  await expect(page.locator('.code-info-card')).toHaveCount(0)
  await expect(project.getByTestId('code-project-actions')).toBeVisible()
})
