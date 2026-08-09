import assert from 'assert';
const {
  encodeProviderSessionKey,
  encodeResumedProviderSessionSource,
} = require('../../shared/provider-session-identity.js');
import {
  AgentSessionResumeCoordinator,
  type AgentSessionResumeCoordinatorPorts,
} from '../agent-session-resume-coordinator.cjs';

type StartCallback = (agentId: string | null, error?: string | null) => void;
type StartOptions = Parameters<AgentSessionResumeCoordinatorPorts['startAgent']>[3];

const CONFLICT_ERROR = 'A different resume request is already in progress for this Agent session';

function flushAsyncWork() {
  return new Promise<void>(resolve => setImmediate(resolve));
}

async function drainAsyncWork() {
  for (let round = 0; round < 4; round += 1) await flushAsyncWork();
}

function deferred<Result>() {
  let resolve!: (value: Result) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<Result>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, reject, resolve };
}

function basePorts(overrides: Partial<AgentSessionResumeCoordinatorPorts> = {}): AgentSessionResumeCoordinatorPorts {
  return {
    archiveNewAgent: async () => null,
    canonicalProjectWorkspace: async workspace => workspace || '',
    configuredProviderHomes: () => ({ codex: [{ id: 'default', path: '/homes/codex' }] }),
    currentAgentSessions: async () => [],
    ensureCodexSessionAvailable: async () => null,
    findAgentSession: async () => ({
      provider: 'codex',
      id: 'session-alpha',
      cwd: '/repo',
      workspace: '/repo',
      title: 'Alpha',
      providerHomeId: 'default',
      providerHomePath: '/homes/codex',
    }),
    getActiveAgents: () => [],
    getMainPageSessionKeys: () => [],
    getSavedAgentSession: () => null,
    getSettings: () => ({ projectWorkspaces: [], pinnedProjectWorkspaces: [] }),
    mountProjectWorkspace: () => ({ projectWorkspaces: ['/repo'], pinnedProjectWorkspaces: [] }),
    publishAgentState: () => {},
    rememberMainPageSession: () => {},
    removeMainPageSession: () => {},
    startAgent: (_command, _workspace, callback) => {
      callback('agent-alpha');
      return Promise.resolve('agent-alpha');
    },
    waitForAgentRecovery: async () => {},
    warn: () => {},
    ...overrides,
  };
}

async function testInvalidRequestBoundary() {
  {
    const coordinator = new AgentSessionResumeCoordinator(basePorts());
    assert.deepStrictEqual(
      await coordinator.resumeHttp('codex', '', undefined),
      { status: 400, body: { error: 'invalid session id' } },
      'an absent JSON body must retain the route\'s invalid-session response instead of throwing',
    );
    assert.deepStrictEqual(
      await coordinator.resumeHttp('codex', 'session-alpha', { customTitle: 7 }),
      { status: 400, body: { error: 'customTitle must be a string' } },
    );
    assert.deepStrictEqual(
      await coordinator.resumeHttp('not-a-provider', 'session-alpha', {}),
      { status: 400, body: { error: 'invalid session id' } },
    );
    assert.deepStrictEqual(
      await coordinator.resumeHttp('codex', '-leading-dash', {}),
      { status: 400, body: { error: 'invalid session id' } },
    );
  }

  for (const providerHomeId of [
    'home:one',
    'bad/home',
    'back\\slash',
    '../escape',
    'has space',
    'home\nother',
    'home\u0000',
    'home*',
  ]) {
    let lookups = 0;
    let starts = 0;
    const remembers: string[] = [];
    const coordinator = new AgentSessionResumeCoordinator(basePorts({
      findAgentSession: async () => {
        lookups += 1;
        return null;
      },
      rememberMainPageSession: (provider, sessionId, home) => { remembers.push(`${provider}:${home}:${sessionId}`); },
      startAgent: () => {
        starts += 1;
        return Promise.resolve('agent-should-not-start');
      },
    }));
    assert.deepStrictEqual(
      await coordinator.resumeHttp('codex', 'session-alpha', { providerHomeId }),
      { status: 400, body: { error: 'invalid provider home id' } },
      `providerHomeId ${JSON.stringify(providerHomeId)} must be rejected at the resume boundary`,
    );
    assert.deepStrictEqual(
      await coordinator.resume('codex', 'session-alpha', { providerHomeId }),
      { error: 'invalid provider home id', status: 400 },
    );
    assert.deepStrictEqual([lookups, starts, remembers.length], [0, 0, 0], 'a rejected provider home must have no effect');
  }
}

async function testProviderHomeNormalization() {
  {
    const completions: Array<ReturnType<typeof deferred<string | null>>> = [];
    const homes: string[] = [];
    const coordinator = new AgentSessionResumeCoordinator(basePorts({
      findAgentSession: async () => null,
      startAgent: (_command, _workspace, _callback, options) => {
        homes.push(options.providerHomeId);
        const completion = deferred<string | null>();
        completions.push(completion);
        return completion.promise;
      },
    }));
    const first = coordinator.resumeHttp('codex', 'session-trim', { providerHomeId: '  home-a  ' });
    await flushAsyncWork();
    const joined = coordinator.resumeHttp('codex', 'session-trim', { providerHomeId: 'home-a' });
    const paddedWithNewline = coordinator.resumeHttp('codex', 'session-trim', { providerHomeId: '\n\thome-a ' });
    await flushAsyncWork();
    assert.strictEqual(completions.length, 1, 'a padded provider home must join the trimmed identity');
    completions[0].resolve('agent-trim');
    assert.strictEqual((await first).status, 201);
    assert.strictEqual((await joined).status, 200);
    assert.strictEqual(
      (await paddedWithNewline).status,
      200,
      'surrounding whitespace must normalize to the same safe provider home rather than fail the boundary',
    );
    assert.deepStrictEqual(homes, ['home-a'], 'the trimmed provider home must reach the Agent start');
  }

  {
    const completions: Array<ReturnType<typeof deferred<string | null>>> = [];
    const homes: string[] = [];
    const coordinator = new AgentSessionResumeCoordinator(basePorts({
      findAgentSession: async () => null,
      startAgent: (_command, _workspace, _callback, options) => {
        homes.push(options.providerHomeId);
        const completion = deferred<string | null>();
        completions.push(completion);
        return completion.promise;
      },
    }));
    const blank = coordinator.resumeHttp('codex', 'session-default-home', { providerHomeId: '' });
    await flushAsyncWork();
    const explicit = coordinator.resumeHttp('codex', 'session-default-home', { providerHomeId: 'default' });
    const absent = coordinator.resumeHttp('codex', 'session-default-home', {});
    const nonString = coordinator.resumeHttp('codex', 'session-default-home', { providerHomeId: 12 });
    await flushAsyncWork();
    assert.strictEqual(completions.length, 1, 'blank, absent, non-string and explicit default homes are one identity');
    completions[0].resolve('agent-default-home');
    assert.strictEqual((await blank).status, 201);
    for (const reply of await Promise.all([explicit, absent, nonString])) {
      assert.strictEqual(reply.status, 200);
    }
    assert.deepStrictEqual(homes, ['default']);
  }

  {
    const completions: Array<ReturnType<typeof deferred<string | null>>> = [];
    const requested: string[] = [];
    const coordinator = new AgentSessionResumeCoordinator(basePorts({
      findAgentSession: async (_provider, sessionId, options) => {
        requested.push(`${options.providerHomeId}|${sessionId}`);
        return null;
      },
      startAgent: () => {
        const completion = deferred<string | null>();
        completions.push(completion);
        return completion.promise;
      },
    }));
    const nested = coordinator.resume('codex', 'one:two:three', { providerHomeId: 'home-a' });
    const shallow = coordinator.resume('codex', 'one', { providerHomeId: 'home-a' });
    const otherHome = coordinator.resume('codex', 'one:two:three', { providerHomeId: 'home-a.two' });
    await flushAsyncWork();
    assert.strictEqual(completions.length, 3, 'colon-bearing session ids must key an exact admission tuple');
    assert.deepStrictEqual(requested, [
      'home-a|one:two:three',
      'home-a|one',
      'home-a.two|one:two:three',
    ]);
    completions[0].resolve('agent-nested');
    completions[1].resolve('agent-shallow');
    completions[2].resolve('agent-other-home');
    assert.deepStrictEqual(
      [(await nested).agentId, (await shallow).agentId, (await otherHome).agentId],
      ['agent-nested', 'agent-shallow', 'agent-other-home'],
    );
  }

  {
    const completions: Array<ReturnType<typeof deferred<string | null>>> = [];
    const coordinator = new AgentSessionResumeCoordinator(basePorts({
      findAgentSession: async () => null,
      startAgent: () => {
        const completion = deferred<string | null>();
        completions.push(completion);
        return completion.promise;
      },
    }));
    const codex = coordinator.resume('codex', 'shared-session', { providerHomeId: 'home-a' });
    const claude = coordinator.resume('claude', 'shared-session', { providerHomeId: 'home-a' });
    const forged = coordinator.resume('codex', 'home-a.shared-session', { providerHomeId: 'home-a' });
    await flushAsyncWork();
    assert.strictEqual(completions.length, 3, 'each provider/home/session tuple must own a separate admission');
    completions[0].resolve('agent-codex');
    completions[1].resolve('agent-claude');
    completions[2].resolve('agent-forged');
    assert.deepStrictEqual(
      [(await codex).agentId, (await claude).agentId, (await forged).agentId],
      ['agent-codex', 'agent-claude', 'agent-forged'],
    );
  }
}

