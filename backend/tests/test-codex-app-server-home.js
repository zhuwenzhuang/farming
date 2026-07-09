const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ensureCodexAppServerHome } = require('../codex-app-server-home');

async function run() {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'farming-codex-app-server-home-'));
  const sourceHome = path.join(root, 'source-home');
  const configDir = path.join(root, 'farming');
  try {
    await fs.promises.mkdir(path.join(sourceHome, 'skills'), { recursive: true });
    await fs.promises.writeFile(path.join(sourceHome, 'auth.json'), '{"auth":"test"}');
    await fs.promises.writeFile(path.join(sourceHome, 'config.toml'), 'model = "test"\n');
    await fs.promises.writeFile(path.join(sourceHome, 'skills', 'test.md'), '# test\n');

    const runtimeHome = ensureCodexAppServerHome({
      configDir,
      agentId: 'agent-test-runtime',
      sourceHome,
    });
    assert.notStrictEqual(runtimeHome, sourceHome);
    assert(fs.lstatSync(path.join(runtimeHome, 'auth.json')).isSymbolicLink());
    assert(fs.lstatSync(path.join(runtimeHome, 'config.toml')).isSymbolicLink());
    assert(fs.lstatSync(path.join(runtimeHome, 'skills')).isSymbolicLink());
    assert(!fs.existsSync(path.join(runtimeHome, 'app-server-control', 'app-server-control.sock')));
    await fs.promises.writeFile(path.join(runtimeHome, 'sessions.jsonl'), 'runtime state');
    assert(!fs.existsSync(path.join(sourceHome, 'sessions.jsonl')));
    assert.throws(
      () => ensureCodexAppServerHome({ configDir, agentId: '../unsafe', sourceHome }),
      /Invalid Codex App Server agent id/
    );
    console.log('test-codex-app-server-home passed');
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
