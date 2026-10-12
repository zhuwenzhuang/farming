import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { expect, test, type APIRequestContext } from '@playwright/test'
import { cleanupAgents } from '../agent-cleanup'

type Entry = {
  type?: string
  role?: string
  content?: Array<{ type?: string; text?: string }>
  _meta?: { codex?: { phase?: string } }
}
type Transcript = { state?: string; entries?: Entry[] }

async function completedTurn(request: APIRequestContext, agentId: string): Promise<Transcript> {
  let transcript: Transcript = {}
  await expect.poll(async () => {
    const response = await request.get(`/farming/api/agents/${agentId}/acp-transcript?maxTurns=10`)
    expect(response.ok()).toBeTruthy()
    transcript = (await response.json()).transcript ?? {}
    if (transcript.state === 'error' || transcript.state === 'waiting-for-permission') {
      throw new Error(`Real handoff stopped in ${transcript.state}: ${JSON.stringify(transcript)}`)
    }
    return transcript.state === 'idle' && transcript.entries?.some(entry => entry.role === 'assistant')
  }, { timeout: 180_000, intervals: [1000, 2000] }).toBe(true)
  return transcript
}

test('real Codex reads source history across Homes and waits in the user language', async ({ request }, testInfo) => {
  test.skip(process.env.FARMING_REAL_HANDOFF !== '1' || process.env.FARMING_E2E_REAL_CODEX !== '1',
    'Explicit opt-in required: this test makes two real provider turns')
  test.setTimeout(420_000)
  const authHome = process.env.FARMING_REAL_HANDOFF_AUTH_HOME
  if (!authHome) throw new Error('Set FARMING_REAL_HANDOFF_AUTH_HOME to an authenticated Codex Home')
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'farming-real-handoff-')))
  const workspace = path.join(root, 'project')
  const sourceHome = path.join(root, 'source-home')
  const targetHome = path.join(root, 'target-home')
  const marker = `海棠-${randomUUID()}`
  const sourcePrompt = `请一直用中文交流。项目代号是「${marker}」。目标是以后创建 result.txt，写入项目代号；目前尚未开始。后续交接的理解说明应包含项目代号和这个待办。本轮只确认你记住了这些信息，然后等待指示，不要调用工具或创建文件。`
  try {
    await fs.mkdir(workspace)
    await fs.writeFile(path.join(workspace, 'README.md'), '# Handoff verification\n')
    for (const home of [sourceHome, targetHome]) {
      await fs.mkdir(home, { mode: 0o700 })
      // Only this explicitly opted-in smoke reuses authentication. Product
      // handoff does not copy credentials, configuration, or conversation data.
      await fs.copyFile(path.join(authHome, 'auth.json'), path.join(home, 'auth.json'))
      await fs.chmod(path.join(home, 'auth.json'), 0o600)
      await fs.writeFile(path.join(home, 'config.toml'), [
        'check_for_update_on_startup = false',
        'model_reasoning_effort = "low"',
        ...(process.env.FARMING_REAL_HANDOFF_MODEL ? [`model = ${JSON.stringify(process.env.FARMING_REAL_HANDOFF_MODEL)}`] : []),
        '',
      ].join('\n'), { mode: 0o600 })
    }
    const settings = (await (await request.get('/farming/api/settings')).json()).settings
    const configured = await request.post('/farming/api/settings', { data: {
      language: 'en',
      agentHomes: {
        ...settings.agentHomes,
        codex: [...settings.agentHomes.codex,
          { id: 'real-source', path: sourceHome, order: 10 },
          { id: 'real-target', path: targetHome, order: 11 }],
      },
    } })
    expect(configured.ok(), await configured.text()).toBeTruthy()
    const created = await request.post('/farming/api/control/agents', { data: {
      command: 'codex', workspace, providerHomeId: 'real-source', agentRuntimeMode: 'chat',
    } })
    expect(created.ok(), await created.text()).toBeTruthy()
    const sourceId = (await created.json()).agentId as string
    const submitted = await request.post(`/farming/api/control/agents/${sourceId}/messages`, { data: {
      message: sourcePrompt, requestId: `real-source-${randomUUID()}`,
    } })
    expect(submitted.ok(), await submitted.text()).toBeTruthy()
    await completedTurn(request, sourceId)
    const inventory = (await (await request.get('/farming/api/control/agents')).json()).agents
    const source = inventory.find((agent: { id: string }) => agent.id === sourceId)
    expect(source.providerSessionTemporary).not.toBe(true)
    expect(source.providerSessionKey).toBeTruthy()
    const handoff = await request.post('/farming/api/control/agents', { data: {
      command: 'codex', providerHomeId: 'real-target', agentRuntimeMode: 'chat',
      handoffSourceSessionKey: source.providerSessionKey, requestId: `real-handoff-${randomUUID()}`,
    } })
    expect(handoff.ok(), await handoff.text()).toBeTruthy()
    const targetId = (await handoff.json()).agentId as string
    const transcript = await completedTurn(request, targetId)
    await testInfo.attach('real-handoff-transcript', {
      body: Buffer.from(JSON.stringify(transcript, null, 2)), contentType: 'application/json',
    })
    const entries = transcript.entries ?? []
    const text = (entry: Entry) => (entry.content ?? []).map(block => block.text ?? '').join('')
    const prompt = entries.filter(entry => entry.role === 'user').map(text).join('\n')
    expect(prompt).not.toContain(marker)
    const replies = entries.filter(entry => entry.role === 'assistant')
    for (const reply of replies) expect(text(reply)).toMatch(/[\u3400-\u9fff]/)
    const firstReply = entries.findIndex(entry => entry.role === 'assistant')
    expect(entries.slice(0, firstReply).some(entry => entry.type === 'tool')).toBe(true)
    const final = replies.filter(entry => entry._meta?.codex?.phase !== 'commentary').map(text).join('\n')
    expect(final).toContain(marker)
    expect(final).toContain('result.txt')
    expect(final).toMatch(/等待|等你|等候/)
    expect(final).toMatch(/理解|了解|目标|待办/)
    expect(final.match(/[\u3400-\u9fff]/g)?.length ?? 0).toBeGreaterThan(30)
    const after = (await (await request.get('/farming/api/control/agents')).json()).agents
    expect(after.find((agent: { id: string }) => agent.id === targetId)).toMatchObject({
      providerHomeId: 'real-target', providerHomePath: targetHome, cwd: workspace, parentAgentId: sourceId,
    })
    expect(after.some((agent: { id: string }) => agent.id === sourceId)).toBe(true)
    expect((await fs.readdir(workspace)).sort()).toEqual(['README.md'])
    expect(await fs.readFile(path.join(workspace, 'README.md'), 'utf8')).toBe('# Handoff verification\n')
    console.log(`Real handoff final response:\n${final}`)
  } finally {
    // This server is isolated by start-playwright-server; remove its Agents
    // before removing their Homes, including temporary authentication copies.
    try { await cleanupAgents(request, { timeoutMs: 30_000 }) }
    finally { await fs.rm(root, { recursive: true, force: true }) }
  }
})
