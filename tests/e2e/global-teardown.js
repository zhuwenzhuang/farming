const fs = require('fs');
const os = require('os');
const path = require('path');

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function removeConfigDir(configDir) {
  let lastError = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      fs.rmSync(configDir, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      await delay(100);
    }
  }
  if (lastError) {
    console.warn(`Failed to remove Playwright config dir ${configDir}: ${lastError.message}`);
  }
}

function isLiveServerOnOtherPort(configDir, currentPort) {
  try {
    const marker = JSON.parse(fs.readFileSync(path.join(configDir, 'server.json'), 'utf8'));
    const pid = Number(marker && marker.pid);
    const port = String(marker && marker.port || '');
    if (!Number.isInteger(pid) || pid <= 0 || port === currentPort) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

module.exports = async function globalTeardown() {
  const tmpRoot = os.tmpdir();
  const currentPort = String(process.env.FARMING_PLAYWRIGHT_PORT || process.env.PORT || '4173');
  let entries = [];
  try {
    entries = fs.readdirSync(tmpRoot, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('farming-playwright-config-')) continue;
    const configDir = path.join(tmpRoot, entry.name);
    if (isLiveServerOnOtherPort(configDir, currentPort)) continue;
    await removeConfigDir(configDir);
  }
};
