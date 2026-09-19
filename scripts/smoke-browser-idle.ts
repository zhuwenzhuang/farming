import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AgentBrowserRuntime } from '../extensions/browser/backend/agent-browser-runtime.cjs';
import { hardStopConfigProcesses } from '../backend/config-process-ownership.cjs';
import { matchingProcessIdentity, readServerProcessIdentity } from '../backend/server-process-identity.cjs';

// Explicit real-browser smoke; routine tests use deterministic fake runtimes.
// Usage: npx tsx scripts/smoke-browser-idle.ts /path/to/agent-browser /path/to/chrome
const [agentBrowserPath, executablePath] = process.argv.slice(2);
if (!agentBrowserPath || !executablePath || process.platform === 'win32') {
  throw new Error('Provide agent-browser and Chrome executables on macOS or Linux');
}
const exec = promisify(execFile);
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
// Keep Unix socket paths below macOS sockaddr_un's 103-byte limit.
const root = fs.mkdtempSync('/tmp/fb-idle-');
const previousSockets = process.env.AGENT_BROWSER_SOCKET_DIR;
process.env.AGENT_BROWSER_SOCKET_DIR = path.join(root, 's');
const profileDir = path.join(root, 'profile');
const runtime = new AgentBrowserRuntime({
  id: 'idle-smoke', generation: 1, configDir: root, profileDir,
  agentBrowserPath, executablePath,
});
let frames = 0;
let tabsObserved = 0;
let stoppedAbruptly = false;
const failures: string[] = [];
runtime.on('frame', () => { frames++; });
runtime.on('tabs', () => { tabsObserved++; });
runtime.on('error', error => failures.push(String(error)));
runtime.on('exit', error => failures.push(String(error)));

async function processes() {
  const { stdout } = await exec('ps', ['-axo', 'pid=,ppid=,%cpu=,command='], { timeout: 3_000, maxBuffer: 8 * 1024 * 1024 });
  return stdout.split('\n').flatMap(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+([\d.]+)\s+(.*)$/);
    return match ? [{ pid: Number(match[1]), parent: Number(match[2]), cpu: Number(match[3]), command: match[4] }] : [];
  });
}

async function measure(phase: string, visible: boolean) {
  await runtime.setViewerActive(visible);
  await wait(500); // Allow the upstream subscriber count to settle.
  frames = 0;
  await wait(5_000);
  const owned = (await processes()).filter(row => row.command.includes(`--user-data-dir=${profileDir} `));
  console.log(JSON.stringify({ phase, frames, cpu: owned.map(({ pid, cpu }) => ({ pid, cpu })) }));
  assert(visible ? frames > 0 : frames === 0, `${phase}: unexpected frame capture`);
}

async function main() {
  try {
    await runtime.start('about:blank');
    const initialTab = runtime.activeTabId;
    await runtime.evaluate({ expression: `document.body.innerHTML='<input id="text"><canvas width="1280" height="720"></canvas>';
      const ctx=document.querySelector('canvas').getContext('2d');
      function draw(t){ctx.fillStyle='hsl('+(t/10%360)+' 80% 50%)';ctx.fillRect(0,0,1280,720);requestAnimationFrame(draw)}
      requestAnimationFrame(draw);document.querySelector('input').focus();true` });
    await measure('unwatched', false);
    await measure('watched', true);
    await measure('hidden', false);
    await runtime.insertText('input without frame capture');
    const value = await runtime.evaluate({ expression: 'document.querySelector("input").value' });
    assert.equal(value.result, 'input without frame capture');
    const screenshot = await runtime.screenshot();
    assert(screenshot, 'one-shot screenshots must remain available while unwatched');
    const previousTabs = tabsObserved;
    await runtime.evaluate({ expression: 'window.open("about:blank"); true' });
    for (let attempt = 0; tabsObserved === previousTabs && attempt < 100; attempt++) await wait(25);
    assert(tabsObserved > previousTabs, 'popup observation must survive without a Viewer');
    assert.equal((await runtime.listTabs()).length, 2);
    await runtime.switchTab(initialTab);
    await measure('reshown', true);
    await runtime.setViewerActive(false);
    await wait(500);
    assert.deepEqual(failures, []);

    // Model abrupt loss of the daemon before Config stop/recovery. Chrome's
    // separate group must still be discoverable from durable exact ownership.
    const daemon = runtime.processIdentity;
    assert(daemon && matchingProcessIdentity(daemon, readServerProcessIdentity(daemon.pid)));
    runtime.closedByOwner = true;
    stoppedAbruptly = true;
    process.kill(-daemon.processGroupId, 'SIGKILL');
    await wait(100);
    assert((await processes()).some(row => row.command.includes(`--user-data-dir=${profileDir} `)),
      'fixture must exercise the independent Chrome process group');
    const result = await hardStopConfigProcesses(root);
    assert.equal(result.refused, 0);
    assert(result.stopped >= 1);
    assert(!(await processes()).some(row => row.command.includes(`--user-data-dir=${profileDir} `)),
      'Config hard stop must remove Chrome after daemon loss');
    console.log('Browser idle, input, popup, resubscribe and abrupt-daemon-loss smoke passed');
  } finally {
    if (!stoppedAbruptly) await runtime.close().catch(error => console.error('Runtime cleanup:', error));
    // Failure cleanup is scoped to this unique fixture, including a launch
    // interrupted before the Runtime could publish its durable identity.
    const rows = await processes();
    const owned = new Set(rows.filter(row => row.command.includes(`--user-data-dir=${profileDir} `)).map(row => row.pid));
    if (runtime.processIdentity && matchingProcessIdentity(runtime.processIdentity, readServerProcessIdentity(runtime.processIdentity.pid))) {
      owned.add(runtime.processIdentity.pid);
    }
    for (let changed = true; changed;) {
      changed = false;
      for (const row of rows) if (owned.has(row.parent) && !owned.has(row.pid)) { owned.add(row.pid); changed = true; }
    }
    const identities = [...owned].map(pid => readServerProcessIdentity(pid)).filter(identity => identity !== null);
    for (const identity of identities) {
      if (!matchingProcessIdentity(identity, readServerProcessIdentity(identity.pid))) continue;
      try { process.kill(identity.pid, 'SIGKILL'); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') console.error('Fixture cleanup failed:', error);
      }
    }
    await wait(100);
    assert(!(await processes()).some(row => row.command.includes(`--user-data-dir=${profileDir} `)), 'fixture leaked Chrome');
    fs.rmSync(root, { recursive: true, force: true });
    if (previousSockets === undefined) delete process.env.AGENT_BROWSER_SOCKET_DIR;
    else process.env.AGENT_BROWSER_SOCKET_DIR = previousSockets;
  }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
