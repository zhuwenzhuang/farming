import fs from 'node:fs'
import path from 'node:path'
import type { Page, Route } from '@playwright/test'
import { encodeResumedProviderSessionSource } from '../../shared/provider-session-identity'
import { expect, interceptWorkspaceRequests, openFarming, test } from './fixtures'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(accept => { resolve = accept })
  return { promise, resolve }
}
type Entry = 'search' | 'history'
async function setup(page: Page, workspaceRoot: string, count = 30, provider = 'codex') {
  const root = path.join(workspaceRoot, 'example-project')
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(path.join(root, 'prior.md'), '# Previous file\nPRIOR_FILE_CONTENT\n')
  const sessions = Array.from({ length: count }, (_, i) => ({
    provider, providerName: provider === 'codex' ? 'Codex' : provider, providerHomeId: 'default', capabilities: ['resume'],
    id: `opening-session-${i}`, title: `Session example ${String(i).padStart(2, '0')}`,
    cwd: root, workspace: root, updatedAt: new Date(Date.UTC(2026, 0, 1) - i * 60000).toISOString(),
  }))
  await page.route(/\/api\/agent-sessions\?(.*)$/, route => route.fulfill({ json: { sessions, total: sessions.length } }))
  await page.route(/\/api\/agent-sessions\/search(?:\?.*)?$/, route => route.fulfill({ json: { sessions } }))
  const agents: string[] = []
  const createAgent = async (command = 'bash', chat = false) => {
    const response = await page.request.post('/farming/api/control/agents', { data: { command, workspace: root, ...(chat ? { agentRuntimeMode: 'chat' } : {}) } })
    expect(response.ok()).toBeTruthy()
    const body = await response.json() as { agentId: string }
    agents.push(body.agentId)
    return body.agentId
  }
  await openFarming(page)
  expect((await page.request.post('/farming/api/projects/mount', { data: { workspace: root } })).ok()).toBeTruthy()
  return { root, sessions, createAgent, cleanup: async () => {
    await page.unrouteAll({ behavior: 'wait' })
    for (const id of agents) await page.request.delete(`/farming/api/control/agents/${encodeURIComponent(id)}`)
  } }
}
async function openSource(page: Page, entry: Entry) {
  if (await page.getByTestId('code-mobile-menu').isVisible()) await page.getByTestId('code-mobile-menu').click()
  await page.getByTestId(entry === 'search' ? 'code-nav-search' : 'code-nav-history').click()
  if (entry === 'search') {
    await page.getByRole('combobox', { name: 'Search projects, agents, or files' }).fill('example')
    await page.getByTestId('code-search-filter-sessions').click()
    await expect(page.getByTestId('code-session-search-result')).toHaveCount(30)
  } else {
    await page.getByRole('searchbox', { name: 'Search history' }).fill('example')
    await expect(page.getByTestId('code-session-history-primary')).toHaveCount(12)
    await page.getByRole('button', { name: 'Next page', exact: true }).click()
    await expect(page.getByTestId('code-history-page-status')).toContainText('2 / 3')
  }
}
function row(page: Page, entry: Entry, index: number) {
  return page.getByTestId(entry === 'search' ? 'code-session-search-result' : 'code-session-history-primary').nth(index)
}
async function assertSource(page: Page, entry: Entry) {
  const input = entry === 'search' ? page.getByRole('combobox', { name: 'Search projects, agents, or files' }) : page.getByRole('searchbox', { name: 'Search history' })
  await expect(input).toHaveValue('example')
  if (entry === 'search') await expect(page.getByTestId('code-search-filter-sessions')).toHaveAttribute('aria-pressed', 'true')
  else await expect(page.getByTestId('code-history-page-status')).toContainText('2 / 3')
}

