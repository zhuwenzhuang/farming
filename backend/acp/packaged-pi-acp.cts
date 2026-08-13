const PACKAGED_PI_ACP_ARG = '--farming-pi-acp';

async function runPackagedPiAcp(): Promise<never> {
  if (!(process as NodeJS.Process & { pkg?: unknown }).pkg) {
    throw new Error('The packaged Pi ACP entry is available only in a standalone Farming CLI');
  }
  throw new Error('The standalone Farming CLI omitted its embedded Pi ACP runtime');
}

export {
  PACKAGED_PI_ACP_ARG,
  runPackagedPiAcp,
};
