import { Readable, Writable } from 'node:stream';
import fs from 'node:fs';
import path from 'node:path';
import {
  AgentSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
} from '@agentclientprotocol/sdk';

if (process.argv.includes('--fake-terminal-login')) {
  process.stdin.setEncoding('utf8');
  process.stdout.write('fake-login> ');
  await new Promise(resolve => process.stdin.once('data', value => {
    process.stdout.write(`signed-in:${String(value).trim()}`);
    resolve();
  }));
  process.exit(0);
}

let client;
let sessionId = 'acp-new-session';
let refreshedModelId = '';
let activeModel = 'gpt-5.5';
let activeEffort = 'high';
const cancelledSessions = new Map();
let activeSteerTurn = null;

function sessionConfigOptions() {
  return [
    { id: 'model', name: 'Model', type: 'select', currentValue: activeModel, options: [{ value: activeModel, name: activeModel }] },
    { id: 'reasoning', name: 'Reasoning', type: 'select', currentValue: activeEffort, options: [{ value: activeEffort, name: activeEffort }] },
    { id: 'fast-mode', name: 'Fast mode', type: 'boolean', currentValue: false },
  ];
}

function validateRequestedSessionScope(params) {
  const requestsDocsRoot = params.additionalDirectories?.some(directory => path.basename(directory) === 'docs');
  if (!requestsDocsRoot) return;
  const docsServer = params.mcpServers?.find(server => server.name === 'docs');
  if (!docsServer || docsServer.command !== '/bin/docs-mcp') {
    throw new Error('Farming did not preserve the requested ACP additional directory and MCP server');
  }
}

