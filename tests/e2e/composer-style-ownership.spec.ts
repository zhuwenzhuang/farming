import { expect, openFarming, test } from './fixtures'

test('Composer style owners preserve the light, dark, and compact runtime cascade', async ({ page, workspaceRoot }) => {
  const response = await page.request.post('/farming/api/control/agents', {
    data: { command: 'bash', workspace: workspaceRoot },
  })
  expect(response.ok()).toBeTruthy()
  const payload = await response.json() as { agentId?: string }
  expect(payload.agentId).toBeTruthy()

  await page.setViewportSize({ width: 1280, height: 800 })
  await openFarming(page)
  await page.locator(`[data-testid="code-agent-row"][data-agent-id="${payload.agentId}"]`).click()

  const composer = page.getByTestId('code-composer')
  const send = page.getByTestId('code-composer-send')
  await expect(composer).toBeVisible()
  await expect(composer).toHaveCSS('background-color', 'rgb(255, 255, 255)')
  await expect(composer).toHaveCSS('border-top-width', '1px')
  await expect(composer).toHaveCSS('border-top-color', 'rgb(217, 221, 212)')
  await expect(composer).toHaveCSS('border-radius', '12px')
  await expect(send).toHaveCSS('width', '32px')
  await expect(send).toHaveCSS('height', '32px')

  await page.locator('body').evaluate(body => { body.dataset.appearance = 'dark' })
  await expect(composer).toHaveCSS('background-color', 'rgba(22, 27, 34, 0.82)')
  await expect(composer).toHaveCSS('border-top-color', 'rgba(240, 246, 252, 0.1)')
  await expect(composer).toHaveCSS('color', 'rgb(255, 255, 255)')

  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.locator('body')).toHaveClass(/code-compact-layout/)
  await expect(composer).toHaveCSS('position', 'absolute')
  await expect(composer).toHaveCSS('margin', '0px')
  await expect(composer).toHaveCSS('border-top-width', '0px')
  await expect(composer).toHaveCSS('border-radius', '20px')
  await expect(composer).toHaveCSS('background-color', 'rgba(22, 27, 34, 0.78)')
  await expect(send).toHaveCSS('width', '44px')
  await expect(send).toHaveCSS('min-width', '44px')
  await expect(send).toHaveCSS('height', '44px')
})
