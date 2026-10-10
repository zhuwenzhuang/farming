import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ComputerResourceManager } from '../../extensions/computer/backend/computer-resource-manager.cjs';
import { IsolatedBrowserProvider } from '../../extensions/computer/backend/isolated-browser-provider.cjs';

test('optional browser discovery is quiet for absent candidates and still finds installed browsers', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-browser-probe-'));
  try {
    const browser = path.join(directory, 'browser');
    fs.writeFileSync(browser, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    fs.writeFileSync(path.join(directory, 'which'), `#!/bin/sh
if [ "$1" = google-chrome ] && [ -n "$TEST_BROWSER" ]; then printf '%s\\n' "$TEST_BROWSER"; exit 0; fi
printf 'which: no %s in (%s)\\n' "$1" "$PATH" >&2
exit 1
`, { mode: 0o700 });
    for (const installed of [false, true]) {
      const probe = spawnSync(process.execPath, ['-e', `
const { discoverBrowserExecutable, discoverBrowserExecutables } = require(${JSON.stringify(path.resolve('extensions/browser/backend/executable-discovery.cjs'))});
console.log(JSON.stringify({ selected: discoverBrowserExecutable({ platform: 'linux', source: 'system' }), all: discoverBrowserExecutables({ platform: 'linux' }) }));
`], { env: { ...process.env, PATH: directory, TEST_BROWSER: installed ? browser : '' }, encoding: 'utf8' });
      assert.equal(probe.status, 0, probe.stderr);
      assert.equal(probe.stderr, '', 'missing candidates must never leak PATH diagnostics');
      const result = JSON.parse(probe.stdout);
      assert.equal(result.selected?.path ?? null, installed ? browser : null);
      assert.equal(result.all.length, installed ? 1 : 0);
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

for (const [zone, expected] of [['Asia/Shanghai', 'zh'], ['Asia/Hong_Kong', 'zh'], ['Asia/Taipei', 'zh'], ['UTC', 'en'], ['America/Los_Angeles', 'en']]) {
  test(`fresh Config language follows ${zone} and preserves an explicit choice`, () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-config-language-'));
    try {
      const probe = spawnSync(process.execPath, ['-e', `
const assert = require('node:assert/strict');
const { ConfigManager } = require(${JSON.stringify(path.resolve('backend/config-manager.cjs'))});
const manager = new ConfigManager({ configDir: ${JSON.stringify(directory)} });
manager.init();
assert.equal(manager.getSettings().language, ${JSON.stringify(expected)});
manager.updateSettings({ language: ${JSON.stringify(expected === 'en' ? 'zh' : 'en')} });
process.env.TZ = 'Asia/Shanghai';
const restarted = new ConfigManager({ configDir: ${JSON.stringify(directory)} });
restarted.init();
assert.equal(restarted.getSettings().language, ${JSON.stringify(expected === 'en' ? 'zh' : 'en')});
`], { env: { ...process.env, TZ: zone, HOME: directory }, encoding: 'utf8' });
      assert.equal(probe.status, 0, probe.stderr);
      assert(!probe.stdout.includes('Loaded settings:'), probe.stdout);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
}

test('Docker image absence is installable state; permissions, timeout and unknown failures stay explicit', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-image-probe-'));
  let failure: 'missing' | 'permission' | 'timeout' | 'unknown' | 'ready' = 'missing';
  const manager = new ComputerResourceManager({
    configDir: directory,
    dockerRunner: async args => {
      if (args[0] === 'image' && failure !== 'ready') {
        const stderr = failure === 'missing' ? `Error response from daemon: No such image: ${args[2]}`
          : failure === 'permission' ? 'permission denied while connecting to Docker' : 'unexpected transport failure';
        throw Object.assign(new Error(`Command failed: docker image inspect ${args[2]}\n${stderr}`), {
          stderr, killed: failure === 'timeout',
        });
      }
      return { stdout: 'fixture', stderr: '' };
    },
  });
  const browser = new IsolatedBrowserProvider({
    configDir: directory, computerResourceManager: manager,
    chromiumInstaller: { browserOption: () => null, install: async () => {}, status: () => ({ state: 'ready' }) },
  });
  try {
    for (const state of ['missing', 'permission', 'timeout', 'unknown', 'ready'] as const) {
      failure = state;
      const result = await browser.capability();
      assert.equal(result.dockerAvailable, true);
      assert.equal(result.imageReady, state === 'ready');
      assert.equal(result.available, state === 'ready');
      assert.equal(Boolean(result.error), !['missing', 'ready'].includes(state));
      assert(!String(result.error).includes('sha256:'), String(result.error));
      assert(!String(result.error).includes('Command failed:'), String(result.error));
      if (state === 'permission') assert.match(String(result.error), /permissions/);
      if (state === 'timeout') assert.match(String(result.error), /time/);
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
