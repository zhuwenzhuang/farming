import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { discoverAgentHomes, type DiscoveredAgentHome } from '../agent-home-discovery.cjs';
import { ConfigManager } from '../config-manager.cjs';
import { listProviderAdapters } from '../provider-adapters.cjs';

async function run(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'farming-home-discovery-'));
  const userHome = await fs.realpath(root);
  const originalLog = console.log;
  try {
    for (const provider of listProviderAdapters()) {
      const home = path.join(userHome, provider.usage.defaultHomeDirectory);
      await fs.mkdir(home, { recursive: true });
      await fs.writeFile(path.join(home, provider.homeDiscoveryMarkers[0]), 'fixture');
    }
    const work = path.join(userHome, '.codex-work');
    await fs.mkdir(work);
    await fs.mkdir(path.join(work, 'sessions'));
    await fs.mkdir(path.join(userHome, '.codex-empty'));
    await fs.mkdir(path.join(userHome, '.codex-security'));
    await fs.writeFile(path.join(userHome, '.codex-backup'), 'not a directory');
    await fs.symlink(work, path.join(userHome, '.codex-alias'), 'dir');
    const custom = path.join(userHome, 'custom-home');
    await fs.mkdir(custom);
    await fs.writeFile(path.join(custom, 'settings.json'), '{}');
    const xdgHome = path.join(userHome, 'config', 'opencode');
    await fs.mkdir(xdgHome, { recursive: true });
    await fs.writeFile(path.join(xdgHome, 'opencode.json'), '{}');
    const piHome = path.join(userHome, '.pi-work', 'agent');
    await fs.mkdir(piHome, { recursive: true });
    await fs.writeFile(path.join(piHome, 'settings.json'), '{}');
    const options = { userHome, env: { CLAUDE_CONFIG_DIR: custom, XDG_CONFIG_HOME: path.dirname(xdgHome) } };
    const discovered = await discoverAgentHomes(options);
    assert.equal(discovered.length, listProviderAdapters().length + 4);
    assert.equal(discovered.filter(home => home.path === work).length, 1, 'realpath aliases must be deduplicated');
    assert(discovered.some(home => home.provider === 'claude' && home.path === custom));
    assert(discovered.some(home => home.provider === 'opencode' && home.path === xdgHome));
    assert(discovered.some(home => home.provider === 'pi' && home.path === piHome));
    assert(discovered.some(home => home.provider === 'pi' && home.path.endsWith('/.pi/agent')));
    await assert.rejects(discoverAgentHomes({ ...options, timeoutMs: 0 }), /timed out/);

    console.log = () => {};
    let scans = 0;
    let completeScan: ((homes: DiscoveredAgentHome[]) => void) | undefined;
    let failWrite = false;
    const configDir = path.join(userHome, 'farming');
    const manager = new ConfigManager({
      configDir,
      discoverHomes: () => { scans++; return new Promise(resolve => { completeScan = resolve; }); },
    });
    manager.init();
    const originalWrite = manager.writeJson;
    manager.writeJson = (file, value) => {
      if (failWrite) throw new Error('fixture disk full');
      originalWrite(file, value);
    };
    manager.updateSettings({ agentHomes: Object.fromEntries(listProviderAdapters().map(provider => [
      provider.id,
      [{ id: 'default', path: path.join(userHome, provider.usage.defaultHomeDirectory) }],
    ])) });
    const refresh = manager.refreshAgentHomes();
    assert.equal(manager.refreshAgentHomes(), refresh, 'concurrent reads share the scan');
    manager.updateSettings({ language: 'zh' });
    completeScan!(discovered);
    await refresh;
    assert.equal(scans, 1);
    assert.equal(manager.getSettings().language, 'zh', 'discovery must merge into the latest settings');
    const workHome = manager.getAgentHomes('codex').find(home => home.path === work)!;
    assert(workHome);
    assert(workHome.order > manager.getAgentHome('codex')!.order);
    assert.equal(manager.getAgentLaunchProfile('codex').homeId, 'default');
    const repeat = manager.refreshAgentHomes();
    completeScan!(discovered);
    await repeat;
    assert.equal(manager.getAgentHomes('codex').length, 2);
    assert.equal(manager.getAgentHomes('codex')[1].id, workHome.id);

    const pending = manager.refreshAgentHomes();
    manager.updateSettings({ agentHomes: {
      ...manager.getSettings().agentHomes,
      codex: manager.getAgentHomes('codex').filter(home => home.id !== workHome.id),
    } });
    completeScan!(discovered);
    await pending;
    assert.equal(manager.getAgentHomes('codex').length, 1, 'a concurrent removal must win');
    const restarted = new ConfigManager({ configDir, discoverHomes: async () => discovered });
    restarted.init();
    await restarted.refreshAgentHomes();
    assert.equal(restarted.getAgentHomes('codex').length, 1, 'removed Homes stay removed after restart');
    assert.equal('agentHomeDiscoveryExcludedPaths' in restarted.getSettings(), false);

    const newer = path.join(userHome, '.codex-newer');
    failWrite = true;
    const failed = manager.refreshAgentHomes();
    completeScan!([{ provider: 'codex', path: newer }]);
    await assert.rejects(failed, /disk full/);
    assert.equal(manager.getAgentHomes('codex').length, 1, 'failed persistence must not publish a Home');
    failWrite = false;
    const retry = manager.refreshAgentHomes();
    completeScan!([{ provider: 'codex', path: newer }]);
    await retry;
    assert.equal(manager.getAgentHomes('codex').length, 2);
    // Manual re-add restores the removed identity and remains deduplicated.
    manager.updateSettings({ agentHomes: {
      ...manager.getSettings().agentHomes,
      codex: [...manager.getAgentHomes('codex'), workHome],
    } });
    const readded = manager.refreshAgentHomes();
    completeScan!(discovered);
    await readded;
    assert.equal(manager.getAgentHomes('codex').filter(home => home.path === work).length, 1);
  } finally {
    console.log = originalLog;
    await fs.rm(root, { recursive: true, force: true });
  }
  console.log('Agent Home discovery, persistence, removal, concurrency and recovery passed');
}

void run().catch(error => { console.error(error); process.exitCode = 1; });
