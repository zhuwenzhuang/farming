import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { runNpmUpdate } from '../npm-update-helper.cjs';
import { packageInstallationId } from '../package-installation.cjs';

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

for (const scenario of ['success', 'rollback', 'missing-runtime']) {
  test(`managed Node follows the image during ${scenario}`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-managed-update-'));
    const previousManagedRoot = process.env.FARMING_MANAGED_NODE_ROOT;
    const calls = path.join(root, 'calls.jsonl');
    const activePackageRoot = path.join(root, 'bootstrap');
    const installationId = packageInstallationId(activePackageRoot);
    const installationRoot = path.join(root, 'installation');
    const stagingPrefix = path.join(installationRoot, 'staging', 'candidate');
    const template = path.join(root, 'candidate-template');
    const writePackage = (directory: string, version: string, fail: boolean) => {
      fs.mkdirSync(path.join(directory, 'bin'), { recursive: true });
      fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: 'farming-code', version }));
      fs.writeFileSync(path.join(directory, 'bin/farming-node'),
        `#!/bin/sh\nexport FARMING_FIXTURE_RUNTIME=${quote(version)}\nexec ${quote(process.execPath)} "$@"\n`, { mode: 0o755 });
      fs.writeFileSync(path.join(directory, 'bin/farming'), `
const assert = require('node:assert/strict');
const fs = require('node:fs');
assert.equal(process.env.FARMING_FIXTURE_RUNTIME, ${JSON.stringify(version)});
assert.equal(process.env.FARMING_PACKAGE_INSTALLATION_ID, undefined);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({command:process.argv[2],runtime:process.env.FARMING_FIXTURE_RUNTIME})+'\\n');
if (process.argv[2] === 'daemon' && ${fail}) process.exit(1);
`);
    };
    try {
      process.env.FARMING_MANAGED_NODE_ROOT = activePackageRoot;
      writePackage(activePackageRoot, '1.0.0', false);
      writePackage(template, '2.0.0', scenario === 'rollback');
      if (scenario === 'missing-runtime') fs.unlinkSync(path.join(template, 'bin/farming-node'));
      const fakeNpm = path.join(root, 'npm');
      fs.writeFileSync(fakeNpm, `#!${process.execPath}
const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path');
const args = process.argv.slice(2);
assert(args.includes('--ignore-scripts')); assert(args.includes('--include=optional'));
const prefix = args[args.indexOf('--prefix')+1];
fs.cpSync(${JSON.stringify(template)},path.join(prefix,'lib/node_modules/farming-code'),{recursive:true});
`, { mode: 0o755 });
      const payload = {
        action: 'prepare' as const,
        operationId: '00000000-0000-4000-8000-000000000010',
        packageName: 'farming-code', targetVersion: '2.0.0', previousVersion: '1.0.0',
        targetIntegrity: 'sha512-test-target',
        stateFile: path.join(root, 'state.json'), logPath: path.join(root, 'update.log'),
        activePackageRoot, installationId, installationRoot, bootstrapPackageRoot: activePackageRoot,
        configDir: root, stagingPrefix, stagingPackageRoot: path.join(stagingPrefix, 'lib/node_modules/farming-code'),
        nodePath: '/missing/system/node', npmCommand: fakeNpm, serverPid: 0, port: 6694, basePath: '/farming',
      };
      fs.writeFileSync(payload.stateFile, JSON.stringify({
        format: 'farming-update-operation-v1', operationId: payload.operationId, method: 'npm', phase: 'installing',
        version: '2.0.0', previousVersion: '1.0.0', startedAt: new Date().toISOString(),
      }));
      await runNpmUpdate(payload);
      const prepared = JSON.parse(fs.readFileSync(payload.stateFile, 'utf8'));
      if (scenario === 'missing-runtime') {
        assert.equal(prepared.phase, 'failed');
        assert(!fs.existsSync(calls), 'missing Node must fail before invoking system Node or restarting');
        return;
      }
      assert.equal(prepared.phase, 'ready-to-restart', fs.readFileSync(payload.logPath, 'utf8'));
      await runNpmUpdate({ ...payload, ...prepared, action: 'apply', stateFile: payload.stateFile,
        targetVersion: '2.0.0', nodePath: payload.nodePath, npmCommand: fakeNpm,
        stagingPrefix: undefined, stagingPackageRoot: undefined });
      const state = JSON.parse(fs.readFileSync(payload.stateFile, 'utf8'));
      assert.equal(state.phase, scenario === 'success' ? 'succeeded' : 'rolled-back', fs.readFileSync(payload.logPath, 'utf8'));
      const observed = fs.readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      assert.deepEqual(observed, [
        { command: 'runtime', runtime: '2.0.0' },
        { command: 'daemon', runtime: '2.0.0' },
        ...(scenario === 'rollback' ? [{ command: 'daemon', runtime: '1.0.0' }] : []),
      ]);
    } finally {
      if (previousManagedRoot === undefined) delete process.env.FARMING_MANAGED_NODE_ROOT;
      else process.env.FARMING_MANAGED_NODE_ROOT = previousManagedRoot;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
