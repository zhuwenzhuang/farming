#!/usr/bin/env node
/**
 * Codex App Server transcript/display consistency smoke for Farming.
 *
 * Default mode is local and deterministic: it covers 20+ App Server event
 * shapes/content variants without calling a model. Set
 * FARMING_REAL_CODEX_DISPLAY_SMOKE=1 to also send 20 tiny real prompts through
 * Codex App Server and compare the sent prompt against Farming's transcript
 * projection, which is what the UI consumes.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CodexAppServerRuntime } = require('../backend/codex-app-server-runtime');
const { ensureCodexAppServerHome } = require('../backend/codex-app-server-home');
const { resolveCompatibleCodexExecutable } = require('../backend/executable-discovery');
const { buildTranscriptFromLines, readCodexTranscript } = require('../backend/codex-transcript');

const INTERNAL_CONTEXT_MARKERS = [
  '<recommended_plugins>',
  '<environment_context>',
  '<codex_internal_context',
  '# AGENTS.md instructions',
  '<INSTRUCTIONS>',
  '<permissions instructions>',
  '<skills_instructions>',
  '<plugins_instructions>',
];

function line(type, payload) {
  return JSON.stringify({ type, payload });
}

function event(type, payload = {}) {
  return line('event_msg', { type, ...payload });
}

function notification(method, params = {}) {
  return JSON.stringify({ jsonrpc: '2.0', method, params });
}

function responseMessage({ id, role = 'user', text, turnId = '', turnIdStyle = 'snake', phase = '' }) {
  const payload = {
    type: 'message',
    role,
    id,
    content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }],
  };
  if (phase) payload.phase = phase;
  if (turnId) {
    const metadata = turnIdStyle === 'camel' ? { turnId } : { turn_id: turnId };
    const key = turnIdStyle === 'camel'
      ? 'internalChatMessageMetadataPassthrough'
      : 'internal_chat_message_metadata_passthrough';
    payload[key] = metadata;
  }
  return line('response_item', payload);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function assertNoInternalMarkers(turn, name) {
  const combined = [
    turn.userMessage,
    turn.finalMessage,
    ...(turn.processItems || []).flatMap(item => [item.title, item.detail]),
  ].join('\n');
  for (const marker of INTERNAL_CONTEXT_MARKERS) {
    assert(
      !combined.includes(marker),
      `${name}: displayed transcript must not include internal marker ${JSON.stringify(marker)}`
    );
  }
}

function assertDisplayedTurn({ turn, prompt, expectedAnswer, name = prompt }) {
  assert.strictEqual(turn.userMessage, prompt, `${name}: displayed user message must equal the sent human prompt`);
  assert(String(turn.finalMessage || '').trim(), `${name}: displayed final message must not be empty`);
  assert(
    String(turn.finalMessage || '').includes(expectedAnswer),
    `${name}: displayed final message must contain the expected answer`,
  );
  assertNoInternalMarkers(turn, name);
}

function fixtureCoverageCases() {
  return [
    {
      name: 'response_item filters recommended plugins before real prompt',
      lines: [
        responseMessage({
          id: 'recommended',
          text: '<recommended_plugins>\n- GitHub (github@openai-curated-remote)\n</recommended_plugins>',
        }),
        line('turn_context', { turn_id: 'fixture-1', model: 'codex-spark' }),
        responseMessage({ id: 'user-1', text: '真实问题 1', turnId: 'fixture-1' }),
        responseMessage({ id: 'assistant-1', role: 'assistant', text: '真实回答 1', turnId: 'fixture-1', phase: 'final_answer' }),
        event('turn_complete', { turn_id: 'fixture-1' }),
      ],
      expected: [{ id: 'fixture-1', user: '真实问题 1', final: '真实回答 1' }],
    },
    {
      name: 'developer permissions response_item is ignored',
      lines: [
        responseMessage({
          id: 'developer-permissions',
          role: 'developer',
          text: '<permissions instructions>\nsecret policy\n</permissions instructions>',
        }),
        event('user_message', { turn_id: 'fixture-2', message: '权限后真实问题' }),
        event('agent_message', { turn_id: 'fixture-2', message: '权限后真实回答', phase: 'final_answer' }),
      ],
      expected: [{ id: 'fixture-2', user: '权限后真实问题', final: '权限后真实回答' }],
    },
    {
      name: 'AGENTS and environment bootstrap are ignored',
      lines: [
        responseMessage({
          id: 'agents-bootstrap',
          text: '# AGENTS.md instructions for /repo\n\n<INSTRUCTIONS>\nhidden\n</INSTRUCTIONS>\n\n<environment_context>\n<cwd>/repo</cwd>\n</environment_context>',
        }),
        event('user_message', { turn_id: 'fixture-3', message: 'bootstrap 后的真实问题' }),
        event('agent_message', { turn_id: 'fixture-3', message: 'bootstrap 后的真实回答', phase: 'final_answer' }),
      ],
      expected: [{ id: 'fixture-3', user: 'bootstrap 后的真实问题', final: 'bootstrap 后的真实回答' }],
    },
    {
      name: 'camelCase metadata turn id ties response items together',
      lines: [
        responseMessage({ id: 'user-4', text: 'camel turn id 问题', turnId: 'fixture-4', turnIdStyle: 'camel' }),
        responseMessage({ id: 'assistant-4', role: 'assistant', text: 'camel turn id 回答', turnId: 'fixture-4', turnIdStyle: 'camel', phase: 'final_answer' }),
      ],
      expected: [{ id: 'fixture-4', user: 'camel turn id 问题', final: 'camel turn id 回答' }],
    },
    {
      name: 'raw_response_item user message',
      lines: [
        event('raw_response_item', {
          turn_id: 'fixture-5',
          item: {
            type: 'message',
            id: 'raw-user-5',
            role: 'user',
            content: [{ type: 'input_text', text: 'raw response item 问题' }],
          },
        }),
        event('agent_message', { turn_id: 'fixture-5', message: 'raw response item 回答', phase: 'final_answer' }),
      ],
      expected: [{ id: 'fixture-5', user: 'raw response item 问题', final: 'raw response item 回答' }],
    },
    {
      name: 'plain event_msg user_message',
      lines: [
        event('user_message', { turn_id: 'fixture-6', message: 'event_msg 问题' }),
        event('agent_message', { turn_id: 'fixture-6', message: 'event_msg 回答', phase: 'final_answer' }),
      ],
      expected: [{ id: 'fixture-6', user: 'event_msg 问题', final: 'event_msg 回答' }],
    },
    {
      name: 'item completed ThreadItem userMessage',
      lines: [
        notification('item/completed', {
          turnId: 'fixture-7',
          item: { type: 'userMessage', id: 'item-user-7', content: [{ type: 'text', text: 'item completed 问题' }] },
        }),
        event('agent_message', { turn_id: 'fixture-7', message: 'item completed 回答', phase: 'final_answer' }),
      ],
      expected: [{ id: 'fixture-7', user: 'item completed 问题', final: 'item completed 回答' }],
    },
    {
      name: 'thread items list snapshot',
      lines: [
        line('thread/items/list', {
          turnId: 'fixture-8',
          data: [
            { type: 'userMessage', id: 'list-user-8', content: [{ type: 'text', text: 'items list 问题' }] },
            { type: 'agentMessage', id: 'list-agent-8', text: 'items list 回答', phase: 'final_answer' },
          ],
        }),
      ],
      expected: [{ id: 'fixture-8', user: 'items list 问题', final: 'items list 回答' }],
    },
    {
      name: 'thread read snapshot',
      lines: [
        line('thread/read', {
          thread: {
            turns: [{
              id: 'fixture-9',
              status: 'completed',
              items: [
                { type: 'userMessage', id: 'read-user-9', content: [{ type: 'text', text: 'thread read 问题' }] },
                { type: 'agentMessage', id: 'read-agent-9', text: 'thread read 回答', phase: 'final_answer' },
              ],
            }],
          },
        }),
      ],
      expected: [{ id: 'fixture-9', user: 'thread read 问题', final: 'thread read 回答' }],
    },
    {
      name: 'turn snapshot',
      lines: [
        line('turn/snapshot', {
          turn: {
            id: 'fixture-10',
            status: 'completed',
            items: [
              { type: 'userMessage', id: 'snap-user-10', content: [{ type: 'text', text: 'turn snapshot 问题' }] },
              { type: 'agentMessage', id: 'snap-agent-10', text: 'turn snapshot 回答', phase: 'final_answer' },
            ],
          },
        }),
      ],
      expected: [{ id: 'fixture-10', user: 'turn snapshot 问题', final: 'turn snapshot 回答' }],
    },
    {
      name: 'realtime transcript done',
      lines: [
        line('thread/realtime/transcript/done', { turnId: 'fixture-11', role: 'user', text: 'realtime done 问题' }),
        line('thread/realtime/transcript/done', { turnId: 'fixture-11', role: 'assistant', text: 'realtime done 回答' }),
      ],
      expected: [{ id: 'fixture-11', user: 'realtime done 问题', final: 'realtime done 回答' }],
    },
    {
      name: 'realtime transcript deltas',
      lines: [
        line('thread/realtime/transcript/delta', { turnId: 'fixture-12', role: 'user', delta: 'delta ' }),
        line('thread/realtime/transcript/done', { turnId: 'fixture-12', role: 'user', text: 'delta 问题' }),
        line('thread/realtime/transcript/delta', { turnId: 'fixture-12', role: 'assistant', delta: 'delta ' }),
        line('thread/realtime/transcript/done', { turnId: 'fixture-12', role: 'assistant', text: 'delta 回答' }),
      ],
      expected: [{ id: 'fixture-12', user: 'delta 问题', final: 'delta 回答' }],
    },
    {
      name: 'user steer stays process item instead of replacing first prompt',
      lines: [
        event('user_message', { turn_id: 'fixture-13', message: '第一条问题' }),
        event('agent_message', { turn_id: 'fixture-13', message: '处理中', phase: 'progress' }),
        event('user_message', { turn_id: 'fixture-13', message: '补充条件' }),
        event('agent_message', { turn_id: 'fixture-13', message: '最终回答', phase: 'final_answer' }),
      ],
      expected: [{ id: 'fixture-13', user: '第一条问题', final: '最终回答', processType: 'user-steer' }],
    },
    {
      name: 'embedded codex internal context is stripped',
      lines: [
        event('user_message', {
          turn_id: 'fixture-14',
          message: '真实前缀\n<codex_internal_context source="goal">\nhidden\n</codex_internal_context>',
        }),
        event('agent_message', { turn_id: 'fixture-14', message: 'strip 回答', phase: 'final_answer' }),
      ],
      expected: [{ id: 'fixture-14', user: '真实前缀', final: 'strip 回答' }],
    },
    {
      name: 'app and skill context blocks are stripped',
      lines: [
        event('user_message', {
          turn_id: 'fixture-15',
          message: '真实 app 问题\n<app-context>\nhidden\n</app-context>\n<skills_instructions>\nhidden\n</skills_instructions>',
        }),
        event('agent_message', { turn_id: 'fixture-15', message: 'app context 回答', phase: 'final_answer' }),
      ],
      expected: [{ id: 'fixture-15', user: '真实 app 问题', final: 'app context 回答' }],
    },
    {
      name: 'response_item user image attachment keeps visible text',
      lines: [
        line('response_item', {
          type: 'message',
          role: 'user',
          id: 'image-user-16',
          internal_chat_message_metadata_passthrough: { turn_id: 'fixture-16' },
          content: [
            { type: 'input_text', text: '图片问题' },
            { type: 'input_image', image_url: 'data:image/png;base64,AAAA', name: 'demo.png' },
          ],
        }),
        responseMessage({ id: 'assistant-16', role: 'assistant', text: '图片回答', turnId: 'fixture-16', phase: 'final_answer' }),
      ],
      expected: [{ id: 'fixture-16', user: '图片问题', final: '图片回答', images: 1 }],
    },
    {
      name: 'composer file attachment is represented separately',
      lines: [
        event('user_message', {
          turn_id: 'fixture-17',
          message: '文件问题\n\nAttached file: demo.txt\nhello from file',
        }),
        event('agent_message', { turn_id: 'fixture-17', message: '文件回答', phase: 'final_answer' }),
      ],
      expected: [{ id: 'fixture-17', user: '文件问题', final: '文件回答', files: 1 }],
    },
    {
      name: 'assistant progress internal context is stripped from process item',
      lines: [
        event('user_message', { turn_id: 'fixture-18', message: '过程项问题' }),
        event('agent_message', {
          turn_id: 'fixture-18',
          message: '可见过程\n<codex_internal_context source="goal">\nhidden\n</codex_internal_context>',
          phase: 'progress',
        }),
        event('agent_message', { turn_id: 'fixture-18', message: '过程项回答', phase: 'final_answer' }),
      ],
      expected: [{ id: 'fixture-18', user: '过程项问题', final: '过程项回答', processType: 'message' }],
    },
    {
      name: 'function call response items inherit turn id metadata',
      lines: [
        responseMessage({ id: 'user-19', text: '工具问题', turnId: 'fixture-19' }),
        line('response_item', {
          type: 'function_call',
          id: 'cmd-19',
          call_id: 'call-19',
          name: 'exec_command',
          arguments: JSON.stringify({ cmd: 'pwd' }),
          internal_chat_message_metadata_passthrough: { turn_id: 'fixture-19' },
        }),
        line('response_item', {
          type: 'function_call_output',
          call_id: 'call-19',
          output: 'ok',
          internal_chat_message_metadata_passthrough: { turn_id: 'fixture-19' },
        }),
        responseMessage({ id: 'assistant-19', role: 'assistant', text: '工具回答', turnId: 'fixture-19', phase: 'final_answer' }),
      ],
      expected: [{ id: 'fixture-19', user: '工具问题', final: '工具回答', processType: 'command' }],
    },
    {
      name: 'thread realtime itemAdded userMessage',
      lines: [
        line('thread/realtime/itemAdded', {
          turnId: 'fixture-20',
          item: { type: 'userMessage', id: 'realtime-item-user-20', content: [{ type: 'text', text: 'itemAdded 问题' }] },
        }),
        event('agent_message', { turn_id: 'fixture-20', message: 'itemAdded 回答', phase: 'final_answer' }),
      ],
      expected: [{ id: 'fixture-20', user: 'itemAdded 问题', final: 'itemAdded 回答' }],
    },
    {
      name: 'object content response_item text',
      lines: [
        line('response_item', {
          type: 'message',
          role: 'user',
          id: 'object-user-21',
          content: { type: 'input_text', text: 'object content 问题' },
          internal_chat_message_metadata_passthrough: { turn_id: 'fixture-21' },
        }),
        responseMessage({ id: 'assistant-21', role: 'assistant', text: 'object content 回答', turnId: 'fixture-21', phase: 'final_answer' }),
      ],
      expected: [{ id: 'fixture-21', user: 'object content 问题', final: 'object content 回答' }],
    },
    {
      name: 'text_elements user payload',
      lines: [
        event('user_message', {
          turn_id: 'fixture-22',
          text_elements: [{ text: 'text element A' }, { content: 'text element B' }],
        }),
        event('agent_message', { turn_id: 'fixture-22', message: 'text element 回答', phase: 'final_answer' }),
      ],
      expected: [{ id: 'fixture-22', user: 'text element A\n\ntext element B', final: 'text element 回答' }],
    },
  ];
}

function runFixtureCoverage() {
  const cases = fixtureCoverageCases();
  assert(cases.length >= 20, 'fixture coverage must include at least 20 App Server display scenarios');
  const report = [];
  for (const testCase of cases) {
    const turns = buildTranscriptFromLines(testCase.lines, { maxTurns: 50 });
    assert.strictEqual(
      turns.length,
      testCase.expected.length,
      `${testCase.name}: expected ${testCase.expected.length} turn(s), got ${turns.length}`
    );
    testCase.expected.forEach((expected, index) => {
      const turn = turns[index];
      assert.strictEqual(turn.id, expected.id, `${testCase.name}: turn id`);
      assert.strictEqual(turn.userMessage, expected.user, `${testCase.name}: displayed user message`);
      assert.strictEqual(turn.finalMessage, expected.final, `${testCase.name}: displayed final message`);
      assertNoInternalMarkers(turn, testCase.name);
      if (expected.processType) {
        assert(
          (turn.processItems || []).some(item => item.type === expected.processType),
          `${testCase.name}: expected process item type ${expected.processType}`
        );
      }
      if (Number.isFinite(expected.images)) {
        assert.strictEqual((turn.userImages || []).length, expected.images, `${testCase.name}: user image count`);
      }
      if (Number.isFinite(expected.files)) {
        assert.strictEqual((turn.userFiles || []).length, expected.files, `${testCase.name}: user file count`);
      }
      report.push({
        name: testCase.name,
        turnId: turn.id,
        displayedUserMessage: turn.userMessage,
        displayedFinalMessage: turn.finalMessage,
      });
    });
  }
  return report;
}

function waitForTurnCompletion(runtime, agentId, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      runtime.off('agent-runtime', onRuntimeEvent);
      reject(new Error(`Timed out waiting for ${agentId} turn completion`));
    }, timeoutMs);
    const onRuntimeEvent = event => {
      if (event.agentId !== agentId || event.state !== 'idle') return;
      clearTimeout(timer);
      runtime.off('agent-runtime', onRuntimeEvent);
      resolve(event);
    };
    runtime.on('agent-runtime', onRuntimeEvent);
  });
}

async function waitForDisplayedTurn({ threadId, codexHome, prompt, timeoutMs = 30_000 }) {
  const deadline = Date.now() + timeoutMs;
  let lastTranscript = null;
  while (Date.now() < deadline) {
    lastTranscript = await readCodexTranscript(threadId, {
      codexHome,
      maxTurns: 80,
    });
    const turn = (lastTranscript.turns || []).find(candidate => candidate.userMessage === prompt);
    if (turn && String(turn.finalMessage || '').trim()) {
      return { transcript: lastTranscript, turn };
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for displayed prompt "${prompt}". Last transcript: ${JSON.stringify(lastTranscript, null, 2)}`);
}

function realCodexCases() {
  const cases = [
    ['ascii exact', 'FARMING_DISPLAY_SMOKE_ASCII'],
    ['math prompt', 'FARMING_DISPLAY_SMOKE_FIVE'],
    ['中文 prompt', '中文展示正常'],
    ['json-looking content', 'FARMING_DISPLAY_SMOKE_JSON'],
    ['markdown content', 'FARMING_DISPLAY_SMOKE_MARKDOWN'],
    ['path line content', 'FARMING_DISPLAY_SMOKE_PATH'],
    ['url content', 'FARMING_DISPLAY_SMOKE_URL'],
    ['quoted content', 'FARMING_DISPLAY_SMOKE_QUOTES'],
    ['emoji content', 'FARMING_DISPLAY_SMOKE_EMOJI_OK'],
    ['bracket content', 'FARMING_DISPLAY_SMOKE_BRACKETS'],
    ['xml-looking visible content', 'FARMING_DISPLAY_SMOKE_XML_VISIBLE'],
    ['multiline prompt', 'FARMING_DISPLAY_SMOKE_MULTILINE'],
    ['colon prompt', 'FARMING_DISPLAY_SMOKE_COLON'],
    ['code fence prompt', 'FARMING_DISPLAY_SMOKE_CODE_FENCE'],
    ['dollar prompt', 'FARMING_DISPLAY_SMOKE_DOLLAR'],
    ['japanese prompt', '日本語表示正常'],
    ['korean prompt', '한국어표시정상'],
    ['full width punctuation', 'FARMING_DISPLAY_SMOKE_FULLWIDTH'],
    ['short yes no', 'FARMING_DISPLAY_SMOKE_SHORT'],
    ['final prompt', 'FARMING_DISPLAY_SMOKE_TWENTY'],
  ];
  return cases.map(([name, token], index) => ({
    name,
    prompt: [
      `Display consistency smoke ${index + 1}/20 (${name}).`,
      'Reply with exactly the token below and no explanation.',
      token,
    ].join('\n'),
    expectedAnswer: token,
  }));
}

function normalizeSmokeModel(value) {
  const model = String(value || '').trim();
  if (!model || model === 'codex-spark') return 'gpt-5.3-codex-spark';
  return model;
}

async function runRealCodexSmoke() {
  if (process.env.FARMING_REAL_CODEX_DISPLAY_SMOKE !== '1') return null;

  const resolved = resolveCompatibleCodexExecutable();
  if (!resolved.compatible || !resolved.path) {
    throw new Error(resolved.error || 'A compatible installed Codex CLI is required');
  }

  const tmpBase = process.platform === 'win32' ? os.tmpdir() : '/tmp';
  const root = await fs.promises.mkdtemp(path.join(tmpBase, 'fcd-'));
  const workspace = path.join(root, 'workspace');
  const configDir = path.join(root, 'farming');
  const sourceHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const codexHome = ensureCodexAppServerHome({
    configDir,
    agentId: 'agent-display-smoke',
    sourceHome,
  });
  const runtime = new CodexAppServerRuntime({ connectTimeoutMs: 15_000 });
  const model = normalizeSmokeModel(process.env.FARMING_REAL_CODEX_DISPLAY_MODEL);
  const reasoningEffort = process.env.FARMING_REAL_CODEX_DISPLAY_EFFORT || 'low';
  const agentId = 'real-display-smoke';
  const requestedLimit = Number(process.env.FARMING_REAL_CODEX_DISPLAY_CASE_LIMIT || 20);
  const cases = realCodexCases().slice(0, Math.max(1, Math.min(20, requestedLimit)));
  let keepRoot = false;

  try {
    await fs.promises.mkdir(workspace, { recursive: true });
    const prepared = await runtime.prepareAgent({
      agentId,
      codexHome,
      executable: resolved.path,
      env: { ...process.env, CODEX_HOME: codexHome },
      cwd: workspace,
      workspaceRoot: workspace,
      approvalMode: 'approve',
      model,
      reasoningEffort,
      serviceTier: 'default',
    });

    const report = [];
    for (const testCase of cases) {
      const completion = waitForTurnCompletion(runtime, agentId);
      const submitted = await runtime.submitComposerMessage({
        agentId,
        message: testCase.prompt,
        model,
        reasoningEffort,
      });
      await completion;
      const { turn, transcript } = await waitForDisplayedTurn({
        threadId: prepared.threadId,
        codexHome,
        prompt: testCase.prompt,
        expectedAnswer: testCase.expectedAnswer,
      });
      assertDisplayedTurn({ turn, prompt: testCase.prompt, expectedAnswer: testCase.expectedAnswer, name: testCase.name });
      report.push({
        name: testCase.name,
        submittedKind: submitted.kind,
        turnId: turn.id || submitted.turnId,
        sent: testCase.prompt,
        displayedUserMessage: turn.userMessage,
        displayedFinalMessage: turn.finalMessage,
        modelAnswerMatchesExpected: String(turn.finalMessage || '').includes(testCase.expectedAnswer),
        expectedAnswer: testCase.expectedAnswer,
        transcriptFile: transcript.filePath,
      });
    }

    return {
      threadId: prepared.threadId,
      model,
      reasoningEffort,
      cases: report,
    };
  } catch (error) {
    keepRoot = process.env.FARMING_REAL_CODEX_DISPLAY_KEEP_TMP_ON_FAILURE === '1';
    if (keepRoot) {
      console.error(`Preserved Codex display smoke temp dir: ${root}`);
    }
    throw error;
  } finally {
    runtime.dispose();
    if (!keepRoot) await fs.promises.rm(root, { recursive: true, force: true });
  }
}

async function run() {
  const fixtureReport = runFixtureCoverage();
  const realReport = await runRealCodexSmoke();
  console.log(JSON.stringify({
    ok: true,
    fixture: {
      scenarios: fixtureReport.length,
      cases: fixtureReport,
    },
    realCodex: realReport || {
      skipped: true,
      hint: 'Set FARMING_REAL_CODEX_DISPLAY_SMOKE=1 to run 20 real GPT-5.3 Codex Spark prompts.',
    },
  }, null, 2));
}

run().catch(error => {
  console.error(error && (error.stack || error.message || error));
  process.exit(1);
});