async function testCrossChannelAdmissionJoin() {
  {
    const completion = deferred<string | null>();
    let starts = 0;
    let mounts = 0;
    let publishes = 0;
    const remembers: string[] = [];
    const coordinator = new AgentSessionResumeCoordinator(basePorts({
      mountProjectWorkspace: () => {
        mounts += 1;
        return { projectWorkspaces: ['/repo'], pinnedProjectWorkspaces: [] };
      },
      publishAgentState: () => { publishes += 1; },
      rememberMainPageSession: (provider, sessionId, providerHomeId) => {
        remembers.push(`${provider}:${providerHomeId}:${sessionId}`);
      },
      startAgent: () => {
        starts += 1;
        return completion.promise;
      },
    }));
    const direct = coordinator.resume('codex', 'session-cross-channel', {});
    await flushAsyncWork();
    const http = coordinator.resumeHttp('codex', 'session-cross-channel', {});
    await flushAsyncWork();
    assert.strictEqual(starts, 1, 'an HTTP resume must join an already in-flight direct resume admission');
    completion.resolve('agent-cross-channel');
    const [directResult, httpReply] = await Promise.all([direct, http]);
    assert.deepStrictEqual(directResult, { agentId: 'agent-cross-channel', projectWorkspace: '/repo' });
    assert.deepStrictEqual(httpReply, {
      status: 200,
      body: {
        agentId: 'agent-cross-channel',
        projectWorkspace: '/repo',
        projectWorkspaces: ['/repo'],
        pinnedProjectWorkspaces: [],
        reused: true,
        pending: true,
      },
    }, 'an HTTP leader that joined an existing admission must project the pending reuse instead of a fresh 201');
    assert.deepStrictEqual([mounts, publishes], [1, 1], 'the joining HTTP request still owns its Project and publish effects once');
    assert.deepStrictEqual(remembers, [
      'codex:default:session-cross-channel',
      'codex:default:session-cross-channel',
    ]);
  }

  {
    const completion = deferred<string | null>();
    const events: string[] = [];
    let starts = 0;
    const coordinator = new AgentSessionResumeCoordinator(basePorts({
      archiveNewAgent: async () => {
        events.push('archive');
        return null;
      },
      mountProjectWorkspace: () => { throw new Error('mount failed for joined resume'); },
      publishAgentState: () => { events.push('publish'); },
      removeMainPageSession: () => { events.push('forget'); },
      startAgent: () => {
        starts += 1;
        return completion.promise;
      },
    }));
    const direct = coordinator.resume('codex', 'session-cross-rollback', {});
    await flushAsyncWork();
    const http = coordinator.resumeHttp('codex', 'session-cross-rollback', {});
    await flushAsyncWork();
    completion.resolve('agent-cross-rollback');
    const [directResult, httpReply] = await Promise.all([direct, http]);
    assert.strictEqual(starts, 1);
    assert.deepStrictEqual(httpReply, { status: 500, body: { error: 'mount failed for joined resume' } });
    assert.deepStrictEqual(
      directResult,
      { agentId: 'agent-cross-rollback', projectWorkspace: '/repo' },
      'the owning direct resume keeps its Agent when a joining HTTP request fails to mount a Project',
    );
    assert.deepStrictEqual(
      events,
      ['publish'],
      'a joined HTTP resume must not archive or forget the Agent another caller started',
    );
  }

  {
    const completion = deferred<string | null>();
    const events: string[] = [];
    let starts = 0;
    const coordinator = new AgentSessionResumeCoordinator(basePorts({
      mountProjectWorkspace: () => {
        events.push('mount');
        return { projectWorkspaces: ['/repo'], pinnedProjectWorkspaces: [] };
      },
      publishAgentState: () => { events.push('publish'); },
      rememberMainPageSession: () => { events.push('remember'); },
      startAgent: () => {
        starts += 1;
        return completion.promise;
      },
    }));
    const http = coordinator.resumeHttp('codex', 'session-http-then-direct', {});
    await flushAsyncWork();
    const direct = coordinator.resume('codex', 'session-http-then-direct', {});
    await flushAsyncWork();
    assert.strictEqual(starts, 1, 'a direct resume must join the in-flight HTTP resume operation');
    completion.resolve('agent-http-then-direct');
    assert.strictEqual((await http).status, 201);
    assert.deepStrictEqual(await direct, {
      agentId: 'agent-http-then-direct',
      projectWorkspace: '/repo',
      reused: true,
      pending: true,
    });
    assert.deepStrictEqual(
      events,
      ['remember', 'mount', 'publish'],
      'the HTTP owner applies each effect once and the direct follower adds none',
    );
  }

  {
    const completion = deferred<string | null>();
    const events: string[] = [];
    const archived: string[] = [];
    let starts = 0;
    const coordinator = new AgentSessionResumeCoordinator(basePorts({
      archiveNewAgent: async agentId => {
        events.push('archive');
        archived.push(agentId);
        return null;
      },
      mountProjectWorkspace: () => {
        events.push('mount');
        throw new Error('mount failed for HTTP owner');
      },
      publishAgentState: () => { events.push('publish'); },
      rememberMainPageSession: () => { events.push('remember'); },
      removeMainPageSession: () => { events.push('forget'); },
      startAgent: () => {
        starts += 1;
        return completion.promise;
      },
    }));
    const http = coordinator.resumeHttp('codex', 'session-http-owner-rollback', {});
    await flushAsyncWork();
    const direct = coordinator.resume('codex', 'session-http-owner-rollback', {});
    await flushAsyncWork();
    assert.strictEqual(starts, 1);
    completion.resolve('agent-http-owner-rollback');
    const [httpReply, directResult] = await Promise.all([http, direct]);
    assert.deepStrictEqual(httpReply, { status: 500, body: { error: 'mount failed for HTTP owner' } });
    assert.deepStrictEqual(
      directResult,
      { error: 'mount failed for HTTP owner', status: 500 },
      'a direct follower must fail with the HTTP owner rather than leak the Agent the owner archived',
    );
    assert.deepStrictEqual(archived, ['agent-http-owner-rollback']);
    assert.deepStrictEqual(
      events,
      ['remember', 'mount', 'archive', 'forget', 'publish'],
      'the archived identity must be forgotten exactly once and never re-remembered by the follower',
    );
  }

  {
    const completion = deferred<string | null>();
    let starts = 0;
    const coordinator = new AgentSessionResumeCoordinator(basePorts({
      startAgent: () => {
        starts += 1;
        return completion.promise;
      },
    }));
    const http = coordinator.resumeHttp('codex', 'session-http-owner-conflict', {});
    await flushAsyncWork();
    assert.deepStrictEqual(
      await coordinator.resume('codex', 'session-http-owner-conflict', { fork: true }),
      { error: CONFLICT_ERROR, status: 409 },
      'a direct resume with different semantics must not join an in-flight HTTP resume operation',
    );
    assert.strictEqual(starts, 1, 'a conflicting direct resume must not create a second start');
    completion.resolve('agent-http-owner-conflict');
    assert.strictEqual((await http).status, 201);
  }

  {
    const completion = deferred<string | null>();
    let starts = 0;
    const coordinator = new AgentSessionResumeCoordinator(basePorts({
      startAgent: () => {
        starts += 1;
        return completion.promise;
      },
    }));
    const direct = coordinator.resume('codex', 'session-cross-conflict', {});
    await flushAsyncWork();
    assert.deepStrictEqual(
      await coordinator.resumeHttp('codex', 'session-cross-conflict', { fork: true }),
      { status: 409, body: { error: CONFLICT_ERROR } },
      'an HTTP resume with different semantics must not join a direct resume admission',
    );
    assert.strictEqual(starts, 1);
    completion.resolve('agent-cross-conflict');
    assert.strictEqual((await direct).agentId, 'agent-cross-conflict');
  }
}