for (const appearance of ['light', 'dark', 'paper'] as const) {
  for (const entry of ['search', 'history'] as const) {
    test(`${entry} opens from a file, deduplicates return/reopen and restores context in ${appearance}`, async ({ page, workspaceRoot }) => {
      await page.setViewportSize({ width: 1360, height: 800 })
      const f = await setup(page, workspaceRoot)
      const gate = deferred<void>()
      let requests = 0
      const agentId = await f.createAgent()
      await page.route(/\/api\/agent-sessions\/codex\/[^/]+\/resume$/, async route => {
        requests++
        await gate.promise
        await route.fulfill({ json: { agentId, projectWorkspaces: [f.root] } })
      })
      try {
        await page.getByTestId('code-nav-search').click()
        await page.getByRole('combobox', { name: 'Search projects, agents, or files' }).fill('prior.md')
        await page.getByTestId('code-global-file-search-result').click()
        await expect(page.getByTestId('code-file-markdown-preview')).toContainText('PRIOR_FILE_CONTENT')
        await page.emulateMedia({ colorScheme: appearance === 'dark' ? 'dark' : 'light', reducedMotion: 'reduce' })
        await page.evaluate(value => { document.documentElement.dataset.appearance = value; document.body.dataset.appearance = value }, appearance)
        await openSource(page, entry)
        const index = entry === 'search' ? 18 : 8
        const selected = row(page, entry, index)
        await selected.scrollIntoViewIfNeeded()
        const title = await selected.locator(entry === 'search' ? 'strong' : '.code-history-card-title').textContent()
        const scroll = await page.getByTestId('code-side-view-panel').evaluate(element => element.scrollTop)
        // Search Enter uses the combobox selection; History Enter activates its native button.
        if (entry === 'history') { await selected.focus(); await selected.press('Enter') }
        else await selected.click()
        const opening = page.getByTestId('code-agent-opening')
        await expect(opening).toHaveAttribute('data-phase', 'resuming')
        await expect(opening).toContainText(title || '')
        await expect(page.getByTestId('code-file-editor')).toBeHidden()
        await expect(page.getByTestId('code-terminal-grid')).toBeHidden()
        await expect(page.getByTestId('code-main')).toHaveScreenshot(`agent-opening-${entry}-${appearance}.png`, { maxDiffPixelRatio: 0, mask: [page.locator('.code-agent-opening-identity').first()] })
        await page.getByTestId('code-agent-opening-back').click()
        await assertSource(page, entry)
        if (entry === 'search') await expect(row(page, entry, index)).toHaveAttribute('aria-selected', 'true')
        await expect.poll(() => page.getByTestId('code-side-view-panel').evaluate(element => element.scrollTop)).toBe(scroll)
        await row(page, entry, index).click()
        await expect.poll(() => requests).toBe(1)
        gate.resolve()
        await expect(opening).toHaveAttribute('data-phase', 'ready')
        await expect(page.locator(`[data-testid="code-terminal-pane"][data-agent-id="${agentId}"]`)).toBeVisible()
        await page.getByTestId('code-agent-opening-back').click()
        await assertSource(page, entry)
        await expect(page.getByTestId('code-file-editor')).toBeHidden()
        expect(requests).toBe(1)
      } finally { gate.resolve(); await f.cleanup() }
    })
  }

  test(`known and uncertain failures stay visible and only status checks reconcile in ${appearance}`, async ({ page, workspaceRoot }) => {
    await page.setViewportSize({ width: 1360, height: 800 })
    const f = await setup(page, workspaceRoot)
    const agentId = await f.createAgent()
    let posts = 0
    let checks = 0
    await page.route(/\/api\/agent-sessions\/codex\/[^/]+\/resume$/, async route => {
      posts++
      if (posts === 1) await route.fulfill({ status: 404, json: { error: 'Example session is unavailable' } })
      else await route.abort('connectionreset')
    })
    await page.route(/\/api\/agent-sessions\/codex\/[^/]+\/resume-status(?:\?.*)?$/, async route => {
      checks++
      await route.fulfill({ json: checks === 1 ? { state: 'pending' } : checks === 2 ? { state: 'absent' } : { state: 'ready', agentId, projectWorkspaces: [f.root] } })
    })
    try {
      await page.emulateMedia({ colorScheme: appearance === 'dark' ? 'dark' : 'light', reducedMotion: 'reduce' })
      await page.evaluate(value => { document.documentElement.dataset.appearance = value; document.body.dataset.appearance = value }, appearance)
      await openSource(page, 'search')
      await page.getByRole('combobox', { name: 'Search projects, agents, or files' }).press('Enter')
      const opening = page.getByTestId('code-agent-opening')
      await expect(opening).toHaveAttribute('data-phase', 'failed')
      await expect(opening.getByRole('alert')).toContainText('Example session is unavailable')
      await page.clock.install()
      await page.clock.fastForward(3000)
      await expect(opening.getByRole('alert')).toBeVisible()
      await expect(page.getByTestId('code-main')).toHaveScreenshot(`agent-opening-error-${appearance}.png`, { maxDiffPixelRatio: 0, mask: [page.locator('.code-agent-opening-identity').first()] })
      await opening.getByRole('button', { name: 'Retry', exact: true }).click()
      await expect(opening.getByRole('button', { name: 'Check status' })).toBeVisible()
      await expect(opening.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0)
      for (let i = 1; i <= 3; i++) {
        await opening.getByRole('button', { name: 'Check status' }).click()
        await expect.poll(() => checks).toBe(i)
        await expect(opening).toHaveAttribute('data-phase', i === 3 ? 'ready' : 'failed')
      }
      expect(posts).toBe(2)
      await expect(page.locator(`[data-testid="code-terminal-pane"][data-agent-id="${agentId}"]`)).toBeVisible()
    } finally { await f.cleanup() }
  })
}

