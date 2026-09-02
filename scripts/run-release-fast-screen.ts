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
    name: 'native PTY socket publication ownership',
    args: ['--import', 'tsx', 'backend/tests/test-native-pty-publication.ts'],
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
    name: 'release workflow artifact reuse',
    args: ['--import', 'tsx', 'backend/tests/test-release-workflow.ts'],
  },
  {
    name: 'release package identity',
    args: ['--import', 'tsx', 'backend/tests/test-cli-release-packaging.ts'],
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
    name: 'shared Codex ACP replacement',
    args: ['--import', 'tsx', 'backend/tests/test-acp-shared-codex-adapter.ts'],
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
