import fs from 'node:fs'
import path from 'node:path'
import { expect, openFarming, test } from './fixtures'

async function expectNoDocumentOverflow(page: import('@playwright/test').Page) {
  await expect.poll(async () => page.evaluate(() => ({
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    overflowsX: document.documentElement.scrollWidth > window.innerWidth + 2,
    overflowsY: document.documentElement.scrollHeight > window.innerHeight + 2,
  }))).toEqual({
    scrollX: 0,
    scrollY: 0,
    overflowsX: false,
    overflowsY: false,
  })
}

test.describe('workspace path suggestions', () => {
  test('keeps New Agent home and workspace recommendations in the Code skin', async ({ page, workspaceRoot }) => {
    const suggestionParent = path.join(workspaceRoot, 'code-skin-picks')
    fs.mkdirSync(path.join(suggestionParent, 'alpha'), { recursive: true })

    await openFarming(page)
    await page.request.post('/farming/api/settings', {
      data: {
        codexRuntimeMode: 'cli',
        agentHomes: {
          codex: [
            { id: 'default', path: '~/.codex' },
            { id: 'mobile', path: path.join(workspaceRoot, 'mobile-home') },
          ],
        },
      },
    })
    await page.getByTestId('code-empty-workspace').getByRole('button', { name: 'New Agent' }).click()
    await expect(page.getByTestId('agent-list-status')).toBeHidden({ timeout: 30_000 })
    await page.getByTestId('agent-option-codex').click()

    const homeSelect = page.getByTestId('agent-home-select')
    await expect(homeSelect).toBeVisible()
    await expect(page.getByText('Codex Home', { exact: true })).toBeVisible()
    const homeMetrics = await homeSelect.evaluate(element => {
      const style = getComputedStyle(element)
      return { background: style.backgroundColor, color: style.color, fontFamily: style.fontFamily }
    })
    expect(homeMetrics.background).toBe('rgb(255, 255, 255)')
    expect(homeMetrics.color).toBe('rgb(36, 41, 47)')
    expect(homeMetrics.fontFamily).not.toContain('Courier')

    await homeSelect.click()
    await expect(page.getByTestId('agent-home-menu')).toBeVisible()
    await page.getByTestId('agent-home-option').filter({ hasText: 'mobile' }).click()
    await expect(homeSelect).toContainText('mobile')

    const runtimeMode = page.getByTestId('codex-runtime-mode')
    await expect(runtimeMode).toBeVisible()
    await expect(runtimeMode.getByRole('button', { name: /Terminal/ })).toHaveAttribute('aria-pressed', 'true')
    await runtimeMode.getByRole('button', { name: /App Server/ }).click()
    await expect(runtimeMode.getByRole('button', { name: /App Server/ })).toHaveAttribute('aria-pressed', 'true')

    const workspaceInput = page.getByTestId('workspace-input')
    await expect(workspaceInput).toHaveAttribute('autocomplete', 'off')
    await expect(workspaceInput).toHaveAttribute('autocorrect', 'off')
    await expect(workspaceInput).toHaveAttribute('autocapitalize', 'none')
    await expect(workspaceInput).toHaveAttribute('spellcheck', 'false')
    await expect(workspaceInput).toHaveAttribute('data-form-type', 'other')

    await workspaceInput.fill(`${suggestionParent}${path.sep}a`)
    await expect(page.getByTestId('workspace-path-suggestions')).toBeVisible()
    const suggestionMetrics = await page.locator('.workspace-path-suggestion-name').first().evaluate(element => ({
      fontWeight: getComputedStyle(element).fontWeight,
      color: getComputedStyle(element).color,
    }))
    expect(Number(suggestionMetrics.fontWeight)).toBeLessThanOrEqual(500)
    expect(suggestionMetrics.color).toBe('rgb(36, 41, 47)')
  })

  test('uses the dark skin for the custom home menu and Codex runtime choice', async ({ page, workspaceRoot }) => {
    await openFarming(page)
    await page.request.post('/farming/api/settings', {
      data: {
        appearance: 'dark',
        codexRuntimeMode: 'cli',
        agentHomes: {
          codex: [
            { id: 'default', path: '~/.codex' },
            { id: 'dark', path: path.join(workspaceRoot, 'dark-codex-home') },
          ],
        },
      },
    })
    await page.reload()
    await expect(page.locator('body')).toHaveAttribute('data-appearance', 'dark')
    await page.getByTestId('code-empty-workspace').getByRole('button', { name: 'New Agent' }).click()
    await expect(page.getByTestId('agent-list-status')).toBeHidden({ timeout: 30_000 })
    await page.getByTestId('agent-option-codex').click()

    await page.getByTestId('agent-home-select').click()
    const homeMenu = page.getByTestId('agent-home-menu')
    await expect(homeMenu).toBeVisible()
    const homeMenuMetrics = await homeMenu.evaluate(element => {
      const style = getComputedStyle(element)
      return { background: style.backgroundColor, color: style.color }
    })
    expect(homeMenuMetrics.background).toBe('rgb(22, 27, 34)')
    expect(homeMenuMetrics.color).toBe('rgb(230, 237, 243)')
    await page.keyboard.press('Escape')
    await expect(homeMenu).toBeHidden()

    const runtimeMetrics = await page.getByTestId('codex-runtime-mode').locator('.workspace-runtime-options').evaluate(element => {
      const style = getComputedStyle(element)
      return { background: style.backgroundColor, color: style.color }
    })
    expect(runtimeMetrics.background).toBe('rgb(22, 27, 34)')
    expect(runtimeMetrics.color).toBe('rgb(230, 237, 243)')
  })

  test('remain scrollable when many directories match', async ({ page, workspaceRoot }) => {
    const suggestionParent = path.join(workspaceRoot, 'many-workspace-picks')
    const suggestionNames = Array.from({ length: 24 }, (_, index) => `workspace-${String(index + 1).padStart(2, '0')}`)
    for (const name of suggestionNames) {
      fs.mkdirSync(path.join(suggestionParent, name), { recursive: true })
    }
    const historyEntries = Array.from({ length: 12 }, (_, index) => path.join(workspaceRoot, `recent-workspace-${String(index + 1).padStart(2, '0')}`))

    await openFarming(page)
    await page.request.post('/farming/api/settings', {
      data: { workspaceHistory: historyEntries },
    })
    await page.getByTestId('code-empty-workspace').getByRole('button', { name: 'New Agent' }).click()
    await expect(page.getByTestId('input-dialog')).toBeVisible()
    await expect(page.getByTestId('agent-list-status')).toBeHidden({ timeout: 30_000 })
    await page.getByTestId('agent-option-bash').click()
    await expect(page.getByTestId('workspace-step')).toBeVisible()
    await expect(page.getByTestId('workspace-history')).toBeVisible()

    await page.getByTestId('workspace-input').fill(`${suggestionParent}${path.sep}workspace-`)
    await expect(page.getByTestId('workspace-path-suggestions')).toBeVisible()
    await expect(page.getByTestId('workspace-path-suggestion')).toHaveCount(suggestionNames.length)
    await expect(page.getByTestId('workspace-path-suggestions')).toContainText(suggestionNames.at(-1)!)

    const listMetrics = await page.getByTestId('workspace-path-suggestions').evaluate(element => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
    }))
    expect(listMetrics.scrollHeight).toBeGreaterThan(listMetrics.clientHeight)
    const firstSuggestionHeight = await page.getByTestId('workspace-path-suggestion').first().evaluate(element => element.getBoundingClientRect().height)
    expect(listMetrics.clientHeight).toBeLessThanOrEqual(firstSuggestionHeight * 5 + 12)

    const historyMetrics = await page.locator('.workspace-history-list').evaluate(element => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
    }))
    await expect(page.getByTestId('workspace-history-item')).toHaveCount(5)
    const firstHistoryHeight = await page.getByTestId('workspace-history-item').first().evaluate(element => element.getBoundingClientRect().height)
    expect(historyMetrics.clientHeight).toBeLessThanOrEqual(firstHistoryHeight * 5 + 12)
    await expect(page.getByTestId('workspace-start')).toBeInViewport()

    const initialScrollTop = await page.getByTestId('workspace-path-suggestions').evaluate(element => element.scrollTop)
    await page.getByTestId('workspace-input').press('ArrowUp')
    await expect(page.getByTestId('workspace-path-suggestion').last()).toHaveAttribute('aria-selected', 'true')
    await expect.poll(async () => page.getByTestId('workspace-path-suggestions').evaluate(element => element.scrollTop))
      .toBeGreaterThan(initialScrollTop)

    await page.getByTestId('workspace-input').press('Enter')
    await expect(page.getByTestId('workspace-input')).toHaveValue(`${path.join(suggestionParent, suggestionNames.at(-1)!)}${path.sep}`)
    await expectNoDocumentOverflow(page)
  })
})
