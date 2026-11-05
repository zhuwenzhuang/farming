import fs from 'node:fs'
import path from 'node:path'
import { devices, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { openFileSearch, expect, test } from './fixtures'

const OWNER_TOKEN = 'mobile-auth-owner-fixture-token'

type ShareTicket = {
  code: string
  shortUrl: string
  longUrl: string
  shortUrlAccessMode: 'owner' | 'read-only'
  longUrlAccessMode: 'read-only'
  fullAccessUrl?: string
  tokenLabel?: string
}

async function openAuthenticatedOwner(page: Page) {
  await page.goto(`/farming/?token=${encodeURIComponent(OWNER_TOKEN)}`, { waitUntil: 'domcontentloaded' })
  await expect(page.getByTestId('app-shell')).toBeVisible()
  await expect(page.getByTestId('code-read-only-share-banner')).toHaveCount(0)
}

async function createTerminalAgent(page: Page, workspace: string) {
  const response = await page.request.post('/farming/api/control/agents', {
    data: { command: 'bash', workspace, agentRuntimeMode: 'terminal' },
  })
  expect(response.ok()).toBeTruthy()
  const body = await response.json() as { agentId?: string }
  expect(body.agentId).toBeTruthy()
  return body.agentId as string
}

async function openMobileShare(page: Page): Promise<ShareTicket> {
  await page.getByTestId('code-mobile-more').click()
  const responsePromise = page.waitForResponse(response => (
    response.request().method() === 'POST'
    && response.url().includes('/api/share/qr-ticket')
  ))
  await page.getByRole('menuitem', { name: /Share current page|分享当前页面/ }).click()
  const response = await responsePromise
  expect(response.status()).toBe(200)
  await expect(page.getByTestId('code-mobile-share-sheet')).toBeVisible()
  return response.json() as Promise<ShareTicket>
}

async function mobileContext(browser: Browser, device: 'iphone' | 'android'): Promise<BrowserContext> {
  return browser.newContext(device === 'iphone' ? devices['iPhone 14 Pro'] : devices['Pixel 7'])
}

async function reopenMobileNavigationFromFile(page: Page) {
  const back = page.getByTestId('code-mobile-back')
  if (await back.isVisible()) await back.click()
  await page.getByTestId('code-mobile-menu').click()
  await expect(page.getByTestId('code-mobile-sidebar-backdrop')).toBeVisible()
}

test('retains explicit tokens and QR desktop startup without login cookies', async ({ page, browser }, testInfo) => {
  test.skip(process.env.FARMING_PLAYWRIGHT_AUTH !== '1', 'Requires isolated token authentication')
  await openAuthenticatedOwner(page)
  expect(new URL(page.url()).searchParams.get('token')).toBe(OWNER_TOKEN)
  await page.context().clearCookies()
  const reopenedOwner = await page.reload({ waitUntil: 'domcontentloaded' })
  expect(reopenedOwner?.ok()).toBeTruthy()
  await expect(page.getByTestId('app-shell')).toBeVisible()
  expect(new URL(page.url()).searchParams.get('token')).toBe(OWNER_TOKEN)

  const share = await page.request.post('/farming/api/share/qr-ticket', { data: {} })
  expect(share.ok()).toBeTruthy()
  const { readOnlyUrl, shortUrl, code } = await share.json() as { readOnlyUrl: string; shortUrl: string; code: string }
  const recipient = await mobileContext(browser, testInfo.project.name.endsWith('webkit') ? 'iphone' : 'android')
  try {
    const guest = await recipient.newPage()
    await guest.goto(shortUrl)
    await expect(guest.getByTestId('app-shell')).toBeVisible()
    expect(new URL(guest.url()).searchParams.get('token')).toBe(OWNER_TOKEN)
    const manifestHref = await guest.locator('link[rel="manifest"]').getAttribute('href')
    expect(manifestHref).toBeTruthy()
    const manifestUrl = new URL(manifestHref!, guest.url())
    const manifestResponse = await guest.request.get(manifestUrl.toString())
    expect(manifestResponse.ok()).toBeTruthy()
    const manifest = await manifestResponse.json() as { start_url: string }
    const desktopUrl = new URL(manifest.start_url, manifestUrl)
    expect(desktopUrl.searchParams.get('token')).toBe(OWNER_TOKEN)
    await recipient.clearCookies()
    expect((await guest.goto(desktopUrl.toString()))?.ok()).toBeTruthy()
    await expect(guest.getByTestId('app-shell')).toBeVisible()
    await expect(guest.getByTestId('code-read-only-share-banner')).toHaveCount(0)
    expect(new URL(guest.url()).searchParams.get('token')).toBe(OWNER_TOKEN)
    expect((await guest.goto(shortUrl))?.status()).toBe(410)
    await recipient.clearCookies()
    await guest.goto(readOnlyUrl)
    await expect(guest.getByTestId('code-read-only-share-banner')).toBeVisible()
    const cookie = (await recipient.cookies()).find(item => item.name.startsWith('farming_token'))
    expect(cookie).toBeTruthy()
    const token = decodeURIComponent(cookie!.value)
    expect(new URL(guest.url()).searchParams.get('token')).toBe(token)
    const readOnlyManifestHref = await guest.locator('link[rel="manifest"]').getAttribute('href')
    const readOnlyManifestUrl = new URL(readOnlyManifestHref!, guest.url())
    const readOnlyManifest = await (await guest.request.get(readOnlyManifestUrl.toString())).json() as { start_url: string }
    expect(new URL(readOnlyManifest.start_url, readOnlyManifestUrl).searchParams.get('token')).toBe(token)
    const queryUrl = new URL('/farming/', guest.url())
    queryUrl.searchParams.set('token', token)
    await recipient.clearCookies()
    const opened = await guest.goto(queryUrl.toString())
    expect(opened?.ok()).toBeTruthy()
    await expect(guest.getByTestId('code-read-only-share-banner')).toBeVisible()
    expect(new URL(guest.url()).searchParams.get('token')).toBe(token)
    await recipient.clearCookies()
    expect((await guest.reload())?.ok()).toBeTruthy()
    await expect(guest.getByTestId('code-read-only-share-banner')).toBeVisible()
    expect(new URL(guest.url()).searchParams.get('token')).toBe(token)
    const denied = await guest.request.post('/farming/api/settings', { data: { appearance: 'dark' } })
    expect(denied.status()).toBe(403)
    const delegatedResponse = await guest.request.post('/farming/api/share/qr-ticket', { data: {} })
    expect(delegatedResponse.ok()).toBeTruthy()
    const delegated = await delegatedResponse.json() as { shortUrl: string }
    await recipient.clearCookies()
    await guest.goto(delegated.shortUrl)
    await expect(guest.getByTestId('code-read-only-share-banner')).toBeVisible()
    expect(new URL(guest.url()).searchParams.get('token')).toMatch(/^farming-ro-v1\./)
  } finally {
    await recipient.close()
    await page.request.delete(`/farming/api/share/qr-ticket/${encodeURIComponent(code)}`)
  }
})

test('retains credentials through Code CRT and recovery navigation', async ({ page }) => {
  test.skip(process.env.FARMING_PLAYWRIGHT_AUTH !== '1', 'Requires isolated token authentication')
  await openAuthenticatedOwner(page)
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.getByTestId('code-sidebar-options').click()
  await page.getByTestId('code-settings-skin-crt').click()
  await expect(page.locator('body')).toHaveAttribute('id', 'farming-crt')
  expect(new URL(page.url()).searchParams.get('token')).toBe(OWNER_TOKEN)
  const manifestHref = await page.locator('link[rel="manifest"]').getAttribute('href')
  expect(new URL(manifestHref!, page.url()).searchParams.get('token')).toBe(OWNER_TOKEN)
  await page.getByRole('button', { name: '[S] SETTINGS', exact: true }).click()
  await page.locator('#theme-list').getByText('Farming Code', { exact: true }).click()
  await expect(page.getByTestId('app-shell')).toBeVisible()
  expect(new URL(page.url()).searchParams.get('token')).toBe(OWNER_TOKEN)

  // Legacy shortcuts with a live cookie regain an explicit startup credential.
  await page.goto('/farming/')
  await expect(page.getByTestId('app-shell')).toBeVisible()
  expect(new URL(page.url()).searchParams.get('token')).toBe(OWNER_TOKEN)
  for (const alias of ['/farming/index.html', '/farming/crt/index.html']) {
    await page.context().clearCookies()
    const response = await page.goto(`${alias}?token=${OWNER_TOKEN}`)
    expect(response?.ok()).toBeTruthy()
    expect(new URL(page.url()).pathname).toBe(alias.replace('index.html', ''))
    expect(new URL(page.url()).searchParams.get('token')).toBe(OWNER_TOKEN)
    const href = await page.locator('link[rel="manifest"]').getAttribute('href')
    expect(new URL(href!, page.url()).searchParams.get('token')).toBe(OWNER_TOKEN)
  }
  await page.goto(`/farming/error-preview?token=${OWNER_TOKEN}`)
  await page.context().clearCookies()
  await page.getByTestId('app-error-fallback').getByRole('button').click()
  await expect(page.getByTestId('app-shell')).toBeVisible()
  expect(new URL(page.url()).searchParams.get('token')).toBe(OWNER_TOKEN)
  const invalid = await page.goto('/farming/?token=invalid')
  expect(invalid?.status()).toBe(401)
  await expect(page.getByTestId('app-shell')).toHaveCount(0)
})

test('enforces Owner and read-only authority across real mobile authentication', {
  tag: ['@critical-behavior', '@behavior-CODE-MOBILE-SHARE-AUTHORITY'],
}, async ({ browser, page, workspaceRoot }, testInfo) => {
  test.setTimeout(150_000)
  test.skip(process.env.FARMING_PLAYWRIGHT_AUTH !== '1', 'Requires the isolated auth-enabled Playwright server')
  test.skip(!testInfo.project.name.startsWith('mobile-auth-'), 'Runs only in an authenticated mobile project')

  const workspace = path.join(workspaceRoot, 'mobile-auth-readonly')
  const externalWorkspace = path.join(workspaceRoot, 'mobile-auth-unmounted-external')
  const externalFile = path.join(externalWorkspace, 'external-readonly.txt')
  fs.mkdirSync(workspace, { recursive: true })
  fs.mkdirSync(path.join(workspace, 'site'), { recursive: true })
  fs.mkdirSync(externalWorkspace, { recursive: true })
  fs.writeFileSync(path.join(workspace, 'README.md'), '# Mobile auth authority\n')
  fs.writeFileSync(path.join(workspace, 'main.ts'), 'export const mobileAuthority = true\n')
  fs.writeFileSync(path.join(workspace, 'site', 'index.html'), '<h1>Read-only scoped preview</h1>\n')
  fs.writeFileSync(externalFile, 'read-only external file\n')
  await openAuthenticatedOwner(page)
  // English action labels are this scenario's explicit authenticated fixture.
  // The common fixture resets settings before the owner URL redeems its token.
  const language = await page.request.post('/farming/api/settings', { data: { language: 'en' } })
  expect(language.ok()).toBeTruthy()
  const agentId = await createTerminalAgent(page, workspace)
  await page.goto(`/farming/?${new URLSearchParams({ token: OWNER_TOKEN, agent: agentId })}`)
  await expect(page.locator(`[data-testid="code-terminal-pane"][data-agent-id="${agentId}"]`)).toBeVisible({ timeout: 30_000 })

  const ownerTicket = await openMobileShare(page)
  expect(ownerTicket.shortUrlAccessMode).toBe('owner')
  expect(ownerTicket.longUrlAccessMode).toBe('read-only')
  expect(ownerTicket.fullAccessUrl).toBeTruthy()
  expect(ownerTicket.tokenLabel).toBeTruthy()

  const fullControl = await mobileContext(browser, testInfo.project.name.endsWith('webkit') ? 'iphone' : 'android')
  const spentTicket = await mobileContext(browser, testInfo.project.name.endsWith('webkit') ? 'iphone' : 'android')
  const readOnly = await mobileContext(browser, testInfo.project.name.endsWith('webkit') ? 'iphone' : 'android')
  const tampered = await mobileContext(browser, testInfo.project.name.endsWith('webkit') ? 'iphone' : 'android')
  let scenarioFailed = false
  try {
    const fullPage = await fullControl.newPage()
    const fullResponse = await fullPage.goto(ownerTicket.shortUrl, { waitUntil: 'domcontentloaded' })
    expect(fullResponse?.ok()).toBeTruthy()
    await expect(fullPage.getByTestId('app-shell')).toBeVisible()
    await expect(fullPage.getByTestId('code-read-only-share-banner')).toHaveCount(0)
    expect(new URL(fullPage.url()).searchParams.get('token')).toBe(OWNER_TOKEN)
    const ownerMutation = await fullPage.request.post(
      new URL('/farming/api/settings', fullPage.url()).toString(),
      { data: { appearance: 'paper' } },
    )
    expect(ownerMutation.ok()).toBeTruthy()

    const spentPage = await spentTicket.newPage()
    const spentResponse = await spentPage.goto(ownerTicket.shortUrl, { waitUntil: 'domcontentloaded' })
    expect(spentResponse?.status()).toBe(410)
    await expect(spentPage.getByText('Farming share link expired.', { exact: true })).toBeVisible()

    const guestPage = await readOnly.newPage()
    const mountFileRequests: string[] = []
    const languageServerRequests: string[] = []
    guestPage.on('request', request => {
      if (new URL(request.url()).pathname.endsWith('/api/projects/mount-file')) {
        mountFileRequests.push(request.url())
      }
    })
    guestPage.on('websocket', socket => {
      socket.on('framesent', event => {
        if (typeof event.payload !== 'string') return
        try {
          const message = JSON.parse(event.payload) as { type?: string }
          if (message.type === 'language-server-request') languageServerRequests.push(event.payload)
        } catch {
          // Ignore native terminal frames and non-JSON protocol payloads.
        }
      })
    })
    const externalShareResponse = await page.request.post('/farming/api/share/qr-ticket', {
      data: { target: { kind: 'file', absolutePath: externalFile } },
    })
    expect(externalShareResponse.ok()).toBeTruthy()
    const externalShare = await externalShareResponse.json() as { readOnlyUrl: string }
    const guestUrl = new URL(externalShare.readOnlyUrl)
    const guestResponse = await guestPage.goto(guestUrl.toString(), { waitUntil: 'domcontentloaded' })
    expect(guestResponse?.ok()).toBeTruthy()
    await expect(guestPage.getByTestId('app-shell')).toBeVisible()
    await expect(guestPage.getByTestId('code-read-only-share-banner')).toBeVisible()
    await expect.poll(() => new URL(guestPage.url()).searchParams.has('ftarget'), { timeout: 10_000 }).toBe(false)
    await expect(guestPage.getByRole('tab', { name: 'external-readonly.txt' })).toHaveCount(0)
    await expect(guestPage.getByTestId('code-copy-toast')).toContainText(/Unable to locate shared path|无法定位分享路径/)
    expect(mountFileRequests).toHaveLength(0)
    expect(new URL(guestPage.url()).searchParams.get('token')).toMatch(/^farming-ro-v1\./)
    await guestPage.reload({ waitUntil: 'domcontentloaded' })
    await expect(guestPage.getByTestId('code-read-only-share-banner')).toBeVisible()

    const rejectedMutation = await guestPage.request.post(
      new URL('/farming/api/settings', guestPage.url()).toString(),
      { data: { appearance: 'dark' } },
    )
    expect(rejectedMutation.status()).toBe(403)
    expect(await rejectedMutation.json()).toEqual({ error: 'This Farming share is read-only.' })

    await guestPage.getByTestId('code-mobile-menu').click()
    await guestPage.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
    const marker = 'READ_ONLY_MUTATION_MUST_NOT_RUN'
    const input = guestPage.getByTestId('code-composer-input')
    await input.fill(`printf '${marker}\\n'`)
    await guestPage.getByTestId('code-composer-send').click()
    await expect(guestPage.getByTestId('app-toast')).toContainText('This Farming share is read-only.')
    await guestPage.waitForTimeout(500)
    expect(await guestPage.evaluate(id => (
      window.__farmingTerminalTest?.getRows(id, 100).join('\n') ?? ''
    ), agentId)).not.toContain(marker)

    await guestPage.getByTestId('code-mobile-menu').click()
    const guestProject = guestPage.getByTestId('code-project-group').filter({ hasText: 'mobile-auth-readonly' })
    const guestFiles = guestProject.getByTestId('code-files-section')
    const filesToggle = guestFiles.getByRole('button', { name: /^Files$/ })
    if (await filesToggle.getAttribute('aria-expanded') === 'false') await filesToggle.click()
    const readmeRow = guestFiles.locator('[data-testid="code-file-row"][data-file-path="README.md"]')
    await expect(readmeRow).toBeVisible()
    await readmeRow.getByRole('button', { name: 'File actions for README.md' }).click()
    const fileMenu = guestPage.getByTestId('code-file-context-menu')
    await expect(fileMenu).toBeVisible()
    await expect(fileMenu.getByRole('menuitem', { name: 'New File' })).toHaveCount(0)
    await expect(fileMenu.getByRole('menuitem', { name: 'New Folder' })).toHaveCount(0)
    await expect(fileMenu.getByRole('menuitem', { name: 'Rename' })).toHaveCount(0)
    await expect(fileMenu.getByRole('menuitem', { name: 'Delete' })).toHaveCount(0)
    await openFileSearch(guestFiles)
    await guestFiles.getByPlaceholder('Search or path:line').click()
    await expect(fileMenu).toHaveCount(0)
    await readmeRow.click()
    await guestPage.getByRole('button', { name: 'Show Markdown source' }).click()
    const readOnlySource = guestPage.getByTestId('code-file-touch-source').getByRole('textbox')
    await expect(readOnlySource).toBeVisible()
    await expect(readOnlySource).toHaveValue('# Mobile auth authority\n')
    await expect(readOnlySource).toHaveAttribute('readonly', '')
    await expect(readOnlySource).not.toBeEditable()
    await readOnlySource.focus()
    await guestPage.keyboard.type('READ_ONLY_FILE_MUTATION_MUST_NOT_RUN')
    await expect(readOnlySource).toHaveValue('# Mobile auth authority\n')
    await expect(guestPage.getByRole('button', { name: 'Save file' })).toHaveCount(0)

    await reopenMobileNavigationFromFile(guestPage)
    const sourceRow = guestFiles.locator('[data-testid="code-file-row"][data-file-path="main.ts"]')
    await expect(sourceRow).toBeVisible()
    await sourceRow.click()
    await expect(guestPage.locator('.code-file-editor-tab[title="main.ts"]')).toHaveAttribute('aria-selected', 'true')
    await expect(readOnlySource).toBeVisible()
    await expect(readOnlySource).toHaveValue('export const mobileAuthority = true\n')
    await expect(readOnlySource).toHaveAttribute('readonly', '')
    await expect(readOnlySource).not.toBeEditable()
    await expect(guestPage.getByRole('button', { name: 'Save file' })).toHaveCount(0)
    await guestPage.waitForTimeout(500)
    expect(languageServerRequests).toHaveLength(0)

    await reopenMobileNavigationFromFile(guestPage)
    const siteRow = guestFiles.locator('[data-testid="code-file-row"][data-file-path="site"]')
    await expect(siteRow).toBeVisible()
    await siteRow.click()
    const previewRow = guestFiles.locator('[data-testid="code-file-row"][data-file-path="site/index.html"]')
    await expect(previewRow).toBeVisible()
    await previewRow.click()
    await expect(guestPage.getByTestId('code-file-html-preview')).toBeVisible()
    await expect(
      guestPage.frameLocator('[data-testid="code-file-html-preview"]').locator('h1'),
    ).toHaveText('Read-only scoped preview')

    await reopenMobileNavigationFromFile(guestPage)
    await readmeRow.getByRole('button', { name: 'File actions for README.md' }).click()
    await expect(fileMenu).toBeVisible()
    await guestPage.evaluate(() => {
      const mutationLabels = new Set(['New File', 'New Folder', 'Rename', 'Delete'])
      const detectOwnerMutationUi = () => {
        const saveVisible = Boolean(document.querySelector(
          'button[aria-label="Save file"], button[aria-label="Overwrite changed file"]',
        ))
        const menuMutationVisible = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'))
          .some(element => mutationLabels.has(element.textContent?.trim() || ''))
        if (saveVisible || menuMutationVisible) document.body.dataset.readOnlyMutationExposed = 'true'
      }
      document.body.dataset.readOnlyMutationExposed = 'false'
      new MutationObserver(detectOwnerMutationUi).observe(document.documentElement, {
        attributes: true,
        childList: true,
        subtree: true,
      })
      detectOwnerMutationUi()
    })
    const closeSockets = await page.request.post('/farming/api/control/e2e/close-websockets')
    expect(closeSockets.ok()).toBeTruthy()
    await expect(guestPage.getByTestId('connection-status')).toBeVisible({ timeout: 8_000 })
    await expect(guestPage.getByTestId('connection-status')).toHaveCount(0, { timeout: 12_000 })
    await expect(guestPage.getByTestId('code-read-only-share-banner')).toBeVisible()
    expect(await guestPage.locator('body').getAttribute('data-read-only-mutation-exposed')).toBe('false')
    await guestPage.keyboard.press('Escape')
    // Close the nested search layer before dismissing its navigation modal.
    await guestFiles.getByRole('button', { name: 'Close file search', exact: true }).click()
    const sidebarBackdrop = guestPage.getByTestId('code-mobile-sidebar-backdrop')
    if (await sidebarBackdrop.isVisible()) {
      // The modal scope isolates background siblings. A real outside touch
      // targets their ancestor and is dismissed by the shared interaction layer.
      const backdropBox = await sidebarBackdrop.boundingBox()
      expect(backdropBox).not.toBeNull()
      await guestPage.touchscreen.tap(backdropBox!.x + 360, backdropBox!.y + 400)
      await expect(sidebarBackdrop).toHaveCount(0)
    }

    const delegatedTicket = await openMobileShare(guestPage)
    expect(delegatedTicket.shortUrlAccessMode).toBe('read-only')
    expect(delegatedTicket.longUrlAccessMode).toBe('read-only')
    expect(delegatedTicket.fullAccessUrl).toBeUndefined()
    expect(delegatedTicket.tokenLabel).toBe('')
    await expect(guestPage.getByTestId('code-mobile-share-full-control-action')).toHaveCount(0)
    await guestPage.keyboard.press('Escape')
    await expect(guestPage.getByTestId('code-mobile-share-sheet')).toHaveCount(0)

    const tamperedUrl = new URL(ownerTicket.longUrl)
    tamperedUrl.pathname += 'x'
    const tamperedPage = await tampered.newPage()
    const tamperedResponse = await tamperedPage.goto(tamperedUrl.toString(), { waitUntil: 'domcontentloaded' })
    expect(tamperedResponse?.status()).toBe(410)
    await expect(tamperedPage.getByText(/share link expired or unavailable/)).toBeVisible()
  } catch (error) {
    scenarioFailed = true
    throw error
  } finally {
    const cleanup = await Promise.allSettled([
      fullControl.close(),
      spentTicket.close(),
      readOnly.close(),
      tampered.close(),
    ])
    await page.keyboard.press('Escape').catch(() => {})
    const failures = cleanup.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (failures.length > 0) {
      await testInfo.attach('Mobile browser context cleanup failure', {
        body: failures.map(String).join('\n'), contentType: 'text/plain',
      })
      if (!scenarioFailed) throw new AggregateError(failures, 'Mobile browser context cleanup failed')
    }
  }
})
