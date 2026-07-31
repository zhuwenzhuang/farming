import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

interface ExecutableVerification {
  valid: boolean;
}

type VerifyExecutable = (
  executablePath: string,
  expectedVersion: string,
  options: {
    env: NodeJS.ProcessEnv;
    execFile?: unknown;
    platform: NodeJS.Platform;
    useConfiguredLoader: boolean;
  },
) => Promise<ExecutableVerification>;

import {
  verifyExecutable,
  type ExecFileImplementation,
} from '../../../backend/runtime-dependency-manager.cjs';
import { AGENT_BROWSER_VERSION } from './agent-browser-runtime.cjs';

type BrowserKind =
  | 'brave'
  | 'chrome'
  | 'chromium'
  | 'custom'
  | 'edge'
  | 'external-cdp'
  | 'isolated-computer'
  | 'managed-chromium'
  | string;

interface BrowserCandidate {
  kind: BrowserKind;
  path: string;
}

interface BrowserExecutable extends BrowserCandidate {
  agentBrowserPath?: string;
  agentBrowserSource?: 'managed';
  agentBrowserVersion?: string;
  cdpUrl?: string;
  error?: string;
  runtimeErrorCode?: 'NOT_FOUND' | 'VERSION_MISMATCH';
}

interface BrowserDiscoveryOptions {
  agentBrowserPath?: unknown;
  env?: NodeJS.ProcessEnv;
  executableKind?: unknown;
  executablePath?: unknown;
  execFile?: ExecFileImplementation;
  externalCdpUrl?: unknown;
  managedBrowserPath?: unknown;
  platform?: NodeJS.Platform;
  source?: unknown;
}

function executable(pathname: unknown, kind: BrowserKind): BrowserCandidate | null {
  if (!pathname) return null;
  const executablePath = String(pathname);
  try {
    fs.accessSync(executablePath, fs.constants.X_OK);
    return { kind, path: executablePath };
  } catch {
    return null;
  }
}

function firstExecutable(candidates: BrowserCandidate[]): BrowserCandidate | null {
  for (const candidate of candidates) {
    const found = executable(candidate.path, candidate.kind);
    if (found) return found;
  }
  return null;
}

function uniqueExecutables(candidates: BrowserCandidate[]): BrowserCandidate[] {
  const seen = new Set<string>();
  const result: BrowserCandidate[] = [];
  for (const candidate of candidates) {
    const found = executable(candidate.path, candidate.kind);
    if (!found || seen.has(found.path)) continue;
    seen.add(found.path);
    result.push(found);
  }
  return result;
}

function which(command: string): string {
  try {
    const program = process.platform === 'win32' ? 'where.exe' : 'which';
    return execFileSync(program, [command], {
      encoding: 'utf8',
      timeout: 1_000,
      maxBuffer: 16_384,
    }).split(/\r?\n/).map(value => value.trim()).find(Boolean) || '';
  } catch {
    return '';
  }
}

function managedAgentBrowserPath(options: BrowserDiscoveryOptions = {}): string {
  const env = options.env || process.env;
  return String(
    options.agentBrowserPath
    || env.FARMING_AGENT_BROWSER_BIN
    || env.FARMING_AGENT_BROWSER_EXECUTABLE
    || '',
  ).trim();
}

