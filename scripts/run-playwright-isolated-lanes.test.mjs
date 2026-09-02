import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  LANE_DIRECTORY_ENV,
  LANE_FILE_ENV,
  createLaneCommand,
  createLaneResources,
  isXvfbDisplayAvailable,
  parseArgs,
  prepareLaneExecutionCopy,
  run,
  terminateOwnedProcessGroups,
  validateResourceRanges,
} from './run-playwright-isolated-lanes.mjs';
import {
  DEFAULT_MAX_CHROMIUM_LANES,
  PLAYWRIGHT_PROJECT_MATRIX,
  createMatrixLaneTasks,
  parseArgs as parseMatrixArgs,
  run as runMatrix,
  projectInvocation,
} from './run-playwright-full-matrix.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const BALANCED_RUNNER = path.join(SCRIPT_DIR, 'run-playwright-balanced-shard.mjs');
const PLAYWRIGHT_CLI = path.join(REPO_ROOT, 'node_modules', '@playwright', 'test', 'cli.js');
const FULL_MATRIX_RUNNER = path.join(SCRIPT_DIR, 'run-playwright-full-matrix.mjs');

function discoverProjectTests(entry) {
  const result = spawnSync(process.execPath, [
    PLAYWRIGHT_CLI,
    'test',
    `--project=${entry.project}`,
    '--list',
  ], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      FARMING_PLAYWRIGHT_AUTH: entry.auth ? '1' : '0',
    },
    maxBuffer: 20 * 1024 * 1024,
    timeout: 15_000,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout
    .split(/\r?\n/)
    .flatMap(line => {
      const match = line.match(/^\s+\[[^\]]+\] › (.+):(\d+):(\d+) › /);
      return match ? [`${match[1]}:${match[2]}`] : [];
    });
}

function listBalancedShard(entry, laneIndex) {
  const result = spawnSync(process.execPath, [
    BALANCED_RUNNER,
    '--project',
    entry.project,
    '--shard',
    `${laneIndex}/${entry.lanes}`,
    '--list-selected',
  ], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      FARMING_PLAYWRIGHT_AUTH: entry.auth ? '1' : '0',
    },
    maxBuffer: 20 * 1024 * 1024,
    timeout: 15_000,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout
    .split(/\r?\n/)
    .filter(line => /(?:^|\/)[^/]+\.spec\.ts:\d+$/.test(line));
}

function baseDependencies(overrides = {}) {
  return {
    isTcpPortAvailable: async () => true,
    executeBuild: async () => {},
    executeLane: async () => 0,
    prepareLaneExecutionCopy: async ({ laneRoot }) => path.join(laneRoot, 'repo'),
    mkdtemp: async () => '/tmp/farming-playwright-lanes-test',
    mkdir: async () => {},
    rm: async () => {},
    wait: async () => {},
    writeStdout: () => {},
    writeStderr: () => {},
    ...overrides,
  };
}

test('accepts only the isolated runner contract and translates list to balanced list-selected', () => {
  const options = parseArgs([
    '--project', 'chromium',
    '--lanes=3',
    '--skip-build',
    '--list',
  ]);
  assert.deepEqual(options, {
    project: 'chromium',
    lanes: 3,
    laneIndex: undefined,
    dryRun: false,
    list: true,
    skipBuild: true,
    headedXvfb: false,
    retainEvidence: false,
  });
  assert.throws(
    () => parseArgs(['--project', 'chromium', '--lanes', '2', '--workers=4']),
    /Unknown argument/,
  );

  const command = createLaneCommand({
    project: 'chromium',
    lanes: 3,
    laneIndex: 2,
    list: true,
    cloneRoot: '/tmp/lane-2/repo',
  });
  assert.deepEqual(command.args, [
    path.join('/tmp/lane-2/repo', 'scripts', 'run-playwright-balanced-shard.mjs'),
    '--project',
    'chromium',
    '--shard',
    '2/3',
    '--list-selected',
  ]);
  assert.equal(command.args.includes('--skip-build'), false);
  assert.equal(command.args.includes('--list'), false);
});

test('a selected logical lane keeps its full shard identity and checks only its own resources', async () => {
  const checkedPorts = [];
  const checkedDisplays = [];
  const executed = [];
  const exitCode = await run(
    [
      '--project', 'chromium',
      '--lanes', '9',
      '--lane-index', '7',
      '--headed-xvfb',
      '--skip-build',
    ],
    baseDependencies({
      platform: 'linux',
      commandExists: async () => true,
      isTcpPortAvailable: async port => {
        checkedPorts.push(port);
        return true;
      },
      isXvfbDisplayAvailable: async display => {
        checkedDisplays.push(display);
        return true;
      },
      executeLane: async ({ lane }) => {
        executed.push({
          laneIndex: lane.laneIndex,
          port: lane.env.FARMING_PLAYWRIGHT_PORT,
          display: lane.env.DISPLAY,
          shard: lane.args.slice(-1)[0],
        });
        return 0;
      },
    }),
  );
  assert.equal(exitCode, 0);
  assert.deepEqual(checkedPorts, [43106]);
  assert.deepEqual(checkedDisplays, [96]);
  assert.deepEqual(executed, [{
    laneIndex: 7,
    port: '43106',
    display: ':96',
    shard: '7/9',
  }]);
  assert.throws(
    () => parseArgs(['--project', 'chromium', '--lanes', '3', '--lane-index', '4']),
    /at most --lanes \(3\)/,
  );
});

