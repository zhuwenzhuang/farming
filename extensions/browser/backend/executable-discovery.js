const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { verifyExecutable } = require('../../../backend/runtime-dependency-manager');
const { AGENT_BROWSER_VERSION } = require('./agent-browser-runtime');

function executable(pathname, kind) {
  if (!pathname) return null;
  try {
    fs.accessSync(pathname, fs.constants.X_OK);
    return { kind, path: pathname };
  } catch {
    return null;
  }
}

function firstExecutable(candidates) {
  for (const candidate of candidates) {
    const found = executable(candidate.path, candidate.kind);
    if (found) return found;
  }
  return null;
}

function uniqueExecutables(candidates) {
  const seen = new Set();
  const result = [];
  for (const candidate of candidates) {
    const found = executable(candidate.path, candidate.kind);
    if (!found || seen.has(found.path)) continue;
    seen.add(found.path);
    result.push(found);
  }
  return result;
}

function which(command) {
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

function managedAgentBrowserPath(options = {}) {
  const env = options.env || process.env;
  return String(
    options.agentBrowserPath
    || env.FARMING_AGENT_BROWSER_BIN
    || env.FARMING_AGENT_BROWSER_EXECUTABLE
    || '',
  ).trim();
}

function macBrowserCandidates() {
  return [
    { kind: 'chrome', path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
    { kind: 'brave', path: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser' },
    { kind: 'edge', path: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' },
    { kind: 'chromium', path: '/Applications/Chromium.app/Contents/MacOS/Chromium' },
    { kind: 'chrome', path: path.join(process.env.HOME || '', 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome') },
    { kind: 'brave', path: path.join(process.env.HOME || '', 'Applications/Brave Browser.app/Contents/MacOS/Brave Browser') },
  ];
}

function discoverMacBrowser() {
  return firstExecutable(macBrowserCandidates());
}

function linuxBrowserCandidates() {
  const commands = [
    ['google-chrome', 'chrome'],
    ['google-chrome-stable', 'chrome'],
    ['brave-browser', 'brave'],
    ['microsoft-edge', 'edge'],
    ['chromium', 'chromium'],
    ['chromium-browser', 'chromium'],
  ];
  return commands.map(([command, kind]) => ({ kind, path: which(command) }));
}

function discoverLinuxBrowser() {
  return firstExecutable(linuxBrowserCandidates());
}

function windowsBrowserCandidates(env) {
  const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean);
  const candidates = [];
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

function discoverWindowsBrowser(env) {
  return firstExecutable(windowsBrowserCandidates(env));
}

function discoverBrowserExecutables(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  if (platform === 'darwin') return uniqueExecutables(macBrowserCandidates());
  if (platform === 'linux') return uniqueExecutables(linuxBrowserCandidates());
  if (platform === 'win32') return uniqueExecutables(windowsBrowserCandidates(env));
  return [];
}

function normalizeExternalCdpUrl(value) {
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

function discoverBrowserExecutable(options = {}) {
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
    if (platform === 'darwin') return discoverMacBrowser();
    if (platform === 'linux') return discoverLinuxBrowser();
    if (platform === 'win32') return discoverWindowsBrowser(env);
    return null;
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
  if (platform === 'darwin') return discoverMacBrowser();
  if (platform === 'linux') return discoverLinuxBrowser();
  if (platform === 'win32') return discoverWindowsBrowser(env);
  return null;
}

async function discoverBrowserRuntime(options = {}) {
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
    useConfiguredLoader: true,
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

module.exports = {
  discoverBrowserExecutable,
  discoverBrowserExecutables,
  discoverBrowserRuntime,
  managedAgentBrowserPath,
  normalizeExternalCdpUrl,
};
