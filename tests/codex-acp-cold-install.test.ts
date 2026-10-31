import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const upstreamSha = '15de6b2dd5203876a48b12861378bcf87040d623ab2159e05052dc9d54c32b16';
const patchedSha = '73d73ef90f16d726c3f5639846389ed6fb24301a8d130f1312c4f55e9d2dcdb7';
const hash = (file: string): string => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

test('a cold Codex ACP installation applies the reviewed patch through the product installer', () => {
  const root = path.resolve(__dirname, '..');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-cold-acp-'));
  const entry = path.join(tmp, 'node_modules/@agentclientprotocol/codex-acp/dist/index.js');
  const patchFile = '@agentclientprotocol+codex-acp+2.5.0.patch';
  const invoke = (program: string, args: string[]): void => {
    const result = spawnSync(program, args, { cwd: tmp, encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, `${result.error?.message || ''}\n${result.stdout}\n${result.stderr}`);
  };
  try {
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'patches'));
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'cold-acp-fixture', version: '1.0.0' }));
    const packageRoot = path.dirname(require.resolve('@agentclientprotocol/codex-acp/package.json'));
    fs.copyFileSync(path.join(packageRoot, 'package.json'), path.join(path.dirname(path.dirname(entry)), 'package.json'));
    fs.copyFileSync(path.join(packageRoot, 'dist/index.js'), entry);
    fs.copyFileSync(path.join(root, 'patches', patchFile), path.join(tmp, 'patches', patchFile));
    if (hash(entry) === patchedSha) invoke('git', ['apply', '--reverse', path.join('patches', patchFile)]);
    assert.equal(hash(entry), upstreamSha, 'fixture must contain the reviewed unmodified upstream bytes before the product installer runs');
    invoke(process.execPath, [path.join(root, 'node_modules/patch-package/index.js'), '--error-on-fail']);
    assert.equal(hash(entry), patchedSha, 'a fresh installation must reproduce the reviewed Farming vendor digest');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
