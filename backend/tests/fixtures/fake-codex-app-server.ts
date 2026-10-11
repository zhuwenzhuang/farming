#!/bin/sh
':' //; script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"; repo_dir="$script_dir"; while [ ! -x "$repo_dir/node_modules/.bin/tsx" ] && [ "$repo_dir" != "/" ]; do repo_dir="$(dirname -- "$repo_dir")"; done; if [ ! -x "$repo_dir/node_modules/.bin/tsx" ]; then echo "Pinned tsx runtime not found above $script_dir" >&2; exit 127; fi; exec "$repo_dir/node_modules/.bin/tsx" "$0" "$@"

const readline = require('readline');
const fs = require('fs');

const sessionId = '019f0000-0000-7000-8000-000000000999';
const imagePath = process.env.FARMING_TEST_HISTORY_IMAGE_PATH || '';
const dataUrl = process.env.FARMING_TEST_HISTORY_IMAGE_DATA_URL || '';
const userInputResultFile = process.env.FARMING_TEST_USER_INPUT_RESULT_FILE || '';
const stallPrompt = process.env.FARMING_TEST_STALL_PROMPT === '1';
const multiSession = process.env.FARMING_TEST_MULTI_SESSION === '1';
const splitUtf8 = process.env.FARMING_TEST_SPLIT_UTF8 === '1';
const requestLogFile = process.env.FARMING_TEST_REQUEST_LOG_FILE || '';
const providerResumeGatePrefix = process.env.FARMING_TEST_PROVIDER_RESUME_GATE_PREFIX || '';
const emitSubagentAfterResume = process.env.FARMING_TEST_EMIT_SUBAGENT_AFTER_RESUME === '1';
const backgroundChild = process.env.FARMING_TEST_BACKGROUND_CHILD === '1';
const childCompletionGate = process.env.FARMING_TEST_CHILD_COMPLETION_GATE || '';
const goalCompletionGate = process.env.FARMING_TEST_GOAL_COMPLETION_GATE || '';
let nextTurn = 1;
let nextThread = 1;
const archivedThreads = new Set<string>();
const loadedEnvironments = new Map<string, Record<string, string>>();
const subscribedThreads = new Set<string>();

function loadEnvironment(id, params) {
  // A subscribed app-server thread keeps its running config on resume. An
  // unsubscribed idle thread can be cold-resumed with the new owner's config.
  if (!subscribedThreads.has(id)) {
    loadedEnvironments.set(id, { ...params.config?.shell_environment_policy?.set });
  }
  subscribedThreads.add(id);
}

