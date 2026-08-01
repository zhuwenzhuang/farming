import {
  expect,
  openFarming,
  openNewAgentDialog,
  startAgentFromOpenDialog,
  test,
} from './fixtures'

test('Farming Code changes only readable content and persists its own size', async ({ page, workspaceRoot }) => {
  const createResponse = await page.request.post('/farming/api/control/agents', {
    data: { command: 'bash', workspace: workspaceRoot },
  })
  expect(createResponse.ok()).toBeTruthy()
  const createBody = await createResponse.json() as { agentId?: string }
  const agentId = String(createBody.agentId || '')
  expect(agentId).not.toBe('')

  await openFarming(page)
  const agentRow = page.locator(
    `[data-testid="code-agent-row"][data-agent-id="${agentId}"], ` +
    `[data-testid="code-project-agent-compact"][data-agent-id="${agentId}"]`,
  ).first()
  await expect(agentRow).toBeVisible({ timeout: 30_000 })
  await agentRow.click()
  const terminalHost = page.locator(
    `[data-testid="code-terminal-pane"][data-agent-id="${agentId}"] ` +
    `.terminal-session-host[data-agent-id="${agentId}"]`,
  )
  await expect(terminalHost).toBeVisible({ timeout: 15_000 })
  await expect(terminalHost).toHaveAttribute('data-terminal-font-size', '12')

  await page.getByTestId('code-sidebar-options').click()
  const settings = page.getByTestId('code-settings-panel')
  const range = settings.getByRole('slider', { name: 'Content text size' })
  const systemButton = settings.getByTestId('code-settings-skin-code')
  const systemFontSize = await systemButton.evaluate(element => getComputedStyle(element).fontSize)

  await range.fill('18')
  await range.blur()

  await expect(page.locator('body')).toHaveAttribute('data-code-content-font-size', '18')
  await expect(terminalHost).toHaveAttribute('data-terminal-font-size', '16')
  await expect(range).toHaveValue('18')
  await expect.poll(async () => {
    const response = await page.request.get('/farming/api/settings')
    const body = await response.json() as { settings?: { codeContentFontSize?: number } }
    return body.settings?.codeContentFontSize
  }).toBe(18)
  await expect(systemButton).toHaveCSS('font-size', systemFontSize)
  await settings.getByRole('button', { name: 'Close' }).click()

  const sizes = await page.evaluate(() => {
    const host = document.createElement('div')
    host.innerHTML = `
      <div class="code-agent-transcript-user">user prose</div>
      <div class="code-agent-transcript-assistant code-markdown-preview"><p>assistant prose</p></div>
      <textarea class="code-file-editor-fallback-textarea">editor prose</textarea>
      <div class="code-composer"><textarea>composer prose</textarea></div>
    `
    document.body.appendChild(host)
    const read = (selector: string) => getComputedStyle(host.querySelector(selector) as Element).fontSize
    const result = {
      user: read('.code-agent-transcript-user'),
      assistant: read('.code-agent-transcript-assistant'),
      editor: read('.code-file-editor-fallback-textarea'),
      composer: read('.code-composer textarea'),
    }
    host.remove()
    return result
  })
  expect(sizes).toEqual({
    user: '18px',
    assistant: '18px',
    editor: '17px',
    composer: '18px',
  })

  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(page.locator('body')).toHaveAttribute('data-code-content-font-size', '18')
})

test('Farming CRT keeps a separate readable-content size and fixed system UI', async ({ page, workspaceRoot }) => {
  await openFarming(page)
  await openNewAgentDialog(page)
  await startAgentFromOpenDialog(page, 'codex', workspaceRoot)
  await page.goto('/farming/crt/', { waitUntil: 'domcontentloaded' })
  const root = page.locator('#farming-crt')
  await expect(root).toBeVisible()
  const settingsButton = page.locator('[data-crt-nav-key="sidebar:settings"]')
  const systemFontSize = await settingsButton.evaluate(element => getComputedStyle(element).fontSize)
  await settingsButton.click()

  const range = page.locator('#crt-content-font-size')
  await expect(range).toBeVisible()
  await range.fill('18')

  await expect(root).toHaveCSS('--crt-chat-font-size', '18px')
  await expect(range).toHaveValue('18')
  await expect(settingsButton).toHaveCSS('font-size', systemFontSize)
  await expect.poll(async () => {
    const response = await page.request.get('/farming/api/settings')
    const body = await response.json() as {
      settings?: { codeContentFontSize?: number; crtContentFontSize?: number }
    }
    return body.settings
  }).toMatchObject({
    codeContentFontSize: 14,
    crtContentFontSize: 18,
  })

  const markdownFontSize = await page.evaluate(() => {
    const prose = document.createElement('div')
    prose.className = 'crt-markdown'
    prose.textContent = 'CRT prose'
    document.querySelector('#farming-crt')?.appendChild(prose)
    const size = getComputedStyle(prose).fontSize
    prose.remove()
    return size
  })
  expect(markdownFontSize).toBe('18px')
})
