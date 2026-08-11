const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { AgentExtensionInventory } = require('../agent-extension-inventory.cjs');
const { AgentSessionInventory } = require('../agent-session-inventory.cjs');
const { searchAgentSessions } = require('../agent-session-history.cjs');

function activeFsWatcherCount(): number {
  const getActiveHandles = Reflect.get(process, '_getActiveHandles');
  assert.strictEqual(typeof getActiveHandles, 'function', 'Node must expose active handles for watcher cleanup assertions');
  const handles = Reflect.apply(getActiveHandles, process, []) as unknown[];
  return handles.filter(handle => {
    if (!handle || typeof handle !== 'object') return false;
    const constructor = Reflect.get(handle, 'constructor');
    return typeof constructor === 'function' && constructor.name === 'FSWatcher';
  }).length;
}

async function drainClosedFsWatchers(): Promise<void> {
  for (let turn = 0; turn < 4; turn += 1) {
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-agent-inventories-'));
  const caches: Array<{ close(): Promise<void> }> = [];
  const initialWatcherCount = activeFsWatcherCount();
  try {
  const codexHome = path.join(root, 'codex');
  const sessionsRoot = path.join(codexHome, 'sessions');
  const skillsRoot = path.join(codexHome, 'skills', 'example');
  fs.mkdirSync(sessionsRoot, { recursive: true });
  fs.mkdirSync(skillsRoot, { recursive: true });
  const sessionId = '019fb51c-bf3a-77a0-801e-3c7e6df01a5f';
  const sessionMarker = path.join(sessionsRoot, `rollout-${sessionId}.jsonl`);
  const sessionIndex = path.join(codexHome, 'session_index.jsonl');
  const globalState = path.join(codexHome, '.codex-global-state.json');
  fs.writeFileSync(sessionMarker, 'x'.repeat(70 * 1024));
  fs.writeFileSync(sessionIndex, 'one');
  fs.writeFileSync(globalState, JSON.stringify({ usage: 1 }));
  fs.utimesSync(sessionMarker, new Date('2026-07-31T00:00:00.000Z'), new Date('2026-07-31T00:00:00.000Z'));
  fs.writeFileSync(path.join(skillsRoot, 'SKILL.md'), '---\nname: Example\ndescription: First\n---\n');

  let historyLoads = 0;
  let appendSessionIndexDuringLoad = false;
  let metadataReads = 0;
  const history = new AgentSessionInventory({
    cacheFile: path.join(root, 'cache', 'history.json'),
    listSessions: async () => {
      historyLoads += 1;
      const title = fs.readFileSync(sessionIndex, 'utf8');
      if (appendSessionIndexDuringLoad) fs.appendFileSync(sessionIndex, '-appended');
      return [{
        provider: 'codex',
        providerHomeId: 'default',
        id: sessionId,
        title,
        updatedAt: '2026-01-01T00:00:00.000Z',
        pinned: false,
      }];
    },
  });
  caches.push(history);
  const metadata = () => {
    metadataReads += 1;
    return {
      providerHomes: { codex: [{ id: 'default', path: codexHome }] },
      providerSessionBindings: [],
    };
  };

  const concurrentHistory = await Promise.all([
    history.list(metadata),
    history.list(metadata),
    history.list(metadata),
  ]);
  assert.strictEqual(concurrentHistory[0][0].title, 'one');
  assert.deepStrictEqual(concurrentHistory[1], concurrentHistory[0]);
  assert.deepStrictEqual(concurrentHistory[2], concurrentHistory[0]);
  assert.strictEqual(metadataReads, 1, 'Concurrent History readers should share one filesystem inventory pass');
  const originalOpen = fs.promises.open;
  let warmTranscriptOpens = 0;
  fs.promises.open = async (...args: Parameters<typeof fs.promises.open>) => {
    if (path.resolve(String(args[0])) === sessionMarker) warmTranscriptOpens += 1;
    return originalOpen(...args);
  };
  try {
    assert.strictEqual((await history.list(metadata))[0].updatedAt, '2026-07-31T00:00:00.000Z');
    assert.strictEqual((await history.list(metadata))[0].title, 'one');
  } finally {
    fs.promises.open = originalOpen;
  }
  assert.strictEqual(warmTranscriptOpens, 0, 'Warm History reads must not reopen unchanged transcript contents');
  assert.strictEqual(historyLoads, 1);
  fs.writeFileSync(globalState, JSON.stringify({ usage: 2 }));
  assert.strictEqual((await history.list(metadata))[0].title, 'one');
  assert.strictEqual(historyLoads, 1, 'unrelated Codex global-state churn should not rebuild History');
  fs.appendFileSync(sessionMarker, 'new activity');
  fs.utimesSync(sessionMarker, new Date('2026-07-31T00:01:00.000Z'), new Date('2026-07-31T00:01:00.000Z'));
  assert.strictEqual((await history.list(metadata))[0].updatedAt, '2026-07-31T00:01:00.000Z');
  assert.strictEqual(historyLoads, 1, 'Transcript appends should refresh activity without reparsing the inventory');
  fs.writeFileSync(globalState, JSON.stringify({ usage: 3, 'pinned-thread-ids': [sessionId] }));
  assert.strictEqual((await history.list(metadata))[0].pinned, true);
  assert.strictEqual(historyLoads, 1, 'Codex presentation state should overlay without reparsing History');
  fs.writeFileSync(sessionIndex, 'two-two');
  assert.strictEqual((await history.list(metadata))[0].title, 'two-two');
  assert.strictEqual(historyLoads, 2, 'History should reconcile a changed provider Home before returning');
  fs.writeFileSync(sessionIndex, 'three');
  appendSessionIndexDuringLoad = true;
  assert.strictEqual((await history.list(metadata))[0].title, 'three');
  appendSessionIndexDuringLoad = false;
  assert.strictEqual(
    (await history.list(metadata))[0].title,
    'three-appended',
    'The next read should converge after an append that raced the previous load',
  );
  assert.strictEqual(historyLoads, 4, 'An append-only source should not exhaust reconciliation retries');

  const scaleHome = path.join(root, 'scale-codex');
  const scaleSessionsRoot = path.join(scaleHome, 'sessions');
  const scaleSessionsDir = path.join(scaleSessionsRoot, '2026', '08', '01');
  const scaleIndex = path.join(scaleHome, 'session_index.jsonl');
  const scaleClaudeHome = path.join(root, 'scale-claude');
  const scaleClaudeProject = path.join(scaleClaudeHome, 'projects', '-repo-scale');
  const scaleCount = 1_714;
  fs.mkdirSync(scaleSessionsDir, { recursive: true });
  fs.mkdirSync(scaleClaudeProject, { recursive: true });
  const scaleIndexLines: string[] = [];
  for (let index = 0; index < scaleCount; index += 1) {
    const suffix = String(index + 1).padStart(12, '0');
    const id = `019f0000-0000-7000-8000-${suffix}`;
    const title = index === scaleCount - 1 ? 'Needle Codex scale tail' : `Scale Codex ${index + 1}`;
    const timestamp = `2026-08-01T00:${String(index % 60).padStart(2, '0')}:00.000Z`;
    fs.writeFileSync(
      path.join(scaleSessionsDir, `rollout-2026-08-01T00-00-00-${id}.jsonl`),
      `${JSON.stringify({
        timestamp,
        type: 'session_meta',
        payload: { id, cwd: '/repo/scale-codex', source: 'cli' },
      })}\n`,
    );
    scaleIndexLines.push(JSON.stringify({ id, thread_name: title, updated_at: timestamp }));
  }
  fs.writeFileSync(scaleIndex, `${scaleIndexLines.join('\n')}\n`);
  const initialClaudeId = '029f0000-0000-7000-8000-000000000001';
  fs.writeFileSync(path.join(scaleClaudeHome, 'history.jsonl'), `${JSON.stringify({
    sessionId: initialClaudeId,
    display: 'Scale Claude initial',
    project: '/repo/scale-claude',
    timestamp: '2026-08-01T01:00:00.000Z',
  })}\n`);
  fs.writeFileSync(path.join(scaleClaudeProject, `${initialClaudeId}.jsonl`), [
    JSON.stringify({
      type: 'user',
      sessionId: initialClaudeId,
      cwd: '/repo/scale-claude',
      timestamp: '2026-08-01T01:00:00.000Z',
      message: { role: 'user', content: 'Scale Claude initial' },
    }),
    JSON.stringify({
      type: 'ai-title',
      sessionId: initialClaudeId,
      timestamp: '2026-08-01T01:00:01.000Z',
      aiTitle: 'Scale Claude initial',
    }),
  ].join('\n'));

  const scaleHistory = new AgentSessionInventory({
    cacheFile: path.join(root, 'cache', 'scale-history.json'),
  });
  caches.push(scaleHistory);
  const scaleMetadata = () => ({
    providerHomes: {
      codex: [{ id: 'scale', path: scaleHome }],
      claude: [{ id: 'scale', path: scaleClaudeHome }],
    },
    providerSessionBindings: [],
  });
  const providerRoots = [path.resolve(scaleHome), path.resolve(scaleClaudeHome)];
  const insideProviderRoot = (candidate: unknown): boolean => {
    if (typeof candidate !== 'string' && !Buffer.isBuffer(candidate)) return false;
    const resolved = path.resolve(String(candidate));
    return providerRoots.some(providerRoot => (
      resolved === providerRoot || resolved.startsWith(`${providerRoot}${path.sep}`)
    ));
  };
  const originalReaddir = fs.promises.readdir;
  const originalReaddirSync = fs.readdirSync;
  const originalStatSync = fs.statSync;
  const originalOpenSync = fs.openSync;
  const originalReadFileSync = fs.readFileSync;
  const originalCreateReadStream = fs.createReadStream;
  const synchronousProviderReads: string[] = [];
  const metadataStreams: Array<{ closed: boolean; fd: number | null }> = [];
  let unrelatedTurns = 0;
  let yieldedDuringScan = false;
  fs.promises.readdir = async (...args: Parameters<typeof fs.promises.readdir>) => {
    if (!yieldedDuringScan && path.resolve(String(args[0])) === scaleSessionsRoot) {
      yieldedDuringScan = true;
      await new Promise<void>(resolve => setImmediate(() => {
        unrelatedTurns += 1;
        resolve();
      }));
    }
    return originalReaddir(...args);
  };
  fs.readdirSync = ((candidate: unknown, ...args: unknown[]) => {
    if (insideProviderRoot(candidate)) synchronousProviderReads.push(`readdir:${String(candidate)}`);
    return originalReaddirSync(candidate, ...args);
  }) as typeof fs.readdirSync;
  fs.statSync = ((candidate: unknown, ...args: unknown[]) => {
    if (insideProviderRoot(candidate)) synchronousProviderReads.push(`stat:${String(candidate)}`);
    return originalStatSync(candidate, ...args);
  }) as typeof fs.statSync;
  fs.openSync = ((candidate: unknown, ...args: unknown[]) => {
    if (insideProviderRoot(candidate)) synchronousProviderReads.push(`open:${String(candidate)}`);
    return originalOpenSync(candidate, ...args);
  }) as typeof fs.openSync;
  fs.readFileSync = ((candidate: unknown, ...args: unknown[]) => {
    if (insideProviderRoot(candidate)) synchronousProviderReads.push(`read:${String(candidate)}`);
    return originalReadFileSync(candidate, ...args);
  }) as typeof fs.readFileSync;
  fs.createReadStream = ((candidate: unknown, ...args: unknown[]) => {
    const stream = originalCreateReadStream(candidate, ...args);
    if (insideProviderRoot(candidate)) metadataStreams.push(stream);
    return stream;
  }) as typeof fs.createReadStream;

  let scaleSessions;
  try {
    scaleSessions = await scaleHistory.list(scaleMetadata);
  } finally {
    fs.promises.readdir = originalReaddir;
    fs.readdirSync = originalReaddirSync;
    fs.statSync = originalStatSync;
    fs.openSync = originalOpenSync;
    fs.readFileSync = originalReadFileSync;
    fs.createReadStream = originalCreateReadStream;
  }
  assert.strictEqual(scaleSessions.length, scaleCount + 1, 'production-shaped inventory must return every Codex and Claude session');
  assert.strictEqual(unrelatedTurns, 1, 'an unrelated event-loop turn must run while the authoritative scan is active');
  assert.deepStrictEqual(synchronousProviderReads, [], 'provider discovery must not perform synchronous filesystem reads');
  assert.strictEqual(metadataStreams.length, scaleCount + 1);
  assert.strictEqual(
    metadataStreams.every(stream => stream.closed && stream.fd === null),
    true,
    'every provider metadata stream must be closed before inventory resolves',
  );
  assert.strictEqual(searchAgentSessions(scaleSessions, 'Needle Codex scale tail').total, 1);

  const originalWarmOpen = fs.promises.open;
  let repeatedTranscriptOpens = 0;
  fs.promises.open = async (...args: Parameters<typeof fs.promises.open>) => {
    if (insideProviderRoot(args[0]) && String(args[0]).endsWith('.jsonl')) repeatedTranscriptOpens += 1;
    return originalWarmOpen(...args);
  };
  let repeatedScaleSessions;
  try {
    repeatedScaleSessions = await scaleHistory.list(scaleMetadata);
    const repeatedAgain = await scaleHistory.list(scaleMetadata);
    assert.deepStrictEqual(
      repeatedAgain.map(session => `${session.provider}:${session.id}`),
      scaleSessions.map(session => `${session.provider}:${session.id}`),
      'repeated History reads must preserve the complete authoritative result',
    );
    assert.strictEqual(searchAgentSessions(repeatedAgain, 'Needle Codex scale tail').total, 1);
  } finally {
    fs.promises.open = originalWarmOpen;
  }
  assert.strictEqual(repeatedScaleSessions.length, scaleCount + 1);
  assert.strictEqual(repeatedTranscriptOpens, 0, 'warm History and Search must not reopen unchanged transcript contents');

  const externalCodexId = '019f0000-0000-7000-8000-000000001715';
  fs.writeFileSync(
    path.join(scaleSessionsDir, `rollout-2026-08-01T02-00-00-${externalCodexId}.jsonl`),
    `${JSON.stringify({
      timestamp: '2026-08-01T02:00:00.000Z',
      type: 'session_meta',
      payload: { id: externalCodexId, cwd: '/repo/scale-codex', source: 'cli' },
    })}\n`,
  );
  fs.appendFileSync(scaleIndex, `${JSON.stringify({
    id: externalCodexId,
    thread_name: 'External Codex write',
    updated_at: '2026-08-01T02:00:00.000Z',
  })}\n`);
  const externalClaudeId = '029f0000-0000-7000-8000-000000000002';
  fs.writeFileSync(path.join(scaleClaudeProject, `${externalClaudeId}.jsonl`), [
    JSON.stringify({
      type: 'user',
      sessionId: externalClaudeId,
      cwd: '/repo/scale-claude',
      timestamp: '2026-08-01T02:01:00.000Z',
      message: { role: 'user', content: 'External Claude write' },
    }),
    JSON.stringify({
      type: 'ai-title',
      sessionId: externalClaudeId,
      timestamp: '2026-08-01T02:01:01.000Z',
      aiTitle: 'External Claude write',
    }),
  ].join('\n'));
  const externallyRefreshed = await scaleHistory.list(scaleMetadata);
  assert.strictEqual(externallyRefreshed.length, scaleCount + 3);
  assert.strictEqual(searchAgentSessions(externallyRefreshed, 'External Codex write').total, 1);
  assert.strictEqual(searchAgentSessions(externallyRefreshed, 'External Claude write').total, 1);
  scaleHistory.invalidate();
  const invalidatedScaleSessions = await scaleHistory.list(scaleMetadata);
  assert.deepStrictEqual(
    invalidatedScaleSessions.map(session => `${session.provider}:${session.id}`),
    externallyRefreshed.map(session => `${session.provider}:${session.id}`),
    'explicit invalidation must rebuild the same complete authoritative inventory',
  );
  assert.strictEqual(
    activeFsWatcherCount(),
    initialWatcherCount,
    'History inventory must not create a persistent recursive watcher',
  );

  let extensionLoads = 0;
  const extensions = new AgentExtensionInventory({
    cacheFile: path.join(root, 'cache', 'extensions.json'),
    discoverExtensions: options => {
      extensionLoads += 1;
      const skill = path.join(options.providerHomePath, 'skills', 'example', 'SKILL.md');
      return [{
        id: 'skill:example',
        name: fs.readFileSync(skill, 'utf8').includes('Second') ? 'Second' : 'First',
        description: '',
        kind: 'skill',
        scope: 'Home',
        status: 'configured',
        sourceFile: 'skills/example/SKILL.md',
      }];
    },
    readConfiguration: () => ({ exists: false, filePath: 'config.toml', summary: [] }),
  });
  caches.push(extensions);

  assert.strictEqual((await extensions.get('codex', codexHome)).extensions[0].name, 'First');
  assert.strictEqual((await extensions.get('codex', codexHome)).extensions[0].name, 'First');
  assert.strictEqual(extensionLoads, 1);
  fs.writeFileSync(path.join(skillsRoot, 'SKILL.md'), '---\nname: Second\n---\n');
  assert.strictEqual((await extensions.get('codex', codexHome)).extensions[0].name, 'Second');
  assert.strictEqual(extensionLoads, 2, 'Plugins should reconcile a changed Home before returning');
  assert.ok(
    activeFsWatcherCount() > initialWatcherCount,
    'The active-handle probe must observe a real non-History filesystem watcher',
  );

  const migrationCacheFile = path.join(root, 'cache', 'migration-extensions.json');
  const legacyExtensions = new AgentExtensionInventory({
    cacheFile: migrationCacheFile,
    discoverExtensions: () => [{
      id: 'plugin:computer-use',
      name: 'Legacy Computer Use',
      description: '',
      kind: 'plugin',
      scope: 'Plugin',
      status: 'configured',
      sourceFile: 'plugins/computer-use/.codex-plugin/plugin.json',
    }],
    readConfiguration: () => ({ exists: false, filePath: 'config.toml', summary: [] }),
  });
  assert.strictEqual((await legacyExtensions.get('codex', codexHome)).extensions[0].name, 'Legacy Computer Use');
  await legacyExtensions.close();
  const legacySnapshot = JSON.parse(fs.readFileSync(migrationCacheFile, 'utf8'));
  const currentKey = Object.keys(legacySnapshot.entries)[0];
  const legacyKey = JSON.stringify({ version: 2, provider: 'codex', homePath: path.resolve(codexHome) });
  legacySnapshot.entries[legacyKey] = legacySnapshot.entries[currentKey];
  delete legacySnapshot.entries[currentKey];
  fs.writeFileSync(migrationCacheFile, JSON.stringify(legacySnapshot));

  let migrationLoads = 0;
  const migratedExtensions = new AgentExtensionInventory({
    cacheFile: migrationCacheFile,
    discoverExtensions: () => {
      migrationLoads += 1;
      return [{
        id: 'plugin:computer-use',
        name: 'Computer Use',
        description: '',
        kind: 'plugin',
        scope: 'Plugin',
        status: 'configured',
        sourceFile: 'plugins/computer-use/.codex-plugin/plugin.json',
        iconPath: 'plugins/computer-use/assets/app-icon.png',
      }];
    },
    readConfiguration: () => ({ exists: false, filePath: 'config.toml', summary: [] }),
  });
  caches.push(migratedExtensions);
  const migratedComputerUse = (await migratedExtensions.get('codex', codexHome)).extensions[0];
  assert.strictEqual(migratedComputerUse.name, 'Computer Use');
  assert.strictEqual(migratedComputerUse.iconPath, 'plugins/computer-use/assets/app-icon.png');
  assert.strictEqual(migrationLoads, 1, 'Plugin icon schema changes must bypass the previous cached inventory schema');

  console.log('test-agent-inventories passed');
  } finally {
    const closeResults = await Promise.allSettled(caches.map(cache => cache.close()));
    await drainClosedFsWatchers();
    let finalWatcherCount = -1;
    try {
      finalWatcherCount = activeFsWatcherCount();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
    assert.strictEqual(
      closeResults.every(result => result.status === 'fulfilled'),
      true,
      'every inventory cache must close successfully',
    );
    assert.strictEqual(finalWatcherCount, initialWatcherCount, 'inventory close must release every filesystem watcher');
    assert.strictEqual(fs.existsSync(root), false, 'inventory fixtures must remove their exact temporary root');
  }
}

run().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
