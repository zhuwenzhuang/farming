const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { AcpRuntime, acpErrorKind, acpSessionRequestOptions, autoPermissionResponse, codexAcpEnvironment, deleteProviderSessionIdentity, promptContentForCapabilities, resolveAcpLaunch, supportsCodexSteer } = require('../acp-runtime');
const { AcpSessionState } = require('../acp-session-state');

async function run() {
  assert.strictEqual(acpErrorKind(new Error('401 Unauthorized: sign in required')), 'authentication');
  assert.strictEqual(acpErrorKind(new Error('Input exceeds the context window')), 'context');
  assert.strictEqual(acpErrorKind(new Error('429 rate limit exceeded')), 'rate-limit');
  assert.strictEqual(acpErrorKind(new Error('socket connection timed out')), 'network');
  assert.strictEqual(acpErrorKind(new Error('unexpected failure')), 'unknown');
  assert.strictEqual(resolveAcpLaunch('codex').version, '1.1.4');
  assert.strictEqual(resolveAcpLaunch('claude').version, '0.59.0');
  assert.strictEqual(supportsCodexSteer({
    _meta: { codex: { steer: { method: '_codex/session/steer', version: 1 } } },
  }), true);
  assert.strictEqual(supportsCodexSteer({
    _meta: { codex: { steer: { method: '_codex/session/steer', version: 0 } } },
  }), false);
  let unsafeConnectionClose;
  const unsafeConnectionClosed = new Promise(resolve => {
    unsafeConnectionClose = resolve;
  });
  const unsafeConnectionSignal = { aborted: false };
  const unsafeIdentityDeletes = [];
  const unsafeSessionRuntime = new AcpRuntime({
    resolveLaunch() {
      return {
        command: process.execPath,
        args: ['-e', "process.stdin.resume(); process.stdin.on('end', () => process.exit(0))"],
        version: 'native',
      };
    },
    async createConnection() {
      return {
        signal: unsafeConnectionSignal,
        closed: unsafeConnectionClosed,
        async initialize() {
          return {
            protocolVersion: 1,
            agentCapabilities: { sessionCapabilities: {} },
            agentInfo: { name: 'unsafe-id-test', version: '1' },
          };
        },
        async newSession() {
          return { sessionId: '--help' };
        },
        close() {
          unsafeConnectionSignal.aborted = true;
          unsafeConnectionClose();
        },
      };
    },
    async deleteProviderSessionIdentity(identity) {
      unsafeIdentityDeletes.push(identity);
    },
  });
  let unsafeSessionError = null;
  await assert.rejects(
    unsafeSessionRuntime.createSessionIdentity({
      provider: 'opencode',
      executable: 'opencode',
      cwd: process.cwd(),
      env: process.env,
    }),
    error => {
      unsafeSessionError = error;
      return /invalid resumable session id/.test(error.message);
    },
  );
  assert.strictEqual(unsafeIdentityDeletes.length, 0, 'an unsafe provider id must never reach CLI deletion');
  assert.strictEqual(unsafeSessionError.providerSessionIdentity?.sessionId, '--help');
  assert.strictEqual(unsafeSessionError.providerSessionIdentity?.producerStopped, true);
  await assert.rejects(
    deleteProviderSessionIdentity({
      provider: 'opencode',
      executable: '/path/that/must/not/run',
      sessionId: '--help',
    }),
    /safe exact session id/,
  );
  await unsafeSessionRuntime.dispose();
  let oldInitializeStarted;
  const oldInitializeReady = new Promise(resolve => {
    oldInitializeStarted = resolve;
  });
  let rejectOldInitialize;
  let connectionSequence = 0;
  const stalePrepareRuntime = new AcpRuntime({
    resolveLaunch() {
      return {
        command: process.execPath,
        args: ['-e', 'process.stdin.resume()'],
        version: 'test',
      };
    },
    async createConnection() {
      const connectionId = ++connectionSequence;
      const signal = { aborted: false };
      return {
        signal,
        closed: new Promise(() => {}),
        initialize() {
          if (connectionId === 1) {
            oldInitializeStarted();
            return new Promise((_, reject) => {
              rejectOldInitialize = reject;
            });
          }
          return Promise.resolve({
            protocolVersion: 1,
            agentCapabilities: { sessionCapabilities: {} },
            agentInfo: { name: 'replacement', version: '1' },
          });
        },
        newSession() {
          return Promise.resolve({ sessionId: 'replacement-session' });
        },
        close() {
          signal.aborted = true;
        },
      };
    },
  });
  const stalePreparation = stalePrepareRuntime.prepareAgent({
    agentId: 'agent-stale-preparation',
    provider: 'codex',
    cwd: process.cwd(),
    env: process.env,
  });
  await oldInitializeReady;
  stalePrepareRuntime.unregisterAgent('agent-stale-preparation');
  const replacementPreparation = await stalePrepareRuntime.prepareAgent({
    agentId: 'agent-stale-preparation',
    provider: 'codex',
    cwd: process.cwd(),
    env: process.env,
  });
  rejectOldInitialize(new Error('old initialize failed'));
  await assert.rejects(stalePreparation, /old initialize failed/);
  assert.strictEqual(replacementPreparation.sessionId, 'replacement-session');
  assert.strictEqual(
    stalePrepareRuntime.getSession('agent-stale-preparation').sessionId,
    'replacement-session',
    'a detached preparation failure must not unregister its replacement binding',
  );
  await stalePrepareRuntime.dispose();

  const compatibleCodexLaunch = resolveAcpLaunch('codex', {
    runtimeEnv: {
      FARMING_NODE_BIN: '/opt/farming/node',
      FARMING_NODE_LD: '/opt/farming/lib/ld-2.28.so',
      FARMING_NODE_LIBRARY_PATH: '/opt/farming/lib',
    },
  });
  assert.strictEqual(compatibleCodexLaunch.command, '/opt/farming/lib/ld-2.28.so');
  assert.deepStrictEqual(compatibleCodexLaunch.args.slice(0, 3), [
    '--library-path',
    '/opt/farming/lib',
    '/opt/farming/node',
  ]);
  assert.match(compatibleCodexLaunch.args[3], /(?:dist\/acp\/codex-acp-1\.1\.4\.js|codex-acp\/dist\/index\.js)$/);
  const originalProcessPkg = process.pkg;
  try {
    process.pkg = { entrypoint: 'backend/farming-app-cli.pkg.js' };
    const packagedCodexLaunch = resolveAcpLaunch('codex');
    assert.strictEqual(packagedCodexLaunch.command, process.execPath);
    assert.deepStrictEqual(packagedCodexLaunch.args, ['--farming-codex-acp']);
  } finally {
    if (originalProcessPkg === undefined) delete process.pkg;
    else process.pkg = originalProcessPkg;
  }
  assert.deepStrictEqual(resolveAcpLaunch('opencode', { cwd: '/tmp/demo', executable: '/bin/opencode' }), {
    command: '/bin/opencode',
    args: ['acp', '--cwd', '/tmp/demo'],
    version: 'native',
  });
  assert.deepStrictEqual(resolveAcpLaunch('qoder', { executable: '/bin/qodercli' }), {
    command: '/bin/qodercli',
    args: ['--acp'],
    version: 'native',
  });
  assert.deepStrictEqual(autoPermissionResponse({
    options: [{ optionId: 'yes', kind: 'allow_once' }],
  }, 'full'), { outcome: { outcome: 'selected', optionId: 'yes' } });
  const codexEnv = codexAcpEnvironment({
    env: { KEEP: 'yes', CODEX_CONFIG: '{"existing":true}' },
    approvalMode: 'full',
    executable: '/opt/codex/bin/codex',
    model: 'gpt-5.5',
    reasoningEffort: 'xhigh',
    serviceTier: 'priority',
    farmingSystemPrompt: 'You are running in Farming.',
  });
  assert.strictEqual(codexEnv.KEEP, 'yes');
  assert.strictEqual(codexEnv.CODEX_PATH, '/opt/codex/bin/codex');
  assert.strictEqual(codexEnv.INITIAL_AGENT_MODE, 'agent-full-access');
  assert.deepStrictEqual(JSON.parse(codexEnv.CODEX_CONFIG), {
    existing: true,
    model: 'gpt-5.5',
    model_reasoning_effort: 'xhigh',
    service_tier: 'priority',
    developer_instructions: 'You are running in Farming.',
  });
  assert.strictEqual(codexAcpEnvironment({ env: {}, approvalMode: 'ask' }).INITIAL_AGENT_MODE, 'read-only');
  assert.deepStrictEqual(acpSessionRequestOptions({
    additionalDirectories: ['../shared', '../shared', '/tmp/absolute'],
    mcpServers: [{ name: 'docs', command: '/bin/docs-mcp', args: ['--stdio'] }],
  }, '/tmp/project'), {
    cwd: '/tmp/project',
    additionalDirectories: ['/tmp/shared', '/tmp/absolute'],
    mcpServers: [{ name: 'docs', command: '/bin/docs-mcp', args: ['--stdio'] }],
  });
  assert.deepStrictEqual(acpSessionRequestOptions({
    provider: 'claude',
    farmingSystemPrompt: 'You are running in Farming.',
  }, '/tmp/project')._meta, {
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      append: 'You are running in Farming.',
    },
  });
  assert.deepStrictEqual(resolveAcpLaunch('qoder', {
    executable: '/bin/qodercli',
    farmingSystemPrompt: 'You are running in Farming.',
  }), {
    command: '/bin/qodercli',
    args: ['--append-system-prompt', 'You are running in Farming.', '--acp'],
    version: 'native',
  });
  assert.deepStrictEqual(promptContentForCapabilities([
    { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png', path: '/tmp/screenshot.png' },
    { type: 'audio', data: 'YXVkaW8=', mimeType: 'audio/wav', path: '/tmp/note.wav' },
  ], { promptCapabilities: { image: true } }), [
    { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png', path: '/tmp/screenshot.png' },
    { type: 'text', text: 'Attached audio: note.wav\n\nAudio path: /tmp/note.wav' },
  ]);

  const state = new AcpSessionState({ provider: 'codex', sessionId: 's1', cwd: '/tmp' });
  state.apply({ sessionId: 's1', update: {
    sessionUpdate: 'user_message_chunk', messageId: 'u1', content: { type: 'text', text: 'hello' },
  } });
  state.apply({ sessionId: 's1', update: {
    sessionUpdate: 'agent_message_chunk', messageId: 'a1', content: { type: 'text', text: 'one' },
  } });
  state.apply({ sessionId: 's1', update: {
    sessionUpdate: 'agent_message_chunk', messageId: 'a1', content: { type: 'text', text: ' two' },
  } });
  state.apply({ sessionId: 's1', update: {
    sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Test', status: 'pending',
  } });
  state.apply({ sessionId: 's1', update: {
    sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', rawOutput: 'ok',
  } });
  const reduced = state.snapshot();
  assert.strictEqual(Object.prototype.hasOwnProperty.call(reduced, 'updates'), false);
  assert.strictEqual(state.snapshot({}, { includeUpdates: true }).updates.length, 5);
  assert.strictEqual(reduced.version, 2);
  assert.strictEqual(reduced.entries.length, 3);
  assert.strictEqual(reduced.entries[1].content[0].text, 'one two');
  assert.strictEqual(reduced.entries[2].status, 'completed');
  state.apply({ sessionId: 's1', update: {
    sessionUpdate: 'usage_update', used: 53_000, size: 200_000, cost: { amount: 0.045, currency: 'USD' },
  } });
  assert.deepStrictEqual(state.snapshot().usage, {
    sessionUpdate: 'usage_update', used: 53_000, size: 200_000, cost: { amount: 0.045, currency: 'USD' },
  });
  state.apply({ sessionId: 's1', update: {
    sessionUpdate: 'plan_update',
    plan: { type: 'items', planId: 'plan-1', entries: [{ content: 'Finish', status: 'in_progress' }] },
  } });
  assert.strictEqual(state.snapshot().entries.find(entry => entry.type === 'plan').plan.entries[0].content, 'Finish');
  state.apply({ sessionId: 's1', update: {
    sessionUpdate: 'context_compaction', compactionId: 'compact-1', status: 'in_progress',
  } });
  state.apply({ sessionId: 's1', update: {
    sessionUpdate: 'context_compaction_update', compactionId: 'compact-1', status: 'completed', summary: 'Kept parser findings',
  } });
  const explicitCompaction = state.snapshot().entries.find(entry => entry.id === 'compact-1');
  assert.strictEqual(explicitCompaction.status, 'completed');
  assert.strictEqual(explicitCompaction.summary, 'Kept parser findings');
  state.beginPrompt('limited');
  state.completePrompt('max_tokens');
  assert.strictEqual(state.snapshot().entries.at(-1).content[0].text, 'limited');
  assert(Number.isFinite(state.snapshot().entries.at(-1).turnStartedAt));
  assert(Number.isFinite(state.snapshot().entries.at(-1).turnCompletedAt));
  assert(Number.isFinite(state.snapshot().entries.at(-1).turnDurationMs));
  const fullSlice = state.transcriptSlice({ maxTurns: 1 });
  assert.strictEqual(fullSlice.delta, false);
  assert.strictEqual(fullSlice.entries[0].role, 'user');
  const beforeDeltaRevision = fullSlice.revision;
  state.apply({ sessionId: 's1', update: {
    sessionUpdate: 'agent_message_chunk', messageId: 'delta-answer', content: { type: 'text', text: 'delta' },
  } });
  const deltaSlice = state.transcriptSlice({ maxTurns: 1, sinceRevision: beforeDeltaRevision });
  assert.strictEqual(deltaSlice.delta, true);
  assert.strictEqual(deltaSlice.entries[0].role, 'user');
  assert.strictEqual(deltaSlice.entries.at(-1).content[0].text, 'delta');
  assert.deepStrictEqual(
    state.transcriptSlice({ sinceRevision: deltaSlice.revision }).entries,
    [],
  );
  const replacementState = new AcpSessionState({
    provider: 'codex', sessionId: 's1', cwd: '/tmp', revisionBase: 12, resetBeforeRevision: 12,
  });
  replacementState.apply({ sessionId: 's1', update: {
    sessionUpdate: 'user_message_chunk', messageId: 'replacement-user', content: { type: 'text', text: 'replacement' },
  } });
  const replacementSlice = replacementState.transcriptSlice({ sinceRevision: 12 });
  assert.strictEqual(replacementSlice.delta, false);
  assert.strictEqual(replacementSlice.entries[0].content[0].text, 'replacement');
  state.apply({ sessionId: 's1', update: {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'large-log-entry',
    status: 'completed',
    rawOutput: 'x'.repeat(40 * 1024),
  } });
  assert.strictEqual(state.snapshot({}, { includeUpdates: true }).updates.at(-1).update.truncated, true);
  const sanitizedState = new AcpSessionState({ provider: 'codex', sessionId: 's2', cwd: '/tmp' });
  sanitizedState.apply({ sessionId: 's2', update: {
    sessionUpdate: 'user_message_chunk',
    messageId: 'u2',
    content: { type: 'text', text: '<environment_context>secret</environment_context>\nvisible' },
  } });
  assert.strictEqual(sanitizedState.snapshot().entries[0].content[0].text, 'visible');
  assert.strictEqual(sanitizedState.snapshot().entries[0].internal, false);
  sanitizedState.apply({ sessionId: 's2', update: {
    sessionUpdate: 'agent_message_chunk',
    messageId: 'a2',
    content: {
      type: 'text',
      text: 'answer\n\n<oai-mem-citation>\n<citation_entries>MEMORY.md:1-2</citation_entries>\n<rollout_ids>thread-id</rollout_ids>\n</oai-mem-citation>',
    },
  } });
  assert.strictEqual(sanitizedState.snapshot().entries[1].content[0].text, 'answer');
  const historyImageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-acp-history-image-'));
  const historyImagePath = path.join(historyImageDir, 'screen.png');
  const historyImageData = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';
  fs.writeFileSync(historyImagePath, Buffer.from(historyImageData, 'base64'));
  try {
    const historyImageState = new AcpSessionState({ provider: 'codex', sessionId: 'history-image', cwd: '/tmp' });
    historyImageState.apply({ sessionId: 'history-image', update: {
      sessionUpdate: 'user_message_chunk',
      messageId: 'history-image-user',
      content: {
        type: 'text',
        text: `# Files mentioned by the user:\n\n## screen.png: ${historyImagePath}\n\n## My request for Codex:\n请检查截图\n[@screen.png](file://${historyImagePath})[@image](${historyImagePath})`,
      },
    } });
    assert.strictEqual(historyImageState.hasCodexHistoryImageReferences(), true);
    assert.strictEqual(await historyImageState.hydrateCodexHistoryAttachments(), 1);
    const historyImageEntry = historyImageState.snapshot().entries[0];
    assert.strictEqual(historyImageEntry.content[0].text, '请检查截图');
    assert.deepStrictEqual(historyImageEntry.content[1], {
      type: 'image', mimeType: 'image/png', data: historyImageData,
    });

    const missingImagePath = path.join(historyImageDir, 'removed.png');
    const fallbackImageState = new AcpSessionState({ provider: 'codex', sessionId: 'fallback-image', cwd: '/tmp' });
    fallbackImageState.apply({ sessionId: 'fallback-image', update: {
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: `看旧截图\n[@image](${missingImagePath})` },
    } });
    assert.strictEqual(await fallbackImageState.hydrateCodexHistoryAttachments({
      imageDataByPath: new Map([[missingImagePath, `data:image/png;base64,${historyImageData}`]]),
    }), 1);
    assert.strictEqual(fallbackImageState.snapshot().entries[0].content[0].text, '看旧截图');
    assert.strictEqual(fallbackImageState.snapshot().entries[0].content[1].data, historyImageData);
  } finally {
    fs.rmSync(historyImageDir, { recursive: true, force: true });
  }
  const phasedState = new AcpSessionState({ provider: 'codex', sessionId: 'phased', cwd: '/tmp' });
  phasedState.apply({ sessionId: 'phased', update: {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'working' },
    _meta: { codex: { phase: 'commentary' } },
  } });
  phasedState.apply({ sessionId: 'phased', update: {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'final answer' },
    _meta: { codex: { phase: 'final_answer' } },
  } });
  const phasedEntries = phasedState.snapshot().entries;
  assert.strictEqual(phasedEntries.length, 2, 'phase boundaries must not merge when history chunks omit message ids');
  assert.strictEqual(phasedEntries[0]._meta.codex.phase, 'commentary');
  assert.strictEqual(phasedEntries[1]._meta.codex.phase, 'final_answer');
  const mirroredFinalState = new AcpSessionState({ provider: 'codex', sessionId: 'mirrored-final', cwd: '/tmp' });
  mirroredFinalState.apply({ sessionId: 'mirrored-final', update: {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'Visible final answer.' },
    _meta: { codex: { phase: 'final_answer' } },
  } });
  mirroredFinalState.apply({ sessionId: 'mirrored-final', update: {
    sessionUpdate: 'agent_message_chunk',
    messageId: 'app-server-final',
    content: { type: 'text', text: [
      'Visible final answer.',
      '<oai-mem-citation>',
      '<citation_entries>MEMORY.md:1-2|note=[source]</citation_entries>',
      '<rollout_ids></rollout_ids>',
      '</oai-mem-citation>',
    ].join('\n') },
    _meta: { codex: { phase: 'final_answer' } },
  } });
  const mirroredFinalEntries = mirroredFinalState.snapshot().entries;
  assert.strictEqual(mirroredFinalEntries.length, 1);
  assert.strictEqual(
    mirroredFinalEntries[0].content.map(item => item.text || '').join(''),
    'Visible final answer.',
    'App Server and JSONL fallback mirrors should not repeat the same sanitized final answer'
  );
  const handoffCompactionState = new AcpSessionState({ provider: 'codex', sessionId: 'handoff-compaction', cwd: '/tmp' });
  handoffCompactionState.apply({ sessionId: 'handoff-compaction', update: {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: '## Handoff Summary: Internal replay state\n\n### Suggested next steps\nDo not render this as an answer.' },
    _meta: { codex: { phase: 'final_answer' } },
  } });
  const handoffEntries = handoffCompactionState.snapshot().entries;
  assert.strictEqual(handoffEntries.length, 1);
  assert.strictEqual(handoffEntries[0].type, 'compaction');
  assert.strictEqual(handoffEntries[0].summary, '');
  const headingHandoffCompactionState = new AcpSessionState({ provider: 'codex', sessionId: 'heading-handoff-compaction', cwd: '/tmp' });
  headingHandoffCompactionState.apply({ sessionId: 'heading-handoff-compaction', update: {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: '## Handoff Summary\n\n### Goal / User Intent\nDo not render this as an answer.' },
    _meta: { codex: { phase: 'final_answer' } },
  } });
  const headingHandoffEntries = headingHandoffCompactionState.snapshot().entries;
  assert.strictEqual(headingHandoffEntries.length, 1);
  assert.strictEqual(headingHandoffEntries[0].type, 'compaction');
  assert.strictEqual(headingHandoffEntries[0].summary, '');
  const heartbeatState = new AcpSessionState({ provider: 'codex', sessionId: 's3', cwd: '/tmp' });
  heartbeatState.apply({ sessionId: 's3', update: {
    sessionUpdate: 'user_message_chunk',
    messageId: 'heartbeat-user',
    content: { type: 'text', text: '<heartbeat><automation_id>ci-watch</automation_id></heartbeat>' },
  } });
  heartbeatState.apply({ sessionId: 's3', update: {
    sessionUpdate: 'tool_call', toolCallId: 'heartbeat-tool', title: 'Check CI', status: 'completed',
  } });
  const heartbeatSnapshot = heartbeatState.snapshot();
  assert.strictEqual(heartbeatSnapshot.entries[0].internal, true);
  assert.strictEqual(heartbeatSnapshot.entries[0].content[0].text, '');
  assert.strictEqual(heartbeatSnapshot.entries[1].internal, true);
  const structuredState = new AcpSessionState({ provider: 'codex', sessionId: 's4', cwd: '/tmp' });
  structuredState.apply({ sessionId: 's4', update: {
    sessionUpdate: 'agent_message_chunk',
    messageId: 'compaction-1',
    content: { type: 'text', text: '*Context compacted to fit the model\'s context window.*' },
  } });
  structuredState.apply({ sessionId: 's4', update: {
    sessionUpdate: 'tool_call',
    toolCallId: 'subagent-1',
    title: 'Delegate review',
    status: 'completed',
    _meta: { subagent_session_info: { session_id: 'child-session', message_start_index: 1 } },
  } });
  assert.strictEqual(structuredState.snapshot().entries[0].type, 'compaction');
  assert.strictEqual(structuredState.snapshot().entries[1]._meta.subagent_session_info.session_id, 'child-session');

  const fixture = path.join(__dirname, 'fixtures', 'fake-acp-agent.mjs');
  const spawnedAdapters = [];
  const runtime = new AcpRuntime({
    spawn(command, args, options) {
      const child = spawn(command, args, options);
      spawnedAdapters.push(child);
      return child;
    },
    resolveLaunch() {
      return { command: process.execPath, args: [fixture], version: 'test' };
    },
  });
  try {
    const emittedSessions = [];
    runtime.on('session', event => emittedSessions.push(event));
    const preparing = runtime.prepareAgent({
      agentId: 'agent-acp-new',
      provider: 'codex',
      cwd: process.cwd(),
      env: process.env,
      approvalMode: 'full',
      serviceTier: 'priority',
    });
    const connectingSession = runtime.getSession('agent-acp-new');
    assert.strictEqual(connectingSession.state, 'connecting');
    assert.deepStrictEqual(connectingSession.entries, []);
    const prepared = await preparing;
    assert.strictEqual(prepared.sessionId, 'acp-new-session');
    assert.strictEqual(prepared.historyMode, 'new');
    const spawnedAdapterCountBeforeMissingForkCheckpoint = spawnedAdapters.length;
    await assert.rejects(
      runtime.prepareAgent({
        agentId: 'agent-acp-owned-fork-without-checkpoint',
        provider: 'claude',
        cwd: process.cwd(),
        env: process.env,
        approvalMode: 'full',
        forkSourceSessionId: 'existing-session',
      }),
      /requires an exact source checkpoint/,
      'an owned fork must fail closed when the fenced source transcript is unavailable',
    );
    assert.strictEqual(
      spawnedAdapters.length,
      spawnedAdapterCountBeforeMissingForkCheckpoint,
      'an invalid owned fork must be rejected before spawning an adapter process',
    );
    const exactForkSource = new AcpSessionState({
      provider: 'claude',
      sessionId: 'existing-session',
      cwd: process.cwd(),
    });
    exactForkSource.beginPrompt('exact fork source question');
    exactForkSource.apply({
      sessionId: 'existing-session',
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'exact-fork-answer',
        content: { type: 'text', text: 'exact fork source answer' },
      },
    });
    exactForkSource.completePrompt();
    exactForkSource.availableCommands = [{ name: 'source-only', description: 'Source command' }];
    const exactForkSubagent = new AcpSessionState({
      provider: 'claude',
      sessionId: 'exact-fork-subagent',
      cwd: process.cwd(),
    });
    exactForkSubagent.apply({
      sessionId: 'exact-fork-subagent',
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'exact-fork-subagent-answer',
        content: { type: 'text', text: 'exact fork subagent answer' },
      },
    });
    const exactForkCheckpoint = {
      version: 2,
      complete: false,
      sessionState: exactForkSource.exportCheckpoint(),
      subagentStates: [{
        sessionId: 'exact-fork-subagent',
        state: exactForkSubagent.exportCheckpoint(),
      }],
      patchDecisions: [['exact-fork-tool\nREADME.md', 'kept']],
      providerProof: { token: 'source-only-proof' },
    };
    let announcedOwnedForkSessionId = '';
    const ownedFork = await runtime.prepareAgent({
      agentId: 'agent-acp-owned-fork',
      provider: 'claude',
      cwd: process.cwd(),
      env: process.env,
      approvalMode: 'full',
      forkSourceSessionId: 'existing-session',
      forkSourceCheckpoint: exactForkCheckpoint,
      onForkSessionCreated: sessionId => {
        announcedOwnedForkSessionId = sessionId;
      },
    });
    assert.strictEqual(ownedFork.sessionId, 'acp-fork-session');
    assert.strictEqual(announcedOwnedForkSessionId, 'acp-fork-session');
    assert.strictEqual(ownedFork.historyMode, 'fork');
    const ownedForkSession = runtime.getSession('agent-acp-owned-fork');
    const ownedForkBinding = runtime.bindings.get('agent-acp-owned-fork');
    assert.strictEqual(ownedForkSession.sessionId, 'acp-fork-session');
    assert.strictEqual(ownedForkBinding.restartOptions.forkSourceSessionId, undefined);
    assert.strictEqual(ownedForkBinding.restartOptions.forkSourceCheckpoint, undefined);
    assert.strictEqual(ownedForkBinding.restartOptions.onForkSessionCreated, undefined);
    assert.strictEqual(ownedForkBinding.checkpointProof, null);
    assert.strictEqual(ownedForkSession.availableCommands.length, 0);
    assert.strictEqual(
      runtime.getSubagentTranscriptSession('agent-acp-owned-fork', 'exact-fork-subagent').entries[0].content[0].text,
      'exact fork subagent answer',
    );
    assert.strictEqual(
      runtime.getPatchDecision('agent-acp-owned-fork', 'exact-fork-tool', 'README.md'),
      'kept',
    );
    assert(
      ownedForkSession.entries.some(entry => (
        entry.role === 'assistant'
        && entry.content?.some(content => content.text === 'exact fork source answer')
      )),
      'an owned fork must expose the exact revision-fenced source transcript',
    );
    assert.strictEqual(
      ownedForkSession.entries.some(entry => (
        entry.content?.some(content => content.text === 'historical answer')
      )),
      false,
      'provider replay lag must not replace the exact fork source transcript',
    );
    const ownedForkPrompt = await runtime.prompt('agent-acp-owned-fork', 'continue owned fork');
    assert.strictEqual(ownedForkPrompt.sessionId, 'acp-fork-session');
    const bindingCountBeforeIdentity = runtime.bindings.size;
    const identity = await runtime.createSessionIdentity({
      provider: 'opencode',
      cwd: process.cwd(),
      env: process.env,
      approvalMode: 'full',
    });
    assert.strictEqual(identity.sessionId, 'acp-new-session');
    assert.strictEqual(identity.historyMode, 'new');
    assert.deepStrictEqual(identity.sessionRequestOptions, {
      cwd: process.cwd(),
      additionalDirectories: [],
      mcpServers: [],
    });
    const identityAdapter = spawnedAdapters.at(-1);
    assert(
      identityAdapter.exitCode !== null || identityAdapter.signalCode !== null,
      'one-shot identity creation must await adapter process exit',
    );
    if (process.platform !== 'win32') {
      assert.throws(
        () => process.kill(-identityAdapter.pid, 0),
        error => error?.code === 'ESRCH',
        'one-shot identity creation must leave no process in its owned process group',
      );
    }
    assert.strictEqual(
      runtime.bindings.size,
      bindingCountBeforeIdentity,
      'one-shot session identity creation must not retain an ACP binding',
    );
    const cleanupFailureRollbacks = [];
    const cleanupFailureRuntime = new AcpRuntime({
      resolveLaunch() {
        return { command: process.execPath, args: [fixture], version: 'test' };
      },
      async deleteProviderSessionIdentity(identity) {
        cleanupFailureRollbacks.push(identity);
      },
    });
    const cleanupFailureUnregister = cleanupFailureRuntime.unregisterAgentAndWait.bind(cleanupFailureRuntime);
    cleanupFailureRuntime.unregisterAgentAndWait = async agentId => {
      await cleanupFailureUnregister(agentId);
      throw new Error('simulated process-tree cleanup proof failure');
    };
    let cleanupFailureError = null;
    await assert.rejects(
      cleanupFailureRuntime.createSessionIdentity({
        provider: 'opencode',
        cwd: process.cwd(),
        env: process.env,
        approvalMode: 'full',
      }),
      error => {
        cleanupFailureError = error;
        return /simulated process-tree cleanup proof failure/.test(error.message);
      },
    );
    assert.strictEqual(
      cleanupFailureRollbacks.length,
      0,
      'a process cleanup proof failure must retain rather than delete the provider identity',
    );
    assert.strictEqual(
      cleanupFailureError.providerSessionIdentity?.producerStopped,
      false,
      'the retained identity must record that producer shutdown was not proven',
    );
    await cleanupFailureRuntime.dispose();
    assert.strictEqual(
      runtime.getSession('agent-acp-new').configOptions.find(option => option.id === 'fast-mode')?.currentValue,
      true,
      'the selected Fast launch profile should be applied through the negotiated ACP boolean option'
    );
    await runtime.prepareAgent({
      agentId: 'agent-acp-prompt-admission',
      provider: 'codex',
      cwd: process.cwd(),
      env: process.env,
      approvalMode: 'full',
    });
    const admittedPrompt = runtime.prompt('agent-acp-prompt-admission', 'first admitted prompt');
    await assert.rejects(
      runtime.prompt('agent-acp-prompt-admission', 'concurrent prompt'),
      /not ready/,
      'ACP must reserve prompt admission before its first asynchronous checkpoint operation',
    );
    assert.strictEqual((await admittedPrompt).stopReason, 'end_turn');
    await runtime.prepareAgent({
      agentId: 'agent-acp-close-race',
      provider: 'codex',
      cwd: process.cwd(),
      env: process.env,
      approvalMode: 'full',
    });
    const closeRaceBinding = runtime.bindings.get('agent-acp-close-race');
    let releaseClose;
    closeRaceBinding.connection.closeSession = () => new Promise(resolve => {
      releaseClose = resolve;
    });
    const closing = runtime.closeSession('agent-acp-close-race');
    await assert.rejects(
      runtime.prompt('agent-acp-close-race', 'must not race session close'),
      /not ready/,
      'a prompt must not enter while session close is in flight',
    );
    releaseClose({});
    assert.deepStrictEqual(await closing, { closed: true, sessionId: closeRaceBinding.sessionId });
    assert.strictEqual(runtime.getSession('agent-acp-close-race').state, 'closed');
    await assert.rejects(
      runtime.prompt('agent-acp-close-race', 'must not reopen a closed session'),
      /not ready/,
    );
    await assert.rejects(
      runtime.authenticate('agent-acp-close-race', 'fake-login'),
      /session is closed/,
    );
    assert.deepStrictEqual(runtime.requestPermission(closeRaceBinding, {
      sessionId: closeRaceBinding.sessionId,
      toolCall: { toolCallId: 'late-closed-tool', title: 'Late closed request' },
      options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
    }), { outcome: { outcome: 'cancelled' } });

    await runtime.prepareAgent({
      agentId: 'agent-acp-close-during-prompt',
      provider: 'codex',
      cwd: process.cwd(),
      env: process.env,
      approvalMode: 'full',
    });
    const activePrompt = runtime.prompt('agent-acp-close-during-prompt', 'mobile interrupt');
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (runtime.bindings.get('agent-acp-close-during-prompt').activeTurn?.phase === 'running') break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    await assert.rejects(
      runtime.closeSession('agent-acp-close-during-prompt'),
      /not ready/,
      'session close must not race an active prompt',
    );
    let promptRaceAuthenticationCalls = 0;
    const closeDuringPromptAuthenticate = runtime.bindings
      .get('agent-acp-close-during-prompt').connection.authenticate;
    runtime.bindings.get('agent-acp-close-during-prompt').connection.authenticate = async request => {
      promptRaceAuthenticationCalls += 1;
      return closeDuringPromptAuthenticate.call(
        runtime.bindings.get('agent-acp-close-during-prompt').connection,
        request,
      );
    };
    await assert.rejects(
      runtime.authenticate('agent-acp-close-during-prompt', 'fake-login'),
      /not ready/,
      'authentication must not race an active prompt',
    );
    assert.strictEqual(
      promptRaceAuthenticationCalls,
      0,
      'authentication must be rejected before any provider side effect',
    );
    await runtime.cancel('agent-acp-close-during-prompt');
    assert.strictEqual((await activePrompt).stopReason, 'cancelled');
    assert.strictEqual(runtime.getSession('agent-acp-close-during-prompt').state, 'idle');

    await runtime.prepareAgent({
      agentId: 'agent-acp-config-isolation',
      provider: 'codex',
      cwd: process.cwd(),
      env: process.env,
      approvalMode: 'full',
    });
    const configBinding = runtime.bindings.get('agent-acp-config-isolation');
    configBinding.configOptions = [
      { id: 'toggle', name: 'Toggle', type: 'boolean', currentValue: false },
    ];
    configBinding.sessionState.configOptions = JSON.parse(JSON.stringify(configBinding.configOptions));
    let releaseConfig;
    configBinding.connection.setSessionConfigOption = params => new Promise(resolve => {
      releaseConfig = () => resolve({
        configOptions: [
          { id: 'toggle', name: 'Toggle', type: 'boolean', currentValue: params.value },
        ],
      });
    });
    const configChange = runtime.setSessionConfigOption('agent-acp-config-isolation', 'toggle', true);
    const promptAfterConfig = runtime.prompt('agent-acp-config-isolation', 'prompt after config');
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(configBinding.activeTurn?.phase, 'admitting');
    assert.strictEqual(configBinding.sessionState.entries.length, 0);
    releaseConfig();
    await configChange;
    assert.strictEqual((await promptAfterConfig).stopReason, 'end_turn');

    const providerConfig = new Map([['alpha', 'old-alpha'], ['beta', 'old-beta']]);
    configBinding.configOptions = [
      { id: 'alpha', name: 'Alpha', type: 'select', currentValue: 'old-alpha', options: [] },
      { id: 'beta', name: 'Beta', type: 'select', currentValue: 'old-beta', options: [] },
    ];
    configBinding.sessionState.configOptions = JSON.parse(JSON.stringify(configBinding.configOptions));
    configBinding.connection.setSessionConfigOption = async params => {
      if (params.configId === 'beta' && params.value === 'new-beta') {
        throw new Error('simulated second config failure');
      }
      providerConfig.set(params.configId, params.value);
      return {
        configOptions: [...providerConfig.entries()].map(([id, currentValue]) => ({
          id,
          name: id,
          type: 'select',
          currentValue,
          options: [],
        })),
      };
    };
    await assert.rejects(
      runtime.setSessionConfigOptions('agent-acp-config-isolation', [
        { configId: 'alpha', value: 'new-alpha' },
        { configId: 'beta', value: 'new-beta' },
      ]),
      /simulated second config failure/,
    );
    assert.deepStrictEqual([...providerConfig.entries()], [
      ['alpha', 'old-alpha'],
      ['beta', 'old-beta'],
    ]);
    assert.strictEqual(
      configBinding.configOptions.find(option => option.id === 'alpha').currentValue,
      'old-alpha',
    );

    const patchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-acp-patch-race-'));
    try {
      fs.writeFileSync(path.join(patchRoot, 'decision-keep.txt'), 'before keep\n');
      fs.writeFileSync(path.join(patchRoot, 'decision-revert.txt'), 'before revert\n');
      await runtime.prepareAgent({
        agentId: 'agent-acp-patch-race',
        provider: 'codex',
        cwd: patchRoot,
        env: process.env,
        approvalMode: 'full',
      });
      assert.strictEqual(
        (await runtime.prompt('agent-acp-patch-race', 'applied edit')).stopReason,
        'end_turn',
      );
      const revertPath = path.join(patchRoot, 'decision-revert.txt');
      const requestedRevertPath = runtime.getToolEntry('agent-acp-patch-race', 'decision-tool')
        .content.find(block => String(block.path || '').endsWith('decision-revert.txt')).path;
      const decisions = await Promise.allSettled([
        runtime.decidePatch('agent-acp-patch-race', 'decision-tool', requestedRevertPath, 'revert'),
        runtime.decidePatch('agent-acp-patch-race', 'decision-tool', requestedRevertPath, 'keep'),
      ]);
      assert.strictEqual(
        decisions.filter(result => result.status === 'fulfilled').length,
        1,
        decisions.map(result => result.status === 'rejected' ? result.reason?.message : result.value?.action).join(', '),
      );
      assert.strictEqual(decisions.filter(result => result.status === 'rejected').length, 1);
      assert.strictEqual(fs.readFileSync(revertPath, 'utf8'), 'before revert\n');
      assert.strictEqual(
        runtime.getPatchDecision('agent-acp-patch-race', 'decision-tool', requestedRevertPath),
        'reverted',
      );
      assert.strictEqual(
        (await runtime.decidePatch(
          'agent-acp-patch-race',
          'decision-tool',
          requestedRevertPath,
          'revert',
        )).action,
        'reverted',
        'repeating the committed decision must be idempotent',
      );
    } finally {
      await runtime.unregisterAgentAndWait('agent-acp-patch-race').catch(() => {});
      fs.rmSync(patchRoot, { recursive: true, force: true });
    }

    await runtime.prepareAgent({
      agentId: 'agent-acp-prompt-cancel',
      provider: 'codex',
      cwd: process.cwd(),
      env: process.env,
      approvalMode: 'full',
    });
    const markCheckpointDirty = runtime.markCheckpointDirty.bind(runtime);
    let releasePromptAdmission;
    let blockFirstPromptAdmission = true;
    runtime.markCheckpointDirty = async binding => {
      if (binding.agentId !== 'agent-acp-prompt-cancel') return markCheckpointDirty(binding);
      if (!blockFirstPromptAdmission) return markCheckpointDirty(binding);
      blockFirstPromptAdmission = false;
      await new Promise(resolve => {
        releasePromptAdmission = resolve;
      });
    };
    const cancelledAdmission = runtime.prompt('agent-acp-prompt-cancel', 'cancel before provider submission');
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(await runtime.cancel('agent-acp-prompt-cancel'), true);
    const replacementAfterAdmissionCancel = runtime.prompt(
      'agent-acp-prompt-cancel',
      'replacement after admission cancellation',
    );
    releasePromptAdmission();
    await assert.rejects(cancelledAdmission, /cancelled before submission/);
    assert.strictEqual((await replacementAfterAdmissionCancel).stopReason, 'end_turn');
    assert.deepStrictEqual(
      runtime.getSession('agent-acp-prompt-cancel').entries
        .filter(entry => entry.role === 'user')
        .map(entry => entry.content[0].text),
      ['replacement after admission cancellation'],
      'a cancelled admission must not clear or commit over the replacement Turn',
    );
    runtime.markCheckpointDirty = markCheckpointDirty;

    await runtime.prepareAgent({
      agentId: 'agent-acp-steer-completion-race',
      provider: 'codex',
      cwd: process.cwd(),
      env: process.env,
      approvalMode: 'full',
    });
    const steerCompletionBinding = runtime.bindings.get('agent-acp-steer-completion-race');
    let resolveSteerCompletionPrompt;
    steerCompletionBinding.connection.prompt = () => new Promise(resolve => {
      resolveSteerCompletionPrompt = resolve;
    });
    const steerCompletionPrompt = runtime.prompt('agent-acp-steer-completion-race', 'turn ending during steer admission');
    while (steerCompletionBinding.activeTurn?.phase !== 'running') {
      await new Promise(resolve => setImmediate(resolve));
    }
    let releaseSteerCheckpoint;
    runtime.markCheckpointDirty = async binding => {
      if (binding !== steerCompletionBinding) return markCheckpointDirty(binding);
      await new Promise(resolve => {
        releaseSteerCheckpoint = resolve;
      });
    };
    let staleSteerRequests = 0;
    steerCompletionBinding.connection.request = async () => {
      staleSteerRequests += 1;
      return { turnId: 'must-not-be-sent' };
    };
    const staleSteer = runtime.steer('agent-acp-steer-completion-race', 'too late');
    await new Promise(resolve => setImmediate(resolve));
    resolveSteerCompletionPrompt({ stopReason: 'end_turn' });
    await new Promise(resolve => setImmediate(resolve));
    releaseSteerCheckpoint();
    await assert.rejects(staleSteer, /No active Codex turn to steer/);
    assert.strictEqual(staleSteerRequests, 0, 'steer must revalidate the exact Turn after checkpoint IO');
    assert.strictEqual((await steerCompletionPrompt).stopReason, 'end_turn');
    runtime.markCheckpointDirty = markCheckpointDirty;

    await runtime.prepareAgent({
      agentId: 'agent-acp-steer-cancel-order',
      provider: 'codex',
      cwd: process.cwd(),
      env: process.env,
      approvalMode: 'full',
    });
    const steerCancelBinding = runtime.bindings.get('agent-acp-steer-cancel-order');
    let resolveSteerCancelPrompt;
    steerCancelBinding.connection.prompt = () => new Promise(resolve => {
      resolveSteerCancelPrompt = resolve;
    });
    const steerCancelPrompt = runtime.prompt('agent-acp-steer-cancel-order', 'serialize steer then cancel');
    while (steerCancelBinding.activeTurn?.phase !== 'running') {
      await new Promise(resolve => setImmediate(resolve));
    }
    let releaseSteerRequest;
    let steerRequestStarted;
    const steerRequestReady = new Promise(resolve => {
      steerRequestStarted = resolve;
    });
    steerCancelBinding.connection.request = () => new Promise(resolve => {
      releaseSteerRequest = () => resolve({ turnId: 'ordered-turn' });
      steerRequestStarted();
    });
    let orderedCancelRequests = 0;
    steerCancelBinding.connection.cancel = async () => {
      orderedCancelRequests += 1;
      resolveSteerCancelPrompt({ stopReason: 'cancelled' });
      return {};
    };
    const orderedSteer = runtime.steer('agent-acp-steer-cancel-order', 'first control');
    await steerRequestReady;
    const orderedCancels = [
      runtime.cancel('agent-acp-steer-cancel-order'),
      runtime.cancel('agent-acp-steer-cancel-order'),
    ];
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(orderedCancelRequests, 0, 'cancel must wait for the admitted steer control operation');
    releaseSteerRequest();
    assert.strictEqual((await orderedSteer).turnId, 'ordered-turn');
    assert.deepStrictEqual(await Promise.all(orderedCancels), [true, true]);
    assert.strictEqual(orderedCancelRequests, 1, 'duplicate interrupts must join one provider cancellation');
    assert.strictEqual((await steerCancelPrompt).stopReason, 'cancelled');

    await runtime.prepareAgent({
      agentId: 'agent-acp-cancel-terminal-proof',
      provider: 'codex',
      cwd: process.cwd(),
      env: process.env,
      approvalMode: 'full',
    });
    const cancelProofBinding = runtime.bindings.get('agent-acp-cancel-terminal-proof');
    let resolveCancelProofPrompt;
    cancelProofBinding.connection.prompt = () => new Promise(resolve => {
      resolveCancelProofPrompt = resolve;
    });
    cancelProofBinding.connection.cancel = async () => ({});
    const cancelProofPrompt = runtime.prompt('agent-acp-cancel-terminal-proof', 'provider delays terminal result');
    while (cancelProofBinding.activeTurn?.phase !== 'running') {
      await new Promise(resolve => setImmediate(resolve));
    }
    const originalCancelTimeoutMs = runtime.cancelTimeoutMs;
    runtime.cancelTimeoutMs = 20;
    await assert.rejects(
      runtime.cancel('agent-acp-cancel-terminal-proof'),
      /ACP turn cancellation timed out/,
    );
    assert.strictEqual(cancelProofBinding.activeTurn?.phase, 'blocked');
    assert.strictEqual(runtime.getSession('agent-acp-cancel-terminal-proof').state, 'error');
    assert.strictEqual(runtime.getSession('agent-acp-cancel-terminal-proof').stopReason, 'cancel_timeout');
    await assert.rejects(
      runtime.prompt('agent-acp-cancel-terminal-proof', 'must not pass unresolved cancellation'),
      /not ready/,
    );
    resolveCancelProofPrompt({ stopReason: 'cancelled' });
    assert.strictEqual((await cancelProofPrompt).stopReason, 'cancelled');
    assert.strictEqual(cancelProofBinding.activeTurn, null);
    assert.strictEqual(runtime.getSession('agent-acp-cancel-terminal-proof').state, 'idle');
    runtime.cancelTimeoutMs = originalCancelTimeoutMs;

    await runtime.prepareAgent({
      agentId: 'agent-acp-binding-fence',
      provider: 'codex',
      cwd: process.cwd(),
      env: process.env,
      approvalMode: 'approve',
    });
    const staleBinding = runtime.bindings.get('agent-acp-binding-fence');
    const staleHandlers = runtime.clientHandlers(staleBinding);
    let resolveStalePrompt;
    staleBinding.connection.prompt = () => new Promise(resolve => {
      resolveStalePrompt = resolve;
    });
    const stalePrompt = runtime.prompt('agent-acp-binding-fence', 'old binding prompt');
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(staleBinding.activeTurn?.phase, 'running');
    runtime.unregisterAgent('agent-acp-binding-fence');
    await runtime.prepareAgent({
      agentId: 'agent-acp-binding-fence',
      provider: 'codex',
      cwd: process.cwd(),
      env: process.env,
      approvalMode: 'approve',
    });
    const replacementBinding = runtime.bindings.get('agent-acp-binding-fence');
    resolveStalePrompt({ stopReason: 'end_turn' });
    await assert.rejects(
      stalePrompt,
      /no longer active/,
      'an old ACP binding must not commit a prompt result after replacement',
    );
    assert.strictEqual(runtime.bindings.get('agent-acp-binding-fence'), replacementBinding);
    assert.strictEqual(runtime.getSession('agent-acp-binding-fence').entries.length, 0);
    assert.deepStrictEqual(
      await Promise.race([
        Promise.resolve(staleHandlers.requestPermission({
          sessionId: staleBinding.sessionId,
          toolCall: { toolCallId: 'stale-tool', title: 'Stale tool' },
          options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
        })),
        new Promise(resolve => setTimeout(() => resolve('timed-out'), 25)),
      ]),
      { outcome: { outcome: 'cancelled' } },
      'a detached ACP binding must cancel late reverse requests instead of creating new pending state',
    );
    await runtime.prepareAgent({
      agentId: 'agent-acp-subagent-binding-fence',
      provider: 'codex',
      cwd: process.cwd(),
      env: process.env,
      approvalMode: 'approve',
    });
    const staleSubagentBinding = runtime.bindings.get('agent-acp-subagent-binding-fence');
    runtime.clientHandlers(staleSubagentBinding).sessionUpdate({
      sessionId: 'stale-subagent-session',
      update: {
        sessionUpdate: 'agent_thought_chunk',
        messageId: 'stale-subagent-thought',
        content: { type: 'text', text: 'Old binding work.' },
      },
    });
    let resolveStaleSubagentCancel;
    staleSubagentBinding.connection.cancel = () => new Promise(resolve => {
      resolveStaleSubagentCancel = resolve;
    });
    const staleSubagentCancel = runtime.cancelSubagent(
      'agent-acp-subagent-binding-fence',
      'stale-subagent-session',
    );
    await new Promise(resolve => setImmediate(resolve));
    runtime.unregisterAgent('agent-acp-subagent-binding-fence');
    await runtime.prepareAgent({
      agentId: 'agent-acp-subagent-binding-fence',
      provider: 'codex',
      cwd: process.cwd(),
      env: process.env,
      approvalMode: 'approve',
    });
    resolveStaleSubagentCancel({});
    await assert.rejects(
      staleSubagentCancel,
      /no longer active/,
      'an old Subagent cancellation must not commit into a replacement binding',
    );
    assert.strictEqual(
      runtime.getSubagentTranscriptSession('agent-acp-subagent-binding-fence', 'stale-subagent-session'),
      null,
    );
    const replacementSubagentBinding = runtime.bindings.get('agent-acp-subagent-binding-fence');
    runtime.clientHandlers(replacementSubagentBinding).sessionUpdate({
      sessionId: 'child-before-parent-tool',
      update: {
        sessionUpdate: 'agent_thought_chunk',
        messageId: 'child-before-parent-thought',
        content: { type: 'text', text: 'Child became active before its parent Tool update.' },
      },
    });
    const outOfOrderCancelSessionIds = [];
    replacementSubagentBinding.connection.cancel = async ({ sessionId }) => {
      outOfOrderCancelSessionIds.push(sessionId);
      return {};
    };
    await runtime.cancel('agent-acp-subagent-binding-fence');
    assert.deepStrictEqual(
      new Set(outOfOrderCancelSessionIds),
      new Set([replacementSubagentBinding.sessionId, 'child-before-parent-tool']),
      'parent cancellation must include a child observed before its parent Tool status arrives',
    );
    runtime.updateSubagentControlFromParent(replacementSubagentBinding, {
      status: 'running',
      _meta: { subagent_session_info: { session_id: 'child-before-parent-tool' } },
    });
    assert.strictEqual(
      replacementSubagentBinding.subagentControls.get('child-before-parent-tool').phase,
      'cancelled',
      'a late parent Tool update must not reopen a terminal child control',
    );
    runtime.resetSubagentControls(replacementSubagentBinding);
    assert.strictEqual(
      replacementSubagentBinding.subagentControls.get('child-before-parent-tool').phase,
      'completed',
      'restored child evidence without a parent Tool must not be treated as a live process',
    );
    await runtime.prepareAgent({
      agentId: 'agent-acp-request-fence',
      provider: 'codex',
      cwd: process.cwd(),
      env: process.env,
      approvalMode: 'approve',
    });
    const requestBinding = runtime.bindings.get('agent-acp-request-fence');
    let resolveStaleList;
    requestBinding.connection.listSessions = () => new Promise(resolve => {
      resolveStaleList = resolve;
    });
    const staleList = runtime.listSessions('agent-acp-request-fence');
    await new Promise(resolve => setImmediate(resolve));
    runtime.unregisterAgent('agent-acp-request-fence');
    await runtime.prepareAgent({
      agentId: 'agent-acp-request-fence',
      provider: 'codex',
      cwd: process.cwd(),
      env: process.env,
      approvalMode: 'approve',
    });
    resolveStaleList({ sessions: [{ sessionId: 'stale-list-result' }] });
    await assert.rejects(
      staleList,
      /no longer active/,
      'an asynchronous ACP request result must still match its binding generation',
    );
    await runtime.prepareAgent({
      agentId: 'agent-acp-closed-binding',
      provider: 'codex',
      cwd: process.cwd(),
      env: process.env,
      approvalMode: 'approve',
    });
    const closedBinding = runtime.bindings.get('agent-acp-closed-binding');
    runtime.handleExit(closedBinding, new Error('socket connection closed'));
    assert.strictEqual(runtime.getSession('agent-acp-closed-binding').state, 'error');
    await assert.rejects(
      runtime.prompt('agent-acp-closed-binding', 'must not reuse closed transport'),
      /not ready/,
    );
    assert.deepStrictEqual(
      runtime.requestPermission(closedBinding, {
        sessionId: closedBinding.sessionId,
        toolCall: { toolCallId: 'closed-tool', title: 'Closed tool' },
        options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
      }),
      { outcome: { outcome: 'cancelled' } },
    );
    await runtime.prepareAgent({
      agentId: 'agent-acp-exit-during-prompt',
      provider: 'codex',
      cwd: process.cwd(),
      env: process.env,
      approvalMode: 'approve',
    });
    const exitingBinding = runtime.bindings.get('agent-acp-exit-during-prompt');
    let resolveExitedPrompt;
    exitingBinding.connection.prompt = () => new Promise(resolve => {
      resolveExitedPrompt = resolve;
    });
    const exitedPrompt = runtime.prompt('agent-acp-exit-during-prompt', 'connection exits during prompt');
    await new Promise(resolve => setImmediate(resolve));
    runtime.handleExit(exitingBinding, new Error('socket connection closed during prompt'));
    const exitedRevision = exitingBinding.sessionState.revision;
    resolveExitedPrompt({ stopReason: 'end_turn' });
    await assert.rejects(exitedPrompt, /connection is closed/);
    runtime.handleExit(exitingBinding, new Error('duplicate close notification'));
    const exitedSession = runtime.getSession('agent-acp-exit-during-prompt');
    assert.strictEqual(exitedSession.state, 'error');
    assert.strictEqual(exitingBinding.activeTurn, null);
    assert.strictEqual(
      exitedSession.entries.filter(entry => entry.type === 'error').length,
      1,
      'connection exit must complete an active prompt with one terminal error entry',
    );
    assert.strictEqual(
      exitingBinding.sessionState.revision,
      exitedRevision,
      'duplicate exit and late prompt completion must not reduce the session twice',
    );

    const prompted = await runtime.prompt('agent-acp-new', 'hello ACP');
    assert.strictEqual(prompted.stopReason, 'end_turn');
    const session = runtime.getSession('agent-acp-new');
    assert.strictEqual(session.protocol, 'acp');
    assert.strictEqual(session.supportsFork, true);
    assert.strictEqual(session.entries.find(item => item.type === 'tool').status, 'completed');
    assert.strictEqual(session.entries.find(item => item.role === 'assistant').content[0].text, 'ACP reply');
    assert(emittedSessions.length > 0);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(emittedSessions[0], 'session'), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(session, 'updates'), false);
    assert(runtime.getSession('agent-acp-new', { includeUpdates: true }).updates.length > 0);
    const listed = await runtime.listSessions('agent-acp-new');
    assert.strictEqual(listed.sessions[0].sessionId, 'acp-new-session');
    const forkRevision = runtime.bindings.get('agent-acp-new').sessionState.revision;
    await assert.rejects(
      runtime.forkSession('agent-acp-new', { expectedRevision: forkRevision + 1 }),
      /conversation changed/,
    );
    assert.strictEqual(
      (await runtime.forkSession('agent-acp-new', { expectedRevision: forkRevision })).sessionId,
      'acp-fork-session',
    );
    assert.deepStrictEqual(await runtime.setSessionMode('agent-acp-new', 'plan'), {
      sessionId: 'acp-new-session', modeId: 'plan',
    });
    const newAgentBinding = runtime.bindings.get('agent-acp-new');
    newAgentBinding.configOptions = [
      { id: 'model', name: 'Model', type: 'select', currentValue: 'gpt-5.5', options: [] },
      { id: 'reasoning', name: 'Reasoning', type: 'select', currentValue: 'high', options: [] },
    ];
    const refreshedModel = await runtime.setSessionConfigOption('agent-acp-new', 'model', 'gpt-5.6-terra');
    assert.strictEqual(refreshedModel.configOptions.find(option => option.id === 'fast-mode')?.currentValue, false);
    const matrixProfile = await runtime.setSessionConfigOptions('agent-acp-new', [
      { configId: 'model', value: 'gpt-5.6-luna' },
      { configId: 'reasoning', value: 'medium' },
    ]);
    assert.strictEqual(matrixProfile.configOptions.find(option => option.id === 'model')?.currentValue, 'gpt-5.6-luna');
    assert.strictEqual(matrixProfile.configOptions.find(option => option.id === 'reasoning')?.currentValue, 'medium');
    await runtime.setSessionConfigOptions('agent-acp-new', [
      { configId: 'model', value: 'gpt-5.6-sol' },
      { configId: 'reasoning', value: 'ultra' },
    ]);
    const fallbackProfile = await runtime.setSessionConfigOption('agent-acp-new', 'model', 'gpt-5.6-luna');
    assert.strictEqual(fallbackProfile.configOptions.find(option => option.id === 'reasoning')?.currentValue, 'max');
    assert.strictEqual(fallbackProfile.configOptions.find(option => option.id === 'fast-mode')?.currentValue, false);
    const configured = await runtime.setSessionConfigOption('agent-acp-new', 'show-thinking', true);
    assert.strictEqual(configured.configOptions[0].currentValue, true);
    let serializedFastValue = false;
    let serializedFastCalls = 0;
    let concurrentFastCalls = 0;
    let maxConcurrentFastCalls = 0;
    newAgentBinding.configOptions = [
      { id: 'fast-mode', name: 'Fast', type: 'boolean', currentValue: serializedFastValue },
    ];
    newAgentBinding.connection.setSessionConfigOption = async params => {
      serializedFastCalls += 1;
      concurrentFastCalls += 1;
      maxConcurrentFastCalls = Math.max(maxConcurrentFastCalls, concurrentFastCalls);
      await new Promise(resolve => setTimeout(resolve, 15));
      serializedFastValue = params.value;
      concurrentFastCalls -= 1;
      return {
        configOptions: [
          { id: 'fast-mode', name: 'Fast', type: 'boolean', currentValue: serializedFastValue },
        ],
      };
    };
    const duplicateFastResults = await Promise.all([
      runtime.setSessionConfigOption('agent-acp-new', 'fast-mode', true),
      runtime.setSessionConfigOption('agent-acp-new', 'fast-mode', true),
    ]);
    assert.strictEqual(serializedFastCalls, 1, 'duplicate ACP target values should collapse after serialization');
    assert.strictEqual(maxConcurrentFastCalls, 1, 'ACP config updates must be single-flight per session');
    assert(duplicateFastResults.every(result => (
      result.configOptions.find(option => option.id === 'fast-mode')?.currentValue === true
    )));
    await Promise.all([
      runtime.setSessionConfigOption('agent-acp-new', 'fast-mode', false),
      runtime.setSessionConfigOption('agent-acp-new', 'fast-mode', true),
    ]);
    assert.strictEqual(serializedFastCalls, 3, 'different queued target values should apply in order');
    assert.strictEqual(maxConcurrentFastCalls, 1);
    assert.strictEqual(serializedFastValue, true);
    assert.deepStrictEqual(await runtime.deleteSession('agent-acp-new', 'old-session'), {
      deleted: true, sessionId: 'old-session',
    });

    const clientServicesRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-acp-protocol-'));
    await runtime.prepareAgent({
      agentId: 'agent-acp-client-services',
      provider: 'codex',
      cwd: clientServicesRoot,
      env: process.env,
      approvalMode: 'full',
    });
    const waitingForInput = new Promise(resolve => {
      const listener = event => {
        if (event.agentId !== 'agent-acp-client-services' || event.state !== 'waiting-for-input') return;
        runtime.off('agent-runtime', listener);
        resolve(event);
      };
      runtime.on('agent-runtime', listener);
    });
    const clientServicesPrompt = runtime.prompt('agent-acp-client-services', 'exercise client services');
    const inputEvent = await waitingForInput;
    runtime.respondElicitation(
      'agent-acp-client-services',
      inputEvent.pendingElicitation.requestId,
      'accept',
      { confirmed: true },
    );
    assert.strictEqual((await clientServicesPrompt).stopReason, 'end_turn');
    const clientServicesSession = runtime.getSession('agent-acp-client-services');
    assert.match(clientServicesSession.entries.find(item => item.role === 'assistant').content[0].text, /filesystem-ok; terminal-ok; exit=0; confirmed=true/);
    assert.match(runtime.getToolEntry('agent-acp-client-services', 'client-terminal-tool').content[0].terminal.output, /terminal-ok/);
    const interactivePrompt = runtime.prompt('agent-acp-client-services', 'interactive terminal');
    let interactiveTool;
    for (let attempt = 0; attempt < 250; attempt += 1) {
      interactiveTool = runtime.getToolEntry('agent-acp-client-services', 'interactive-terminal-tool');
      if (interactiveTool?.content?.[0]?.terminal?.output?.includes('name>')) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.match(interactiveTool.content[0].terminal.output, /name>/);
    runtime.inputTerminal('agent-acp-client-services', interactiveTool.content[0].terminalId, 'Farming\r');
    assert.strictEqual((await interactivePrompt).stopReason, 'end_turn');
    assert.match(
      runtime.getSession('agent-acp-client-services').entries.filter(item => item.role === 'assistant').at(-1).content[0].text,
      /hello Farming/,
    );
    assert.strictEqual((await runtime.prompt('agent-acp-client-services', 'subagent preview')).stopReason, 'end_turn');
    const subagentTool = runtime.getToolEntry('agent-acp-client-services', 'subagent-tool');
    assert.strictEqual(subagentTool._meta.subagent_session_info.session_id, 'acp-child-session');
    const childSession = runtime.getSubagentTranscriptSession('agent-acp-client-services', 'acp-child-session', { maxTurns: 10 });
    assert(childSession);
    assert.strictEqual(childSession.state, 'idle');
    assert.strictEqual(childSession.stopReason, 'end_turn');
    assert.strictEqual(childSession.entries[0].content[0].text, 'Inspect the parser');
    assert.strictEqual(childSession.entries.at(-1).content[0].text, 'The parser is consistent.');
    const clientServicesBinding = runtime.bindings.get('agent-acp-client-services');
    const clientServicesApprovalMode = clientServicesBinding.approvalMode;
    clientServicesBinding.approvalMode = 'approve';
    const childPermission = runtime.requestPermission(clientServicesBinding, {
      sessionId: 'acp-child-session',
      toolCall: { toolCallId: 'child-permission', title: 'Subagent command', kind: 'execute' },
      options: [{ optionId: 'allow-child', name: 'Allow', kind: 'allow_once' }],
    });
    const childPermissionSnapshot = runtime.getSession('agent-acp-client-services').pendingPermissions[0];
    assert.strictEqual(childPermissionSnapshot.origin, 'subagent');
    assert.strictEqual(
      runtime.getSubagentTranscriptSession('agent-acp-client-services', 'acp-child-session').state,
      'waiting-for-permission',
    );
    runtime.respondPermission('agent-acp-client-services', childPermissionSnapshot.requestId, 'allow-child');
    await childPermission;
    const childElicitation = runtime.requestElicitation(clientServicesBinding, {
      sessionId: 'acp-child-session',
      mode: 'form',
      message: 'Choose the subagent scope',
      requestedSchema: {
        type: 'object',
        required: ['scope'],
        properties: { scope: { type: 'string', enum: ['focused', 'full'] } },
      },
    });
    const childElicitationSnapshot = runtime.getSession('agent-acp-client-services').pendingElicitations[0];
    assert.strictEqual(childElicitationSnapshot.origin, 'subagent');
    assert.strictEqual(childElicitationSnapshot.sessionId, 'acp-child-session');
    assert.strictEqual(
      runtime.getSubagentTranscriptSession('agent-acp-client-services', 'acp-child-session').state,
      'waiting-for-input',
    );
    runtime.respondElicitation(
      'agent-acp-client-services',
      childElicitationSnapshot.requestId,
      'accept',
      { scope: 'focused' },
    );
    assert.deepStrictEqual(await childElicitation, { action: 'accept', content: { scope: 'focused' } });
    assert.deepStrictEqual(
      await runtime.cancelSubagent('agent-acp-client-services', 'acp-child-session'),
      { cancelled: true, sessionId: 'acp-child-session' },
    );
    const longSubagentPrompt = runtime.prompt('agent-acp-client-services', 'long subagent');
    let longSubagentTool;
    for (let attempt = 0; attempt < 250; attempt += 1) {
      longSubagentTool = runtime.getToolEntry('agent-acp-client-services', 'long-subagent-tool');
      if (longSubagentTool && runtime.getSubagentTranscriptSession(
        'agent-acp-client-services',
        'acp-long-child-session',
      )) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert(longSubagentTool);
    assert.strictEqual(
      runtime.getSubagentTranscriptSession('agent-acp-client-services', 'acp-long-child-session').state,
      'working',
    );
    const originalClientServicesCancel = clientServicesBinding.connection.cancel.bind(clientServicesBinding.connection);
    let longSubagentCancelRequests = 0;
    let longParentCancelRequests = 0;
    clientServicesBinding.connection.cancel = params => {
      if (params?.sessionId === 'acp-long-child-session') longSubagentCancelRequests += 1;
      if (params?.sessionId === clientServicesBinding.sessionId) longParentCancelRequests += 1;
      return originalClientServicesCancel(params);
    };
    assert.deepStrictEqual(
      await Promise.all([
        runtime.cancel('agent-acp-client-services'),
        runtime.cancelSubagent('agent-acp-client-services', 'acp-long-child-session'),
        runtime.cancelSubagent('agent-acp-client-services', 'acp-long-child-session'),
      ]),
      [
        true,
        { cancelled: true, sessionId: 'acp-long-child-session' },
        { cancelled: true, sessionId: 'acp-long-child-session' },
      ],
    );
    assert.strictEqual(longParentCancelRequests, 1, 'parent cancellation must issue one root provider request');
    assert.strictEqual(longSubagentCancelRequests, 1, 'duplicate Subagent cancels must join one provider request');
    assert.strictEqual((await longSubagentPrompt).stopReason, 'cancelled');
    const lateSubagentUpdate = runtime.clientHandlers(clientServicesBinding).sessionUpdate;
    lateSubagentUpdate({
      sessionId: 'acp-long-child-session',
      update: {
        sessionUpdate: 'agent_thought_chunk',
        messageId: 'late-long-child-thought',
        content: { type: 'text', text: 'Late provider update after cancellation.' },
      },
    });
    const cancelledSubagent = runtime.getSubagentTranscriptSession(
      'agent-acp-client-services',
      'acp-long-child-session',
    );
    assert.strictEqual(cancelledSubagent.state, 'idle');
    assert.strictEqual(cancelledSubagent.stopReason, 'cancelled');
    clientServicesBinding.connection.cancel = originalClientServicesCancel;
    clientServicesBinding.approvalMode = clientServicesApprovalMode;
    await assert.rejects(
      runtime.prompt('agent-acp-client-services', 'authentication error'),
      /401 Unauthorized/,
    );
    const failedSession = runtime.getSession('agent-acp-client-services');
    assert.strictEqual(failedSession.state, 'error');
    assert.strictEqual(failedSession.stopReason, 'error');
    assert.strictEqual(failedSession.errorKind, 'authentication');
    assert.strictEqual(failedSession.entries.at(-1).type, 'error');
    assert.strictEqual(failedSession.entries.at(-1).kind, 'authentication');
    assert.match(failedSession.entries.at(-1).message, /401 Unauthorized: sign in required/);
    assert.strictEqual(failedSession.entries.at(-1).status, 'failed');
    assert.strictEqual(failedSession.authMethods[0].id, 'fake-login');
    assert.deepStrictEqual(await runtime.authenticate('agent-acp-client-services', 'fake-login'), {
      authenticated: true,
      methodId: 'fake-login',
    });
    assert.deepStrictEqual(await runtime.logout('agent-acp-client-services'), { loggedOut: true });
    const authenticatedSession = runtime.getSession('agent-acp-client-services');
    assert.strictEqual(authenticatedSession.state, 'idle');
    assert.strictEqual(authenticatedSession.error, '');
    assert.strictEqual(authenticatedSession.stopReason, '');
    const bindingBeforeTerminalAuth = runtime.bindings.get('agent-acp-client-services');
    const revisionBeforeTerminalAuth = bindingBeforeTerminalAuth.sessionState.revision;
    const terminalAuthentication = await runtime.authenticate('agent-acp-client-services', 'fake-terminal-login');
    assert.strictEqual(terminalAuthentication.authenticated, false);
    await assert.rejects(
      runtime.prompt('agent-acp-client-services', 'must wait for terminal authentication'),
      /not ready/,
      'terminal authentication must retain its Agent reservation until restart completes',
    );
    await assert.rejects(
      runtime.cancel('agent-acp-client-services'),
      /not ready for cancellation/,
      'interrupt must not overlap the terminal authentication reservation',
    );
    let terminalAuthenticationSnapshot;
    for (let attempt = 0; attempt < 250; attempt += 1) {
      terminalAuthenticationSnapshot = runtime.getSession('agent-acp-client-services').authTerminal;
      if (terminalAuthenticationSnapshot?.terminal?.output?.includes('fake-login>')) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.match(terminalAuthenticationSnapshot.terminal.output, /fake-login>/);
    runtime.inputTerminal('agent-acp-client-services', terminalAuthentication.terminalId, 'approved\r');
    for (let attempt = 0; attempt < 500; attempt += 1) {
      if (runtime.bindings.get('agent-acp-client-services') !== bindingBeforeTerminalAuth
        && runtime.getSession('agent-acp-client-services').state === 'idle') break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.notStrictEqual(runtime.bindings.get('agent-acp-client-services'), bindingBeforeTerminalAuth);
    assert.strictEqual(runtime.getSession('agent-acp-client-services').state, 'idle');
    const reloadedAfterTerminalAuth = runtime.getTranscriptSession('agent-acp-client-services', {
      sinceRevision: revisionBeforeTerminalAuth,
    });
    assert.strictEqual(reloadedAfterTerminalAuth.delta, false);
    assert.strictEqual(reloadedAfterTerminalAuth.entries[0].content[0].text, 'rich timeline');
    fs.rmSync(clientServicesRoot, { recursive: true, force: true });

    const loadEventStart = emittedSessions.length;
    const loaded = await runtime.prepareAgent({
      agentId: 'agent-acp-load',
      provider: 'opencode',
      cwd: process.cwd(),
      env: process.env,
      sessionId: 'existing-session',
      approvalMode: 'full',
    });
    assert.strictEqual(loaded.historyMode, 'load');
    const history = runtime.getSession('agent-acp-load');
    assert.strictEqual(history.entries.length, 2);
    assert.strictEqual(history.entries[0].content[0].text, 'historical question');
    assert.strictEqual(history.entries[1].content[0].text, 'historical answer');
    assert.strictEqual(
      emittedSessions.slice(loadEventStart).filter(event => event.agentId === 'agent-acp-load').length,
      1,
      'history replay should publish one settled transcript invalidation instead of one event per entry',
    );

    const delayedLoadEventStart = emittedSessions.length;
    const delayedHistory = await runtime.prepareAgent({
      agentId: 'agent-acp-qoder-load',
      provider: 'qoder',
      cwd: process.cwd(),
      env: process.env,
      sessionId: 'delayed-history-session',
      approvalMode: 'full',
    });
    assert.strictEqual(delayedHistory.historyMode, 'load');
    const qoderHistory = runtime.getSession('agent-acp-qoder-load');
    assert.strictEqual(qoderHistory.entries.length, 2);
    assert.strictEqual(qoderHistory.entries[1].content[0].text, 'delayed historical answer');
    assert.strictEqual(
      emittedSessions.slice(delayedLoadEventStart).filter(event => event.agentId === 'agent-acp-qoder-load').length,
      1,
      'delayed history replay should also publish only its settled snapshot',
    );

    await runtime.prepareAgent({
      agentId: 'agent-acp-permission',
      provider: 'claude',
      cwd: process.cwd(),
      env: process.env,
      approvalMode: 'approve',
    });
    const waiting = new Promise(resolve => {
      const listener = event => {
        if (event.agentId === 'agent-acp-permission' && event.state === 'waiting-for-permission') {
          runtime.off('agent-runtime', listener);
          resolve(event);
        }
      };
      runtime.on('agent-runtime', listener);
    });
    const permissionPrompt = runtime.prompt('agent-acp-permission', 'needs permission');
    const waitingEvent = await waiting;
    assert.strictEqual(waitingEvent.pendingPermission.options[0].optionId, 'allow');
    runtime.respondPermission(
      'agent-acp-permission',
      waitingEvent.pendingPermission.requestId,
      'allow'
    );
    assert.strictEqual((await permissionPrompt).stopReason, 'end_turn');

    const permissionBinding = runtime.bindings.get('agent-acp-permission');
    const request = {
      sessionId: 'acp-new-session',
      toolCall: { toolCallId: 'parallel-tool', title: 'Parallel request' },
      options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
    };
    assert.deepStrictEqual(runtime.requestPermission(permissionBinding, {
      ...request,
      sessionId: 'unrelated-session',
    }), { outcome: { outcome: 'cancelled' } });
    assert.strictEqual(
      runtime.getSession('agent-acp-permission').pendingPermissions.length,
      0,
      'an unrelated ACP session must not create permission state on this binding',
    );
    const firstPermission = runtime.requestPermission(permissionBinding, request);
    const secondPermission = runtime.requestPermission(permissionBinding, {
      ...request,
      toolCall: { toolCallId: 'parallel-tool-2', title: 'Second request' },
    });
    const pending = runtime.getSession('agent-acp-permission').pendingPermissions;
    assert.strictEqual(pending.length, 2);
    runtime.respondPermission('agent-acp-permission', pending[0].requestId, 'allow');
    assert.strictEqual(runtime.getSession('agent-acp-permission').state, 'waiting-for-permission');
    runtime.respondPermission('agent-acp-permission', pending[1].requestId, 'allow');
    assert.strictEqual(runtime.getSession('agent-acp-permission').state, 'idle');

    const constrainedElicitation = runtime.requestElicitation(permissionBinding, {
      sessionId: permissionBinding.sessionId,
      mode: 'form',
      message: 'Release settings',
      requestedSchema: {
        type: 'object',
        required: ['tag', 'replicas', 'reviewers'],
        properties: {
          tag: { type: 'string', pattern: '^v\\d+$', minLength: 2, maxLength: 8 },
          replicas: { type: 'integer', minimum: 1, maximum: 5 },
          reviewers: { type: 'array', minItems: 1, maxItems: 2, items: { enum: ['a', 'b', 'c'] } },
        },
      },
    });
    const constrainedInput = runtime.getSession('agent-acp-permission').pendingElicitations[0];
    assert.throws(
      () => runtime.respondElicitation('agent-acp-permission', constrainedInput.requestId, 'accept', {
        tag: 'latest', replicas: 0, reviewers: [],
      }),
      /invalid format|below the minimum|more selections/,
    );
    runtime.respondElicitation('agent-acp-permission', constrainedInput.requestId, 'accept', {
      tag: 'v2', replicas: 2, reviewers: ['a'],
    });
    assert.deepStrictEqual(await constrainedElicitation, {
      action: 'accept',
      content: { tag: 'v2', replicas: 2, reviewers: ['a'] },
    });
    await Promise.all([firstPermission, secondPermission]);

    const formElicitation = runtime.requestElicitation(permissionBinding, {
      sessionId: permissionBinding.sessionId,
      mode: 'form',
      message: 'Choose a release channel',
      requestedSchema: {
        type: 'object',
        required: ['channel', 'confirmed'],
        properties: {
          channel: { type: 'string', enum: ['stable', 'beta'] },
          confirmed: { type: 'boolean' },
        },
      },
    });
    const pendingInput = runtime.getSession('agent-acp-permission').pendingElicitations[0];
    assert.strictEqual(runtime.getSession('agent-acp-permission').state, 'waiting-for-input');
    assert.strictEqual(pendingInput.mode, 'form');
    assert.throws(
      () => runtime.respondElicitation('agent-acp-permission', pendingInput.requestId, 'accept', { channel: 'stable' }),
      /required: confirmed/,
    );
    runtime.respondElicitation('agent-acp-permission', pendingInput.requestId, 'accept', {
      channel: 'stable',
      confirmed: true,
    });
    assert.deepStrictEqual(await formElicitation, {
      action: 'accept',
      content: { channel: 'stable', confirmed: true },
    });
    assert.strictEqual(runtime.getSession('agent-acp-permission').state, 'idle');

    const requestScopedElicitation = runtime.requestElicitation(permissionBinding, {
      requestId: 42,
      mode: 'form',
      message: 'Authenticate before opening a session',
      requestedSchema: { type: 'object', properties: {} },
    });
    const requestScopedInput = runtime.getSession('agent-acp-permission').pendingElicitations[0];
    assert.match(requestScopedInput.requestId, /^acp-elicitation-/);
    assert.strictEqual(requestScopedInput.protocolRequestId, 42);
    assert.strictEqual(requestScopedInput.origin, 'request');
    runtime.respondElicitation('agent-acp-permission', requestScopedInput.requestId, 'accept', {});
    assert.deepStrictEqual(await requestScopedElicitation, { action: 'accept', content: {} });
    assert.strictEqual(runtime.getSession('agent-acp-permission').state, 'idle');

    const savedSessionId = permissionBinding.sessionId;
    permissionBinding.sessionId = '';
    permissionBinding.state = 'connecting';
    const authElicitation = runtime.requestElicitation(permissionBinding, {
      requestId: 'auth-request',
      mode: 'form',
      message: 'Authenticate',
      requestedSchema: { type: 'object', properties: {} },
    });
    const authInput = runtime.getSession('agent-acp-permission').pendingElicitations[0];
    runtime.respondElicitation('agent-acp-permission', authInput.requestId, 'decline');
    assert.deepStrictEqual(await authElicitation, { action: 'decline' });
    assert.strictEqual(runtime.getSession('agent-acp-permission').state, 'connecting');
    permissionBinding.sessionId = savedSessionId;
    permissionBinding.state = 'idle';

    const urlElicitation = runtime.requestElicitation(permissionBinding, {
      sessionId: permissionBinding.sessionId,
      mode: 'url',
      elicitationId: 'login-1',
      message: 'Sign in',
      url: 'https://example.com/login',
    });
    const pendingUrl = runtime.getSession('agent-acp-permission').pendingElicitations[0];
    runtime.respondElicitation('agent-acp-permission', pendingUrl.requestId, 'accept');
    assert.deepStrictEqual(await urlElicitation, { action: 'accept' });
    assert.strictEqual(runtime.getSession('agent-acp-permission').activeElicitations[0].elicitationId, 'login-1');
    runtime.completeElicitation(permissionBinding, { elicitationId: 'login-1' });
    assert.strictEqual(runtime.getSession('agent-acp-permission').activeElicitations.length, 0);

    const cancelledPermission = runtime.requestPermission(permissionBinding, request);
    assert.strictEqual(runtime.getSession('agent-acp-permission').pendingPermissions.length, 1);
    assert.strictEqual(await runtime.cancel('agent-acp-permission'), true);
    assert.strictEqual(runtime.getSession('agent-acp-permission').pendingPermissions.length, 0);
    assert.strictEqual(runtime.getSession('agent-acp-permission').state, 'idle');
    assert.deepStrictEqual(await cancelledPermission, { outcome: { outcome: 'cancelled' } });

    const timeoutBinding = runtime.bindings.get('agent-acp-new');
    timeoutBinding.connection.cancel = () => new Promise(() => {});
    runtime.cancelTimeoutMs = 10;
    await assert.rejects(
      runtime.cancel('agent-acp-new'),
      /ACP session\/cancel timed out/,
    );
    assert.strictEqual(runtime.getSession('agent-acp-new').state, 'error');
    assert.strictEqual(runtime.getSession('agent-acp-new').stopReason, 'cancel_error');
  } finally {
    await runtime.dispose();
  }

  if (process.platform !== 'win32') {
    const descendantPidFile = path.join(os.tmpdir(), `farming-acp-descendant-${process.pid}-${Date.now()}.pid`);
    const processTreeRuntime = new AcpRuntime({
      resolveLaunch() {
        return { command: process.execPath, args: [fixture], version: 'test' };
      },
    });
    try {
      await processTreeRuntime.prepareAgent({
        agentId: 'agent-acp-process-tree',
        provider: 'codex',
        cwd: process.cwd(),
        env: {
          ...process.env,
          FARMING_TEST_ACP_DESCENDANT_PID_FILE: descendantPidFile,
        },
        approvalMode: 'full',
      });
      const descendantPid = Number(fs.readFileSync(descendantPidFile, 'utf8'));
      assert(Number.isInteger(descendantPid) && descendantPid > 0);
      await processTreeRuntime.dispose();
      assert.strictEqual(processTreeRuntime.bindings.has('agent-acp-process-tree'), false);
      assert.throws(
        () => process.kill(descendantPid, 0),
        error => error?.code === 'ESRCH',
        'verified ACP cleanup must stop descendants in the adapter process group',
      );
    } finally {
      await processTreeRuntime.dispose();
      fs.rmSync(descendantPidFile, { force: true });
    }
  }

  console.log('ACP runtime tests passed');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
