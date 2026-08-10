const { execFile } = require('child_process');
const { promisify } = require('util');
const crypto = require('crypto');
import {
  canonicalConfigDir,
  configInstanceFingerprint,
} from '../../../backend/config-instance.cjs';
import { ManagedChromiumInstaller } from '../../browser/backend/managed-chromium-installer.cjs';

const execFileAsync = promisify(execFile);
const LEGACY_ISOLATED_BROWSER_IMAGE_DIGEST =
  'sha256:27764b6a7867b1d7ed07975b4678e20c3005e469b0fb8178d8ee6986c14cc97b';

interface DockerResult {
  stdout: string;
  stderr: string;
}

interface DockerRunner {
  (args: string[], options?: { timeoutMs?: number; maxBuffer?: number }): Promise<DockerResult>;
}

interface ComputerResourceManagerLike {
  acquireBrowser(input: {
    ownerAgentId: string;
    projectRootId: string;
    workspace: string;
    executablePath: string;
  }): Promise<{ cdpUrl: string; leaseKey: string }>;
  capability(refresh?: boolean): Promise<Record<string, unknown>>;
  prepare(): Promise<unknown>;
  releaseBrowser(leaseKey: string): Promise<void>;
  verifyBrowserExecutable(executablePath: string): Promise<string>;
}

interface ChromiumInstallerLike {
  browserOption(): { path?: string } | null;
  install(): Promise<unknown>;
  status(): unknown;
}

interface IsolatedBrowserProviderOptions {
  configDir: string;
  computerResourceManager: ComputerResourceManagerLike;
  chromiumInstaller?: ChromiumInstallerLike;
  dockerRunner?: DockerRunner;
}

interface IsolatedBrowserOwner {
  ownerAgentId: string;
  ownerKey: string;
  projectRootId: string;
  workspace: string;
}

function isolatedBrowserError(message: string, code: string, status = 409) {
  return Object.assign(new Error(message), { code, status });
}

class IsolatedBrowserProvider {
  readonly computerResourceManager: ComputerResourceManagerLike;
  readonly configFingerprint: string;
  readonly legacyConfigFingerprints: Set<string>;
  readonly chromiumInstaller: ChromiumInstallerLike;
  readonly docker: DockerRunner;
  preparePromise: Promise<unknown> | null = null;

  constructor(options: IsolatedBrowserProviderOptions) {
    this.computerResourceManager = options.computerResourceManager;
    const configDir = canonicalConfigDir(options.configDir);
    this.configFingerprint = configInstanceFingerprint(configDir);
    this.legacyConfigFingerprints = new Set([
      crypto.createHash('sha256').update(options.configDir).digest('hex').slice(0, 12),
      crypto.createHash('sha256').update(configDir).digest('hex').slice(0, 12),
    ]);
    this.docker = options.dockerRunner || (async (args, runOptions = {}) => {
      const result = await execFileAsync('docker', args, {
        encoding: 'utf8',
        timeout: runOptions.timeoutMs || 90_000,
        killSignal: 'SIGKILL',
        maxBuffer: runOptions.maxBuffer || 20 * 1024 * 1024,
      });
      return {
        stdout: String(result.stdout || ''),
        stderr: String(result.stderr || ''),
      };
    });
    this.chromiumInstaller = options.chromiumInstaller || new ManagedChromiumInstaller({
      configDir,
      platform: 'linux',
      arch: process.arch,
      platformKey: `linux-${process.arch}-computer`,
      verifyBrowser: executablePath =>
        this.computerResourceManager.verifyBrowserExecutable(executablePath),
    });
  }

  async capability(refresh = false): Promise<Record<string, unknown>> {
    const computer = await this.computerResourceManager.capability(refresh);
    const chromiumValue = this.chromiumInstaller.status();
    const chromium = chromiumValue && typeof chromiumValue === 'object'
      ? chromiumValue as Record<string, unknown>
      : {};
    const imageReady = computer.imageReady === true && chromium.state === 'ready';
    return {
      available: computer.dockerAvailable === true && imageReady,
      dockerAvailable: computer.dockerAvailable === true,
      imageReady,
      image: computer.image || '',
      imageDigest: computer.imageDigest || '',
      compatibilityMode: computer.compatibilityMode === true,
      chromium,
      error: String(computer.error || chromium.error || ''),
    };
  }

