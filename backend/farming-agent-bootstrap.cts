const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
import * as storageLayout from './storage-layout.cjs';

const sourceFile = path.join(__dirname, 'farming-agent-bootstrap.md');

function renderFarmingAgentBootstrap(): string {
  return fs.readFileSync(sourceFile, 'utf8').trim();
}

function renderFarmingAgentSystemPrompt(additionalInstructions = ''): string {
  const additional = String(additionalInstructions || '').trim();
  if (!additional) return renderFarmingAgentBootstrap();
  return [
    renderFarmingAgentBootstrap(),
    '## User shared instructions',
    'The following instructions were configured by the owner of this Farming Config instance.',
    additional,
    'Farming built-in ownership, security, and lifecycle contracts above remain authoritative.',
  ].join('\n\n');
}

function ensureFarmingAgentBootstrapFile(configDir: string, additionalInstructions = ''): string {
  const content = `${renderFarmingAgentSystemPrompt(additionalInstructions)}\n`;
  const hasAdditionalInstructions = Boolean(String(additionalInstructions || '').trim());
  const target = hasAdditionalInstructions
    ? path.join(
        configDir,
        'shared-prompt-snapshots',
        `${crypto.createHash('sha256').update(content).digest('hex')}.md`,
      )
    : storageLayout.farmingAgentBootstrapFile(configDir);
  try {
    if (fs.readFileSync(target, 'utf8') === content) return target;
  } catch {
    // Install the current Farming-owned prompt below.
  }
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
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
  renderFarmingAgentSystemPrompt,
};
