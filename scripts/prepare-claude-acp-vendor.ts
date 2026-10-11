#!/usr/bin/env -S npx tsx
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as esbuild from 'esbuild';

const projectRoot = path.join(__dirname, '..');
const expectedVersion = '0.89.1';
const expectedSdkVersion = '0.3.293';
const expectedBundleSha256 = '391074b6d589cd57082bd7d5863a03f79017beed4c0ee0df190364f8ff9ff523';
const packageRoot = path.dirname(require.resolve('@agentclientprotocol/claude-agent-acp/package.json'));
const packageJsonPath = path.join(packageRoot, 'package.json');
const sdkEntry = require.resolve('@anthropic-ai/claude-agent-sdk', {
  paths: [packageRoot],
});
const sdkPackageJsonPath = path.join(path.dirname(sdkEntry), 'package.json');
const acpAgentEntry = path.join(packageRoot, 'dist', 'acp-agent.js');
const sourceLicense = path.join(packageRoot, 'LICENSE');
const sdkLicense = path.join(path.dirname(sdkPackageJsonPath), 'LICENSE.md');
const targetDirectory = path.join(projectRoot, 'dist', 'acp');
const targetEntry = path.join(targetDirectory, `claude-agent-acp-${expectedVersion}.mjs`);
const targetLicense = path.join(targetDirectory, 'LICENSE.claude-agent-acp');
const targetSdkLicense = path.join(targetDirectory, 'LICENSE.claude-agent-sdk');
const executableFunctionStart = 'export async function claudeCliPath() {';
const executableFunctionEnd = 'function isMuslLibc() {';
const upstreamDeleteMethod = [
  '    async deleteSession(params) {',
  '        return this.sessionIndex.deleteSession(params);',
  '    }',
].join('\n');

function sha256(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function assertPackageVersion(packageJsonPathValue: string, expected: string, label: string): void {
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPathValue, 'utf8'));
  if (packageJson.version !== expected) {
    throw new Error(`Expected ${label} ${expected}, found ${packageJson.version}`);
  }
}

function farmingClaudePlugin(): esbuild.Plugin {
  return {
    name: 'farming-claude-executable',
    setup(build) {
      build.onLoad({ filter: /.*/ }, args => {
        if (path.resolve(args.path) === path.resolve(acpAgentEntry)) {
          const source = fs.readFileSync(args.path, 'utf8');
          const start = source.indexOf(executableFunctionStart);
          const end = source.indexOf(executableFunctionEnd);
          if (start < 0 || end <= start || source.indexOf(executableFunctionStart, start + 1) >= 0) {
            throw new Error('Expected one reviewed Claude executable resolver');
          }
          let executableSource = source.slice(0, start)
              + [
                'export async function claudeCliPath() {',
                '    if (process.env.CLAUDE_CODE_EXECUTABLE) {',
                '        return process.env.CLAUDE_CODE_EXECUTABLE;',
                '    }',
                '    throw new Error("CLAUDE_CODE_EXECUTABLE is required by Farming packaged Claude ACP");',
                '}',
                '',
              ].join('\n')
              + source.slice(end);
          const liveAnchor = '                    case "assistant": {\n';
          const replayAnchor = '            if (pending?.stopped || isReplayHiddenMetaMessage(message)) {\n';
          if (executableSource.split(liveAnchor).length !== 2 || executableSource.split(replayAnchor).length !== 2) {
            throw new Error('Expected reviewed Claude live and replay message boundaries');
          }
          executableSource = executableSource.replace(liveAnchor, liveAnchor + [
            '                        const peerUpdate = farmingClaudePeerUpdate(message);',
            '                        if (peerUpdate) {',
            '                            await sendUpdate({ sessionId: params.sessionId, update: peerUpdate });',
            '                            break;',
            '                        }',
            '',
          ].join('\n')).replace(replayAnchor, [
            '            if (pending?.stopped) return;',
            '            const peerUpdate = farmingClaudePeerUpdate(message);',
            '            if (peerUpdate) {',
            '                const parent = parentToolUseIdOf(message);',
            '                const target = nativeReplayEnabled && parent ? await announceReplayChild(parent) : sessionId;',
            '                await this.client.sessionUpdate({ sessionId: target, update: peerUpdate });',
            '                return;',
            '            }',
            replayAnchor,
          ].join('\n'));
          // Farming uses explicit session/delete for owned failed-Fork cleanup.
          // AIR's new archive-instead-of-delete compatibility behavior would
          // retain the failed session while reporting successful deletion.
          if (executableSource.split(upstreamDeleteMethod).length !== 2) {
            throw new Error('Expected one reviewed Claude session/delete implementation');
          }
          return {
            contents: 'import { deleteSession as farmingDeleteSession } from "@anthropic-ai/claude-agent-sdk";\n'
              + `import { farmingClaudePeerUpdate } from ${JSON.stringify(path.join(projectRoot, 'scripts/vendor/claude-peer-messages.mjs'))};\n`
              + executableSource.replace(upstreamDeleteMethod, [
                '    async deleteSession(params) {',
                '        if (this.sessions[params.sessionId]) {',
                '            await this.teardownSession(params.sessionId);',
                '        }',
                '        await farmingDeleteSession(params.sessionId);',
                '        return {};',
                '    }',
              ].join('\n')),
            loader: 'js',
          };
        }
        return null;
      });
    },
  };
}

async function prepareClaudeAcpVendor({ copy = false } = {}): Promise<void> {
  assertPackageVersion(packageJsonPath, expectedVersion, '@agentclientprotocol/claude-agent-acp');
  assertPackageVersion(sdkPackageJsonPath, expectedSdkVersion, '@anthropic-ai/claude-agent-sdk');
  if (!copy) return;

  fs.mkdirSync(targetDirectory, { recursive: true });
  const temporaryEntry = `${targetEntry}.${process.pid}.${Date.now()}.tmp`;
  try {
    await esbuild.build({
      absWorkingDir: packageRoot,
      entryPoints: ['dist/index.js'],
      outfile: temporaryEntry,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      minify: false,
      legalComments: 'none',
      sourcemap: false,
      plugins: [farmingClaudePlugin()],
    });
    const actualSha256 = sha256(temporaryEntry);
    if (actualSha256 !== expectedBundleSha256) {
      throw new Error(
        `Refusing unreviewed Claude ACP bundle bytes: expected ${expectedBundleSha256}, found ${actualSha256}`,
      );
    }
    fs.renameSync(temporaryEntry, targetEntry);
  } finally {
    fs.rmSync(temporaryEntry, { force: true });
  }
  fs.copyFileSync(sourceLicense, targetLicense);
  fs.copyFileSync(sdkLicense, targetSdkLicense);
  console.log(`Prepared version-locked Claude ACP runtime at ${targetEntry}`);
}

prepareClaudeAcpVendor({ copy: process.argv.includes('--copy') }).catch(error => {
  console.error((error as Error).message || error);
  process.exitCode = 1;
});