test('assigns every lane unique ports, directories, displays, and single-file screenshot paths', () => {
  assert.deepEqual(Object.keys(LANE_DIRECTORY_ENV).sort(), [
    'FARMING_FILE_OPERATION_AUDIT_DIR',
    'FARMING_GLOBAL_FILE_SEARCH_MOBILE_AUDIT_DIR',
    'FARMING_IPHONE_MOBILE_AUDIT_DIR',
    'FARMING_MARKDOWN_MATH_CAPTURE_DIR',
    'FARMING_MOBILE_PLUGIN_AUDIT_DIR',
    'FARMING_MOBILE_VISUAL_AUDIT_DIR',
    'FARMING_PET_REMINDER_SCREENSHOT_DIR',
    'FARMING_PET_SETUP_SCREENSHOT_DIR',
    'FARMING_PLAYWRIGHT_AUDIT_DIR',
    'FARMING_PLAYWRIGHT_CONFIG_DIR',
    'FARMING_PLAYWRIGHT_HTML_REPORT_DIR',
    'FARMING_PLAYWRIGHT_OUTPUT_DIR',
    'FARMING_PLAYWRIGHT_SCREENSHOT_DIR',
    'FARMING_REAL_AGENT_IPHONE_AUDIT_DIR',
    'FARMING_VISUAL_EVIDENCE_DIR',
    'FARMING_VISUAL_OUTPUT_DIR',
    'PLAYWRIGHT_HTML_OUTPUT_DIR',
    'TMPDIR',
  ]);
  assert.deepEqual(Object.keys(LANE_FILE_ENV), ['FARMING_ACP_COMMAND_SCREENSHOT_PATH']);
  const root = '/tmp/isolated-lanes';
  const lanes = [1, 2, 3].map(laneIndex => createLaneResources({
    root,
    laneIndex,
    basePort: 43100,
    display: 89 + laneIndex,
  }));

  assert.deepEqual(lanes.map(lane => lane.env.FARMING_PLAYWRIGHT_PORT), ['43100', '43101', '43102']);
  assert.deepEqual(lanes.map(lane => lane.env.DISPLAY), [':90', ':91', ':92']);
  for (const envName of [...Object.keys(LANE_DIRECTORY_ENV), ...Object.keys(LANE_FILE_ENV)]) {
    assert.equal(new Set(lanes.map(lane => lane.env[envName])).size, lanes.length, envName);
  }
  for (const lane of lanes) {
    assert.equal(lane.env.FARMING_PLAYWRIGHT_SKIP_BUILD, '1');
    assert.equal(lane.env.FARMING_PLAYWRIGHT_RETRIES, '0');
    assert.equal(lane.env.FARMING_PLAYWRIGHT_HEADED, '1');
    assert.match(lane.env.FARMING_ACP_COMMAND_SCREENSHOT_PATH, /long-command-activity\.png$/);
    assert.equal(
      lane.env.PLAYWRIGHT_HTML_OUTPUT_DIR,
      lane.env.FARMING_PLAYWRIGHT_HTML_REPORT_DIR,
    );
  }
});

