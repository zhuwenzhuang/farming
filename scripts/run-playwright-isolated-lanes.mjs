#!/usr/bin/env node

import { spawn } from 'node:child_process';
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readlink,
  rm,
  symlink,
} from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const BALANCED_RUNNER = path.join(SCRIPT_DIR, 'run-playwright-balanced-shard.mjs');
const DEFAULT_STOP_GRACE_MS = 2_000;
const XVFB_READY_TIMEOUT_MS = 5_000;
const MAX_TCP_PORT = 65_535;
const MAX_XVFB_DISPLAY = 65_535;
const GENERATED_RUNTIME_SOURCE_ONLY_DIRECTORIES = new Set(['tests', 'types', 'vendor']);

export const GENERATED_RUNTIME_OUTPUT_ROOTS = Object.freeze([
  'backend',
  'extensions/browser/backend',
  'extensions/computer/backend',
  'extensions/language-server/backend',
  'extensions/shared-config/backend',
]);

const GENERATED_RUNTIME_SINGLETONS = Object.freeze([
  {
    trigger: 'backend/usage-history-worker.cts',
    outputs: ['backend/usage-history-scanner.generated.js'],
  },
]);

export const LANE_DIRECTORY_ENV = Object.freeze({
  FARMING_PLAYWRIGHT_CONFIG_DIR: 'config',
  TMPDIR: 'tmp',
  FARMING_PLAYWRIGHT_OUTPUT_DIR: 'playwright-output',
  FARMING_PLAYWRIGHT_HTML_REPORT_DIR: 'playwright-report',
  PLAYWRIGHT_HTML_OUTPUT_DIR: 'playwright-report',
  FARMING_PLAYWRIGHT_AUDIT_DIR: 'audit',
  FARMING_PLAYWRIGHT_SCREENSHOT_DIR: 'screenshots',
  FARMING_GLOBAL_FILE_SEARCH_MOBILE_AUDIT_DIR: 'global-file-search-mobile-audit',
  FARMING_MOBILE_PLUGIN_AUDIT_DIR: 'mobile-plugin-audit',
  FARMING_MOBILE_VISUAL_AUDIT_DIR: 'mobile-visual-audit',
  FARMING_IPHONE_MOBILE_AUDIT_DIR: 'iphone-mobile-audit',
  FARMING_REAL_AGENT_IPHONE_AUDIT_DIR: 'real-agent-iphone-audit',
  FARMING_MARKDOWN_MATH_CAPTURE_DIR: 'markdown-math-captures',
  FARMING_PET_SETUP_SCREENSHOT_DIR: 'pet-setup-screenshots',
  FARMING_PET_REMINDER_SCREENSHOT_DIR: 'pet-reminder-screenshots',
  FARMING_VISUAL_EVIDENCE_DIR: 'visual-evidence',
  FARMING_VISUAL_OUTPUT_DIR: 'visual-output',
  FARMING_FILE_OPERATION_AUDIT_DIR: 'file-operation-audit',
});

export const LANE_FILE_ENV = Object.freeze({
  FARMING_ACP_COMMAND_SCREENSHOT_PATH: 'acp-command-screenshots/long-command-activity.png',
});

function parsePositiveInteger(value, label) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || String(parsed) !== String(value)) {
    throw new Error(`${label} must be a positive integer, received: ${value}`);
  }
  return parsed;
}

