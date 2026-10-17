import { AgentCard, ListTasksRequest, ListTasksResponse, CancelTaskRequest, SubscribeToTaskRequest, StreamResponse, GetTaskRequest, SendMessageRequest, Task, Message, TaskState } from '@a2a-js/sdk';
import { ClientFactory, DefaultAgentCardResolver, JsonRpcTransportFactory } from '@a2a-js/sdk/client';

export type CommunicationAdminCommand =
  | { operation: 'grants' }
  | { operation: 'revoke'; grantId: string }
  | { operation: 'grant'; peerId: string; name: string; targets: string[]; hours: number };

export function parseCommunicationAdminCommand(args: string[]): CommunicationAdminCommand {
  if (args[0] === 'grants' && args.length === 1) return { operation: 'grants' };
  if (args[0] === 'revoke' && args.length === 2 && ID.test(args[1])) return { operation: 'revoke', grantId: args[1] };
  if (args[0] === 'grant' && ID.test(args[1] || '')) {
    const targets: string[] = []; let name = ''; let hours = 24;
    for (let i = 2; i < args.length; i += 2) {
      const value = args[i + 1];
      if (!value) throw new Error('Grant options require values');
      if (args[i] === '--target' && ID.test(value)) targets.push(value);
      else if (args[i] === '--name' && !name && value.trim().length && value.length <= 240) name = value;
      else if (args[i] === '--hours' && Number.isFinite(Number(value)) && Number(value) > 0 && Number(value) <= 720) hours = Number(value);
      else throw new Error(`Invalid grant option: ${args[i]}`);
    }
    if (name && targets.length && targets.length <= 128) return { operation: 'grant', peerId: args[1], name, targets, hours };
  }
  throw new Error('Use: farming message grant <peerId> --name <name> --target <agentId> [--target <agentId>] [--hours <1-720>] | grants | revoke <grantId>');
}

export type CommunicationCommand =
  | { operation: 'card'; agentId: string }
  | { operation: 'list'; agentId: string; pageToken?: string }
  | { operation: 'get' | 'watch' | 'cancel' | 'subscribe'; agentId: string; taskId: string }
  | { operation: 'send'; agentId: string; messageId: string; text: string; contextId?: string; replyToTaskId?: string };
const ID = /^[A-Za-z0-9._:-]{1,160}$/;

export function parseCommunicationCommand(args: string[]): CommunicationCommand {
  const [operation, agentId, ...rest] = args;
  if (!agentId || !ID.test(agentId)) throw new Error('message requires an exact Agent ID');
  if (operation === 'card' && rest.length === 0) return { operation, agentId };
  if (operation === 'list' && (rest.length === 0 || (rest.length === 2 && rest[0] === '--page' && /^[A-Za-z0-9._:-]{1,200}$/.test(rest[1])))) {
    return { operation, agentId, ...(rest.length ? { pageToken: rest[1] } : {}) };
  }
  if ((operation === 'get' || operation === 'watch' || operation === 'cancel' || operation === 'subscribe') && rest.length === 1 && ID.test(rest[0])) {
    return { operation, agentId, taskId: rest[0] };
  }
  if (operation === 'send') {
    let messageId = ''; let contextId: string | undefined; let replyToTaskId: string | undefined;
    const separator = rest.indexOf('--');
    const options = separator < 0 ? [] : rest.slice(0, separator);
    for (let i = 0; i < options.length; i += 2) {
      if (!ID.test(options[i + 1] || '')) throw new Error('message options require bounded identifiers');
      if (options[i] === '--id' && !messageId) messageId = options[i + 1];
      else if (options[i] === '--reply-to' && !replyToTaskId) replyToTaskId = options[i + 1];
      else if (options[i] === '--context' && !contextId) contextId = options[i + 1];
      else throw new Error(`Unknown or repeated message option: ${options[i]}`);
    }
    const text = separator < 0 ? '' : rest.slice(separator + 1).join(' ');
    if (messageId && text.trim() && Buffer.byteLength(text) <= 65536) return { operation, agentId, messageId, text, ...(contextId ? { contextId } : {}), ...(replyToTaskId ? { replyToTaskId } : {}) };
    throw new Error('Use: farming message send <agentId> --id <unique-request-id> [--context <contextId>] [--reply-to <taskId>] -- <text>');
  }
  throw new Error('Use: farming message card <agentId> | get <agentId> <taskId> | watch <agentId> <taskId> | list <agentId> [--page <cursor>] | cancel <agentId> <taskId> | subscribe <agentId> <taskId>');
}