function thread(id = sessionId) {
  return {
    id,
    sessionId: id,
    historyMode: 'paginated',
    forkedFromId: null,
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
    parentThreadId: id.endsWith('-child') ? id.slice(0, -6) : null,
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
    const gateFile = process.env.FARMING_TEST_ACCOUNT_READ_GATE_FILE;
    const deadline = Date.now() + 10_000;
    while (gateFile && fs.existsSync(gateFile)) {
      if (Date.now() >= deadline) throw new Error('Timed out waiting for account read gate');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
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
    if (process.env.FARMING_TEST_ACTIVE_WRITER === '1') throw new Error(`thread ${params.threadId} already has an active writer`);
    loadEnvironment(params.threadId, params);
    return {
      thread: { ...thread(params.threadId), turns: [] },
      itemsBackwardsCursor: 'history-start',
      model: 'gpt-5.6',
      modelProvider: 'openai',
      reasoningEffort: 'medium',
      serviceTier: null,
    };
  }
  if (method === 'thread/start' && (stallPrompt || multiSession || backgroundChild || userInputResultFile || goalCompletionGate)) {
    const id = multiSession || backgroundChild
      ? `019f0000-0000-7000-8000-${String(nextThread++).padStart(12, '0')}`
      : sessionId;
    loadEnvironment(id, params);
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
    loadEnvironment(id, params);
    return { thread: { ...thread(id), forkedFromId: params.threadId, turns: [] } };
  }
  if (method === 'turn/start' && (stallPrompt || backgroundChild || userInputResultFile || goalCompletionGate)) {
    return {
      turn: {
        id: backgroundChild ? params.outputSchema ? 'turn-title' : `turn-parent-${nextTurn++}` : 'turn-stalled-title',
        items: [],
        status: 'inProgress',
        error: null,
      },
    };
  }
  if (method === 'thread/read') {
    return { thread: { ...thread(params.threadId), turns: [],
      ...(backgroundChild && params.threadId.endsWith('-child') ? {
        agentNickname: 'Background reviewer', status: { type: childCompletionGate && fs.existsSync(childCompletionGate) ? 'idle' : 'active' },
      } : {}),
    } };
  }
  if (method === 'thread/items/list') {
    if (process.env.FARMING_TEST_PAGED_CHILD_HISTORY === '1' && /^turn-\d+$/.test(String(params.turnId))) {
      const i = Number(String(params.turnId).slice(5));
      return { data: [
        { turnId: params.turnId, item: { id: `user-${i}`, type: 'userMessage', content: [{ type: 'text', text: `Question ${i}`, text_elements: [] }] } },
        { turnId: params.turnId, item: { id: `answer-${i}`, type: 'agentMessage', text: `Answer ${i}`, phase: 'final_answer' } },
      ], nextCursor: null };
    }

    const entries = String(params.threadId).endsWith('-child')
      ? [{ turnId: 'child-turn', item: { id: 'child-question', type: 'userMessage', content: [{ type: 'text', text: 'Inspect the parser', text_elements: [] }] } },
        { turnId: 'child-turn', item: { id: 'child-answer', type: 'agentMessage', text: 'Live child history read without resume.', phase: 'final_answer' } }]
      : thread(params.threadId).turns.flatMap(turn => turn.items.map(item => ({ turnId: turn.id, item })));
    const paginated = process.env.FARMING_TEST_PAGINATED_HISTORY === '1' && !String(params.threadId).endsWith('-child');
    const newest = { turnId: 'turn-history-newest', item: { id: 'user-history-newest', type: 'userMessage', content: [{ type: 'text', text: 'Newest paginated turn', text_elements: [] }] } };
    let data;
    let nextCursor: string | null = null;
    if (params.sortDirection === 'desc') data = [paginated ? newest : entries.at(-1)].filter(Boolean);
    else if (paginated && params.cursor === 'items-newer') data = [newest];
    else { data = entries; nextCursor = paginated ? 'items-newer' : null; }
    // Keep a 64 MiB transport response outside the emitted ACP transcript.
    const fixturePadding = process.env.FARMING_TEST_LARGE_HISTORY === '1' && params.sortDirection === 'asc'
      ? `${'x'.repeat(1020)}恢复🌱`.repeat(65536) : undefined;
    return { data: data.map(entry => ({ ...entry, startedAtMs: null, completedAtMs: null })), nextCursor,
      ...(fixturePadding ? { fixturePadding } : {}) };
  }
  if (method === 'thread/turns/list') {
    if (process.env.FARMING_TEST_PAGED_CHILD_HISTORY === '1' && String(params.threadId).endsWith('-child')) {
      const end = params.cursor == null ? 260 : Number(params.cursor);
      const start = Math.max(0, end - Number(params.limit));
      return { data: Array.from({ length: end - start }, (_, offset) => {
        const i = end - offset - 1;
        if (i % 2) return { id: `turn-${i}`, status: 'completed', items: [], itemsView: 'notLoaded' };
        return { id: `turn-${i}`, status: 'completed', items: [
          { id: `user-${i}`, type: 'userMessage', content: [{ type: 'text', text: `Question ${i}`, text_elements: [] }] },
          { id: `answer-${i}`, type: 'agentMessage', text: `Answer ${i}`, phase: 'final_answer' },
        ] };
      }), nextCursor: start > 0 ? String(start) : null };
    }
    if (String(params.threadId).endsWith('-child')) return { data: [{ id: 'child-turn', items: [], itemsView: { type: 'summary' },
      status: backgroundChild && childCompletionGate && fs.existsSync(childCompletionGate) ? 'completed' : 'inProgress',
    }], nextCursor: null };

    const turns = thread(params.threadId).turns;
    if (process.env.FARMING_TEST_PAGINATED_HISTORY === '1' && params.cursor !== 'history-older') {
      return {
        data: [{
          ...turns[0],
          id: 'turn-history-newest',
          items: [{
            id: 'user-history-newest',
            type: 'userMessage',
            content: [{ type: 'text', text: 'Newest paginated turn', text_elements: [] }],
          }],
        }],
        nextCursor: 'history-older',
      };
    }
    return { data: [...turns].reverse(), nextCursor: null };
  }
  if (method === 'thread/archive') {
    if (process.env.FARMING_TEST_ARCHIVE_FAILURE_FILE && fs.existsSync(process.env.FARMING_TEST_ARCHIVE_FAILURE_FILE) && String(params.threadId).endsWith('-child-child')) throw new Error('Simulated descendant archive failure');
    archivedThreads.add(params.threadId);
    return {};
  }
  if (method === 'thread/unsubscribe' || method === 'thread/delete') {
    if (method === 'thread/unsubscribe' && process.env.FARMING_TEST_UNSUBSCRIBE_FAILURE_FILE
      && fs.existsSync(process.env.FARMING_TEST_UNSUBSCRIBE_FAILURE_FILE)) {
      throw new Error('Simulated fork ownership release failure');
    }
    subscribedThreads.delete(params.threadId);
    return {};
  }
  if (method === 'thread/list') {
    // App-server's default source filter excludes native children even when
    // ancestorThreadId is set. Exercise the real filter, not a permissive fake.
    if (params.ancestorThreadId && !params.sourceKinds?.includes('subAgent')) return { data: [], nextCursor: null };
    if (backgroundChild && params.ancestorThreadId) {
      const child = (await resultFor('thread/read', { threadId: `${params.ancestorThreadId}-child` })).thread;
      return { data: [child], nextCursor: null };
    }
    if (process.env.FARMING_TEST_ARCHIVE_CHILDREN === '1' && params.ancestorThreadId) {
      return { data: [`${params.ancestorThreadId}-child`, `${params.ancestorThreadId}-child-child`]
        .filter(id => !archivedThreads.has(id)).map(id => thread(id)), nextCursor: null };
    }
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
    if (goalCompletionGate) return { goal: {
      threadId: params.threadId, objective: 'Continue the goal', status: 'active',
      tokensUsed: fs.existsSync(goalCompletionGate) ? 42 : 0,
      timeUsedSeconds: fs.existsSync(goalCompletionGate) ? 12 : 0,
      createdAt: 1, updatedAt: fs.existsSync(goalCompletionGate) ? 2 : 1,
    } };
    return { goal: null, revision: 0 };
  }
  if (goalCompletionGate && method === 'turn/steer') {
    if (params.expectedTurnId !== 'goal-continuation') throw new Error('Steer targeted the wrong turn');
    return { turnId: 'goal-continuation' };
  }
  if (goalCompletionGate && method === 'turn/interrupt') {
    if (params.turnId !== 'goal-continuation') throw new Error('Interrupt targeted the wrong turn');
    fs.writeFileSync(goalCompletionGate, 'interrupted');
    return {};
  }
  throw new Error(`Unexpected fake Codex app-server request: ${method} ${JSON.stringify(params)}`);
}

async function writeResponse(message) {
  const bytes = Buffer.from(`${JSON.stringify(message)}\n`);
  if (process.env.FARMING_TEST_LARGE_HISTORY === '1') {
    // Odd-sized chunks also split multi-byte characters and JSON delimiters.
    for (let offset = 0; offset < bytes.length; offset += 32749) {
      if (!process.stdout.write(bytes.subarray(offset, offset + 32749))) {
        await new Promise<void>(resolve => process.stdout.once('drain', resolve));
      }
    }
    return;
  }
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
      const result = await resultFor(request.method, request.params);
      if (requestLogFile && process.env.FARMING_TEST_SESSION_ENVIRONMENT === '1'
        && ['thread/start', 'thread/resume', 'thread/fork'].includes(request.method)) {
        fs.appendFileSync(requestLogFile, `${JSON.stringify({
          pid: process.pid,
          method: 'fixture/session-environment',
          params: { threadId: result.thread.id, environment: loadedEnvironments.get(result.thread.id) },
        })}\n`);
      }
      await enqueueResponse({
        id: request.id,
        result,
      });
      if ((backgroundChild || userInputResultFile || goalCompletionGate) && request.method === 'turn/start' && request.params.outputSchema) {
        await enqueueResponse({ method: 'turn/completed', params: { threadId: request.params.threadId,
          turn: { ...result.turn, status: 'completed' } } });
      }
      if (goalCompletionGate && request.method === 'turn/start' && !request.params.outputSchema) {
        const threadId = request.params.threadId;
        const emitTurn = (turn, status) => enqueueResponse({ method: status === 'inProgress' ? 'turn/started' : 'turn/completed',
          params: { threadId, turn: { ...turn, status } } });
        await emitTurn(result.turn, 'inProgress');
        await emitTurn(result.turn, 'completed');
        const autonomous = { ...result.turn, id: 'goal-continuation' };
        await emitTurn(autonomous, 'inProgress');
        await enqueueResponse({ method: 'item/agentMessage/delta', params: {
          threadId, turnId: autonomous.id, itemId: 'goal-answer', delta: 'Autonomous goal work is visible.',
        } });
        const completion = (async () => {
          const deadline = Date.now() + 10000;
          while (!fs.existsSync(goalCompletionGate)) {
            if (Date.now() >= deadline) throw new Error('Goal completion gate timed out');
            await new Promise(resolve => setTimeout(resolve, 10));
          }
          await emitTurn(autonomous, fs.readFileSync(goalCompletionGate, 'utf8'));
        })();
        pending.add(completion);
        void completion.finally(() => pending.delete(completion));
      }
      if (userInputResultFile && request.method === 'turn/start' && !request.params.outputSchema) {
        await enqueueResponse({ method: 'turn/started', params: { threadId: request.params.threadId, turn: result.turn } });
        await enqueueResponse({ id: 'fixture-user-input', method: 'item/tool/requestUserInput', params: {
          threadId: request.params.threadId, turnId: result.turn.id, itemId: 'question', autoResolutionMs: null,
          questions: [{ id: 'choice', header: 'Choice', question: 'Choose a target', isOther: true, isSecret: false,
            options: [{ label: 'Local', description: 'This machine' }, { label: 'Remote', description: 'Another machine' }] }],
        } });
      }
      if (backgroundChild && request.method === 'turn/start' && !request.params.outputSchema) {
        const parentId = request.params.threadId;
        const childId = `${parentId}-child`;
        await enqueueResponse({ method: 'turn/started', params: { threadId: parentId, turn: result.turn } });
        await enqueueResponse({ method: 'item/started', params: { threadId: parentId, turnId: result.turn.id,
          item: { type: 'subAgentActivity', id: `activity-${result.turn.id}`, kind: 'message',
            agentThreadId: childId, agentPath: '/root/reviewer', text: 'Child working independently' } } });
        await enqueueResponse({ method: 'item/agentMessage/delta', params: {
          threadId: childId, turnId: 'child-turn', itemId: 'child-answer', delta: `Child update during ${result.turn.id}.`,
        } });
        await enqueueResponse({ method: 'turn/completed', params: { threadId: parentId,
          turn: { ...result.turn, status: request.params.input?.some(item => item.text === 'Cancel parent only') ? 'interrupted' : 'completed' } } });
      }
      if (backgroundChild && request.method === 'thread/list' && childCompletionGate && fs.existsSync(childCompletionGate)) {
        const childId = `${request.params.ancestorThreadId}-child`;
        await enqueueResponse({ method: 'item/agentMessage/delta', params: {
          threadId: childId, turnId: 'child-turn', itemId: 'child-answer', delta: 'Child finished after parent prompt returned.',
        } });
        await enqueueResponse({ method: 'turn/completed', params: { threadId: childId,
          turn: { id: 'child-turn', items: [], status: 'completed', error: null } } });
      }
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
    if (request.id === 'fixture-user-input' && !request.method) {
      fs.writeFileSync(userInputResultFile, JSON.stringify(request));
      await enqueueResponse({ method: 'turn/completed', params: { threadId: sessionId,
        turn: { id: 'turn-stalled-title', items: [], status: 'completed', error: null } } });
      continue;
    }
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