export function parseArgs(argv, platform = process.platform) {
  const options = {
    project: undefined,
    lanes: undefined,
    laneIndex: undefined,
    dryRun: false,
    list: false,
    skipBuild: false,
    headedXvfb: false,
    retainEvidence: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--project') {
      options.project = argv[++index];
    } else if (argument.startsWith('--project=')) {
      options.project = argument.slice('--project='.length);
    } else if (argument === '--lanes') {
      options.lanes = parsePositiveInteger(argv[++index], '--lanes');
    } else if (argument.startsWith('--lanes=')) {
      options.lanes = parsePositiveInteger(argument.slice('--lanes='.length), '--lanes');
    } else if (argument === '--lane-index') {
      options.laneIndex = parsePositiveInteger(argv[++index], '--lane-index');
    } else if (argument.startsWith('--lane-index=')) {
      options.laneIndex = parsePositiveInteger(argument.slice('--lane-index='.length), '--lane-index');
    } else if (argument === '--dry-run') {
      options.dryRun = true;
    } else if (argument === '--list') {
      options.list = true;
    } else if (argument === '--skip-build') {
      options.skipBuild = true;
    } else if (argument === '--headed-xvfb') {
      options.headedXvfb = true;
    } else if (argument === '--retain-evidence' || argument === '--keep-evidence') {
      options.retainEvidence = true;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (!options.project) throw new Error('--project is required');
  if (!options.lanes) throw new Error('--lanes is required');
  if (options.laneIndex !== undefined && options.laneIndex > options.lanes) {
    throw new Error(`--lane-index must be at most --lanes (${options.lanes}), received: ${options.laneIndex}`);
  }
  if (options.headedXvfb && platform !== 'linux') {
    throw new Error('--headed-xvfb is supported only on Linux');
  }
  return options;
}

export function validateResourceRanges({ basePort, baseDisplay, lanes, headedXvfb }) {
  const lastPort = basePort + lanes - 1;
  if (lastPort > MAX_TCP_PORT) {
    throw new Error(`Playwright lane port range ${basePort}-${lastPort} exceeds ${MAX_TCP_PORT}`);
  }
  if (headedXvfb) {
    const lastDisplay = baseDisplay + lanes - 1;
    if (lastDisplay > MAX_XVFB_DISPLAY) {
      throw new Error(`Xvfb display range :${baseDisplay}-:${lastDisplay} exceeds :${MAX_XVFB_DISPLAY}`);
    }
  }
}

export function createLaneResources({ root, laneIndex, basePort, display }) {
  const laneName = `lane-${laneIndex}`;
  const laneRoot = path.join(root, laneName);
  const env = {
    FARMING_PLAYWRIGHT_PORT: String(basePort + laneIndex - 1),
    FARMING_PLAYWRIGHT_LANE: String(laneIndex),
    FARMING_PLAYWRIGHT_SKIP_BUILD: '1',
    FARMING_PLAYWRIGHT_RETRIES: '0',
  };
  for (const [name, relativePath] of Object.entries(LANE_DIRECTORY_ENV)) {
    env[name] = path.join(laneRoot, relativePath);
  }
  for (const [name, relativePath] of Object.entries(LANE_FILE_ENV)) {
    env[name] = path.join(laneRoot, relativePath);
  }
  if (display !== undefined) {
    env.DISPLAY = `:${display}`;
    env.FARMING_PLAYWRIGHT_HEADED = '1';
  }
  return { laneName, laneRoot, env };
}

export function createLaneCommand({ project, lanes, laneIndex, list, cloneRoot }) {
  const args = [
    path.join(cloneRoot, 'scripts', 'run-playwright-balanced-shard.mjs'),
    '--project',
    project,
    '--shard',
    `${laneIndex}/${lanes}`,
  ];
  if (list) args.push('--list-selected');
  return { command: process.execPath, args };
}

async function commandExists(command) {
  return await new Promise((resolve) => {
    const child = spawn(command, ['-help'], { stdio: 'ignore' });
    child.once('error', () => resolve(false));
    child.once('exit', () => resolve(true));
  });
}

export async function isTcpPortAvailable(port) {
  return await new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      server.close(error => resolve(!error));
    });
  });
}

async function pathExists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

function isMissingPathError(error) {
  return error && typeof error === 'object' && error.code === 'ENOENT';
}

function resolveContainedPath(root, relativePath, label) {
  if (
    typeof relativePath !== 'string'
    || relativePath.length === 0
    || relativePath.includes('\0')
    || path.isAbsolute(relativePath)
  ) {
    throw new Error(`${label} contains an invalid repository path: ${JSON.stringify(relativePath)}`);
  }
  const segments = relativePath.split('/');
  if (segments.some(segment => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new Error(`${label} escapes its repository root: ${JSON.stringify(relativePath)}`);
  }
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, ...segments);
  const containment = path.relative(resolvedRoot, resolved);
  if (
    containment.length === 0
    || containment === '..'
    || containment.startsWith(`..${path.sep}`)
    || path.isAbsolute(containment)
  ) {
    throw new Error(`${label} escapes its repository root: ${JSON.stringify(relativePath)}`);
  }
  return resolved;
}

