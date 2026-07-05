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
