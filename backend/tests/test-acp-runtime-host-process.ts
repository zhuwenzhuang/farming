const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { StringDecoder } = require('string_decoder');

const { AcpRuntimeHostProcess } = require('../acp-runtime-host-process.cts');
const { promptContentHash } = require('../acp-runtime-host-service.cts');
const { acpRuntimeHostSocketPath } = require('../acp-runtime-host-path.cts');

const HOST_RESPONSE_CAP_BYTES = 16 * 1024 * 1024;

function assertHostResponseFits(result, message) {
  assert(
    Buffer.byteLength(JSON.stringify({ id: 1, ok: true, result })) < HOST_RESPONSE_CAP_BYTES,
    message,
  );
}

class FakeRuntime extends EventEmitter {
  constructor() {
    super();
    this.sessions = new Map();
    this.transcriptEntries = [];
    this.subagentTranscriptEntries = new Map();
    this.promptCalls = 0;
    this.promptCompletion = null;
    this.inputCalls = 0;
  }

  bindingEpoch(agentId) {
    return this.sessions.get(agentId)?.bindingEpoch || '';
  }

  getSession(agentId) {
    return { ...this.sessions.get(agentId) };
  }

  getTranscriptSessionForRead(agentId) {
    return {
      ...this.getSession(agentId),
      entries: this.transcriptEntries,
    };
  }

  getTranscriptEntryForSessionRead(agentId, sessionId, entryId, subagentOnly = false) {
    if (subagentOnly && this.sessions.get(agentId)?.sessionId === sessionId) return null;
    const entries = this.sessions.get(agentId)?.sessionId === sessionId
      ? this.transcriptEntries
      : (this.subagentTranscriptEntries.get(sessionId) || []);
    const matches = entries.filter(entry => entry.id === entryId);
    return matches.length === 1 ? matches[0] : null;
  }

  getSubagentTranscriptSessionForRead(_agentId, sessionId) {
    const entries = this.subagentTranscriptEntries.get(sessionId);
    return entries ? { sessionId, revision: 1, entries } : null;
  }

  getToolEntryForRead(_agentId, toolCallId) {
    return this.transcriptEntries.find(entry => entry.id === toolCallId && entry.type === 'tool') || null;
  }

  async prepareAgent(options) {
    const session = {
      agentId: options.agentId,
      bindingEpoch: options.capabilityRuntimeEpoch,
      sessionId: options.sessionId,
      state: 'idle',
      revision: 1,
    };
    this.sessions.set(options.agentId, session);
    this.emit('agent-runtime', session);
    return { sessionId: options.sessionId, historyMode: 'load' };
  }

  submitMessage(agentId, _prompt, options: { onSubmitted?: () => void } = {}) {
    this.promptCalls += 1;
    options.onSubmitted?.();
    const session = this.sessions.get(agentId);
    session.state = 'working';
    session.revision += 1;
    this.emit('agent-runtime', session);
    return new Promise(resolve => {
      this.promptCompletion = result => {
        session.state = 'idle';
        session.revision += 1;
        this.emit('agent-runtime', session);
        resolve(result);
      };
    });
  }

  async dispose() {}

  inputTerminal() {
    this.inputCalls += 1;
    return { written: true };
  }
}

class HostClient {
  socket;
  buffer;
  nextId;
  pending;

  constructor(socket) {
    this.socket = socket;
    this.buffer = '';
    this.nextId = 1;
    this.pending = new Map();
    socket.on('data', chunk => this.onData(chunk));
  }

  onData(chunk) {
    this.buffer += chunk.toString('utf8');
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      const message = JSON.parse(line);
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (pending) {
          this.pending.delete(message.id);
          if (message.ok) pending.resolve(message.result);
          else pending.reject(new Error(message.error?.message || String(message.error)));
        }
      }
      newline = this.buffer.indexOf('\n');
    }
  }

  request(method, params = {}): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    const promise = new Promise<Record<string, unknown>>((resolve, reject) => (
      this.pending.set(id, { resolve, reject })
    ));
    this.socket.write(`${JSON.stringify({ id, method, params })}\n`);
    return promise;
  }

  close() {
    this.socket.destroy();
  }
}

async function connect(socketPath) {
  const socket = net.createConnection(socketPath);
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  return new HostClient(socket);
}

async function waitFor(predicate, message) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

