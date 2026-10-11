import assert from 'node:assert/strict'
import test from 'node:test'
import type { Agent } from '../src/types/agent'
import { AgentMetadataMutationController } from '../src/lib/agent-metadata-mutations'
import {
  agentWithCurrentLiveState, projectAgentLiveSummary, reconcileAgentLiveStates,
  resetAgentLiveStates, setAgentMetadataProjections, updateAgentLiveState,
  type AgentMetadataProjection,
} from '../src/lib/agent-live-state'
import { projectMembershipDisplay } from '../src/components/code/useProjectMembershipController'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(accept => { resolve = accept })
  return { promise, resolve }
}
function agent(id: string, patch: Partial<Agent> = {}): Agent {
  return { id, cwd: '/project', projectWorkspace: '/project', startedAt: 1,
    projectOrder: 1024, pinned: false, followUp: false, unread: false,
    attentionSeq: 10, readAttentionSeq: 10, customTitle: id, ...patch } as Agent
}
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

function fixture(request: typeof fetch) {
  let agents = [agent('a'), agent('b', { projectOrder: 2048 })]
  let patches: ReadonlyMap<string, AgentMetadataProjection> = new Map()
  const notices: boolean[] = []
  const controller = new AgentMetadataMutationController({
    agents: () => agents, request, notice: value => notices.push(value),
    project: value => { patches = value },
  })
  return { controller, notices, patches: () => patches,
    setAgents: (next: Agent[]) => { agents = next; controller.observe() },
    displayed: () => agents.map(agent => ({ ...agent, ...patches.get(agent.id) })),
  }
}

test('rapid pin/unpin projects immediately and an older rejection cannot undo later intent', async () => {
  const first = deferred<Response>()
  let writes = 0
  const subject = fixture(async () => ++writes === 1 ? first.promise : response({ agentId: 'a', pinned: false }))
  const pin = subject.controller.mutate({ kind: 'patch', agentId: 'a', patch: { pinned: true } })
  assert.equal(subject.displayed()[0]?.pinned, true)
  const unpin = subject.controller.mutate({ kind: 'patch', agentId: 'a', patch: { pinned: false } })
  assert.equal(subject.displayed()[0]?.pinned, false)
  assert.equal(writes, 1)
  first.resolve(response({ error: 'rejected' }, 409))
  assert.equal(await pin, false)
  assert(await unpin)
  assert.equal(subject.displayed()[0]?.pinned, false)
  assert.deepEqual(subject.notices, [])
  subject.controller.dispose()
})

test('HTTP confirmation survives old state until authoritative state catches up', async () => {
  const subject = fixture(async () => response({ agentId: 'a', customTitle: 'Renamed' }))
  await subject.controller.mutate({ kind: 'patch', agentId: 'a', patch: { customTitle: 'Renamed' } })
  subject.setAgents([agent('a'), agent('b')])
  assert.equal(subject.displayed()[0]?.customTitle, 'Renamed')
  subject.setAgents([agent('a', { customTitle: 'Renamed' }), agent('b')])
  assert.equal(subject.patches().size, 0)
  subject.controller.dispose()
})

test('state received before HTTP retires the receipt so later external changes remain visible', async () => {
  const gate = deferred<Response>()
  const subject = fixture(async () => gate.promise)
  const save = subject.controller.mutate({ kind: 'patch', agentId: 'a', patch: { pinned: true } })
  subject.setAgents([agent('a', { pinned: true, pinnedOrder: 1024 }), agent('b')])
  gate.resolve(response({ agentId: 'a', pinned: true, pinnedOrder: 1024 }))
  await save
  assert.equal(subject.patches().size, 0)
  subject.setAgents([agent('a', { pinned: false, pinnedOrder: 1024 }), agent('b')])
  assert.equal(subject.displayed()[0]?.pinned, false)
  subject.controller.dispose()
})

test('Pinned drops preserve the ascending Pinned order while pending and confirmed', async () => {
  const gate = deferred<Response>()
  const subject = fixture(async () => gate.promise)
  subject.setAgents(['a', 'b', 'c'].map((id, index) => agent(id, { pinned: true, pinnedOrder: (index + 1) * 1024 })))
  const save = subject.controller.mutate({ kind: 'reorder', agentId: 'c', beforeAgentId: '', afterAgentId: 'a' })
  const order = () => subject.displayed().sort((a, b) => Number(a.pinnedOrder) - Number(b.pinnedOrder)).map(agent => agent.id)
  assert.deepEqual(order(), ['c', 'a', 'b'])
  gate.resolve(response({ agentId: 'c', updates: [{ agentId: 'c', pinnedOrder: 0 }] }))
  await save
  assert.deepEqual(order(), ['c', 'a', 'b'])
  subject.controller.dispose()
})

