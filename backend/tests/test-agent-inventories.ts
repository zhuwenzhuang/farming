const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { AgentExtensionInventory } = require('../agent-extension-inventory.cjs');
const { AgentSessionInventory } = require('../agent-session-inventory.cjs');

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-agent-inventories-'));
  const caches: Array<{ close(): Promise<void> }> = [];
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
  assert.strictEqual((await history.list(metadata))[0].updatedAt, '2026-07-31T00:00:00.000Z');
  assert.strictEqual((await history.list(metadata))[0].title, 'one');
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

  console.log('test-agent-inventories passed');
  } finally {
    await Promise.allSettled(caches.map(cache => cache.close()));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

run().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
