import { Readable, Writable } from 'node:stream';
import {
  AgentSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
} from '@agentclientprotocol/sdk';

let client;
let sessionId = 'acp-new-session';

class FakeAgent {
  async initialize() {
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: { list: {}, resume: {}, fork: {}, delete: {}, close: {} },
      },
      authMethods: [],
      agentInfo: { name: 'Farming fake ACP Agent', version: '1.0.0' },
    };
  }

  async newSession() {
    return { sessionId };
  }

  async loadSession(params) {
    sessionId = params.sessionId;
    await client.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: 'user_message_chunk',
        messageId: 'history-user',
        content: { type: 'text', text: 'historical question' },
      },
    });
    await client.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'history-answer',
        content: { type: 'text', text: 'historical answer' },
      },
    });
    return {};
  }

  async resumeSession(params) {
    sessionId = params.sessionId;
    return {};
  }

  async listSessions() {
    return { sessions: [{ sessionId, cwd: process.cwd(), title: 'Fake history' }] };
  }

  async unstable_forkSession() {
    return { sessionId: 'acp-fork-session' };
  }

  async deleteSession() {
    return {};
  }

  async closeSession() {
    return {};
  }

  async setSessionMode() {
    return {};
  }

  async setSessionConfigOption(params) {
    return { configOptions: [{ id: params.configId, type: 'boolean', currentValue: params.value }] };
  }

  async authenticate() {
    return {};
  }

  async prompt(params) {
    const permission = await client.requestPermission({
      sessionId: params.sessionId,
      toolCall: { toolCallId: 'tool-1', title: 'Run fake command', kind: 'execute' },
      options: [
        { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
        { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
      ],
    });
    await client.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tool-1',
        title: 'Run fake command',
        kind: 'execute',
        status: 'in_progress',
      },
    });
    await client.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-1',
        status: 'completed',
        rawOutput: permission.outcome.outcome,
      },
    });
    await client.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'answer-1',
        content: { type: 'text', text: 'ACP reply' },
      },
    });
    return { stopReason: 'end_turn' };
  }

  async cancel() {}
}

new AgentSideConnection(
  connection => {
    client = connection;
    return new FakeAgent();
  },
  ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin))
);
