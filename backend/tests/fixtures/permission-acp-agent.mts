import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import { agent, ndJsonStream, type AgentContext, type SessionConfigOption } from '@agentclientprotocol/sdk/unstable';

// Captured provider contracts, deliberately independent of the production map.
const contracts: Record<string, [string, string] | null> = {
  codex: ['agent', 'agent-full-access'], claude: ['default', 'bypassPermissions'],
  qoder: ['default', 'bypassPermissions'], qwen: ['default', 'yolo'],
  agy: ['agent_decides', 'bypassPermissions'], opencode: null, pi: null,
};
const provider = process.argv[2];
const contract = contracts[provider];
const sessions = new Map<string, { cwd: string; mode: string }>();
let client: AgentContext;
function options(mode: string): SessionConfigOption[] {
  if (process.argv.includes('--legacy') || !contract) return [];
  return [{ id: 'permission', name: 'Mode', category: 'mode', type: 'select', currentValue: mode,
    options: (process.argv.includes('--missing') ? [contract[0]] : contract).map(value => ({ value, name: value })) }];
}
function open(sessionId: string, cwd: string) {
  const mode = (process.argv.includes('--selected') ? contract?.[1] : contract?.[0]) || '';
  sessions.set(sessionId, { cwd, mode });
  return { sessionId, configOptions: options(mode), ...(contract ? { modes: {
    currentModeId: contract[0], availableModes: contract.map(id => ({ id, name: id })),
  } } : {}) };
}
agent()
  .onConnect(connection => { client = connection.client; })
  .onRequest('initialize', () => ({ protocolVersion: 1, agentCapabilities: { loadSession: true },
    agentInfo: { name: `${provider}-permission-fixture`, version: '1' } }))
  .onRequest('session/new', ({ params }) => open(randomUUID(), params.cwd))
  .onRequest('session/load', ({ params }) => open(params.sessionId, params.cwd))
  .onRequest('session/set_mode', ({ params }) => {
    const session = sessions.get(params.sessionId)!;
    if (!contract?.includes(params.modeId)) throw new Error('Unsupported mode');
    session.mode = params.modeId;
    return {};
  })
  .onRequest('session/set_config_option', ({ params }) => {
    const session = sessions.get(params.sessionId)!;
    fs.appendFileSync(path.join(session.cwd, 'mode-requests.jsonl'), `${JSON.stringify(params)}\n`);
    if (process.argv.includes('--reject')) throw new Error('Permission mode rejected');
    if (!contract?.includes(String(params.value))) throw new Error('Unsupported permission');
    if (!process.argv.includes('--unconfirmed')) session.mode = String(params.value);
    return { configOptions: options(session.mode) };
  })
  .onRequest('session/prompt', async ({ params }) => {
    const session = sessions.get(params.sessionId)!;
    if (contract && session.mode !== contract[1]) throw new Error('Provider is still restricted');
    if (provider === 'opencode') {
      const result = await client.request('session/request_permission', { sessionId: params.sessionId,
        toolCall: { toolCallId: 'write-proof', title: 'Write test proof', kind: 'edit', status: 'pending' },
        options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }] });
      if (result.outcome.outcome !== 'selected') throw new Error('Write was not approved');
    }
    fs.writeFileSync(path.join(session.cwd, `${params.sessionId}.proof`), provider);
    return { stopReason: 'end_turn' };
  })
  .connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>));