test('failed reorder rebases a later drop and preserves newly arriving Agents', async () => {
  const first = deferred<Response>()
  const second = deferred<Response>()
  let writes = 0
  const bodies: unknown[] = []
  const subject = fixture(async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)))
    return ++writes === 1 ? first.promise : second.promise
  })
  subject.setAgents([agent('a'), agent('b', { projectOrder: 2048 }), agent('c', { projectOrder: 3072 })])
  const one = subject.controller.mutate({ kind: 'reorder', agentId: 'a', beforeAgentId: '', afterAgentId: 'c' })
  const two = subject.controller.mutate({ kind: 'reorder', agentId: 'b', beforeAgentId: 'a', afterAgentId: 'c' })
  subject.setAgents([agent('a'), agent('b', { projectOrder: 2048 }), agent('c', { projectOrder: 3072 }), agent('d', { projectOrder: 4096 })])
  first.resolve(response({ error: 'rejected' }, 409))
  await one
  const displayed = subject.displayed().sort((a, b) => Number(b.projectOrder) - Number(a.projectOrder))
  assert.deepEqual(displayed.map(agent => agent.id), ['d', 'c', 'a', 'b'])
  assert.deepEqual(bodies[1], { beforeAgentId: 'a', afterAgentId: '' })
  second.resolve(response({ agentId: 'b', updates: [{ agentId: 'b', projectOrder: 0 }] }))
  await two
  assert.equal(subject.displayed().length, 4)
  subject.controller.dispose()
})

test('a lost response after a successful save reconciles silently without another write', async () => {
  let writes = 0
  const subject = fixture(async url => {
    if (String(url).endsWith('/api/control/agents')) return response({ agents: [agent('a', { pinned: true }), agent('b')] })
    writes += 1
    throw new Error('lost response')
  })
  const result = await subject.controller.mutate({ kind: 'patch', agentId: 'a', patch: { pinned: true } })
  assert(result)
  assert.equal(writes, 1)
  assert.equal(subject.displayed()[0]?.pinned, true)
  assert.deepEqual(subject.notices, [])
  subject.controller.dispose()
})

test('a queued drop whose targets disappear cannot invent a different position', async () => {
  const gate = deferred<Response>()
  const bodies: Record<string, unknown>[] = []
  const subject = fixture(async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)))
    return bodies.length === 1 ? gate.promise : response({ error: 'Reorder neighbors are stale' }, 409)
  })
  subject.setAgents([agent('a', { projectOrder: 3072 }), agent('b', { projectOrder: 2048 }), agent('c')])
  const marker = subject.controller.mutate({ kind: 'patch', agentId: 'a', patch: { followUp: true } })
  const drop = subject.controller.mutate({ kind: 'reorder', agentId: 'a', beforeAgentId: 'b', afterAgentId: 'c' })
  subject.setAgents([agent('a', { projectOrder: 3072 }), agent('d')])
  assert.equal(subject.displayed()[0]?.projectOrder, 3072)
  gate.resolve(response({ agentId: 'a', followUp: true }))
  await marker
  assert.equal(await drop, false)
  assert.deepEqual(bodies[1], { beforeAgentId: 'b', afterAgentId: 'c' })
  assert.deepEqual(subject.notices, [false])
  subject.controller.dispose()
})

test('uncertainty cancels later writes and emits one neutral notice', async () => {
  const gate = deferred<Response>()
  let writes = 0
  const subject = fixture(async url => {
    if (String(url).endsWith('/api/control/agents')) throw new Error('offline')
    writes += 1
    return gate.promise
  })
  const one = subject.controller.mutate({ kind: 'patch', agentId: 'a', patch: { pinned: true } })
  const two = subject.controller.mutate({ kind: 'patch', agentId: 'b', patch: { followUp: true } })
  gate.resolve(response({ error: 'unavailable' }, 503))
  assert.equal(await one, false)
  assert.equal(await two, false)
  assert.equal(writes, 1)
  assert.deepEqual(subject.notices, [true])
  subject.controller.dispose()
})

test('an uncertain background read reports a canceled foreground action once', async () => {
  const gate = deferred<Response>()
  const subject = fixture(async url => {
    if (String(url).endsWith('/api/control/agents')) throw new Error('offline')
    return gate.promise
  })
  const read = subject.controller.mutate({ kind: 'patch', agentId: 'a', patch: { unread: false } })
  const pin = subject.controller.mutate({ kind: 'patch', agentId: 'a', patch: { pinned: true } })
  gate.resolve(response({}, 503))
  assert.equal(await read, false)
  assert.equal(await pin, false)
  assert.deepEqual(subject.notices, [true])
  subject.controller.dispose()
})

test('reconciliation cannot project unrelated stale fields over fresh activity', async () => {
  const gate = deferred<Response>()
  const subject = fixture(async url => {
    if (String(url).endsWith('/api/control/agents')) return gate.promise
    throw new Error('lost response')
  })
  const save = subject.controller.mutate({ kind: 'patch', agentId: 'a', patch: { pinned: true } })
  subject.setAgents([agent('a', { unread: true, attentionSeq: 11 }), agent('b', { followUp: true })])
  gate.resolve(response({ agents: [agent('a', { pinned: true }), agent('b')] }))
  assert(await save)
  assert.equal(subject.displayed()[0]?.unread, true)
  assert.equal(subject.displayed()[1]?.followUp, true)
  subject.controller.dispose()
})

