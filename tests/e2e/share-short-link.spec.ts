import fs from 'node:fs'
import path from 'node:path'
import { expect, test } from './fixtures'

const OWNER_TOKEN = 'mobile-auth-owner-fixture-token'

for (const appearance of ['light', 'dark', 'paper']) {
  for (const mobile of [false, true]) {
    test(`real short links preserve access and location in ${appearance} ${mobile ? 'mobile' : 'desktop'}`, async ({ page, browser, workspaceRoot }, testInfo) => {
      test.skip(process.env.FARMING_PLAYWRIGHT_AUTH !== '1', 'Requires isolated token authentication')
      test.setTimeout(90_000)
      await page.setViewportSize(mobile ? { width: 393, height: 852 } : { width: 1440, height: 900 })
      await page.goto(`/farming/?token=${OWNER_TOKEN}`)
      await expect(page.getByTestId('app-shell')).toBeVisible()
      await page.request.post('/farming/api/settings', { data: { appearance, language: 'en', instanceName: 'farming-e2e-host' } })
      await page.reload()
      await expect(page.locator('body')).toHaveAttribute('data-appearance', appearance)
      await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
      const responsePromise = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/api/share/qr-ticket'))
      if (mobile) {
        await page.getByTestId('code-mobile-more').click()
        await page.getByRole('menuitem', { name: 'Share current page' }).click()
      } else {
        await page.getByTestId('code-share-button').click()
      }
      const response = await responsePromise
      expect(response.status()).toBe(200)
      const ticket = await response.json() as { code: string; readOnlyUrl: string; longUrl: string }
      expect(new URL(ticket.readOnlyUrl).pathname).toMatch(/^\/farming\/s\/[\w-]{22}$/)
      expect(new URL(ticket.readOnlyUrl).search).toBe('')
      expect(ticket.longUrl).toBe(ticket.readOnlyUrl)
      const panel = page.getByTestId(mobile ? 'code-mobile-share-sheet' : 'code-share-popover')
      await expect(panel).toBeVisible()
      if (mobile) {
        await expect(panel.locator('.code-mobile-share-link').first()).toHaveText(ticket.readOnlyUrl)
        await page.getByTestId('code-mobile-share-copy-action').click()
      }
      await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(ticket.readOnlyUrl)
      await expect(panel.locator('.code-share-qr-svg')).toBeVisible()
      await page.screenshot({ path: testInfo.outputPath(`short-share-${appearance}-${mobile ? 'mobile' : 'desktop'}.png`) })
      const revoke = page.waitForResponse(r => r.request().method() === 'DELETE' && r.url().endsWith(ticket.code))
      await page.keyboard.press('Escape')
      await revoke
      await expect(panel).toHaveCount(0)
      const head = await page.request.head(ticket.readOnlyUrl)
      expect(head.status()).toBe(204)

      // Independent recipients can reuse a copied link after the panel revoked its QR.
      for (let index = 0; index < 2; index += 1) {
        const recipient = await browser.newContext()
        try {
          const guest = await recipient.newPage()
          await guest.goto(ticket.readOnlyUrl)
          await expect(guest.getByTestId('code-read-only-share-banner')).toBeVisible()
          expect(new URL(guest.url()).searchParams.has('token')).toBe(false)
          expect((await guest.request.post(new URL('/farming/api/settings', guest.url()).href, { data: { appearance: 'dark' } })).status()).toBe(403)
        } finally { await recipient.close() }
      }
      if (mobile) return

      // The direct file action exercises real target capture, copy, QR cleanup and redemption.
      const workspace = path.join(workspaceRoot, 'short-link-demo')
      fs.mkdirSync(workspace, { recursive: true })
      fs.writeFileSync(path.join(workspace, 'notes.txt'), Array.from({ length: 180 }, (_, i) => `line ${i + 1}`).join('\n'))
      const created = await page.request.post('/farming/api/control/agents', { data: { command: 'bash', workspace, agentRuntimeMode: 'terminal' } })
      expect(created.ok()).toBeTruthy()
      const project = page.getByTestId('code-project-group').filter({ hasText: 'short-link-demo' })
      const files = project.getByTestId('code-files-section')
      const toggle = files.locator('.code-files-title').first()
      await expect(toggle).toBeVisible()
      if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click()
      await files.locator('[data-file-path="notes.txt"]').click()
      await expect.poll(() => page.evaluate(() => window.__farmingFileEditorTest?.revealLine(120, 6))).toBe(true)
      await page.getByTestId('code-file-editor-share').click()
      await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).not.toBe(ticket.readOnlyUrl)
      const fileUrl = await page.evaluate(() => navigator.clipboard.readText())
      expect(new URL(fileUrl).pathname).toMatch(/^\/farming\/s\/[\w-]{22}$/)
      expect(fileUrl.length).toBe(ticket.readOnlyUrl.length)
      const recipient = await browser.newContext()
      try {
        await recipient.addInitScript(() => { window.__FARMING_E2E__ = true })
        const guest = await recipient.newPage()
        await guest.goto(fileUrl)
        await expect(guest.getByTestId('code-read-only-share-banner')).toBeVisible()
        await expect(guest.getByTestId('code-file-monaco')).toBeVisible()
        await expect.poll(() => guest.evaluate(() => window.__farmingFileEditorTest?.getPosition())).toEqual({ lineNumber: 120, column: 6 })
        await expect(guest.getByRole('button', { name: 'Save file', exact: true })).toHaveCount(0)
        await expect.poll(() => new URL(guest.url()).search).toBe('')
      } finally { await recipient.close() }
    })
  }
}
