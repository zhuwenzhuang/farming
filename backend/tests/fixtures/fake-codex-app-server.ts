#!/bin/sh
':' //; script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"; repo_dir="$script_dir"; while [ ! -x "$repo_dir/node_modules/.bin/tsx" ] && [ "$repo_dir" != "/" ]; do repo_dir="$(dirname -- "$repo_dir")"; done; if [ ! -x "$repo_dir/node_modules/.bin/tsx" ]; then echo "Pinned tsx runtime not found above $script_dir" >&2; exit 127; fi; exec "$repo_dir/node_modules/.bin/tsx" "$0" "$@"

const readline = require('readline');
const fs = require('fs');
const path = require('path');

const sessionId = '019f0000-0000-7000-8000-000000000999';
const imagePath = process.env.FARMING_TEST_HISTORY_IMAGE_PATH || '';
const dataUrl = process.env.FARMING_TEST_HISTORY_IMAGE_DATA_URL || '';
const stallPrompt = process.env.FARMING_TEST_STALL_PROMPT === '1';
const realtimeFenceDirectory = process.env.FARMING_TEST_REALTIME_FENCE_DIR || '';
const loseFirstRealtimeStartResponse = process.env.FARMING_TEST_REALTIME_LOSE_START_RESPONSE === '1';
let realtimeStartResponseLost = false;
let realtimeStopPending = false;
let realtimeReleaseWatcher: import('fs').FSWatcher | null = null;

function sendNotification(method, params) {
  process.stdout.write(`${JSON.stringify({ method, params })}\n`);
}

function publishRealtimeClosedAfterRelease() {
  if (!realtimeFenceDirectory) return false;
  const releasePath = path.join(realtimeFenceDirectory, 'release-closed');
  const finish = () => {
    if (!realtimeStopPending || !fs.existsSync(releasePath)) return;
    realtimeStopPending = false;
    realtimeReleaseWatcher?.close();
    realtimeReleaseWatcher = null;
    sendNotification('thread/realtime/sdp', {
      threadId: sessionId,
      sdp: 'v=0\r\nfake-delayed-a-answer',
    });
    sendNotification('thread/realtime/closed', { threadId: sessionId });
  };
  realtimeStopPending = true;
  realtimeReleaseWatcher?.close();
  realtimeReleaseWatcher = fs.watch(realtimeFenceDirectory, finish);
  fs.writeFileSync(path.join(realtimeFenceDirectory, 'stop-response-returned'), '');
  finish();
  return true;
}

function thread() {
  return {
    id: sessionId,
    sessionId,
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
          { type: 'text', text: '请检查历史图片', text_elements: [] },
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

function resultFor(method, params) {
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
    return {
      thread: thread(),
      model: 'gpt-5.6',
      modelProvider: 'openai',
      reasoningEffort: 'medium',
      serviceTier: null,
    };
  }
  if (method === 'thread/start' && stallPrompt) {
    return {
      thread: { ...thread(), turns: [] },
      model: 'gpt-5.6',
      modelProvider: 'openai',
      reasoningEffort: 'medium',
      serviceTier: null,
    };
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
    return { thread: thread() };
  }
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
  if (method === 'thread/realtime/start') {
    if (realtimeStopPending) {
      throw new Error('A replacement Realtime start crossed the unclosed operation fence');
    }
    if (params?.threadId !== sessionId || params?.outputModality !== 'audio') {
      throw new Error(`Unexpected realtime start params: ${JSON.stringify(params)}`);
    }
    if (
      params?.version !== 'v3'
      || params?.model !== 'gpt-live-1-boulder-alpha'
      || params?.includeStartupContext !== true
      || params?.flushTranscriptTailOnSessionEnd !== true
    ) {
      throw new Error(`Expected the Codex Realtime v3 session contract: ${JSON.stringify(params)}`);
    }
    if (params?.transport?.type !== 'webrtc' || typeof params?.transport?.sdp !== 'string') {
      throw new Error(`Expected a WebRTC SDP offer: ${JSON.stringify(params)}`);
    }
    return {};
  }
  if (method === 'thread/realtime/stop') {
    if (params?.threadId !== sessionId) {
      throw new Error(`Unexpected realtime stop params: ${JSON.stringify(params)}`);
    }
    return {};
  }
  throw new Error(`Unexpected fake Codex app-server request: ${method} ${JSON.stringify(params)}`);
}

function notificationsFor(method) {
  if (method === 'thread/realtime/start') {
    return [{
      method: 'thread/realtime/sdp',
      params: { threadId: sessionId, sdp: 'v=0\r\nfake-answer' },
    }, {
      method: 'thread/realtime/transcript/done',
      params: { threadId: sessionId, role: 'user', text: 'run focused tests' },
    }];
  }
  if (method === 'thread/realtime/stop') {
    if (publishRealtimeClosedAfterRelease()) return [];
    return [{
      method: 'thread/realtime/closed',
      params: { threadId: sessionId },
    }];
  }
  return [];
}

async function run() {
  const lines = readline.createInterface({ input: process.stdin });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const request = JSON.parse(line);
    if (request.id === undefined) continue;
    try {
      const result = resultFor(request.method, request.params);
      if (
        request.method === 'thread/realtime/start'
        && loseFirstRealtimeStartResponse
        && !realtimeStartResponseLost
      ) {
        realtimeStartResponseLost = true;
        fs.writeFileSync(path.join(realtimeFenceDirectory, 'start-accepted-without-response'), '');
      } else {
        process.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
      }
      for (const notification of notificationsFor(request.method)) {
        process.stdout.write(`${JSON.stringify(notification)}\n`);
      }
    } catch (error) {
      process.stdout.write(`${JSON.stringify({
        id: request.id,
        error: { code: -32601, message: error.message },
      })}\n`);
    }
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
