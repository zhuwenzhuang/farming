const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { AgentExtensionInventory } = require('../agent-extension-inventory.cjs');
const { AgentSessionInventory } = require('../agent-session-inventory.cjs');

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-agent-inventories-'));
  const codexHome = path.join(root, 'codex');
  const sessionsRoot = path.join(codexHome, 'sessions');
  const skillsRoot = path.join(codexHome, 'skills', 'example');
  fs.mkdirSync(sessionsRoot, { recursive: true });
  fs.mkdirSync(skillsRoot, { recursive: true });
  const sessionMarker = path.join(sessionsRoot, 'marker.jsonl');
  fs.writeFileSync(sessionMarker, 'one');
  fs.writeFileSync(path.join(skillsRoot, 'SKILL.md'), '---\nname: Example\ndescription: First\n---\n');

  let historyLoads = 0;
  const history = new AgentSessionInventory({
    cacheFile: path.join(root, 'cache', 'history.json'),
    listSessions: async () => {
      historyLoads += 1;
      const title = fs.readFileSync(sessionMarker, 'utf8');
      return [{
        provider: 'codex',
        providerHomeId: 'default',
        id: 'session-1',
        title,
        updatedAt: '2026-07-31T00:00:00.000Z',
      }];
    },
  });
  const metadata = () => ({
    providerHomes: { codex: [{ id: 'default', path: codexHome }] },
    providerSessionBindings: [],
  });

  assert.strictEqual((await history.list(metadata))[0].title, 'one');
  assert.strictEqual((await history.list(metadata))[0].title, 'one');
  assert.strictEqual(historyLoads, 1);
  fs.writeFileSync(sessionMarker, 'two-two');
  assert.strictEqual((await history.list(metadata))[0].title, 'two-two');
  assert.strictEqual(historyLoads, 2, 'History should reconcile a changed provider Home before returning');

  let extensionLoads = 0;
  const extensions = new AgentExtensionInventory({
    cacheFile: path.join(root, 'cache', 'extensions.json'),
    discoverExtensions: options => {
      extensionLoads += 1;
      const skill = path.join(options.providerHomePath, 'skills', 'example', 'SKILL.md');
      return [{
        id: 'skill:example',
        name: fs.readFileSync(skill, 'utf8').includes('Second') ? 'Second' : 'First',
        description: '',
        kind: 'skill',
        scope: 'Home',
        status: 'configured',
        sourceFile: 'skills/example/SKILL.md',
      }];
    },
    readConfiguration: () => ({ exists: false, filePath: 'config.toml', summary: [] }),
  });

  assert.strictEqual((await extensions.get('codex', codexHome)).extensions[0].name, 'First');
  assert.strictEqual((await extensions.get('codex', codexHome)).extensions[0].name, 'First');
  assert.strictEqual(extensionLoads, 1);
  fs.writeFileSync(path.join(skillsRoot, 'SKILL.md'), '---\nname: Second\n---\n');
  assert.strictEqual((await extensions.get('codex', codexHome)).extensions[0].name, 'Second');
  assert.strictEqual(extensionLoads, 2, 'Plugins should reconcile a changed Home before returning');

  await history.close();
  await extensions.close();
  fs.rmSync(root, { recursive: true, force: true });
  console.log('test-agent-inventories passed');
}

run().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