test('A then B with B completing first never jumps back; leaving a request protects another page', async ({ page, workspaceRoot }) => {
  const f = await setup(page, workspaceRoot)
  const a = await f.createAgent()
  const b = await f.createAgent()
  const routes: Route[] = []
  await page.route(/\/api\/agent-sessions\/codex\/[^/]+\/resume$/, route => { routes.push(route) })
  try {
    await openSource(page, 'search')
    await row(page, 'search', 0).click()
    await expect.poll(() => routes.length).toBe(1)
    await page.getByTestId('code-agent-opening-back').click()
    await row(page, 'search', 1).click()
    await expect.poll(() => routes.length).toBe(2)
    await routes[1].fulfill({ json: { agentId: b } })
    await expect(page.getByTestId('code-agent-opening')).toHaveAttribute('data-phase', 'ready')
    await routes[0].fulfill({ json: { agentId: a } })
    await expect(page.locator(`[data-testid="code-terminal-pane"][data-agent-id="${b}"]`)).toBeVisible()
    await expect(page.locator(`[data-testid="code-terminal-pane"][data-agent-id="${a}"]`)).toBeHidden()
    await page.getByTestId('code-agent-opening-back').click()
    await row(page, 'search', 2).click()
    await expect.poll(() => routes.length).toBe(3)
    await page.getByTestId('code-nav-history').click()
    await expect(page.getByTestId('code-history-panel')).toBeVisible()
    await routes[2].fulfill({ json: { agentId: a } })
    await expect(page.getByTestId('code-history-panel')).toBeVisible()
    await expect(page.getByTestId('code-agent-opening')).toHaveCount(0)
  } finally { for (const route of routes) await route.abort().catch(() => {}); await f.cleanup() }
})

test('HTTP before live state has a bounded wait; checking recovers without another POST', async ({ page, workspaceRoot }) => {
  let holdState = false
  const release: Array<() => void> = []
  await page.routeWebSocket(/\/farming\/ws(?:\?|$)/, socket => {
    const server = socket.connectToServer()
    server.onMessage(payload => {
      const message = JSON.parse(String(payload)) as { type?: string }
      if (holdState && (message.type === 'state' || message.type === 'state-delta')) release.push(() => socket.send(payload))
      else socket.send(payload)
    })
  })
  const f = await setup(page, workspaceRoot)
  let posts = 0
  let agentId = ''
  await page.route(/\/api\/agent-sessions\/codex\/[^/]+\/resume$/, async route => {
    posts++
    holdState = true
    agentId = await f.createAgent()
    await route.fulfill({ json: { agentId } })
  })
  await page.route(/\/api\/agent-sessions\/codex\/[^/]+\/resume-status(?:\?.*)?$/, async route => {
    holdState = false
    for (const send of release.splice(0)) send()
    await route.fulfill({ json: { state: 'ready', agentId } })
  })
  try {
    await openSource(page, 'search')
    await page.clock.install()
    await page.getByRole('combobox', { name: 'Search projects, agents, or files' }).press('Enter')
    const opening = page.getByTestId('code-agent-opening')
    await expect(opening).toHaveAttribute('data-phase', 'waiting')
    await expect(page.getByTestId('code-terminal-grid')).toBeHidden()
    await page.clock.fastForward(31_000)
    await expect(opening).toHaveAttribute('data-phase', 'failed')
    await opening.getByRole('button', { name: 'Check status' }).click()
    await expect(opening).toHaveAttribute('data-phase', 'ready')
    expect(posts).toBe(1)
  } finally { holdState = false; for (const send of release.splice(0)) send(); await f.cleanup() }
})

