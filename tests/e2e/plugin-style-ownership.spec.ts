import { expect, openFarming, test } from './fixtures'

test('Plugin style owners preserve the light, dark, and narrow runtime cascade', async ({ page }) => {
  await openFarming(page)
  await page.route('**/farming/api/agent-extensions', async route => {
    const response = await route.fetch()
    const data = await response.json() as {
      agents?: Array<{ id?: string, available?: boolean } & Record<string, unknown>>
    }
    await route.fulfill({
      response,
      json: {
        ...data,
        agents: data.agents?.map(agent => agent.id === 'opencode'
          ? { ...agent, available: false }
          : agent),
      },
    })
  })
  await page.getByTestId('code-nav-plugins').click()

  const panel = page.getByTestId('code-plugins-panel')
  const pluginView = page.locator('.code-plugins-view')
  const tabs = panel.locator('.code-plugin-tabs')
  const selectedTab = tabs.locator('[aria-selected="true"]')
  const firstCard = panel.locator('.code-plugin-card').first()

  await expect(panel).toBeVisible()
  await expect(pluginView).toHaveCSS('background-color', 'rgb(255, 255, 255)')
  await expect(tabs).toHaveCSS('background-color', 'rgb(246, 248, 250)')
  await expect(selectedTab).toHaveCSS('background-color', 'rgb(255, 255, 255)')
  await expect(firstCard).toHaveCSS('background-color', 'rgb(246, 248, 250)')

  await page.locator('body').evaluate(body => { body.dataset.appearance = 'dark' })
  await expect(tabs).toHaveCSS('background-color', 'rgb(28, 28, 28)')
  await expect(selectedTab).toHaveCSS('background-color', 'rgb(24, 24, 24)')
  await expect(firstCard).toHaveCSS('background-color', 'rgb(28, 28, 28)')

  await page.locator('body').evaluate(body => { body.dataset.appearance = 'paper' })
  await panel.getByTestId('code-plugin-tab-farming').click()
  const selectTrigger = panel.locator('.code-select-trigger').first()
  await expect(selectTrigger).toBeVisible()
  await expect(selectTrigger).toHaveCSS('background-color', 'rgb(255, 254, 250)')
  await expect(selectTrigger).toHaveCSS('border-color', 'rgba(0, 0, 0, 0)')
  await expect(selectTrigger).toHaveCSS('color', 'rgb(40, 41, 34)')

  await panel.getByTestId('code-plugin-tab-homes').click()
  const openCode = panel.getByTestId('code-plugin-section-agent-opencode-default')
  const agentIdentity = openCode.locator('.code-plugin-agent-identity')
  const agentConfiguration = openCode.locator('.code-plugin-agent-configuration')
  const appearanceStyles = {
    light: {
      border: 'rgba(31, 35, 40, 0.12)',
      title: 'rgb(36, 41, 47)',
      muted: 'rgb(87, 96, 106)',
      subtle: 'rgb(110, 119, 129)',
      badgeBackground: 'rgba(31, 35, 40, 0.055)',
      warning: 'rgb(154, 103, 0)',
      warningBackground: 'rgba(210, 153, 34, 0.14)',
    },
    dark: {
      border: 'rgb(56, 56, 56)',
      title: 'rgb(255, 255, 255)',
      muted: 'rgb(216, 216, 216)',
      subtle: 'rgb(155, 155, 155)',
      badgeBackground: 'rgb(45, 45, 45)',
      warning: 'rgb(210, 153, 34)',
      warningBackground: 'rgba(210, 153, 34, 0.16)',
    },
    paper: {
      border: 'rgba(0, 0, 0, 0)',
      title: 'rgb(40, 41, 34)',
      muted: 'rgb(104, 104, 95)',
      subtle: 'rgb(119, 119, 109)',
      badgeBackground: 'rgba(82, 75, 60, 0.055)',
      warning: 'rgb(139, 90, 24)',
      warningBackground: 'rgb(243, 234, 212)',
    },
  } as const
  for (const appearance of ['light', 'dark', 'paper'] as const) {
    await page.locator('body').evaluate((body, value) => { body.dataset.appearance = value }, appearance)
    const expected = appearanceStyles[appearance]
    await expect(openCode).toHaveCSS('border-top-color', expected.border)
    await expect(agentIdentity.locator('h3')).toHaveCSS('color', expected.title)
    await expect(agentIdentity.locator('h3 > span')).toHaveCSS('color', expected.subtle)
    await expect(agentIdentity.locator('h3 > span')).toHaveCSS('background-color', expected.badgeBackground)
    await expect(agentIdentity.locator('h3 > em')).toHaveCSS('color', expected.warning)
    await expect(agentIdentity.locator('h3 > em')).toHaveCSS('background-color', expected.warningBackground)
    await expect(agentIdentity.locator('h3 > small')).toHaveCSS('color', expected.subtle)
    await expect(agentIdentity.locator('p code')).toHaveCSS('color', expected.muted)
    await expect(agentConfiguration.locator('strong')).toHaveCSS('color', expected.muted)
    await expect(agentConfiguration.locator('span')).toHaveCSS('color', expected.muted)
  }
  await panel.getByRole('button', { name: 'Add Agent', exact: true }).click()
  const form = panel.getByTestId('code-plugin-agent-form')
  await expect(form).toBeVisible()
  await expect.poll(() => form.evaluate(element => (
    getComputedStyle(element).gridTemplateColumns.trim().split(/\s+/).length
  ))).toBeGreaterThan(1)

  await page.setViewportSize({ width: 680, height: 900 })
  await expect.poll(() => form.evaluate(element => (
    getComputedStyle(element).gridTemplateColumns.trim().split(/\s+/).length
  ))).toBe(1)
})

test('Search, History, and Plugins share one page-title and canvas contract', async ({ page }) => {
  await openFarming(page)

  const pages = [
    { nav: 'code-nav-search', view: '.code-search-view', heading: '.code-search-panel-header h2' },
    { nav: 'code-nav-history', view: '.code-history-view', heading: '.code-history-panel-header h2' },
    { nav: 'code-nav-plugins', view: '.code-plugins-view', heading: '.code-plugins-panel-header h2' },
  ] as const

  for (const appearance of ['light', 'dark', 'paper'] as const) {
    await page.locator('body').evaluate((body, value) => { body.dataset.appearance = value }, appearance)
    const pageStyles: Array<{ background: string, fontSize: string, fontWeight: string, lineHeight: string }> = []
    for (const entry of pages) {
      await page.getByTestId(entry.nav).click()
      await expect(page.locator(entry.heading)).toBeVisible()
      pageStyles.push(await page.locator(entry.heading).evaluate((heading, viewSelector) => {
        const headingStyle = getComputedStyle(heading)
        const view = document.querySelector(viewSelector)
        if (!(view instanceof HTMLElement)) throw new Error(`Missing ${viewSelector}`)
        return {
          background: getComputedStyle(view).backgroundColor,
          fontSize: headingStyle.fontSize,
          fontWeight: headingStyle.fontWeight,
          lineHeight: headingStyle.lineHeight,
        }
      }, entry.view))
    }
    expect(pageStyles).toEqual([pageStyles[0]!, pageStyles[0]!, pageStyles[0]!])
  }
})
