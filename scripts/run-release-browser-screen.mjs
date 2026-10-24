#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run as runIsolated, executeLane, isTcpPortAvailable } from './run-playwright-isolated-lanes.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const definitions = [
  ['touch-files', 'release:fast-screen:touch-files'],
  ['mobile-files', 'release:fast-screen:mobile'],
  ['mobile-auth', 'release:fast-screen:mobile-auth'],
  ['composer', 'release:fast-screen:composer'],
  ['interaction', 'release:fast-screen:interaction'],
  ['language-server', 'release:fast-screen:language-server'],
  ['sidebar', 'release:fast-screen:sidebar-mobile'],
  ['communication', 'release:fast-screen:communication'],
  ['ui-boundaries', 'release:fast-screen:ui-boundaries'],
  ['mobile-viewport', 'release:fast-screen:mobile-viewport'],
  ['identity-files', 'release:fast-screen:identity-files'],
  ['wire-state', 'release:fast-screen:wire-state'],
  ['computer-resource', 'release:fast-screen:computer-resource'],
  ['structured-composer', 'release:fast-screen:structured-composer'],
  ['quoted-side', 'release:fast-screen:quoted-side'],
  ['dynamic-pinning', 'release:fast-screen:dynamic-pinning'],
];
export function selectBrowserScreen(files) {
  const selected = new Set();
  const unmapped = [];
  for (const filename of files) {
    let mapped = false;
    const select = names => { mapped = true; names.forEach(name => selected.add(name)); };
    if (/^src\/components\/files\/|^src\/lib\/workspace-|^src\/styles\/file-|^tests\/e2e\/(file-|global-file-search|iphone-mobile-layout|mobile-files|mobile-human-story)/.test(filename)) {
      select(['touch-files', 'mobile-files', 'mobile-auth']);
    }
    if (/^extensions\/language-server\/|^shared\/workspace-request-scheduling\.|^tests\/e2e\/(lsp-|file-editor-diagnostics)/.test(filename)) select(['language-server']);
    if (/^src\/components\/code\/.*[Cc]omposer|^src\/lib\/composer-|^src\/styles\/composer|^tests\/e2e\/(composer-|mobile-composer)/.test(filename)) select(['composer']);
    if (/^src\/components\/code\/(acp\/|.*[Cc]hat|.*[Tt]ranscript)|^(backend|shared)\/acp|^backend\/control-api\.cts|^src\/components\/CodeWorkspace\.|^src\/styles\/(chat|transcript)|^tests\/e2e\/(acp-|chat-|agent-handoff|terminal-state-protocol|related-(session|history)|ui-interaction-layer)/.test(filename)) select(['interaction']);
    if (/^src\/.*(auth|sharing|access)|^backend\/.*(auth|sharing|access-control|read-only-access)|^tests\/e2e\/(mobile-auth-readonly|read-only-chat-rejection)/.test(filename)) select(['mobile-auth']);
    if (/^src\/.*[Ss]idebar|^src\/styles\/sidebar|^tests\/e2e\/sidebar-/.test(filename)) select(['sidebar']);
    if (/^extensions\/a2a\/|^shared\/agent-communication\.|^src\/components\/code\/(CodeMainArea|PluginsPanel|copy|related-session-navigation)\.|^src\/styles\/plugin\.css$|^tests\/e2e\/(a2a-plugin|acp-peer-messages|shared-config-plugin)\.spec\.ts$/.test(filename)) select(['communication']);
    if (['src/components/code/MobileShareSheet.tsx', 'tests/e2e/mobile-navigation-modal.spec.ts',
      'tests/e2e/sidebar-focus-appearance.spec.ts', 'src/styles/sidebar.css'].includes(filename)) select(['ui-boundaries']);
    if (['src/components/code/MobileUnreadNavigation.tsx', 'src/components/code/mobile-unread-navigation.ts',
      'src/components/CodeWorkspace.tsx', 'src/components/code/AgentTranscriptPane.tsx',
      'src/styles/agent-list.css', 'src/styles/terminal.css', 'src/styles/main.css',
      'tests/e2e/mobile-unread-navigation.spec.ts'].includes(filename)) select(['mobile-viewport']);
    if (['tests/e2e/project-subdirectory-scope.spec.ts', 'tests/e2e/transcript-file-links.spec.ts'].includes(filename)) select(['identity-files']);
    if (['shared/browser-protocol.ts', 'shared/browser-protocol.js', 'frontend/agent-state-bridge.js',
      'tests/e2e/crt-agent-state-protocol.spec.ts'].includes(filename)) select(['wire-state']);
    if (['extensions/computer/backend/computer-resource-manager.cts', 'tests/e2e/computer-resources.spec.ts'].includes(filename)) select(['computer-resource']);
    if (['src/components/code/BrowserTabStatus.tsx', 'src/components/code/browser-tab-status.ts',
      'tests/e2e/browser-tab-status.spec.ts', 'index.html'].includes(filename)) select(['ui-boundaries']);
    if (/^shared\/composer-document\.|^src\/components\/code\/(ComposerRichInput|ComposerDocumentContent|composer-document-editor|composer-input-element)\.|^tests\/e2e\/(composer-rich-document|acp-goal)\.spec\.ts$/.test(filename)) select(['structured-composer']);
    if (/^src\/components\/code\/(QuotedContextCard|SubagentBody|SubagentPreparation|useSubagentOpening)\.|^tests\/e2e\/quoted-side-flow\.spec\.ts$/.test(filename)) select(['quoted-side']);
    if (['src/hooks/useWebSocket.ts', 'src/types/messages.ts'].includes(filename)) select(['interaction', 'wire-state', 'quoted-side']);
    if (['src/lib/dynamic-pinning.ts', 'tests/e2e/dynamic-pinning.spec.ts'].includes(filename)) select(['dynamic-pinning']);
    // The separate live-provider composite remains mandatory for this case;
    // the early deterministic screen exercises its shared interaction owners.
    if (filename === 'tests/e2e/internal/real-codex-release-case.spec.ts') select(['interaction', 'wire-state']);
    if (/^tests\/e2e\/(backend-connection-status|mermaid-module-recovery|background-chat-continuity)\.spec\.ts$/.test(filename)) select(['interaction']);
    if (filename === 'tests/e2e/quote-selection.spec.ts') select(['quoted-side', 'interaction']);
    if (!mapped && /^(src|frontend|extensions|shared)\/|^tests\/e2e\//.test(filename)) unmapped.push(filename);
  }
  return {
    files, lanes: definitions.filter(([name]) => selected.has(name)).map(([name, script]) => ({ name, script })),
    unmapped, maxParallel: 4, laneTimeoutMs: 180_000,
    scope: 'Early changed-area screen; full final exact-SHA CI remains required.',
    timingRisk: selected.size > 4 ? 'More than four selected lanes require a bounded queue; this screen may exceed three minutes.' : null,
    omissionReason: selected.size === 0 && unmapped.length === 0 ? 'No mapped browser input selected a lane; metadata and other backend inputs still require their owning checks.' : null,
  };
}
export function readChanges(base, root = repoRoot) {
  if (!base || base.startsWith('-') || base.includes('\0')) throw new Error('--base requires a commit or ref');
  const git = args => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 10_000 });
  const resolvedBase = git(['rev-parse', '--verify', `${base}^{commit}`]).trim();
  const tracked = git(['diff', '--name-only', '-z', resolvedBase, '--']).split('\0').filter(Boolean);
  const untracked = git(['ls-files', '--others', '--exclude-standard', '-z', '--', 'backend', 'src', 'frontend', 'extensions', 'shared', 'tests']).split('\0').filter(Boolean);
  return { resolvedBase, files: [...new Set([...tracked, ...untracked])].sort() };
}
export function parseBrowserArgs(args) {
  let base;
  let plan = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--base') base = args[++i];
    else if (args[i] === '--plan') plan = true;
    else throw new Error(`Unknown option: ${args[i]}`);
  }
  if (!base || base.startsWith('-')) throw new Error('Usage: run-release-browser-screen.mjs --base COMMIT_OR_REF [--plan]');
  return { base, plan };
}
export function laneCommand(script) {
  return { command: process.platform === 'win32' ? 'npm.cmd' : 'npm',
    args: ['run', script, '--', '--workers=1', '--retries=0', '--global-timeout=180000', '--max-failures=1', '--reporter=line'],
    env: { FARMING_E2E_REAL_CODEX: '0', FARMING_PLAYWRIGHT_INTERNAL: '0',
      FARMING_PLAYWRIGHT_AUTH: script === 'release:fast-screen:mobile-auth' ? '1' : '0' } };
}
async function availablePortRange(count, available) {
  for (let first = 43100; first < 43200; first += count) {
    if ((await Promise.all(Array.from({ length: count }, (_, i) => available(first + i)))).every(Boolean)) return first;
  }
  throw new Error('No available isolated browser-screen port range');
}
export async function runBrowserScreen(args = process.argv.slice(2), dependencies = {}) {
  const startedAt = Date.now();
  const options = parseBrowserArgs(args);
  const changes = (dependencies.readChanges ?? readChanges)(options.base);
  const plan = { base: changes.resolvedBase, ...selectBrowserScreen(changes.files) };
  const write = dependencies.write ?? (value => console.log(JSON.stringify(value, null, 2)));
  if (options.plan) { write({ ...plan, commands: plan.lanes.map(lane => ({ name: lane.name, ...laneCommand(lane.script) })) }); return 0; }
  if (plan.unmapped.length) {
    write({ ...plan, status: 'blocked', reason: 'Unmapped browser inputs require an explicit owning focused scenario; no build or lane was started.' });
    return 1;
  }
  if (!plan.lanes.length) { write({ ...plan, status: 'not-selected', elapsedMs: Date.now() - startedAt }); return 0; }
  const basePort = await availablePortRange(plan.lanes.length, dependencies.isTcpPortAvailable ?? isTcpPortAvailable);
  const receipts = [];
  let code = 1;
  let failure;
  try {
    code = await (dependencies.runIsolated ?? runIsolated)(['--project', 'chromium', '--lanes', String(plan.lanes.length), '--retain-evidence'], {
      ...dependencies.isolated,
      env: { ...process.env, FARMING_PLAYWRIGHT_PORT_BASE: String(basePort) },
      laneConcurrency: 4,
      createLaneCommand: ({ laneIndex }) => laneCommand(plan.lanes[laneIndex - 1].script),
      executeLane: async parameters => {
        const started = Date.now();
        let result = 1;
        try { result = await (dependencies.executeLane ?? executeLane)(parameters); return result; }
        finally { receipts.push({ name: plan.lanes[parameters.lane.laneIndex - 1].name, code: result,
          elapsedMs: Date.now() - started, port: parameters.lane.env.FARMING_PLAYWRIGHT_PORT,
          evidenceDirectory: parameters.lane.laneRoot }); }
      },
    });
  } catch (error) { failure = error instanceof Error ? error.message : String(error); }
  write({ ...plan, status: code === 0 ? 'green' : 'failed', elapsedMs: Date.now() - startedAt, receipts, ...(failure ? { failure } : {}) });
  return code;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runBrowserScreen().then(code => { process.exitCode = code; }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
