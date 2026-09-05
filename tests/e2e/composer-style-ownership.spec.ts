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
  await expect(composer).toHaveCSS('border-top-color', 'rgba(0, 0, 0, 0)')
  await expect(composer).toHaveCSS('border-radius', '12px')
  await expect(send).toHaveCSS('width', '32px')
  await expect(send).toHaveCSS('height', '32px')

  await page.locator('body').evaluate(body => { body.dataset.appearance = 'dark' })
  await expect(composer).toHaveCSS('background-color', 'rgb(24, 24, 24)')
  await expect(composer).toHaveCSS('border-top-color', 'rgba(0, 0, 0, 0)')
  await expect(composer).toHaveCSS('color', 'rgb(255, 255, 255)')

  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.locator('body')).toHaveClass(/code-compact-layout/)
  await expect(composer).toHaveCSS('position', 'absolute')
  await expect(composer).toHaveCSS('margin', '0px')
  await expect(composer).toHaveCSS('border-top-width', '0px')
  await expect(composer).toHaveCSS('border-radius', '20px')
  await expect(composer).toHaveCSS('background-color', 'rgb(24, 24, 24)')
  await expect(send).toHaveCSS('width', '44px')
  await expect(send).toHaveCSS('min-width', '44px')
  await expect(send).toHaveCSS('height', '44px')
})

for (const runtime of ['terminal', 'chat'] as const) {
  test(`Paper ${runtime} input stays distinct from the reading surface across widths and focus`, async ({ page, workspaceRoot }) => {
    const response = await page.request.post('/farming/api/control/agents', {
      data: { command: runtime === 'chat' ? 'codex' : 'bash', workspace: workspaceRoot, agentRuntimeMode: runtime },
    })
    expect(response.ok()).toBeTruthy()
    const payload = await response.json() as { agentId?: string }
    expect(payload.agentId).toBeTruthy()

    await openFarming(page)
    await page.locator('body').evaluate(body => { body.dataset.appearance = 'paper' })
    await page.locator(`[data-testid="code-agent-row"][data-agent-id="${payload.agentId}"]`).click()

    const composer = page.getByTestId(runtime === 'chat' ? 'code-acp-composer' : 'code-composer')
    const input = page.getByTestId(runtime === 'chat' ? 'code-acp-composer-input' : 'code-composer-input')
    await expect(composer).toBeVisible()
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 844 })
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
      await expect(composer).toHaveCSS('background-color', 'rgb(255, 254, 250)')
      await expect(composer).toHaveCSS('border-top-color', 'rgba(0, 0, 0, 0)')
      await expect(composer).toHaveCSS('box-shadow', 'none')
      await expect(page.locator('.code-main')).toHaveCSS('background-color', 'rgb(249, 248, 244)')

      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
      const idleStyle = await composer.evaluate(element => {
        const style = getComputedStyle(element)
        return {
          background: style.backgroundColor,
          border: style.borderColor,
          boxShadow: style.boxShadow,
        }
      })
      await input.focus()
      await expect.poll(() => composer.evaluate(element => {
        const style = getComputedStyle(element)
        return {
          background: style.backgroundColor,
          border: style.borderColor,
          boxShadow: style.boxShadow,
        }
      })).toEqual(idleStyle)
      await input.fill('请检查输入框与正文的颜色区分')
      await composer.screenshot({ path: test.info().outputPath(`paper-${runtime}-${width}-focused.png`) })
      if (runtime === 'chat') {
        await page.getByTestId('code-acp-composer-add').click()
        await expect(page.getByTestId('code-acp-plus-menu')).toBeVisible()
        await expect(composer).toHaveCSS('background-color', 'rgb(255, 254, 250)')
        await page.keyboard.press('Escape')
      } else {
        // A plain Bash terminal has no attachment/context menu capability.
        await expect(page.getByTestId('code-composer-add')).toHaveCount(0)
      }
    }
  })
}
