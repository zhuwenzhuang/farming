import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { runDiscoveryCommand } from '../discovery-command.cjs';
import { discoverAgentHomes } from '../agent-home-discovery.cjs';
import { AgentShellEnvResolver, resolveUserShellEnv } from '../agent-env.cjs';
import { clearExecutableVersionCache, listAvailableAgentsAsync, resolveTerminalExecutableAsync } from '../executable-discovery.cjs';

async function run(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'farming-refresh-concurrency-'));
  try {
    const executable = path.join(root, 'slow-agent');
    const calls = path.join(root, 'calls');
    const script = (version: string) => `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(calls)}, 'probe\\n');\nsetTimeout(() => console.log('${version}'), 700);\n`;
    await fs.writeFile(executable, script('1.2.3'), { mode: 0o755 });
    const options = { systemCandidates: [executable], farmingCandidates: [] };
    const homes = discoverAgentHomes({ userHome: root, env: {}, timeoutMs: 500 });
    const resolutions = Promise.all([
      resolveTerminalExecutableAsync('codex', '', options),
      resolveTerminalExecutableAsync('claude', '', options),
    ]);
    await assert.doesNotReject(homes, 'slow executable discovery must not consume another request’s Home deadline');
    for (const resolution of await resolutions) assert.equal(resolution.path, executable);
    assert.equal((await fs.readFile(calls, 'utf8')).trim().split('\n').length, 1, 'concurrent version reads share one exact executable probe');
    assert.equal((await resolveTerminalExecutableAsync('codex', '', options)).version, '1.2.3');
    await fs.writeFile(executable, script('2.30.4'));
    assert.equal((await resolveTerminalExecutableAsync('codex', '', options)).version, '2.30.4', 'changed metadata invalidates the version');
    const managed = path.join(root, 'managed');
    await fs.writeFile(managed, script('3.0.0'), { mode: 0o755 });
    assert.equal((await resolveTerminalExecutableAsync('codex', '', { ...options, farmingCandidates: [managed] })).source, 'farming');
    assert.equal((await resolveTerminalExecutableAsync('claude', '', { systemCandidates: [managed], farmingCandidates: [managed] })).source, 'system', 'equal versions preserve system preference');

    const pi = path.join(root, 'pi');
    await fs.writeFile(pi, `#!${process.execPath}\nsetTimeout(() => console.log('AI coding assistant with read, bash, edit, write tools'), 700);\n`, { mode: 0o755 });
    const identityHomes = discoverAgentHomes({ userHome: root, env: {}, timeoutMs: 500 });
    const available = listAvailableAgentsAsync(root);
    await assert.doesNotReject(identityHomes);
    assert((await available).some(agent => agent.name === 'pi'));
    await fs.writeFile(pi, `#!${process.execPath}\nconsole.log('unrelated pi utility');\n`);
    assert(!(await listAvailableAgentsAsync(root)).some(agent => agent.name === 'pi'));

    const shellHomes = discoverAgentHomes({ userHome: root, env: {}, timeoutMs: 500 });
    const shell = resolveUserShellEnv({ shell: process.execPath, cwd: root, processEnv: {}, args: ['-e', `setTimeout(() => console.log('__FARMING_AGENT_ENV_BEGIN__\\n{"PATH":"/fixture"}\\n__FARMING_AGENT_ENV_END__'), 700)`] });
    await assert.doesNotReject(shellHomes);
    assert.equal((await shell)?.PATH, '/fixture');
    const timeout = await resolveUserShellEnv({ shell: process.execPath, cwd: root, processEnv: {}, timeoutMs: 250, args: ['-e', 'setInterval(() => {}, 1000)'] });
    assert.equal(timeout, null);

    if (process.platform !== 'win32') {
      const marker = path.join(root, 'descendant-survived');
      const pidFile = path.join(root, 'descendant-pid');
      const descendant = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'leaked'), 900)`;
      const parent = `const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: 'inherit' }); require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(child.pid)); setInterval(() => {}, 1000);`;
      try {
        assert.equal(await runDiscoveryCommand(process.execPath, ['-e', parent], { timeoutMs: 500 }), null);
        await fs.access(pidFile);
        await new Promise(resolve => setTimeout(resolve, 600));
        await assert.rejects(fs.access(marker), { code: 'ENOENT' }, 'timeout must kill the exact probe descendants');
      } finally {
        try { process.kill(Number(await fs.readFile(pidFile, 'utf8')), 'SIGKILL'); } catch { /* Already killed. */ }
      }
    }
    assert.equal(await runDiscoveryCommand(path.join(root, 'missing'), [], { timeoutMs: 250 }), null);
    assert.equal(await runDiscoveryCommand(process.execPath, ['-e', "console.log('x'.repeat(1024 * 1024 + 1))"], { timeoutMs: 1000 }), null);

    let complete!: (env: NodeJS.ProcessEnv) => void;
    let reads = 0;
    const resolver = new AgentShellEnvResolver({ provider: () => ({ PATH: '/sync' }), asyncProvider: () => {
      reads++;
      return new Promise(resolve => { complete = resolve; });
    } });
    const first = resolver.resolveAsync();
    assert.equal(resolver.resolveAsync(), first, 'concurrent shell inventory reads share one collection');
    await Promise.resolve();
    complete({ PATH: '/async' });
    assert.equal((await first)?.PATH, '/async');
    assert.equal(resolver.resolve()?.PATH, '/async', 'synchronous launch consumes the shared completed cache');
    assert.equal(reads, 1);
    const pending = resolver.resolveAsync('', { force: true });
    await Promise.resolve();
    resolver.dispose();
    complete({ PATH: '/disposed' });
    await pending;
    assert.equal(resolver.resolve()?.PATH, '/sync', 'late collection cannot repopulate a disposed resolver');
    resolver.dispose();
    console.log('Refresh discovery concurrency, executable policy, metadata invalidation, shell timeout and cleanup passed');
  } finally {
    clearExecutableVersionCache();
    await fs.rm(root, { recursive: true, force: true });
  }
}
void run().catch(error => { console.error(error); process.exitCode = 1; });
