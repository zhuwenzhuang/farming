const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  discoverAgentWorkspaces,
  resolveEncodedProjectDirectory,
} = require('../workspace-discovery');

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

function run() {
  const tmpRoot = fs.mkdtempSync(path.join(process.cwd(), '.tmp-farming-workspace-discovery-'));
  const homeDir = path.join(tmpRoot, 'home', 'admin');
  const projectA = path.join(homeDir, 'example-project');
  const projectB = path.join(homeDir, 'farming');
  const projectC = path.join(homeDir, 'codex-work');

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

  const encodedName = encodeProjectPath(realProjectC);
  const encodedFallback = path.join(homeDir, '.claude', 'projects', encodedName);
  mkdirp(encodedFallback);

  const previousCwd = process.cwd();
  process.chdir('/');
  try {
    assert.strictEqual(
      resolveEncodedProjectDirectory(encodedName),
      realProjectC
    );
  } finally {
    process.chdir(previousCwd);
  }

  const workspaces = discoverAgentWorkspaces({ homeDir, limit: 10 });
  const byPath = new Map(workspaces.map(item => [item.path, item]));

  assert.ok(byPath.has(realProjectA), 'Claude/Qwen metadata cwd should be discovered');
  assert.ok(byPath.has(realProjectB), 'Codex session cwd should be discovered');
  assert.ok(byPath.has(realProjectC), 'Encoded project directory fallback should be discovered');
  assert.ok(!byPath.has(fs.realpathSync('/tmp')), 'Temporary root workspace should not be discovered');
  assert.deepStrictEqual([...byPath.get(realProjectA).agents].sort(), ['claude', 'qwen']);
  assert.strictEqual(byPath.get(realProjectA).confidence, 'high');

  const qwenWorkspaces = discoverAgentWorkspaces({ homeDir, agent: 'qwen', limit: 10 });
  assert.deepStrictEqual(qwenWorkspaces.map(item => item.path), [realProjectA]);

  const codexWorkspaces = discoverAgentWorkspaces({ homeDir, agent: 'codex', limit: 10 });
  assert.deepStrictEqual(codexWorkspaces.map(item => item.path), [realProjectB]);

  const bashWorkspaces = discoverAgentWorkspaces({ homeDir, agent: 'bash', limit: 10 });
  assert.strictEqual(bashWorkspaces.length, workspaces.length, 'Unknown agent should fall back to global workspace discovery');

  const limited = discoverAgentWorkspaces({ homeDir, limit: 2 });
  assert.strictEqual(limited.length, 2);

  const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert(
    serverSource.includes('const workspaceDiscoveryCache = new AsyncCache') &&
      serverSource.includes("app.get(routePath(BASE_PATH, '/api/workspaces/discovered')") &&
      serverSource.includes('workspaceDiscoveryCache.get(cacheToken)'),
    'workspace discovery API should cache short-lived scans for faster refresh'
  );

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('test-workspace-discovery passed');
}

run();