async function testStartAdmissionSignature() {
  {
    const callbacks: StartCallback[] = [];
    const completions: Array<ReturnType<typeof deferred<string | null>>> = [];
    let starts = 0;
    const remembers: string[] = [];
    const coordinator = new AgentSessionResumeCoordinator(basePorts({
      rememberMainPageSession: (provider, sessionId, providerHomeId) => {
        remembers.push(`${provider}:${providerHomeId}:${sessionId}`);
      },
      startAgent: (_command, _workspace, callback) => {
        starts += 1;
        callbacks.push(callback);
        const completion = deferred<string | null>();
        completions.push(completion);
        return completion.promise;
      },
    }));
    const first = coordinator.resume('codex', 'session-alpha', { providerHomeId: 'default' });
    const joined = coordinator.resume('codex', 'session-alpha', { providerHomeId: 'default' });
    await flushAsyncWork();
    assert.strictEqual(starts, 1, 'same provider/home/session resume must join one exact start admission');
    callbacks[0]('agent-alpha');
    completions[0].resolve('agent-alpha');
    assert.deepStrictEqual(await first, { agentId: 'agent-alpha', projectWorkspace: '/repo' });
    assert.deepStrictEqual(
      await joined,
      { agentId: 'agent-alpha', projectWorkspace: '/repo', reused: true, pending: true },
      'a joined resume must keep reporting a pending reuse instead of claiming a fresh start',
    );
    assert.deepStrictEqual(remembers, ['codex:default:session-alpha', 'codex:default:session-alpha']);

    await flushAsyncWork();

    const next = coordinator.resume('codex', 'session-alpha', { providerHomeId: 'default' });
    await flushAsyncWork();
    assert.strictEqual(starts, 2, 'settled identity must not retain a stale in-flight admission');
    callbacks[0]('late-agent');
    let settled = false;
    void next.then(() => { settled = true; });
    await flushAsyncWork();
    assert.strictEqual(settled, false, 'a stale callback must not settle a later exact resume intent');
    callbacks[1]('agent-beta');
    completions[1].resolve('agent-beta');
    assert.deepStrictEqual(await next, { agentId: 'agent-beta', projectWorkspace: '/repo' });
  }

  {
    const completion = deferred<string | null>();
    let starts = 0;
    const coordinator = new AgentSessionResumeCoordinator(basePorts({
      startAgent: () => {
        starts += 1;
        return completion.promise;
      },
    }));
    const auto = coordinator.resume('codex', 'session-auto-read', {
      autoReadInitialAttention: true,
      rememberMainPageSession: false,
    });
    await flushAsyncWork();
    assert.deepStrictEqual(
      await coordinator.resume('codex', 'session-auto-read', {}),
      { error: CONFLICT_ERROR, status: 409 },
      'an auto-read recovery resume must not silently absorb an interactive resume intent',
    );
    assert.strictEqual(starts, 1, 'a conflicting resume intent must not create a second start');
    completion.resolve('agent-auto-read');
    assert.strictEqual((await auto).agentId, 'agent-auto-read');
  }
}

