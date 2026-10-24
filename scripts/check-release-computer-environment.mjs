#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const runtimeRoots = ['backend', 'extensions/browser/backend', 'extensions/computer/backend',
  'extensions/language-server/backend', 'extensions/shared-config/backend', 'extensions/a2a/backend'];
const excluded = new Set(['tests', 'types', 'vendor']);
function runtimeSources(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const filename = path.join(directory, entry.name);
    return entry.isDirectory() ? (excluded.has(entry.name) ? [] : runtimeSources(filename))
      : entry.name.endsWith('.cts') ? [filename] : [];
  });
}
const digest = filename => crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');

// This is an environment receipt, never Computer Use acceptance. No server,
// Resource, Desktop, PTY session, browser, image pull, or private config is created.
export function checkComputerEnvironment({ root, candidateSha, image }, {
  platform = process.platform, arch = process.arch,
  env = process.env,
  execute = (command, args, options) => execFileSync(command, args, {
    encoding: 'utf8', timeout: 2_000, maxBuffer: 128 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'], ...options,
  }),
} = {}) {
  const startedAt = new Date().toISOString();
  const failures = [];
  const facts = {};
  const check = (signature, operation) => {
    try { operation(); } catch { failures.push(signature); }
  };
  if (!/^[a-f0-9]{40}$/.test(candidateSha || '')) failures.push('CU_CANDIDATE_SHA_INVALID');
  if (platform !== 'linux' || !['x64', 'arm64'].includes(arch)) failures.push('CU_LINUX_RUNTIME_REQUIRED');
  if (!/^\S+@sha256:[a-f0-9]{64}$/.test(image || '') || image.startsWith('-')) {
    failures.push('CU_PINNED_IMAGE_REQUIRED');
  }
  if (failures.length === 0) {
    const require = createRequire(path.join(path.resolve(root), 'package.json'));
    check('CU_CANDIDATE_IDENTITY_MISMATCH', () => {
      const releaseFile = path.join(root, 'RELEASE.json');
      if (fs.existsSync(releaseFile)) {
        const release = JSON.parse(fs.readFileSync(releaseFile, 'utf8'));
        if (release.type !== 'app-bundle' || release.dirty !== false
          || release.platform !== 'linux' || release.arch !== arch || release.gitSha !== candidateSha) throw Error();
        facts.inputKind = 'app-bundle';
      } else {
        if (execute('git', ['-C', root, 'rev-parse', 'HEAD']).trim() !== candidateSha
          || execute('git', ['-C', root, 'status', '--porcelain', '--untracked-files=no']).trim()) throw Error();
        facts.inputKind = 'clean-source';
      }
      facts.packageLockSha256 = digest(path.join(root, 'package-lock.json'));
    });
    check('CU_GENERATED_RUNTIME_MISSING_OR_STALE', () => {
      const sources = runtimeRoots.flatMap(directory => runtimeSources(path.join(root, directory)));
      for (const filename of sources) {
        const generated = filename.slice(0, -4) + '.cjs';
        fs.accessSync(generated, fs.constants.R_OK);
        // App bundles have verified generated outputs, without source maps.
        if (facts.inputKind === 'clean-source') {
          const map = JSON.parse(fs.readFileSync(generated + '.map', 'utf8'));
          if (!map.sourcesContent?.includes(fs.readFileSync(filename, 'utf8'))) throw Error();
        }
      }
      for (const filename of ['bin/farming', 'dist/index.html', 'backend/usage-history-scanner.generated.js',
        'backend/data/runtime-dependency-manifest.json', 'extensions/computer/backend/index.cjs',
        'extensions/computer/backend/cua-tools.json']) fs.accessSync(path.join(root, filename), fs.constants.R_OK);
      const owner = require(path.join(path.resolve(root), 'backend/native-pty-host-identity.cjs'));
      for (const filename of owner.NATIVE_PTY_HOST_RUNTIME_FILES) fs.accessSync(path.join(root, 'backend', filename));
      facts.nativePtyBuildId = owner.nativePtyHostRuntimeIdentity(path.join(root, 'backend')).buildId;
      if (!/^[a-f0-9]{64}$/.test(facts.nativePtyBuildId || '')) throw Error();
    });
    check('CU_MANAGED_RIPGREP_MISSING_OR_WRONG_VERSION', () => {
      const owner = require(path.join(path.resolve(root), 'backend/ripgrep-runtime.cjs'));
      const executable = path.join(root, owner.managedRipgrepRelativePath(`linux-${arch}`));
      fs.accessSync(executable, fs.constants.R_OK | fs.constants.X_OK);
      const actual = execute(executable, ['--version']).split(/\r?\n/, 1)[0];
      if (actual !== `ripgrep ${owner.MANAGED_RIPGREP_VERSION}`
        && !actual.startsWith(`ripgrep ${owner.MANAGED_RIPGREP_VERSION} `)) throw Error();
      facts.ripgrepVersion = owner.MANAGED_RIPGREP_VERSION;
      facts.ripgrepSha256 = digest(executable);
    });
    check('CU_CHILD_NODE_OR_NATIVE_PTY_LOAD_FAILED', () => {
      // ACP fixture launches process.execPath. Probe that same child boundary;
      // a working parent launched under a private loader does not prove this.
      const probe = 'const [a,b]=process.versions.node.split(".").map(Number);'
        + 'if(!((a===22&&b>=13)||a>=23))process.exit(2);'
        + 'if(typeof require(process.argv[1]).nodePty?.spawn!=="function")process.exit(3);'
        + 'process.stdout.write(process.versions.node);';
      const childEnv = { ...env, FARMING_PACKAGED_RUNTIME: '0' };
      delete childEnv.FARMING_CONFIG_DIR;
      const runtimeRequire = createRequire(path.join(path.resolve(root), 'package.json'));
      const { runtimeExecutableInvocation } = runtimeRequire('./backend/runtime-executable-invocation.cjs');
      const nodePath = childEnv.FARMING_NODE_BIN || process.execPath;
      const invocation = runtimeExecutableInvocation(nodePath,
        ['-e', probe, path.join(path.resolve(root), 'backend/packaged-node-pty.cjs')], childEnv, platform);
      const version = execute(invocation.command, invocation.args, { cwd: root, env: childEnv }).trim();
      if (!/^\d+\.\d+\.\d+$/.test(version)) throw Error();
      facts.childNodeVersion = version;
    });
    check('CU_DOCKER_UNAVAILABLE', () => {
      const info = JSON.parse(execute('docker', ['info', '--format', '{{json .}}']));
      if (info.OSType !== 'linux' || !Number.isInteger(info.NCPU) || info.NCPU < 1) throw Error();
      facts.cpus = info.NCPU;
    });
    check('CU_PINNED_IMAGE_NOT_WARM', () => {
      const inspected = JSON.parse(execute('docker', ['image', 'inspect', image]))[0];
      if (!/^sha256:[a-f0-9]{64}$/.test(inspected?.Id)
        || !inspected.RepoDigests?.includes(image) || inspected.Os !== 'linux'
        || inspected.Architecture !== ({ x64: 'amd64', arm64: 'arm64' })[arch]) throw Error();
      facts.imageId = inspected.Id;
      facts.imageDigest = image.slice(image.lastIndexOf('@') + 1);
    });
  }
  return { schemaVersion: 1, kind: 'release-computer-environment', candidateSha: /^[a-f0-9]{40}$/.test(candidateSha || '') ? candidateSha : null,
    startedAt, completedAt: new Date().toISOString(), status: failures.length ? 'blocked' : 'ready',
    facts, failures, scope: 'Environment only; owned Resource, browser profile, foreground screenshot and scenario acceptance remain separate.' };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 3) {
    console.error('Usage: node scripts/check-release-computer-environment.mjs ROOT FULL_SHA PINNED_IMAGE');
    process.exitCode = 2;
  } else {
    const receipt = checkComputerEnvironment({ root: path.resolve(args[0]), candidateSha: args[1], image: args[2] });
    console.log(JSON.stringify(receipt, null, 2));
    process.exitCode = receipt.status === 'ready' ? 0 : 1;
  }
}
