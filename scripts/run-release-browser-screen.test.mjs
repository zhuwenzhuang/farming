import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { selectBrowserScreen, readChanges, runBrowserScreen } from './run-release-browser-screen.mjs';
import { run as runIsolated } from './run-playwright-isolated-lanes.mjs';

const changed = ['src/components/files/FileEditorTouchSource.tsx',
  'src/components/code/CodeComposer.tsx', 'tests/e2e/acp-human-cases.spec.ts'];
test('2.2.86 native Files/Composer/disclosure changes select owning bounded lanes', () => {
  const plan = selectBrowserScreen(changed);
  assert.deepEqual(plan.lanes.map(lane => lane.name), ['touch-files', 'mobile-files', 'mobile-auth', 'composer', 'interaction']);
  assert.equal(plan.maxParallel, 4);
  assert.equal(plan.laneTimeoutMs, 180_000);
  assert(plan.timingRisk);
  assert.deepEqual(plan.unmapped, []);
  assert.deepEqual(selectBrowserScreen(['src/lib/workspace-file-links.ts', 'src/lib/composer-paste.ts',
    'backend/acp-runtime.cts', 'shared/acp-messages.ts']).lanes.map(lane => lane.name),
  ['touch-files', 'mobile-files', 'mobile-auth', 'composer', 'interaction']);
  assert.deepEqual(selectBrowserScreen(['backend/control-api.cts', 'tests/e2e/agent-handoff.spec.ts', 'tests/e2e/related-history-recovery.spec.ts'])
    .lanes.map(lane => lane.name), ['interaction']);
  assert.equal(selectBrowserScreen(['package.json', 'backend/provider.cts', 'release-notes/v2.2.86.md']).lanes.length, 0);
  assert.deepEqual(selectBrowserScreen(['src/new-widget.tsx']).unmapped, ['src/new-widget.tsx']);
});
test('unexpected worker rejection leaves unexecuted lanes failed instead of accepting a sparse result array', async () => {
  const fake = runnerDependencies();
  let started = 0;
  const code = await runIsolated(['--project', 'chromium', '--lanes', '5'], {
    ...fake.dependencies.isolated, laneConcurrency: 4,
    executeLane: () => { started++; throw Error('synchronous runner failure before result assignment'); },
  });
  assert.equal(code, 1);
  assert.equal(started, 4, 'the fifth queued lane was never executed and must remain failed');
});
test('explicit Git base includes staged/unstaged tracked changes and new untracked product/test files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'farming-screen-diff-'));
  const git = args => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  try {
    git(['init', '-q']);
    await writeFile(path.join(root, 'package.json'), '{}');
    git(['add', '.']);
    git(['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Demo', '-c', 'user.email=demo@example.com', 'commit', '-qm', 'base']);
    const base = git(['rev-parse', 'HEAD']).trim();
    await writeFile(path.join(root, 'package.json'), '{"changed":true}');
    await mkdir(path.join(root, 'src'), { recursive: true });
    await mkdir(path.join(root, 'tests/e2e'), { recursive: true });
    await writeFile(path.join(root, 'src/new-widget.tsx'), '');
    await writeFile(path.join(root, 'tests/e2e/new-case.spec.ts'), '');
    assert.deepEqual(readChanges(base, root).files, ['package.json', 'src/new-widget.tsx', 'tests/e2e/new-case.spec.ts']);
  } finally { await rm(root, { recursive: true, force: true }); }
});
function runnerDependencies({ buildFails = false, failLane = false } = {}) {
  const writes = [];
  const calls = [];
  const environment = [];
  let builds = 0;
  let active = 0;
  let maximum = 0;
  let completed = 0;
  return {
    writes, calls, environment,
    counts: () => ({ builds, maximum, completed }),
    dependencies: {
      readChanges: () => ({ resolvedBase: 'a'.repeat(40), files: changed }),
      write: value => writes.push(value), isTcpPortAvailable: async () => true,
      isolated: {
        isTcpPortAvailable: async () => true,
        mkdtemp: async () => '/temporary-owned-screen', mkdir: async () => {},
        prepareLaneExecutionCopy: async () => {}, rm: async () => {},
        writeStderr: () => {}, writeStdout: () => {}, signalSource: new EventEmitter(),
        executeBuild: async () => { builds++; if (buildFails) throw Error('build failed'); },
      },
      executeLane: async ({ lane }) => {
        calls.push(lane);
        environment.push(lane.env);
        active++; maximum = Math.max(maximum, active);
        await new Promise(resolve => setTimeout(resolve, lane.laneIndex === 1 ? 20 : 5));
        active--; completed++;
        if (failLane && lane.laneIndex === 1) throw Error('first lane signature');
        return 0;
      },
    },
  };
}
test('one shared build, max four concurrent lanes, isolated ports/Config/evidence and all-settled failure', async () => {
  const fake = runnerDependencies({ failLane: true });
  const code = await runBrowserScreen(['--base', 'HEAD'], fake.dependencies);
  assert.equal(code, 1);
  assert.deepEqual(fake.counts(), { builds: 1, maximum: 4, completed: 5 });
  assert.equal(fake.writes.at(-1).receipts.length, 5);
  for (const key of ['FARMING_PLAYWRIGHT_PORT', 'FARMING_PLAYWRIGHT_CONFIG_DIR', 'FARMING_PLAYWRIGHT_OUTPUT_DIR']) {
    assert.equal(new Set(fake.environment.map(env => env[key])).size, 5);
  }
  for (const lane of fake.calls) {
    assert.equal(lane.env.FARMING_PLAYWRIGHT_SKIP_BUILD, '1');
    assert.equal(lane.env.FARMING_E2E_REAL_CODEX, '0');
    assert(lane.args.includes('--global-timeout=180000'));
    assert(lane.args.includes('--workers=1'));
    assert(lane.args.includes('--retries=0'));
    assert(lane.args.includes('--max-failures=1'));
    assert.equal(lane.command, process.platform === 'win32' ? 'npm.cmd' : 'npm');
  }
});
test('build failure starts zero browser lanes, plan is mutation-free and unknown product changes block', async () => {
  const fake = runnerDependencies({ buildFails: true });
  assert.equal(await runBrowserScreen(['--base', 'HEAD'], fake.dependencies), 1);
  assert.deepEqual(fake.counts(), { builds: 1, maximum: 0, completed: 0 });
  const planned = runnerDependencies();
  assert.equal(await runBrowserScreen(['--base', 'HEAD', '--plan'], planned.dependencies), 0);
  assert.deepEqual(planned.counts(), { builds: 0, maximum: 0, completed: 0 });
  const unknown = runnerDependencies();
  unknown.dependencies.readChanges = () => ({ resolvedBase: 'a'.repeat(40), files: ['src/new-widget.tsx'] });
  assert.equal(await runBrowserScreen(['--base', 'HEAD'], unknown.dependencies), 1);
  assert.deepEqual(unknown.counts(), { builds: 0, maximum: 0, completed: 0 });
});

