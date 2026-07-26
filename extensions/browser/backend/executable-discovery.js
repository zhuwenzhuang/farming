const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

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
    return execFileSync('which', [command], {
      encoding: 'utf8',
      timeout: 1_000,
      maxBuffer: 16_384,
    }).trim();
  } catch {
    return '';
  }
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

function discoverBrowserExecutable(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const configured = String(options.executablePath || env.FARMING_BROWSER_EXECUTABLE || '').trim();
  if (configured) {
    return executable(path.resolve(configured), 'custom');
  }
  if (platform === 'darwin') return discoverMacBrowser();
  if (platform === 'linux') return discoverLinuxBrowser();
  if (platform === 'win32') return discoverWindowsBrowser(env);
  return null;
}

module.exports = {
  discoverBrowserExecutable,
};
