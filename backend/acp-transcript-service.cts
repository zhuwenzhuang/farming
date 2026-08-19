'use strict';

import type {
  AcpRuntimeContract,
  AcpSessionRequestOptions,
  AcpTranscriptEntry,
} from './agent-manager-provider-types.js';
import type { AgentRecord } from './agent-manager-record-types.js';
import { runtimeBindingOf } from './agent-runtime-binding.cjs';
import { AcpPreparedTranscriptCache } from './acp-prepared-transcript-cache.cjs';
import { acpTranscriptEntries } from './acp-transcript.cjs';

type UnknownRecord = Record<string, unknown>;
type TranscriptResponse = { payload?: UnknownRecord; serialized?: string };

type AcpTranscriptServiceOptions = {
  getAgent: (agentId: string) => AgentRecord | undefined;
  mediaPathPrefix: (agentId: string) => string;
  requireLiveAgent: (agentId: string) => AgentRecord;
  runtime: AcpRuntimeContract;
};

const PREPARED_TRANSCRIPT_TURN_LIMIT = 5;
const PREPARED_TRANSCRIPT_QUIET_MS = 60;

function isTranscriptEntry(value: unknown): value is AcpTranscriptEntry {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

class AcpTranscriptService {
  private readonly getAgent: AcpTranscriptServiceOptions['getAgent'];
  private readonly mediaPathPrefix: AcpTranscriptServiceOptions['mediaPathPrefix'];
  private readonly requireLiveAgent: AcpTranscriptServiceOptions['requireLiveAgent'];
  private readonly runtime: AcpRuntimeContract;
  private readonly prepared: AcpPreparedTranscriptCache;
  private readonly reads = new Map<string, Promise<TranscriptResponse>>();

  constructor(options: AcpTranscriptServiceOptions) {
    this.getAgent = options.getAgent;
    this.mediaPathPrefix = options.mediaPathPrefix;
    this.requireLiveAgent = options.requireLiveAgent;
    this.runtime = options.runtime;
    this.prepared = new AcpPreparedTranscriptCache({
      prepare: identity => this.buildEnvelope(identity.agentId, {
        maxTurns: PREPARED_TRANSCRIPT_TURN_LIMIT,
        mediaPathPrefix: this.mediaPathPrefix(identity.agentId),
      }),
      validate: identity => this.validatePreparedIdentity(identity),
      quietMs: PREPARED_TRANSCRIPT_QUIET_MS,
    });
  }

  async get(agentId: string, options: Partial<AcpSessionRequestOptions> = {}): Promise<UnknownRecord> {
    const response = await this.resolve(agentId, options);
    if (response.payload) return response.payload;
    return JSON.parse(String(response.serialized || '{}')) as UnknownRecord;
  }

  async getSerialized(
    agentId: string,
    options: Partial<AcpSessionRequestOptions> = {},
  ): Promise<string> {
    const response = await this.resolve(agentId, options);
    return response.serialized || JSON.stringify(response.payload);
  }

  async resolve(
    agentId: string,
    options: Partial<AcpSessionRequestOptions> = {},
  ): Promise<TranscriptResponse> {
    const agent = this.requireLiveAgent(agentId);
    const runtimeBinding = runtimeBindingOf(agent, 'acp');
    const identity = {
      agentId,
      sessionId: String(agent.providerSessionId || ''),
      runtimeEpoch: this.runtime.bindingEpoch(agentId),
      revision: Number(runtimeBinding?.sessionRevision || 0),
      projectionRevision: this.runtime.transcriptProjectionRevision(agentId),
    };
    const preparedProfile = !Number.isFinite(Number(options.sinceRevision))
      && Number(options.maxTurns) === PREPARED_TRANSCRIPT_TURN_LIMIT
      && options.mediaPathPrefix === this.mediaPathPrefix(agentId);
    if (preparedProfile && identity.sessionId) {
      this.observe(agentId, 100);
      const serialized = this.prepared.getSerialized(identity);
      if (serialized) return { serialized };
    }
    const readKey = JSON.stringify({
      agentId,
      sessionId: identity.sessionId,
      runtimeEpoch: identity.runtimeEpoch,
      maxTurns: Number(options.maxTurns) || 0,
      sinceRevision: Number.isFinite(Number(options.sinceRevision)) ? Number(options.sinceRevision) : null,
      mediaPathPrefix: String(options.mediaPathPrefix || ''),
    });
    const existing = this.reads.get(readKey);
    if (existing) return existing;
    const read = (async () => {
      const payload = await this.buildEnvelope(agentId, options);
      if (preparedProfile && identity.sessionId) {
        const serialized = this.prepared.publishOnDemand(identity, payload);
        if (serialized) return { payload, serialized };
      }
      return { payload };
    })().finally(() => {
      if (this.reads.get(readKey) === read) this.reads.delete(readKey);
    });
    this.reads.set(readKey, read);
    return read;
  }

  async buildEnvelope(
    agentId: string,
    options: Partial<AcpSessionRequestOptions> = {},
  ): Promise<UnknownRecord> {
    const identityBefore = this.currentTranscriptIdentity(agentId);
    const transcript = await this.build(agentId, options);
    const identityAfter = this.currentTranscriptIdentity(agentId);
    if (
      identityBefore.sessionId !== identityAfter.sessionId
      || identityBefore.runtimeEpoch !== identityAfter.runtimeEpoch
      || String(transcript.sessionId || '') !== identityAfter.sessionId
    ) {
      throw new Error('ACP Transcript identity changed during read');
    }
    const requestedRevision = Number(options.sinceRevision);
    const replace = transcript.delta !== true;
    return {
      version: 1,
      agentId,
      sessionId: String(transcript.sessionId || ''),
      runtimeEpoch: identityAfter.runtimeEpoch,
      fromRevision: !replace && Number.isFinite(requestedRevision)
        ? Math.max(0, Math.floor(requestedRevision))
        : null,
      toRevision: Number(transcript.revision || 0),
      replace,
      settled: this.runtime.transcriptSettled(agentId),
      hasMoreBefore: transcript.hasMoreBefore === true,
      transcript,
    };
  }

  observe(agentId: string, priority = 0): void {
    const agent = this.getAgent(agentId);
    const runtimeBinding = runtimeBindingOf(agent, 'acp');
    const sessionId = String(agent?.providerSessionId || '');
    if (!agent || !runtimeBinding || !sessionId) return;
    this.prepared.observe({
      agentId,
      sessionId,
      runtimeEpoch: this.runtime.bindingEpoch(agentId),
      revision: Number(runtimeBinding.sessionRevision || 0),
      projectionRevision: this.runtime.transcriptProjectionRevision(agentId),
      eligible: runtimeBinding.state === 'idle',
      priority,
    });
  }

  refresh(agentId: string): void {
    if (this.prepared.hasAgent(agentId)) this.observe(agentId);
  }

  prioritize(agentId: string): void {
    this.observe(agentId, 100);
  }

  prepare(agentId: string): { accepted: true } {
    this.requireLiveAgent(agentId);
    this.observe(agentId, 100);
    return { accepted: true };
  }

  deleteAgent(agentId: string): void {
    this.prepared.deleteAgent(agentId);
  }

  stats(): ReturnType<AcpPreparedTranscriptCache['stats']> {
    return this.prepared.stats();
  }

  dispose(): void {
    this.prepared.dispose();
    this.reads.clear();
  }

  async build(
    agentId: string,
    options: Partial<AcpSessionRequestOptions>,
  ): Promise<UnknownRecord> {
    this.requireLiveAgent(agentId);
    const transcript = await this.runtime.getTranscriptSessionForRead(agentId, options);
    const entries = Array.isArray(transcript.entries)
      ? transcript.entries.filter(isTranscriptEntry)
      : [];
    return {
      ...transcript,
      entries: acpTranscriptEntries(entries, {
        mediaPathPrefix: typeof options.mediaPathPrefix === 'string'
          ? options.mediaPathPrefix
          : undefined,
      }),
    };
  }

  private validatePreparedIdentity(identity: {
    agentId: string;
    sessionId: string;
    runtimeEpoch: string;
    revision: number;
  }): boolean {
    const agent = this.getAgent(identity.agentId);
    const runtimeBinding = runtimeBindingOf(agent, 'acp');
    return Boolean(
      agent
      && runtimeBinding
      && String(agent.providerSessionId || '') === identity.sessionId
      && this.runtime.bindingEpoch(identity.agentId) === identity.runtimeEpoch
      && Number(runtimeBinding.sessionRevision || 0) === identity.revision
      && runtimeBinding.state === 'idle'
    );
  }

  private currentTranscriptIdentity(agentId: string) {
    this.requireLiveAgent(agentId);
    const session = this.runtime.getSession(agentId, {
      includeEntries: false,
      includeUpdates: false,
    });
    const sessionId = String(session.sessionId || '').trim();
    const runtimeEpoch = String(this.runtime.bindingEpoch(agentId) || '').trim();
    if (!sessionId || !runtimeEpoch) {
      throw new Error('ACP Transcript identity is unavailable');
    }
    return { sessionId, runtimeEpoch };
  }
}

export {
  AcpTranscriptService,
  PREPARED_TRANSCRIPT_TURN_LIMIT,
};
