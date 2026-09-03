#!/usr/bin/env node

import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { terminateOwnedProcessGroups } from './run-playwright-isolated-lanes.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const ISOLATED_RUNNER = path.join(SCRIPT_DIR, 'run-playwright-isolated-lanes.mjs');
const STOP_GRACE_MS = 5_000;

export const DEFAULT_MAX_CHROMIUM_LANES = 6;

export const PLAYWRIGHT_PROJECT_MATRIX = Object.freeze([
  { project: 'chromium', browser: 'chromium', tests: 604, lanes: 6, portBase: 43_100, displayBase: 90, auth: false },
  { project: 'iphone-webkit', browser: 'webkit', tests: 45, lanes: 2, portBase: 43_200, displayBase: 110, auth: false },
  { project: 'iphone-human-webkit', browser: 'webkit', tests: 26, lanes: 1, portBase: 43_300, displayBase: 120, auth: false },
  { project: 'android-human-chromium', browser: 'chromium', tests: 29, lanes: 1, portBase: 43_400, displayBase: 130, auth: false },
  { project: 'mobile-auth-chromium', browser: 'chromium', tests: 1, lanes: 1, portBase: 43_500, displayBase: 140, auth: true },
  { project: 'mobile-auth-webkit', browser: 'webkit', tests: 1, lanes: 1, portBase: 43_600, displayBase: 150, auth: true },
]);

const MAX_CONFIGURABLE_CHROMIUM_LANES = PLAYWRIGHT_PROJECT_MATRIX
  .filter(entry => entry.browser === 'chromium')
  .reduce((sum, entry) => sum + entry.lanes, 0);

export function verifyGitWorkspace({
  cwd = REPO_ROOT,
  execFile = execFileSync,
} = {}) {
  const git = args => {
    try {
      return String(execFile('git', args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })).trim();
    } catch (error) {
      const detail = String(error?.stderr || error?.message || error).trim();
      throw new Error(
        `Playwright matrix requires a real Git worktree with a resolvable HEAD at ${cwd}${detail ? `: ${detail}` : ''}`,
      );
    }
  };
  if (git(['rev-parse', '--is-inside-work-tree']) !== 'true') {
    throw new Error(`Playwright matrix requires a real Git worktree at ${cwd}`);
  }
  const head = git(['rev-parse', '--verify', 'HEAD^{commit}']);
  if (!/^[0-9a-f]{40,64}$/i.test(head)) {
    throw new Error(`Playwright matrix could not resolve a commit HEAD at ${cwd}`);
  }
  return head;
}

function parsePositiveInteger(value, label) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || String(parsed) !== String(value)) {
    throw new Error(`${label} must be a positive integer, received: ${value}`);
  }
  return parsed;
}

function isolatedInvocation(entry, laneIndex) {
  return {
    command: process.execPath,
    args: [
      ISOLATED_RUNNER,
      '--project', entry.project,
      '--lanes', String(entry.lanes),
      ...(laneIndex === undefined ? [] : ['--lane-index', String(laneIndex)]),
      '--headed-xvfb',
      '--skip-build',
      '--retain-evidence',
    ],
    env: {
      ...process.env,
      FARMING_PLAYWRIGHT_PORT_BASE: String(entry.portBase),
      FARMING_PLAYWRIGHT_XVFB_DISPLAY_BASE: String(entry.displayBase),
      FARMING_PLAYWRIGHT_AUTH: entry.auth ? '1' : '0',
    },
  };
}

export function projectInvocation(entry) {
  return isolatedInvocation(entry);
}

export function laneInvocation(entry, laneIndex) {
  return isolatedInvocation(entry, laneIndex);
}

export function createMatrixLaneTasks(matrix = PLAYWRIGHT_PROJECT_MATRIX) {
  return matrix.flatMap(entry =>
    Array.from({ length: entry.lanes }, (_, offset) => {
      const laneIndex = offset + 1;
      return {
        entry,
        laneIndex,
        label: `${entry.project} lane ${laneIndex}/${entry.lanes}`,
        invocation: laneInvocation(entry, laneIndex),
      };
    }),
  );
}

function shellCommand(task) {
  const { entry, invocation } = task;
  return [
    `FARMING_PLAYWRIGHT_PORT_BASE=${entry.portBase}`,
    `FARMING_PLAYWRIGHT_XVFB_DISPLAY_BASE=${entry.displayBase}`,
    `FARMING_PLAYWRIGHT_AUTH=${entry.auth ? 1 : 0}`,
    invocation.command,
    ...invocation.args,
  ].join(' ');
}

function childResult(child) {
  return new Promise(resolve => {
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    child.once('error', error => finish({ code: 1, error }));
    child.once('exit', (code, signal) => finish({
      code: code ?? (signal ? 1 : 0),
      signal,
    }));
  });
}

function spawnOwned(spawnChild, ownedChildren, command, args, options) {
  const child = spawnChild(command, args, { ...options, detached: true });
  const record = {
    child,
    pid: child.pid,
    result: childResult(child),
  };
  ownedChildren.add(record);
  record.result.finally(() => ownedChildren.delete(record));
  return record;
}