for (const entry of ['search', 'history'] as const) {
  test(`compact ${entry} activation closes navigation and Back retains the query`, async ({ page, workspaceRoot }) => {
    const f = await setup(page, workspaceRoot)
    await page.setViewportSize({ width: 900, height: 700 })
    const gate = deferred<void>()
    await page.route(/\/api\/agent-sessions\/codex\/[^/]+\/resume$/, async route => { await gate.promise; await route.fulfill({ status: 404, json: { error: 'Unavailable' } }) })
    try {
      await openSource(page, entry)
      await row(page, entry, 1).click()
      await expect(page.getByTestId('code-agent-opening')).toHaveAttribute('data-phase', 'resuming')
      await expect(page.getByTestId('code-agent-opening-back')).toBeInViewport()
      await page.getByTestId('code-agent-opening-back').click()
      await assertSource(page, entry)
    } finally { gate.resolve(); await f.cleanup() }
  })
}

test('running Agent opens from Search with mouse or Enter without a resume mutation', async ({ page, workspaceRoot }) => {
  const f = await setup(page, workspaceRoot)
  const agentId = await f.createAgent()
  let posts = 0
  await page.route(/\/api\/agent-sessions\/[^/]+\/[^/]+\/resume$/, async route => { posts++; await route.abort() })
  try {
    await openSource(page, 'search')
    await page.getByTestId('code-search-filter-agents').click()
    await page.getByTestId('code-search-result').click()
    await expect(page.locator(`[data-testid="code-terminal-pane"][data-agent-id="${agentId}"]`)).toBeVisible()
    await expect(page.getByTestId('code-agent-opening')).toHaveAttribute('data-phase', 'ready')
    await page.getByTestId('code-agent-opening-back').click()
    await page.getByRole('combobox', { name: 'Search projects, agents, or files' }).press('Enter')
    await expect(page.locator(`[data-testid="code-terminal-pane"][data-agent-id="${agentId}"]`)).toBeVisible()
    expect(posts).toBe(0)
  } finally { await f.cleanup() }
})

test('Escape returns from pending History and late completion cannot steal focus', async ({ page, workspaceRoot }) => {
  const f = await setup(page, workspaceRoot)
  const agentId = await f.createAgent()
  const gate = deferred<void>()
  await page.route(/\/api\/agent-sessions\/codex\/[^/]+\/resume$/, async route => { await gate.promise; await route.fulfill({ json: { agentId } }) })
  try {
    await openSource(page, 'history')
    const selected = row(page, 'history', 3)
    await selected.focus()
    await selected.press('Enter')
    await expect(page.getByTestId('code-agent-opening')).toHaveAttribute('data-phase', 'resuming')
    await page.keyboard.press('Escape')
    await assertSource(page, 'history')
    await expect(selected).toBeFocused()
    // A membership refresh can remove a historical row. A later user focus
    // decision must still win over the completed operation.
    const search = page.getByRole('searchbox', { name: 'Search history' })
    await search.focus()
    gate.resolve()
    await expect(page.getByTestId('code-history-panel')).toBeVisible()
    await expect(search).toBeFocused()
  } finally { gate.resolve(); await f.cleanup() }
})

