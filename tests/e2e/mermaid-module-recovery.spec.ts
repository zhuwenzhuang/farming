import fs from 'node:fs'
import path from 'node:path'
import { expect, openFarming, test } from './fixtures'

for (const appearance of ['light', 'dark', 'paper'] as const) {
  test(`recovers a missing Mermaid module without replaying the turn in ${appearance}`, async ({ page, workspaceRoot }) => {
    test.setTimeout(90_000)
    const workspace = path.join(workspaceRoot, `mermaid-module-${appearance}`)
    fs.mkdirSync(workspace, { recursive: true })
    const response = await page.request.post('/farming/api/control/agents', {
      data: { command: 'claude', workspace, agentRuntimeMode: 'chat' },
    })
    expect(response.ok()).toBeTruthy()
    const { agentId } = await response.json() as { agentId: string }
    const moduleUrl = '**/assets/FileEditorMarkdownPreview-*.js'
    try {
      await page.route(moduleUrl, route => route.abort('failed'))
      await page.addInitScript(value => {
        window.addEventListener('DOMContentLoaded', () => { document.body.dataset.appearance = value })
      }, appearance)
      await openFarming(page)
      await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
      await page.evaluate(value => { document.body.dataset.appearance = value }, appearance)
      const input = page.getByTestId('code-acp-composer-input')
      await input.fill('phase-aware mermaid')
      await page.getByTestId('code-acp-composer-send').click()
      const turn = page.locator('.code-agent-transcript-turn').filter({ hasText: 'phase-aware mermaid' }).last()
      const failure = turn.getByTestId('code-agent-transcript-mermaid-render-error')
      await expect(failure).toContainText('Diagram component could not be loaded')
      await expect(turn).not.toHaveClass(/running/)
      const turnId = await turn.getAttribute('data-turn-id')
      await expect(page.getByTestId('app-error-fallback')).toHaveCount(0)
      await input.fill('Unsent draft must survive diagram recovery')
      await failure.scrollIntoViewIfNeeded()
      await page.screenshot({ path: test.info().outputPath(`module-failed-${appearance}.png`) })
      await page.unroute(moduleUrl)
      await failure.getByRole('button', { name: 'Reload page', exact: true }).click()
      const restored = page.locator(`[data-turn-id="${turnId}"]`)
      await expect(restored.locator('.code-markdown-mermaid-canvas > svg')).toBeVisible()
      await expect(input).toHaveValue('Unsent draft must survive diagram recovery')
      await expect(page.locator('.code-agent-transcript-turn').filter({ hasText: 'phase-aware mermaid' })).toHaveCount(1)
      await page.evaluate(value => { document.body.dataset.appearance = value }, appearance)
      await restored.locator('.code-markdown-mermaid').scrollIntoViewIfNeeded()
      await page.screenshot({ path: test.info().outputPath(`module-recovered-${appearance}.png`) })
    } finally {
      await page.unroute(moduleUrl)
      await page.request.delete(`/farming/api/control/agents/${agentId}`)
    }
  })
}
