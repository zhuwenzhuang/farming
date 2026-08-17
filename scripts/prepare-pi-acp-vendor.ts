#!/usr/bin/env -S npx tsx
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as esbuild from 'esbuild';

const projectRoot = path.join(__dirname, '..');
const expectedVersion = '0.0.33';
const expectedSdkVersion = '0.26.0';
const expectedZodVersion = '3.25.76';
const expectedUpstreamSha256 = '24ff73fda6e3c76ddce2d359a79f5c4b8f292eb290e4d2ab85aac94676b2c2dc';
const expectedBundleSha256 = 'a750044ca2135463763d373c49744031aa1e9ff08f77011f1626156e3b4c8981';
const packageRoot = path.dirname(require.resolve('pi-acp/package.json'));
const packageJsonPath = path.join(packageRoot, 'package.json');
const sourceEntry = path.join(packageRoot, 'dist', 'index.js');
const sourceLicense = path.join(packageRoot, 'LICENSE');
const sdkPackageJsonPath = require.resolve('@agentclientprotocol/sdk/package.json', { paths: [packageRoot] });
const sdkLicense = path.join(path.dirname(sdkPackageJsonPath), 'LICENSE');
const zodPackageJsonPath = require.resolve('zod/package.json', { paths: [packageRoot] });
const zodLicense = path.join(path.dirname(zodPackageJsonPath), 'LICENSE');
const targetDirectory = path.join(projectRoot, 'dist', 'acp');
const targetEntry = path.join(targetDirectory, `pi-acp-${expectedVersion}.mjs`);
const targetLicense = path.join(targetDirectory, 'LICENSE.pi-acp');
const targetSdkLicense = path.join(targetDirectory, 'LICENSE.pi-acp-sdk');
const targetZodLicense = path.join(targetDirectory, 'LICENSE.pi-acp-zod');

function sha256(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function assertPackageVersion(packageJsonPathValue: string, expected: string, label: string): void {
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPathValue, 'utf8'));
  if (packageJson.version !== expected) {
    throw new Error(`Expected ${label} ${expected}, found ${packageJson.version}`);
  }
}

function replaceExactly(source: string, before: string, after: string, label: string): string {
  const occurrences = source.split(before).length - 1;
  if (occurrences !== 1) {
    throw new Error(`Expected one reviewed Pi ACP ${label} marker, found ${occurrences}`);
  }
  return source.replace(before, after);
}

function replaceCounted(
  source: string,
  before: string,
  after: string,
  expectedOccurrences: number,
  label: string,
): string {
  const occurrences = source.split(before).length - 1;
  if (occurrences !== expectedOccurrences) {
    throw new Error(
      `Expected ${expectedOccurrences} reviewed Pi ACP ${label} markers, found ${occurrences}`,
    );
  }
  return source.split(before).join(after);
}