async function testHttpAdmissionSignature() {
  const joiningBodies: Array<[Record<string, unknown>, Record<string, unknown>]> = [
    [{}, {}],
    [{ agentRuntimeMode: 'chat' }, { agentRuntimeMode: 'acp' }],
    [{ agentRuntimeMode: 'shell' }, {}],
    [{ acpHistoryMode: 'unknown' }, { acpHistoryMode: 'load' }],
    [{ unarchiveArchived: false }, {}],
    [{ customTitle: 'same' }, { customTitle: 'same' }],
    [{ asMain: true, fork: true }, { fork: true, asMain: false }],
  ];
  for (const [leaderBody, followerBody] of joiningBodies) {
    const completion = deferred<string | null>();
    let starts = 0;
    const coordinator = new AgentSessionResumeCoordinator(basePorts({
      startAgent: () => {
        starts += 1;
        return completion.promise;
      },
    }));
    const leader = coordinator.resumeHttp('codex', 'session-join', leaderBody);
    await flushAsyncWork();
    const follower = coordinator.resumeHttp('codex', 'session-join', followerBody);
    await flushAsyncWork();
    assert.strictEqual(starts, 1, `${JSON.stringify(followerBody)} must join ${JSON.stringify(leaderBody)}`);
    completion.resolve('agent-join');
    assert.strictEqual((await leader).status, 201);
    assert.strictEqual((await follower).status, 200);
  }

  const conflictingBodies: Array<[Record<string, unknown>, Record<string, unknown>]> = [
    [{}, { customTitle: '' }],
    [{ customTitle: 'first' }, { customTitle: 'second' }],
    [{}, { agentRuntimeMode: 'chat' }],
    [{}, { acpHistoryMode: 'resume' }],
    [{}, { unarchiveArchived: true }],
    [{}, { fork: true }],
    [{}, { asMain: true }],
  ];
  for (const [leaderBody, followerBody] of conflictingBodies) {
    const completion = deferred<string | null>();
    let starts = 0;
    const coordinator = new AgentSessionResumeCoordinator(basePorts({
      startAgent: () => {
        starts += 1;
        return completion.promise;
      },
    }));
    const leader = coordinator.resumeHttp('codex', 'session-conflict', leaderBody);
    await flushAsyncWork();
    assert.deepStrictEqual(
      await coordinator.resumeHttp('codex', 'session-conflict', followerBody),
      { status: 409, body: { error: CONFLICT_ERROR } },
      `${JSON.stringify(followerBody)} must conflict with ${JSON.stringify(leaderBody)}`,
    );
    assert.strictEqual(starts, 1, 'a conflicting HTTP resume must not create a second start');
    completion.resolve('agent-conflict');
    assert.strictEqual((await leader).status, 201);
  }
}

async function testHttpSingleFlightEffects() {
  {
    const completion = deferred<string | null>();
    const events: string[] = [];
    let starts = 0;
    const coordinator = new AgentSessionResumeCoordinator(basePorts({
      mountProjectWorkspace: () => {
        events.push('mount');
        return { projectWorkspaces: ['/repo'], pinnedProjectWorkspaces: ['/pinned'] };
      },
      publishAgentState: () => { events.push('publish'); },
      rememberMainPageSession: () => { events.push('remember'); },
      startAgent: () => {
        starts += 1;
        return completion.promise;
      },
    }));
    const first = coordinator.resumeHttp('codex', 'session-http-success', {});
    await flushAsyncWork();
    const joined = coordinator.resumeHttp('codex', 'session-http-success', {});
    assert.strictEqual(starts, 1, 'same HTTP mutation must share one start');
    completion.resolve('agent-http-success');
    const [firstReply, joinedReply] = await Promise.all([first, joined]);
    assert.deepStrictEqual(firstReply, {
      status: 201,
      body: {
        agentId: 'agent-http-success',
        projectWorkspace: '/repo',
        projectWorkspaces: ['/repo'],
        pinnedProjectWorkspaces: ['/pinned'],
      },
    });
    assert.deepStrictEqual(joinedReply, {
      status: 200,
      body: {
        agentId: 'agent-http-success',
        projectWorkspace: '/repo',
        projectWorkspaces: ['/repo'],
        pinnedProjectWorkspaces: ['/pinned'],
        reused: true,
        pending: true,
      },
    }, 'a joined HTTP resume must report the pending reuse protocol, never the leader\'s 201');
    assert.deepStrictEqual(events, ['remember', 'mount', 'publish'], 'the leader must apply each HTTP effect once');
  }

  {
    const gate = deferred<void>();
    const events: string[] = [];
    let claiming = false;
    let starts = 0;
    const coordinator = new AgentSessionResumeCoordinator(basePorts({
      findAgentSession: async () => {
        await gate.promise;
        claiming = true;
        return { provider: 'codex', id: 'session-claim-join', cwd: '/repo', workspace: '/repo' };
      },
      getActiveAgents: () => (claiming
        ? [{ id: 'claimed-agent', cwd: '/repo', providerSessionKey: encodeProviderSessionKey('codex', 'session-claim-join', 'default'), status: 'running' }]
        : []),
      publishAgentState: () => { events.push('publish'); },
      startAgent: () => {
        starts += 1;
        return Promise.resolve('unexpected-agent');
      },
    }));
    const leader = coordinator.resumeHttp('codex', 'session-claim-join', {});
    const follower = coordinator.resumeHttp('codex', 'session-claim-join', {});
    await flushAsyncWork();
    gate.resolve();
    const [leaderReply, followerReply] = await Promise.all([leader, follower]);
    assert.strictEqual(starts, 0, 'a late-appearing claim must be reused instead of started again');
    assert.deepStrictEqual(leaderReply, {
      status: 200,
      body: {
        agentId: 'claimed-agent',
        projectWorkspace: '/repo',
        projectWorkspaces: ['/repo'],
        pinnedProjectWorkspaces: [],
        reused: true,
        claimed: true,
      },
    });
    assert.deepStrictEqual(followerReply, {
      status: 200,
      body: {
        agentId: 'claimed-agent',
        projectWorkspace: '/repo',
        projectWorkspaces: ['/repo'],
        pinnedProjectWorkspaces: [],
        reused: true,
        claimed: true,
        pending: true,
      },
    });
    assert.deepStrictEqual(events, ['publish']);
  }

  {
    const completion = deferred<string | null>();
    const events: string[] = [];
    const archived: string[] = [];
    let starts = 0;
    const coordinator = new AgentSessionResumeCoordinator(basePorts({
      archiveNewAgent: async agentId => {
        events.push('archive');
        archived.push(agentId);
        return null;
      },
      mountProjectWorkspace: () => {
        events.push('mount');
        throw new Error('shared mount failed');
      },
      publishAgentState: () => { events.push('publish'); },
      removeMainPageSession: () => { events.push('forget'); },
      startAgent: () => {
        starts += 1;
        return completion.promise;
      },
    }));
    const first = coordinator.resumeHttp('codex', 'session-http-failure', {});
    await flushAsyncWork();
    const joined = coordinator.resumeHttp('codex', 'session-http-failure', {});
    completion.resolve('agent-http-failure');
    const [firstReply, joinedReply] = await Promise.all([first, joined]);
    assert.deepStrictEqual(firstReply, { status: 500, body: { error: 'shared mount failed' } });
    assert.deepStrictEqual(
      joinedReply,
      firstReply,
      'joined HTTP resumes must share one outcome so one cannot succeed while the other archives the Agent',
    );
    assert.strictEqual(starts, 1);
    assert.deepStrictEqual(archived, ['agent-http-failure']);
    assert.deepStrictEqual(events, ['mount', 'archive', 'forget', 'publish']);
  }

  {
    const events: string[] = [];
    const coordinator = new AgentSessionResumeCoordinator(basePorts({
      archiveNewAgent: async () => {
        events.push('archive');
        return { error: 'engine still running' };
      },
      mountProjectWorkspace: () => { throw new Error('mount failed'); },
      publishAgentState: () => { events.push('publish'); },
      removeMainPageSession: () => { events.push('forget'); },
    }));
    assert.deepStrictEqual(await coordinator.resumeHttp('codex', 'session-rollback-failed', {}), {
      status: 500,
      body: {
        error: 'mount failed. Rollback failed: engine still running',
        rollbackError: 'engine still running',
      },
    });
    assert.deepStrictEqual(events, ['archive', 'publish'], 'a failed rollback must keep the remembered session');
  }

  {
    const events: string[] = [];
    const coordinator = new AgentSessionResumeCoordinator(basePorts({
      archiveNewAgent: async () => {
        events.push('archive');
        return null;
      },
      getMainPageSessionKeys: () => [encodeProviderSessionKey('codex', 'session-already-remembered', 'default')],
      mountProjectWorkspace: () => { throw new Error('mount failed'); },
      publishAgentState: () => { events.push('publish'); },
      removeMainPageSession: () => { events.push('forget'); },
    }));
    assert.strictEqual((await coordinator.resumeHttp('codex', 'session-already-remembered', {})).status, 500);
    assert.deepStrictEqual(events, ['archive', 'publish'], 'rollback must not forget a session the user already had');
  }

  {
    const events: string[] = [];
    const coordinator = new AgentSessionResumeCoordinator(basePorts({
      getActiveAgents: () => [{
        id: 'claimed-agent',
        cwd: '/repo',
        providerSessionKey: encodeProviderSessionKey('codex', 'session-alpha', 'default'),
        status: 'running',
      }],
      archiveNewAgent: async () => {
        events.push('archive');
        return null;
      },
      mountProjectWorkspace: () => {
        throw new Error('mount failed');
      },
      publishAgentState: () => { events.push('publish'); },
      removeMainPageSession: () => { events.push('forget'); },
    }));
    assert.deepStrictEqual(await coordinator.resumeHttp('codex', 'session-alpha', {}), {
      status: 500,
      body: { error: 'mount failed' },
    });
    assert.deepStrictEqual(
      events,
      ['publish'],
      'a reused Agent must never be archived or forgotten by another request\'s mount rollback',
    );
  }
}