/** Same-instance commands use the known A2A endpoint, so saved tasks remain readable after stop. */
export async function runCommunicationCommand(command: CommunicationCommand, options: {
  baseUrl: string; token: string; write(text: string): unknown;
}): Promise<number> {
  if (!options.token) throw new Error('No communication credential. Launch this Agent again or provide an explicitly scoped external FARMING_COMMUNICATION_TOKEN.');
  const endpoint = `${options.baseUrl.replace(/\/+$/, '')}/api/a2a/agents/${encodeURIComponent(command.agentId)}`;
  const authenticatedFetch: typeof fetch = (url, init) => {
    const headers = new Headers(init?.headers);
    headers.set('Authorization', `Bearer ${options.token}`);
    return fetch(url, { ...init, headers, redirect: 'error', signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(command.operation === 'subscribe' ? 65000 : 20000)]) : AbortSignal.timeout(command.operation === 'subscribe' ? 65000 : 20000) });
  };
  if (command.operation === 'card') {
    const card = await new DefaultAgentCardResolver({ fetchImpl: authenticatedFetch }).resolve(endpoint + '/');
    options.write(`${JSON.stringify(AgentCard.toJSON(card), null, 2)}\n`);
    return 0;
  }
  const transport = await new ClientFactory({ transports: [new JsonRpcTransportFactory({ fetchImpl: authenticatedFetch })] }).createFromAgentCard(
    AgentCard.fromJSON({ supportedInterfaces: [{ url: endpoint, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }] }));
  if (command.operation === 'send') {
    try {
      const result = await transport.sendMessage(SendMessageRequest.fromJSON({ message: {
        messageId: command.messageId, role: 'ROLE_USER', contextId: command.contextId, referenceTaskIds: command.replyToTaskId ? [command.replyToTaskId] : [], parts: [{ text: command.text }],
      }, configuration: { returnImmediately: true } }));
      options.write(`${JSON.stringify('id' in result ? Task.toJSON(result) : Message.toJSON(result), null, 2)}\n`);
      return 0;
    } catch (error) {
      throw new Error(`Message ${command.messageId} was not confirmed: ${error instanceof Error ? error.message : String(error)}. If transport failed, retry only with the same ID and identical content to reconcile; do not create a new ID.`, { cause: error });
    }
  }
  if (command.operation === 'list') {
    const tasks = await transport.listTasks(ListTasksRequest.fromJSON({ pageToken: command.pageToken, pageSize: 50 }));
    options.write(`${JSON.stringify(ListTasksResponse.toJSON(tasks), null, 2)}
`);
    return 0;
  }
  if (command.operation === 'cancel') {
    const task = await transport.cancelTask(CancelTaskRequest.fromJSON({ id: command.taskId }));
    options.write(`${JSON.stringify(Task.toJSON(task), null, 2)}
`);
    return 0;
  }
  if (command.operation === 'subscribe') {
    for await (const event of transport.resubscribeTask(SubscribeToTaskRequest.fromJSON({ id: command.taskId }))) {
      options.write(`${JSON.stringify(StreamResponse.toJSON(event))}
`);
    }
    return 0;
  }
  const deadline = Date.now() + 60000;
  for (;;) {
    const task = await transport.getTask(GetTaskRequest.fromJSON({ id: command.taskId }));
    const state = task.status?.state;
    if (command.operation === 'get' || ![TaskState.TASK_STATE_SUBMITTED, TaskState.TASK_STATE_WORKING].includes(state!) || Date.now() >= deadline) {
      options.write(`${JSON.stringify(Task.toJSON(task), null, 2)}\n`);
      return 0;
    }
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
}
