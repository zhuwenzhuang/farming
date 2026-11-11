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
// --switching exercises client Full access -> Manual -> Full access and reconnect
// with real shell tool requests; requires a provider with clientFullAccess.
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
        'oauth_creds.json', 'opencode.json', 'opencode.jsonc', 'state.json', '.auth',
        'antigravity-oauth-token', 'jetski_state.pbtxt', 'antigravity_state.pbtxt', 'installation_id']) {
        const input = path.join(source, name);
        if (fs.existsSync(input)) fs.cpSync(input, path.join(home, name), { recursive: true });
      }
      const executable = value('--executable') || adapter.executable;
      const launch = resolveLaunchCommand(adapter.id, { dangerouslySkipPermissions: true });
      const prepareOptions = { agentId: 'smoke', provider: adapter.id,
        executable, configDir: root, cwd: workspace, providerHomePath: home,
        approvalMode: launch.permissionMode || 'approve', env: { ...process.env, [adapter.homeEnvKey]: home,
          XDG_DATA_HOME: path.join(root, 'data'), XDG_STATE_HOME: path.join(root, 'state'), XDG_CACHE_HOME: path.join(root, 'cache') } };
      const result = await runtime.prepareAgent(prepareOptions);
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
        clearTimeout(timer);
      }
      if (args.includes('--switching')) {
        const nativeMode = adapter.acp.config?.clientFullAccess?.nativeMode;
        assert.ok(nativeMode, '--switching requires clientFullAccess');
        const withinDeadline = async <T>(operation: Promise<T>) => {
          try {
            return await Promise.race([operation, new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error('Permission transition observation deadline exceeded')), 90_000);
            })]);
          } finally { clearTimeout(timer); }
        };
        const proof = randomUUID();
        const runTool = (filename: string) => runtime.prompt('smoke', [{ type: 'text', text:
          `Permission integration test. Use your shell tool to run exactly: printf '%s' '${proof}' > '${path.join(workspace, filename)}' . Do not use file edit tools or modify other files. If permission is denied, stop without retrying or using another tool. Reply DONE after the tool settles.` }]);
        await withinDeadline(runTool('full-proof.txt'));
        assert.equal(fs.readFileSync(path.join(workspace, 'full-proof.txt'), 'utf8').trim(), proof);
        await runtime.setSessionConfigOption('smoke', modeOption!.id, nativeMode);
        const manual = runTool('manual-proof.txt');
        let manualSettled = false;
        void manual.then(() => { manualSettled = true; }, () => { manualSettled = true; });
        await withinDeadline((async () => {
          while (binding.pendingPermissions.size === 0) {
            assert.equal(manualSettled, false, 'manual tool completed without an approval request');
            await new Promise(resolve => setTimeout(resolve, 20));
          }
        })());
        assert.equal(fs.existsSync(path.join(workspace, 'manual-proof.txt')), false);
        const request = [...binding.pendingPermissions.values()][0];
        const choices = request.options as Array<{ optionId: string; kind: string }>;
        const reject = choices.find(choice => choice.kind === 'reject_once');
        assert.ok(reject, 'native permission must offer rejection');
        runtime.respondPermission('smoke', String(request.requestId), reject.optionId);
        await withinDeadline(manual);
        assert.equal(fs.existsSync(path.join(workspace, 'manual-proof.txt')), false, 'denied tool must not execute');
        await runtime.setSessionConfigOption('smoke', modeOption!.id, expected);
        const overrides = binding.restartOptions.configOverrides;
        const previousPid = binding.child?.pid;
        await runtime.unregisterAgentAndWait('smoke');
        await runtime.prepareAgent({ ...prepareOptions, sessionId: result.sessionId, historyMode: 'load', configOverrides: overrides });
        assert.notEqual(runtime.bindings.get('smoke')!.child?.pid, previousPid, 'restore must use a new provider process');
        assert.equal(runtime.getSession('smoke').sessionId, result.sessionId);
        assert.equal(runtime.getSession('smoke').currentModeId, expected);
        await withinDeadline(runTool('restored-proof.txt'));
        assert.equal(fs.readFileSync(path.join(workspace, 'restored-proof.txt'), 'utf8').trim(), proof);
        assert.equal(runtime.bindings.get('smoke')!.pendingPermissions.size, 0);
      }
      console.log(JSON.stringify({ provider: adapter.id, status: 'passed', info: binding.initializeResponse.agentInfo,
        permissionMode: expected || 'provider-native/client-approval', toolProof: args.includes('--turn'), switching: args.includes('--switching') }));
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
