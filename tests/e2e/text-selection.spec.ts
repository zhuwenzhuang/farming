import fs from 'node:fs'
import path from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { expect, openFarming, openNewAgentDialog, selectAgent, test } from './fixtures'

const copyShortcut = process.platform === 'darwin' ? 'Meta+C' : 'Control+C'

async function dragSelectInput(page: Page, input: Locator) {
  const box = await input.boundingBox()
  expect(box).not.toBeNull()
  // Composer actions occupy the trailing edge above the textarea. Stay in the
  // actual text lane so this exercises native selection rather than a button.
  const startX = box!.x + Math.min(240, box!.width * 0.55)
  const textY = box!.y + Math.min(18, box!.height / 2)
  await page.mouse.move(startX, textY)
  await page.mouse.down()
  await page.mouse.move(box!.x + 14, textY, { steps: 12 })
  await page.mouse.up()
  const selection = await input.evaluate(element => {
    const field = element as HTMLInputElement | HTMLTextAreaElement
    return {
      start: field.selectionStart ?? 0,
      end: field.selectionEnd ?? 0,
      selected: field.value.slice(field.selectionStart ?? 0, field.selectionEnd ?? 0),
    }
  })
  expect(selection.end).toBeGreaterThan(selection.start)
  expect(selection.selected.length).toBeGreaterThan(2)
  await page.keyboard.press(copyShortcut)
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(selection.selected)
}

async function dragSelectText(page: Page, target: Locator, expectedSourceText: string) {
  const box = await target.boundingBox()
  expect(box).not.toBeNull()
  await page.evaluate(() => window.getSelection()?.removeAllRanges())
  await page.mouse.move(box!.x + 8, box!.y + box!.height / 2)
  await page.mouse.down()
  await page.mouse.move(box!.x + box!.width - 8, box!.y + box!.height / 2, { steps: 12 })
  await page.mouse.up()
  const selection = await page.evaluate(() => window.getSelection()?.toString() ?? '')
  expect(selection.trim().length).toBeGreaterThan(2)
  expect(expectedSourceText).toContain(selection.trim())
  await page.keyboard.press(copyShortcut)
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(selection)
}

test('keeps mouse selection and clipboard copy working in Chat and text inputs', async ({ page, workspaceRoot }) => {
  const workspace = path.join(workspaceRoot, 'text-selection')
  fs.mkdirSync(workspace, { recursive: true })
  const create = await page.request.post('/farming/api/control/agents', {
    data: { command: 'claude', workspace, agentRuntimeMode: 'chat' },
  })
  expect(create.ok()).toBeTruthy()
  const { agentId } = await create.json() as { agentId: string }

  await openFarming(page)
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], {
    origin: new URL(page.url()).origin,
  })
  const row = page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
  await expect(row).toBeVisible()
  await row.click()

  const composer = page.getByTestId('code-acp-composer-input')
  await expect(composer).toBeEditable({ timeout: 20_000 })
  await composer.fill('mouse selectable composer text')
  await dragSelectInput(page, composer)

  await composer.fill('usage warning mouse selectable transcript text')
  await page.getByTestId('code-acp-composer-send').click()
  const transcriptText = 'usage warning mouse selectable transcript text'
  const userMessage = page.locator('.code-agent-transcript-user')
    .filter({ hasText: transcriptText })
  await expect(userMessage).toBeVisible({ timeout: 20_000 })
  await dragSelectText(page, userMessage, transcriptText)

  const expectedSelectionBackgrounds = {
    light: 'rgba(9, 105, 218, 0.2)',
    dark: 'rgba(51, 156, 255, 0.34)',
    paper: 'rgba(58, 110, 74, 0.22)',
  } as const
  for (const [appearance, expectedBackground] of Object.entries(expectedSelectionBackgrounds)) {
    await page.locator('body').evaluate((body, nextAppearance) => {
      body.dataset.appearance = nextAppearance
    }, appearance)
    const selectionStyle = await userMessage.evaluate(element => ({
      userSelect: getComputedStyle(element).userSelect,
      selectionBackground: getComputedStyle(element, '::selection').backgroundColor,
    }))
    expect(selectionStyle).toEqual({
      userSelect: 'text',
      selectionBackground: expectedBackground,
    })
  }

  await openNewAgentDialog(page)
  await selectAgent(page, 'bash')
  const workspaceInput = page.getByTestId('workspace-input')
  await workspaceInput.fill(path.join(workspace, 'mouse-selectable-directory'))
  await dragSelectInput(page, workspaceInput)
})