function farmingPiPlugin(): esbuild.Plugin {
  return {
    name: 'farming-pi-acp-isolation',
    setup(build) {
      build.onLoad({ filter: /.*/ }, args => {
        if (path.resolve(args.path) !== path.resolve(sourceEntry)) return null;
        let source = fs.readFileSync(args.path, 'utf8');
        const farmingLaunchOptions = [
          'function farmingOptionValue(name) {',
          '  const index = process.argv.indexOf(name);',
          '  return index >= 0 ? String(process.argv[index + 1] || "") : "";',
          '}',
          'const farmingPiCommand = farmingOptionValue("--farming-pi-command");',
          'const farmingPiAcpStateDir = farmingOptionValue("--farming-pi-acp-state-dir");',
          'const farmingAppendSystemPrompt = farmingOptionValue("--farming-append-system-prompt");',
        ].join('\n');
        source = replaceExactly(
          source,
          '#!/usr/bin/env node\n',
          `#!/usr/bin/env node\n${farmingLaunchOptions}\n`,
          'private launch options',
        );
        source = replaceExactly(
          source,
          'import * as readline from "readline";',
          'import { StringDecoder } from "string_decoder";',
          'strict LF decoder import',
        );
        source = replaceExactly(
          source,
          '    const rl = readline.createInterface({ input: child.stdout });\n    rl.on("line", (line) => {',
          [
            '    const stdoutDecoder = new StringDecoder("utf8");',
            '    let stdoutBuffer = "";',
            '    const handleLine = (line) => {',
          ].join('\n'),
          'strict LF line handler',
        );
        source = replaceExactly(
          source,
          '    });\n    child.on("exit", (code, signal) => {',
          [
            '    };',
            '    const drainStdout = () => {',
            '      for (;;) {',
            '        const newline = stdoutBuffer.indexOf("\\n");',
            '        if (newline < 0) return;',
            '        const line = stdoutBuffer.slice(0, newline).replace(/\\r$/, "");',
            '        stdoutBuffer = stdoutBuffer.slice(newline + 1);',
            '        handleLine(line);',
            '      }',
            '    };',
            '    child.stdout.on("data", (chunk) => {',
            '      stdoutBuffer += typeof chunk === "string" ? chunk : stdoutDecoder.write(chunk);',
            '      drainStdout();',
            '    });',
            '    child.stdout.on("end", () => {',
            '      stdoutBuffer += stdoutDecoder.end();',
            '      if (stdoutBuffer) handleLine(stdoutBuffer.replace(/\\r$/, ""));',
            '      stdoutBuffer = "";',
            '    });',
            '    child.on("exit", (code, signal) => {',
          ].join('\n'),
          'strict LF stream framing',
        );
        source = replaceExactly(
          source,
          'const args = ["--mode", "rpc", "--no-themes"];',
          [
            'const args = ["--mode", "rpc", "--no-themes"];',
            '    const farmingSystemPrompt = farmingAppendSystemPrompt.trim();',
            '    if (farmingSystemPrompt) args.push("--append-system-prompt", farmingSystemPrompt);',
          ].join('\n'),
          'system prompt',
        );
        source = replaceExactly(
          source,
          'function getPiAcpDir() {\n  return join(homedir(), ".pi", "pi-acp");\n}',
          [
            'function getPiAcpDir() {',
            '  const configured = farmingPiAcpStateDir.trim();',
            '  return configured ? join(configured) : join(homedir(), ".pi", "pi-acp");',
            '}',
          ].join('\n'),
          'state directory',
        );
        source = replaceExactly(
          source,
          'var pkg = readNearestPackageJson(import.meta.url);',
          `var pkg = { name: "pi-acp", version: "${expectedVersion}" };`,
          'vendored package identity',
        );
        source = replaceExactly(
          source,
          'const userDir = join2(homedir2(), ".pi", "agent", "prompts");',
          [
            'const userAgentDir = process.env.PI_CODING_AGENT_DIR',
            '    ? resolve(process.env.PI_CODING_AGENT_DIR)',
            '    : join2(homedir2(), ".pi", "agent");',
            '  const userDir = join2(userAgentDir, "prompts");',
          ].join('\n  '),
          'prompt directory',
        );
        source = replaceCounted(
          source,
          'spawnSync("pi", ["--version"]',
          'spawnSync(getPiCommand(farmingPiCommand || undefined), ["--version"]',
          2,
          'Pi executable probe',
        );
        source = replaceCounted(
          source,
          'process.env.PI_ACP_PI_COMMAND',
          'farmingPiCommand || undefined',
          3,
          'Pi executable launch',
        );
        source = replaceExactly(
          source,
          [
            'function walkJsonlFiles(dir, out) {',
            '  let entries;',
            '  try {',
            '    entries = readdirSync2(dir, { withFileTypes: true, encoding: "utf8" });',
            '  } catch {',
            '    return;',
            '  }',
            '  for (const e of entries) {',
            '    const name = typeof e.name === "string" ? e.name : String(e.name);',
            '    const p = join3(dir, name);',
            '    if (e.isDirectory()) walkJsonlFiles(p, out);',
            '    else if (e.isFile() && name.endsWith(".jsonl")) out.push(p);',
            '  }',
            '}',
          ].join('\n'),
          [
            'function walkJsonlFiles(dir, out, depth = 0, state = { visited: 0 }) {',
            '  if (depth > 2 || state.visited >= 5000) return;',
            '  let entries;',
            '  try {',
            '    entries = readdirSync2(dir, { withFileTypes: true, encoding: "utf8" });',
            '  } catch {',
            '    return;',
            '  }',
            '  for (const e of entries) {',
            '    if (state.visited >= 5000) return;',
            '    state.visited += 1;',
            '    const name = typeof e.name === "string" ? e.name : String(e.name);',
            '    const p = join3(dir, name);',
            '    if (e.isDirectory()) walkJsonlFiles(p, out, depth + 1, state);',
            '    else if (e.isFile() && name.endsWith(".jsonl")) out.push(p);',
            '  }',
            '}',
          ].join('\n'),
          'bounded session scan',
        );
        source = replaceExactly(
          source,
          'if (!title) {\n      title = scanSessionInfoNameFromFile(file);\n    }',
          '// Farming keeps adapter-side history reads bounded; an old name may be omitted.',
          'full title scan removal',
        );
        source = replaceExactly(
          source,
          'if (!title) {\n      title = pickFallbackTitleFromHead(file);\n    }',
          '// Farming local History supplies a bounded first-prompt fallback.',
          'full prompt scan removal',
        );
        source = replaceExactly(
          source,
          'case "agent_settled": {\n        void this.flushEmits().finally(() => {',
          [
            'case "agent_settled": {',
            '        void this.flushEmits().then(async () => {',
            '          try {',
            '            const stats = await this.proc.getSessionStats();',
            '            const used = Number(stats?.contextUsage?.tokens);',
            '            const size = Number(stats?.contextUsage?.contextWindow);',
            '            if (Number.isFinite(used) && used >= 0 && Number.isFinite(size) && size > 0) {',
            '              const amount = Number(stats?.cost);',
            '              this.emit({',
            '                sessionUpdate: "usage_update",',
            '                used,',
            '                size,',
            '                ...Number.isFinite(amount) && amount >= 0',
            '                  ? { cost: { amount, currency: "USD" } }',
            '                  : {}',
            '              });',
            '              await this.flushEmits();',
            '            }',
            '          } catch {',
            '          }',
            '        }).finally(() => {',
          ].join('\n'),
          'ACP usage update',
        );
        source = replaceExactly(
          source,
          'return isAbsolute2(sessionDir) ? sessionDir : resolve2(agentDir, sessionDir);',
          'return isAbsolute2(sessionDir) ? sessionDir : false;',
          'relative session directory guard',
        );
        source = replaceExactly(
          source,
          'function getPiSessionsDir() {\n  const agentDir = getPiAgentDir();\n  return readSessionDirFromSettings(agentDir) ?? join3(agentDir, "sessions");\n}',
          [
            'function getPiSessionsDir() {',
            '  const agentDir = getPiAgentDir();',
            '  const configured = String(process.env.PI_CODING_AGENT_SESSION_DIR || "").trim();',
            '  const sessionDir = configured === "~"',
            '    ? homedir3()',
            '    : configured.startsWith("~/")',
            '      ? join3(homedir3(), configured.slice(2))',
            '      : configured',
            '        ? resolve2(configured)',
            '        : "";',
            '  if (sessionDir) return sessionDir;',
            '  const settingsSessionDir = readSessionDirFromSettings(agentDir);',
            '  if (settingsSessionDir === false) return null;',
            '  return settingsSessionDir ?? join3(agentDir, "sessions");',
            '}',
          ].join('\n'),
          'session directory',
        );
        return { contents: source, loader: 'js' };
      });
    },
  };
}