  prepare(): Promise<unknown> {
    if (this.preparePromise) return this.preparePromise;
    this.preparePromise = (async () => {
      await this.computerResourceManager.prepare();
      await this.chromiumInstaller.install();
      return this.capability(true);
    })().finally(() => {
      this.preparePromise = null;
    });
    return this.preparePromise;
  }

  async recover(): Promise<void> {
    // v2.2.30 briefly created hidden cuabot containers for isolated Browsers.
    // Remove only containers carrying this exact Farming instance and legacy
    // image identity. New Browser sessions are owned by visible Computers.
    const ownedFingerprints = new Set([
      this.configFingerprint,
      ...this.legacyConfigFingerprints,
    ]);
    const ids = new Set<string>();
    for (const fingerprint of ownedFingerprints) {
      let listed: DockerResult;
      try {
        listed = await this.docker([
          'ps', '-aq',
          '--filter', 'label=farming.dev/kind=isolated-browser',
          '--filter', `label=farming.dev/config=${fingerprint}`,
          '--filter', `label=farming.dev/image-digest=${LEGACY_ISOLATED_BROWSER_IMAGE_DIGEST}`,
        ], { timeoutMs: 10_000 });
      } catch {
        return;
      }
      for (const id of listed.stdout.split(/\s+/).filter(Boolean)) ids.add(id);
    }
    for (const id of ids) {
      const inspected = await this.docker(['inspect', id], { timeoutMs: 10_000 });
      const parsed = JSON.parse(inspected.stdout);
      const value = Array.isArray(parsed) && parsed[0] && typeof parsed[0] === 'object'
        ? parsed[0] as Record<string, unknown>
        : {};
      const labels = (
        value.Config && typeof value.Config === 'object'
          ? (value.Config as Record<string, unknown>).Labels
          : {}
      ) as Record<string, unknown>;
      if (
        labels['farming.dev/kind'] !== 'isolated-browser'
        || !ownedFingerprints.has(String(labels['farming.dev/config'] || ''))
        || labels['farming.dev/image-digest'] !== LEGACY_ISOLATED_BROWSER_IMAGE_DIGEST
      ) continue;
      const state = value.State && typeof value.State === 'object'
        ? value.State as Record<string, unknown>
        : {};
      if (state.Running === true) {
        await this.docker(['stop', '--time', '10', id], { timeoutMs: 30_000 });
      }
      await this.docker(['rm', id], { timeoutMs: 30_000 });
    }
  }

  async acquire(owner: IsolatedBrowserOwner): Promise<{ cdpUrl: string; leaseKey: string }> {
    const ownerAgentId = String(owner.ownerAgentId || '').trim();
    const projectRootId = String(owner.projectRootId || '').trim();
    const workspace = String(owner.workspace || '').trim();
    if (!ownerAgentId || !projectRootId || !workspace) {
      throw isolatedBrowserError(
        'An Agent-owned Browser requires an Agent and Project workspace',
        'ISOLATED_BROWSER_AGENT_OWNER_REQUIRED',
        400,
      );
    }
    const option = this.chromiumInstaller.browserOption();
    const executablePath = String(option?.path || '').trim();
    if (!executablePath) {
      throw isolatedBrowserError(
        'Prepare the isolated Browser runtime before starting this Browser',
        'ISOLATED_BROWSER_IMAGE_NOT_READY',
        503,
      );
    }
    return this.computerResourceManager.acquireBrowser({
      ownerAgentId,
      projectRootId,
      workspace,
      executablePath,
    });
  }

  release(leaseKey: string): Promise<void> {
    return this.computerResourceManager.releaseBrowser(leaseKey);
  }

  deleteOwner(_ownerKey: string): Promise<void> {
    // The Computer belongs to the Agent, not to an individual Browser row.
    return Promise.resolve();
  }
}

export {
  LEGACY_ISOLATED_BROWSER_IMAGE_DIGEST,
  IsolatedBrowserProvider,
};
