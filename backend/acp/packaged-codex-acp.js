const PACKAGED_CODEX_ACP_ARG = '--farming-codex-acp';

function runPackagedCodexAcp() {
  if (!process.pkg) {
    throw new Error('The packaged Codex ACP entry is available only in a standalone Farming CLI');
  }
  require('../../dist/acp/codex-acp-1.1.4.js');
}

module.exports = {
  PACKAGED_CODEX_ACP_ARG,
  runPackagedCodexAcp,
};
