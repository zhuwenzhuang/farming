const fs = require('fs');
const path = require('path');
const storageLayout = require('./storage-layout');

const sourceFile = path.join(__dirname, 'farming-agent-bootstrap.zh_cn.md');

function renderFarmingAgentBootstrap() {
  return fs.readFileSync(sourceFile, 'utf8').trim();
}

function ensureFarmingAgentBootstrapFile(configDir) {
  const target = storageLayout.farmingAgentBootstrapFile(configDir);
  const content = `${renderFarmingAgentBootstrap()}\n`;
  try {
    if (fs.readFileSync(target, 'utf8') === content) return target;
  } catch {
    // Install the current Farming-owned prompt below.
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, target);
  return target;
}

function appendOpenCodeBootstrap(env, bootstrapFile) {
  const next = { ...env };
  let config = {};
  if (next.OPENCODE_CONFIG_CONTENT) {
    try {
      const parsed = JSON.parse(next.OPENCODE_CONFIG_CONTENT);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) config = parsed;
    } catch {
      return next;
    }
  }
  const instructions = Array.isArray(config.instructions)
    ? config.instructions.filter(value => typeof value === 'string')
    : [];
  config.instructions = [...new Set([...instructions, bootstrapFile])];
  next.OPENCODE_CONFIG_CONTENT = JSON.stringify(config);
  return next;
}

module.exports = {
  appendOpenCodeBootstrap,
  ensureFarmingAgentBootstrapFile,
  renderFarmingAgentBootstrap,
};
