#!/bin/sh
':' //; script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"; repo_dir="$script_dir"; while [ ! -x "$repo_dir/node_modules/.bin/tsx" ] && [ "$repo_dir" != "/" ]; do repo_dir="$(dirname -- "$repo_dir")"; done; if [ ! -x "$repo_dir/node_modules/.bin/tsx" ]; then echo "Pinned tsx runtime not found above $script_dir" >&2; exit 127; fi; exec "$repo_dir/node_modules/.bin/tsx" "$0" "$@"

const readline = require('readline');
const fs = require('fs');

const sessionId = '019f0000-0000-7000-8000-000000000999';
const imagePath = process.env.FARMING_TEST_HISTORY_IMAGE_PATH || '';
const dataUrl = process.env.FARMING_TEST_HISTORY_IMAGE_DATA_URL || '';
const stallPrompt = process.env.FARMING_TEST_STALL_PROMPT === '1';
const multiSession = process.env.FARMING_TEST_MULTI_SESSION === '1';
const splitUtf8 = process.env.FARMING_TEST_SPLIT_UTF8 === '1';
const requestLogFile = process.env.FARMING_TEST_REQUEST_LOG_FILE || '';
const providerResumeGatePrefix = process.env.FARMING_TEST_PROVIDER_RESUME_GATE_PREFIX || '';
const emitSubagentAfterResume = process.env.FARMING_TEST_EMIT_SUBAGENT_AFTER_RESUME === '1';
let nextThread = 1;

function thread(id = sessionId) {
  return {
    id,
    sessionId: id,
    forkedFromId: null,
    parentThreadId: null,
    preview: 'ACP history image test',
    ephemeral: false,
    modelProvider: 'openai',
    createdAt: 1,
    updatedAt: 2,
    recencyAt: 2,
    status: { type: 'idle' },
    path: null,
    cwd: process.cwd(),
    cliVersion: '0.0.0-test',
    source: 'appServer',
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: [{
      id: 'turn-history-image',
      items: [{
        id: 'user-history-image',
        type: 'userMessage',
        content: [
          { type: 'text', text: splitUtf8 ? '通用谓词解析器' : '请检查历史图片', text_elements: [] },
          { type: 'localImage', path: imagePath },
          { type: 'image', url: dataUrl },
          { type: 'localImage', path: `${imagePath}.missing` },
        ],
      }, {
        id: 'user-history-steer',
        type: 'userMessage',
        content: [
          { type: 'text', text: '重点检查恢复后的图片', text_elements: [] },
        ],
      }],
      itemsView: { type: 'full' },
      status: 'completed',
      error: null,
      startedAt: 1,
      completedAt: 2,
      durationMs: 1000,
    }],
  };
}