function parseGitFileManifest(manifest) {
  if (manifest.length === 0) return [];
  if (manifest[manifest.length - 1] !== 0) {
    throw new Error('git ls-files returned a malformed non-NUL-terminated manifest');
  }
  const entries = manifest.subarray(0, -1).toString('utf8').split('\0');
  const seen = new Set();
  for (const entry of entries) {
    if (seen.has(entry)) {
      throw new Error(`git ls-files returned a duplicate repository path: ${JSON.stringify(entry)}`);
    }
    seen.add(entry);
  }
  return entries;
}

async function copyRegularFile(source, destination, sourceStat) {
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(source, destination);
  await chmod(destination, sourceStat.mode & 0o777);
}

/**
 * Copies the exact git-provided tracked + non-ignored untracked manifest.
 * Only regular files and symbolic links are accepted. Every regular file is
 * byte-copied, never linked, and retains its executable permission bits.
 */
export async function copyGitFileManifest({ repoRoot, cloneRoot, manifest }) {
  const records = [];
  for (const relativePath of parseGitFileManifest(manifest)) {
    const source = resolveContainedPath(repoRoot, relativePath, 'Source manifest');
    const destination = resolveContainedPath(cloneRoot, relativePath, 'Lane manifest');
    const sourceStat = await lstat(source);
    if (!sourceStat.isFile() && !sourceStat.isSymbolicLink()) {
      throw new Error(
        `Lane manifest path must be a regular file or symbolic link: ${relativePath}`,
      );
    }
    records.push({
      relativePath,
      source,
      destination,
      sourceStat,
    });
  }

  const symbolicLinks = new Set(
    records
      .filter(record => record.sourceStat.isSymbolicLink())
      .map(record => record.relativePath),
  );
  for (const record of records) {
    let parent = path.posix.dirname(record.relativePath);
    while (parent !== '.') {
      if (symbolicLinks.has(parent)) {
        throw new Error(
          `Lane manifest path ${record.relativePath} is nested below symbolic link ${parent}`,
        );
      }
      parent = path.posix.dirname(parent);
    }
  }

  for (const record of records.sort((left, right) => (
    left.relativePath.localeCompare(right.relativePath)
  ))) {
    await mkdir(path.dirname(record.destination), { recursive: true });
    if (record.sourceStat.isSymbolicLink()) {
      await symlink(await readlink(record.source), record.destination);
    } else {
      await copyRegularFile(record.source, record.destination, record.sourceStat);
    }
  }
}

async function collectRuntimeSources(repoRoot, relativeRoot) {
  const root = resolveContainedPath(repoRoot, relativeRoot, 'Generated runtime root');
  try {
    const rootStat = await lstat(root);
    if (!rootStat.isDirectory()) {
      throw new Error(`Generated runtime root is not a directory: ${relativeRoot}`);
    }
  } catch (error) {
    if (isMissingPathError(error)) return [];
    throw error;
  }

  const sources = [];
  const visit = async (directory, relativeDirectory) => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (GENERATED_RUNTIME_SOURCE_ONLY_DIRECTORIES.has(entry.name)) continue;
        await visit(
          path.join(directory, entry.name),
          relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name,
        );
      } else if (entry.isFile() && entry.name.endsWith('.cts')) {
        sources.push(
          relativeDirectory
            ? `${relativeRoot}/${relativeDirectory}/${entry.name}`
            : `${relativeRoot}/${entry.name}`,
        );
      }
    }
  };
  await visit(root, '');
  return sources;
}

async function copyRequiredGeneratedArtifact(repoRoot, cloneRoot, relativePath, sourcePath) {
  const source = resolveContainedPath(repoRoot, relativePath, 'Generated runtime artifact');
  const destination = resolveContainedPath(cloneRoot, relativePath, 'Lane runtime artifact');
  let sourceStat;
  try {
    sourceStat = await lstat(source);
  } catch (error) {
    if (isMissingPathError(error)) {
      throw new Error(
        `Generated runtime artifact ${relativePath} is missing for ${sourcePath}; `
        + 'run `npm run build:backend-runtime` (or `npm run build`) before isolated lanes',
      );
    }
    throw error;
  }
  if (!sourceStat.isFile()) {
    throw new Error(`Generated runtime artifact must be a regular file: ${relativePath}`);
  }
  await copyRegularFile(source, destination, sourceStat);
}

/**
 * Inherits only outputs owned by the canonical backend runtime build roots.
 * Each `.cts` source requires its adjacent `.cjs` and `.cjs.map`; explicit
 * singleton generated runtime files use a source trigger. Missing or
 * non-regular outputs fail closed instead of falling back to tsx resolution.
 */
