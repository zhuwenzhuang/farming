const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const MANAGED_RIPGREP_VERSION = '15.2.0';

interface ManagedRipgrepArtifact {
  archiveName: string;
  sha256: string;
}

const MANAGED_RIPGREP_ARTIFACTS: Record<string, ManagedRipgrepArtifact> = {
  'darwin-arm64': {
    archiveName: `ripgrep-${MANAGED_RIPGREP_VERSION}-aarch64-apple-darwin.tar.gz`,
    sha256: '3750b2e93f37e0c692657da574d7019a101c0084da05a790c83fd335bad973e4',
  },
  'darwin-x64': {
    archiveName: `ripgrep-${MANAGED_RIPGREP_VERSION}-x86_64-apple-darwin.tar.gz`,
    sha256: 'af7825fcc69a2afc7a7aea55fc9af90e26421d8f20fe59df32e233c0b8a231c1',
  },
  'linux-arm64': {
    archiveName: `ripgrep-${MANAGED_RIPGREP_VERSION}-aarch64-unknown-linux-musl.tar.gz`,
    sha256: '800b1e7206afe799dfb5a6901f23147cfaabe0e52210538100f61e86e1740915',
  },
  'linux-x64': {
    archiveName: `ripgrep-${MANAGED_RIPGREP_VERSION}-x86_64-unknown-linux-musl.tar.gz`,
    sha256: '33e15bcf1624b25cdd2a55813a47a2f95dbe126268203e76aa6a585d1e7b149c',
  },
  'win32-arm64': {
    archiveName: `ripgrep-${MANAGED_RIPGREP_VERSION}-aarch64-pc-windows-msvc.zip`,
    sha256: 'e4abca10c3a64ebea742667dd7009449d49403db5460dd6873e389fa2945360f',
  },
  'win32-x64': {
    archiveName: `ripgrep-${MANAGED_RIPGREP_VERSION}-x86_64-pc-windows-msvc.zip`,
    sha256: '71b2fef860abe467217a538ff31de02f5258807c0129f771846f87bd029aafc5',
  },
};

function canonicalManagedRipgrepPlatform(platformKey: string): string {
  return platformKey.replace(/-musl$/, '');
}

function currentManagedRipgrepPlatform(): string {
  return canonicalManagedRipgrepPlatform(`${process.platform}-${process.arch}`);
}

function managedRipgrepFilename(platformKey: string): string {
  return canonicalManagedRipgrepPlatform(platformKey).startsWith('win32-') ? 'rg.exe' : 'rg';
}

function managedRipgrepRelativePath(platformKey: string): string {
  const canonicalPlatform = canonicalManagedRipgrepPlatform(platformKey);
  return path.join('dist', 'runtime', 'ripgrep', canonicalPlatform, managedRipgrepFilename(canonicalPlatform));
}

function managedRipgrepPackageRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.FARMING_PACKAGED_RUNTIME_ROOT || path.resolve(__dirname, '..');
}

function isStandalonePackagedRuntime(): boolean {
  return Boolean((process as NodeJS.Process & { pkg?: unknown }).pkg);
}

function materializeStandaloneRipgrep(
  platformKey = currentManagedRipgrepPlatform(),
  env: NodeJS.ProcessEnv = process.env,
  embeddedRoot = path.resolve(__dirname, '..'),
): string {
  const configRoot = String(env.FARMING_CONFIG_DIR || '').trim();
  if (!configRoot) {
    throw new Error('Farming standalone ripgrep preparation requires FARMING_CONFIG_DIR');
  }
  const canonicalPlatform = canonicalManagedRipgrepPlatform(platformKey);
  const relativePath = managedRipgrepRelativePath(canonicalPlatform);
  const source = path.join(embeddedRoot, relativePath);
  const runtimeRoot = path.join(configRoot, '.runtime', `ripgrep-${MANAGED_RIPGREP_VERSION}`);
  const destination = path.join(runtimeRoot, relativePath);
  const destinationDirectory = path.dirname(destination);
  fs.mkdirSync(destinationDirectory, { recursive: true, mode: 0o700 });
  const stagingDirectory = fs.mkdtempSync(path.join(destinationDirectory, '.rg-stage-'));
  const staging = path.join(stagingDirectory, managedRipgrepFilename(canonicalPlatform));
  try {
    fs.copyFileSync(source, staging);
    fs.chmodSync(staging, process.platform === 'win32' ? 0o600 : 0o700);
    fs.rmSync(destination, { force: true });
    fs.renameSync(staging, destination);
  } catch (caught: unknown) {
    throw new Error(`Farming standalone package omitted managed ripgrep: ${source}`, { cause: caught });
  } finally {
    fs.rmSync(stagingDirectory, { recursive: true, force: true });
  }
  env.FARMING_PACKAGED_RUNTIME_ROOT = runtimeRoot;
  return destination;
}

function managedRipgrepPath(
  platformKey = currentManagedRipgrepPlatform(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(managedRipgrepPackageRoot(env), managedRipgrepRelativePath(platformKey));
}

function assertManagedRipgrep(
  platformKey = currentManagedRipgrepPlatform(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  const canonicalPlatform = canonicalManagedRipgrepPlatform(platformKey);
  if (!MANAGED_RIPGREP_ARTIFACTS[canonicalPlatform]) {
    throw new Error(`Farming does not provide ripgrep for ${canonicalPlatform}`);
  }
  const executable = isStandalonePackagedRuntime()
    ? materializeStandaloneRipgrep(canonicalPlatform, env)
    : managedRipgrepPath(canonicalPlatform, env);
  try {
    fs.accessSync(executable, fs.constants.R_OK | (process.platform === 'win32' ? 0 : fs.constants.X_OK));
  } catch {
    throw new Error(`Farming managed ripgrep ${MANAGED_RIPGREP_VERSION} is missing or not executable: ${executable}`);
  }
  try {
    const version = String(execFileSync(executable, ['--version'], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024,
      timeout: 2_000,
    })).split(/\r?\n/, 1)[0];
    if (version !== `ripgrep ${MANAGED_RIPGREP_VERSION}`
      && !version.startsWith(`ripgrep ${MANAGED_RIPGREP_VERSION} `)) {
      throw new Error(`unexpected version: ${version || 'missing'}`);
    }
  } catch (caught: unknown) {
    const detail = caught instanceof Error ? `: ${caught.message}` : '';
    throw new Error(
      `Farming managed ripgrep ${MANAGED_RIPGREP_VERSION} is corrupt: ${executable}${detail}`,
      { cause: caught },
    );
  }
  return executable;
}

export {
  MANAGED_RIPGREP_ARTIFACTS,
  MANAGED_RIPGREP_VERSION,
  assertManagedRipgrep,
  canonicalManagedRipgrepPlatform,
  currentManagedRipgrepPlatform,
  managedRipgrepFilename,
  managedRipgrepPath,
  managedRipgrepRelativePath,
  materializeStandaloneRipgrep,
};