class FakeAgent {
  async initialize(params) {
    if (
      params.clientCapabilities?.fs?.readTextFile !== true
      || params.clientCapabilities?.fs?.writeTextFile !== true
      || params.clientCapabilities?.terminal !== true
      || params.clientCapabilities?.auth?.terminal !== true
      || params.clientCapabilities?._meta?.terminal_output !== true
      || !params.clientCapabilities?.elicitation?.form
      || !params.clientCapabilities?.elicitation?.url
    ) {
      throw new Error('Farming did not advertise the expected ACP client capabilities');
    }
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        auth: { logout: {} },
        loadSession: true,
        promptCapabilities: { image: true, audio: true, embeddedContext: true },
        sessionCapabilities: { list: {}, resume: {}, fork: {}, delete: {}, close: {} },
        _meta: { codex: { steer: { method: '_codex/session/steer', version: 1 } } },
      },
      authMethods: [{
        id: 'fake-login',
        name: 'Sign in to fake Agent',
        description: 'Exercises the ACP agent-managed authentication flow.',
        type: 'agent',
      }, {
        id: 'fake-terminal-login',
        name: 'Sign in from terminal',
        description: 'Exercises client terminal authentication.',
        type: 'terminal',
        args: ['--fake-terminal-login'],
      }],
      agentInfo: { name: 'Farming fake ACP Agent', version: '1.0.0' },
    };
  }

  async newSession(params) {
    validateRequestedSessionScope(params);
    return {
      sessionId,
      configOptions: sessionConfigOptions(),
    };
  }

  async loadSession(params) {
    validateRequestedSessionScope(params);
    sessionId = params.sessionId;
    if (sessionId === 'acp-new-session') {
      const replay = [
        ['user_message_chunk', 'history-rich-user', 'rich timeline'],
        ['agent_message_chunk', 'history-rich-progress', 'I found the display boundary and am checking the typed ACP content.'],
        ['agent_message_chunk', 'history-rich-answer', 'Rich ACP timeline complete.'],
        ['user_message_chunk', 'history-subagent-user', 'subagent preview'],
        ['agent_message_chunk', 'history-subagent-answer', 'Subagent inspection complete.'],
      ];
      for (const [sessionUpdate, messageId, text] of replay) {
        await client.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate,
            messageId,
            content: { type: 'text', text },
          },
        });
      }
      return { configOptions: sessionConfigOptions() };
    }
    if (sessionId === 'delayed-history-session') {
      await client.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: 'user_message_chunk',
          messageId: 'delayed-history-user',
          content: { type: 'text', text: 'delayed historical question' },
        },
      });
      setTimeout(() => {
        void client.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            messageId: 'delayed-history-answer',
            content: { type: 'text', text: 'delayed historical answer' },
          },
        });
      }, 120);
      return { configOptions: sessionConfigOptions() };
    }
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
    return { configOptions: sessionConfigOptions() };
  }

  async resumeSession(params) {
    validateRequestedSessionScope(params);
    sessionId = params.sessionId;
    return { configOptions: sessionConfigOptions() };
  }

  async listSessions() {
    const sessions = [{ sessionId, cwd: process.cwd(), title: 'Fake history', updatedAt: '2020-01-01T00:00:00.000Z' }];
    if (sessionId !== 'existing-session') {
      sessions.push({
        sessionId: 'existing-session',
        cwd: process.cwd(),
        title: 'Existing fake history',
        updatedAt: '2020-01-01T00:00:00.000Z',
      });
    }
    return {
      sessions,
    };
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
    if (params.configId === 'model') {
      activeModel = params.value;
      if (activeModel === 'gpt-5.6-luna' && activeEffort === 'ultra') activeEffort = 'max';
      const refreshedMatch = refreshedModelId.match(/^(.+)\[([^\]]+)]$/);
      const refreshed = refreshedMatch?.[1] === params.value;
      if (refreshed) activeEffort = refreshedMatch[2];
      return {
        configOptions: [
          { id: 'model', name: 'Model', type: 'select', currentValue: activeModel, options: [{ value: activeModel, name: activeModel }] },
          { id: 'reasoning', name: 'Reasoning', type: 'select', currentValue: activeEffort, options: [{ value: activeEffort, name: activeEffort }] },
          ...(refreshed ? [{ id: 'fast-mode', name: 'Fast', type: 'boolean', currentValue: false }] : []),
        ],
      };
    }
    if (params.configId === 'reasoning') {
      activeEffort = params.value;
      return {
        configOptions: [
          { id: 'model', name: 'Model', type: 'select', currentValue: activeModel, options: [{ value: activeModel, name: activeModel }] },
          { id: 'reasoning', name: 'Reasoning', type: 'select', currentValue: activeEffort, options: [{ value: activeEffort, name: activeEffort }] },
        ],
      };
    }
    return { configOptions: [{ id: params.configId, type: 'boolean', currentValue: params.value }] };
  }

  async extMethod(method, params) {
    if (method === '_codex/session/steer') {
      if (!activeSteerTurn || activeSteerTurn.sessionId !== params.sessionId) {
        const error = new Error('No active Codex turn to steer');
        error.data = { details: 'no active turn to steer' };
        throw error;
      }
      const promptText = params.prompt?.map(block => block.type === 'text' ? block.text : '').join('') || '';
      for (const content of params.prompt || []) {
        await client.sessionUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: 'user_message_chunk',
            messageId: params.clientMessageId,
            content,
            _meta: { codex: { steer: true, turnId: activeSteerTurn.turnId } },
          },
        });
      }
      await client.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: `steer-accepted-answer-${activeSteerTurn.received + 1}`,
          content: { type: 'text', text: `Steer accepted: ${promptText}` },
        },
      });
      activeSteerTurn.received += 1;
      const turnId = activeSteerTurn.turnId;
      if (activeSteerTurn.received >= activeSteerTurn.expected) {
        const turn = activeSteerTurn;
        activeSteerTurn = null;
        turn.release();
      }
      return { turnId };
    }
    if (method !== 'session/set_model') throw new Error(`Unsupported extension method: ${method}`);
    refreshedModelId = params.modelId;
    const match = refreshedModelId.match(/^(.+)\[([^\]]+)]$/);
    if (match) {
      activeModel = match[1];
      activeEffort = match[2];
    }
    return {};
  }

  async authenticate() {
    return {};
  }

  async logout() {
    return {};
  }

  async prompt(params) {
    const promptText = params.prompt?.map(block => block.type === 'text' ? block.text : '').join('') || '';
    const imageCount = params.prompt?.filter(block => block.type === 'image').length || 0;
    if (promptText.includes('mobile interrupt')) {
      await client.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'mobile-interrupt-waiting',
          content: { type: 'text', text: 'Mobile interrupt waiting.' },
        },
      });
      await new Promise(resolve => cancelledSessions.set(params.sessionId, resolve));
      cancelledSessions.delete(params.sessionId);
      await client.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'mobile-interrupt-stopped',
          content: { type: 'text', text: 'Mobile interrupt stopped.' },
        },
      });
      return { stopReason: 'cancelled' };
    }
    if (promptText.includes('hold for steer') || promptText.includes('hold for two steers')) {
      let releaseSteerTurn;
      const steerTurnReleased = new Promise(resolve => { releaseSteerTurn = resolve; });
      activeSteerTurn = {
        sessionId: params.sessionId,
        turnId: 'fake-active-turn',
        expected: promptText.includes('two steers') ? 2 : 1,
        received: 0,
        release: releaseSteerTurn,
      };
      await client.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'steer-ready',
          content: { type: 'text', text: 'Waiting for steering.' },
        },
      });
      await steerTurnReleased;
      return { stopReason: 'end_turn' };
    }
    if (promptText.includes('phase-aware mermaid')) {
      await client.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'phase-aware-commentary',
          content: { type: 'text', text: 'Checking the final-answer phase.' },
          _meta: { codex: { phase: 'commentary' } },
        },
      });
      await client.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'phase-aware-final',
          content: {
            type: 'text',
            text: 'Phase-aware rich answer.\n\n```mermaid\nsequenceDiagram\n    participant G as Git\n    participant R as Repository\n    G->>R: Register .git/worktrees/&lt;id&gt;\n```',
          },
          _meta: { codex: { phase: 'final_answer' } },
        },
      });
      await client.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'agent_thought_chunk',
          messageId: 'phase-aware-trailing-thought',
          content: { type: 'text', text: 'Trailing replay thought.' },
        },
      });
      return { stopReason: 'end_turn' };
    }
    if (promptText.includes('image attachment')) {
      await client.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'image-attachment-answer',
          content: { type: 'text', text: `Received ${imageCount} image.` },
        },
      });
      return { stopReason: 'end_turn' };
    }
    if (promptText.includes('applied edit')) {
      const files = promptText.includes('conflict')
        ? ['decision-conflict.txt']
        : ['decision-keep.txt', 'decision-revert.txt'];
      const content = files.map(file => {
        const target = path.join(process.cwd(), file);
        const oldText = fs.readFileSync(target, 'utf8');
        const newText = `after ${file}\n`;
        fs.writeFileSync(target, newText);
        return { type: 'diff', path: target, oldText, newText };
      });
      await client.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: promptText.includes('conflict') ? 'decision-conflict-tool' : 'decision-tool',
          title: 'Apply reviewed edits',
          kind: 'edit',
          status: 'completed',
          content,
        },
      });
      await client.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: promptText.includes('conflict') ? 'decision-conflict-answer' : 'decision-answer',
          content: { type: 'text', text: 'Applied edit complete.' },
        },
      });
      return { stopReason: 'end_turn' };
    }
    if (promptText.includes('markdown typography')) {
      await client.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'markdown-typography-answer',
          content: {
            type: 'text',
            text: [
              'Typography baseline.',
              '',
              '## Readability heading',
              '',
              '```js',
              "const primary = 'code content'",
              'return primary',
              '```',
              '',
              '| Column | Value |',
              '| --- | --- |',
              '| Readability | Primary |',
              '',
              '> Quoted reading content.',
              '',
              'Inline `metadata` stays compact.',
              '',
              '[Safe docs](https://example.com) [unsafe](javascript:window.__crtMarkdownUnsafe=true)',
              '',
              '<script>window.__crtMarkdownUnsafe = true</script>',
            ].join('\n'),
          },
        },
      });
      return { stopReason: 'end_turn' };
    }
    if (promptText.includes('crt math mermaid')) {
      await client.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'crt-math-mermaid-answer',
          content: {
            type: 'text',
            text: [
              'Formula and diagram baseline.',
              '',
              'Inline math $E = mc^2$ remains in the sentence.',
              '',
              '$$',
              String.raw`\int_0^1 x^2\,dx = \frac{1}{3}`,
              '$$',
              '',
              '```mermaid',
              'flowchart LR',
              '  plan[Plan] --> build[Build]',
              '```',
            ].join('\n'),
          },
        },
      });
      return { stopReason: 'end_turn' };
    }
    if (promptText.includes('crt invalid mermaid')) {
      await client.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'crt-invalid-mermaid-answer',
          content: {
            type: 'text',
            text: [
              'Invalid diagram baseline.',
              '',
              '```mermaid',
              'this is not a diagram',
              '```',
            ].join('\n'),
          },
        },
      });
      return { stopReason: 'end_turn' };
    }
    if (promptText.includes('rich timeline')) {
      const releaseStory = promptText.includes('release readiness story');
      await client.sessionUpdate({
        sessionId: params.sessionId,
        update: { sessionUpdate: 'usage_update', used: 53_000, size: 200_000, cost: { amount: 0.045, currency: 'USD' } },
      });
      await client.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'available_commands_update',
          availableCommands: [{ name: 'review', description: 'Review the current changes', input: { hint: 'optional focus' } }],
        },
      });
      await client.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'plan',
          entries: releaseStory ? [
            { content: 'Trace the authoritative checkpoint state', priority: 'high', status: 'completed' },
            { content: 'Exercise reconnect and gap recovery', priority: 'high', status: 'in_progress' },
            { content: 'Verify release gates and residual risk', priority: 'medium', status: 'pending' },
          ] : [
            { content: 'Inspect the source', priority: 'high', status: 'completed' },
            { content: 'Apply the change', priority: 'medium', status: 'in_progress' },
            { content: 'Verify the result', priority: 'medium', status: 'pending' },
          ],
        },
      });
      await client.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'rich-progress-1',
          content: {
            type: 'text',
            text: releaseStory
              ? 'The PTY host owns the exact screen state. I am checking reconnect, hidden-page resume, and cross-skin continuity against that boundary.'
              : 'I found the display boundary and am checking the typed ACP content.',
          },
        },
      });
      await client.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'agent_thought_chunk',
          messageId: 'rich-thought-1',
          content: {
            type: 'text',
            text: releaseStory
              ? 'A reconnect is safe only when one exact checkpoint is installed before contiguous later transitions resume.'
              : 'The ordered stream must stay reversible.',
          },
        },
      });
      await client.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'rich-read-tool',
          title: releaseStory ? 'Inspect terminal recovery protocol' : 'Read ACP display fixtures',
          kind: 'read',
          status: 'completed',
          locations: [{ path: path.join(process.cwd(), releaseStory ? 'docs/products/code/terminal-state-protocol.md' : 'README.md'), line: 1 }],
          rawInput: { path: releaseStory ? 'docs/products/code/terminal-state-protocol.md' : 'README.md' },
          content: [
            { type: 'content', content: { type: 'text', text: 'Typed tool result' } },
            { type: 'content', content: { type: 'resource_link', name: 'ACP reference', uri: 'https://agentclientprotocol.com/', mimeType: 'text/html' } },
            { type: 'content', content: { type: 'resource', resource: { uri: 'file:///tmp/acp-note.txt', mimeType: 'text/plain', text: 'Embedded ACP note' } } },
            { type: 'content', content: { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=' } },
            { type: 'content', content: { type: 'audio', mimeType: 'audio/wav', data: 'UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=' } },
          ],
        },
      });
      await client.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'rich-edit-tool',
          title: releaseStory ? 'Update recovery invariant test' : 'Edit display fixture',
          kind: 'edit',
          status: 'completed',
          content: [{
            type: 'diff',
            path: path.join(process.cwd(), releaseStory ? 'tests/e2e/terminal-cross-skin-recovery.spec.ts' : 'display-fixture.txt'),
            oldText: releaseStory ? 'expect(view.outputSeq).toBe(3)\n' : 'before\n',
            newText: releaseStory ? 'expect(view.outputSeq).toBe(checkpoint.outputSeq + 1)\n' : 'after\n',
          }],
        },
      });
      const terminal = await client.createTerminal({
        sessionId: params.sessionId,
        command: process.execPath,
        args: ['-e', "process.stdout.write('rich-terminal-output')"],
        cwd: process.cwd(),
      });
      await terminal.waitForExit();
      await client.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'rich-terminal-tool',
          title: releaseStory ? 'Run cross-skin verification' : 'Run verification command',
          kind: 'execute',
          status: 'completed',
          content: [{ type: 'terminal', terminalId: terminal.id }],
        },
      });
      await client.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'plan',
          entries: releaseStory ? [
            { content: 'Trace the authoritative checkpoint state', priority: 'high', status: 'completed' },
            { content: 'Exercise reconnect and gap recovery', priority: 'high', status: 'completed' },
            { content: 'Verify release gates and residual risk', priority: 'medium', status: 'completed' },
          ] : [
            { content: 'Inspect the source', priority: 'high', status: 'completed' },
            { content: 'Apply the change', priority: 'medium', status: 'completed' },
            { content: 'Verify the result', priority: 'medium', status: 'completed' },
          ],
        },
      });
      await client.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'rich-answer',
          content: {
            type: 'text',
            text: releaseStory
              ? [
                  '### Release decision · Ready',
                  '',
                  'Release readiness is confirmed.',
                  '',
                  '| Gate | Evidence | Result |',
                  '| --- | --- | --- |',
                  '| Source + backend | 182 checks | Passed |',
                  '| Cross-skin recovery | 12 scenarios | Passed |',
                  '| Terminal input | p95 59 ms / 250 ms | Passed |',
                  '| Release artifacts | 6 bundles verified | Passed |',
                  '',
                  '**What is now proven**',
                  '',
                  '- Code and CRT restore one exact checkpoint before live output resumes.',
                  '- Gap, epoch change, and hidden-page recovery converge on the authoritative PTY state.',
                  '',
                  '**Residual risk:** none in the supported WebGL path.',
                ].join('\n')
              : 'Rich ACP timeline complete.',
          },
        },
      });
      return { stopReason: 'end_turn' };
    }
    if (promptText.includes('live progress')) {
      await client.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'live-command',
          title: 'PORT=4187 FARMING_PLAYWRIGHT_PORT=4187 FARMING_BASE_PATH=/farming node ./scripts/run-long-command.js --verify-mobile-composer-focus',
          kind: 'execute',
          status: 'in_progress',
          rawInput: { command: 'PORT=4187 FARMING_PLAYWRIGHT_PORT=4187 FARMING_BASE_PATH=/farming node ./scripts/run-long-command.js --verify-mobile-composer-focus' },
        },
      });
      for (const [index, text] of ['Inspecting files', 'Editing display data', 'Running checks'].entries()) {
        await client.sessionUpdate({
          sessionId: params.sessionId,
          update: { sessionUpdate: 'agent_message_chunk', messageId: `live-progress-${index}`, content: { type: 'text', text } },
        });
        // Keep the turn active long enough for browser tests to exercise the
        // real queued-follow-up controls instead of racing an instant fixture.
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      await client.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'live-command',
          status: 'completed',
          rawOutput: { stdout: 'checks passed\n', stderr: '', exitCode: 0 },
        },
      });
      await client.sessionUpdate({
        sessionId: params.sessionId,
        update: { sessionUpdate: 'agent_message_chunk', messageId: 'live-answer', content: { type: 'text', text: 'Live progress complete.' } },
      });
      return { stopReason: 'end_turn' };
    }
    if (promptText.includes('streaming thought')) {
      await client.sessionUpdate({
        sessionId: params.sessionId,
        update: { sessionUpdate: 'agent_thought_chunk', messageId: 'streaming-thought-1', content: { type: 'text', text: 'Comparing the likely causes' } },
      });
      await new Promise(resolve => setTimeout(resolve, 700));
      await client.sessionUpdate({
        sessionId: params.sessionId,
        update: { sessionUpdate: 'agent_thought_chunk', messageId: 'streaming-thought-1', content: { type: 'text', text: ' and checking the strongest one.' } },
      });
      await new Promise(resolve => setTimeout(resolve, 700));
      await client.sessionUpdate({
        sessionId: params.sessionId,
        update: { sessionUpdate: 'agent_message_chunk', messageId: 'streaming-thought-answer', content: { type: 'text', text: 'Streaming thought complete.' } },
      });
      return { stopReason: 'end_turn' };
    }
    if (promptText.includes('scroll stability')) {
      const opening = Array.from(
        { length: 48 },
        (_, index) => `Reading paragraph ${String(index + 1).padStart(2, '0')}: keep this viewport stable while the answer continues below.`,
      ).join('\n\n');
      await client.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'scroll-stability-answer',
          content: { type: 'text', text: opening },
        },
      });
      await new Promise(resolve => setTimeout(resolve, 900));
      for (let index = 1; index <= 6; index += 1) {
        await client.sessionUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            messageId: 'scroll-stability-answer',
            content: { type: 'text', text: `\n\nStreaming tail ${index}: additional text arrived without taking over the reader's viewport.` },
          },
        });
        await new Promise(resolve => setTimeout(resolve, 260));
      }
      return { stopReason: 'end_turn' };
    }
    if (promptText.includes('usage warning')) {
      await client.sessionUpdate({
        sessionId: params.sessionId,
        update: { sessionUpdate: 'usage_update', used: 190_000, size: 200_000, cost: { amount: 0.125, currency: 'USD' } },
      });
      await client.sessionUpdate({
        sessionId: params.sessionId,
        update: { sessionUpdate: 'agent_message_chunk', messageId: 'usage-warning-answer', content: { type: 'text', text: 'Usage warning published.' } },
      });
      return { stopReason: 'end_turn' };
    }
    if (promptText.includes('failed tool')) {
      await client.sessionUpdate({
        sessionId: params.sessionId,
        update: { sessionUpdate: 'tool_call', toolCallId: 'failed-tool', title: 'Run failing check', kind: 'execute', status: 'in_progress' },
      });
      await client.sessionUpdate({
        sessionId: params.sessionId,
        update: { sessionUpdate: 'tool_call_update', toolCallId: 'failed-tool', status: 'failed', rawOutput: { exitCode: 1, stderr: 'fixture failed' } },
      });
      await client.sessionUpdate({
        sessionId: params.sessionId,
        update: { sessionUpdate: 'agent_message_chunk', messageId: 'failed-answer', content: { type: 'text', text: 'The check failed; no files were changed.' } },
      });
      return { stopReason: 'end_turn' };
    }
    if (promptText.includes('unicode permission')) {
      const permission = await client.requestPermission({
        sessionId: params.sessionId,
        toolCall: {
          toolCallId: 'unicode-tool',
          title: 'Connect to requested host',
          kind: 'execute',
          _meta: {
            sandbox_authorization: {
              command: 'curl https://xn--pple-43d.com',
              network_hosts: ['xn--pple-43d.com'],
              write_paths: [`${process.cwd()}/safe\u200Bpath`],
              reason: 'Verify the external fixture',
            },
          },
        },
        options: [
          { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'allow_always', name: 'Always allow', kind: 'allow_always' },
          { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
        ],
      });
      await client.sessionUpdate({
        sessionId: params.sessionId,
        update: { sessionUpdate: 'agent_message_chunk', messageId: 'unicode-answer', content: { type: 'text', text: `Unicode permission: ${permission.outcome.outcome}` } },
      });
      return { stopReason: 'end_turn' };
    }
    if (promptText.includes('subagent elicitation')) {
      const childSessionId = 'acp-input-child-session';
      await client.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'input-subagent-tool',
          title: 'Clarify with subagent',
          kind: 'other',
          status: 'in_progress',
          _meta: { subagent_session_info: { session_id: childSessionId, message_start_index: 0 } },
        },
      });
      await client.sessionUpdate({
        sessionId: childSessionId,
        update: { sessionUpdate: 'user_message_chunk', messageId: 'input-child-user', content: { type: 'text', text: 'Confirm the child scope' } },
      });
      const elicitation = await client.unstable_createElicitation({
        sessionId: childSessionId,
        mode: 'form',
        message: 'Confirm the subagent scope',
        requestedSchema: {
          type: 'object',
          required: ['confirmed'],
          properties: { confirmed: { type: 'boolean', title: 'Confirmed for subagent' } },
        },
      });
      await client.sessionUpdate({
        sessionId: childSessionId,
        update: { sessionUpdate: 'agent_message_chunk', messageId: 'input-child-answer', content: { type: 'text', text: `Child confirmed: ${elicitation.content?.confirmed === true}` } },
      });
      await client.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'input-subagent-tool',
          status: 'completed',
          _meta: { subagent_session_info: { session_id: childSessionId, message_start_index: 0, message_end_index: 1 } },
        },
      });
      await client.sessionUpdate({
        sessionId: params.sessionId,
        update: { sessionUpdate: 'agent_message_chunk', messageId: 'input-subagent-answer', content: { type: 'text', text: 'Subagent input complete.' } },
      });
      return { stopReason: 'end_turn' };
    }
    if (promptText.includes('subagent preview')) {
      const childSessionId = 'acp-child-session';
      await client.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'subagent-tool',
          title: 'Inspect with subagent',
          kind: 'other',
          status: 'in_progress',
          _meta: { subagent_session_info: { session_id: childSessionId, message_start_index: 0 } },
        },
      });
      await client.sessionUpdate({
        sessionId: childSessionId,
        update: { sessionUpdate: 'user_message_chunk', messageId: 'child-user', content: { type: 'text', text: 'Inspect the parser' } },
      });
      await client.sessionUpdate({
        sessionId: childSessionId,
        update: { sessionUpdate: 'agent_thought_chunk', messageId: 'child-thought', content: { type: 'text', text: 'Reading parser files' } },
      });
      await client.sessionUpdate({
        sessionId: childSessionId,
        update: {
          sessionUpdate: 'plan',
          entries: [
            { content: 'Inspect parser state', status: 'completed', priority: 'high' },
            { content: 'Verify parser output', status: 'in_progress', priority: 'medium' },
          ],
        },
      });
      await client.sessionUpdate({
        sessionId: childSessionId,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'child-read-tool',
          title: 'Read parser fixture',
          kind: 'read',
          status: 'completed',
          content: [{ type: 'content', content: { type: 'text', text: 'Parser state is valid.' } }],
        },
      });
      await client.sessionUpdate({
        sessionId: childSessionId,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'child-edit-tool',
          title: 'Edit parser fixture',
          kind: 'edit',
          status: 'completed',
          content: [{ type: 'diff', path: 'parser-fixture.txt', oldText: 'old\n', newText: 'new\n' }],
        },
      });
      await client.sessionUpdate({
        sessionId: childSessionId,
        update: { sessionUpdate: 'agent_message_chunk', messageId: 'child-answer', content: { type: 'text', text: 'The parser is consistent.' } },
      });
      await client.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'subagent-tool',
          status: 'completed',
          _meta: { subagent_session_info: { session_id: childSessionId, message_start_index: 0, message_end_index: 2 } },
        },
      });
      await client.sessionUpdate({
        sessionId: params.sessionId,
        update: { sessionUpdate: 'agent_message_chunk', messageId: 'subagent-answer', content: { type: 'text', text: 'Subagent inspection complete.' } },
      });
      return { stopReason: 'end_turn' };
    }
    if (promptText.includes('long subagent')) {
      const childSessionId = 'acp-long-child-session';
      await client.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'long-subagent-tool',
          title: 'Investigate with subagent',
          kind: 'other',
          status: 'in_progress',
          _meta: { subagent_session_info: { session_id: childSessionId, message_start_index: 0 } },
        },
      });
      await client.sessionUpdate({
        sessionId: childSessionId,
        update: { sessionUpdate: 'user_message_chunk', messageId: 'long-child-user', content: { type: 'text', text: 'Inspect the long-running task' } },
      });
      await client.sessionUpdate({
        sessionId: childSessionId,
        update: { sessionUpdate: 'agent_thought_chunk', messageId: 'long-child-thought', content: { type: 'text', text: 'Checking the first candidate' } },
      });
      await new Promise(resolve => cancelledSessions.set(childSessionId, resolve));
      cancelledSessions.delete(childSessionId);
      await client.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'long-subagent-tool',
          status: 'cancelled',
          _meta: { subagent_session_info: { session_id: childSessionId, message_start_index: 0, message_end_index: 1 } },
        },
      });
      await client.sessionUpdate({
        sessionId: params.sessionId,
        update: { sessionUpdate: 'agent_message_chunk', messageId: 'long-subagent-answer', content: { type: 'text', text: 'Subagent stopped.' } },
      });
      return { stopReason: 'cancelled' };
    }
    if (promptText.includes('client services')) {
      const filePath = path.join(process.cwd(), 'acp-client-roundtrip.txt');
      await client.writeTextFile({ sessionId: params.sessionId, path: filePath, content: 'filesystem-ok' });
      const file = await client.readTextFile({ sessionId: params.sessionId, path: filePath });
      const terminal = await client.createTerminal({
        sessionId: params.sessionId,
        command: process.execPath,
        args: ['-e', "process.stdout.write('terminal-ok')"],
        cwd: process.cwd(),
      });
      const exit = await terminal.waitForExit();
      const output = await terminal.currentOutput();
      const elicitation = await client.unstable_createElicitation({
        sessionId: params.sessionId,
        mode: 'form',
        message: 'Confirm the protocol round trip',
        requestedSchema: {
          type: 'object',
          required: ['confirmed'],
          properties: { confirmed: { type: 'boolean', title: 'Confirmed' } },
        },
      });
      await client.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'client-terminal-tool',
          title: 'Run client terminal',
          kind: 'execute',
          status: 'completed',
          content: [{ type: 'terminal', terminalId: terminal.id }],
        },
      });
      await terminal.release();
      await client.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'client-services-answer',
          content: {
            type: 'text',
            text: `${file.content}; ${output.output}; exit=${exit.exitCode}; confirmed=${elicitation.content?.confirmed === true}`,
          },
        },
      });
      return { stopReason: 'end_turn' };
    }
    if (promptText.includes('long terminal')) {
      const terminal = await client.createTerminal({
        sessionId: params.sessionId,
        command: process.execPath,
        args: ['-e', "process.stdout.write('long-terminal-ready\\n'); setInterval(() => {}, 1000)"],
        cwd: process.cwd(),
      });
      await client.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'long-terminal-tool',
          title: 'Run long command',
          kind: 'execute',
          status: 'in_progress',
          content: [{ type: 'terminal', terminalId: terminal.id }],
        },
      });
      const exit = await terminal.waitForExit();
      await client.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'long-terminal-tool',
          status: exit.signal ? 'cancelled' : 'completed',
        },
      });
      await client.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'long-terminal-answer',
          content: { type: 'text', text: exit.signal ? 'Long command stopped.' : 'Long command completed.' },
        },
      });
      return { stopReason: 'end_turn' };
    }
    if (promptText.includes('interactive terminal')) {
      const terminal = await client.createTerminal({
        sessionId: params.sessionId,
        command: process.execPath,
        args: ['-e', "process.stdin.setEncoding('utf8'); process.stdout.write('name> '); process.stdin.once('data', value => { process.stdout.write('hello ' + value.trim()); process.exit(0); })"],
        cwd: process.cwd(),
      });
      await client.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'interactive-terminal-tool',
          title: 'Ask in terminal',
          kind: 'execute',
          status: 'in_progress',
          content: [{ type: 'terminal', terminalId: terminal.id }],
        },
      });
      const exit = await terminal.waitForExit();
      const output = await terminal.currentOutput();
      await client.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'interactive-terminal-tool',
          status: exit.exitCode === 0 ? 'completed' : 'failed',
        },
      });
      await client.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'interactive-terminal-answer',
          content: { type: 'text', text: `Interactive terminal completed: ${output.output.trim()}` },
        },
      });
      return { stopReason: 'end_turn' };
    }
    if (promptText.includes('authentication error')) {
      const error = new Error('401 Unauthorized: sign in required');
      error.code = 401;
      throw error;
    }
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

  async cancel(params) {
    cancelledSessions.get(params?.sessionId)?.();
  }
}

new AgentSideConnection(
  connection => {
    client = connection;
    return new FakeAgent();
  },
  ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin))
);
