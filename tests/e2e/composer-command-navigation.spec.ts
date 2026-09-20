import { expect, openFarming, test } from './fixtures'

for (const appearance of ['light', 'dark', 'paper'] as const) {
  test(`Chat command keyboard selection stays visible in ${appearance}`, async ({ page, workspaceRoot }) => {
    const response = await page.request.post('/farming/api/control/agents', {
      data: { command: 'codex', workspace: workspaceRoot, agentRuntimeMode: 'chat' },
    })
    expect(response.ok()).toBeTruthy()
    const { agentId } = await response.json() as { agentId: string }
    await page.route(/\/farming\/api\/agents\/[^/]+\/acp-session(?:\?includeEntries=0)?$/, async route => {
      const response = await route.fetch()
      const payload = await response.json()
      payload.session.availableCommands = Array.from({ length: 12 }, (_, index) => ({
        name: `command-${index}`,
        description: `Inspect workspace changes and report result ${index}`,
      }))
      await route.fulfill({ response, json: payload })
    })
    await page.setViewportSize({ width: 1280, height: 800 })
    await openFarming(page)
    await page.evaluate(value => {
      document.documentElement.dataset.appearance = value
      document.body.dataset.appearance = value
    }, appearance)
    await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
    const input = page.getByTestId('code-acp-composer-input')
    await expect(input).toBeEnabled()
    await input.fill('/command-')
    const menu = page.getByTestId('code-acp-command-menu')
    const selected = menu.locator('[aria-selected="true"]')
    await expect(menu.getByRole('option')).toHaveCount(12)
    const expectedFill = { light: 'rgb(238, 238, 236)', dark: 'rgb(35, 54, 72)', paper: 'rgb(230, 229, 225)' }[appearance]
    await expect(selected).toHaveCSS('background-color', expectedFill)
    async function visibleSelection() {
      await expect(input).toBeFocused()
      await expect.poll(() => selected.evaluate(row => {
        const container = row.parentElement!
        const bounds = container.getBoundingClientRect()
        const item = row.getBoundingClientRect()
        return item.top >= bounds.top + container.clientTop - 1
          && item.bottom <= bounds.top + container.clientTop + container.clientHeight + 1
      })).toBe(true)
    }
    for (let index = 1; index < 12; index++) {
      await input.press('ArrowDown')
      await expect(selected).toHaveAttribute('data-testid', `code-acp-command-command-${index}`)
      await visibleSelection()
    }
    await menu.screenshot({ path: test.info().outputPath(`${appearance}-commands-end.png`) })
    await input.press('ArrowDown')
    await expect(selected).toHaveAttribute('data-testid', 'code-acp-command-command-0')
    await visibleSelection()
    await input.press('ArrowUp')
    await visibleSelection()
    await input.press('Home')
    await expect(selected).toHaveAttribute('data-testid', 'code-acp-command-command-0')
    await visibleSelection()
    await input.press('End')
    await expect(selected).toHaveAttribute('data-testid', 'code-acp-command-command-11')
    await visibleSelection()
    await input.fill('/command-1')
    await expect(selected).toHaveAttribute('data-testid', 'code-acp-command-command-1')
    await visibleSelection()
    await selected.hover()
    await expect(selected).toHaveCSS('background-color', expectedFill)
    await input.press('Tab')
    await expect(input).toHaveValue('/command-1 ')
  })
}
