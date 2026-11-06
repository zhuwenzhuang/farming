import fs from 'node:fs'
import path from 'node:path'
import { expect, openFarming, test } from './fixtures'

for (const { appearance, phase } of (['light', 'dark', 'paper'] as const).flatMap(appearance =>
  (['commentary', 'final_answer'] as const).map(phase => ({ appearance, phase })))) {
  test(`keeps streaming ${phase} diagrams stable and fullscreen draggable in ${appearance}`, async ({ page, workspaceRoot }) => {
    const workspace = path.join(workspaceRoot, `mermaid-streaming-${appearance}`)
    fs.mkdirSync(workspace, { recursive: true })
    const created = await page.request.post('/farming/api/control/agents', {
      data: { command: 'codex', workspace, agentRuntimeMode: 'chat' },
    })
    expect(created.ok()).toBeTruthy()
    const { agentId } = await created.json() as { agentId: string }
    try {
      const response = await page.request.get(`/farming/api/agents/${agentId}/acp-transcript?maxTurns=5&media=external-v1`)
      const identity = await response.json() as { sessionId: string; runtimeEpoch: string; toRevision: number }
      let revision = identity.toRevision + 1_000_000
      let active = true
      let stopReason = ''
      let source = '```mermaid\nflowchart LR\n A["Query'
      let step = 0
      let notifyRevision = () => { throw new Error('Transcript WebSocket is not connected') }
      await page.routeWebSocket(/\/farming\/ws(?:\?|$)/, socket => {
        socket.connectToServer()
        notifyRevision = () => socket.send(JSON.stringify({
          type: 'acp-session-revision',
          session: { agentId, sessionId: identity.sessionId, runtimeEpoch: identity.runtimeEpoch, revision, updatedAt: new Date().toISOString() },
        }))
      })
      await page.route(new RegExp(`/farming/api/agents/${agentId}/acp-transcript(?:\\?.*)?$`), route => route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          version: 1, agentId, sessionId: identity.sessionId, runtimeEpoch: identity.runtimeEpoch,
          fromRevision: null, toRevision: revision, replace: true, settled: true, hasMoreBefore: false,
          transcript: { sessionId: identity.sessionId, provider: 'codex', revision, state: active ? 'working' : 'idle', stopReason, entries: [
            { id: 'question', type: 'message', role: 'user', content: [{ type: 'text', text: 'Explain the query pipeline.' }] },
            { id: 'diagram', type: 'message', role: 'assistant', messageId: 'diagram',
              _meta: { codex: { phase } }, content: [{ type: 'text', text: `Revision ${step}\n\n${source}` }] },
            ...(phase === 'final_answer' ? [{ id: 'read', type: 'tool', title: 'Check pipeline', kind: 'read', status: 'completed' }] : []),
            // Keep commentary in the activity surface even after settlement.
            ...(!active ? [{ id: 'final', type: 'message', role: 'assistant', _meta: { codex: { phase: 'final_answer' } }, content: [{ type: 'text', text: 'Pipeline reviewed.' }] }] : []),
          ] },
        }),
      }))
      await openFarming(page)
      await page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`).click()
      await page.evaluate(value => { document.body.dataset.appearance = value }, appearance)
      const turn = page.locator('.code-agent-transcript-turn').filter({ hasText: 'Explain the query pipeline.' })
      if (phase === 'final_answer') await turn.getByTestId('code-agent-transcript-process-summary').click()
      const progress = turn.getByTestId(phase === 'commentary' ? 'code-acp-progress-update' : 'code-acp-answer-segment')
      const diagram = progress.locator('.code-markdown-mermaid').first()
      await expect(diagram).toHaveAttribute('data-render-state', 'streaming')
      const initialHeight = (await diagram.boundingBox())!.height
      await diagram.evaluate(element => {
        const states: string[] = []
        const observer = new MutationObserver(() => { states.push(element.getAttribute('data-render-state') || '') })
        observer.observe(element, { attributes: true, childList: true, subtree: true })
        Object.assign(window, { mermaidStreamAudit: { states, element, stop: () => observer.disconnect() } })
      })
      const refresh = async () => {
        revision++
        step++
        notifyRevision()
        await expect(progress).toContainText(`Revision ${step}`)
      }
      for (const chunk of [' tasks"]', ' --> B["Filter', ' rows"]', '\n B --> C["Results"]']) {
        source += chunk
        await refresh()
        await expect(diagram).toHaveAttribute('data-render-state', 'streaming')
        await expect(diagram.locator('.code-markdown-mermaid-canvas, pre')).toHaveCount(0)
        expect((await diagram.boundingBox())!.height).toBe(initialHeight)
      }
      const audit = await diagram.evaluate(element => {
        const audit = (window as typeof window & { mermaidStreamAudit: { states: string[]; element: Element; stop: () => void } }).mermaidStreamAudit
        audit.stop()
        return { sameElement: audit.element === element, states: audit.states }
      })
      expect(audit.sameElement).toBe(true)
      expect(audit.states.every(state => state === 'streaming')).toBe(true)
      await page.screenshot({ path: test.info().outputPath(`pending-${appearance}.png`) })
      source += '\n```'
      await refresh()
      await expect(diagram).toHaveAttribute('data-render-state', 'ready')
      const svg = await diagram.locator('.code-markdown-mermaid-canvas > svg').elementHandle()
      source += '\n\nThe completed diagram remains visible while this explanation grows.'
      await refresh()
      expect(await diagram.locator('.code-markdown-mermaid-canvas > svg').evaluate((element, previous) => element === previous, svg)).toBe(true)
      await diagram.getByRole('button', { name: 'Open fullscreen diagram' }).click()
      const viewer = page.getByRole('dialog', { name: 'Mermaid diagram', exact: true })
      await expect(viewer.getByRole('button', { name: 'Toggle pan mode' })).toHaveAttribute('aria-pressed', 'true')
      for (const action of ['', 'Zoom in', 'Fit diagram to view', 'Actual size (100%)']) {
        if (action) await viewer.getByRole('button', { name: action, exact: true }).click()
        const canvas = viewer.locator('.code-markdown-mermaid-canvas')
        const before = (await canvas.boundingBox())!
        const viewport = (await viewer.locator('.code-markdown-mermaid-viewport').boundingBox())!
        await page.mouse.move(viewport.x + viewport.width / 2, viewport.y + viewport.height / 2)
        await page.mouse.down()
        await page.mouse.move(viewport.x + viewport.width / 2 + 50, viewport.y + viewport.height / 2 + 30, { steps: 5 })
        await page.mouse.up()
        const after = (await canvas.boundingBox())!
        expect(after.x - before.x).toBeCloseTo(50, 0)
        expect(after.y - before.y).toBeCloseTo(30, 0)
      }
      await page.screenshot({ path: test.info().outputPath(`dragged-fullscreen-${appearance}.png`) })
      await page.keyboard.press('Escape')
      await expect(diagram.getByRole('button', { name: 'Toggle pan mode' })).toHaveAttribute('aria-pressed', 'false')
      source += '\n\n```mermaid\nflowchart LR\n Broken["unfinished'
      await refresh()
      const pending = progress.locator('.code-markdown-mermaid').last()
      await expect(pending).toHaveAttribute('data-render-state', 'streaming')
      active = false
      stopReason = 'cancelled'
      await refresh()
      await expect(pending).toHaveAttribute('data-render-state', 'interrupted')
      stopReason = 'end_turn'
      const disclosure = turn.getByTestId('code-agent-transcript-process-summary')
      if (await disclosure.getAttribute('aria-expanded') === 'false') await disclosure.click()
      await refresh()
      await expect(pending).toHaveAttribute('data-render-state', 'error')
    } finally {
      await page.request.delete(`/farming/api/control/agents/${agentId}`)
    }
  })
}
