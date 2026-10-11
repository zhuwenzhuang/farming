import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
const { WorkspaceFileService } = require('../workspace-file-service.cjs');

for (const platform of ['linux', 'darwin']) {
  test(`Workspace helper inherits the private runtime invocation on ${platform}`, { timeout: 10000 }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-workspace-runtime-'));
    const loader = path.join(root, 'private loader');
    const trace = path.join(root, 'loader-args');
    fs.writeFileSync(loader, '#!/bin/sh\nprintf "%s\\n" "$@" > "$FARMING_TEST_LOADER_TRACE"\nshift 2\nexec "$@"\n', { mode: 0o755 });
    const previousPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const keys = ['FARMING_NODE_LD', 'FARMING_NODE_LIBRARY_PATH', 'FARMING_NODE_BIN', 'FARMING_TEST_LOADER_TRACE'] as const;
    const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    let service;
    try {
      process.env.FARMING_NODE_LD = loader;
      process.env.FARMING_NODE_LIBRARY_PATH = path.join(root, 'private libraries');
      process.env.FARMING_NODE_BIN = process.execPath;
      process.env.FARMING_TEST_LOADER_TRACE = trace;
      Object.defineProperty(process, 'platform', { ...previousPlatform, value: platform });
      service = new WorkspaceFileService({ rgPath: process.execPath });
    } catch (error) {
      fs.rmSync(root, { recursive: true, force: true });
      throw error;
    } finally {
      Object.defineProperty(process, 'platform', previousPlatform);
      for (const key of keys) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
    }
    try {
      const runner = service.commandRunner;
      const helper = runner.child;
      assert(helper?.pid, 'the helper must actually start');
      const result = await runner.run(process.execPath, ['-e', 'process.stdout.write(String(process.ppid))'], { timeout: 5000 });
      assert.equal(result.stdout, String(helper.pid), 'the helper, not the in-process fallback, must execute the command');
      if (platform === 'linux') {
        assert.deepEqual(fs.readFileSync(trace, 'utf8').trim().split('\n'), [
          '--library-path', path.join(root, 'private libraries'), process.execPath,
          path.resolve(__dirname, '../command-runner-child.cjs'),
        ]);
      } else {
        assert(!fs.existsSync(trace), 'non-Linux must not use the compatibility loader');
      }
    } finally {
      const child = service.commandRunner.child;
      const exited = child && child.exitCode === null && child.signalCode === null ? once(child, 'exit') : Promise.resolve();
      await service.dispose();
      await exited;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
