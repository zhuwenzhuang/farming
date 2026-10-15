import path from 'path';

const PACKAGED_AGY_ACP_ARG = '--farming-agy-acp';

async function runPackagedAgyAcp(argv: string[] = process.argv.slice(3)): Promise<void> {
  if (!(process as NodeJS.Process & { pkg?: unknown }).pkg) {
    throw new Error('The packaged Antigravity ACP entry is available only in a standalone Farming CLI');
  }
  const { runAgyAcpBridge } = require('./agy-acp-bridge.cjs') as {
    runAgyAcpBridge: (args?: string[]) => void;
  };
  runAgyAcpBridge(argv);
}

function resolveAgyAcpLaunch(
  options: {
    executable?: string;
    providerHomePath?: string;
    farmingSystemPrompt?: string;
    runtimeEnv?: NodeJS.ProcessEnv;
  } = {}
): { command: string; args: string[] } {
  const runtimeEnv =
    options.runtimeEnv && typeof options.runtimeEnv === 'object' ? options.runtimeEnv : process.env;
  const bridgeArgs: string[] = [];
  const executable = String(options.executable || 'agy').trim();
  if (executable) {
    bridgeArgs.push('--farming-agy-command', executable);
  }
  const providerHomePath = String(options.providerHomePath || '').trim();
  if (providerHomePath) {
    bridgeArgs.push('--farming-agy-home', providerHomePath);
  }
  const farmingSystemPrompt = String(options.farmingSystemPrompt || '').trim();
  if (farmingSystemPrompt) {
    bridgeArgs.push('--farming-append-system-prompt', farmingSystemPrompt);
  }

  if ((process as NodeJS.Process & { pkg?: unknown }).pkg) {
    return {
      command: process.execPath,
      args: [PACKAGED_AGY_ACP_ARG, ...bridgeArgs]
    };
  }

  const entry = path.join(__dirname, 'agy-acp-bridge.cjs');
  const nodeBin = runtimeEnv.FARMING_NODE_BIN || process.execPath;
  const ldPath = runtimeEnv.FARMING_NODE_LD || '';
  const libraryPath = runtimeEnv.FARMING_NODE_LIBRARY_PATH || '';
  if (ldPath && libraryPath) {
    return {
      command: ldPath,
      args: ['--library-path', libraryPath, nodeBin, entry, ...bridgeArgs]
    };
  }
  return {
    command: nodeBin,
    args: [entry, ...bridgeArgs]
  };
}

export {
  PACKAGED_AGY_ACP_ARG,
  resolveAgyAcpLaunch,
  runPackagedAgyAcp
};