async function testStartCompletionChannels() {
  {
    const coordinator = new AgentSessionResumeCoordinator(basePorts({
      startAgent: () => { throw new Error('sync start failure'); },
    }));
    assert.deepStrictEqual(await coordinator.resumeHttp('codex', 'session-sync-throw', {}), {
      status: 500,
      body: { error: 'sync start failure' },
    });
  }

  {
    const coordinator = new AgentSessionResumeCoordinator(basePorts({
      startAgent: () => Promise.resolve('agent-returned-id'),
    }));
    const reply = await coordinator.resumeHttp('codex', 'session-returned-id', {});
    assert.strictEqual(reply.status, 201);
    assert.strictEqual(reply.body.agentId, 'agent-returned-id');
  }

  for (const resolved of [null, '']) {
    const coordinator = new AgentSessionResumeCoordinator(basePorts({
      startAgent: () => Promise.resolve(resolved),
    }));
    assert.deepStrictEqual(await coordinator.resumeHttp('codex', 'session-missing-id', {}), {
      status: 500,
      body: { error: 'failed to resume agent session' },
    }, `a start settling ${JSON.stringify(resolved)} must be a terminal failure`);
  }

  {
    const coordinator = new AgentSessionResumeCoordinator(basePorts({
      startAgent: () => Promise.reject(new Error('start rejected')),
    }));
    assert.deepStrictEqual(await coordinator.resumeHttp('codex', 'session-rejected', {}), {
      status: 500,
      body: { error: 'start rejected' },
    });
  }

  {
    const coordinator = new AgentSessionResumeCoordinator(basePorts({
      startAgent: (_command, _workspace, callback) => {
        callback(null, 'agent refused to start');
        return Promise.resolve(null);
      },
    }));
    assert.deepStrictEqual(await coordinator.resumeHttp('codex', 'session-callback-error', {}), {
      status: 400,
      body: { error: 'agent refused to start' },
    });
  }

  {
    const coordinator = new AgentSessionResumeCoordinator(basePorts({
      startAgent: (_command, _workspace, callback) => {
        callback(null);
        return Promise.resolve(null);
      },
    }));
    assert.deepStrictEqual(await coordinator.resumeHttp('codex', 'session-callback-no-id', {}), {
      status: 500,
      body: { error: 'failed to resume agent session' },
    });
  }

  {
    const coordinator = new AgentSessionResumeCoordinator(basePorts({
      startAgent: (_command, _workspace, callback) => {
        callback('agent-first-callback');
        callback(null, 'a second callback outcome');
        callback('agent-third-callback');
        return Promise.resolve('agent-different-resolution');
      },
    }));
    const reply = await coordinator.resumeHttp('codex', 'session-repeated-outcomes', {});
    await drainAsyncWork();
    assert.deepStrictEqual(reply, {
      status: 201,
      body: {
        agentId: 'agent-first-callback',
        projectWorkspace: '/repo',
        projectWorkspaces: ['/repo'],
        pinnedProjectWorkspaces: [],
      },
    }, 'a start must settle exactly once on its first delivered outcome');
  }

  {
    const coordinator = new AgentSessionResumeCoordinator(basePorts({
      startAgent: (_command, _workspace, callback) => {
        callback('agent-first-outcome');
        return Promise.reject(new Error('late start rejection'));
      },
    }));
    const reply = await coordinator.resumeHttp('codex', 'session-callback-then-reject', {});
    await drainAsyncWork();
    assert.strictEqual(reply.status, 201, 'a late rejection must not flip a delivered start success');
    assert.strictEqual(reply.body.agentId, 'agent-first-outcome');
  }

  {
    const lateCallbacks: StartCallback[] = [];
    const coordinator = new AgentSessionResumeCoordinator(basePorts({
      startAgent: (_command, _workspace, callback) => {
        lateCallbacks.push(callback);
        return Promise.reject(new Error('start rejected first'));
      },
    }));
    const reply = await coordinator.resumeHttp('codex', 'session-reject-then-callback', {});
    assert.deepStrictEqual(reply, { status: 500, body: { error: 'start rejected first' } });
    lateCallbacks[0]('agent-too-late');
    await drainAsyncWork();
    assert.deepStrictEqual(reply, { status: 500, body: { error: 'start rejected first' } });
  }
}

