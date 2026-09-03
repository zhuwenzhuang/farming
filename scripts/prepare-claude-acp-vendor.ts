#!/usr/bin/env -S npx tsx
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as esbuild from 'esbuild';

const projectRoot = path.join(__dirname, '..');
const expectedVersion = '0.73.0';
const expectedSdkVersion = '0.3.257';
const expectedBundleSha256 = '362921ce5205272f3f2255445db2fd7d60e85f9483e65da3e5916af5dd2517d7';
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
const executableFunctionEnd = 'function shouldHideClaudeAuth() {';

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
          return {
            contents: source.slice(0, start)
              + [
                'export async function claudeCliPath() {',
                '    if (process.env.CLAUDE_CODE_EXECUTABLE) {',
                '        return process.env.CLAUDE_CODE_EXECUTABLE;',
                '    }',
                '    throw new Error("CLAUDE_CODE_EXECUTABLE is required by Farming packaged Claude ACP");',
                '}',
                '',
              ].join('\n')
              + source.slice(end),
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
