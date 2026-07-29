const PACKAGED_CODEX_ACP_ARG = '--farming-codex-acp';

async function runPackagedCodexAcp(): Promise<never> {
  if (!(process as NodeJS.Process & { pkg?: unknown }).pkg) {
    throw new Error('The packaged Codex ACP entry is available only in a standalone Farming CLI');
  }
  throw new Error('The standalone Farming CLI omitted its embedded Codex ACP runtime');
}

export {
  PACKAGED_CODEX_ACP_ARG,
  runPackagedCodexAcp,
};
