import fs from 'node:fs'
import path from 'node:path'
import { expect, openFarming, test } from './fixtures'

for (const appearance of ['light', 'dark', 'paper'] as const) {
  test(`animates only first live progress arrivals in ${appearance}`, async ({ page, workspaceRoot }) => {
    const workspace = path.join(workspaceRoot, `progress-arrival-${appearance}`)
    fs.mkdirSync(workspace, { recursive: true })
    const gate = path.join(workspace, '.progress-arrival-stage')
    const agentIds: string[] = []
    try {
      for (let i = 0; i < 2; i += 1) {
        const response = await page.request.post('/farming/api/control/agents', {
          data: { command: 'codex', workspace, agentRuntimeMode: 'chat' },
        })
        expect(response.ok()).toBeTruthy()
        agentIds.push((await response.json() as { agentId: string }).agentId)
      }
      await openFarming(page)
      const row = (id: string) => page.locator(`[data-testid="code-agent-row"][data-agent-id="${id}"]`)
      await row(agentIds[0]).click()
      await expect(page.locator('.code-agent-transcript-blank')).toHaveText('No conversation yet.')
      await page.emulateMedia({ reducedMotion: 'no-preference' })
      await page.evaluate(value => {
        document.body.dataset.appearance = value
        const original = Element.prototype.animate
        const calls: { id: string; frames: Keyframe[]; duration: number | string | undefined }[] = []
        Object.assign(window, { progressArrivalCalls: calls })
        Element.prototype.animate = function (frames, options) {
          if (this.hasAttribute('data-progress-id')) {
            calls.push({ id: this.getAttribute('data-progress-id')!, frames: frames as Keyframe[],
              duration: typeof options === 'number' ? options : options?.duration })
          }
          return original.call(this, frames, options)
        }
      }, appearance)
      const calls = () => page.evaluate(() => (window as typeof window & {
        progressArrivalCalls: { id: string; frames: Keyframe[]; duration: number }[]
      }).progressArrivalCalls)
      await page.getByTestId('code-acp-composer-input').fill('progress arrival motion')
      await page.getByTestId('code-acp-composer-send').click()
      await expect(page.getByTestId('code-acp-composer-input')).toHaveValue('')
      await expect(page.getByTestId('code-agent-transcript-live-activity')).toBeVisible()
      fs.writeFileSync(gate, '1')
      const progress = page.getByTestId('code-acp-progress-update')
      await expect(progress).toContainText('Arrival one.')
      await expect.poll(async () => (await calls()).length).toBe(1)
      expect((await calls())[0]).toMatchObject({ duration: 180, frames: [{ opacity: 0.65 }, { opacity: 1 }] })
      fs.writeFileSync(gate, '2')
      await expect(progress).toContainText('Streaming extension.')
      expect(await calls()).toHaveLength(1)
      const summary = page.getByTestId('code-agent-transcript-process-summary')
      await summary.click()
      await summary.click()
      await expect(progress).toContainText('Streaming extension.')
      expect(await calls()).toHaveLength(1)
      await row(agentIds[1]).click()
      fs.writeFileSync(gate, '3')
      await expect.poll(async () => {
        const response = await page.request.get(`/farming/api/agents/${agentIds[0]}/acp-transcript`)
        return response.text()
      }).toContain('Arrival stage 3.')
      await row(agentIds[0]).click()
      await expect(progress.filter({ hasText: 'Arrival stage 3.' })).toBeVisible()
      expect(await calls()).toHaveLength(1)
      await page.emulateMedia({ reducedMotion: 'reduce' })
      fs.writeFileSync(gate, '4')
      await expect(progress.filter({ hasText: 'Arrival stage 4.' })).toBeVisible()
      expect(await calls()).toHaveLength(1)
      await page.emulateMedia({ reducedMotion: 'no-preference' })
      if (await summary.getAttribute('aria-expanded') !== 'true') await summary.click()
      const scroll = page.getByTestId('code-agent-transcript-scroll')
      await scroll.hover()
      await page.mouse.wheel(0, -2000)
      await expect(page.getByTestId('code-agent-transcript-jump-bottom')).toBeVisible()
      fs.writeFileSync(gate, '5')
      await expect(progress.filter({ hasText: 'Arrival stage 5.' })).toHaveCount(1)
      expect(await calls()).toHaveLength(1)
      await page.getByTestId('code-agent-transcript-jump-bottom').click()
      await expect(progress.filter({ hasText: 'Arrival stage 5.' })).toBeVisible()
      await page.screenshot({ path: test.info().outputPath(`progress-arrival-${appearance}.png`) })
      fs.writeFileSync(gate, '6')
      await expect(progress.filter({ hasText: 'Arrival stage 6.' })).toBeVisible()
      await expect.poll(async () => (await calls()).length).toBe(2)
      await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
        document.dispatchEvent(new Event('visibilitychange'))
      })
      fs.writeFileSync(gate, '7')
      await expect.poll(async () => (await page.request.get(`/farming/api/agents/${agentIds[0]}/acp-transcript`)).text())
        .toContain('Arrival stage 7.')
      await page.evaluate(() => {
        delete (document as Partial<Document>).visibilityState
        delete (document as Partial<Document>).hidden
        document.dispatchEvent(new Event('visibilitychange'))
      })
      await expect(progress.filter({ hasText: 'Arrival stage 7.' })).toBeVisible()
      expect(await calls()).toHaveLength(2)
      await page.evaluate(() => window.dispatchEvent(new Event('farming:backend-disconnected')))
      fs.writeFileSync(gate, '8')
      await expect.poll(async () => (await page.request.get(`/farming/api/agents/${agentIds[0]}/acp-transcript`)).text())
        .toContain('Arrival stage 8.')
      await page.evaluate(() => window.dispatchEvent(new Event('farming:backend-connected')))
      await expect(progress.filter({ hasText: 'Arrival stage 8.' })).toBeVisible()
      expect(await calls()).toHaveLength(2)
      fs.writeFileSync(gate, '9')
      await expect(page.locator('.code-agent-transcript-assistant').last()).toContainText('Arrival stage 9.')
      await expect(page.getByTestId('code-agent-transcript-live-activity')).toHaveCount(0)
      expect(await calls()).toHaveLength(2)
      await page.reload()
      await expect(page.locator('.code-agent-transcript-assistant').last()).toContainText('Arrival stage 9.')
      await expect(page.locator('.code-acp-progress-update.live-fill')).toHaveCount(0)
    } finally {
      fs.writeFileSync(gate, '9')
      for (const agentId of agentIds) await page.request.delete(`/farming/api/control/agents/${agentId}?recordHistory=0`).catch(() => {})
      fs.rmSync(gate, { force: true })
    }
  })
}
