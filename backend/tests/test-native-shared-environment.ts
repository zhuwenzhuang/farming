import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NativeSessionEngine } from '../native-session-engine.cjs';

async function run() {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-native-shared-env-'));
  const engine = new NativeSessionEngine({ configDir });
  let output = '';
  engine.on('session-output', payload => {
    output += String((payload as { data?: unknown }).data || '');
  });
  try {
    await engine.createSession({
      agentId: 'native-shared-env',
      command: '/bin/bash',
      args: ['-l'],
      cwd: configDir,
      env: { ...process.env, SHARED_NATIVE_SENTINEL: 'native-ready' },
      category: 'other',
    });
    await new Promise(resolve => setTimeout(resolve, 1_000));
    await engine.sendInput(
      'native-shared-env',
      "printf '__NATIVE_SHARED__%s__END__\\n' \"$SHARED_NATIVE_SENTINEL\"\r",
    );
    const deadline = Date.now() + 5_000;
    while (!output.includes('__NATIVE_SHARED__native-ready__END__') && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.match(output, /__NATIVE_SHARED__native-ready__END__/);
  } finally {
    await engine.killSession('native-shared-env').catch(() => {});
    engine.dispose();
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

run().then(() => {
  console.log('native shared environment tests passed');
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
