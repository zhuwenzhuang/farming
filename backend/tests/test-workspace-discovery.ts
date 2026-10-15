const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  discoverAgentWorkspaces,
  resolveEncodedProjectDirectory,
} = require('../workspace-discovery.cjs');

type DiscoveredWorkspaceFixture = {
  path: string;
  agents: string[];
  confidence: string;
};

function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeJsonl(file, records) {
  fs.writeFileSync(file, records.map(record => JSON.stringify(record)).join('\n'));
}

function encodeProjectPath(workspace) {
  return `-${workspace
    .split(path.sep)
    .filter(Boolean)
    .map(segment => segment.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, ''))
    .filter(Boolean)
    .join('-')}`;
}

async function run() {
  // The encoded-directory fallback resolves a real absolute workspace from the
  // filesystem root. A home-scoped fixture remains valid when this repository
  // is tested from an isolated worktree under /tmp.
  const tmpRoot = fs.mkdtempSync(path.join(os.homedir(), '.farming-test-workspace-discovery-'));
  const homeDir = path.join(tmpRoot, 'home', 'admin');
  const projectA = path.join(homeDir, 'example-project');
  const projectB = path.join(homeDir, 'farming');
  const projectC = path.join(homeDir, 'codex-work');

  try {
    mkdirp(projectA);
    mkdirp(projectB);
    mkdirp(projectC);
    const realProjectA = fs.realpathSync(projectA);
    const realProjectB = fs.realpathSync(projectB);
    const realProjectC = fs.realpathSync(projectC);

    const claudeProject = path.join(homeDir, '.claude', 'projects', '-tmp-farming-discovery-missing');
    mkdirp(claudeProject);
    writeJsonl(path.join(claudeProject, 'recent.jsonl'), [
      { type: 'summary' },
      { type: 'user', cwd: projectA },
    ]);

    const qwenProject = path.join(homeDir, '.qwen', 'projects', '-tmp-farming-discovery-qwen');
    mkdirp(qwenProject);
    writeJsonl(path.join(qwenProject, 'recent.jsonl'), [
      { type: 'session', cwd: projectA },
    ]);

    const codexSessionDir = path.join(homeDir, '.codex', 'sessions', '2026', '04', '12');
    mkdirp(codexSessionDir);
    writeJsonl(path.join(codexSessionDir, 'rollout.jsonl'), [
      { type: 'session_meta', payload: { cwd: projectB } },
    ]);

    writeJsonl(path.join(codexSessionDir, 'temp.jsonl'), [
      { type: 'session_meta', payload: { cwd: '/tmp' } },
    ]);

    const agyConversationDir = path.join(homeDir, '.gemini', 'antigravity', 'conversations');
    mkdirp(agyConversationDir);
    const { ensureAgyConversationDatabase } = require('../agy-conversation-store.cjs');
    ensureAgyConversationDatabase(
      path.join(homeDir, '.gemini', 'antigravity'),
      '11111111-2222-4333-8444-555555555555',
      projectB,
    );

    const encodedName = encodeProjectPath(realProjectC);
    const encodedFallback = path.join(homeDir, '.claude', 'projects', encodedName);
    mkdirp(encodedFallback);

    const previousCwd = process.cwd();
    process.chdir('/');
    try {
      assert.strictEqual(
        await resolveEncodedProjectDirectory(encodedName),
        realProjectC
      );
    } finally {
      process.chdir(previousCwd);
    }

    const workspaces = await discoverAgentWorkspaces({ homeDir, limit: 10 });
    const byPath = new Map<string, DiscoveredWorkspaceFixture>(
      workspaces.map(item => [item.path, item]),
    );

    assert.ok(byPath.has(realProjectA), 'Claude/Qwen metadata cwd should be discovered');
    assert.ok(byPath.has(realProjectB), 'Codex/agy session cwd should be discovered');
    assert.ok(byPath.has(realProjectC), 'Encoded project directory fallback should be discovered');
    assert.ok(!byPath.has(fs.realpathSync('/tmp')), 'Temporary root workspace should not be discovered');
    assert.deepStrictEqual([...byPath.get(realProjectA).agents].sort(), ['claude', 'qwen']);
    assert.deepStrictEqual([...byPath.get(realProjectB).agents].sort(), ['agy', 'codex']);
    assert.strictEqual(byPath.get(realProjectA).confidence, 'high');

    const qwenWorkspaces = await discoverAgentWorkspaces({ homeDir, agent: 'qwen', limit: 10 });
    assert.deepStrictEqual(qwenWorkspaces.map(item => item.path), [realProjectA]);

    const codexWorkspaces = await discoverAgentWorkspaces({ homeDir, agent: 'codex', limit: 10 });
    assert.deepStrictEqual(codexWorkspaces.map(item => item.path), [realProjectB]);

    const agyWorkspaces = await discoverAgentWorkspaces({ homeDir, agent: 'agy', limit: 10 });
    assert.deepStrictEqual(agyWorkspaces.map(item => item.path), [realProjectB]);

    const bashWorkspaces = await discoverAgentWorkspaces({ homeDir, agent: 'bash', limit: 10 });
    assert.strictEqual(bashWorkspaces.length, workspaces.length, 'Unknown agent should fall back to global workspace discovery');

    const limited = await discoverAgentWorkspaces({ homeDir, limit: 2 });
    assert.strictEqual(limited.length, 2);

    // A cold suggestions read must not consume an unrelated Home scan's deadline.
    // Simulate the same slow filesystem for both old synchronous and async callers.
    const { mock } = require('node:test');
    const { AsyncCache } = require('../async-cache.cjs');
    const { discoverAgentHomes } = require('../agent-home-discovery.cjs');
    let slowDirectory = '';
    const readSync = fs.readdirSync;
    const readAsync = fs.promises.readdir;
    const sleeper = new Int32Array(new SharedArrayBuffer(4));
    const syncRead = mock.method(fs, 'readdirSync', function (directory, ...args) {
      if (directory === slowDirectory) Atomics.wait(sleeper, 0, 0, 500);
      return readSync.call(fs, directory, ...args);
    });
    const asyncRead = mock.method(fs.promises, 'readdir', async function (directory, ...args) {
      if (directory === slowDirectory) await new Promise(resolve => setTimeout(resolve, 500));
      return readAsync.call(fs.promises, directory, ...args);
    });
    try {
      for (const root of ['.claude/projects', '.qwen/projects', '.codex/sessions', '.gemini/antigravity/conversations']) {
        slowDirectory = path.join(homeDir, root);
        const cache = new AsyncCache(() => discoverAgentWorkspaces({ homeDir }));
        const results = await Promise.allSettled([
          discoverAgentHomes({ userHome: homeDir, env: {}, timeoutMs: 300 }),
          cache.get('cold'),
        ]);
        assert.strictEqual(results[0].status, 'fulfilled', `${root} discovery must not starve Home discovery`);
        assert.strictEqual(results[1].status, 'fulfilled');
      }
    } finally {
      syncRead.mock.restore();
      asyncRead.mock.restore();
    }

    const older = path.join(homeDir, 'ambiguous-name');
    const newer = path.join(homeDir, 'ambiguous_name');
    mkdirp(older);
    mkdirp(newer);
    fs.utimesSync(older, 1000, 1000);
    fs.utimesSync(newer, 2000, 2000);
    assert.strictEqual(await resolveEncodedProjectDirectory(encodeProjectPath(newer)), fs.realpathSync(newer),
      'equally specific encoded names retain the newest-directory tie break');

    const emptyHome = path.join(tmpRoot, 'empty-history');
    const emptyHistory = path.join(emptyHome, '.codex', 'sessions');
    mkdirp(emptyHistory);
    for (let index = 0; index < 4096; index++) mkdirp(path.join(emptyHistory, String(index)));
    await assert.rejects(discoverAgentWorkspaces({ homeDir: emptyHome }), /history directory limit/,
      'a history tree without matching files must still have a traversal bound');

    console.log('test-workspace-discovery passed');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