export async function inheritGeneratedRuntimeArtifacts({ repoRoot, cloneRoot }) {
  for (const relativeRoot of GENERATED_RUNTIME_OUTPUT_ROOTS) {
    const sources = await collectRuntimeSources(repoRoot, relativeRoot);
    for (const sourcePath of sources.sort()) {
      const runtimePath = sourcePath.slice(0, -'.cts'.length) + '.cjs';
      await copyRequiredGeneratedArtifact(repoRoot, cloneRoot, runtimePath, sourcePath);
      await copyRequiredGeneratedArtifact(repoRoot, cloneRoot, `${runtimePath}.map`, sourcePath);
    }
  }

  for (const singleton of GENERATED_RUNTIME_SINGLETONS) {
    const trigger = resolveContainedPath(repoRoot, singleton.trigger, 'Generated runtime trigger');
    try {
      const triggerStat = await lstat(trigger);
      if (!triggerStat.isFile()) continue;
    } catch (error) {
      if (isMissingPathError(error)) continue;
      throw error;
    }
    for (const output of singleton.outputs) {
      await copyRequiredGeneratedArtifact(repoRoot, cloneRoot, output, singleton.trigger);
    }
  }
}

/**
 * Creates an independent per-lane execution copy of the repository.
 *
 * Uses `git clone --shared` to share the immutable object database, then
 * overlays the exact current tracked + non-ignored untracked manifest so
 * each lane sees the same WIP. Generated backend runtime artifacts are copied
 * from their canonical build roots. `node_modules` and `dist` are replaced
 * with symlinks to the source tree; they must already be built there.
 *
 * @param {{ repoRoot: string, laneRoot: string }} params
 * @returns {Promise<string>} the clone root path
 */
export async function prepareLaneExecutionCopy({
  repoRoot,
  laneRoot,
  spawnChild,
  ownedChildren,
}) {
  const cloneRoot = path.join(laneRoot, 'repo');

  // Clone with shared object storage — independent refs, index, working tree.
  await runOwnedCommand(spawnChild, ownedChildren, 'git', [
    'clone', '--shared', '--no-checkout', repoRoot, cloneRoot,
  ]);

  // Populate the index from HEAD so git status shows the correct diff after
  // the exact manifest is copied.
  await runOwnedCommand(spawnChild, ownedChildren, 'git', [
    '-C', cloneRoot, 'reset', '--mixed', 'HEAD',
  ]);

  // Overlay the exact current tracked + non-ignored untracked manifest.
  const { stdout: manifest } = await runOwnedCommand(
    spawnChild, ownedChildren, 'git',
    ['-C', repoRoot, 'ls-files', '-co', '--exclude-standard', '-z'],
  );

  await copyGitFileManifest({ repoRoot, cloneRoot, manifest });
  await inheritGeneratedRuntimeArtifacts({ repoRoot, cloneRoot });

  // Replace shared directories with symlinks to the (already-built) source.
  for (const name of ['node_modules', 'dist']) {
    const target = path.join(cloneRoot, name);
    await rm(target, { recursive: true, force: true });
    await symlink(path.join(repoRoot, name), target);
  }

  return cloneRoot;
}

export async function isXvfbDisplayAvailable(display, exists = pathExists) {
  const socketPath = `/tmp/.X11-unix/X${display}`;
  const lockPath = `/tmp/.X${display}-lock`;
  return !(await exists(socketPath)) && !(await exists(lockPath));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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
  const child = spawnChild(command, args, {
    ...options,
    detached: process.platform !== 'win32',
  });
  const record = {
    child,
    pid: child.pid,
    result: childResult(child),
  };
  ownedChildren.add(record);
  record.result.finally(() => ownedChildren.delete(record));
  return record;
}

/**
 * Runs a command through spawnOwned, immediately collecting stdout and
 * stderr as Buffers, then awaits exit.  Throws with command, exit code,
 * signal, and stderr on failure. All lane-preparation subprocesses (clone,
 * reset, and ls-files) enter the same ownedChildren set.
 */