async function executeBuild({ spawnChild, ownedChildren }) {
  const build = spawnOwned(
    spawnChild,
    ownedChildren,
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['run', 'build'],
    { cwd: REPO_ROOT, env: process.env, stdio: 'inherit' },
  );
  const result = await build.result;
  if (result.code !== 0) {
    throw new Error(`Playwright matrix build failed with exit code ${result.code}`);
  }
}

async function executeTask(task, { spawnChild, ownedChildren }) {
  const { invocation } = task;
  const record = spawnOwned(
    spawnChild,
    ownedChildren,
    invocation.command,
    invocation.args,
    { cwd: REPO_ROOT, env: invocation.env, stdio: 'inherit' },
  );
  return await record.result;
}

async function runTaskPool(tasks, concurrency, runTask, shouldContinue) {
  const results = [];
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, tasks.length) },
    async () => {
      while (shouldContinue()) {
        const taskIndex = nextIndex;
        nextIndex += 1;
        if (taskIndex >= tasks.length) return;
        const task = tasks[taskIndex];
        let result;
        try {
          result = await runTask(task);
        } catch (error) {
          result = { code: 1, error };
        }
        results.push({ task, result });
      }
    },
  );
  await Promise.all(workers);
  return results;
}

export function parseArgs(argv) {
  const options = {
    dryRun: false,
    skipBuild: false,
    maxChromiumLanes: DEFAULT_MAX_CHROMIUM_LANES,
  };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    let key;
    if (argument === '--dry-run') {
      key = '--dry-run';
      options.dryRun = true;
    } else if (argument === '--skip-build') {
      key = '--skip-build';
      options.skipBuild = true;
    } else if (argument === '--max-chromium-lanes') {
      key = '--max-chromium-lanes';
      options.maxChromiumLanes = parsePositiveInteger(argv[++index], key);
    } else if (argument.startsWith('--max-chromium-lanes=')) {
      key = '--max-chromium-lanes';
      options.maxChromiumLanes = parsePositiveInteger(argument.slice(`${key}=`.length), key);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
    if (seen.has(key)) throw new Error(`Duplicate argument: ${key}`);
    seen.add(key);
  }
  if (options.maxChromiumLanes > MAX_CONFIGURABLE_CHROMIUM_LANES) {
    throw new Error(
      `--max-chromium-lanes must be at most ${MAX_CONFIGURABLE_CHROMIUM_LANES}, received: ${options.maxChromiumLanes}`,
    );
  }
  return options;
}

export async function run(argv = process.argv.slice(2), dependencies = {}) {
  const { dryRun, skipBuild, maxChromiumLanes } = parseArgs(argv);
  const platform = dependencies.platform ?? process.platform;
  const spawnChild = dependencies.spawn ?? spawn;
  const runBuild = dependencies.executeBuild ?? executeBuild;
  const runTask = dependencies.executeTask ?? executeTask;
  const verifyWorkspace = dependencies.verifyWorkspace ?? verifyGitWorkspace;
  const wait = dependencies.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const killGroup = dependencies.killGroup ?? process.kill;
  const stopOwned = dependencies.terminateOwned
    ?? (ownedChildren => terminateOwnedProcessGroups(ownedChildren, {
      graceMs: STOP_GRACE_MS,
      wait,
      killGroup,
    }));
  const writeStdout = dependencies.writeStdout ?? (text => process.stdout.write(text));
  const writeStderr = dependencies.writeStderr ?? (text => process.stderr.write(text));
  const tasks = createMatrixLaneTasks();

  if (platform !== 'linux' && !dryRun) {
    throw new Error('The complete headed Playwright matrix is supported only on Linux');
  }

  if (dryRun) {
    if (!skipBuild) writeStdout('npm run build\n');
    tasks.forEach(task => writeStdout(`${shellCommand(task)}\n`));
    return 0;
  }

  await verifyWorkspace();

  const ownedChildren = new Set();
  let interrupted = false;
  let terminationPromise;
  const requestTermination = signal => {
    interrupted = true;
    writeStderr(`Received ${signal}; stopping owned Playwright matrix process groups\n`);
    terminationPromise ??= stopOwned(ownedChildren);
  };
  const handlers = new Map();
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    const handler = () => requestTermination(signal);
    handlers.set(signal, handler);
    process.once(signal, handler);
  }

  try {
    if (!skipBuild) {
      await runBuild({ spawnChild, ownedChildren });
      if (interrupted) return 1;
    }

    const chromiumTasks = tasks.filter(task => task.entry.browser === 'chromium');
    const webkitTasks = tasks.filter(task => task.entry.browser === 'webkit');
    const execute = task => runTask(task, { spawnChild, ownedChildren });
    const shouldContinue = () => !interrupted;
    const [chromiumResults, webkitResults] = await Promise.all([
      runTaskPool(chromiumTasks, maxChromiumLanes, execute, shouldContinue),
      runTaskPool(webkitTasks, Math.max(webkitTasks.length, 1), execute, shouldContinue),
    ]);
    const results = [...chromiumResults, ...webkitResults];
    const failures = results.filter(({ result }) => result.code !== 0);
    failures.forEach(({ task, result }) => {
      writeStderr(`${task.label} failed with exit code ${result.code}\n`);
    });
    return interrupted || failures.length > 0 ? 1 : 0;
  } finally {
    await (terminationPromise ?? stopOwned(ownedChildren));
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().then(code => { process.exitCode = code; }).catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