test('prepareLaneExecutionCopy creates isolated clones that do not leak writes between lanes', { timeout: 30_000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'farming-isolation-test-'));
  const sandbox = path.join(root, 'source');
  const laneARoot = path.join(root, 'lane-a');
  const laneBRoot = path.join(root, 'lane-b');
  try {
    function git(args, opts = {}) {
      const result = spawnSync('git', args, { encoding: 'utf8', ...opts });
      assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr || result.error?.message}`);
      return result;
    }
    git(['init', '-b', 'main', sandbox]);
    git(['-C', sandbox, 'config', 'user.email', 'test@farming.local']);
    git(['-C', sandbox, 'config', 'user.name', 'Farming Test']);

    mkdirSync(path.join(sandbox, 'src'), { recursive: true });
    mkdirSync(path.join(sandbox, 'test'), { recursive: true });
    mkdirSync(path.join(sandbox, 'snapshots'), { recursive: true });
    mkdirSync(path.join(sandbox, 'node_modules'));
    mkdirSync(path.join(sandbox, 'dist'));
    writeFileSync(path.join(sandbox, 'src', 'app.ts'), 'export const app = "hello";\n');
    writeFileSync(path.join(sandbox, 'src', 'executable.sh'), '#!/bin/sh\necho farming\n');
    chmodSync(path.join(sandbox, 'src', 'executable.sh'), 0o755);
    writeFileSync(path.join(sandbox, 'src', 'link-target.txt'), 'source link target\n');
    symlinkSync('link-target.txt', path.join(sandbox, 'src', 'link.txt'));
    writeFileSync(path.join(sandbox, 'test', 'app.spec.ts'), 'import { app } from "../src/app";\n');
    writeFileSync(path.join(sandbox, 'snapshots', 'base.png'), Buffer.from('snapshot-base-content'));

    git(['-C', sandbox, 'add', '-A']);
    git(['-C', sandbox, 'commit', '-m', 'initial']);

    writeFileSync(path.join(sandbox, 'src', 'app.ts'), 'export const app = "modified wip";\n');
    writeFileSync(path.join(sandbox, 'untracked.txt'), 'untracked wip content\n');

    const sourceHashBefore = git(['-C', sandbox, 'rev-parse', 'HEAD']).stdout.trim();
    const sourceStatusBefore = git(['-C', sandbox, 'status', '--porcelain']).stdout;

    mkdirSync(laneARoot, { recursive: true });
    mkdirSync(laneBRoot, { recursive: true });

    const ownedA = new Set();
    const ownedB = new Set();
    const spawnedCommands = [];
    const spawnWithoutRsync = (command, args, options) => {
      spawnedCommands.push(command);
      assert.notEqual(command, 'rsync', 'lane preparation must not depend on external rsync');
      return spawn(command, args, options);
    };
    const cloneA = await prepareLaneExecutionCopy({
      repoRoot: sandbox,
      laneRoot: laneARoot,
      spawnChild: spawnWithoutRsync,
      ownedChildren: ownedA,
    });
    const cloneB = await prepareLaneExecutionCopy({
      repoRoot: sandbox,
      laneRoot: laneBRoot,
      spawnChild: spawnWithoutRsync,
      ownedChildren: ownedB,
    });

    assert.equal(readFileSync(path.join(cloneA, 'src', 'app.ts'), 'utf8'), 'export const app = "modified wip";\n');
    assert.equal(readFileSync(path.join(cloneB, 'src', 'app.ts'), 'utf8'), 'export const app = "modified wip";\n');
    assert.equal(readFileSync(path.join(cloneA, 'untracked.txt'), 'utf8'), 'untracked wip content\n');
    assert.equal(readFileSync(path.join(cloneB, 'untracked.txt'), 'utf8'), 'untracked wip content\n');
    assert.equal(spawnedCommands.includes('rsync'), false);
    assert.equal(lstatSync(path.join(cloneA, 'src', 'link.txt')).isSymbolicLink(), true);
    assert.equal(readlinkSync(path.join(cloneA, 'src', 'link.txt')), 'link-target.txt');
    assert.notEqual(
      lstatSync(path.join(cloneA, 'src', 'app.ts')).ino,
      lstatSync(path.join(sandbox, 'src', 'app.ts')).ino,
      'tracked regular files must be copied rather than hard-linked',
    );
    assert.notEqual(
      lstatSync(path.join(cloneA, 'src', 'link.txt')).ino,
      lstatSync(path.join(sandbox, 'src', 'link.txt')).ino,
      'tracked symbolic links must be recreated rather than hard-linked',
    );
    assert.equal(lstatSync(path.join(cloneA, 'src', 'executable.sh')).mode & 0o111, 0o111);

    writeFileSync(path.join(cloneA, 'src', 'link.txt'), 'lane-a link target\n');
    assert.equal(
      readFileSync(path.join(sandbox, 'src', 'link-target.txt'), 'utf8'),
      'source link target\n',
      'writing through a cloned relative symlink must stay inside the clone',
    );

    writeFileSync(path.join(cloneA, 'snapshots', 'base.png'), Buffer.from('lane-a-modified-snapshot'));
    writeFileSync(path.join(cloneA, 'snapshots', 'lane-a-only.png'), Buffer.from('lane-a-only-content'));

    assert.deepEqual(
      readFileSync(path.join(sandbox, 'snapshots', 'base.png')),
      Buffer.from('snapshot-base-content'),
    );
    assert.equal(existsSync(path.join(sandbox, 'snapshots', 'lane-a-only.png')), false);
    const sourceStatusAfter = git(['-C', sandbox, 'status', '--porcelain']).stdout;
    const sourceHashAfter = git(['-C', sandbox, 'rev-parse', 'HEAD']).stdout.trim();
    assert.equal(sourceStatusAfter, sourceStatusBefore, 'source git status must be unchanged');
    assert.equal(sourceHashAfter, sourceHashBefore, 'source HEAD must be unchanged');
    assert.match(sourceStatusAfter, / M src\/app\.ts/);
    assert.match(sourceStatusAfter, /\?\? untracked\.txt/);
    assert.equal(sourceStatusAfter.includes('lane-a-only.png'), false);

    assert.deepEqual(
      readFileSync(path.join(cloneB, 'snapshots', 'base.png')),
      Buffer.from('snapshot-base-content'),
    );
    assert.equal(existsSync(path.join(cloneB, 'snapshots', 'lane-a-only.png')), false);
    const laneBStatus = git(['-C', cloneB, 'status', '--porcelain']).stdout;
    assert.match(laneBStatus, / M src\/app\.ts/);
    assert.match(laneBStatus, /\?\? untracked\.txt/);
    assert.equal(laneBStatus.includes('lane-a-only.png'), false);

    assert.equal(lstatSync(path.join(cloneA, 'node_modules')).isSymbolicLink(), true);
    assert.equal(lstatSync(path.join(cloneA, 'dist')).isSymbolicLink(), true);
    assert.equal(lstatSync(path.join(cloneB, 'node_modules')).isSymbolicLink(), true);
    assert.equal(lstatSync(path.join(cloneB, 'dist')).isSymbolicLink(), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('prepareLaneExecutionCopy copies generated runtime artifacts for plain node and fails closed when one is missing', { timeout: 30_000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'farming-runtime-inheritance-test-'));
  const sandbox = path.join(root, 'source');
  const laneRoot = path.join(root, 'lane');
  const missingLaneRoot = path.join(root, 'missing-lane');
  try {
    function git(args, opts = {}) {
      const result = spawnSync('git', args, { encoding: 'utf8', ...opts });
      assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr || result.error?.message}`);
      return result;
    }
    git(['init', '-b', 'main', sandbox]);
    git(['-C', sandbox, 'config', 'user.email', 'test@farming.local']);
    git(['-C', sandbox, 'config', 'user.name', 'Farming Test']);

    mkdirSync(path.join(sandbox, 'backend'), { recursive: true });
    writeFileSync(
      path.join(sandbox, '.gitignore'),
      'backend/**/*.cjs\nbackend/**/*.cjs.map\nbackend/*.cjs\nbackend/*.cjs.map\n',
    );
    writeFileSync(path.join(sandbox, 'backend', 'native-pty-host.cts'), 'export {};\n');
    writeFileSync(path.join(sandbox, 'backend', 'acp-runtime-host-process.cts'), 'export {};\n');
    writeFileSync(
      path.join(sandbox, 'backend', 'native-pty-host.cjs'),
      [
        '// Generated by scripts/build-backend-runtime.ts. Do not edit.',
        '"use strict";',
        'console.log("native-host-ok");',
        '//# sourceMappingURL=native-pty-host.cjs.map',
        '',
      ].join('\n'),
    );
    chmodSync(path.join(sandbox, 'backend', 'native-pty-host.cjs'), 0o755);
    writeFileSync(
      path.join(sandbox, 'backend', 'native-pty-host.cjs.map'),
      '{"version":3,"sources":["native-pty-host.cts"],"mappings":""}\n',
    );
    writeFileSync(
      path.join(sandbox, 'backend', 'acp-runtime-host-process.cjs'),
      [
        '// Generated by scripts/build-backend-runtime.ts. Do not edit.',
        '"use strict";',
        'module.exports = { runtime: "acp-host-ok" };',
        '//# sourceMappingURL=acp-runtime-host-process.cjs.map',
        '',
      ].join('\n'),
    );
    writeFileSync(
      path.join(sandbox, 'backend', 'acp-runtime-host-process.cjs.map'),
      '{"version":3,"sources":["acp-runtime-host-process.cts"],"mappings":""}\n',
    );
    git(['-C', sandbox, 'add', '-A']);
    git(['-C', sandbox, 'commit', '-m', 'runtime sources']);

    mkdirSync(laneRoot, { recursive: true });
    const cloneRoot = await prepareLaneExecutionCopy({
      repoRoot: sandbox,
      laneRoot,
      spawnChild: spawn,
      ownedChildren: new Set(),
    });

    for (const relativePath of [
      'backend/native-pty-host.cjs',
      'backend/native-pty-host.cjs.map',
      'backend/acp-runtime-host-process.cjs',
      'backend/acp-runtime-host-process.cjs.map',
    ]) {
      assert.equal(lstatSync(path.join(cloneRoot, relativePath)).isFile(), true, relativePath);
      assert.notEqual(
        lstatSync(path.join(cloneRoot, relativePath)).ino,
        lstatSync(path.join(sandbox, relativePath)).ino,
        `${relativePath} must be an isolated copy`,
      );
    }
    assert.equal(lstatSync(path.join(cloneRoot, 'backend', 'native-pty-host.cjs')).mode & 0o111, 0o111);

    const nativeResult = spawnSync(
      process.execPath,
      [path.join(cloneRoot, 'backend', 'native-pty-host.cjs')],
      { cwd: cloneRoot, encoding: 'utf8' },
    );
    assert.equal(nativeResult.status, 0, nativeResult.stderr);
    assert.equal(nativeResult.stdout.trim(), 'native-host-ok');

    const acpResult = spawnSync(
      process.execPath,
      ['-e', 'console.log(require("./backend/acp-runtime-host-process.cjs").runtime)'],
      { cwd: cloneRoot, encoding: 'utf8' },
    );
    assert.equal(acpResult.status, 0, acpResult.stderr);
    assert.equal(acpResult.stdout.trim(), 'acp-host-ok');

    rmSync(path.join(sandbox, 'backend', 'native-pty-host.cjs'));
    mkdirSync(missingLaneRoot, { recursive: true });
    await assert.rejects(
      prepareLaneExecutionCopy({
        repoRoot: sandbox,
        laneRoot: missingLaneRoot,
        spawnChild: spawn,
        ownedChildren: new Set(),
      }),
      /Generated runtime artifact backend\/native-pty-host\.cjs is missing.*npm run build:backend-runtime/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('prepareLaneExecutionCopy clones are independent git identities — no hard links', { timeout: 30_000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'farming-isolation-test-'));
  const sandbox = path.join(root, 'source');
  const laneARoot = path.join(root, 'lane-a');
  const laneBRoot = path.join(root, 'lane-b');
  try {
    function git(args, opts = {}) {
      const result = spawnSync('git', args, { encoding: 'utf8', ...opts });
      assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr || result.error?.message}`);
      return result;
    }
    git(['init', '-b', 'main', sandbox]);
    git(['-C', sandbox, 'config', 'user.email', 'test@farming.local']);
    git(['-C', sandbox, 'config', 'user.name', 'Farming Test']);
    mkdirSync(path.join(sandbox, 'src'), { recursive: true });
    mkdirSync(path.join(sandbox, 'node_modules'));
    mkdirSync(path.join(sandbox, 'dist'));
    writeFileSync(path.join(sandbox, 'src', 'lib.ts'), 'export const x = 1;\n');
    git(['-C', sandbox, 'add', '-A']);
    git(['-C', sandbox, 'commit', '-m', 'initial']);

    mkdirSync(laneARoot, { recursive: true });
    mkdirSync(laneBRoot, { recursive: true });

    const cloneA = await prepareLaneExecutionCopy({ repoRoot: sandbox, laneRoot: laneARoot, spawnChild: spawn, ownedChildren: new Set() });
    const cloneB = await prepareLaneExecutionCopy({ repoRoot: sandbox, laneRoot: laneBRoot, spawnChild: spawn, ownedChildren: new Set() });

    const inoA = lstatSync(path.join(cloneA, 'src', 'lib.ts')).ino;
    const inoB = lstatSync(path.join(cloneB, 'src', 'lib.ts')).ino;
    const inoSource = lstatSync(path.join(sandbox, 'src', 'lib.ts')).ino;
    assert.notEqual(inoA, inoB, 'clone A and clone B must not share inodes');
    assert.notEqual(inoA, inoSource, 'clone A and source must not share inodes');
    assert.notEqual(inoB, inoSource, 'clone B and source must not share inodes');

    const alternatesA = readFileSync(path.join(cloneA, '.git', 'objects', 'info', 'alternates'), 'utf8');
    assert.match(alternatesA.trim(), /objects$/);
    const alternatesB = readFileSync(path.join(cloneB, '.git', 'objects', 'info', 'alternates'), 'utf8');
    assert.match(alternatesB.trim(), /objects$/);

    writeFileSync(path.join(cloneA, 'src', 'lib.ts'), 'export const x = 42;\n');
    git(['-C', cloneA, 'config', 'user.email', 'test@farming.local']);
    git(['-C', cloneA, 'config', 'user.name', 'Farming Test']);
    git(['-C', cloneA, 'add', 'src/lib.ts']);
    git(['-C', cloneA, 'commit', '-m', 'lane-a-only']);
    const logA = git(['-C', cloneA, 'log', '--oneline']).stdout;
    const logB = git(['-C', cloneB, 'log', '--oneline']).stdout;
    assert.match(logA, /lane-a-only/);
    assert.equal(logB.includes('lane-a-only'), false, 'lane B must not see lane A commit');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test('SIGTERM during preparation fails closed: TERM/KILL delivered, lane not started, evidence retained, process.exitCode restored', async () => {
  const savedExitCode = process.exitCode;
  const signalSource = new EventEmitter();
  const signals = [];
  let pidCounter = 100;
  const childrenByPid = new Map();

  class FakeChild extends EventEmitter {
    constructor(pid) {
      super();
      this.pid = pid;
      this.stdout = new EventEmitter();
      this.stderr = new EventEmitter();
      this.stdin = { end: () => {} };
    }
  }

  // Fake spawn schedules SIGTERM only after the first child and listeners are
  // attached, so the signal arrives during actual lane preparation.
  const fakeSpawn = (_command, _args, _options) => {
    const child = new FakeChild(pidCounter++);
    childrenByPid.set(child.pid, child);
    setImmediate(() => {
      signalSource.emit('SIGTERM');
    });
    return child;
  };

  // Fake SIGTERM keeps child live; fake SIGKILL ends stdout/stderr then emits exit.
  const killGroup = (pgid, signal) => {
    signals.push([pgid, signal]);
    for (const [pid, child] of childrenByPid) {
      if (-pid === pgid) {
        if (signal === 'SIGKILL') {
          child.stdout.emit('end');
          child.stderr.emit('end');
          child.emit('exit', null, 'SIGKILL');
        }
        // SIGTERM: keep child live, no exit
      }
    }
  };

  let laneStarted = false;
  let tempRemoved = false;
  let stderr = '';

  try {
    const exitCode = await run(
      ['--project', 'chromium', '--lanes', '1', '--skip-build'],
      {
        signalSource,
        killGroup,
        spawn: fakeSpawn,
        isTcpPortAvailable: async () => true,
        wait: async () => {}, // zero grace period
        executeBuild: async () => {},
        executeLane: async () => { laneStarted = true; return 0; },
        mkdtemp: async () => '/tmp/farming-playwright-lanes-test',
        mkdir: async () => {},
        rm: async (target) => {
          if (target === '/tmp/farming-playwright-lanes-test') tempRemoved = true;
        },
        writeStdout: () => {},
        writeStderr: text => { stderr += text; },
      },
    );

    assert.equal(exitCode, 1);
    assert.equal(laneStarted, false);
    assert.equal(tempRemoved, false);
    // Must deliver TERM then KILL, in order, to a process group.
    assert.ok(signals.length >= 2, 'must deliver at least TERM and KILL');
    const termIndex = signals.findIndex(([pgid, sig]) => pgid < 0 && sig === 'SIGTERM');
    const killIndex = signals.findIndex(([pgid, sig]) => pgid < 0 && sig === 'SIGKILL');
    assert.ok(termIndex >= 0, 'must deliver SIGTERM to a process group');
    assert.ok(killIndex >= 0, 'must deliver SIGKILL to a process group');
    assert.ok(termIndex < killIndex, 'SIGTERM must precede SIGKILL');
    assert.match(stderr, /SIGTERM/);
    // Signal handler must have set process.exitCode and run must restore it.
    assert.equal(process.exitCode, savedExitCode);
  } finally {
    process.exitCode = savedExitCode;
  }
});

test('spawn capture proves cwd is cloneRoot and runner arg is inside clone, never source path', { timeout: 15_000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'farming-spawn-test-'));
  try {
    let cloneRoot;
    const spawnCalls = [];
    const fakeSpawn = (command, args, options) => {
      spawnCalls.push({ command, args, options });
      const child = new EventEmitter();
      child.pid = 9000 + spawnCalls.length;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = { end: () => {} };
      setImmediate(() => child.emit('exit', 0));
      return child;
    };
    const exitCode = await run(
      ['--project', 'chromium', '--lanes', '1', '--skip-build'],
      {
        platform: 'linux',
        spawn: fakeSpawn,
        isTcpPortAvailable: async () => true,
        mkdtemp: async () => root,
        mkdir: async () => {},
        rm: async () => {},
        executeBuild: async () => {},
        prepareLaneExecutionCopy: async ({ laneRoot }) => {
          cloneRoot = path.join(laneRoot, 'repo');
          mkdirSync(cloneRoot, { recursive: true });
          mkdirSync(path.join(cloneRoot, 'scripts'), { recursive: true });
          writeFileSync(
            path.join(cloneRoot, 'scripts', 'run-playwright-balanced-shard.mjs'),
            '',
          );
          return cloneRoot;
        },
      },
    );
    assert.equal(exitCode, 0);
    assert.ok(spawnCalls.length >= 1, 'must spawn at least the lane runner');
    const runnerCall = spawnCalls.find(c => c.args[0] && c.args[0].includes('run-playwright-balanced-shard.mjs'));
    assert.ok(runnerCall, 'must find the lane runner spawn call');
    assert.equal(runnerCall.options.cwd, cloneRoot, 'cwd must equal cloneRoot exactly');
    assert.equal(
      runnerCall.args[0],
      path.join(cloneRoot, 'scripts', 'run-playwright-balanced-shard.mjs'),
      'args[0] must be cloneRoot/scripts/run-playwright-balanced-shard.mjs',
    );
    assert.ok(
      !runnerCall.args[0].includes(SCRIPT_DIR),
      'runner arg must not be source path',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('run awaits all preparation promises before cleanup, never starts lanes until all settle', async () => {
  const savedExitCode = process.exitCode;
  const signalSource = new EventEmitter();
  let releaseLane2;
  const lane2Promise = new Promise(resolve => { releaseLane2 = resolve; });
  let laneStarted = false;
  let stderr = '';
  let tempRemoved = false;

  const prepareLaneCopy = async ({ laneRoot }) => {
    if (laneRoot.includes('lane-1')) {
      signalSource.emit('SIGTERM');
      throw new Error('lane-1 preparation failed');
    }
    await lane2Promise;
    return path.join(laneRoot, 'repo');
  };

  try {
    const tempRoot = '/tmp/farming-playwright-lanes-concurrency-test';
    const runPromise = run(
      ['--project', 'chromium', '--lanes', '2', '--skip-build'],
      {
        signalSource,
        isTcpPortAvailable: async () => true,
        wait: async () => {},
        executeBuild: async () => {},
        executeLane: async () => { laneStarted = true; return 0; },
        prepareLaneExecutionCopy: prepareLaneCopy,
        mkdtemp: async () => tempRoot,
        mkdir: async () => {},
        rm: async (target) => {
          if (target === tempRoot) tempRemoved = true;
        },
        writeStdout: () => {},
        writeStderr: text => { stderr += text; },
      },
    );

    // run must still be pending because lane 2 has not settled.
    const race = await Promise.race([
      runPromise.then(code => ({ resolved: true, code })),
      new Promise(resolve => setTimeout(() => resolve({ resolved: false }), 100)),
    ]);
    assert.equal(race.resolved, false, 'run must still be pending while lane 2 is unsettled');
    assert.equal(laneStarted, false, 'no lane must start before all preparations settle');

    // Release lane 2; run should finish and return 1.
    releaseLane2();
    const exitCode = await runPromise;
    assert.equal(exitCode, 1);
    assert.equal(laneStarted, false, 'no lane must start after preparation failure');
    assert.equal(tempRemoved, false, 'evidence temp root must be retained');
    assert.match(stderr, /SIGTERM/);
  } finally {
    process.exitCode = savedExitCode;
  }
});

test('complete matrix covers all 703 discovered tests exactly once across 12 logical lanes', { timeout: 90_000 }, () => {
  let discoveredTotal = 0;
  assert.deepEqual(PLAYWRIGHT_PROJECT_MATRIX.map(entry => entry.lanes), [6, 2, 1, 1, 1, 1]);
  const tasks = createMatrixLaneTasks();
  assert.equal(tasks.length, 12);
  assert.equal(new Set(tasks.map(task => `${task.entry.project}:${task.laneIndex}`)).size, 12);
  const ports = new Set();
  const displays = new Set();
  for (const entry of PLAYWRIGHT_PROJECT_MATRIX) {
    const discovered = discoverProjectTests(entry);
    const discoveredCount = discovered.length;
    assert.equal(discoveredCount, entry.tests, entry.project);
    discoveredTotal += discoveredCount;
    const assignedLocations = entry.lanes
      ? Array.from({ length: entry.lanes }, (_, offset) => listBalancedShard(entry, offset + 1)).flat()
      : [];
    assert.equal(
      new Set(assignedLocations).size,
      assignedLocations.length,
      `${entry.project} assigned a test location more than once`,
    );
    assert.deepEqual(
      new Set(assignedLocations),
      new Set(discovered),
      `${entry.project} lost or duplicated discovered inventory`,
    );
    for (let offset = 0; offset < entry.lanes; offset += 1) {
      assert.equal(ports.has(entry.portBase + offset), false);
      assert.equal(displays.has(entry.displayBase + offset), false);
      ports.add(entry.portBase + offset);
      displays.add(entry.displayBase + offset);
    }
    const invocation = projectInvocation(entry);
    assert.equal(invocation.args.includes('--headed-xvfb'), true);
    assert.equal(invocation.args.includes('--skip-build'), true);
    assert.equal(invocation.args.includes('--retain-evidence'), true);
    assert.equal(invocation.env.FARMING_PLAYWRIGHT_AUTH, entry.auth ? '1' : '0');
  }
  assert.equal(discoveredTotal, 703);
  // Main chromium lanes must equal the default global Chromium concurrency cap.
  const mainChromium = PLAYWRIGHT_PROJECT_MATRIX.find(entry => entry.project === 'chromium');
  assert.equal(mainChromium.lanes, DEFAULT_MAX_CHROMIUM_LANES);
});

test('full matrix accepts only explicit top-level build controls', () => {
  assert.deepEqual(parseMatrixArgs([]), {
    dryRun: false,
    skipBuild: false,
    maxChromiumLanes: DEFAULT_MAX_CHROMIUM_LANES,
  });
  assert.deepEqual(parseMatrixArgs(['--skip-build']), {
    dryRun: false,
    skipBuild: true,
    maxChromiumLanes: DEFAULT_MAX_CHROMIUM_LANES,
  });
  assert.deepEqual(
    parseMatrixArgs(['--skip-build', '--dry-run', '--max-chromium-lanes=4']),
    { dryRun: true, skipBuild: true, maxChromiumLanes: 4 },
  );
  assert.throws(() => parseMatrixArgs(['--workers=4']), /Unknown argument/);
  assert.throws(() => parseMatrixArgs(['--skip-build', '--skip-build']), /Duplicate argument/);
  assert.throws(() => parseMatrixArgs(['--max-chromium-lanes=0']), /positive integer/);
  assert.throws(() => parseMatrixArgs(['--max-chromium-lanes=9']), /at most 8/);
});

test('full matrix dry-run builds once by default and omits only the build on request', () => {
  const runDry = extraArgs => spawnSync(process.execPath, [
    FULL_MATRIX_RUNNER,
    '--dry-run',
    ...extraArgs,
  ], { cwd: REPO_ROOT, encoding: 'utf8' });

  const withBuild = runDry([]);
  const withoutBuild = runDry(['--skip-build']);
  assert.equal(withBuild.status, 0, withBuild.stderr);
  assert.equal(withoutBuild.status, 0, withoutBuild.stderr);

  const withBuildLines = withBuild.stdout.trim().split(/\r?\n/);
  const withoutBuildLines = withoutBuild.stdout.trim().split(/\r?\n/);
  assert.equal(withBuildLines[0], 'npm run build');
  assert.equal(withBuildLines.length, 13);
  assert.equal(withoutBuildLines.length, 12);
  assert.equal(withoutBuildLines.includes('npm run build'), false);
  assert.deepEqual(withBuildLines.slice(1), withoutBuildLines);
  assert.equal(withoutBuildLines.every(line => line.includes('--skip-build')), true);
  assert.equal(withoutBuildLines.every(line => line.includes('--lane-index')), true);
});

test('full matrix fails closed on an invalid Git workspace before build or lane spawn', async () => {
  const calls = [];
  await assert.rejects(
    runMatrix([], {
      platform: 'linux',
      verifyWorkspace: () => {
        calls.push('git-preflight');
        throw new Error('Playwright matrix requires a real Git worktree with a resolvable HEAD');
      },
      executeBuild: async () => { calls.push('build'); },
      executeTask: async () => {
        calls.push('lane');
        return { code: 0 };
      },
      terminateOwned: async () => { calls.push('cleanup'); },
      writeStdout: () => {},
      writeStderr: () => {},
    }),
    /real Git worktree with a resolvable HEAD/,
  );
  assert.deepEqual(calls, ['git-preflight']);
});

test('full matrix globally caps Chromium lanes at six, all main chromium lanes start before any finishes', async () => {
  let activeChromium = 0;
  let peakChromium = 0;
  let activeWebKit = 0;
  let peakWebKit = 0;
  const started = [];
  const completed = [];
  const mainChromiumStarted = [];
  const mainChromiumCompleted = [];
  let secondWave = false;
  const exitCode = await runMatrix([], {
    platform: 'linux',
    executeBuild: async () => {},
    executeTask: async task => {
      started.push(task.label);
      if (task.entry.browser === 'chromium') {
        activeChromium += 1;
        peakChromium = Math.max(peakChromium, activeChromium);
        if (task.entry.project === 'chromium') {
          mainChromiumStarted.push(task.label);
          // If any main chromium lane has already completed, this is a second wave.
          if (mainChromiumCompleted.length > 0) secondWave = true;
        }
      } else {
        activeWebKit += 1;
        peakWebKit = Math.max(peakWebKit, activeWebKit);
      }
      await new Promise(resolve => setTimeout(resolve, 5));
      if (task.entry.browser === 'chromium') {
        activeChromium -= 1;
        if (task.entry.project === 'chromium') {
          mainChromiumCompleted.push(task.label);
        }
      } else activeWebKit -= 1;
      completed.push(task.label);
      return { code: 0 };
    },
    terminateOwned: async () => {},
    writeStdout: () => {},
    writeStderr: () => {},
  });
  assert.equal(exitCode, 0);
  assert.equal(peakChromium, 6);
  assert.ok(peakWebKit > 1);
  assert.equal(started.length, 12);
  assert.deepEqual(new Set(completed), new Set(started));
  // All 6 main chromium lanes must start in the first wave — none waits for a peer.
  assert.equal(mainChromiumStarted.length, 6);
  assert.equal(secondWave, false, 'no main chromium lane must start after a main chromium lane completes');
});

test('full matrix builds exactly once by default and zero times with --skip-build', async () => {
  for (const [args, expectedBuilds] of [[[], 1], [['--skip-build'], 0]]) {
    let builds = 0;
    let lanes = 0;
    const exitCode = await runMatrix(args, {
      platform: 'linux',
      executeBuild: async () => { builds += 1; },
      executeTask: async () => {
        lanes += 1;
        return { code: 0 };
      },
      terminateOwned: async () => {},
      writeStdout: () => {},
      writeStderr: () => {},
    });
    assert.equal(exitCode, 0);
    assert.equal(builds, expectedBuilds);
    assert.equal(lanes, 12);
  }
});

test('full matrix aggregates every lane failure without retry and always cleans owned groups', async () => {
  const attempts = new Map();
  const cleaned = [];
  let stderr = '';
  const exitCode = await runMatrix(['--skip-build'], {
    platform: 'linux',
    executeTask: async task => {
      attempts.set(task.label, (attempts.get(task.label) ?? 0) + 1);
      return { code: task.label === 'chromium lane 2/6' || task.label === 'mobile-auth-webkit lane 1/1' ? 1 : 0 };
    },
    terminateOwned: async owned => { cleaned.push(owned); },
    writeStdout: () => {},
    writeStderr: text => { stderr += text; },
  });
  assert.equal(exitCode, 1);
  assert.equal(attempts.size, 12);
  assert.equal([...attempts.values()].every(count => count === 1), true);
  assert.match(stderr, /chromium lane 2\/6 failed with exit code 1/);
  assert.match(stderr, /mobile-auth-webkit lane 1\/1 failed with exit code 1/);
  assert.equal(cleaned.length, 1);
});

test('balanced list-selected shards are complete and non-overlapping', { timeout: 30_000 }, () => {
  const listShard = shard => {
    const result = spawnSync(process.execPath, [
      BALANCED_RUNNER,
      '--project',
      'chromium',
      '--shard',
      `${shard}/2`,
      '--list-selected',
    ], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout
      .split(/\r?\n/)
      .filter(line => /(?:^|\/)[^/]+\.spec\.ts:\d+$/.test(line));
  };

  const chromium = PLAYWRIGHT_PROJECT_MATRIX.find(entry => entry.project === 'chromium');
  assert.ok(chromium);
  const expected = new Set(discoverProjectTests(chromium));

  const first = listShard(1);
  const second = listShard(2);
  assert.equal(first.some(location => second.includes(location)), false);
  assert.deepEqual(new Set([...first, ...second]), expected);
});


test('rejects invalid port and headed display ranges before build or temp creation', async () => {
  assert.throws(
    () => validateResourceRanges({ basePort: 65_535, baseDisplay: 90, lanes: 2, headedXvfb: false }),
    /port range 65535-65536 exceeds 65535/,
  );
  assert.throws(
    () => validateResourceRanges({ basePort: 43_100, baseDisplay: 65_535, lanes: 2, headedXvfb: true }),
    /display range :65535-:65536 exceeds :65535/,
  );

  for (const env of [
    { FARMING_PLAYWRIGHT_PORT_BASE: '65535' },
    { FARMING_PLAYWRIGHT_XVFB_DISPLAY_BASE: '65535' },
  ]) {
    const calls = [];
    await assert.rejects(
      run(
        ['--project', 'chromium', '--lanes', '2', '--headed-xvfb'],
        baseDependencies({
          platform: 'linux',
          env,
          executeBuild: async () => { calls.push('build'); },
          mkdtemp: async () => { calls.push('mkdtemp'); return '/tmp/unexpected'; },
        }),
      ),
      /exceeds/,
    );
    assert.deepEqual(calls, []);
  }
});

test('fails closed before build or temp creation when a lane port is occupied', async () => {
  let buildCount = 0;
  let tempCount = 0;
  await assert.rejects(
    run(['--project', 'chromium', '--lanes', '2'], baseDependencies({
      isTcpPortAvailable: async port => port !== 43101,
      executeBuild: async () => { buildCount += 1; },
      mkdtemp: async () => {
        tempCount += 1;
        return '/tmp/should-not-exist';
      },
    })),
    /port 43101 is already in use/,
  );
  assert.equal(buildCount, 0);
  assert.equal(tempCount, 0);
});

test('dry-run has no build, service, directory, or temp-root side effect', async () => {
  const calls = [];
  let output = '';
  const exitCode = await run(
    ['--project', 'chromium', '--lanes', '2', '--dry-run'],
    {
      isTcpPortAvailable: async () => { calls.push('port'); return true; },
      executeBuild: async () => { calls.push('build'); },
      executeLane: async () => { calls.push('lane'); return 0; },
      mkdtemp: async () => { calls.push('mkdtemp'); return '/tmp/unexpected'; },
      mkdir: async () => { calls.push('mkdir'); },
      rm: async () => { calls.push('rm'); },
      writeStdout: text => { output += text; },
    },
  );
  assert.equal(exitCode, 0);
  assert.deepEqual(calls, []);
  const parsed = JSON.parse(output);
  assert.equal(parsed.tempRoot, null);
  assert.equal(parsed.lanes.length, 2);
  for (const lane of parsed.lanes) {
    assert.equal(lane.command, process.execPath);
    assert.ok(
      lane.args[0].includes('lane-'),
      'args[0] must be in the lane clone, not the source runner',
    );
    assert.ok(
      lane.args[0].includes('/repo/scripts/run-playwright-balanced-shard.mjs'),
      'args[0] must point to the clone copy of the balanced runner',
    );
    assert.ok(
      lane.cloneRoot.endsWith('/repo'),
      'cloneRoot must point to the lane clone',
    );
  }
});

test('builds once by default, skips on request, and never delegates a per-lane build', async () => {
  for (const [extraArgs, expectedBuilds] of [[[], 1], [['--skip-build'], 0]]) {
    let buildCount = 0;
    const laneSkipBuild = [];
    const exitCode = await run(
      ['--project', 'chromium', '--lanes', '3', ...extraArgs],
      baseDependencies({
        executeBuild: async () => { buildCount += 1; },
        executeLane: async ({ lane }) => {
          laneSkipBuild.push(lane.env.FARMING_PLAYWRIGHT_SKIP_BUILD);
          return 0;
        },
      }),
    );
    assert.equal(exitCode, 0);
    assert.equal(buildCount, expectedBuilds);
    assert.deepEqual(laneSkipBuild, ['1', '1', '1']);
  }
});

test('collects every lane terminal result and retains failed-lane evidence', async () => {
  const completed = [];
  const removed = [];
  let stderr = '';
  const exitCode = await run(
    ['--project', 'chromium', '--lanes', '2', '--skip-build'],
    baseDependencies({
      executeLane: async ({ lane }) => {
        if (lane.laneIndex === 2) await new Promise(resolve => setTimeout(resolve, 20));
        completed.push(lane.laneIndex);
        return lane.laneIndex === 1 ? 1 : 0;
      },
      rm: async target => { removed.push(target); },
      writeStderr: text => { stderr += text; },
    }),
  );
  assert.equal(exitCode, 1);
  assert.deepEqual(completed.sort(), [1, 2]);
  assert.deepEqual(removed, []);
  assert.match(stderr, /evidence retained at \/tmp\/farming-playwright-lanes-test/);
  assert.match(stderr, /Failed lane 1/);
});

test('successful evidence cleanup is default and explicit retention prints the exact root', async () => {
  for (const [extraArgs, expectedRemovals, expectedMessage] of [
    [[], 1, false],
    [['--retain-evidence'], 0, true],
    [['--keep-evidence'], 0, true],
  ]) {
    const removed = [];
    let stderr = '';
    const exitCode = await run(
      ['--project', 'chromium', '--lanes', '2', '--skip-build', ...extraArgs],
      baseDependencies({
        rm: async (target, options) => { removed.push({ target, options }); },
        writeStderr: text => { stderr += text; },
      }),
    );
    assert.equal(exitCode, 0);
    assert.equal(removed.length, expectedRemovals);
    assert.equal(stderr.includes('evidence retained at /tmp/farming-playwright-lanes-test'), expectedMessage);
  }
});

test('deletes the lane root only after every lane succeeds', async () => {
  const removed = [];
  const exitCode = await run(
    ['--project', 'chromium', '--lanes', '2', '--skip-build'],
    baseDependencies({
      rm: async (target, options) => { removed.push({ target, options }); },
    }),
  );
  assert.equal(exitCode, 0);
  assert.deepEqual(removed, [{
    target: '/tmp/farming-playwright-lanes-test',
    options: { recursive: true, force: true },
  }]);
});

test('TERM and later KILL target only the owned process groups', async () => {
  const signals = [];
  class FakeChild extends EventEmitter {
    kill() {}
  }
  const owned = new Set([
    { pid: 101, child: new FakeChild() },
    { pid: 202, child: new FakeChild() },
  ]);
  await terminateOwnedProcessGroups(owned, {
    graceMs: 0,
    wait: async () => {},
    killGroup: (pid, signal) => { signals.push([pid, signal]); },
  });
  assert.deepEqual(signals, [
    [-101, 'SIGTERM'],
    [-202, 'SIGTERM'],
    [-101, 'SIGKILL'],
    [-202, 'SIGKILL'],
  ]);
  assert.equal(signals.some(([pid]) => pid === -303), false);
});

test('fails closed when Xvfb is missing or its display is occupied', async () => {
  let tempCount = 0;
  const deps = baseDependencies({
    platform: 'linux',
    commandExists: async () => false,
    mkdtemp: async () => {
      tempCount += 1;
      return '/tmp/unexpected';
    },
  });
  await assert.rejects(
    run(['--project', 'chromium', '--lanes', '1', '--headed-xvfb'], deps),
    /Xvfb is required/,
  );
  assert.equal(tempCount, 0);

  await assert.rejects(
    run(['--project', 'chromium', '--lanes', '1', '--headed-xvfb'], {
      ...deps,
      commandExists: async () => true,
      isXvfbDisplayAvailable: async () => false,
    }),
    /display :90 is already in use/,
  );
  assert.equal(tempCount, 0);

  assert.equal(await isXvfbDisplayAvailable(90, async target => target.endsWith('X90')), false);
  assert.equal(await isXvfbDisplayAvailable(91, async () => false), true);
});

test('real dry-run leaves no matching temporary root behind', () => {
  const sandbox = mkdtempSync(path.join(tmpdir(), 'farming-isolated-dry-run-test-'));
  try {
    const result = spawnSync(process.execPath, [
      path.join(SCRIPT_DIR, 'run-playwright-isolated-lanes.mjs'),
      '--project',
      'chromium',
      '--lanes',
      '2',
      '--dry-run',
    ], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: { ...process.env, TMPDIR: sandbox },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      spawnSync(process.execPath, ['-e', 'console.log(require("fs").readdirSync(process.argv[1]).join("\\n"))', sandbox], {
        encoding: 'utf8',
      }).stdout.trim(),
      '',
    );
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});
