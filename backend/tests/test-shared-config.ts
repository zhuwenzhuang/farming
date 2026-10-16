import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SharedConfigService, parseDotenv } from '../../extensions/shared-config/backend/shared-config-service.cjs';
import { renderFarmingAgentBootstrap, renderFarmingAgentSystemPrompt } from '../farming-agent-bootstrap.cjs';

function write(file: string, content: string, mode = 0o600) {
  fs.writeFileSync(file, content, { encoding: 'utf8', mode });
  fs.chmodSync(file, mode);
}

async function run() {
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-shared-config-test-'));
try {
  const configDir = path.join(temp, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  const service = new SharedConfigService({ configDir });

  assert.deepEqual((await service.getState()), {
    revision: 0,
    enabled: false,
    instructions: '',
    environment: null,
    environmentSummary: { names: [], setCount: 0, unsetCount: 0, ignoredNames: [] },
    updatedAt: 0,
    status: 'disabled',
    detail: '',
  });

  assert.deepEqual(parseDotenv([
    '# comment',
    'PLAIN=value # comment',
    'export QUOTED="line\\nvalue"',
    "LITERAL='${UNCHANGED}'",
    'EMPTY=',
  ].join('\n')), {
    set: { PLAIN: 'value', QUOTED: 'line\nvalue', LITERAL: '${UNCHANGED}', EMPTY: '' },
    unset: [],
  });
  assert.throws(() => parseDotenv('FARMING_TOKEN_FILE=unsafe'), /Farming-owned/);
  assert.throws(() => parseDotenv('NODE_OPTIONS=--require=x'), /Farming-owned/);
  assert.throws(() => parseDotenv('BAD-NAME=value'), /Invalid environment variable/);
  assert.throws(
    () => parseDotenv(Array.from({ length: 1025 }, (_, index) => `KEY_${index}=value`).join('\n')),
    /exceeds 1024 variables/,
  );

  const dotenvFile = path.join(temp, 'agent.env');
  write(dotenvFile, 'SHARED_ALPHA=one\nSHARED_EMPTY=\n');
  const saved = await service.save({
    expectedRevision: 0,
    enabled: true,
    instructions: 'Always report the final verification command.',
    environment: { format: 'dotenv', path: dotenvFile },
  }, { PATH: '/usr/bin', HOME: temp });
  assert.equal(saved.revision, 1);
  assert.equal(saved.status, 'ready');
  assert.deepEqual(saved.environmentSummary, {
    names: ['SHARED_ALPHA', 'SHARED_EMPTY'],
    setCount: 2,
    unsetCount: 0,
    ignoredNames: [],
  });
  assert.equal(fs.statSync(path.join(configDir, 'shared-agent-config.json')).mode & 0o777, 0o600);
  const storedText = fs.readFileSync(path.join(configDir, 'shared-agent-config.json'), 'utf8');
  assert.doesNotMatch(storedText, /\bone\b/);

  const launch = service.captureLaunchConfig();
  assert.equal(launch.instructions, 'Always report the final verification command.');
  assert.deepEqual(await service.applyEnvironment({ PATH: '/usr/bin', KEEP: 'yes' }, launch), {
    PATH: '/usr/bin', KEEP: 'yes', SHARED_ALPHA: 'one', SHARED_EMPTY: '',
  });
  await assert.rejects(() => service.save({ expectedRevision: 0, enabled: false }), /changed/);

  write(dotenvFile, 'SHARED_ALPHA=two\n');
  assert.equal((await service.getState()).status, 'ready');
  assert.equal((await service.applyEnvironment({}, launch)).SHARED_ALPHA, 'one');
  assert.equal((await service.applyEnvironment({}, service.captureLaunchConfig())).SHARED_ALPHA, 'two');
  fs.rmSync(dotenvFile);
  assert.equal((await service.getState()).status, 'invalid');
  await assert.rejects(() => service.applyEnvironment({}, service.captureLaunchConfig()), /not found/);
  write(dotenvFile, 'SHARED_ALPHA=recovered\n');
  assert.equal((await service.getState()).status, 'ready');
  assert.equal((await service.applyEnvironment({}, service.captureLaunchConfig())).SHARED_ALPHA, 'recovered');

  const disabled = await service.save({
    expectedRevision: 1,
    enabled: false,
    instructions: 'draft',
    environment: { format: 'dotenv', path: path.join(temp, 'missing.env') },
  });
  assert.equal(disabled.status, 'disabled');
  assert.equal(service.captureLaunchConfig().instructions, '');

  const shellFile = path.join(temp, 'agent.sh');
  write(shellFile, [
    'echo should-not-leak',
    'export SHARED_SHELL=set',
    'export CHANGED=after',
    'unset REMOVE_ME',
    'alias ignored_alias=true',
    'ignored_function() { :; }',
  ].join('\n'));
  const shellSaved = await service.save({
    expectedRevision: 2,
    enabled: true,
    instructions: '',
    environment: { format: 'shell', path: shellFile },
  }, {
    PATH: process.env.PATH,
    SHELL: '/bin/bash',
    SHLVL: '27',
    CHANGED: 'before',
    REMOVE_ME: 'yes',
  });
  assert.equal(shellSaved.status, 'ready');
  assert.deepEqual(shellSaved.environmentSummary, {
    names: ['CHANGED', 'REMOVE_ME', 'SHARED_SHELL'],
    setCount: 2,
    unsetCount: 1,
    ignoredNames: [],
  });
  const shellEnv = await service.applyEnvironment(
    {
      PATH: process.env.PATH,
      SHELL: '/bin/bash',
      SHLVL: '27',
      CHANGED: 'before',
      REMOVE_ME: 'yes',
    },
    service.captureLaunchConfig(),
  );
  assert.equal(shellEnv.SHARED_SHELL, 'set');
  assert.equal(shellEnv.CHANGED, 'after');
  assert.equal(shellEnv.REMOVE_ME, undefined);
  assert.equal(shellEnv.ignored_alias, undefined);
  assert.equal(shellEnv.SHLVL, '27');

  write(shellFile, 'export FARMING_AGENT_ID=spoofed\nexport SHARED_ALLOWED=yes\n');
  const protectedShell = await service.save({
    expectedRevision: 3,
    enabled: true,
    instructions: '',
    environment: { format: 'shell', path: shellFile },
  }, { PATH: process.env.PATH, SHELL: '/bin/bash' });
  assert.deepEqual(protectedShell.environmentSummary, {
    names: ['SHARED_ALLOWED'],
    setCount: 1,
    unsetCount: 0,
    ignoredNames: ['FARMING_AGENT_ID'],
  });
  const protectedApplied = await service.applyEnvironment(
    { PATH: process.env.PATH, SHELL: '/bin/bash', FARMING_AGENT_ID: 'authoritative' },
    service.captureLaunchConfig(),
  );
  assert.equal(protectedApplied.FARMING_AGENT_ID, 'authoritative');
  assert.equal(protectedApplied.SHARED_ALLOWED, 'yes');
  write(shellFile, 'exit 7\n');
  await assert.rejects(() => service.save({
    expectedRevision: 4,
    enabled: true,
    instructions: '',
    environment: { format: 'shell', path: shellFile },
  }, { PATH: process.env.PATH, SHELL: '/bin/bash' }), /returned an error/);
  write(shellFile, 'export GROUP_WRITABLE=accepted\n', 0o666);
  const groupWritable = await service.save({
    expectedRevision: 4,
    enabled: true,
    instructions: '',
    environment: { format: 'shell', path: shellFile },
  }, { PATH: process.env.PATH, SHELL: '/bin/bash' });
  assert.equal(groupWritable.status, 'ready');
  assert.equal(
    (await service.applyEnvironment(
      { PATH: process.env.PATH, SHELL: '/bin/bash' },
      service.captureLaunchConfig(),
    )).GROUP_WRITABLE,
    'accepted',
  );
  write(shellFile, 'sleep 30\n');
  await assert.rejects(() => service.save({
    expectedRevision: 5,
    enabled: true,
    instructions: '',
    environment: { format: 'shell', path: shellFile },
  }, { PATH: process.env.PATH, SHELL: '/bin/bash' }), /timed out/);

  const basePrompt = renderFarmingAgentBootstrap();
  assert.equal(renderFarmingAgentSystemPrompt(''), basePrompt);
  const composedPrompt = renderFarmingAgentSystemPrompt('Use the shared sentinel.');
  assert.match(composedPrompt, /Use the shared sentinel/);
  assert.ok(composedPrompt.startsWith(basePrompt));
  assert.match(composedPrompt, /remain authoritative/);

  await assert.rejects(() => service.save({
    expectedRevision: 5,
    enabled: true,
    instructions: '',
    environment: { format: 'dotenv', path: '' },
  }), /Add system instructions/);
  await assert.rejects(() => service.save({
    expectedRevision: 5,
    enabled: true,
    instructions: '',
    environment: { format: 'script', path: shellFile },
  }), /format must be dotenv or shell/);

  const oversizedFile = path.join(temp, 'oversized.env');
  write(oversizedFile, `OVERSIZED=${'x'.repeat(256 * 1024)}\n`);
  await assert.rejects(() => service.save({
    expectedRevision: 5,
    enabled: true,
    instructions: '',
    environment: { format: 'dotenv', path: oversizedFile },
  }), /larger than 256 KiB/);

  const concurrent = new SharedConfigService({ configDir: path.join(temp, 'concurrent') });
  const countFile = path.join(temp, 'source-count');
  const slowShell = path.join(temp, 'slow-shell.sh');
  write(slowShell, 'sleep 0.15\nprintf x >> "$SHARED_COUNT_FILE"\nexport SHARED_ASYNC=ready\n');
  const shellBase = { PATH: process.env.PATH, SHELL: '/bin/bash', SHARED_COUNT_FILE: countFile };
  let eventLoopProgress = false;
  const progressTimer = setTimeout(() => { eventLoopProgress = true; }, 10);
  try {
    await concurrent.save({ expectedRevision: 0, enabled: true, environment: { format: 'shell', path: slowShell } }, shellBase);
    assert.equal(eventLoopProgress, true, 'shell evaluation must leave the Server event loop available');
  } finally { clearTimeout(progressTimer); }
  assert.equal(fs.readFileSync(countFile, 'utf8'), 'x', 'saving evaluates the shell once, without a second status evaluation');
  const concurrentLaunch = concurrent.captureLaunchConfig();
  const [left, right] = await Promise.all([
    concurrent.applyEnvironment(shellBase, concurrentLaunch), concurrent.applyEnvironment(shellBase, concurrentLaunch),
  ]);
  assert.equal(left.SHARED_ASYNC, 'ready');
  assert.deepEqual(left, right);
  assert.equal(fs.readFileSync(countFile, 'utf8'), 'xx', 'one launch snapshot shares its in-flight environment evaluation');
  const losingSave = concurrent.save({ expectedRevision: 1, enabled: true, environment: { format: 'shell', path: slowShell } }, shellBase);
  await concurrent.save({ expectedRevision: 1, enabled: false });
  await assert.rejects(losingSave, { code: 'SHARED_CONFIG_REVISION_CONFLICT' });
  assert.equal((await concurrent.getState()).revision, 2);

  fs.writeFileSync(path.join(configDir, 'shared-agent-config.json'), '{bad json', 'utf8');
  await assert.rejects(() => service.getState(), /store is invalid/);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

console.log('shared configuration tests passed');

}
void run().catch(error => { console.error(error); process.exitCode = 1; });