async function preparePiAcpVendor({ copy = false } = {}): Promise<void> {
  assertPackageVersion(packageJsonPath, expectedVersion, 'pi-acp');
  assertPackageVersion(sdkPackageJsonPath, expectedSdkVersion, '@agentclientprotocol/sdk');
  assertPackageVersion(zodPackageJsonPath, expectedZodVersion, 'zod');
  if (sha256(sourceEntry) !== expectedUpstreamSha256) {
    throw new Error(`Refusing unreviewed pi-acp ${expectedVersion} source bytes`);
  }
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
      plugins: [farmingPiPlugin()],
    });
    const actualSha256 = sha256(temporaryEntry);
    if (actualSha256 !== expectedBundleSha256) {
      throw new Error(
        `Refusing unreviewed Pi ACP bundle bytes: expected ${expectedBundleSha256}, found ${actualSha256}`,
      );
    }
    fs.renameSync(temporaryEntry, targetEntry);
  } finally {
    fs.rmSync(temporaryEntry, { force: true });
  }
  fs.copyFileSync(sourceLicense, targetLicense);
  fs.copyFileSync(sdkLicense, targetSdkLicense);
  fs.copyFileSync(zodLicense, targetZodLicense);
  console.log(`Prepared version-locked Pi ACP runtime at ${targetEntry}`);
}

preparePiAcpVendor({ copy: process.argv.includes('--copy') }).catch(error => {
  console.error((error as Error).message || error);
  process.exitCode = 1;
});
