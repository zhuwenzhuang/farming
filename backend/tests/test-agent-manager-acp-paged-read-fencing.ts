const assert = require('assert');
const crypto = require('crypto');
const { AgentManager } = require('../agent-manager.cjs');
const { createTestAcpRuntime, createTestAgentManager } = require('./helpers/test-acp-runtime.ts');

function config() {
  return {
    getWorkspace: () => '/tmp',
    getHeartbeatInterval: () => 60_000,
    getTaskHistory: () => [],
    getDangerouslySkipAgentPermissionsByDefault: () => false,
    getAgentLaunchProfiles: () => ({}),
    getAgentHome: () => ({ id: 'default', path: '/tmp/.codex' }),
  };
}

function sha256(value: string | Buffer) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function run() {
  const agentId = 'agent-paged-read-fencing';
  let primarySessionId = 'primary-session-v1';
  let runtimeEpoch = 'runtime-epoch-v1';
  const runtime = createTestAcpRuntime({
    hasBinding: (requestedAgentId: string) => requestedAgentId === agentId,
    getSession: (requestedAgentId: string) => {
      assert.strictEqual(requestedAgentId, agentId);
      return { sessionId: primarySessionId };
    },
    bindingEpoch: (requestedAgentId: string) => {
      assert.strictEqual(requestedAgentId, agentId);
      return runtimeEpoch;
    },
  });
  const manager = createTestAgentManager(AgentManager, config(), {
    acpRuntime: runtime,
    skipExecutablePreflight: true,
    transcriptMediaPathPrefix: (requestedAgentId: string, sessionId = '') => (
      `/api/agents/${requestedAgentId}/acp-subagents/${sessionId}/acp-media`
    ),
  });
  manager.agents.set(agentId, {
    id: agentId,
    command: 'codex',
    cwd: '/tmp',
    projectWorkspace: '/tmp',
    status: 'running',
    engineName: 'native',
    runtimeBinding: { kind: 'acp', state: 'idle' },
  });

  try {
    const detailPayload = JSON.stringify({
      detail: 'bounded tool detail',
      changes: [],
      terminals: [],
    });
    const detailSplit = Math.floor(detailPayload.length / 2);
    const detailHash = sha256(detailPayload);
    runtime.getToolDetailPageForRead = async (
      requestedAgentId: string,
      toolCallId: string,
      offset: number,
    ) => {
      assert.strictEqual(requestedAgentId, agentId);
      assert.strictEqual(toolCallId, 'tool-detail-hash-race');
      if (offset === 0) {
        return {
          sessionId: primarySessionId,
          toolCallId,
          offset,
          totalChars: detailPayload.length,
          detailHash,
          serializedDetail: detailPayload.slice(0, detailSplit),
          nextOffset: detailSplit,
        };
      }
      return {
        sessionId: primarySessionId,
        toolCallId,
        offset,
        totalChars: detailPayload.length,
        detailHash: sha256(`${detailPayload}:changed`),
        serializedDetail: detailPayload.slice(detailSplit),
        nextOffset: null,
      };
    };
    await assert.rejects(
      manager.getAcpToolDetail(agentId, 'tool-detail-hash-race'),
      /ACP tool detail changed during read/,
      'tool detail pagination must reject a changed page hash',
    );

    runtime.getToolDetailPageForRead = async (
      _requestedAgentId: string,
      toolCallId: string,
      offset: number,
    ) => offset === 0 ? {
      sessionId: primarySessionId,
      toolCallId,
      offset,
      totalChars: detailPayload.length,
      detailHash,
      serializedDetail: detailPayload.slice(0, detailSplit),
      nextOffset: detailSplit,
    } : {
      sessionId: primarySessionId,
      toolCallId,
      offset,
      totalChars: detailPayload.length,
      detailHash,
      serializedDetail: `${detailPayload.slice(detailSplit, -1)}x`,
      nextOffset: null,
    };
    await assert.rejects(
      manager.getAcpToolDetail(agentId, 'tool-detail-payload-race'),
      /ACP tool detail changed during read/,
      'tool detail pagination must reject content that no longer matches the stable metadata hash',
    );

    primarySessionId = 'primary-session-v1';
    runtimeEpoch = 'runtime-epoch-v1';
    const subagentDetailPayload = JSON.stringify({
      detail: 'delegated detail',
      changes: [],
      subagentSessionId: 'subagent-session-v1',
      terminals: [],
    });
    runtime.getToolDetailPageForRead = async (
      _requestedAgentId: string,
      toolCallId: string,
      offset: number,
    ) => ({
      sessionId: 'primary-session-v1',
      toolCallId,
      offset,
      totalChars: subagentDetailPayload.length,
      detailHash: sha256(subagentDetailPayload),
      serializedDetail: subagentDetailPayload,
      nextOffset: null,
    });
    runtime.getSubagentTranscriptSessionForRead = async () => {
      primarySessionId = 'primary-session-v2';
      runtimeEpoch = 'runtime-epoch-v2';
      return {
        sessionId: 'subagent-session-v1',
        entries: [],
        transcriptProjectionVersion: 1,
      };
    };
    await assert.rejects(
      manager.getAcpToolDetail(agentId, 'tool-detail-subagent-race'),
      /ACP tool detail changed during read/,
      'a subagent transcript must be discarded when the primary Session or runtime changes before return',
    );

    primarySessionId = 'primary-session-v1';
    runtimeEpoch = 'runtime-epoch-v1';
    const reviewPayloads = new Map([
      ['review-tool-a', JSON.stringify([{ path: 'a.ts', kind: 'update' }])],
      ['review-tool-b', JSON.stringify([{ path: 'b.ts', kind: 'update' }])],
    ]);
    runtime.getToolReviewChangesPageForRead = async (
      _requestedAgentId: string,
      toolCallId: string,
      offset: number,
    ) => {
      const serializedChanges = reviewPayloads.get(toolCallId);
      assert(serializedChanges, `missing review payload for ${toolCallId}`);
      if (toolCallId === 'review-tool-b') {
        primarySessionId = 'primary-session-v2';
        runtimeEpoch = 'runtime-epoch-v2';
      }
      return {
        sessionId: 'primary-session-v1',
        toolCallId,
        offset,
        totalChars: serializedChanges.length,
        changesHash: sha256(serializedChanges),
        serializedChanges,
        nextOffset: null,
      };
    };
    await assert.rejects(
      manager.getAcpReviewChanges(agentId, ['review-tool-a', 'review-tool-b']),
      /ACP review changes changed during read/,
      'a multi-tool review must reject the entire response when Session or runtime identity changes between tools',
    );

    primarySessionId = 'primary-session-v1';
    runtimeEpoch = 'runtime-epoch-v1';
    let mediaPageReads = 0;
    runtime.getTranscriptMediaChunkForRead = async () => {
      mediaPageReads += 1;
      throw new Error('primary Session media must be rejected before a Host read');
    };
    await assert.rejects(
      manager.getAcpTranscriptMedia(
        agentId,
        'subagent-entry',
        'subagent-media',
        'primary-session-v1',
      ),
      /ACP transcript media not found/,
      'a subagent media route must reject the primary Session id',
    );
    assert.strictEqual(mediaPageReads, 0, 'a rejected primary Session id must not reach the media page reader');

    console.log('test-agent-manager-acp-paged-read-fencing passed');
  } finally {
    await manager.dispose();
  }
}

run().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
