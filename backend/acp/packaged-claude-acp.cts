const PACKAGED_CLAUDE_ACP_ARG = '--farming-claude-acp';

async function runPackagedClaudeAcp(): Promise<never> {
  if (!(process as NodeJS.Process & { pkg?: unknown }).pkg) {
    throw new Error('The packaged Claude ACP entry is available only in a standalone Farming CLI');
  }
  throw new Error('The standalone Farming CLI omitted its embedded Claude ACP runtime');
}

export {
  PACKAGED_CLAUDE_ACP_ARG,
  runPackagedClaudeAcp,
};