async function testTerminalFailuresReleaseAdmission() {
  {
    let lookups = 0;
    const coordinator = new AgentSessionResumeCoordinator(basePorts({
      findAgentSession: async () => {
        lookups += 1;
        throw new Error('lookup failed');
      },
    }));
    assert.deepStrictEqual(await coordinator.resumeHttp('codex', 'session-lookup-failure', {}), {
      status: 500,
      body: { error: 'lookup failed' },
    });
    assert.deepStrictEqual(await coordinator.resumeHttp('codex', 'session-lookup-failure', {}), {
      status: 500,
      body: { error: 'lookup failed' },
    });
    assert.strictEqual(lookups, 2, 'a failed resume must release its admission for the next attempt');
  }

  {
    const coordinator = new AgentSessionResumeCoordinator(basePorts({
      canonicalProjectWorkspace: async () => { throw new Error('canonical failed'); },
    }));
    assert.deepStrictEqual(await coordinator.resumeHttp('codex', 'session-canonical-failure', {}), {
      status: 500,
      body: { error: 'canonical failed' },
    });
  }

  {
    const coordinator = new AgentSessionResumeCoordinator(basePorts({
      canonicalProjectWorkspace: async () => { throw new Error('canonical reuse failed'); },
      getActiveAgents: () => [{
        id: 'claimed-agent',
        cwd: '/repo',
        providerSessionKey: encodeProviderSessionKey('codex', 'session-alpha', 'default'),
        status: 'running',
      }],
    }));
    assert.deepStrictEqual(await coordinator.resumeHttp('codex', 'session-alpha', {}), {
      status: 500,
      body: { error: 'canonical reuse failed' },
    });
  }

  {
    const coordinator = new AgentSessionResumeCoordinator(basePorts({
      ensureCodexSessionAvailable: async () => { throw new Error('unarchive crashed'); },
    }));
    assert.deepStrictEqual(
      await coordinator.resumeHttp('codex', 'session-unarchive-crash', { unarchiveArchived: true }),
      { status: 500, body: { error: 'unarchive crashed' } },
    );
  }

  {
    let starts = 0;
    let published = 0;
    const coordinator = new AgentSessionResumeCoordinator(basePorts({
      publishAgentState: () => { published += 1; },
      rememberMainPageSession: () => { throw new Error('settings write failed'); },
      startAgent: (_command, _workspace, callback) => {
        starts += 1;
        callback('agent-remember-failure');
        return Promise.resolve('agent-remember-failure');
      },
    }));
    assert.deepStrictEqual(await coordinator.resume('codex', 'session-remember-failure', {}), {
      error: 'settings write failed',
      status: 500,
    });
    assert.deepStrictEqual(await coordinator.resumeHttp('codex', 'session-remember-failure', {}), {
      status: 500,
      body: { error: 'settings write failed' },
    }, 'a failed main-page remember must be a bounded HTTP failure rather than an escaping exception');
    assert.strictEqual(published, 0, 'a resume that never reached its Project mount must not publish a state change');
    assert.strictEqual(starts, 2, 'a failed remember must release the admission for the next attempt');
  }
}

async function testArchivedAndUnarchiveSemantics() {
  {
    let starts = 0;
    const removed: string[] = [];
    const coordinator = new AgentSessionResumeCoordinator(basePorts({
      findAgentSession: async () => ({
        provider: 'codex', id: 'archived-session', providerName: 'Codex', archived: true,
      }),
      removeMainPageSession: (provider, sessionId, providerHomeId) => {
        removed.push(`${provider}:${providerHomeId}:${sessionId}`);
      },
      startAgent: () => {
        starts += 1;
        return Promise.resolve(null);
      },
    }));
    assert.deepStrictEqual(await coordinator.resume('codex', 'archived-session'), {
      error: 'Codex session is archived. Unarchive it before resuming.', status: 409, archived: true,
    });
    assert.strictEqual(starts, 0, 'archived history must fail before creating a new Agent');
    assert.deepStrictEqual(removed, ['codex:default:archived-session']);
  }

  {
    const unarchiveCalls: Array<Record<string, unknown>> = [];
    let lookups = 0;
    const coordinator = new AgentSessionResumeCoordinator(basePorts({
      ensureCodexSessionAvailable: async (sessionId, options) => {
        unarchiveCalls.push({ sessionId, ...options, providerHomes: undefined });
        return null;
      },
      findAgentSession: async () => {
        lookups += 1;
        return {
          provider: 'codex',
          id: 'session-unarchive',
          providerName: 'Codex',
          archived: lookups === 1,
          cwd: '/repo',
          workspace: '/repo',
          providerHomeId: 'default',
          providerHomePath: '/homes/codex',
        };
      },
    }));
    const reply = await coordinator.resumeHttp('codex', 'session-unarchive', { unarchiveArchived: true });
    assert.strictEqual(reply.status, 201);
    assert.strictEqual(lookups, 2, 'unarchive must re-read authoritative history before resuming');
    assert.deepStrictEqual(unarchiveCalls, [{
      sessionId: 'session-unarchive',
      providerHomeId: 'default',
      providerHomePath: '/homes/codex',
      providerHomes: undefined,
      cwd: '/repo',
    }]);
  }

  {
    let starts = 0;
    const coordinator = new AgentSessionResumeCoordinator(basePorts({
      ensureCodexSessionAvailable: async () => ({ error: 'codex refused to unarchive' }),
      findAgentSession: async () => ({
        provider: 'codex', id: 'session-unarchive-error', providerName: 'Codex', archived: true,
      }),
      startAgent: () => {
        starts += 1;
        return Promise.resolve(null);
      },
    }));
    assert.deepStrictEqual(
      await coordinator.resumeHttp('codex', 'session-unarchive-error', { unarchiveArchived: true }),
      { status: 400, body: { error: 'codex refused to unarchive' } },
    );
    assert.strictEqual(starts, 0);
  }
}

