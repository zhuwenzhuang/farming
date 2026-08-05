const fs = require('fs');
const path = require('path');
import * as storageLayout from './storage-layout.cjs';

const sourceFile = path.join(__dirname, 'farming-agent-bootstrap.zh_cn.md');

function renderFarmingAgentBootstrap(): string {
  return fs.readFileSync(sourceFile, 'utf8').trim();
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function renderFarmingAgentSessionContext(agentId: string, projectWorkspace: string): string {
  const agentName = String(agentId || '').trim();
  const workspace = String(projectWorkspace || '').trim();
  if (!agentName || !workspace) return '';
  return [
    '<farming-agent-context>',
    `当前 Farming Agent 名字是 ${agentName}。这个名字只是本地资源路由名，不是权限凭据。`,
    '调用 Farming Browser、Computer、capabilities 或 title 时，为命令显式设置当前 Agent 名字与 Project：',
    `FARMING_AGENT_ID=${shellSingleQuote(agentName)} FARMING_PROJECT_WORKSPACE=${shellSingleQuote(workspace)} "$FARMING_CLI_BIN_DIR/farming" <command>`,
    '不得使用其他 Agent 的名字；如果该名字不存在，让命令明确失败，不要回退到其他 Agent。',
    '</farming-agent-context>',
  ].join('\n');
}

function ensureFarmingAgentBootstrapFile(configDir: string): string {
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

function appendOpenCodeBootstrap(
  env: NodeJS.ProcessEnv,
  bootstrapFile: string,
): NodeJS.ProcessEnv {
  const next = { ...env };
  let config: Record<string, unknown> = {};
  if (next.OPENCODE_CONFIG_CONTENT) {
    try {
      const parsed = JSON.parse(next.OPENCODE_CONFIG_CONTENT);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        config = parsed as Record<string, unknown>;
      }
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

export {
  appendOpenCodeBootstrap,
  ensureFarmingAgentBootstrapFile,
  renderFarmingAgentBootstrap,
  renderFarmingAgentSessionContext,
};
