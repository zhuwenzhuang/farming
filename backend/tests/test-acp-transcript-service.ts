import assert from 'node:assert/strict';
import test from 'node:test';
import { AcpTranscriptService } from '../acp-transcript-service.cjs';

function runtimeBinding(revision: number) {
  return {
    kind: 'acp' as const,
    state: 'idle',
    error: '',
    stopReason: '',
    supportsSteer: false,
    supportsFork: false,
    pendingPermission: null,
    pendingPermissions: [],
    pendingElicitation: null,
    pendingElicitations: [],
    activeElicitations: [],
    sessionUpdatedAt: '2026-08-19T00:00:00.000Z',
    sessionRevision: revision,
  };
}

test('an ACP Transcript read rejects a Session identity change during the read', async () => {
  const agent = {
    id: 'agent-a',
    providerSessionId: 'session-old',
    runtimeBinding: runtimeBinding(8),
  };
  let runtimeEpoch = 'epoch-old';
  let releaseRead!: () => void;
  const readGate = new Promise<void>(resolve => { releaseRead = resolve; });
  let readStarted!: () => void;
  const started = new Promise<void>(resolve => { readStarted = resolve; });
  const runtime = {
    bindingEpoch: () => runtimeEpoch,
    getSession: () => ({ sessionId: agent.providerSessionId }),
    transcriptProjectionRevision: () => 0,
    transcriptSettled: () => true,
    async getTranscriptSessionForRead() {
      readStarted();
      await readGate;
      return {
        sessionId: 'session-old',
        revision: 8,
        entries: [],
      };
    },
  };
  const service = new AcpTranscriptService({
    getAgent: () => agent as never,
    mediaPathPrefix: () => '/media',
    requireLiveAgent: () => agent as never,
    runtime: runtime as never,
  });

  try {
    const read = service.get('agent-a', { maxTurns: 6 });
    await started;
    agent.providerSessionId = 'session-new';
    agent.runtimeBinding = runtimeBinding(1);
    runtimeEpoch = 'epoch-new';
    releaseRead();

    await assert.rejects(read, /identity changed during read/i);
  } finally {
    service.dispose();
  }
});

test('an ACP Transcript read allows revision progress while Session identity stays stable', async () => {
  const agent = {
    id: 'agent-a',
    providerSessionId: 'session-a',
    runtimeBinding: runtimeBinding(8),
  };
  let revision = 8;
  let releaseRead!: () => void;
  const readGate = new Promise<void>(resolve => { releaseRead = resolve; });
  let readStarted!: () => void;
  const started = new Promise<void>(resolve => { readStarted = resolve; });
  const runtime = {
    bindingEpoch: () => 'epoch-a',
    getSession: () => ({ sessionId: 'session-a', revision }),
    transcriptProjectionRevision: () => 0,
    transcriptSettled: () => true,
    async getTranscriptSessionForRead() {
      readStarted();
      await readGate;
      return {
        sessionId: 'session-a',
        revision,
        entries: [],
      };
    },
  };
  const service = new AcpTranscriptService({
    getAgent: () => agent as never,
    mediaPathPrefix: () => '/media',
    requireLiveAgent: () => agent as never,
    runtime: runtime as never,
  });

  try {
    const read = service.get('agent-a', { maxTurns: 6 });
    await started;
    revision = 9;
    agent.runtimeBinding = runtimeBinding(9);
    releaseRead();

    const payload = await read;
    assert.equal(payload.sessionId, 'session-a');
    assert.equal(payload.runtimeEpoch, 'epoch-a');
    assert.equal(payload.toRevision, 9);
  } finally {
    service.dispose();
  }
});

test('an ACP Transcript read rejects a transcript from another Session', async () => {
  const agent = {
    id: 'agent-a',
    providerSessionId: 'session-a',
    runtimeBinding: runtimeBinding(8),
  };
  const runtime = {
    bindingEpoch: () => 'epoch-a',
    getSession: () => ({ sessionId: 'session-a', revision: 8 }),
    transcriptProjectionRevision: () => 0,
    transcriptSettled: () => true,
    async getTranscriptSessionForRead() {
      return {
        sessionId: 'session-b',
        revision: 8,
        entries: [],
      };
    },
  };
  const service = new AcpTranscriptService({
    getAgent: () => agent as never,
    mediaPathPrefix: () => '/media',
    requireLiveAgent: () => agent as never,
    runtime: runtime as never,
  });

  try {
    await assert.rejects(
      service.get('agent-a', { maxTurns: 6 }),
      /identity changed during read/i,
    );
  } finally {
    service.dispose();
  }
});
