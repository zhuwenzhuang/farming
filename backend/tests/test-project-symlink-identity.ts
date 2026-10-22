import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FarmingSessionStore } from '../farming-session-store.cjs';
import { ConfigManager } from '../config-manager.cjs';
import { RunHistoryStore } from '../run-history-store.cjs';
import { AgentSessionInventory } from '../agent-session-inventory.cjs';
import { encodeProviderSessionKey } from '../../shared/provider-session-identity.js';
import { groupAgentsByProject } from '../../src/components/code/model';

async function run() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'farming-project-symlink-')));
  let inventory: AgentSessionInventory | undefined;
  try {
    const project = path.join(root, 'internal', 'sql-insight');
    const alias = path.join(root, 'public', 'sql-insight');
    const distinct = path.join(root, 'distinct', 'sql-insight');
    fs.mkdirSync(project, { recursive: true });
    fs.mkdirSync(path.dirname(alias), { recursive: true });
    fs.mkdirSync(distinct, { recursive: true });
    fs.symlinkSync(project, alias, 'junction');
    const configDir = path.join(root, 'config');
    const store = new FarmingSessionStore(configDir);
    store.init();
    const key = encodeProviderSessionKey('codex', 'legacy-conversation', 'default');
    // Seed old bytes directly; using today's writer would hide the migration bug.
    const legacy = {
      id: 'agent_legacy', kind: 'agent', cwd: alias, projectWorkspace: alias,
      provider: 'codex', providerHomeId: 'default', providerSessionId: 'legacy-conversation',
      providerSessionKey: key, pinned: true, archived: true, archivedAt: 123,
      customTitle: 'Keep this title', createdAt: 10, updatedAt: 20,
    };
    fs.writeFileSync(store.sessionFile(legacy.id), JSON.stringify(legacy));
    const recovered = store.readRecord(legacy.id)!;
    assert.equal(recovered.projectWorkspace, project);
    assert.equal(recovered.cwd, alias);
    assert.equal(recovered.providerSessionKey, key);
    assert.equal(recovered.pinned, true);
    assert.equal(recovered.archivedAt, 123);
    assert.equal(recovered.customTitle, legacy.customTitle);
    assert.equal(recovered.updatedAt, 20, 'reading must not reorder old conversations');
    assert.equal(JSON.parse(fs.readFileSync(store.sessionFile(legacy.id), 'utf8')).projectWorkspace, alias,
      'read migration must not rewrite metadata while another owner may be writing');
    store.writeRecord(recovered);
    assert.equal(JSON.parse(fs.readFileSync(store.sessionFile(legacy.id), 'utf8')).projectWorkspace, project);
    const reopened = new FarmingSessionStore(configDir);
    reopened.init();
    assert.equal(reopened.getRecordForProviderSessionKey(key)!.id, legacy.id);
    assert.equal(reopened.readRecord(legacy.id)!.projectWorkspace, project);

    const missing = path.join(root, 'unmounted', 'sql-insight');
    const missingId = store.writeRecord({ ...legacy, id: 'agent_missing', projectWorkspace: missing });
    assert.equal(store.readRecord(missingId)!.projectWorkspace, missing, 'unavailable paths retain membership');
    const mainId = store.writeRecord({ ...legacy, id: 'agent_main', wantsMain: true, projectWorkspace: '' });
    assert.equal(store.readRecord(mainId)!.projectWorkspace, '', 'main Agent stays projectless');

    const config = Object.create(ConfigManager.prototype) as ConfigManager;
    const history = new RunHistoryStore(configDir, {
      normalizeTaskHistory: entries => config.normalizeTaskHistory(entries),
    });
    fs.mkdirSync(path.join(configDir, 'history'), { recursive: true });
    fs.writeFileSync(path.join(configDir, 'history', 'runs.json'), JSON.stringify([{
      id: 'run-old', agentId: 'old-runtime', command: 'codex', reason: 'manual-kill',
      cwd: alias, projectWorkspace: alias, archivedAt: 123, title: 'Old run',
    }]));
    history.init();
    assert.equal(history.getEntries()[0].projectWorkspace, project);
    assert.equal(history.getEntries()[0].cwd, alias);
    assert.equal(history.getEntries()[0].archivedAt, 123);
    assert.equal(JSON.parse(fs.readFileSync(path.join(configDir, 'history', 'runs.json'), 'utf8'))[0].projectWorkspace, project);

    const home = path.join(root, 'provider-home');
    fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
    let loads = 0;
    inventory = new AgentSessionInventory({
      cacheFile: path.join(root, 'inventory.json'),
      listSessions: async () => {
        loads += 1;
        return [
          { id: 'old', provider: 'claude', providerHomeId: 'default', cwd: alias, workspace: alias },
          { id: 'new', provider: 'claude', providerHomeId: 'default', cwd: project, workspace: project },
          { id: 'other', provider: 'claude', providerHomeId: 'default', cwd: distinct, workspace: distinct },
          { id: 'missing', provider: 'claude', providerHomeId: 'default', cwd: missing, workspace: missing },
          { id: 'chat', provider: 'claude', providerHomeId: 'default', cwd: alias, workspace: '', projectless: true },
        ];
      },
    });
    const metadata = () => ({ providerHomes: { claude: [{ id: 'default', path: home }] } });
    const sessions = await inventory.list(metadata);
    assert.equal(sessions.find(session => session.id === 'old')!.cwd, alias);
    assert.equal(sessions.find(session => session.id === 'old')!.workspace, project);
    const groups = groupAgentsByProject([], sessions as Parameters<typeof groupAgentsByProject>[1]);
    assert.deepEqual(groups.find(group => group.workspace === project)!.agentSessions.map(s => s.id).sort(), ['new', 'old']);
    assert.equal(groups.filter(group => group.workspace === distinct).length, 1, 'same basename is not identity');
    assert.equal(sessions.find(session => session.id === 'missing')!.workspace, missing);
    assert.equal(sessions.find(session => session.id === 'chat')!.workspace, '');
    const baselineLoads = loads;
    fs.unlinkSync(alias);
    fs.symlinkSync(distinct, alias, 'junction');
    const refreshed = await inventory.list(metadata);
    assert.equal(refreshed.find(session => session.id === 'old')!.workspace, distinct,
      'a warm provider cache must not freeze a symlink target');
    assert.equal(loads, baselineLoads, 'path reconciliation must reuse the provider inventory cache');
    console.log('Project symlink identity: legacy records, history, cache and grouping passed');
  } finally {
    await inventory?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
