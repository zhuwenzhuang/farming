const assert = require('assert');
const { importTsModule } = require('./helpers/import-ts-module');
const { isStoppedAgentResumeCandidate } = importTsModule('src/components/code/ResumeStoppedAgentDialog.tsx');

const agent = {
  providerSessionProvider: 'codex', providerHomeId: 'work',
  projectWorkspace: '/work/project', cwd: '/work/project/nested',
};
const session = {
  provider: 'codex', providerHomeId: 'work', id: 'session-1',
  workspace: '/work/project', cwd: '/work/project/nested', title: 'Chosen conversation', updatedAt: '',
};
assert.strictEqual(isStoppedAgentResumeCandidate(agent, session), true);
for (const patch of [
  { provider: 'claude' }, { providerHomeId: 'default' }, { providerHomeId: undefined },
  { workspace: '/work/project-other' }, { workspace: '/work/project/nested' },
  { workspace: '/work' }, { archived: true }, { id: '' },
]) {
  assert.strictEqual(isStoppedAgentResumeCandidate(agent, { ...session, ...patch }), false, JSON.stringify(patch));
}
assert.strictEqual(isStoppedAgentResumeCandidate(
  { ...agent, providerHomeId: undefined }, { ...session, providerHomeId: 'default' },
), true, 'an omitted Home means the exact default Home');
assert.strictEqual(isStoppedAgentResumeCandidate(
  { ...agent, projectWorkspace: '' }, { ...session, workspace: '' },
), true, 'cwd is the workspace fallback only when project workspace is absent');
assert.strictEqual(isStoppedAgentResumeCandidate({ ...agent, projectWorkspace: '', cwd: '' }, session), false);
console.log('stopped Agent resume candidate tests passed');
