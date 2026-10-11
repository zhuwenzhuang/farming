import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { buildShellEnvCommand, parseShellEnvOutput, resolveUserShellEnvSync } from '../agent-env.cjs';

for (const platform of ['linux', 'darwin']) {
  test(`Shell environment collection uses the selected Node runtime on ${platform}`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "farming-shell-runtime-'"));
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    try {
      const loader = path.join(root, 'private loader');
      const trace = path.join(root, 'loader-args');
      const shell = path.join(root, 'probe-shell');
      fs.writeFileSync(loader, '#!/bin/sh\nprintf "%s\\n" "$@" > "$FARMING_TEST_LOADER_TRACE"\nshift 2\nexec "$@"\n', { mode: 0o755 });
      fs.writeFileSync(shell, '#!/bin/sh\nshift\nexec /bin/bash --noprofile --norc -c "$1"\n', { mode: 0o755 });
      const env: NodeJS.ProcessEnv = { ...process.env, FARMING_NODE_BIN: process.execPath, FARMING_NODE_LD: loader,
        FARMING_NODE_LIBRARY_PATH: path.join(root, 'private libraries'), FARMING_TEST_LOADER_TRACE: trace,
        FARMING_AGENT_SHELL_ENV: '1', FARMING_SHELL_PROBE: 'collected', HOME: root };
      Object.defineProperty(process, 'platform', { ...originalPlatform, value: platform });
      const result = resolveUserShellEnvSync({ processEnv: env, shell, cwd: root, timeoutMs: 5000 });
      assert.equal(result?.FARMING_SHELL_PROBE, 'collected');
      assert.equal(result?.PATH, env.PATH, 'collecting the environment must not rewrite the user PATH');
      assert.equal(result?.LD_LIBRARY_PATH, env.LD_LIBRARY_PATH, 'private libraries must not become global shell libraries');
      const expectedTrace = ['--library-path', env.FARMING_NODE_LIBRARY_PATH, process.execPath, '-e', 'process.stdout.write(JSON.stringify(process.env))'];
      if (platform === 'linux') assert.deepEqual(fs.readFileSync(trace, 'utf8').trim().split('\n'), expectedTrace);
      else assert(!fs.existsSync(trace));
      const direct = execFileSync('/bin/bash', ['--noprofile', '--norc', '-c', buildShellEnvCommand(process.execPath, env)], { env, encoding: 'utf8', timeout: 5000 });
      assert.equal(parseShellEnvOutput(direct)?.FARMING_SHELL_PROBE, 'collected');
      const explicit = resolveUserShellEnvSync({ processEnv: { ...env, FARMING_NODE_BIN: '/missing/default-node' }, nodePath: process.execPath, shell, cwd: root });
      assert.equal(explicit?.FARMING_SHELL_PROBE, 'collected', 'explicit Node selection overrides the default');
    } finally {
      Object.defineProperty(process, 'platform', originalPlatform);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
