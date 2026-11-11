import { agyExplicitHomeCliArgs } from '../agy-conversation-store.cjs';

/** Antigravity owns the ACP transport, catalog and conversation lifecycle. */
function resolveAgyAcpLaunch(options: {
  executable?: string;
  providerHomePath?: string;
} = {}): { command: string; args: string[] } {
  return {
    command: options.executable?.trim() || 'agy',
    args: ['acp', '--stdio', ...agyExplicitHomeCliArgs(options.providerHomePath)],
  };
}

export { resolveAgyAcpLaunch };
