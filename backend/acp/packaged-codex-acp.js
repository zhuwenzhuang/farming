const PACKAGED_CODEX_ACP_ARG = '--farming-codex-acp';

async function runPackagedCodexAcp() {
  if (!process.pkg) {
    throw new Error('The packaged Codex ACP entry is available only in a standalone Farming CLI');
  }
  throw new Error('The standalone Farming CLI omitted its embedded Codex ACP runtime');
}

module.exports = {
  PACKAGED_CODEX_ACP_ARG,
  runPackagedCodexAcp,
};