test('read projection updates counts immediately but never hides later attention', () => {
  resetAgentLiveStates()
  const original = agent('a', { unread: true, readAttentionSeq: 9 })
  reconcileAgentLiveStates([original])
  setAgentMetadataProjections(new Map([['a', { unread: false, readAttentionSeq: 10, followUp: true }]]))
  assert.equal(agentWithCurrentLiveState(original).unread, false)
  assert.equal(projectAgentLiveSummary('/project')?.unreadCount, 0)
  assert.equal(projectAgentLiveSummary('/project')?.followUpCount, 1)
  updateAgentLiveState('a', { unread: true, attentionSeq: 11 })
  assert.equal(agentWithCurrentLiveState(original).unread, true)
  assert.equal(projectAgentLiveSummary('/project')?.unreadCount, 1)
  resetAgentLiveStates()
})

test('read writes acknowledge the admission cut instead of consuming activity during the save', async () => {
  const gate = deferred<Response>()
  let sent: unknown
  const subject = fixture(async (_url, init) => {
    sent = JSON.parse(String(init?.body))
    return gate.promise
  })
  subject.setAgents([agent('a', { unread: true, readAttentionSeq: 9 })])
  const write = subject.controller.mutate({ kind: 'patch', agentId: 'a', patch: { unread: false } })
  assert.deepEqual(sent, { readAttentionSeq: 10 })
  subject.setAgents([agent('a', { unread: true, attentionSeq: 11, readAttentionSeq: 9 })])
  gate.resolve(response({ agentId: 'a', unread: true, attentionSeq: 11, readAttentionSeq: 10 }))
  assert(await write)
  assert.equal(subject.displayed()[0]?.unread, true)
  assert.deepEqual(subject.notices, [])
  subject.controller.dispose()
})

test('a newer read cursor retires an older read receipt without regressing the cursor', async () => {
  const subject = fixture(async () => response({ agentId: 'a', unread: false, readAttentionSeq: 10 }))
  subject.setAgents([agent('a', { unread: true, readAttentionSeq: 9 })])
  await subject.controller.mutate({ kind: 'patch', agentId: 'a', patch: { unread: false } })
  subject.setAgents([agent('a', { unread: true, attentionSeq: 12, readAttentionSeq: 11 })])
  assert.equal(subject.patches().size, 0)
  assert.equal(subject.displayed()[0]?.unread, true)
  assert.equal(subject.displayed()[0]?.readAttentionSeq, 11)
  subject.controller.dispose()
})

test('a read queued after the first manual unread includes that manual marker', async () => {
  const first = deferred<Response>()
  const bodies: Record<string, unknown>[] = []
  const subject = fixture(async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)))
    return bodies.length === 1 ? first.promise : response({ agentId: 'a', unread: false, readAttentionSeq: 1 })
  })
  subject.setAgents([agent('a', { attentionSeq: 0, readAttentionSeq: 0 })])
  const unread = subject.controller.mutate({ kind: 'patch', agentId: 'a', patch: { unread: true } })
  const read = subject.controller.mutate({ kind: 'patch', agentId: 'a', patch: { unread: false } })
  assert.equal(subject.displayed()[0]?.unread, false)
  first.resolve(response({ agentId: 'a', unread: true, attentionSeq: 1, readAttentionSeq: 0 }))
  await unread
  await read
  assert.deepEqual(bodies[1], { readAttentionSeq: 1 })
  assert.equal(subject.displayed()[0]?.unread, false)
  subject.controller.dispose()
})

test('an incomplete successful response is reconciled rather than accepted as saved', async () => {
  const subject = fixture(async url => String(url).endsWith('/api/control/agents')
    ? response({ agents: [agent('a'), agent('b')] }) : response({ agentId: 'a' }))
  assert.equal(await subject.controller.mutate({ kind: 'patch', agentId: 'a', patch: { pinned: true } }), false)
  assert.equal(subject.displayed()[0]?.pinned, false)
  assert.deepEqual(subject.notices, [true])
  subject.controller.dispose()
})

test('Project projections rebase queued pin and reorder over fresh membership', () => {
  const state = { projectWorkspaces: ['/a', '/b', '/new'], pinnedProjectWorkspaces: [], projectWorkspacesLoaded: true }
  const result = projectMembershipDisplay(state, [
    { kind: 'reorder', workspace: '/b', beforeWorkspace: '', afterWorkspace: '/a' },
    { kind: 'pin', workspace: '/a', pinned: true },
    { kind: 'pin', workspace: '/a', pinned: false },
  ])
  assert.deepEqual(result.projectWorkspaces, ['/b', '/a', '/new'])
  assert.deepEqual(result.pinnedProjectWorkspaces, [])
  assert.deepEqual(state.projectWorkspaces, ['/a', '/b', '/new'])
})
