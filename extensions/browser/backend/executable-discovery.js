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

function agentBrowserBinaryName(platform = process.platform, arch = process.arch) {
  return `agent-browser-${platform}-${arch}${platform === 'win32' ? '.exe' : ''}`;
}

function agentBrowserSystemCandidates(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  const configured = String(
    options.agentBrowserPath
    || env.FARMING_AGENT_BROWSER_BIN
    || env.FARMING_AGENT_BROWSER_EXECUTABLE
    || '',
  ).trim();
  const commandPath = configured || which('agent-browser');
  const candidates = [];
  if (commandPath) {
    try {
      const realCommandPath = fs.realpathSync(commandPath);
      const nativeSibling = path.join(
        path.dirname(realCommandPath),
        agentBrowserBinaryName(platform, arch),
      );
      if (fs.existsSync(nativeSibling)) candidates.push(nativeSibling);
    } catch {
      // The resolver reports the configured candidate as missing below.
    }
    candidates.push(commandPath);
  }
  return [...new Set(candidates.map(candidate => path.resolve(candidate)))];
}

function discoverMacBrowser() {
  return firstExecutable([
    { kind: 'chrome', path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
    { kind: 'brave', path: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser' },
    { kind: 'edge', path: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' },
    { kind: 'chromium', path: '/Applications/Chromium.app/Contents/MacOS/Chromium' },
    { kind: 'chrome', path: path.join(process.env.HOME || '', 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome') },
    { kind: 'brave', path: path.join(process.env.HOME || '', 'Applications/Brave Browser.app/Contents/MacOS/Brave Browser') },
  ]);
}

function discoverLinuxBrowser() {
  const commands = [
    ['google-chrome', 'chrome'],
    ['google-chrome-stable', 'chrome'],
    ['brave-browser', 'brave'],
    ['microsoft-edge', 'edge'],
    ['chromium', 'chromium'],
    ['chromium-browser', 'chromium'],
  ];
  for (const [command, kind] of commands) {
    const found = executable(which(command), kind);
    if (found) return found;
  }
  return null;
}

function discoverWindowsBrowser(env) {
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
  return firstExecutable(candidates);
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
  const env = options.env || process.env;
  const candidates = options.agentBrowserSystemCandidates || agentBrowserSystemCandidates(options);
  for (const candidate of candidates) {
    const verification = await verifyExecutable(candidate, AGENT_BROWSER_VERSION, {
      execFile: options.execFile,
    });
    if (!verification.valid) continue;
    return {
      ...browser,
      agentBrowserPath: candidate,
      agentBrowserVersion: AGENT_BROWSER_VERSION,
      agentBrowserSource: candidate === String(env.FARMING_AGENT_BROWSER_BIN || '').trim()
        ? 'managed'
        : 'system',
    };
  }
  return {
    ...browser,
    error: `agent-browser ${AGENT_BROWSER_VERSION} is required; restart Farming through its launcher to prepare startup dependencies`,
    runtimeErrorCode: 'NOT_FOUND',
  };
}

module.exports = {
  agentBrowserBinaryName,
  agentBrowserSystemCandidates,
  discoverBrowserExecutable,
  discoverBrowserRuntime,
  normalizeExternalCdpUrl,
};
