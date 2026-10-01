#!/usr/bin/env -S npx tsx
import { spawn } from 'node:child_process';
import path from 'node:path';

interface FastScreenTask {
  name: string;
  args: string[];
}

const projectRoot = path.resolve(__dirname, '..');
const packageVersion = require(path.join(projectRoot, 'package.json')).version;
const tasks: FastScreenTask[] = [
  {
    name: 'cold Codex ACP patch-package installation',
    args: ['--import', 'tsx', '--test', 'tests/codex-acp-cold-install.test.ts'],
  },
  {
    name: 'Codex ACP upstream upgrade user input and session writer compatibility',
    args: ['--import', 'tsx', 'backend/tests/test-codex-acp-upgrade.ts'],
  },
  {
    name: 'Browser component provenance and candidate assembly fences',
    args: ['--import', 'tsx', '--test', 'tests/agent-browser-reuse.test.ts'],
  },
  {
    name: 'source-inspection contract registration',
    args: ['--import', 'tsx', 'scripts/check-source-inspection-contracts.ts'],
  },
  {
    name: 'Browser production build recipe and failed-test publication fence',
    args: ['--import', 'tsx', '--test', 'tests/agent-browser-build-recipe.test.ts'],
  },
  {
    name: 'persistent workflow observations and transport recovery',
    args: ['--import', 'tsx', '--test', 'tests/release-workflow-monitor.test.ts'],
  },
  {
    name: 'source and packaged Terminal Worker resolution',
    args: ['--import', 'tsx', 'backend/tests/test-terminal-screen-worker.ts'],
  },
  {
    name: 'bounded npm publication evidence and recovery',
    args: ['--import', 'tsx', '--test', 'tests/npm-release-evidence.test.ts'],
  },
  {
    name: 'authoritative release lineage',
    args: ['--import', 'tsx', '--test', 'tests/release-lineage.test.ts'],
  },
  {
    name: 'API route registration and access ordering',
    args: ['--import', 'tsx', 'backend/tests/test-server-route-manifest.ts'],
  },
  {
    name: 'shared UI design ownership',
    args: ['--import', 'tsx', 'backend/tests/test-ui-design-ownership.ts'],
  },
  {
    name: 'sidebar styles and shared workbench splitter ownership',
    args: ['--import', 'tsx', 'backend/tests/test-sidebar-style-ownership.ts'],
  },
  {
    name: 'native PTY socket publication ownership',
    args: ['--import', 'tsx', 'backend/tests/test-native-pty-publication.ts'],
  },
  {
    name: 'terminal checkpoint native and alternate buffer state',
    args: ['--import', 'tsx', 'backend/tests/test-terminal-screen-state.ts'],
  },
  {
    name: 'Codex Terminal model menu transaction',
    args: ['--import', 'tsx', 'backend/tests/test-codex-terminal-profile.ts'],
  },
  {
    name: 'Terminal uncertain input admission fence',
    args: ['--import', 'tsx', 'backend/tests/test-terminal-uncertain-input-fence.ts'],
  },
  {
    name: 'bounded Desktop command and download lifecycle',
    args: [
      '--import', 'tsx', '--test',
      '--test-name-pattern=local command completion cannot revive|remote bootstrap TERM cleans|desktop release download reports progress',
      'tests/desktop-backend.test.ts',
    ],
  },
  {
    name: 'managed dependency registry policy',
    args: ['scripts/check-release-managed-dependency-updates.mjs'],
  },
  {
    name: 'current bilingual release notes',
    args: ['scripts/verify-release-notes.mjs', packageVersion],
  },
  {
    name: 'CI runtime ownership and immutable Browser launch fixture',
    args: ['--import', 'tsx', 'backend/tests/test-ci-node-version-gate.ts'],
  },
  {
    name: 'release workflow artifact reuse',
    args: ['--import', 'tsx', 'backend/tests/test-release-workflow.ts'],
  },
  {
    name: 'script and fake-Agent harness type boundaries',
    args: ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.scripts-harness.json'],
  },
  {
    name: 'backend test type boundaries',
    args: ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.tests.json'],
  },
  {
    name: 'release package identity',
    args: ['--import', 'tsx', 'backend/tests/test-cli-release-packaging.ts'],
  },
  {
    name: 'Pi ACP fragmented UTF-8 record ownership',
    args: ['--import', 'tsx', 'backend/tests/test-pi-acp-vendor.ts'],
  },
  {
    name: 'app CLI and third-party dependency notices',
    args: ['--import', 'tsx', 'backend/tests/test-farming-app-cli.ts'],
  },
  {
    name: 'managed dependency policy tests',
    args: ['--import', 'tsx', 'backend/tests/test-release-managed-dependency-updates.ts'],
  },
  {
    name: 'release note format tests',
    args: ['--import', 'tsx', 'backend/tests/test-release-notes-format.ts'],
  },
  {
    name: 'Browser lifecycle regression',
    args: ['--import', 'tsx', 'backend/tests/test-browser-extension.ts'],
  },
  {
    name: 'Computer Browser relay concurrent clients',
    args: ['--import', 'tsx', 'backend/tests/test-computer-browser-relay.ts'],
  },
  {
    name: 'native hard-stop ownership regression',
    args: ['--import', 'tsx', 'backend/tests/test-config-process-hard-stop.ts'],
  },
  {
    name: 'shared Codex ACP replacement',
    args: ['--import', 'tsx', 'backend/tests/test-acp-shared-codex-adapter.ts'],
  },
  {
    name: 'AIR metadata provider boundary',
    args: ['--import', 'tsx', 'backend/tests/test-acp-session-provider-policy.ts'],
  },
  {
    name: 'Codex paginated image and steering history',
    args: ['--import', 'tsx', 'backend/tests/test-codex-acp-history-images.ts'],
  },
  {
    name: 'Codex large fragmented history transport',
    args: ['--import', 'tsx', 'backend/tests/test-codex-acp-large-history.ts'],
  },
  {
    name: 'ACP live Host controller reconnection',
    args: ['--import', 'tsx', 'backend/tests/test-acp-runtime-host-restart.ts'],
  },
  {
    name: 'Composer admission ordering and completed Turn fence',
    args: ['--import', 'tsx', 'backend/tests/test-composer-follow-up-controller.ts'],
  },
  {
    name: 'Workspace restoration admission and cancellation',
    args: ['--import', 'tsx', '--test', 'tests/workspace-request-admission.test.ts'],
  },
  {
    name: 'Workspace view persistence and bounded Transcript reads',
    args: ['--import', 'tsx', '--test', 'tests/workspace-view-state.test.ts', 'tests/acp-transcript-session-pool.test.ts'],
  },
];

async function runTask(task: FastScreenTask): Promise<{ name: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, task.args, {
      cwd: projectRoot,
      env: process.env,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) {
        console.error(`${task.name} ended from signal ${signal}`);
        resolve({ name: task.name, code: 1 });
        return;
      }
      resolve({ name: task.name, code: code ?? 1 });
    });
  });
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const results = await Promise.all(tasks.map(runTask));
  const failures = results.filter(result => result.code !== 0);
  const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(2);
  if (failures.length > 0) {
    throw new Error(
      `Release fast screen failed after ${elapsedSeconds}s: ${failures.map(result => result.name).join(', ')}`,
    );
  }
  console.log(`Release fast screen passed ${tasks.length} gates in ${elapsedSeconds}s.`);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
