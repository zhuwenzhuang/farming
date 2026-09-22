import { expect, openFarming, test } from './fixtures'

test('project path actions respect backend locality in every appearance', async ({ page, context, workspaceRoot }, testInfo) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  const response = await page.request.post('/farming/api/control/agents', {
    data: { command: 'bash', workspace: workspaceRoot },
  })
  expect(response.ok()).toBeTruthy()
  await openFarming(page)
  const project = page.getByTestId('code-project-group').filter({
    has: page.locator(`[data-testid="code-project-title"][data-project-id="${workspaceRoot}"]`),
  })
  const menu = page.getByTestId('code-project-context-menu')
  const openMenu = async () => {
    await project.getByTestId('code-project-title').hover()
    await project.getByTestId('code-project-actions').click()
    await expect(menu).toBeVisible()
  }
  for (const appearance of ['light', 'dark', 'paper']) {
    await page.locator('body').evaluate((body, value) => { body.dataset.appearance = value }, appearance)
    await openMenu()
    await expect(menu.getByRole('menuitem', { name: 'Reveal in Finder' })).toHaveCount(0)
    await expect(menu.getByRole('menuitem', { name: 'Archive all chats', exact: true })).toBeVisible()
    await menu.screenshot({ path: testInfo.outputPath(`project-menu-${appearance}.png`) })
    await menu.getByRole('menuitem', { name: 'Copy path', exact: true }).click()
    await expect(menu).toBeHidden()
    await expect(page.getByTestId('code-copy-toast')).toHaveText('Copied working directory')
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(workspaceRoot)
  }
  for (const scenario of [
    { kind: 'remote', platform: 'darwin', available: false },
    { kind: 'local', platform: 'linux', available: false },
    { kind: 'local', platform: 'darwin', available: true },
    { kind: 'failed', platform: 'darwin', available: false },
  ]) {
    // Install the connection-owner boundary only; no actual desktop operations run.
    await page.evaluate(({ kind, platform }) => {
      Reflect.set(window, 'farmingDesktop', {
        getState: async () => {
          if (kind === 'failed') throw new Error('Connection state unavailable')
          return {
            activeBackendId: 'fixture',
            profiles: [{ id: 'fixture', kind }],
            connections: [{ backendId: 'fixture', status: 'ready', server: { platform } }],
          }
        },
        onStateChanged: () => () => {},
        showNotification: async () => {},
      })
    }, scenario)
    await openMenu()
    if (scenario.available) await expect(menu.getByRole('menuitem', { name: 'Reveal in Finder' })).toBeVisible()
    else await expect(menu.getByRole('menuitem', { name: 'Reveal in Finder' })).toHaveCount(0)
    await expect(menu.getByRole('menuitem', { name: 'Copy path', exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
  }
})
