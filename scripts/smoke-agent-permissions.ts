#!/usr/bin/env -S npx tsx
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AcpRuntime } from '../backend/acp-runtime.cjs';
import { resolveLaunchCommand } from '../backend/cli-agents.cjs';
import { listProviderAdapters } from '../backend/provider-adapters.cjs';

const expectedModes: Record<string, string> = {
  codex: 'agent-full-access', claude: 'bypassPermissions', qoder: 'bypassPermissions',
  qwen: 'yolo', agy: 'bypassPermissions', opencode: '', pi: '',
};

// Explicit real-provider smoke; never included in routine fake-agent CI.
// Usage: npx tsx scripts/smoke-agent-permissions.ts --provider qoder --turn
// --home and --executable select existing credentials/runtime without modifying them.
async function main() {
  const args = process.argv.slice(2);
  const value = (flag: string) => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
  const selected = value('--provider');
  const adapters = listProviderAdapters().filter(adapter => !selected || adapter.id === selected);
  assert.ok(adapters.length, `Unknown provider: ${selected}`);
  if ((value('--home') || value('--executable')) && !selected) throw new Error('--home/--executable requires --provider');
  let failed = false;
  for (const adapter of adapters) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-real-permissions-'));
    const home = path.join(root, 'home');
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(home, { mode: 0o700 });
    fs.mkdirSync(workspace);
    const source = value('--home') || path.join(os.homedir(), adapter.usage.defaultHomeDirectory);
    const runtime = new AcpRuntime({ initializeTimeoutMs: 30_000, sessionSetupTimeoutMs: 30_000, requestTimeoutMs: 15_000 });
    let timer: NodeJS.Timeout | undefined;
    try {
      // Copy only configuration/authentication, never sessions or workspace data.
      for (const name of ['settings.json', 'auth.json', 'models.json', 'config.toml', '.credentials.json',
        'oauth_creds.json', 'opencode.json', 'opencode.jsonc', 'state.json', '.auth']) {
        const input = path.join(source, name);
        if (fs.existsSync(input)) fs.cpSync(input, path.join(home, name), { recursive: true });
      }
      const executable = value('--executable') || adapter.executable;
      const launch = resolveLaunchCommand(adapter.id, { dangerouslySkipPermissions: true });
      const result = await runtime.prepareAgent({ agentId: 'smoke', provider: adapter.id,
        executable, configDir: root, cwd: workspace, providerHomePath: home,
        approvalMode: launch.permissionMode || 'approve', env: { ...process.env, [adapter.homeEnvKey]: home,
          XDG_DATA_HOME: path.join(root, 'data'), XDG_STATE_HOME: path.join(root, 'state'), XDG_CACHE_HOME: path.join(root, 'cache') } });
      assert.ok(result.sessionId, `${adapter.id}: authentication required`);
      const binding = runtime.bindings.get('smoke')!;
      assert.ok(Object.hasOwn(expectedModes, adapter.id), 'new providers need a real permission acceptance contract');
      const expected = expectedModes[adapter.id];
      const modeOption = binding.configOptions.find(option => option.category === 'mode');
      if (expected) {
        assert.equal(binding.sessionState?.currentModeId, expected, 'provider permission mode');
        if (modeOption) assert.equal(modeOption.currentValue, expected, 'Composer permission selection');
      }
      if (args.includes('--turn')) {
        const proof = randomUUID();
        const prompt = runtime.prompt('smoke', [{ type: 'text', text:
          `Permission integration test. Use your file or shell tool to create exactly bypass-proof.txt in the current working directory, containing exactly ${proof}. Do not modify any other files. Then reply DONE.` }]);
        const deadline = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Test observation deadline: tool proof not completed within 90 seconds')), 90_000);
        });
        await Promise.race([prompt, deadline]);
        assert.equal(fs.readFileSync(path.join(workspace, 'bypass-proof.txt'), 'utf8').trim(), proof);
        assert.equal(binding.pendingPermissions.size, 0, 'no unanswered permission request');
      }
      console.log(JSON.stringify({ provider: adapter.id, status: 'passed', info: binding.initializeResponse.agentInfo,
        permissionMode: expected || 'provider-native/client-approval', toolProof: args.includes('--turn') }));
    } catch (error) {
      failed = true;
      console.error(JSON.stringify({ provider: adapter.id, status: 'failed', error: error instanceof Error ? error.message : String(error) }));
    } finally {
      clearTimeout(timer);
      await runtime.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
  if (failed) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