async function main() {
  const splitUtf8Host = new AcpRuntimeHostProcess({
    configDir: os.tmpdir(),
    socketPath: '/unused',
    runtime: new FakeRuntime(),
    exitOnShutdown: false,
  });
  const splitUtf8Requests: Record<string, unknown>[] = [];
  splitUtf8Host.handleMessage = async (_client, line) => {
    splitUtf8Requests.push(JSON.parse(line));
  };
  const splitUtf8Request = Buffer.from(`${JSON.stringify({
    id: 1,
    method: 'submitPrompt',
    params: { prompt: [{ type: 'text', text: '通用谓词解析器' }] },
  })}\n`);
  const splitUtf8Character = Buffer.from('析');
  const splitUtf8At = splitUtf8Request.indexOf(splitUtf8Character);
  const splitUtf8Client = {
    buffer: '',
    controller: null,
    decoder: new StringDecoder('utf8'),
    disconnected: false,
    socket: { destroy() {} },
  };
  splitUtf8Host.handleData(splitUtf8Client, splitUtf8Request.subarray(0, splitUtf8At));
  for (const byte of splitUtf8Character) {
    splitUtf8Host.handleData(splitUtf8Client, Buffer.from([byte]));
  }
  splitUtf8Host.handleData(
    splitUtf8Client,
    splitUtf8Request.subarray(splitUtf8At + splitUtf8Character.length),
  );
  assert.deepStrictEqual(splitUtf8Requests, [{
    id: 1,
    method: 'submitPrompt',
    params: { prompt: [{ type: 'text', text: '通用谓词解析器' }] },
  }]);
  await splitUtf8Host.dispose();

  const transcriptConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-acp-runtime-host-transcript-'));
  const transcriptSocketPath = path.join(transcriptConfigDir, 'host.sock');
  const transcriptRuntime = new FakeRuntime();
  const screenshotBytes = Buffer.alloc(24 * 1024, 1);
  transcriptRuntime.subagentTranscriptEntries.set('session-child', [{
    id: 'child-screenshot',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'image', mimeType: 'image/png', data: screenshotBytes.toString('base64') }],
  }]);
  transcriptRuntime.transcriptEntries = [{
    id: 'large-mobile-screenshot',
    type: 'tool',
    kind: 'other',
    title: 'Inspect mobile screenshot',
    status: 'completed',
    content: [{
      type: 'image',
      mimeType: 'image/png',
      data: screenshotBytes.toString('base64'),
    }],
  }, {
    id: 'large-tool-detail',
    type: 'tool',
    kind: 'other',
    title: 'Inspect large output',
    status: 'completed',
    rawOutput: { formatted_output: 'x'.repeat(40 * 1024) },
    content: [],
  }, {
    id: 'large-review-change',
    type: 'tool',
    kind: 'edit',
    title: 'Edit a large file',
    status: 'completed',
    content: [{
      type: 'diff',
      path: 'large.ts',
      oldText: 'before\n'.repeat(4 * 1024),
      newText: 'after\n'.repeat(4 * 1024),
    }],
  }];
  assert(
    Buffer.byteLength(JSON.stringify(transcriptRuntime.transcriptEntries)) > 96 * 1024,
    'the raw transcript fixture must exceed the Host response limit',
  );
  const transcriptHost = new AcpRuntimeHostProcess({
    configDir: transcriptConfigDir,
    socketPath: transcriptSocketPath,
    runtime: transcriptRuntime,
    exitOnShutdown: false,
    maxResponseBytes: 96 * 1024,
  });
  let transcriptClient;
  try {
    await transcriptHost.start();
    transcriptClient = await connect(transcriptSocketPath);
    await transcriptClient.request('registerController', { identity: { id: 'server-transcript', generation: 1 } });
    await transcriptClient.request('prepareAgent', {
      options: {
        agentId: 'agent-transcript',
        capabilityRuntimeEpoch: 'binding-transcript',
        sessionId: 'session-transcript',
      },
    });
    const projected = await transcriptClient.request('getTranscriptSessionForRead', {
      agentId: 'agent-transcript',
      options: {
        maxTurns: 5,
        mediaPathPrefix: '/farming/api/agents/agent-transcript/acp-media',
      },
    });
    assert.strictEqual(projected.entries[0].content[0].data, undefined);
    assert.match(
      projected.entries[0].content[0].url,
      /^\/farming\/api\/agents\/agent-transcript\/acp-media\/large-mobile-screenshot\/[a-f0-9]{64}$/,
    );
    assert.strictEqual(Object.prototype.hasOwnProperty.call(projected.entries[0], 'rawOutput'), false);
    assert.strictEqual(projected.transcriptProjectionVersion, 1);
    assert(
      Buffer.byteLength(JSON.stringify(projected)) < 96 * 1024,
      'the Runtime Host must project a bounded transcript before enforcing its response limit',
    );
    const mediaId = projected.entries[0].content[0].url.split('/').at(-1);
    const mediaChunks = [];
    let mediaOffset = 0;
    for (;;) {
      const chunk = await transcriptClient.request('getTranscriptMediaChunkForRead', {
        agentId: 'agent-transcript',
        sessionId: 'session-transcript',
        entryId: 'large-mobile-screenshot',
        mediaId,
        offset: mediaOffset,
        maxBytes: 4 * 1024,
      });
      assert(chunk, 'projected transcript media must remain available through bounded Host chunks');
      mediaChunks.push(Buffer.from(chunk.dataBase64, 'base64'));
      if (chunk.nextOffset == null) break;
      assert(chunk.nextOffset > mediaOffset);
      mediaOffset = chunk.nextOffset;
    }
    assert.deepStrictEqual(Buffer.concat(mediaChunks), screenshotBytes);

    let serializedDetail = '';
    let detailOffset = 0;
    for (;;) {
      const page = await transcriptClient.request('getToolDetailPageForRead', {
        agentId: 'agent-transcript',
        toolCallId: 'large-tool-detail',
        offset: detailOffset,
        maxChars: 4 * 1024,
      });
      assert(page, 'large tool detail must remain available through bounded Host pages');
      serializedDetail += page.serializedDetail;
      if (page.nextOffset == null) break;
      assert(page.nextOffset > detailOffset);
      detailOffset = page.nextOffset;
    }
    const detailPayload = JSON.parse(serializedDetail);
    assert(detailPayload.detail.includes('x'.repeat(32 * 1024)));

    const childProjected = await transcriptClient.request('getSubagentTranscriptSessionForRead', {
      agentId: 'agent-transcript',
      sessionId: 'session-child',
      options: {
        maxTurns: 12,
        mediaPathPrefix: '/farming/api/agents/agent-transcript/acp-subagents/session-child/acp-media',
      },
    });
    assert.strictEqual(childProjected.entries[0].content[0].data, undefined);
    assert.match(
      childProjected.entries[0].content[0].url,
      /^\/farming\/api\/agents\/agent-transcript\/acp-subagents\/session-child\/acp-media\/child-screenshot\/[a-f0-9]{64}$/,
    );
    const primaryRejectedAsSubagent = await transcriptClient.request('getTranscriptMediaChunkForRead', {
      agentId: 'agent-transcript',
      sessionId: 'session-transcript',
      entryId: 'large-mobile-screenshot',
      mediaId,
      offset: 0,
      maxBytes: 4 * 1024,
      subagentOnly: true,
    });
    assert.strictEqual(
      primaryRejectedAsSubagent,
      null,
      'a subagent-only media read must reject the primary Session',
    );
    const childMediaId = childProjected.entries[0].content[0].url.split('/').at(-1);
    const childMedia = await transcriptClient.request('getTranscriptMediaChunkForRead', {
      agentId: 'agent-transcript',
      sessionId: 'session-child',
      entryId: 'child-screenshot',
      mediaId: childMediaId,
      offset: 0,
      maxBytes: 4 * 1024,
      subagentOnly: true,
    });
    assert(childMedia, 'a child Session must remain readable through subagent-only media routing');

    let serializedReviewChanges = '';
    let reviewOffset = 0;
    for (;;) {
      const page = await transcriptClient.request('getToolReviewChangesPageForRead', {
        agentId: 'agent-transcript',
        toolCallId: 'large-review-change',
        offset: reviewOffset,
        maxChars: 4 * 1024,
      });
      assert(page, 'large review changes must remain available through bounded Host pages');
      serializedReviewChanges += page.serializedChanges;
      if (page.nextOffset == null) break;
      assert(page.nextOffset > reviewOffset);
      reviewOffset = page.nextOffset;
    }
    const reviewChanges = JSON.parse(serializedReviewChanges);
    assert.strictEqual(reviewChanges[0].oldText, 'before\n'.repeat(4 * 1024));
    assert.strictEqual(reviewChanges[0].newText, 'after\n'.repeat(4 * 1024));
  } finally {
    transcriptClient?.close();
    await transcriptHost.dispose();
    fs.rmSync(transcriptConfigDir, { recursive: true, force: true });
  }

  const hardCapConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-acp-runtime-host-hard-cap-'));
  const hardCapSocketPath = path.join(hardCapConfigDir, 'host.sock');
  const hardCapRuntime = new FakeRuntime();
  const hardCapHost = new AcpRuntimeHostProcess({
    configDir: hardCapConfigDir,
    socketPath: hardCapSocketPath,
    runtime: hardCapRuntime,
    exitOnShutdown: false,
  });
  let hardCapClient;
  try {
    await hardCapHost.start();
    hardCapClient = await connect(hardCapSocketPath);
    await hardCapClient.request('registerController', { identity: { id: 'server-hard-cap', generation: 1 } });
    await hardCapClient.request('prepareAgent', {
      options: {
        agentId: 'agent-hard-cap',
        capabilityRuntimeEpoch: 'binding-hard-cap',
        sessionId: 'session-hard-cap',
      },
    });

    let oversizedMediaData = Buffer.alloc(13 * 1024 * 1024, 3).toString('base64');
    hardCapRuntime.transcriptEntries = [{
      id: 'oversized-inline-media',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'image', mimeType: 'image/png', data: oversizedMediaData }],
    }];
    assert(
      Buffer.byteLength(JSON.stringify(hardCapRuntime.transcriptEntries)) > HOST_RESPONSE_CAP_BYTES,
      'the no-prefix media fixture must exceed the real Host response cap',
    );
    const boundedInlineMedia = await hardCapClient.request('getTranscriptSessionForRead', {
      agentId: 'agent-hard-cap',
      options: { maxTurns: 5 },
    });
    assertHostResponseFits(
      boundedInlineMedia,
      'a no-prefix 13 MiB media transcript must fit below the real Host response cap',
    );
    assert(Number(boundedInlineMedia.transcriptTransportTruncatedEntries) > 0);
    assert.strictEqual(boundedInlineMedia.entries[0].transcriptTransportTruncated, true);
    oversizedMediaData = '';

    let oversizedResourceDescription = 'r'.repeat(17 * 1024 * 1024);
    hardCapRuntime.transcriptEntries = [{
      id: 'oversized-resource-link',
      type: 'tool',
      kind: 'other',
      title: 'Inspect resource',
      status: 'completed',
      content: [{
        type: 'resource_link',
        name: 'large resource',
        uri: 'https://example.invalid/large',
        description: oversizedResourceDescription,
      }],
    }];
    const boundedResource = await hardCapClient.request('getTranscriptSessionForRead', {
      agentId: 'agent-hard-cap',
      options: {
        maxTurns: 5,
        mediaPathPrefix: '/farming/api/agents/agent-hard-cap/acp-media',
      },
    });
    assertHostResponseFits(
      boundedResource,
      'an external-media transcript with a large resource link must fit below the real Host response cap',
    );
    assert(Number(boundedResource.transcriptTransportTruncatedEntries) > 0);
    oversizedResourceDescription = '';

    hardCapRuntime.transcriptEntries = [{
      id: 'small-entry-with-large-plan',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'done' }],
    }];
    hardCapRuntime.sessions.get('agent-hard-cap').plan = { explanation: 'p'.repeat(17 * 1024 * 1024) };
    const boundedPlan = await hardCapClient.request('getTranscriptSessionForRead', {
      agentId: 'agent-hard-cap',
      options: { maxTurns: 5 },
    });
    assertHostResponseFits(
      boundedPlan,
      'a transcript with oversized Session metadata must fit below the real Host response cap',
    );
    assert.strictEqual(boundedPlan.planTransportTruncated, true);
    assert.deepStrictEqual(boundedPlan.plan, {});
    delete hardCapRuntime.sessions.get('agent-hard-cap').plan;

    const aggregateDescription = 'a'.repeat(2 * 1024 * 1024);
    hardCapRuntime.transcriptEntries = Array.from({ length: 10 }, (_, index) => ({
      id: `aggregate-tool-${index}`,
      type: 'tool',
      kind: 'other',
      title: `Aggregate tool ${index}`,
      status: 'completed',
      content: [{
        type: 'resource_link',
        name: `resource-${index}`,
        uri: `https://example.invalid/${index}`,
        description: aggregateDescription,
      }],
    }));
    assert(
      Buffer.byteLength(JSON.stringify(hardCapRuntime.transcriptEntries)) > HOST_RESPONSE_CAP_BYTES,
      'the aggregate transcript fixture must exceed the real Host response cap',
    );
    const boundedAggregate = await hardCapClient.request('getTranscriptSessionForRead', {
      agentId: 'agent-hard-cap',
      options: {
        maxTurns: 5,
        mediaPathPrefix: '/farming/api/agents/agent-hard-cap/acp-media',
      },
    });
    assertHostResponseFits(
      boundedAggregate,
      'an aggregate transcript must fit below the real Host response cap',
    );
    assert(Number(boundedAggregate.transcriptTransportTruncatedEntries) > 0);

    const repeatedOldText = 'before'.repeat(2_858);
    const repeatedNewText = 'after'.repeat(3_334);
    hardCapRuntime.transcriptEntries = [{
      id: 'five-hundred-changes',
      type: 'tool',
      kind: 'edit',
      title: 'Edit 500 files',
      status: 'completed',
      content: Array.from({ length: 500 }, (_, index) => ({
        type: 'diff',
        path: `file-${index}.ts`,
        oldText: repeatedOldText,
        newText: repeatedNewText,
      })),
    }];
    let pagedSerializedDetail = '';
    let pagedDetailOffset = 0;
    let detailPages = 0;
    for (;;) {
      const page = await hardCapClient.request('getToolDetailPageForRead', {
        agentId: 'agent-hard-cap',
        toolCallId: 'five-hundred-changes',
        offset: pagedDetailOffset,
        maxChars: 1024 * 1024,
      });
      assert(page, 'the 500-change tool detail must remain readable');
      assertHostResponseFits(page, 'every serialized tool detail page must fit below the Host response cap');
      assert(String(page.serializedDetail || '').length <= 1024 * 1024);
      pagedSerializedDetail += page.serializedDetail;
      detailPages += 1;
      if (page.nextOffset == null) break;
      assert(page.nextOffset > pagedDetailOffset);
      pagedDetailOffset = page.nextOffset;
    }
    assert(detailPages > 1, '500 exact changes must cross more than one serializedDetail page');
    assert(
      Buffer.byteLength(pagedSerializedDetail) > HOST_RESPONSE_CAP_BYTES,
      'the reconstructed 500-change detail must exceed one unpaged Host response',
    );
    const pagedDetailPayload = JSON.parse(pagedSerializedDetail);
    assert.strictEqual(pagedDetailPayload.changes.length, 500);
  } finally {
    hardCapClient?.close();
    await hardCapHost.dispose();
    fs.rmSync(hardCapConfigDir, { recursive: true, force: true });
  }

  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-acp-runtime-host-process-'));
  const socketPath = path.join(configDir, 'host.sock');
  const runtime = new FakeRuntime();
  const host = new AcpRuntimeHostProcess({
    configDir,
    socketPath,
    runtime,
    exitOnShutdown: false,
  });
  try {
    await host.start();
    const first = await connect(socketPath);
    await first.request('registerController', { identity: { id: 'server-a', generation: 1 } });
    await first.request('prepareAgent', {
      options: {
        agentId: 'agent-1',
        capabilityRuntimeEpoch: 'binding-1',
        sessionId: 'session-1',
      },
    });
    const originalPrompt = first.request('submitPrompt', {
      agentId: 'agent-1',
      bindingEpoch: 'binding-1',
      clientPromptId: 'prompt-1',
      contentHash: promptContentHash([{ type: 'text', text: 'work' }]),
      prompt: [{ type: 'text', text: 'work' }],
    });
    await waitFor(() => runtime.promptCalls === 1, 'prompt was not admitted by the runtime host');
    assert.strictEqual(runtime.promptCalls, 1);
    first.close();
    await new Promise(resolve => setImmediate(resolve));

    const stale = await connect(socketPath);
    await assert.rejects(
      stale.request('registerController', { identity: { id: 'server-a', generation: 1 } }),
      /Stale ACP runtime host controller/,
    );
    stale.close();

    const second = await connect(socketPath);
    await second.request('registerController', { identity: { id: 'server-b', generation: 2 } });
    const replacement = await connect(socketPath);
    await replacement.request('registerController', { identity: { id: 'server-b', generation: 2 } });
    await waitFor(() => second.socket.destroyed, 'duplicate controller lease did not replace its old socket');
    const terminalMutation = {
      agentId: 'agent-1',
      terminalId: 'terminal-1',
      input: 'echo once\n',
      operationId: 'terminal-input-1',
      bindingEpoch: 'binding-1',
      signature: 'terminal-input-signature-1',
    };
    assert.strictEqual((await replacement.request('inputTerminal', terminalMutation)).written, true);
    assert.strictEqual((await replacement.request('inputTerminal', terminalMutation)).written, true);
    assert.strictEqual(runtime.inputCalls, 1, 'stable terminal input operationId must execute once per Host epoch');
    const recovered = await replacement.request('recover');
    assert.strictEqual(recovered.bindings[0].state, 'working');
    assert.strictEqual(recovered.promptOperations[0].status, 'provider-owned');
    const joinedPrompt = replacement.request('submitPrompt', {
      agentId: 'agent-1',
      bindingEpoch: 'binding-1',
      clientPromptId: 'prompt-1',
      contentHash: promptContentHash([{ type: 'text', text: 'work' }]),
      prompt: [{ type: 'text', text: 'work' }],
    });
    assert.strictEqual(runtime.promptCalls, 1);
    runtime.promptCompletion({ stopReason: 'end_turn' });
    const result = await joinedPrompt;
    assert.strictEqual(result.stopReason, 'end_turn');
    assert.strictEqual(runtime.promptCalls, 1);
    void originalPrompt.catch(() => {});
    replacement.close();
    const shuttingDown = host.dispose();
    await assert.rejects(connect(socketPath), /ENOENT|ECONNREFUSED/);
    await shuttingDown;
  } finally {
    await host.dispose();
    fs.rmSync(configDir, { recursive: true, force: true });
  }

  const idleConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-acp-runtime-host-idle-'));
  const idleSocketDirectory = path.dirname(acpRuntimeHostSocketPath(idleConfigDir));
  const idleRuntime = new FakeRuntime();
  const idleHost = new AcpRuntimeHostProcess({
    configDir: idleConfigDir,
    runtime: idleRuntime,
    exitOnShutdown: false,
    idleExitMs: 20,
  });
  try {
    await idleHost.start();
    assert.strictEqual(fs.statSync(idleSocketDirectory).mode & 0o777, 0o700);
    assert.strictEqual(fs.statSync(acpRuntimeHostSocketPath(idleConfigDir)).mode & 0o777, 0o600);
    await waitFor(() => idleHost.disposed, 'an unclaimed detached Host did not exit when idle');
  } finally {
    await idleHost.dispose();
    fs.rmSync(idleSocketDirectory, { recursive: true, force: true });
    fs.rmSync(idleConfigDir, { recursive: true, force: true });
  }

  if (process.platform !== 'win32') {
    const symlinkConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-acp-runtime-host-symlink-'));
    const symlinkSocketDirectory = path.dirname(acpRuntimeHostSocketPath(symlinkConfigDir));
    const symlinkTarget = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-acp-runtime-host-target-'));
    try {
      fs.rmSync(symlinkSocketDirectory, { recursive: true, force: true });
      fs.symlinkSync(symlinkTarget, symlinkSocketDirectory);
      const symlinkHost = new AcpRuntimeHostProcess({
        configDir: symlinkConfigDir,
        runtime: new FakeRuntime(),
        exitOnShutdown: false,
      });
      await assert.rejects(symlinkHost.start(), /not a private directory/);
      await symlinkHost.dispose();
      const customParent = path.join(symlinkConfigDir, 'custom-socket-parent');
      fs.symlinkSync(symlinkTarget, customParent);
      const customSymlinkHost = new AcpRuntimeHostProcess({
        configDir: symlinkConfigDir,
        socketPath: path.join(customParent, 'host.sock'),
        runtime: new FakeRuntime(),
        exitOnShutdown: false,
      });
      await assert.rejects(customSymlinkHost.start(), /not a private directory/);
      await customSymlinkHost.dispose();
      const broadParent = path.join(symlinkConfigDir, 'broad-socket-parent');
      fs.mkdirSync(broadParent, { mode: 0o755 });
      fs.chmodSync(broadParent, 0o755);
      const broadHost = new AcpRuntimeHostProcess({
        configDir: symlinkConfigDir,
        socketPath: path.join(broadParent, 'host.sock'),
        runtime: new FakeRuntime(),
        exitOnShutdown: false,
      });
      await assert.rejects(broadHost.start(), /accessible to other users/);
      await broadHost.dispose();
    } finally {
      fs.rmSync(symlinkSocketDirectory, { recursive: true, force: true });
      fs.rmSync(symlinkTarget, { recursive: true, force: true });
      fs.rmSync(symlinkConfigDir, { recursive: true, force: true });
    }
  }

  console.log('ACP runtime host process tests passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