for (const provider of ['codex', 'claude', 'opencode', 'pi', 'qwen']) {
  test(`${provider} Chat loading stays in the target pane and uses the existing transcript error/retry flow`, async ({ page, workspaceRoot }) => {
    let sourceOverrides = 0
    // A historical Chat expects a checkpoint. A newly created empty Chat
    // deliberately suppresses checkpoint errors, so model the durable source.
    await page.routeWebSocket(/\/farming\/ws(?:\?|$)/, socket => {
      const server = socket.connectToServer()
      server.onMessage(payload => {
        const message = JSON.parse(String(payload)) as { type: string; state?: { agents?: Array<{ source?: string }> }; upserts?: Array<{ source?: string }> }
        const agents = message.type === 'state' ? message.state?.agents : message.type === 'state-delta' ? message.upserts : undefined
        for (const agent of agents || []) {
          if (agent.source === 'control-cli') {
            sourceOverrides++
            agent.source = encodeResumedProviderSessionSource(provider, 'recorded-transcript-fixture', 'default')
          }
        }
        socket.send(JSON.stringify(message))
      })
    })
    const f = await setup(page, workspaceRoot, 30, provider)
    const transcript = deferred<void>()
    let reads = 0
    let failTranscript = true
    // Install before creating the first Agent: automatic initial selection can
    // otherwise populate the transcript cache before the route exists.
    await page.route(/\/api\/agents\/[^/]+\/acp-transcript(?:\?.*)?$/, async route => {
      reads++
      await transcript.promise
      if (failTranscript) await route.fulfill({ status: 503, json: { error: 'Example transcript unavailable' } })
      else await route.continue()
    })
    const agentId = await f.createAgent(provider, true)
    await page.route(new RegExp(`/api/agent-sessions/${provider}/[^/]+/resume$`), route => route.fulfill({ json: { agentId } }))
    try {
      await openSource(page, 'search')
      await page.getByRole('combobox', { name: 'Search projects, agents, or files' }).press('Enter')
      await expect(page.getByTestId('code-agent-opening')).toHaveAttribute('data-phase', 'ready')
      expect(sourceOverrides).toBeGreaterThan(0)
      await expect.poll(() => reads).toBeGreaterThan(0)
      await expect(page.getByTestId('code-file-editor')).toBeHidden()
      transcript.resolve()
      const alert = page.getByTestId('code-agent-transcript-load-error')
      await expect(alert).toBeVisible()
      failTranscript = false
      await alert.getByRole('button', { name: /Retry/i }).click()
      await expect.poll(() => reads).toBeGreaterThan(1)
      await expect(alert).toBeHidden()
      await page.getByTestId('code-agent-opening-back').click()
      await assertSource(page, 'search')
    } finally { transcript.resolve(); await f.cleanup() }
  })
}

test('pending target does not mark the hidden previous Agent as read', async ({ page, workspaceRoot }) => {
  const f = await setup(page, workspaceRoot)
  const old = await f.createAgent()
  const gate = deferred<void>()
  await page.route(/\/api\/agent-sessions\/codex\/[^/]+\/resume$/, async route => { await gate.promise; await route.fulfill({ status: 404, json: { error: 'Unavailable' } }) })
  try {
    await page.locator(`[data-testid="code-agent-row"][data-agent-id="${old}"]`).click()
    await expect(page.locator(`[data-testid="code-terminal-pane"][data-agent-id="${old}"]`)).toBeVisible()
    await openSource(page, 'search')
    expect((await page.request.patch(`/farming/api/agents/${old}`, { data: { unread: true } })).ok()).toBeTruthy()
    const readOldUnread = async () => {
      const response = await page.request.get('/farming/api/control/agents')
      const { agents } = await response.json() as { agents: Array<{ id: string; unread?: boolean }> }
      return agents.find(agent => agent.id === old)?.unread
    }
    await expect.poll(readOldUnread).toBe(true)
    await row(page, 'search', 1).click()
    await expect(page.getByTestId('code-agent-opening')).toHaveAttribute('data-phase', 'resuming')
    await page.clock.install()
    await page.clock.fastForward(1500)
    expect(await readOldUnread()).toBe(true)
    await expect(page.getByTestId('code-terminal-grid')).toBeHidden()
  } finally { gate.resolve(); await f.cleanup() }
})