async function waitForProviderResumeGate() {
  if (!providerResumeGatePrefix) return;
  const gateFile = `${providerResumeGatePrefix}.${process.pid}`;
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(gateFile)) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for provider resume gate ${gateFile}`);
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function resultFor(method, params) {
  if (method === 'initialize') {
    return { userAgent: 'fake-codex-app-server/0.0.0' };
  }
  if (method === 'account/read') {
    return { account: null, requiresOpenaiAuth: false };
  }
  if (method === 'config/read') {
    return { config: {}, layers: [] };
  }
  if (method === 'skills/extraRoots/set') {
    return {};
  }
  if (method === 'skills/list') {
    return { data: [] };
  }
  if (method === 'thread/resume') {
    await waitForProviderResumeGate();
    return {
      thread: thread(params.threadId),
      model: 'gpt-5.6',
      modelProvider: 'openai',
      reasoningEffort: 'medium',
      serviceTier: null,
    };
  }
  if (method === 'thread/start' && (stallPrompt || multiSession)) {
    const id = multiSession
      ? `019f0000-0000-7000-8000-${String(nextThread++).padStart(12, '0')}`
      : sessionId;
    return {
      thread: { ...thread(id), turns: [] },
      model: 'gpt-5.6',
      modelProvider: 'openai',
      reasoningEffort: 'medium',
      serviceTier: null,
    };
  }
  if (method === 'thread/fork') {
    const id = `019f0000-0000-7000-8001-${String(nextThread++).padStart(12, '0')}`;
    return { thread: { ...thread(id), forkedFromId: params.threadId, turns: [] } };
  }
  if (method === 'turn/start' && stallPrompt) {
    return {
      turn: {
        id: 'turn-stalled-title',
        items: [],
        status: 'inProgress',
        error: null,
      },
    };
  }
  if (method === 'thread/read') {
    return { thread: thread(params.threadId) };
  }
  if (method === 'thread/unsubscribe' || method === 'thread/delete') return {};
  if (method === 'thread/list') {
    return { data: [], nextCursor: null };
  }
  if (method === 'model/list') {
    return {
      data: [{
        id: 'gpt-5.6',
        model: 'gpt-5.6',
        upgrade: null,
        upgradeInfo: null,
        availabilityNux: null,
        displayName: 'GPT-5.6',
        description: 'test model',
        hidden: false,
        supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Medium' }],
        defaultReasoningEffort: 'medium',
        inputModalities: ['text', 'image'],
        supportsPersonality: false,
        additionalSpeedTiers: [],
        serviceTiers: [],
        defaultServiceTier: null,
        isDefault: true,
      }],
      nextCursor: null,
    };
  }
  if (method === 'thread/goal/get') {
    return { goal: null, revision: 0 };
  }
  throw new Error(`Unexpected fake Codex app-server request: ${method} ${JSON.stringify(params)}`);
}

async function writeResponse(message) {
  const bytes = Buffer.from(`${JSON.stringify(message)}\n`);
  if (!splitUtf8) {
    process.stdout.write(bytes);
    return;
  }

  const splitCharacter = Buffer.from('析');
  const splitAt = bytes.indexOf(splitCharacter);
  if (splitAt < 0) {
    process.stdout.write(bytes);
    return;
  }

  process.stdout.write(bytes.subarray(0, splitAt));
  for (const byte of splitCharacter) {
    await new Promise(resolve => setTimeout(resolve, 10));
    process.stdout.write(Buffer.from([byte]));
  }
  await new Promise(resolve => setTimeout(resolve, 10));
  process.stdout.write(bytes.subarray(splitAt + splitCharacter.length));
}

async function run() {
  const lines = readline.createInterface({ input: process.stdin });
  const pending = new Set();
  let outputQueue = Promise.resolve();
  const enqueueResponse = message => {
    const response = outputQueue.then(() => writeResponse(message));
    outputQueue = response.catch(() => {});
    return response;
  };
  const handleRequest = async request => {
    try {
      if (requestLogFile) {
        fs.appendFileSync(requestLogFile, `${JSON.stringify({
          pid: process.pid,
          method: request.method,
          params: request.params,
        })}\n`);
      }
      await enqueueResponse({
        id: request.id,
        result: await resultFor(request.method, request.params),
      });
      if (request.method === 'thread/resume' && emitSubagentAfterResume) {
        const childId = `${request.params.threadId}-child`;
        await enqueueResponse({
          method: 'thread/started',
          params: {
            thread: {
              ...thread(childId),
              parentThreadId: request.params.threadId,
              agentNickname: 'provider-restart-child',
            },
          },
        });
      }
    } catch (error) {
      await enqueueResponse({
        id: request.id,
        error: { code: -32601, message: error.message },
      });
    }
  };
  for await (const line of lines) {
    if (!line.trim()) continue;
    const request = JSON.parse(line);
    if (request.id === undefined) continue;
    if (!providerResumeGatePrefix) {
      await handleRequest(request);
      continue;
    }
    const operation = handleRequest(request);
    pending.add(operation);
    void operation.finally(() => pending.delete(operation));
  }
  await Promise.allSettled([...pending]);
  await outputQueue;
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