async function runOwnedCommand(spawnChild, ownedChildren, command, args, opts) {
  const { stdin, ...spawnOptions } = opts ?? {};
  const record = spawnOwned(spawnChild, ownedChildren, command, args, {
    ...spawnOptions,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const stdoutPromise = new Promise((resolve, reject) => {
    const chunks = [];
    record.child.stdout.on('data', chunk => chunks.push(chunk));
    record.child.stdout.on('error', reject);
    record.child.stdout.on('end', () => resolve(Buffer.concat(chunks)));
  });

  const stderrPromise = new Promise((resolve, reject) => {
    const chunks = [];
    record.child.stderr.on('data', chunk => chunks.push(chunk));
    record.child.stderr.on('error', reject);
    record.child.stderr.on('end', () => resolve(Buffer.concat(chunks)));
  });

  if (stdin !== undefined) {
    record.child.stdin.end(stdin);
  } else {
    record.child.stdin.end();
  }

  const label = `${command} ${args.join(' ')}`;

  // Await child exit, stdout, and stderr together so no promise is left
  // unawaited and no stream error is silently swallowed.
  const settled = await Promise.allSettled([
    record.result,
    stdoutPromise,
    stderrPromise,
  ]);

  const [exitSettled, stdoutSettled, stderrSettled] = settled;

  // Surface stream errors with actionable command + stream name.
  if (stdoutSettled.status === 'rejected') {
    throw new Error(
      `${label}: stdout stream error: ${stdoutSettled.reason?.message ?? stdoutSettled.reason}`,
    );
  }
  if (stderrSettled.status === 'rejected') {
    throw new Error(
      `${label}: stderr stream error: ${stderrSettled.reason?.message ?? stderrSettled.reason}`,
    );
  }

  const stdout = stdoutSettled.value;
  const stderr = stderrSettled.value;

  if (exitSettled.status === 'rejected') {
    throw new Error(
      `${label}: child process error: ${exitSettled.reason?.message ?? exitSettled.reason}`,
    );
  }

  const exitResult = exitSettled.value;

  if (exitResult.code !== 0) {
    const stderrText = stderr.toString('utf8').trim();
    const how = exitResult.error
      ? `error: ${exitResult.error.message ?? exitResult.error}`
      : exitResult.signal
        ? `signal ${exitResult.signal}`
        : `exit ${exitResult.code}`;
    throw new Error(
      `${label} failed with ${how}${stderrText ? `: ${stderrText}` : ''}`,
    );
  }

  return { code: exitResult.code, stdout, stderr };
}

function signalOwnedRecord(record, signal, killGroup = process.kill) {
  if (!record.pid) return;
  try {
    if (process.platform === 'win32') {
      record.child.kill(signal);
    } else {
      killGroup(-record.pid, signal);
    }
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

export async function terminateOwnedProcessGroups(
  ownedChildren,
  {
    graceMs = DEFAULT_STOP_GRACE_MS,
    killGroup = process.kill,
    wait = sleep,
  } = {},
) {
  const snapshot = [...ownedChildren];
  for (const record of snapshot) signalOwnedRecord(record, 'SIGTERM', killGroup);
  if (snapshot.length > 0) await wait(graceMs);
  for (const record of snapshot) {
    if (ownedChildren.has(record)) signalOwnedRecord(record, 'SIGKILL', killGroup);
  }
}

async function waitForXvfbReady(record, display, exists = pathExists, wait = sleep) {
  const socketPath = `/tmp/.X11-unix/X${display}`;
  const deadline = Date.now() + XVFB_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await exists(socketPath)) return;
    if (record.child.exitCode !== null || record.child.signalCode !== null) {
      const result = await record.result;
      throw new Error(`Xvfb ${display} exited before becoming ready (exit ${result.code})`);
    }
    await wait(25);
  }
  throw new Error(`Xvfb ${display} did not create ${socketPath} within ${XVFB_READY_TIMEOUT_MS}ms`);
}

async function executeBuild({ spawnChild, ownedChildren }) {
  const record = spawnOwned(
    spawnChild,
    ownedChildren,
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['run', 'build'],
    { cwd: REPO_ROOT, env: process.env, stdio: 'inherit' },
  );
  const result = await record.result;
  if (result.code !== 0) throw new Error(`Playwright prerequisite build failed with exit code ${result.code}`);
}

async function executeLane({
  lane,
  options,
  spawnChild,
  ownedChildren,
  xvfbSocketExists,
  wait,
  killGroup,
}) {
  const env = { ...process.env, ...lane.env };
  let xvfb;
  try {
    if (options.headedXvfb && !options.list) {
      const display = Number(lane.env.DISPLAY.slice(1));
      xvfb = spawnOwned(
        spawnChild,
        ownedChildren,
        'Xvfb',
        [lane.env.DISPLAY, '-screen', '0', '1920x1080x24', '-nolisten', 'tcp'],
        { cwd: lane.cloneRoot, env, stdio: 'inherit' },
      );
      await waitForXvfbReady(xvfb, display, xvfbSocketExists, wait);
    }

    const runner = spawnOwned(
      spawnChild,
      ownedChildren,
      lane.command,
      lane.args,
      { cwd: lane.cloneRoot, env, stdio: 'inherit' },
    );
    if (!xvfb) return (await runner.result).code;

    const first = await Promise.race([
      runner.result.then(result => ({ owner: 'runner', result })),
      xvfb.result.then(result => ({ owner: 'xvfb', result })),
    ]);
    if (first.owner === 'xvfb') {
      signalOwnedRecord(runner, 'SIGTERM', killGroup);
      await wait(100);
      if (ownedChildren.has(runner)) signalOwnedRecord(runner, 'SIGKILL', killGroup);
      await runner.result;
      process.stderr.write(
        `Lane ${lane.laneIndex} failed because Xvfb ${lane.env.DISPLAY} exited early (exit ${first.result.code})\n`,
      );
      return 1;
    }
    signalOwnedRecord(xvfb, 'SIGTERM', killGroup);
    return first.result.code;
  } catch (error) {
    if (xvfb) signalOwnedRecord(xvfb, 'SIGTERM', killGroup);
    process.stderr.write(`Lane ${lane.laneIndex} failed: ${error instanceof Error ? error.message : error}\n`);
    return 1;
  }
}

function planLanes(options, root, basePort, baseDisplay) {
  const laneIndexes = options.laneIndex === undefined
    ? Array.from({ length: options.lanes }, (_, offset) => offset + 1)
    : [options.laneIndex];
  return laneIndexes.map(laneIndex => {
    const offset = laneIndex - 1;
    const resources = createLaneResources({
      root,
      laneIndex,
      basePort,
      display: options.headedXvfb ? baseDisplay + offset : undefined,
    });
    const cloneRoot = path.join(resources.laneRoot, 'repo');
    const command = createLaneCommand({ ...options, laneIndex, cloneRoot });
    return { laneIndex, ...resources, ...command, cloneRoot: path.join(resources.laneRoot, 'repo') };
  });
}

export async function run(argv = process.argv.slice(2), dependencies = {}) {
  const savedExitCode = process.exitCode;
  const options = parseArgs(argv, dependencies.platform ?? process.platform);
  const spawnChild = dependencies.spawn ?? spawn;
  const makeTempRoot = dependencies.mkdtemp ?? mkdtemp;
  const removeTree = dependencies.rm ?? rm;
  const makeDirectory = dependencies.mkdir ?? mkdir;
  const exists = dependencies.commandExists ?? commandExists;
  const portAvailable = dependencies.isTcpPortAvailable ?? isTcpPortAvailable;
  const displayAvailable = dependencies.isXvfbDisplayAvailable ?? isXvfbDisplayAvailable;
  const xvfbSocketExists = dependencies.pathExists ?? pathExists;
  const wait = dependencies.wait ?? sleep;
  const killGroup = dependencies.killGroup ?? process.kill;
  const runBuild = dependencies.executeBuild ?? executeBuild;
  const runLane = dependencies.executeLane ?? executeLane;
  const prepareLaneCopy = dependencies.prepareLaneExecutionCopy ?? prepareLaneExecutionCopy;
  const writeStdout = dependencies.writeStdout ?? (text => process.stdout.write(text));
  const writeStderr = dependencies.writeStderr ?? (text => process.stderr.write(text));
  const environment = dependencies.env ?? process.env;
  const signalSource = dependencies.signalSource ?? process;
  const basePort = parsePositiveInteger(
    environment.FARMING_PLAYWRIGHT_PORT_BASE ?? '43100',
    'FARMING_PLAYWRIGHT_PORT_BASE',
  );
  const baseDisplay = parsePositiveInteger(
    environment.FARMING_PLAYWRIGHT_XVFB_DISPLAY_BASE ?? '90',
    'FARMING_PLAYWRIGHT_XVFB_DISPLAY_BASE',
  );

  validateResourceRanges({
    basePort,
    baseDisplay,
    lanes: options.lanes,
    headedXvfb: options.headedXvfb,
  });

  const dryRoot = path.join(tmpdir(), 'farming-playwright-lanes-DRY-RUN');
  if (options.dryRun) {
    const lanes = planLanes(options, dryRoot, basePort, baseDisplay);
    writeStdout(`${JSON.stringify({ tempRoot: null, lanes }, null, 2)}\n`);
    return 0;
  }

  if (!options.list) {
    const laneOffsets = options.laneIndex === undefined
      ? Array.from({ length: options.lanes }, (_, offset) => offset)
      : [options.laneIndex - 1];
    for (const offset of laneOffsets) {
      const port = basePort + offset;
      if (!(await portAvailable(port))) {
        throw new Error(`Playwright lane port ${port} is already in use; refusing to reuse it`);
      }
    }
    if (options.headedXvfb) {
      if (!(await exists('Xvfb'))) {
        throw new Error('Xvfb is required for --headed-xvfb; refusing to run headless');
      }
      for (const offset of laneOffsets) {
        const display = baseDisplay + offset;
        if (!(await displayAvailable(display))) {
          throw new Error(`Xvfb display :${display} is already in use; refusing to reuse it`);
        }
      }
    }
  }

  const ownedChildren = new Set();
  let interrupted = false;
  let terminationPromise;
  const requestTermination = signal => {
    interrupted = true;
    process.exitCode = 1;
    writeStderr(`Received ${signal}; stopping owned Playwright lane process groups\n`);
    terminationPromise ??= terminateOwnedProcessGroups(ownedChildren, { killGroup, wait });
  };
  const signalHandlers = new Map();
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    const handler = () => requestTermination(signal);
    signalHandlers.set(signal, handler);
    signalSource.once(signal, handler);
  }

  let tempRoot;
  let succeeded = false;
  try {
    if (!options.skipBuild && !options.list) {
      await runBuild({ spawnChild, ownedChildren });
      if (interrupted) return 1;
    }

    tempRoot = await makeTempRoot(path.join(tmpdir(), 'farming-playwright-lanes-'));
    const lanes = planLanes(options, tempRoot, basePort, baseDisplay);
    const dirResults = await Promise.allSettled(
      lanes.flatMap(lane =>
        [...new Set(Object.values(LANE_DIRECTORY_ENV))]
          .map(relativePath => makeDirectory(path.join(lane.laneRoot, relativePath), { recursive: true })),
      ),
    );
    if (interrupted) return 1;
    const dirFailure = dirResults.find(r => r.status === 'rejected');
    if (dirFailure) throw dirFailure.reason;

    const prepResults = await Promise.allSettled(
      lanes.map(lane => prepareLaneCopy({ repoRoot: REPO_ROOT, laneRoot: lane.laneRoot, spawnChild, ownedChildren })),
    );
    if (interrupted) return 1;
    const prepFailure = prepResults.find(r => r.status === 'rejected');
    if (prepFailure) throw prepFailure.reason;

    const results = await Promise.all(
      lanes.map(lane => runLane({
        lane,
        options,
        spawnChild,
        ownedChildren,
        xvfbSocketExists,
        wait,
        killGroup,
      })),
    );
    succeeded = !interrupted && results.every(code => code === 0);
    if (!succeeded || options.retainEvidence) {
      writeStderr(`Playwright lane evidence retained at ${tempRoot}\n`);
    }
    if (!succeeded) {
      for (const [index, code] of results.entries()) {
        if (code !== 0) writeStderr(`Failed lane ${lanes[index].laneIndex}: ${lanes[index].laneRoot}\n`);
      }
    }
    return succeeded ? 0 : 1;
  } catch (error) {
    if (!interrupted) throw error;
    writeStderr(`Preparation failed after signal: ${error instanceof Error ? error.message : error}\n`);
    return 1;
  } finally {
    await (terminationPromise ?? terminateOwnedProcessGroups(ownedChildren, { killGroup, wait }));
    for (const [signal, handler] of signalHandlers) signalSource.removeListener(signal, handler);
    if (tempRoot && succeeded && !options.retainEvidence) {
      await removeTree(tempRoot, { recursive: true, force: true });
    }
    process.exitCode = savedExitCode;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run()
    .then(exitCode => {
      process.exitCode = exitCode;
    })
    .catch(error => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