test('resume status HTTP endpoint reads exact live provider identity and never launches an Agent', async ({ page, workspaceRoot }) => {
  const f = await setup(page, workspaceRoot)
  const id = await f.createAgent('claude', true)
  type Live = { id: string; providerSessionProvider?: string; providerSessionId?: string; providerHomeId?: string }
  const inventory = async () => {
    const response = await page.request.get('/farming/api/control/agents')
    return (await response.json() as { agents: Live[] }).agents
  }
  try {
    await expect.poll(async () => (await inventory()).find(agent => agent.id === id)?.providerSessionId).toBeTruthy()
    const before = await inventory()
    const agent = before.find(candidate => candidate.id === id)!
    const url = `/farming/api/agent-sessions/${agent.providerSessionProvider}/${encodeURIComponent(agent.providerSessionId!)}/resume-status`
    const exact = await page.request.get(`${url}?providerHomeId=${agent.providerHomeId || 'default'}`)
    expect(exact.ok()).toBeTruthy()
    expect(exact.headers()['cache-control']).toBe('no-store')
    expect(await exact.json()).toMatchObject({ state: 'ready', agentId: id })
    expect(await (await page.request.get(`${url}?providerHomeId=other`)).json()).toEqual({ state: 'absent' })
    expect((await page.request.get(`${url}?providerHomeId=..%2Fbad`)).status()).toBe(400)
    expect((await inventory()).map(candidate => candidate.id).sort()).toEqual(before.map(candidate => candidate.id).sort())
  } finally { await f.cleanup() }
})

test('a newer sidebar file intent wins before its delayed read completes', async ({ page, workspaceRoot }) => {
  const file = deferred<void>()
  let reading = false
  await interceptWorkspaceRequests(page, request => request.operation === 'read-file' && request.path === 'prior.md'
    ? { onResult: async message => { reading = true; await file.promise; return message } } : undefined)
  const f = await setup(page, workspaceRoot)
  const agentId = await f.createAgent()
  const resume = deferred<void>()
  let delivered = false
  await page.route(/\/api\/agent-sessions\/codex\/[^/]+\/resume$/, async route => {
    await resume.promise
    await route.fulfill({ json: { agentId } })
    delivered = true
  })
  try {
    const files = page.getByTestId('code-files-section').filter({ has: page.locator('.code-files-title') }).first()
    const filesTitle = files.locator('.code-files-title')
    await expect(filesTitle).toBeVisible()
    if (await filesTitle.getAttribute('aria-expanded') === 'false') await filesTitle.click()
    await expect(files.getByTestId('code-file-row').filter({ hasText: 'prior.md' })).toBeVisible()
    await openSource(page, 'search')
    await row(page, 'search', 0).click()
    await expect(page.getByTestId('code-agent-opening')).toHaveAttribute('data-phase', 'resuming')
    await files.getByTestId('code-file-row').filter({ hasText: 'prior.md' }).click()
    await expect.poll(() => reading).toBe(true)
    await expect(page.getByTestId('code-agent-opening')).toHaveCount(0)
    resume.resolve()
    await expect.poll(() => delivered).toBe(true)
    await expect(page.getByTestId('code-agent-opening')).toHaveCount(0)
    file.resolve()
    await expect(page.getByTestId('code-file-markdown-preview')).toContainText('PRIOR_FILE_CONTENT')
  } finally { file.resolve(); resume.resolve(); await f.cleanup() }
})

test('a new Agent dialog revokes the old resume before it can close the dialog', async ({ page, workspaceRoot }) => {
  const f = await setup(page, workspaceRoot)
  const agentId = await f.createAgent()
  const gate = deferred<void>()
  let delivered = false
  await page.route(/\/api\/agent-sessions\/codex\/[^/]+\/resume$/, async route => { await gate.promise; await route.fulfill({ json: { agentId } }); delivered = true })
  try {
    await openSource(page, 'search')
    await row(page, 'search', 0).click()
    await expect(page.getByTestId('code-agent-opening')).toHaveAttribute('data-phase', 'resuming')
    await page.getByTestId('code-new-agent').click()
    await expect(page.getByTestId('input-dialog')).toBeVisible()
    gate.resolve()
    await expect.poll(() => delivered).toBe(true)
    await expect(page.getByTestId('input-dialog')).toBeVisible()
    await expect(page.getByTestId('code-agent-opening')).toHaveCount(0)
    await page.keyboard.press('Escape')
  } finally { gate.resolve(); await f.cleanup() }
})