async function testForkAndMainSemantics() {
  {
    let lookups = 0;
    const coordinator = new AgentSessionResumeCoordinator(basePorts({
      findAgentSession: async () => {
        lookups += 1;
        return null;
      },
    }));
    assert.deepStrictEqual(await coordinator.resumeHttp('qwen', 'session-fork-unsupported', { fork: true }), {
      status: 400,
      body: { error: 'qwen does not support session Fork' },
    });
    assert.strictEqual(lookups, 0, 'an unsupported Fork must fail before reading history');
  }

  {
    const events: string[] = [];
    let startOptions: StartOptions | null = null;
    const coordinator = new AgentSessionResumeCoordinator(basePorts({
      findAgentSession: async () => ({
        provider: 'codex', id: 'session-fork', archived: true, cwd: '/repo', workspace: '/repo', title: 'Forked',
      }),
      getSavedAgentSession: () => ({ id: 'persisted-1', customTitle: 'Saved title' }),
      publishAgentState: () => { events.push('publish'); },
      rememberMainPageSession: () => { events.push('remember'); },
      startAgent: (_command, _workspace, callback, options) => {
        startOptions = options;
        callback('agent-fork');
        return Promise.resolve('agent-fork');
      },
    }));
    const reply = await coordinator.resumeHttp('codex', 'session-fork', { fork: true });
    assert.strictEqual(reply.status, 201);
    assert.deepStrictEqual(events, ['publish'], 'a Fork must not be remembered as a main-page session');
    assert.strictEqual(
      startOptions!.source,
      encodeResumedProviderSessionSource('codex', 'session-fork', 'default', { forked: true }),
    );
    assert.strictEqual(startOptions!.persistentSessionId, '', 'a Fork must not inherit the source session record');
    assert.strictEqual(startOptions!.customTitle, '');
  }

  {
    let starts = 0;
    const coordinator = new AgentSessionResumeCoordinator(basePorts({
      startAgent: () => {
        starts += 1;
        return Promise.resolve(null);
      },
    }));
    assert.deepStrictEqual(await coordinator.resumeHttp('codex', 'session-alpha', { asMain: true }), {
      status: 400,
      body: { error: 'session is not a Main Agent session' },
    });
    assert.strictEqual(starts, 0);
  }

  {
    const events: string[] = [];
    let startOptions: StartOptions | null = null;
    const coordinator = new AgentSessionResumeCoordinator(basePorts({
      findAgentSession: async () => ({
        provider: 'codex', id: 'session-main', cwd: '~/.farming', workspace: '~/.farming', title: 'Main',
      }),
      mountProjectWorkspace: () => {
        events.push('mount');
        return { projectWorkspaces: [], pinnedProjectWorkspaces: [] };
      },
      publishAgentState: () => { events.push('publish'); },
      rememberMainPageSession: () => { events.push('remember'); },
      startAgent: (_command, _workspace, callback, options) => {
        startOptions = options;
        callback('agent-main');
        return Promise.resolve('agent-main');
      },
    }));
    assert.deepStrictEqual(await coordinator.resumeHttp('codex', 'session-main', { asMain: true }), {
      status: 201,
      body: { agentId: 'agent-main', projectWorkspaces: [], pinnedProjectWorkspaces: [] },
    });
    assert.strictEqual(startOptions!.wantsMain, true);
    assert.strictEqual(startOptions!.projectWorkspace, '');
    assert.deepStrictEqual(events, ['publish'], 'a Main resume must not mount a Project or be remembered');
  }

  {
    let starts = 0;
    const coordinator = new AgentSessionResumeCoordinator(basePorts({
      getActiveAgents: () => [{
        id: 'claimed-agent',
        cwd: '/repo',
        projectWorkspace: '/repo',
        providerSessionKey: encodeProviderSessionKey('codex', 'session-alpha', 'default'),
        status: 'running',
      }],
      startAgent: () => {
        starts += 1;
        return Promise.resolve(null);
      },
    }));
    assert.deepStrictEqual(await coordinator.resumeHttp('codex', 'session-alpha', { asMain: true }), {
      status: 200,
      body: {
        agentId: 'claimed-agent',
        projectWorkspaces: [],
        pinnedProjectWorkspaces: [],
        reused: true,
      },
    }, 'an active claim keeps the existing Agent and reports no Project for a Main resume');
    assert.strictEqual(starts, 0);
  }

  {
    const coordinator = new AgentSessionResumeCoordinator(basePorts({
      canonicalProjectWorkspace: async workspace => (workspace ? `${workspace}/canonical` : ''),
      getActiveAgents: () => [{
        id: 'claimed-agent',
        cwd: '/repo',
        gitWorktree: { workspace: '/worktree' },
        providerSessionKey: encodeProviderSessionKey('codex', 'session-alpha', 'default'),
        status: 'running',
      }],
      mountProjectWorkspace: workspace => ({ projectWorkspaces: [workspace], pinnedProjectWorkspaces: [] }),
    }));
    assert.deepStrictEqual(await coordinator.resumeHttp('codex', 'session-alpha', {}), {
      status: 200,
      body: {
        agentId: 'claimed-agent',
        projectWorkspace: '/worktree/canonical',
        projectWorkspaces: ['/worktree/canonical'],
        pinnedProjectWorkspaces: [],
        reused: true,
      },
    });
  }
}

async function testStartOptionsFromSavedSession() {
  let startOptions: StartOptions | null = null;
  const savedLookups: string[] = [];
  const coordinator = new AgentSessionResumeCoordinator(basePorts({
    findAgentSession: async () => ({
      provider: 'codex',
      id: 'session-saved',
      cwd: '/repo/session',
      workspace: '/repo/session',
      title: 'History title',
      cliVersion: '1.2.3',
      providerHomeId: 'home-b',
      providerHomePath: '/homes/codex-b',
    }),
    getSavedAgentSession: (provider, sessionId, providerHomeId) => {
      savedLookups.push(`${provider}:${providerHomeId}:${sessionId}`);
      return {
        id: 'persisted-7',
        task: 'Saved task',
        workflowTemplate: 'template-a',
        customTitle: 'Saved title',
        projectWorkspace: '/repo/saved',
        providerSessionTitle: 'Saved provider title',
        pinned: true,
        projectOrder: 3,
        pinnedOrder: 1,
        attentionSeq: 5,
        readAttentionSeq: 5,
        readOutputSeq: 9,
      };
    },
    startAgent: (_command, _workspace, callback, options) => {
      startOptions = options;
      callback('agent-saved');
      return Promise.resolve('agent-saved');
    },
  }));
  assert.strictEqual((await coordinator.resumeHttp('codex', 'session-saved', {
    providerHomeId: 'home-a',
    customTitle: 'Requested title',
  })).status, 201);
  assert.deepStrictEqual(savedLookups, ['codex:home-b:session-saved'], 'the saved record follows the history home');
  assert.strictEqual(startOptions!.customTitle, 'Requested title');
  assert.strictEqual(startOptions!.customTitleExplicit, true);
  assert.strictEqual(startOptions!.task, 'Saved task');
  assert.strictEqual(startOptions!.workflowTemplate, 'template-a');
  assert.strictEqual(startOptions!.persistentSessionId, 'persisted-7');
  assert.strictEqual(startOptions!.providerSessionTitle, 'History title');
  assert.strictEqual(startOptions!.projectWorkspace, '/repo/saved');
  assert.strictEqual(startOptions!.providerHomeId, 'home-b');
  assert.strictEqual(startOptions!.providerHomePath, '/homes/codex-b');
  assert.strictEqual(startOptions!.requiredCliVersion, '1.2.3');
  assert.strictEqual(startOptions!.pinned, true);
  assert.strictEqual(
    startOptions!.source,
    encodeResumedProviderSessionSource('codex', 'session-saved', 'home-b'),
  );
  assert.strictEqual(startOptions!.preserveProviderSessionProfile, true);
  assert.strictEqual(startOptions!.autoReadInitialAttention, false);
  assert.strictEqual(startOptions!.agentRuntimeMode, 'terminal');
  assert.strictEqual(startOptions!.acpHistoryMode, 'load');

  const unreadCoordinator = new AgentSessionResumeCoordinator(basePorts({
    getSavedAgentSession: () => ({ attentionSeq: 4, readAttentionSeq: 2 }),
    startAgent: (_command, _workspace, callback, options) => {
      startOptions = options;
      callback('agent-unread');
      return Promise.resolve('agent-unread');
    },
  }));
  await unreadCoordinator.resume('codex', 'session-unread', { autoReadInitialAttention: true });
  assert.strictEqual(
    startOptions!.autoReadInitialAttention,
    false,
    'auto-resume must not silently mark unread attention as read',
  );
}

