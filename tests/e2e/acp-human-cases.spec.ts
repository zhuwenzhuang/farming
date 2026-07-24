import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import type { Page } from '@playwright/test'
import { expect, openFarming, test } from './fixtures'

async function createAcpAgent(page: Page, workspace: string) {
  const response = await page.request.post('/farming/api/control/agents', {
    data: { command: 'claude', workspace, agentRuntimeMode: 'chat' },
  })
  expect(response.ok()).toBeTruthy()
  const payload = await response.json() as { agentId?: string }
  expect(payload.agentId).toBeTruthy()
  return payload.agentId as string
}

function agentRow(page: Page, agentId: string) {
  return page.locator(`[data-testid="code-agent-row"][data-agent-id="${agentId}"]`)
}

async function sendAcpMessage(page: Page, text: string) {
  const input = page.getByTestId('code-acp-composer-input')
  await input.fill(text)
  await page.getByTestId('code-acp-composer-send').click()
  await expect(input).toHaveValue('')
}

test.describe('ACP human-like browser matrix', () => {
  test('keeps a fresh OpenCode launch on ACP before the provider session id exists', async ({ page, workspaceRoot }) => {
    const workspace = path.join(workspaceRoot, 'opencode-acp-launch')
    fs.mkdirSync(workspace, { recursive: true })
    await page.route('**/farming/api/executables', route => route.fulfill({
      json: {
        agents: [
          { name: 'codex', command: 'codex', description: 'Codex', category: 'coding', supported: true, interactive: true },
          { name: 'opencode', command: 'opencode', description: 'OpenCode', category: 'coding', supported: true, interactive: true },
          { name: 'bash', command: 'bash', description: 'Bash', category: 'other', supported: true, interactive: true },
        ],
      },
    }))
    await openFarming(page)
    await expect.poll(async () => {
      const response = await page.request.get('/farming/api/control/agents')
      const body = await response.json() as { mainAgentId?: string | null }
      return body.mainAgentId ?? ''
    }, { timeout: 30_000 }).not.toBe('')

    await page.getByTestId('code-new-agent').click()
    await expect(page.getByTestId('input-dialog')).toBeVisible()
    await expect(page.getByTestId('agent-list-status')).toBeHidden({ timeout: 30_000 })
    await page.getByTestId('agent-option-opencode').click()
    const runtime = page.getByTestId('agent-runtime-mode')
    await runtime.getByRole('button', { name: /^Chat/ }).click()
    await expect(runtime.getByRole('button', { name: /^Chat/ })).toHaveAttribute('aria-pressed', 'true')
    await page.getByTestId('workspace-input').fill(workspace)
    await page.getByTestId('workspace-start').click()

    await expect(page.getByTestId('input-dialog')).toBeHidden({ timeout: 30_000 })
    await expect(page.getByTestId('code-agent-chat-view')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('code-acp-composer')).toBeVisible()
    const stateResponse = await page.request.get('/farming/api/control/agents')
    const state = await stateResponse.json() as {
      agents?: Array<{
        command?: string
        runtimeBinding?: { kind?: string }
        providerSessionProvider?: string
      }>
    }
    const openCode = state.agents?.find(agent => agent.command === 'opencode')
    expect(openCode?.runtimeBinding?.kind).toBe('acp')
    expect(openCode?.providerSessionProvider).toBe('opencode')
  })

  test('keeps Chat reading content on one typography baseline', async ({ page, workspaceRoot }) => {
    const workspace = path.join(workspaceRoot, 'acp-markdown-typography')
    fs.mkdirSync(workspace, { recursive: true })

    const agentId = await createAcpAgent(page, workspace)
    await openFarming(page)
    await agentRow(page, agentId).click()
    await sendAcpMessage(page, 'markdown typography')

    const turn = page.locator('.code-agent-transcript-turn').filter({ hasText: 'Typography baseline.' })
    await expect(turn).toBeVisible({ timeout: 15_000 })
    const metrics = await turn.evaluate(element => {
      const answer = element.querySelector<HTMLElement>('.code-agent-transcript-assistant.code-markdown-preview')
      const pre = answer?.querySelector<HTMLElement>('pre')
      const preCode = pre?.querySelector<HTMLElement>('code')
      const table = answer?.querySelector<HTMLElement>('table')
      const header = table?.querySelector<HTMLElement>('th')
      const quote = answer?.querySelector<HTMLElement>('blockquote')
      const inlineCode = Array.from(answer?.querySelectorAll<HTMLElement>('code') ?? [])
        .find(code => !code.closest('pre'))
      if (!answer || !pre || !preCode || !table || !header || !quote || !inlineCode) {
        throw new Error('Markdown typography fixtures are incomplete')
      }
      return {
        answerFontSize: getComputedStyle(answer).fontSize,
        answerLineHeight: getComputedStyle(answer).lineHeight,
        preFontSize: getComputedStyle(pre).fontSize,
        preLineHeight: getComputedStyle(pre).lineHeight,
        preCodeFontSize: getComputedStyle(preCode).fontSize,
        preCodePaddingLeft: getComputedStyle(preCode).paddingLeft,
        tableFontSize: getComputedStyle(table).fontSize,
        headerLineHeight: getComputedStyle(header).lineHeight,
        quoteFontSize: getComputedStyle(quote).fontSize,
        inlineCodeFontSize: Number.parseFloat(getComputedStyle(inlineCode).fontSize),
      }
    })
    expect(metrics).toMatchObject({
      answerFontSize: '14px',
      answerLineHeight: '20px',
      preFontSize: '14px',
      preLineHeight: '20px',
      preCodeFontSize: '14px',
      preCodePaddingLeft: '0px',
      tableFontSize: '14px',
      headerLineHeight: '20px',
      quoteFontSize: '14px',
    })
    expect(metrics.inlineCodeFontSize).toBeGreaterThanOrEqual(12)
    expect(metrics.inlineCodeFontSize).toBeLessThan(14)
  })

  test('aligns every Chat turn to one shared content column', async ({ page, workspaceRoot }) => {
    const workspace = path.join(workspaceRoot, 'acp-turn-alignment')
    fs.mkdirSync(workspace, { recursive: true })

    const agentId = await createAcpAgent(page, workspace)
    await openFarming(page)
    await agentRow(page, agentId).click()
    await sendAcpMessage(page, 'usage warning')
    await expect(page.getByText('Usage warning published.', { exact: true })).toBeVisible({ timeout: 15_000 })

    const shortTranscriptGeometry = await page.getByTestId('code-agent-transcript-scroll').evaluate(element => {
      const user = element.querySelector<HTMLElement>('.code-agent-transcript-user')
      if (!user) throw new Error('Short Chat turn fixture is incomplete')
      const scrollerBox = element.getBoundingClientRect()
      const userBox = user.getBoundingClientRect()
      return {
        userTopOffset: userBox.top - scrollerBox.top,
        scrollTop: element.scrollTop,
      }
    })
    expect(shortTranscriptGeometry.scrollTop).toBe(0)
    expect(shortTranscriptGeometry.userTopOffset).toBeGreaterThanOrEqual(30)
    expect(shortTranscriptGeometry.userTopOffset).toBeLessThanOrEqual(60)

    await sendAcpMessage(page, 'Please inspect the complete interaction and return a rich timeline with all relevant details.')
    await expect(page.getByText('Rich ACP timeline complete.', { exact: true })).toBeVisible({ timeout: 20_000 })

    const turns = page.locator('.code-agent-transcript-turn')
    const shortTurn = turns.filter({ hasText: 'usage warning' })
    const longTurn = turns.filter({ hasText: 'Please inspect the complete interaction' })
    const metrics = await Promise.all([shortTurn, longTurn].map(turn => turn.evaluate(element => {
      const turnBox = element.getBoundingClientRect()
      const userBox = element.querySelector('.code-agent-transcript-user')?.getBoundingClientRect()
      const answerBox = element.querySelector('.code-agent-transcript-answer')?.getBoundingClientRect()
      if (!userBox || !answerBox) throw new Error('Chat alignment fixture is incomplete')
      return {
        turnLeft: turnBox.left,
        turnWidth: turnBox.width,
        userRight: userBox.right,
        answerLeft: answerBox.left,
      }
    })))

    expect(Math.abs(metrics[0].turnLeft - metrics[1].turnLeft)).toBeLessThanOrEqual(1)
    expect(Math.abs(metrics[0].turnWidth - metrics[1].turnWidth)).toBeLessThanOrEqual(1)
    expect(Math.abs(metrics[0].userRight - metrics[1].userRight)).toBeLessThanOrEqual(1)
    expect(Math.abs(metrics[0].answerLeft - metrics[1].answerLeft)).toBeLessThanOrEqual(1)
  })

  test('keeps 53 structured chat interactions coherent across live, history, security, and runtime switching', async ({ page, workspaceRoot }) => {
    test.setTimeout(150_000)
    const workspace = path.join(workspaceRoot, 'acp-human-cases')
    fs.mkdirSync(workspace, { recursive: true })
    fs.writeFileSync(path.join(workspace, 'README.md'), '# ACP browser fixture\n')
    fs.writeFileSync(path.join(workspace, 'display-fixture.txt'), 'before\n')
    execFileSync('git', ['init'], { cwd: workspace, stdio: 'ignore' })
    execFileSync('git', ['config', 'user.name', 'Farming E2E'], { cwd: workspace })
    execFileSync('git', ['config', 'user.email', 'farming-e2e@example.com'], { cwd: workspace })
    execFileSync('git', ['add', '.'], { cwd: workspace, stdio: 'ignore' })
    execFileSync('git', ['commit', '-m', 'seed ACP fixture'], { cwd: workspace, stdio: 'ignore' })

    let agentId = ''
    await test.step('01 create a real fake-ACP runtime through the server', async () => {
      agentId = await createAcpAgent(page, workspace)
    })
    await test.step('02 open the Farming Code browser surface', async () => {
      await openFarming(page)
    })
    await test.step('03 select the ACP Agent from the project list', async () => {
      await expect(agentRow(page, agentId)).toBeVisible()
      await agentRow(page, agentId).click()
      await expect(agentRow(page, agentId)).toHaveClass(/active/)
    })
    await test.step('04 show Chat rather than a terminal for an ACP runtime', async () => {
      await expect(page.getByTestId('code-agent-chat-view')).toBeVisible()
      await expect(page.getByTestId('code-agent-terminal-view')).toHaveCount(0)
      const emptyState = page.locator('.code-agent-transcript-blank')
      await expect(emptyState).toHaveText('No conversation yet.')
      await expect(emptyState).toHaveAttribute('role', 'status')
    })
    await test.step('05 retain the established composer shape and toolbar', async () => {
      await expect(page.getByTestId('code-acp-composer')).toBeVisible()
      await expect(page.getByTestId('code-acp-composer-toolbar')).toBeVisible()
      await expect(page.getByTestId('code-acp-composer-add')).toBeVisible()
      await expect(page.getByTestId('code-acp-composer-send')).toBeVisible()
    })
    await test.step('06 accept ordinary text input', async () => {
      await page.getByTestId('code-acp-composer-input').fill('rich timeline')
      await expect(page.getByTestId('code-acp-composer-input')).toHaveValue('rich timeline')
    })
    await test.step('07 send a structured ACP prompt', async () => {
      await page.getByTestId('code-acp-composer-send').click()
      await expect(page.getByTestId('code-acp-composer-input')).toHaveValue('')
    })
    await test.step('08 render the optimistic user message once', async () => {
      await expect(page.getByText('rich timeline', { exact: true })).toHaveCount(1)
    })
    await test.step('09 render the final answer after dynamic updates', async () => {
      await expect(page.getByText('Rich ACP timeline complete.', { exact: true })).toBeVisible({ timeout: 20_000 })
    })
    await test.step('10 expose ACP context usage and session cost', async () => {
      const usage = page.getByTestId('code-acp-context-window')
      await expect(usage).toBeVisible()
      await expect(usage).toHaveAttribute('aria-label', /53k \/ 200k tokens used/i)
      await expect(usage).toHaveAttribute('aria-label', /0\.045 USD/)
    })
    await test.step('10b warn when the Agent reports a nearly full context window', async () => {
      await sendAcpMessage(page, 'usage warning')
      await expect(page.getByText('Usage warning published.', { exact: true })).toBeVisible({ timeout: 15_000 })
      const usage = page.getByTestId('code-acp-context-window')
      await expect(usage).toHaveAttribute('data-level', 'warning')
      await expect(usage).toHaveAttribute('aria-label', /nearly full/i)
      await expect(usage).toHaveAttribute('aria-label', /190k \/ 200k tokens used/i)
    })
    const richTurn = page.locator('.code-agent-transcript-turn').filter({ hasText: 'rich timeline' })
    await test.step('11 collapse completed process details by default', async () => {
      await expect(richTurn.getByTestId('code-agent-transcript-process-summary')).toHaveAttribute('aria-expanded', 'false')
    })
    await test.step('12 expand a completed process without moving to another turn', async () => {
      await richTurn.getByTestId('code-agent-transcript-process-summary').click()
      await expect(richTurn.getByTestId('code-agent-transcript-process-summary')).toHaveAttribute('aria-expanded', 'true')
    })
    await test.step('13 surface concise intermediate commentary', async () => {
      await expect(richTurn.getByText('I found the display boundary and am checking the typed ACP content.')).toBeVisible()
    })
    await test.step('14 retain reasoning as an expandable process item', async () => {
      await expect(richTurn.getByText('Reasoning', { exact: true })).toBeVisible()
    })
    await test.step('15 render an execution plan with the correct meaning', async () => {
      await expect(richTurn.getByText('Plan', { exact: true })).toBeVisible()
    })
    await test.step('16 group completed actions into a compact reversible summary', async () => {
      const actionGroup = richTurn.getByTestId('code-agent-transcript-process-group').first()
      await expect(actionGroup).toBeVisible()
      await actionGroup.getByTestId('code-agent-transcript-process-group-toggle').click()
    })
    const readItem = richTurn.getByTestId('code-agent-transcript-process-item').filter({ hasText: 'Read ACP display fixtures' })
    await test.step('17 retain the typed read-tool title and location', async () => {
      await expect(readItem).toBeVisible()
      await readItem.getByTestId('code-agent-transcript-process-item-toggle').click()
      await expect(readItem).toContainText('README.md')
    })
    await test.step('18 render a safe HTTP resource as a real link', async () => {
      await expect(readItem.getByRole('link', { name: 'ACP reference' })).toHaveAttribute('href', 'https://agentclientprotocol.com/')
    })
    await test.step('19 render an embedded text resource without losing its content', async () => {
      const embedded = readItem.getByTestId('code-agent-transcript-user-files').locator('details').filter({ hasText: 'acp-note.txt' })
      await embedded.locator('summary').click()
      await expect(embedded.getByText('Embedded ACP note')).toBeVisible()
    })
    await test.step('20 render ACP image content inside the tool detail', async () => {
      await expect(readItem.getByTestId('code-agent-transcript-process-images').locator('img')).toHaveCount(1)
    })
    await test.step('21 render ACP audio content with native controls', async () => {
      await expect(readItem.getByTestId('code-agent-transcript-audios').locator('audio')).toHaveCount(1)
    })
    await test.step('22 summarize a file edit as a result card', async () => {
      await expect(richTurn.getByTestId('code-agent-transcript-result-card')).toBeVisible()
      await expect(richTurn.getByTestId('code-agent-transcript-result-card')).toContainText('1 file changed')
    })
    await test.step('23 reveal the exact ACP diff on demand', async () => {
      const resultSummary = richTurn.getByTestId('code-agent-transcript-result-summary')
      await resultSummary.click()
      await expect(richTurn.getByTestId('code-agent-transcript-result-details')).toBeVisible()
      await expect(richTurn.getByTestId('code-agent-transcript-result-details')).toContainText('display-fixture.txt')
      await richTurn.locator('.code-agent-transcript-result-file').getByText('display-fixture.txt', { exact: true }).click()
      await expect(richTurn.locator('.code-agent-transcript-result-diff')).toContainText('+after')

    })
    await test.step('23b keep expanded supporting content readable but secondary', async () => {
      await expect(richTurn.locator('.code-acp-progress-update')).toHaveCSS('font-size', '14px')
      await expect(readItem.locator('.code-agent-transcript-user-file pre')).toHaveCSS('font-size', '13px')
      await expect(richTurn.locator('.code-agent-transcript-result-diff')).toHaveCSS('font-size', '13px')
    })
    const terminalItem = richTurn.getByTestId('code-agent-transcript-process-item').filter({ hasText: 'Run verification command' })
    await test.step('24 fetch terminal presentation only when expanded', async () => {
      await terminalItem.getByTestId('code-agent-transcript-process-item-toggle').click()
      await expect(terminalItem.getByTestId('code-agent-transcript-terminals')).toBeVisible()
    })
    await test.step('25 show terminal exit status and output', async () => {
      await expect(terminalItem).toContainText('Exit 0')
      await expect(terminalItem).toContainText('rich-terminal-output')
      await expect(terminalItem).toContainText(process.execPath)
      await expect(terminalItem).toContainText(workspace)
      await expect(terminalItem.getByRole('button', { name: 'Copy terminal output' })).toBeVisible()
    })
    await test.step('26 keep transcript search controls out of the Chat header', async () => {
      await expect(page.getByRole('button', { name: 'Search this chat' })).toHaveCount(0)
      const userMessage = page.locator('.code-agent-transcript-user').filter({ hasText: 'rich timeline' })
      const modeToggle = page.getByTestId('code-terminal-mode-toggle')
      await expect(userMessage).toHaveCount(1)
      await expect.poll(async () => {
        const userBox = await userMessage.boundingBox()
        const toggleBox = await modeToggle.boundingBox()
        if (!userBox || !toggleBox) return -1
        return toggleBox.x - (userBox.x + userBox.width)
      }).toBeGreaterThanOrEqual(8)
    })
    await test.step('27 keep the ordered transcript unchanged', async () => {
      await expect(page.getByText('Rich ACP timeline complete.', { exact: true })).toBeVisible()
    })
    await test.step('28 expose Agent-provided slash commands', async () => {
      await page.getByTestId('code-acp-composer-input').fill('/')
      await expect(page.getByTestId('code-acp-command-review')).toBeVisible()
      await page.getByTestId('code-acp-composer-input').fill('')
    })
    await test.step('29 keep the plus menu compact and actionable', async () => {
      await page.getByTestId('code-acp-composer-add').click()
      await expect(page.getByTestId('code-acp-plus-menu')).toBeVisible()
      await expect(page.getByTestId('code-acp-composer-attach-file')).toBeVisible()
      await page.getByTestId('code-acp-composer-add').click()
    })
    await test.step('29b attach an image through the established composer control', async () => {
      const imagePath = path.join(workspace, 'attachment.png')
      fs.writeFileSync(imagePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=', 'base64'))
      await page.getByTestId('code-acp-composer-file-input').setInputFiles(imagePath)
      const attachment = page.getByTestId('code-composer-attachment')
      await expect(attachment).toContainText('attachment.png')
      await expect(attachment).toHaveClass(/ready/, { timeout: 15_000 })
    })
    await test.step('29c send native ACP image content and retain it in the user turn', async () => {
      await sendAcpMessage(page, 'image attachment')
      await expect(page.getByText('Received 1 image.', { exact: true })).toBeVisible({ timeout: 15_000 })
      const imageTurn = page.locator('.code-agent-transcript-turn').filter({ hasText: 'image attachment' }).last()
      await expect(imageTurn.getByTestId('code-agent-transcript-user-images').locator('img')).toHaveCount(1)
    })
    await test.step('30 send a subagent-producing prompt', async () => {
      await sendAcpMessage(page, 'subagent preview')
      await expect(page.getByText('Subagent inspection complete.', { exact: true })).toBeVisible({ timeout: 15_000 })
    })
    const subagentTurn = page.locator('.code-agent-transcript-turn').filter({ hasText: 'subagent preview' })
    await test.step('31 keep the completed subagent action collapsed', async () => {
      await expect(subagentTurn.getByTestId('code-agent-transcript-process-summary')).toHaveAttribute('aria-expanded', 'false')
      await subagentTurn.getByTestId('code-agent-transcript-process-summary').click()
    })
    await test.step('32 lazily fetch and render the child transcript', async () => {
      const subagentItem = subagentTurn.getByTestId('code-agent-transcript-process-item').filter({ hasText: 'Inspect with subagent' })
      await subagentItem.getByTestId('code-agent-transcript-process-item-toggle').click()
      await expect(subagentItem.getByTestId('code-agent-transcript-subagent')).toContainText('Inspect the parser')
      await expect(subagentItem.getByTestId('code-agent-transcript-subagent')).toContainText('The parser is consistent.')
      await expect(subagentItem.getByTestId('code-agent-transcript-subagent')).toContainText('Completed')
      await expect(subagentItem.getByTestId('code-agent-transcript-subagent')).toContainText('1 turn · 4 actions')
      const readAction = subagentItem.getByTestId('code-agent-transcript-subagent-action').filter({ hasText: 'Read parser fixture' })
      await readAction.locator('summary').click()
      await expect(readAction).toContainText('Parser state is valid.')
      const editAction = subagentItem.getByTestId('code-agent-transcript-subagent-action').filter({ hasText: 'Edit parser fixture' })
      await editAction.locator('summary').click()
      await expect(editAction).toContainText('parser-fixture.txt')
      await expect(editAction).toContainText('+1 -1')
    })
    await test.step('32b open the child transcript without leaving the parent chat', async () => {
      const subagentItem = subagentTurn.getByTestId('code-agent-transcript-process-item').filter({ hasText: 'Inspect with subagent' })
      await subagentItem.getByTestId('code-acp-subagent-fullscreen').click()
      const dialog = page.getByRole('dialog', { name: 'Subagent details' })
      await expect(dialog).toContainText('The parser is consistent.')
      await dialog.getByRole('button', { name: 'Close subagent details' }).click()
      await expect(dialog).toHaveCount(0)
      await expect(page.getByTestId('code-agent-chat-view')).toBeVisible()
    })
    await test.step('33 keep an intermediate failed tool out of the collapsed summary', async () => {
      await sendAcpMessage(page, 'failed tool')
      await expect(page.getByText('The check failed; no files were changed.', { exact: true })).toBeVisible({ timeout: 15_000 })
      const failedTurn = page.locator('.code-agent-transcript-turn').filter({ hasText: 'failed tool' })
      await expect(failedTurn.getByTestId('code-agent-transcript-process-summary')).toHaveAttribute('aria-expanded', 'false')
      await expect(failedTurn.getByTestId('code-agent-transcript-process-compact-list')).toHaveCount(0)
      await expect(failedTurn.getByText('Failed: Run failing check', { exact: true })).toHaveCount(0)
      await failedTurn.getByTestId('code-agent-transcript-process-summary').click()
      const failedGroup = failedTurn.getByTestId('code-agent-transcript-process-group')
      await expect(failedGroup.getByTestId('code-agent-transcript-process-group-toggle')).toContainText('Action failed')
      await failedGroup.getByTestId('code-agent-transcript-process-group-toggle').click()
      const failedItem = failedTurn.getByTestId('code-agent-transcript-process-item')
        .filter({ hasText: 'Run failing check' })
      await expect(failedItem).toHaveAttribute('data-status', 'failed')
      await expect(failedItem.getByTestId('code-agent-transcript-process-item-toggle')).toHaveAttribute('aria-expanded', 'false')
      await expect(failedItem.locator('.code-agent-transcript-process-status')).toHaveText('failed')
    })
    await test.step('34 block permission grants for punycode and invisible paths', async () => {
      await sendAcpMessage(page, 'unicode permission')
      const permission = page.getByTestId('code-acp-permission-request')
      await expect(permission).toBeVisible({ timeout: 15_000 })
      await expect(permission.getByTestId('code-acp-permission-risk')).toContainText('аpple.com')
      await expect(permission.getByRole('button', { name: /Approve|Allow/ })).toBeDisabled()
    })
    await test.step('35 explain each surprising Unicode code point', async () => {
      const risk = page.getByTestId('code-acp-permission-risk')
      await expect(risk).toContainText('U+0430')
      await expect(risk).toContainText('U+200B')
    })
    await test.step('36 require explicit acknowledgement before Allow', async () => {
      const permission = page.getByTestId('code-acp-permission-request')
      await permission.getByRole('checkbox').check()
      const allow = permission.getByRole('button', { name: /Approve|Allow/ })
      await expect(allow).toBeEnabled()
      await allow.click()
      await expect(permission).toBeHidden()
      await expect(page.getByText(/Unicode permission: selected/)).toBeVisible({ timeout: 15_000 })
    })
    await test.step('37 show restrained live progress while the Agent works', async () => {
      await sendAcpMessage(page, 'live progress')
      await expect(page.getByText('Inspecting files', { exact: true })).toBeVisible({ timeout: 5_000 })
      const liveTurn = page.locator('.code-agent-transcript-turn').filter({ hasText: 'live progress' }).last()
      const liveSummary = liveTurn.getByTestId('code-agent-transcript-process-summary')
      await expect(liveSummary).toContainText('Process')
      await expect(liveSummary).toHaveAttribute('title', /run-long-command\.js --verify-mobile-composer-focus/)
      const liveAction = liveTurn.getByTestId('code-agent-transcript-process-item')
        .filter({ hasText: 'PORT=4187 FARMING_PLAYWRIGHT_PORT=4187' })
      await expect(liveAction).toBeVisible()
      await expect(liveAction.locator('.code-agent-transcript-process-status')).toHaveCount(0)
      const liveActionTitle = liveAction.locator('.code-agent-transcript-process-title-text')
      await expect(liveActionTitle).toHaveCSS('text-overflow', 'ellipsis')
      await expect(liveActionTitle).toHaveCSS('white-space', 'nowrap')
      const liveSummaryLabel = liveSummary.locator('.code-agent-transcript-process-summary-label')
      await expect(liveSummaryLabel).toHaveCSS('text-overflow', 'ellipsis')
      await expect(liveSummaryLabel).toHaveCSS('white-space', 'nowrap')
      await expect(page.getByText('Live progress complete.', { exact: true })).toBeVisible({ timeout: 10_000 })
      await expect(liveSummary).not.toHaveAttribute('title', /run-long-command\.js --verify-mobile-composer-focus/)
      await liveTurn.getByTestId('code-agent-transcript-process-summary').click()
      await expect(liveTurn.getByText('Editing display data', { exact: true })).toBeVisible()
      await expect(liveTurn.getByText('Running checks', { exact: true })).toBeVisible()
    })
    await test.step('38 queue and discard a follow-up during active work', async () => {
      await sendAcpMessage(page, 'live progress')
      const activeLiveTurn = page.locator('.code-agent-transcript-turn').filter({ hasText: 'live progress' }).last()
      await expect(activeLiveTurn.getByText('Inspecting files', { exact: true })).toBeVisible({ timeout: 5_000 })
      await page.getByTestId('code-acp-composer-input').fill('queued follow-up')
      await page.getByTestId('code-acp-composer-send').click()
      await expect(page.getByTestId('code-acp-pending-followup')).toContainText('queued follow-up')
      await page.getByTestId('code-acp-pending-followup-discard').click()
      await expect(page.getByTestId('code-acp-pending-followup')).toBeHidden()
      await expect(page.getByText('Live progress complete.', { exact: true }).last()).toBeVisible({ timeout: 10_000 })
    })
    await test.step('39 expose an ACP form elicitation instead of looking stuck', async () => {
      await sendAcpMessage(page, 'exercise client services')
      const elicitation = page.getByTestId('code-acp-elicitation')
      await expect(elicitation).toBeVisible({ timeout: 15_000 })
      await expect(elicitation).toContainText('Confirm the protocol round trip')
    })
    await test.step('40 submit typed ACP input through the established composer area', async () => {
      const elicitation = page.getByTestId('code-acp-elicitation')
      await elicitation.getByRole('checkbox', { name: 'Confirmed' }).check()
      await elicitation.getByRole('button', { name: 'Submit' }).click()
    })
    await test.step('41 keep client filesystem and terminal results in the ordered turn', async () => {
      await expect(page.getByText('filesystem-ok; terminal-ok; exit=0; confirmed=true', { exact: true })).toBeVisible({ timeout: 15_000 })
      const clientTurn = page.locator('.code-agent-transcript-turn').filter({ hasText: 'exercise client services' })
      await clientTurn.getByTestId('code-agent-transcript-process-summary').click()
      await expect(clientTurn.getByTestId('code-agent-transcript-process-group-toggle')).toContainText('Ran a command')
    })
    await test.step('42 clear the resolved elicitation without leaving a duplicate notice', async () => {
      await expect(page.getByTestId('code-acp-elicitation')).toHaveCount(0)
      await expect(page.getByText('Confirm the protocol round trip', { exact: true })).toHaveCount(0)
    })
    const modeToggle = page.getByTestId('code-terminal-mode-toggle')
    await test.step('42b keep Chat and Terminal switch icons visibly rendered', async () => {
      await expect(modeToggle).toBeVisible()
      for (const name of ['Chat', 'Terminal']) {
        const icon = modeToggle.getByRole('button', { name }).locator('svg')
        await expect(icon).toBeVisible()
        await expect(icon).toHaveCSS('fill', /rgb\(/)
      }
      await expect(modeToggle).toHaveCSS('opacity', '0.82')
    })
    await test.step('43 classify a runtime failure without hiding the transcript', async () => {
      await sendAcpMessage(page, 'authentication error')
      const errorTurn = page.locator('.code-agent-transcript-turn').filter({ hasText: 'authentication error' })
      const errorSummary = errorTurn.getByTestId('code-agent-transcript-process-summary')
      await expect(errorSummary).toContainText('Authentication required', { timeout: 10_000 })
      await expect(errorSummary).toHaveAttribute('aria-expanded', 'false')
      await expect(errorTurn.getByTestId('code-agent-transcript-process-item')).toHaveCount(0)
      await errorSummary.click()
      const errorItem = errorTurn.getByTestId('code-agent-transcript-process-item').filter({ hasText: 'Authentication required' })
      await expect(errorItem.getByTestId('code-agent-transcript-process-item-toggle')).toHaveAttribute('aria-expanded', 'false')
      await errorItem.getByTestId('code-agent-transcript-process-item-toggle').click()
      await expect(errorTurn).toContainText('401 Unauthorized')
      await expect(page.getByTestId('code-acp-error')).toHaveCount(0)
      await expect(page.getByText('Rich ACP timeline complete.', { exact: true })).toBeVisible()
    })
    await test.step('44 offer the Agent-advertised authentication method', async () => {
      const authentication = page.getByTestId('code-acp-authentication')
      await expect(authentication).toBeVisible()
      await expect(authentication).toContainText('Sign in to fake Agent')
    })
    await test.step('45 authenticate without discarding the failed turn', async () => {
      const agentAuthentication = page.getByTestId('code-acp-authentication')
        .locator('.code-acp-authentication-method')
        .filter({ hasText: 'Sign in to fake Agent' })
      await agentAuthentication.getByRole('button', { name: 'Authenticate' }).click()
      await expect(page.getByTestId('code-acp-authentication')).toHaveCount(0)
      await expect(page.getByTestId('code-agent-transcript-scroll').getByText('401 Unauthorized', { exact: false })).toBeVisible()
    })
    await test.step('45b expose and complete capability-negotiated ACP logout', async () => {
      await page.getByTestId('code-acp-composer-add').click()
      const logout = page.getByTestId('code-acp-logout')
      await expect(logout).toBeVisible()
      const logoutResponse = page.waitForResponse(response => (
        response.request().method() === 'POST'
        && response.url().includes(`/api/agents/${agentId}/acp-session/logout`)
      ))
      await logout.click()
      expect((await logoutResponse).ok()).toBeTruthy()
    })
    await test.step('46 expose a running client terminal as an ordered tool item', async () => {
      await sendAcpMessage(page, 'long terminal')
      const longTurn = page.locator('.code-agent-transcript-turn').filter({ hasText: 'long terminal' }).last()
      await expect(longTurn.getByTestId('code-agent-transcript-process-summary')).toHaveAttribute('aria-expanded', 'false')
      const longItem = longTurn.getByTestId('code-agent-transcript-process-item')
        .filter({ hasText: 'Run long command' })
      await expect(longItem).toBeVisible({ timeout: 15_000 })
      await expect(longItem.getByTestId('code-agent-transcript-process-item-toggle')).toHaveAttribute('aria-expanded', 'true')
      await expect(longItem).toContainText('long-terminal-ready')
      await expect(longTurn.locator('.code-agent-transcript-placeholder')).toHaveCount(0)
      await expect(longItem.locator('.code-agent-transcript-terminal > header > span')).toHaveCount(0)
      expect((await longItem.locator('.code-acp-embedded-terminal-host').boundingBox())?.height || 0).toBeLessThan(120)
    })
    await test.step('47 stop the running ACP terminal from its detail card', async () => {
      const longTurn = page.locator('.code-agent-transcript-turn').filter({ hasText: 'long terminal' }).last()
      const longItem = longTurn.getByTestId('code-agent-transcript-process-item').filter({ hasText: 'Run long command' })
      await expect(longItem).toBeVisible()
      await expect(longItem).toContainText('long-terminal-ready')
      await longItem.getByTestId('code-acp-terminal-stop').click()
    })
    await test.step('48 preserve terminal output and report the stopped result', async () => {
      await expect(page.getByText('Long command stopped.', { exact: true })).toBeVisible({ timeout: 15_000 })
      const longTurn = page.locator('.code-agent-transcript-turn').filter({ hasText: 'long terminal' }).last()
      const processSummary = longTurn.getByTestId('code-agent-transcript-process-summary')
      await expect(processSummary).toHaveAttribute('aria-expanded', 'false')
      await processSummary.click()
      const actionGroup = longTurn.getByTestId('code-agent-transcript-process-group')
      await actionGroup.getByTestId('code-agent-transcript-process-group-toggle').click()
      const longItem = longTurn.getByTestId('code-agent-transcript-process-item').filter({ hasText: 'Run long command' })
      await expect(longItem.getByTestId('code-agent-transcript-process-item-toggle')).toHaveAttribute('aria-expanded', 'true')
      await expect(longTurn).toContainText('long-terminal-ready')
      await expect(longItem.getByTestId('code-acp-embedded-terminal')).toHaveCount(0)
      await expect(longItem.getByTestId('code-acp-terminal-output')).toContainText('long-terminal-ready')
    })
    await test.step('49 restart from Chat into Terminal with the same provider session', async () => {
      const stateResponse = await page.request.get('/farming/api/control/agents')
      const state = await stateResponse.json() as { agents?: Array<{ id?: string }> }
      expect(state.agents?.some(agent => agent.id === agentId)).toBeTruthy()
      const switchResponsePromise = page.waitForResponse((response) => {
        if (response.request().method() !== 'PATCH'
          || !response.url().includes(`/api/agents/${agentId}`)) {
          return false
        }
        try {
          const payload = response.request().postDataJSON() as { agentRuntimeMode?: string }
          return payload.agentRuntimeMode === 'terminal'
        } catch {
          return false
        }
      })
      await modeToggle.getByRole('button', { name: 'Terminal' }).click()
      await expect(page.getByTestId('code-permission-switching')).toBeVisible()
      const switchResponse = await switchResponsePromise
      const switchPayload = await switchResponse.json() as { error?: string, agentRuntimeMode?: string, restartedAgentId?: string }
      expect(switchResponse.ok(), switchPayload.error || 'Runtime switch request failed').toBeTruthy()
      expect(switchPayload.agentRuntimeMode).toBe('terminal')
      expect(switchPayload.restartedAgentId).toBeTruthy()
      agentId = switchPayload.restartedAgentId || agentId
      await expect(page.getByTestId('code-agent-terminal-view')).toBeVisible({ timeout: 30_000 })
      await expect(page.getByTestId('code-composer-input')).toBeVisible()
      await expect(page.getByTestId('code-acp-composer')).toHaveCount(0)
    })
    await test.step('50 restart back to ACP Chat and preserve structured history', async () => {
      await page.getByTestId('code-terminal-mode-toggle').getByRole('button', { name: 'Chat' }).click()
      await expect(page.getByTestId('code-agent-chat-view')).toBeVisible({ timeout: 30_000 })
      await expect(page.getByTestId('code-acp-composer')).toBeVisible()
      await expect(page.getByText('Rich ACP timeline complete.', { exact: true })).toBeVisible({ timeout: 20_000 })
      await expect(page.getByText('Subagent inspection complete.', { exact: true })).toBeVisible()
    })
  })

  test('opens ACP File Changes from the exact historical diff rather than the current worktree', async ({ page, workspaceRoot }) => {
    test.setTimeout(60_000)
    const workspace = path.join(workspaceRoot, 'acp-historical-review')
    fs.mkdirSync(workspace, { recursive: true })
    fs.writeFileSync(path.join(workspace, 'README.md'), '# ACP review fixture\n')
    fs.writeFileSync(path.join(workspace, 'display-fixture.txt'), 'before\n')
    execFileSync('git', ['init'], { cwd: workspace, stdio: 'ignore' })
    execFileSync('git', ['config', 'user.name', 'Farming E2E'], { cwd: workspace })
    execFileSync('git', ['config', 'user.email', 'farming-e2e@example.com'], { cwd: workspace })
    execFileSync('git', ['add', '.'], { cwd: workspace, stdio: 'ignore' })
    execFileSync('git', ['commit', '-m', 'seed ACP review fixture'], { cwd: workspace, stdio: 'ignore' })

    const agentId = await createAcpAgent(page, workspace)
    await openFarming(page)
    await agentRow(page, agentId).click()
    await sendAcpMessage(page, 'rich timeline')
    await expect(page.getByText('Rich ACP timeline complete.', { exact: true })).toBeVisible({ timeout: 20_000 })

    const turn = page.locator('.code-agent-transcript-turn').filter({ hasText: 'rich timeline' })
    const summary = turn.getByTestId('code-agent-transcript-result-summary')
    await expect(summary).toHaveText('1 file changed+1-1')
    await summary.click()
    await expect(turn.getByTestId('code-agent-transcript-result-details')).toBeVisible()
    await expect(turn.locator('.code-agent-transcript-result-loading')).toHaveCount(0)
    await expect(turn.locator('.code-agent-transcript-result-error')).toHaveCount(0)
    await turn.locator('.code-agent-transcript-result-file').filter({ hasText: 'display-fixture.txt' }).locator('summary').click()
    await expect(turn.locator('.code-agent-transcript-result-diff')).toContainText('+after')

    const reviewPagePromise = page.waitForEvent('popup')
    await turn.getByRole('button', { name: /Review/ }).click()
    const reviewPage = await reviewPagePromise
    await expect.poll(() => new URL(reviewPage.url()).searchParams.get('reviewId')).toMatch(/^review-[a-f0-9]{32}$/)
    const gitRoot = fs.realpathSync(execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: workspace, encoding: 'utf8' }).trim())
    expect(new URL(reviewPage.url()).searchParams.get('root')).toBe(gitRoot)
    const changedFiles = reviewPage.getByRole('region', { name: 'Changed files' })
    await expect(changedFiles).toContainText('Last Turn')
    await expect(changedFiles).toContainText('display-fixture.txt')
    await expect(changedFiles).toContainText('+1')
  })

  test('accepts human input in an ACP client terminal without switching to Terminal mode', async ({ page, workspaceRoot }) => {
    test.setTimeout(60_000)
    const workspace = path.join(workspaceRoot, 'acp-interactive-terminal')
    fs.mkdirSync(workspace, { recursive: true })
    const agentId = await createAcpAgent(page, workspace)
    await openFarming(page)
    await agentRow(page, agentId).click()

    await sendAcpMessage(page, 'interactive terminal')
    const turn = page.locator('.code-agent-transcript-turn').filter({ hasText: 'interactive terminal' }).last()
    await expect(turn.getByTestId('code-agent-transcript-process-summary')).toHaveAttribute('aria-expanded', 'false')
    const tool = turn.getByTestId('code-agent-transcript-process-item')
      .filter({ hasText: 'Ask in terminal' })
    await expect(tool).toBeVisible({ timeout: 15_000 })
    await expect(tool.getByTestId('code-agent-transcript-process-item-toggle')).toHaveAttribute('aria-expanded', 'true')
    await expect(tool).toContainText('name>')
    const terminal = tool.getByTestId('code-acp-embedded-terminal')
    await expect(terminal).toBeVisible()
    expect((await terminal.locator('.code-acp-embedded-terminal-host').boundingBox())?.height || 0).toBeLessThan(120)
    await terminal.locator('.code-acp-embedded-terminal-host').click()
    await page.keyboard.type('Farming', { delay: 30 })
    await page.keyboard.press('Enter')
    const answer = page.locator('.code-agent-transcript-answer').filter({ hasText: 'Interactive terminal completed:' })
    await expect(answer).toContainText('hello Farming', { timeout: 15_000 })
    await expect(page.getByTestId('code-agent-chat-view')).toBeVisible()
    await expect(page.getByTestId('code-agent-terminal-view')).toHaveCount(0)
  })

  test('keeps streaming thought behind explicit process disclosure and folds it after completion', async ({ page, workspaceRoot }) => {
    test.setTimeout(60_000)
    const workspace = path.join(workspaceRoot, 'acp-streaming-thought')
    fs.mkdirSync(workspace, { recursive: true })
    const agentId = await createAcpAgent(page, workspace)
    await openFarming(page)
    await agentRow(page, agentId).click()

    await sendAcpMessage(page, 'streaming thought')
    const turn = page.locator('.code-agent-transcript-turn').filter({ hasText: 'streaming thought' }).last()
    await expect(turn.getByTestId('code-agent-transcript-process-summary')).toHaveAttribute('aria-expanded', 'false')
    await expect(turn.getByText('Comparing the likely causes', { exact: false })).toHaveCount(0)
    await turn.getByTestId('code-agent-transcript-process-summary').click()
    await expect(turn.getByText('Comparing the likely causes', { exact: false })).toBeVisible({ timeout: 10_000 })
    const thought = turn.getByTestId('code-agent-transcript-process-item').filter({ hasText: 'Reasoning' })
    await expect(thought.getByTestId('code-agent-transcript-process-item-toggle')).toHaveAttribute('aria-expanded', 'true')
    await expect(page.getByText('Streaming thought complete.', { exact: true })).toBeVisible({ timeout: 15_000 })
    await expect(turn.getByTestId('code-agent-transcript-process-summary')).toHaveAttribute('aria-expanded', 'false')
    await turn.getByTestId('code-agent-transcript-process-summary').click()
    await expect(thought.getByTestId('code-agent-transcript-process-item-toggle')).toHaveAttribute('aria-expanded', 'false')
  })

  test('preserves a manually opened process group while consecutive tools stream into it', async ({ page, workspaceRoot }) => {
    test.setTimeout(60_000)
    const workspace = path.join(workspaceRoot, 'acp-grouped-streaming-tools')
    fs.mkdirSync(workspace, { recursive: true })
    const agentId = await createAcpAgent(page, workspace)
    await openFarming(page)
    await agentRow(page, agentId).click()

    await sendAcpMessage(page, 'grouped streaming tools')
    const turn = page.locator('.code-agent-transcript-turn').filter({ hasText: 'grouped streaming tools' }).last()
    const processSummary = turn.getByTestId('code-agent-transcript-process-summary')
    await expect(processSummary).toHaveAttribute('aria-expanded', 'false')
    await processSummary.click()
    const group = turn.getByTestId('code-agent-transcript-process-group')
    await expect(group).toHaveAttribute('data-count', '1', { timeout: 10_000 })
    await group.getByTestId('code-agent-transcript-process-group-toggle').click()
    await expect(group.getByTestId('code-agent-transcript-process-group-toggle')).toHaveAttribute('aria-expanded', 'true')
    await expect(group).toHaveAttribute('data-count', '2', { timeout: 10_000 })
    await expect(group.getByTestId('code-agent-transcript-process-group-toggle')).toHaveAttribute('aria-expanded', 'true')
    await expect(page.getByText('Grouped streaming tools complete.', { exact: true })).toBeVisible({ timeout: 15_000 })
  })

  test('keeps a manually closed terminal detail closed when the running command fails', async ({ page, workspaceRoot }) => {
    test.setTimeout(60_000)
    const workspace = path.join(workspaceRoot, 'acp-failing-terminal')
    fs.mkdirSync(workspace, { recursive: true })
    const agentId = await createAcpAgent(page, workspace)
    await openFarming(page)
    await agentRow(page, agentId).click()

    let delayedTerminalOutcomeResponses = 0
    await page.route('**/acp-tool-details/failing-terminal-tool', async route => {
      const response = await route.fetch()
      const body = await response.json() as {
        terminals?: Array<{ terminal?: { exitStatus?: unknown, released?: boolean } }>
      }
      const hasTerminalOutcome = body.terminals?.some(terminal => (
        Boolean(terminal.terminal?.exitStatus) || terminal.terminal?.released
      ))
      if (hasTerminalOutcome && delayedTerminalOutcomeResponses < 3) {
        delayedTerminalOutcomeResponses += 1
        body.terminals = body.terminals?.map(terminal => ({
          ...terminal,
          terminal: terminal.terminal ? {
            ...terminal.terminal,
            exitStatus: null,
            released: false,
          } : terminal.terminal,
        }))
      }
      await route.fulfill({ response, json: body })
    })

    await sendAcpMessage(page, 'failing terminal')
    const turn = page.locator('.code-agent-transcript-turn').filter({ hasText: 'failing terminal' }).last()
    const runningItem = turn.getByTestId('code-agent-transcript-process-item')
      .filter({ hasText: 'Run failing command' })
    const toggle = runningItem.getByTestId('code-agent-transcript-process-item-toggle')
    await expect(toggle).toHaveAttribute('aria-expanded', 'true', { timeout: 15_000 })
    await expect(runningItem).toContainText('failing-terminal-ready')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')

    await expect(page.getByText('Failing terminal finished.', { exact: true })).toBeVisible({ timeout: 15_000 })
    const processSummary = turn.getByTestId('code-agent-transcript-process-summary')
    await expect(processSummary).toHaveAttribute('aria-expanded', 'false')
    await expect(turn.getByTestId('code-agent-transcript-process-item')).toHaveCount(0)
    await processSummary.click()
    const failedGroup = turn.getByTestId('code-agent-transcript-process-group')
    await failedGroup.getByTestId('code-agent-transcript-process-group-toggle').click()
    const failedItem = turn.getByTestId('code-agent-transcript-process-item')
      .filter({ hasText: 'Run failing command' })
    await expect(failedItem).toBeVisible()
    const failedToggle = failedItem.getByTestId('code-agent-transcript-process-item-toggle')
    await expect(failedToggle).toHaveAttribute('aria-expanded', 'false')
    await failedToggle.click()
    const syncError = failedItem.getByTestId('code-acp-terminal-sync-error')
    await expect(syncError).toContainText('Terminal status could not be synchronized.')
    await expect(failedItem.getByTestId('code-acp-terminal-stop')).toHaveCount(0)
    await expect(failedItem.getByTestId('code-acp-embedded-terminal')).toHaveCount(0)
    expect(delayedTerminalOutcomeResponses).toBe(3)
    await syncError.getByRole('button', { name: 'Retry' }).click()
    await expect(syncError).toHaveCount(0)
    await expect(failedItem.getByTestId('code-acp-terminal-output')).toContainText('failing-terminal-ready')
    await expect(failedItem.locator('.code-agent-transcript-terminal-meta')).toContainText('Exit 2')
    await expect(failedItem.getByText('Output', { exact: true })).toHaveCount(0)
  })

  test('shows terminal outcome recovery when no terminal snapshot could be loaded', async ({ page, workspaceRoot }) => {
    test.setTimeout(60_000)
    const workspace = path.join(workspaceRoot, 'acp-unavailable-terminal-detail')
    fs.mkdirSync(workspace, { recursive: true })
    const agentId = await createAcpAgent(page, workspace)
    await openFarming(page)
    await agentRow(page, agentId).click()

    let allowTerminalDetail = false
    await page.route('**/acp-tool-details/failing-terminal-tool', async route => {
      if (!allowTerminalDetail) {
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'terminal detail temporarily unavailable' }),
        })
        return
      }
      await route.continue()
    })

    await sendAcpMessage(page, 'failing terminal')
    const turn = page.locator('.code-agent-transcript-turn').filter({ hasText: 'failing terminal' }).last()
    const runningItem = turn.getByTestId('code-agent-transcript-process-item')
      .filter({ hasText: 'Run failing command' })
    const toggle = runningItem.getByTestId('code-agent-transcript-process-item-toggle')
    await expect(toggle).toBeVisible({ timeout: 10_000 })
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')

    await expect(page.getByText('Failing terminal finished.', { exact: true })).toBeVisible({ timeout: 15_000 })
    const processSummary = turn.getByTestId('code-agent-transcript-process-summary')
    await expect(processSummary).toHaveAttribute('aria-expanded', 'false')
    await expect(turn.getByTestId('code-agent-transcript-process-item')).toHaveCount(0)
    await processSummary.click()
    const failedItem = turn.getByTestId('code-agent-transcript-process-item')
      .filter({ hasText: 'Run failing command' })
    const syncError = failedItem.getByTestId('code-acp-terminal-sync-error')
    await expect(syncError).toContainText('Terminal status could not be synchronized.', { timeout: 10_000 })
    await expect(failedItem.locator('.code-agent-transcript-terminal')).toHaveCount(0)
    await expect(failedItem.getByTestId('code-acp-terminal-stop')).toHaveCount(0)

    allowTerminalDetail = true
    await syncError.getByRole('button', { name: 'Retry' }).click()
    await expect(syncError).toHaveCount(0)
    await expect(failedItem.getByTestId('code-acp-terminal-output')).toContainText('failing-terminal-ready')
    await expect(failedItem.locator('.code-agent-transcript-terminal-meta')).toContainText('Exit 2')
  })

  test('keeps a dense multi-step turn compact until the user opens its evidence', async ({ page, workspaceRoot }) => {
    test.setTimeout(60_000)
    const workspace = path.join(workspaceRoot, 'acp-dense-multi-step-progress')
    fs.mkdirSync(workspace, { recursive: true })
    const agentId = await createAcpAgent(page, workspace)
    await openFarming(page)
    await agentRow(page, agentId).click()

    await sendAcpMessage(page, 'dense multi-step progress')
    const turn = page.locator('.code-agent-transcript-turn').filter({ hasText: 'dense multi-step progress' }).last()
    const processSummary = turn.getByTestId('code-agent-transcript-process-summary')
    await expect(processSummary).toContainText('Process', { timeout: 10_000 })
    expect(await processSummary.getAttribute('aria-expanded')).toBe('false')
    await expect(turn.getByTestId('code-agent-transcript-process-group')).toHaveCount(0)
    await expect(turn.getByTestId('code-agent-transcript-process-item')).toHaveCount(4)
    await expect(turn.getByTestId('code-agent-transcript-process-earlier')).toHaveText('16 earlier actions')
    for (const step of [21, 22, 23, 24]) {
      await expect(turn.getByTestId('code-agent-transcript-process-item')
        .filter({ hasText: `Run verification step ${step}` })).toBeVisible()
    }
    await expect(turn.getByTestId('code-agent-transcript-process-item')
      .filter({ hasText: 'Run verification step 20' })).toHaveCount(0)
    await expect(turn.getByTestId('code-agent-transcript-process-item')
      .filter({ hasText: 'Failed: Run verification step 2' })).toHaveCount(0)
    await expect(turn.getByTestId('code-agent-transcript-process-item')
      .filter({ hasText: /^Reasoning/ })).toHaveCount(0)
    const failedItems = turn.locator('[data-testid="code-agent-transcript-process-item"][data-status="failed"]')
    await expect(failedItems).toHaveCount(0)
    const activeAction = turn.getByTestId('code-agent-transcript-process-item')
      .filter({ hasText: 'Run verification step 24' })
    await expect(activeAction).toBeVisible()
    const visibleProgress = turn.getByTestId('code-acp-progress-update')
    await expect(visibleProgress).toHaveCount(1)
    await expect(visibleProgress).toContainText('The second verification phase passed; final checks are running.')
    await expect(visibleProgress).not.toContainText('The first verification phase passed.')
    await expect(visibleProgress).toHaveCSS('max-height', '73px')
    await expect(visibleProgress).toHaveCSS('overflow', 'hidden')
    await expect(visibleProgress.locator('a')).toHaveCount(0)

    await activeAction.getByTestId('code-agent-transcript-process-item-toggle').click()
    await processSummary.click()
    await expect(processSummary).toHaveAttribute('aria-expanded', 'true')
    await expect(turn.getByTestId('code-agent-transcript-process-group')).toHaveCount(24)
    const activeFullGroup = turn.getByTestId('code-agent-transcript-process-group')
      .filter({ hasText: 'Run verification step 24' })
    await expect(activeFullGroup.getByTestId('code-agent-transcript-process-group-toggle')).toHaveAttribute('aria-expanded', 'true')
    const fullProgress = turn.getByTestId('code-acp-progress-update').last()
    expect((await fullProgress.boundingBox())?.height || 0).toBeGreaterThan(60)
    await expect(fullProgress.getByRole('link', { name: 'Details' })).toBeVisible()
    const thought = turn.getByTestId('code-agent-transcript-process-item').filter({ hasText: 'Reasoning' })
    await expect(thought).toHaveCount(24)
    await expect(thought.filter({ hasText: 'Reasoning checkpoint 24' })
      .getByTestId('code-agent-transcript-process-item-toggle')).toHaveAttribute('aria-expanded', 'true')
    await processSummary.click()
    await expect(processSummary).toHaveAttribute('aria-expanded', 'false')
    await expect(turn.getByTestId('code-agent-transcript-process-group')).toHaveCount(0)
    await expect(turn.getByTestId('code-agent-transcript-process-item')).toHaveCount(4)

    await expect(page.getByText('Dense multi-step progress complete.', { exact: true })).toBeVisible({ timeout: 15_000 })
    await expect(processSummary).toHaveAttribute('aria-expanded', 'false')
    await expect(turn.getByTestId('code-acp-progress-update')).toHaveCount(0)
    await expect(turn.getByTestId('code-agent-transcript-process-item')).toHaveCount(0)
  })

  test('keeps a phase-marked rich answer visible after a trailing thought and renders encoded Mermaid source', async ({ page, workspaceRoot }) => {
    test.setTimeout(60_000)
    const workspace = path.join(workspaceRoot, 'acp-phase-aware-mermaid')
    fs.mkdirSync(workspace, { recursive: true })
    const agentId = await createAcpAgent(page, workspace)
    await openFarming(page)
    await agentRow(page, agentId).click()

    await sendAcpMessage(page, 'phase-aware mermaid')
    const turn = page.locator('.code-agent-transcript-turn').filter({ hasText: 'phase-aware mermaid' }).last()
    const answer = turn.locator('.code-agent-transcript-answer')
    await expect(answer).toContainText('Phase-aware rich answer.', { timeout: 15_000 })
    await expect(turn.getByTestId('code-agent-transcript-process-summary')).toHaveAttribute('aria-expanded', 'false')
    await expect(answer.locator('.code-markdown-mermaid')).toBeVisible({ timeout: 15_000 })
    await expect(answer.locator('.code-markdown-mermaid.error')).toHaveCount(0)
    const diagram = answer.locator('.code-markdown-mermaid-canvas > svg')
    await expect(diagram).toBeVisible()
    const diagramId = await diagram.getAttribute('id')
    await page.waitForTimeout(2_500)
    await expect(diagram).toHaveAttribute('id', diagramId || '')
  })

  test('opens and stops a live ACP subagent without leaving the parent chat', async ({ page, workspaceRoot }) => {
    test.setTimeout(60_000)
    const workspace = path.join(workspaceRoot, 'acp-long-subagent')
    fs.mkdirSync(workspace, { recursive: true })
    const agentId = await createAcpAgent(page, workspace)
    await openFarming(page)
    await agentRow(page, agentId).click()

    await sendAcpMessage(page, 'long subagent')
    const turn = page.locator('.code-agent-transcript-turn').filter({ hasText: 'long subagent' }).last()
    const processSummary = turn.getByTestId('code-agent-transcript-process-summary')
    await expect(processSummary).toHaveAttribute('aria-expanded', 'false')
    await processSummary.click()
    const item = turn.getByTestId('code-agent-transcript-process-item').filter({ hasText: 'Investigate with subagent' })
    await expect(item).toBeVisible({ timeout: 15_000 })
    await item.getByTestId('code-agent-transcript-process-item-toggle').click()
    const preview = item.getByTestId('code-agent-transcript-subagent')
    await expect(preview).toContainText('Inspect the long-running task', { timeout: 15_000 })
    await expect(preview).toContainText('Working')
    await preview.getByTestId('code-acp-subagent-fullscreen').click()
    const dialog = page.getByRole('dialog', { name: 'Subagent details' })
    await expect(dialog).toContainText('Checking the first candidate')
    await dialog.getByRole('button', { name: 'Close subagent details' }).click()
    await preview.getByTestId('code-acp-subagent-stop').click()
    await expect(page.getByText('Subagent stopped.', { exact: true })).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId('code-agent-chat-view')).toBeVisible()
    await expect(page.getByTestId('code-agent-terminal-view')).toHaveCount(0)
  })

  test('answers an ACP elicitation from a child session in the parent composer', async ({ page, workspaceRoot }) => {
    test.setTimeout(60_000)
    const workspace = path.join(workspaceRoot, 'acp-subagent-elicitation')
    fs.mkdirSync(workspace, { recursive: true })
    const agentId = await createAcpAgent(page, workspace)
    await openFarming(page)
    await agentRow(page, agentId).click()

    await sendAcpMessage(page, 'subagent elicitation')
    const elicitation = page.getByTestId('code-acp-elicitation')
    await expect(elicitation).toBeVisible({ timeout: 15_000 })
    await expect(elicitation).toContainText('Subagent · form')
    await expect(elicitation).toContainText('Confirm the subagent scope')
    await elicitation.getByRole('checkbox', { name: 'Confirmed for subagent' }).check()
    await elicitation.getByRole('button', { name: 'Submit' }).click()
    await expect(page.getByText('Subagent input complete.', { exact: true })).toBeVisible({ timeout: 15_000 })
    await expect(elicitation).toHaveCount(0)
  })

  test('completes terminal authentication inside ACP Chat and reconnects the same session', async ({ page, workspaceRoot }) => {
    test.setTimeout(60_000)
    const workspace = path.join(workspaceRoot, 'acp-terminal-authentication')
    fs.mkdirSync(workspace, { recursive: true })
    const agentId = await createAcpAgent(page, workspace)
    await openFarming(page)
    await agentRow(page, agentId).click()

    await sendAcpMessage(page, 'authentication error')
    const authentication = page.getByTestId('code-acp-authentication')
    await expect(authentication).toBeVisible({ timeout: 15_000 })
    const terminalMethod = authentication.locator('.code-acp-authentication-method').filter({ hasText: 'Sign in from terminal' })
    await expect(terminalMethod).toContainText('Exercises client terminal authentication.')
    await terminalMethod.getByRole('button', { name: 'Authenticate' }).click()

    const terminal = authentication.getByTestId('code-acp-auth-terminal')
    await expect(terminal).toBeVisible()
    await expect(terminal.getByTestId('code-acp-auth-terminal-output')).toContainText('fake-login>', { timeout: 15_000 })
    const input = terminal.getByRole('textbox', { name: 'Terminal sign-in input' })
    await input.fill('approved')
    await input.press('Enter')

    await expect(authentication).toHaveCount(0, { timeout: 20_000 })
    await expect(page.getByTestId('code-agent-chat-view')).toBeVisible()
    await expect(page.getByTestId('code-agent-terminal-view')).toHaveCount(0)
    await expect(page.getByText('Rich ACP timeline complete.', { exact: true })).toBeVisible({ timeout: 20_000 })
  })

  test('keeps or safely reverts ACP file changes without overwriting newer work', async ({ page, workspaceRoot }) => {
    test.setTimeout(75_000)
    const workspace = path.join(workspaceRoot, 'acp-patch-decisions')
    fs.mkdirSync(workspace, { recursive: true })
    fs.writeFileSync(path.join(workspace, 'decision-keep.txt'), 'before keep\n')
    fs.writeFileSync(path.join(workspace, 'decision-revert.txt'), 'before revert\n')
    fs.writeFileSync(path.join(workspace, 'decision-conflict.txt'), 'before conflict\n')
    const agentId = await createAcpAgent(page, workspace)
    await openFarming(page)
    await agentRow(page, agentId).click()

    await sendAcpMessage(page, 'applied edit')
    await expect(page.getByText('Applied edit complete.', { exact: true })).toBeVisible({ timeout: 15_000 })
    expect(fs.readFileSync(path.join(workspace, 'decision-keep.txt'), 'utf8')).toBe('after decision-keep.txt\n')
    expect(fs.readFileSync(path.join(workspace, 'decision-revert.txt'), 'utf8')).toBe('after decision-revert.txt\n')

    const turn = page.locator('.code-agent-transcript-turn').filter({ hasText: 'applied edit' }).last()
    await turn.getByTestId('code-agent-transcript-result-summary').click()
    await expect(turn.getByTestId('code-agent-transcript-result-details')).toBeVisible()
    const keepFile = turn.locator('.code-agent-transcript-result-file').filter({ hasText: 'decision-keep.txt' })
    const revertFile = turn.locator('.code-agent-transcript-result-file').filter({ hasText: 'decision-revert.txt' })
    await keepFile.locator('summary').click()
    await revertFile.locator('summary').click()
    await keepFile.getByRole('button', { name: 'Keep' }).click()
    await expect(keepFile.getByTestId('code-acp-patch-decision')).toContainText('Kept')
    await revertFile.getByRole('button', { name: 'Revert' }).click()
    await expect(revertFile.getByTestId('code-acp-patch-decision')).toContainText('Reverted')
    expect(fs.readFileSync(path.join(workspace, 'decision-keep.txt'), 'utf8')).toBe('after decision-keep.txt\n')
    expect(fs.readFileSync(path.join(workspace, 'decision-revert.txt'), 'utf8')).toBe('before revert\n')

    await page.reload()
    await agentRow(page, agentId).click()
    const restoredTurn = page.locator('.code-agent-transcript-turn').filter({ hasText: 'applied edit' }).last()
    await restoredTurn.getByTestId('code-agent-transcript-result-summary').click()
    const restoredKeep = restoredTurn.locator('.code-agent-transcript-result-file').filter({ hasText: 'decision-keep.txt' })
    const restoredRevert = restoredTurn.locator('.code-agent-transcript-result-file').filter({ hasText: 'decision-revert.txt' })
    await restoredKeep.locator('summary').click()
    await restoredRevert.locator('summary').click()
    await expect(restoredKeep.getByTestId('code-acp-patch-decision')).toContainText('Kept')
    await expect(restoredRevert.getByTestId('code-acp-patch-decision')).toContainText('Reverted')

    await sendAcpMessage(page, 'conflict applied edit')
    const conflictTurn = page.locator('.code-agent-transcript-turn').filter({ hasText: 'conflict applied edit' }).last()
    await expect(conflictTurn.getByText('Applied edit complete.', { exact: true })).toBeVisible({ timeout: 15_000 })
    fs.writeFileSync(path.join(workspace, 'decision-conflict.txt'), 'newer human change\n')
    await conflictTurn.getByTestId('code-agent-transcript-result-summary').click()
    const conflictFile = conflictTurn.locator('.code-agent-transcript-result-file').filter({ hasText: 'decision-conflict.txt' })
    await conflictFile.locator('summary').click()
    await conflictFile.getByRole('button', { name: 'Revert' }).click()
    await expect(conflictFile.getByRole('alert')).toContainText('File changed after this ACP patch')
    expect(fs.readFileSync(path.join(workspace, 'decision-conflict.txt'), 'utf8')).toBe('newer human change\n')
  })
})