function macBrowserCandidates(): BrowserCandidate[] {
  return [
    { kind: 'chrome', path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
    { kind: 'brave', path: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser' },
    { kind: 'edge', path: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' },
    { kind: 'chromium', path: '/Applications/Chromium.app/Contents/MacOS/Chromium' },
    { kind: 'chrome', path: path.join(process.env.HOME || '', 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome') },
    { kind: 'brave', path: path.join(process.env.HOME || '', 'Applications/Brave Browser.app/Contents/MacOS/Brave Browser') },
  ];
}

function discoverMacBrowser(): BrowserCandidate | null {
  return firstExecutable(macBrowserCandidates());
}

function linuxBrowserCandidates(): BrowserCandidate[] {
  const commands: Array<[string, BrowserKind]> = [
    ['google-chrome', 'chrome'],
    ['google-chrome-stable', 'chrome'],
    ['brave-browser', 'brave'],
    ['microsoft-edge', 'edge'],
    ['chromium', 'chromium'],
    ['chromium-browser', 'chromium'],
  ];
  return commands.map(([command, kind]) => ({ kind, path: which(command) }));
}

function discoverLinuxBrowser(): BrowserCandidate | null {
  return firstExecutable(linuxBrowserCandidates());
}

function windowsBrowserCandidates(env: NodeJS.ProcessEnv): BrowserCandidate[] {
  const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA]
    .filter((root): root is string => Boolean(root));
  const candidates: BrowserCandidate[] = [];
  for (const root of roots) {
    candidates.push(
      { kind: 'edge', path: path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe') },
      { kind: 'chrome', path: path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe') },
      { kind: 'brave', path: path.join(root, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe') },
      { kind: 'chromium', path: path.join(root, 'Chromium', 'Application', 'chrome.exe') },
    );
  }
  return candidates;
}

function discoverWindowsBrowser(env: NodeJS.ProcessEnv): BrowserCandidate | null {
  return firstExecutable(windowsBrowserCandidates(env));
}

function discoverBrowserExecutables(options: BrowserDiscoveryOptions = {}): BrowserCandidate[] {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  let candidates: BrowserCandidate[] = [];
  if (platform === 'darwin') candidates = macBrowserCandidates();
  if (platform === 'linux') candidates = linuxBrowserCandidates();
  if (platform === 'win32') candidates = windowsBrowserCandidates(env);
  const managed = executable(options.managedBrowserPath, 'managed-chromium');
  return [
    ...uniqueExecutables(candidates),
    ...(managed ? [managed] : []),
  ];
}

function normalizeExternalCdpUrl(value: unknown): string {
  const input = String(value || '').trim();
  if (!input) return '';
  try {
    const url = new URL(input);
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) return '';
    if (url.username || url.password || url.search) return '';
    const hostname = url.hostname.toLowerCase();
    if (!['localhost', '127.0.0.1', '[::1]'].includes(hostname)) return '';
    url.hash = '';
    return url.href;
  } catch {
    return '';
  }
}

function discoverBrowserExecutable(
  options: BrowserDiscoveryOptions = {},
): BrowserExecutable | null {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const source = String(options.source || '').trim();
  if (source === 'external-cdp') {
    const cdpUrl = normalizeExternalCdpUrl(options.externalCdpUrl);
    return cdpUrl
      ? { kind: 'external-cdp', path: '', cdpUrl }
      : {
          kind: 'external-cdp',
          path: '',
          cdpUrl: '',
          error: 'External CDP must be a loopback http(s) or ws(s) endpoint without credentials or query parameters',
        };
  }
  if (source === 'isolated') {
    return { kind: 'isolated-computer', path: '' };
  }
  if (source === 'managed') {
    return executable(options.managedBrowserPath, 'managed-chromium') || {
      kind: 'managed-chromium',
      path: String(options.managedBrowserPath || ''),
      error: 'Install or update the Farming-managed Chromium for this agent-browser version',
    };
  }
  if (source === 'system') {
    const configuredPath = String(options.executablePath || '').trim();
    if (configuredPath) {
      const configuredKind = String(options.executableKind || 'custom').trim() || 'custom';
      return executable(path.resolve(configuredPath), configuredKind) || {
        kind: configuredKind,
        path: path.resolve(configuredPath),
        error: 'The selected Chromium browser is no longer available',
      };
    }
    let systemBrowser: BrowserCandidate | null = null;
    if (platform === 'darwin') systemBrowser = discoverMacBrowser();
    if (platform === 'linux') systemBrowser = discoverLinuxBrowser();
    if (platform === 'win32') systemBrowser = discoverWindowsBrowser(env);
    return systemBrowser;
  }
  const externalCdpInput = String(options.externalCdpUrl || env.FARMING_BROWSER_CDP_URL || '').trim();
  if (externalCdpInput) {
    const cdpUrl = normalizeExternalCdpUrl(externalCdpInput);
    return cdpUrl
      ? { kind: 'external-cdp', path: '', cdpUrl }
      : {
          kind: 'external-cdp',
          path: '',
          cdpUrl: '',
          error: 'FARMING_BROWSER_CDP_URL must be a loopback http(s) or ws(s) CDP endpoint without credentials or query parameters',
        };
  }
  const configured = String(options.executablePath || env.FARMING_BROWSER_EXECUTABLE || '').trim();
  if (configured) {
    return executable(path.resolve(configured), 'custom');
  }
  let systemBrowser: BrowserCandidate | null = null;
  if (platform === 'darwin') systemBrowser = discoverMacBrowser();
  if (platform === 'linux') systemBrowser = discoverLinuxBrowser();
  if (platform === 'win32') systemBrowser = discoverWindowsBrowser(env);
  return systemBrowser || executable(options.managedBrowserPath, 'managed-chromium');
}

async function discoverBrowserRuntime(
  options: BrowserDiscoveryOptions = {},
): Promise<BrowserExecutable | null> {
  const browser = discoverBrowserExecutable(options);
  if (!browser || browser.error) return browser;
  const agentBrowserPath = managedAgentBrowserPath(options);
  if (!agentBrowserPath) {
    return {
      ...browser,
      error: `agent-browser ${AGENT_BROWSER_VERSION} is required; restart Farming through its launcher to prepare startup dependencies`,
      runtimeErrorCode: 'NOT_FOUND',
    };
  }
  const verification = await verifyExecutable(agentBrowserPath, AGENT_BROWSER_VERSION, {
    execFile: options.execFile,
    env: options.env || process.env,
    platform: options.platform || process.platform,
    useConfiguredLoader: (options.env || process.env).FARMING_AGENT_BROWSER_STATIC !== '1',
  });
  if (!verification.valid) {
    return {
      ...browser,
      error: `The Farming-managed agent-browser must be version ${AGENT_BROWSER_VERSION}`,
      runtimeErrorCode: 'VERSION_MISMATCH',
    };
  }
  return {
    ...browser,
    agentBrowserPath,
    agentBrowserVersion: AGENT_BROWSER_VERSION,
    agentBrowserSource: 'managed',
  };
}

export {
  discoverBrowserExecutable,
  discoverBrowserExecutables,
  discoverBrowserRuntime,
  managedAgentBrowserPath,
  normalizeExternalCdpUrl,
};
export type {
  BrowserCandidate,
  BrowserDiscoveryOptions,
  BrowserExecutable,
};