async function testAutoResume() {
  {
    const events: string[] = [];
    const starts: StartCallback[] = [];
    const completions: Array<ReturnType<typeof deferred<string | null>>> = [];
    const coordinator = new AgentSessionResumeCoordinator(basePorts({
      currentAgentSessions: async () => [{
        provider: 'codex', id: 'session-alpha', providerHomeId: 'default', cwd: '/repo', workspace: '/repo',
      }],
      getSettings: () => ({ mainPageSessionKeys: [encodeProviderSessionKey('codex', 'session-alpha', 'default')] }),
      publishAgentState: () => { events.push('publish'); },
      startAgent: (_command, _workspace, callback) => {
        starts.push(callback);
        const completion = deferred<string | null>();
        completions.push(completion);
        return completion.promise;
      },
      waitForAgentRecovery: async () => { events.push('recovered'); },
    }));
    const recovery = coordinator.autoResumeMainPageAgentSessions();
    await drainAsyncWork();
    assert.deepStrictEqual(events, ['recovered']);
    assert.strictEqual(starts.length, 1, 'auto recovery must use the same resume admission path');
    starts[0]('restored-agent');
    completions[0].resolve('restored-agent');
    await recovery;
    assert.deepStrictEqual(events, ['recovered', 'publish']);
  }

  {
    let catalogReads = 0;
    let starts = 0;
    const removed: string[] = [];
    const warnings: unknown[][] = [];
    const coordinator = new AgentSessionResumeCoordinator(basePorts({
      currentAgentSessions: async () => {
        catalogReads += 1;
        return [];
      },
      getSettings: () => ({ mainPageSessionKeys: [encodeProviderSessionKey('codex', 'session-alpha', 'default')] }),
      removeMainPageSession: (provider, sessionId) => { removed.push(`${provider}:${sessionId}`); },
      startAgent: () => {
        starts += 1;
        return Promise.resolve(null);
      },
      waitForAgentRecovery: async () => { throw new Error('Agent lifecycle recovery failed'); },
      warn: (...args) => { warnings.push(args); },
    }));
    await coordinator.autoResumeMainPageAgentSessions();
    await drainAsyncWork();
    assert.deepStrictEqual([catalogReads, starts, removed.length], [0, 0, 0], 'a failed recovery must stop auto-resume');
    assert.strictEqual(warnings.length, 1);
    assert.strictEqual(
      warnings[0][0],
      'Skipping main-page Agent session auto-resume after failed lifecycle recovery:',
    );
  }

  {
    let starts = 0;
    const removed: string[] = [];
    const coordinator = new AgentSessionResumeCoordinator(basePorts({
      currentAgentSessions: async () => [],
      getSettings: () => ({ mainPageSessionKeys: [encodeProviderSessionKey('codex', 'session-gone', 'default')] }),
      removeMainPageSession: (provider, sessionId, providerHomeId) => {
        removed.push(`${provider}:${providerHomeId}:${sessionId}`);
      },
      startAgent: () => {
        starts += 1;
        return Promise.resolve(null);
      },
    }));
    await coordinator.autoResumeMainPageAgentSessions();
    assert.deepStrictEqual(removed, ['codex:default:session-gone'], 'a session missing from the catalog must be dropped');
    assert.strictEqual(starts, 0);
  }

  {
    let starts = 0;
    const removed: string[] = [];
    const coordinator = new AgentSessionResumeCoordinator(basePorts({
      currentAgentSessions: async () => [{
        provider: 'codex', id: 'session-claimed', providerHomeId: 'default', cwd: '/repo',
      }],
      getActiveAgents: () => [{
        id: 'claimed-agent',
        cwd: '/repo',
        providerSessionKey: encodeProviderSessionKey('codex', 'session-claimed', 'default'),
        status: 'running',
      }],
      getSettings: () => ({ mainPageSessionKeys: [encodeProviderSessionKey('codex', 'session-claimed', 'default')] }),
      removeMainPageSession: (provider, sessionId) => { removed.push(`${provider}:${sessionId}`); },
      startAgent: () => {
        starts += 1;
        return Promise.resolve(null);
      },
    }));
    await coordinator.autoResumeMainPageAgentSessions();
    assert.deepStrictEqual([starts, removed.length], [0, 0], 'an already claimed session must be left alone');
  }

  {
    const removed: string[] = [];
    const warnings: unknown[][] = [];
    const coordinator = new AgentSessionResumeCoordinator(basePorts({
      currentAgentSessions: async () => [{
        provider: 'qoder', id: 'session-stale', providerHomeId: 'default', cwd: '/repo',
      }],
      findAgentSession: async () => ({
        provider: 'qoder', id: 'session-stale', cwd: '/repo', workspace: '/repo',
      }),
      getSettings: () => ({ mainPageSessionKeys: [encodeProviderSessionKey('qoder', 'session-stale', 'default')] }),
      removeMainPageSession: (provider, sessionId, providerHomeId) => {
        removed.push(`${provider}:${providerHomeId}:${sessionId}`);
      },
      startAgent: (_command, _workspace, callback) => {
        callback(null, 'Invalid session identifier');
        return Promise.resolve(null);
      },
      warn: (...args) => { warnings.push(args); },
    }));
    await coordinator.autoResumeMainPageAgentSessions();
    assert.deepStrictEqual(removed, ['qoder:default:session-stale']);
    assert.strictEqual(warnings[0][0], 'Dropping stale qoder session from auto-resume:');
  }

  {
    const warnings: unknown[][] = [];
    let published = 0;
    const coordinator = new AgentSessionResumeCoordinator(basePorts({
      currentAgentSessions: async () => [{
        provider: 'codex', id: 'session-broken', providerHomeId: 'default', cwd: '/repo',
      }],
      getSettings: () => ({ mainPageSessionKeys: [encodeProviderSessionKey('codex', 'session-broken', 'default')] }),
      publishAgentState: () => { published += 1; },
      startAgent: (_command, _workspace, callback) => {
        callback(null, 'engine unavailable');
        return Promise.resolve(null);
      },
      warn: (...args) => { warnings.push(args); },
    }));
    await coordinator.autoResumeMainPageAgentSessions();
    assert.strictEqual(warnings[0][0], 'Failed to auto-resume main page agent session:');
    assert.strictEqual(published, 0, 'a fully failed auto-resume must not publish a state change');
  }

  {
    const warnings: unknown[][] = [];
    const coordinator = new AgentSessionResumeCoordinator(basePorts({
      currentAgentSessions: async () => { throw new Error('catalog unavailable'); },
      getSettings: () => ({ mainPageSessionKeys: [encodeProviderSessionKey('codex', 'session-alpha', 'default')] }),
      warn: (...args) => { warnings.push(args); },
    }));
    await coordinator.autoResumeMainPageAgentSessions();
    assert.deepStrictEqual(warnings, [[
      'Failed to load Agent session catalog for auto-resume:',
      'catalog unavailable',
    ]]);
  }
}

async function run() {
  const unhandled: unknown[] = [];
  process.on('unhandledRejection', reason => { unhandled.push(reason); });

  await testInvalidRequestBoundary();
  await testProviderHomeNormalization();
  await testCrossChannelAdmissionJoin();
  await testStartAdmissionSignature();
  await testHttpAdmissionSignature();
  await testHttpSingleFlightEffects();
  await testStartCompletionChannels();
  await testTerminalFailuresReleaseAdmission();
  await testArchivedAndUnarchiveSemantics();
  await testForkAndMainSemantics();
  await testStartOptionsFromSavedSession();
  await testAutoResume();

  await drainAsyncWork();
  assert.deepStrictEqual(unhandled, [], 'resume coordination must never leave an unhandled rejection');

  console.log('agent session resume coordinator tests passed');
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
