import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import type { Page } from '@playwright/test'
import { expect, openFarming, test } from '../fixtures'

const workspace = path.join(process.cwd(), '.tmp', 'real-browser-agent-use')
const completionAnchor = 'REAL_BROWSER_AGENT_OK'
let targetServer: http.Server
let targetUrl = ''

type BrowserResource = {
  id: string
  ownerAgentId?: string
  status?: string
  url?: string
}

async function browserResources(page: Page) {
  const response = await page.request.get('/farming/api/browsers')
  expect(response.ok()).toBeTruthy()
  const body = await response.json() as { resources?: BrowserResource[] }
  return body.resources ?? []
}

test.describe('real low-cost Agent uses Farming Browser', () => {
  test.setTimeout(8 * 60_000)

  test.beforeAll(async () => {
    if (process.env.FARMING_REAL_BROWSER_AGENT_USE !== '1') {
      throw new Error('Set FARMING_REAL_BROWSER_AGENT_USE=1 to run this real-model case')
    }
    if (process.env.FARMING_E2E_REAL_CODEX !== '1') {
      throw new Error('This case must run with the real Codex CLI')
    }
    fs.rmSync(workspace, { recursive: true, force: true })
    fs.mkdirSync(workspace, { recursive: true })
    fs.writeFileSync(path.join(workspace, 'README.md'), '# Real Browser Agent use\n')
    targetServer = http.createServer((_request, response) => {
      response.setHeader('content-type', 'text/html; charset=utf-8')
      response.end(`<!doctype html>
        <meta charset="utf-8">
        <title>Browser Interaction Lab</title>
        <h1>Browser Interaction Lab</h1>
        <p>The real Agent must inspect this rendered page.</p>`)
    })
    await new Promise<void>(resolve => targetServer.listen(0, '127.0.0.1', resolve))
    targetUrl = `http://127.0.0.1:${(targetServer.address() as AddressInfo).port}/`
  })

  test.afterAll(async () => {
    await new Promise<void>(resolve => targetServer.close(() => resolve()))
    fs.rmSync(workspace, { recursive: true, force: true })
  })

  test('discovers Browser, asks once per site, leaves a visible preview, and completes', async ({
    page,
  }, testInfo) => {
    const catalogResponse = await page.request.get('/farming/api/codex/models')
    expect(catalogResponse.ok()).toBeTruthy()
    const catalog = await catalogResponse.json() as {
      catalog?: Array<{ value: string, reasoningLevels?: Array<{ value: string }> }>
    }
    const model = catalog.catalog?.find(item => item.value === 'gpt-5.4-mini')
    expect(model, 'The reviewed low-cost model must exist').toBeTruthy()
    const effort = model?.reasoningLevels?.some(level => level.value === 'medium') ? 'medium' : 'low'

    const settingsResponse = await page.request.post('/farming/api/settings', {
      data: {
        browserExtensionEnabled: true,
        codexModel: 'gpt-5.4-mini',
        codexReasoningEffort: effort,
        codexModelPreset: `gpt-5.4-mini:${effort}`,
        agentLaunchProfiles: {
          codex: {
            approvalMode: 'approve',
            model: 'gpt-5.4-mini',
            reasoningEffort: effort,
            serviceTier: 'default',
            modelPreset: `gpt-5.4-mini:${effort}`,
          },
        },
      },
    })
    expect(settingsResponse.ok()).toBeTruthy()

    await openFarming(page)
    const createResponse = await page.request.post('/farming/api/control/agents', {
      data: { command: 'codex', workspace, agentRuntimeMode: 'chat' },
    })
    const created = await createResponse.json() as { agentId?: string, error?: string }
    expect(createResponse.ok(), created.error || 'Failed to create real Codex Agent').toBeTruthy()
    const agentId = created.agentId as string
    expect(agentId).toBeTruthy()

    const agentRow = page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
    await expect(agentRow).toBeVisible({ timeout: 90_000 })
    await agentRow.click()
    const composer = page.locator(
      '[data-testid="code-composer-input"]:visible, [data-testid="code-acp-composer-input"]:visible',
    )
    await expect(composer).toBeEnabled({ timeout: 90_000 })
    await composer.fill([
      'Use only the Farming Browser tools for this task; do not use shell, curl, or another browser.',
      `Open ${targetUrl}.`,
      'Inspect the rendered page with Browser tools and report its document title and main heading.',
      'Leave the Browser open so the human can watch the same page.',
      `Finish with the exact marker ${completionAnchor}. Do not modify files.`,
    ].join(' '))
    await page.locator(
      '[data-testid="code-composer-send"]:visible, [data-testid="code-acp-composer-send"]:visible',
    ).click()

    const answer = page.locator('.code-agent-transcript-assistant.code-markdown-preview')
      .filter({ hasText: completionAnchor })
      .last()
    const approvalScreenshots: string[] = []
    const startedAt = Date.now()
    while (Date.now() - startedAt < 6 * 60_000) {
      if (await answer.isVisible().catch(() => false)) break
      const elicitation = page.getByTestId('code-acp-elicitation')
      if (
        await elicitation.isVisible().catch(() => false)
        && /farming-browser/i.test(await elicitation.innerText())
      ) {
        const scope = elicitation.getByRole('combobox', { name: 'Approval scope' })
        const options = await scope.locator('option').evaluateAll(items => items.map(item => ({
          value: (item as HTMLOptionElement).value,
          label: item.textContent?.trim() || '',
        })))
        const selected = options.find(option => /session/i.test(option.label)) || options[0]
        expect(selected, 'Browser approval must expose a Session-capable choice').toBeTruthy()
        await scope.selectOption(selected!.value)
        const screenshotPath = testInfo.outputPath(`browser-approval-${approvalScreenshots.length + 1}.png`)
        await page.screenshot({ path: screenshotPath, fullPage: true, animations: 'disabled' })
        approvalScreenshots.push(screenshotPath)
        await elicitation.getByRole('button', { name: 'Submit' }).click()
        await page.waitForTimeout(500)
        continue
      }
      const permission = page.getByTestId('code-acp-permission-request')
      if (await permission.isVisible().catch(() => false)) {
        const scope = permission.getByRole('combobox', { name: 'Permission scope' })
        if (await scope.isVisible().catch(() => false)) {
          const options = await scope.locator('option').evaluateAll(items => items.map(item => ({
            value: (item as HTMLOptionElement).value,
            label: item.textContent?.trim() || '',
          })))
          const selected = options.find(option => /session/i.test(option.label)) || options[0]
          if (selected) await scope.selectOption(selected.value)
        }
        const screenshotPath = testInfo.outputPath(`browser-approval-${approvalScreenshots.length + 1}.png`)
        await page.screenshot({ path: screenshotPath, fullPage: true, animations: 'disabled' })
        approvalScreenshots.push(screenshotPath)
        await permission.getByRole('button', { name: /Approve|Allow/ }).click()
        await page.waitForTimeout(500)
        continue
      }
      await page.waitForTimeout(300)
    }

    await expect(answer).toBeVisible()
    await expect(answer).toContainText(/Browser Interaction Lab/)
    expect(
      approvalScreenshots,
      'A normal Provider should ask once, then reuse the Session grant for the same website',
    ).toHaveLength(1)

    const owned = (await browserResources(page)).filter(resource => resource.ownerAgentId === agentId)
    expect(owned).toHaveLength(1)
    expect(owned[0].status).toBe('running')
    expect(owned[0].url).toBe(targetUrl)

    const preview = page.getByTestId('farming-browser-activity-preview')
    await expect(preview).toBeVisible({ timeout: 30_000 })
    await expect(preview.locator('img')).toBeVisible({ timeout: 30_000 })
    const screenshotPath = testInfo.outputPath('real-browser-agent-use.png')
    await page.screenshot({ path: screenshotPath, fullPage: true, animations: 'disabled' })
    await testInfo.attach('real-browser-agent-use', {
      path: screenshotPath,
      contentType: 'image/png',
    })

    await preview.locator('.farming-browser-activity-frame').click()
    const viewer = page.getByTestId('farming-browser-viewer')
    await expect(viewer).toBeVisible()
    await expect(viewer.locator('canvas')).toBeVisible({ timeout: 30_000 })
    await expect(viewer.getByRole('textbox', { name: 'Browser address' })).toHaveValue(targetUrl)
  })
})
