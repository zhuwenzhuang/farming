#!/usr/bin/env -S npx tsx
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as esbuild from 'esbuild';

const projectRoot = path.join(__dirname, '..');
const expectedVersion = '0.0.34';
const expectedSdkVersion = '0.26.0';
const expectedZodVersion = '4.6.7';
const expectedUpstreamSha256 = '324aeb8bba1228937e16b1326fb3e014e2a625b2dea549dbcd49b006cd5df6a2';
const expectedBundleSha256 = '7b56b4820d7739e877b8ad96b2a045e2b57ddaf45ec6c637412d37c43b3abd10';
const packageRoot = path.dirname(require.resolve('pi-acp/package.json'));
const packageJsonPath = path.join(packageRoot, 'package.json');
const sourceEntry = path.join(packageRoot, 'dist', 'index.js');
const sourceLicense = path.join(packageRoot, 'LICENSE');
const sdkPackageJsonPath = require.resolve('@agentclientprotocol/sdk/package.json', { paths: [packageRoot] });
const sdkLicense = path.join(path.dirname(sdkPackageJsonPath), 'LICENSE');
const zodPackageJsonPath = require.resolve('zod/package.json', { paths: [projectRoot] });
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
      // The protocol imports Zod v4; bind its reviewed validator independently
      // of the adapter package's legacy dependency range.
      build.onResolve({ filter: /^zod(?:\/|$)/ }, args => {
        if (!args.importer.startsWith(`${packageRoot}${path.sep}`)) return;
        return build.resolve(args.path, { kind: args.kind, resolveDir: projectRoot });
      });
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
          'return { sessionUpdate: "usage_update", used, size };',
          [
            'const amount = Number(stats?.cost);',
            '  return { sessionUpdate: "usage_update", used, size,',
            '    ...Number.isFinite(amount) && amount >= 0',
            '      ? { cost: { amount, currency: "USD" } }',
            '      : {}',
            '  };',
          ].join('\n  '),
          'ACP usage cost',
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
        source = replaceExactly(
          source,
          [
            '  async prompt(message, images = []) {',
            '    const res = await this.request({ type: "prompt", message, images });',
            '    if (!res.success) throw new Error(`pi prompt failed: ${res.error ?? JSON.stringify(res.data)}`);',
            '  }',
          ].join('\n'),
          [
            '  async prompt(message, images = []) {',
            '    const res = await this.request({ type: "prompt", message, images });',
            '    if (!res.success) throw new Error(`pi prompt failed: ${res.error ?? JSON.stringify(res.data)}`);',
            '  }',
            '  async steer(message, images = []) {',
            '    const res = await this.request({ type: "steer", message, images });',
            '    if (!res.success) throw new Error(`pi steer failed: ${res.error ?? JSON.stringify(res.data)}`);',
            '  }',
          ].join('\n'),
          'Pi RPC steer request',
        );
        source = replaceExactly(
          source,
          [
            '  inAgentLoop = false;',
            '  // For ACP diff support: capture file contents before edit/write mutations,',
          ].join('\n'),
          [
            '  inAgentLoop = false;',
            '  turnSteerable = false;',
            '  lastTurnError = null;',
            '  // For ACP diff support: capture file contents before edit/write mutations,',
          ].join('\n'),
          'Pi session steering and error state fields',
        );
        source = replaceExactly(
          source,
          [
            '  async cancel() {',
            '    this.cancelRequested = true;',
          ].join('\n'),
          [
            '  async steer(message, images = [], idleBehavior = "") {',
            '    if (!this.pendingTurn || !this.turnSteerable || this.cancelRequested) {',
            '      if (idleBehavior === "promptRequired") {',
            '        return { outcome: "promptRequired", reason: "noRunningTurn" };',
            '      }',
            '      throw RequestError2.invalidParams("No active Pi turn to steer");',
            '    }',
            '    const expandedMessage = expandSlashCommand(message, this.fileCommands);',
            '    await this.proc.steer(expandedMessage, images);',
            '    return { outcome: "injected" };',
            '  }',
            '  async cancel() {',
            '    this.cancelRequested = true;',
            '    this.turnSteerable = false;',
          ].join('\n'),
          'Pi session steer method',
        );
        source = replaceExactly(
          source,
          [
            '  async settleTurn() {',
            '    await this.publishContextUsage();',
            '    const reason = this.cancelRequested ? "cancelled" : "end_turn";',
            '    this.pendingTurn?.resolve(reason);',
            '    this.pendingTurn = null;',
            '    this.inAgentLoop = false;',
          ].join('\n'),
          [
            '  async settleTurn() {',
            '    await this.publishContextUsage();',
            '    const turnError = !this.cancelRequested ? this.lastTurnError : null;',
            '    this.lastTurnError = null;',
            '    this.turnSteerable = false;',
            '    if (turnError) {',
            '      const authErr = maybeAuthRequiredError(turnError);',
            '      this.pendingTurn?.reject(authErr ?? RequestError2.internalError({}, turnError));',
            '    } else {',
            '      const reason = this.cancelRequested ? "cancelled" : "end_turn";',
            '      this.pendingTurn?.resolve(reason);',
            '    }',
            '    this.pendingTurn = null;',
            '    this.inAgentLoop = false;',
          ].join('\n'),
          'Pi session settleTurn error propagation',
        );
        source = replaceExactly(
          source,
          [
            '  startTurn(t) {',
            '    this.cancelRequested = false;',
            '    this.inAgentLoop = false;',
            '    this.pendingTurn = { resolve: t.resolve, reject: t.reject };',
          ].join('\n'),
          [
            '  startTurn(t) {',
            '    this.cancelRequested = false;',
            '    this.inAgentLoop = false;',
            '    this.turnSteerable = true;',
            '    this.lastTurnError = null;',
            '    this.pendingTurn = { resolve: t.resolve, reject: t.reject };',
          ].join('\n'),
          'Pi session startTurn state reset',
        );
        source = replaceExactly(
          source,
          [
            '    switch (type) {',
            '      case "message_update": {',
            '        const ame = ev.assistantMessageEvent;',
            '        if (ame?.type === "text_delta" && typeof ame.delta === "string") {',
          ].join('\n'),
          [
            '    switch (type) {',
            '      case "message_end": {',
            '        const msg = ev.message;',
            '        if (msg && typeof msg === "object" && msg.role === "assistant") {',
            '          if (msg.stopReason === "error") {',
            '            const errText = typeof msg.errorMessage === "string" && msg.errorMessage.trim()',
            '              ? msg.errorMessage.trim()',
            '              : "Pi turn failed";',
            '            this.lastTurnError = errText;',
            '          } else {',
            '            this.lastTurnError = null;',
            '          }',
            '        }',
            '        break;',
            '      }',
            '      case "message_update": {',
            '        this.lastTurnError = null;',
            '        const ame = ev.assistantMessageEvent;',
            '        if (ame?.type === "text_delta" && typeof ame.delta === "string") {',
          ].join('\n'),
          'Pi session message_end error tracking',
        );
        source = replaceExactly(
          source,
          [
            '      case "auto_retry_end": {',
            '        this.emit({',
            '          sessionUpdate: "agent_message_chunk",',
            '          content: { type: "text", text: "Retry finished, resuming." }',
            '        });',
            '        break;',
            '      }',
          ].join('\n'),
          [
            '      case "auto_retry_end": {',
            '        if (ev.success === false) {',
            '          const finalError = typeof ev.finalError === "string" && ev.finalError.trim()',
            '            ? ev.finalError.trim()',
            '            : this.lastTurnError || "Retry failed.";',
            '          this.lastTurnError = finalError;',
            '          break;',
            '        }',
            '        this.lastTurnError = null;',
            '        this.emit({',
            '          sessionUpdate: "agent_message_chunk",',
            '          content: { type: "text", text: "Retry finished, resuming." }',
            '        });',
            '        break;',
            '      }',
          ].join('\n'),
          'Pi session auto_retry_end failure handling',
        );
        source = replaceExactly(
          source,
          [
            '      case "agent_start": {',
            '        this.inAgentLoop = true;',
            '        break;',
            '      }',
            '      case "turn_end": {',
            '        break;',
            '      }',
            '      case "agent_end": {',
            '        this.inAgentLoop = false;',
            '        break;',
            '      }',
          ].join('\n'),
          [
            '      case "agent_start": {',
            '        this.inAgentLoop = true;',
            '        this.turnSteerable = true;',
            '        break;',
            '      }',
            '      case "turn_end": {',
            '        break;',
            '      }',
            '      case "agent_end": {',
            '        this.inAgentLoop = false;',
            '        if (!ev.willRetry) this.turnSteerable = false;',
            '        break;',
            '      }',
          ].join('\n'),
          'Pi session agent_start/agent_end steerable window',
        );
        source = replaceExactly(
          source,
          [
            '        sessionCapabilities: {',
            '          // **UNSTABLE** ACP capability used by Zed\'s codex-acp adapter.',
            '          // Enables a native session picker in clients that support it.',
            '          list: {},',
            '          delete: {}',
            '        }',
            '      }',
            '    };',
          ].join('\n'),
          [
            '        sessionCapabilities: {',
            '          // **UNSTABLE** ACP capability used by Zed\'s codex-acp adapter.',
            '          // Enables a native session picker in clients that support it.',
            '          list: {},',
            '          delete: {}',
            '        }',
            '      },',
            '      _meta: {',
            '        steering: {',
            '          supported: true',
            '        }',
            '      }',
            '    };',
          ].join('\n'),
          'Pi ACP initialize steering capability',
        );
        source = replaceExactly(
          source,
          [
            '  async cancel(params) {',
            '    const session = this.sessions.maybeGet(params.sessionId);',
            '    if (!session) return;',
            '    await session.cancel();',
            '  }',
          ].join('\n'),
          [
            '  async extMethod(method, params) {',
            '    if (method !== "_session/steering") {',
            '      throw RequestError3.methodNotFound(method);',
            '    }',
            '    const sessionId = typeof params?.sessionId === "string" ? params.sessionId : "";',
            '    if (!sessionId) {',
            '      throw RequestError3.invalidParams("Missing sessionId");',
            '    }',
            '    const idleBehavior = typeof params?._meta?.steering?.idleBehavior === "string"',
            '      ? params._meta.steering.idleBehavior',
            '      : "";',
            '    const session = this.sessions.maybeGet(sessionId);',
            '    if (!session) {',
            '      if (idleBehavior === "promptRequired") {',
            '        return { outcome: "promptRequired", reason: "noRunningTurn" };',
            '      }',
            '      throw RequestError3.invalidParams("No active Pi turn to steer");',
            '    }',
            '    const promptBlocks = Array.isArray(params?.prompt) ? params.prompt : [];',
            '    const { message, images } = promptToPiMessage(promptBlocks);',
            '    return await session.steer(message, images, idleBehavior);',
            '  }',
            '  async cancel(params) {',
            '    const session = this.sessions.maybeGet(params.sessionId);',
            '    if (!session) return;',
            '    await session.cancel();',
            '  }',
          ].join('\n'),
          'Pi ACP extMethod steering handler',
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
      banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
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