test('semantic transport changes select the actual LSP browser scenarios', () => {
  const plan = selectBrowserScreen(['shared/workspace-request-scheduling.ts', 'shared/workspace-request-scheduling.js',
    'extensions/language-server/backend/managed-language-server-client.cts', 'tests/e2e/lsp-file-isolation.spec.ts']);
  assert.deepEqual(plan.unmapped, []);
  assert.deepEqual(plan.lanes.map(lane => lane.script), ['release:fast-screen:language-server']);
});

test('A2A plugin and attributed messages select the complete communication story', () => {
  const plan = selectBrowserScreen(['extensions/a2a/frontend/A2aPluginCard.tsx',
    'extensions/a2a/backend/a2a-router.cts', 'shared/agent-communication.ts',
    'src/components/code/PluginsPanel.tsx', 'src/components/code/CodeMainArea.tsx',
    'src/components/code/copy.ts', 'src/components/code/related-session-navigation.ts',
    'src/styles/plugin.css', 'tests/e2e/a2a-plugin.spec.ts',
    'tests/e2e/acp-peer-messages.spec.ts', 'tests/e2e/shared-config-plugin.spec.ts']);
  assert.deepEqual(plan.unmapped, []);
  assert.deepEqual(plan.lanes.map(lane => lane.name), ['interaction', 'communication']);
});


test('convergence changes select focused UI, wire and Computer owners without ignoring generated inputs', () => {
  const plan = selectBrowserScreen(['src/components/code/MobileShareSheet.tsx',
    'src/components/code/MobileUnreadNavigation.tsx', 'src/styles/main.css',
    'tests/e2e/project-subdirectory-scope.spec.ts', 'tests/e2e/transcript-file-links.spec.ts',
    'shared/browser-protocol.ts', 'shared/browser-protocol.js', 'frontend/agent-state-bridge.js',
    'extensions/computer/backend/computer-resource-manager.cts']);
  assert.deepEqual(plan.unmapped, []);
  assert.deepEqual(plan.lanes.map(lane => lane.name),
    ['ui-boundaries', 'mobile-viewport', 'identity-files', 'wire-state', 'computer-resource']);
  assert.equal(plan.maxParallel, 4);
});

// Shared reading owners affect both parked Terminals and mobile unread Chat.
test('read acknowledgement owners select interaction and mobile unread screens', () => {
  const plan = selectBrowserScreen(['src/components/CodeWorkspace.tsx',
    'src/components/code/AgentTranscriptPane.tsx', 'tests/e2e/terminal-state-protocol.spec.ts']);
  assert.deepEqual(plan.unmapped, []);
  assert.deepEqual(plan.lanes.map(lane => lane.name), ['interaction', 'mobile-viewport']);
});
