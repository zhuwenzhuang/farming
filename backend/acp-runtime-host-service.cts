import { EventEmitter } from 'events';
import * as crypto from 'crypto';
import { AcpRuntimeHostState, type ControllerIdentity } from './acp-runtime-host-state.cjs';
import { acpLastAssistantNotificationSummary } from './acp-turn-summary.cjs';

type UnknownRecord = Record<string, unknown>;

interface RuntimeLike extends EventEmitter {
  bindingEpoch(agentId: string): string;
  cancel(agentId: string): Promise<unknown>;
  getSession(agentId: string, options?: UnknownRecord): UnknownRecord;
  getSessionRequestOptions?(agentId: string): UnknownRecord;
  getTranscriptSession?(agentId: string, options?: UnknownRecord): UnknownRecord;
  prepareAgent(options?: UnknownRecord): Promise<UnknownRecord>;
  submitMessage(agentId: string, prompt: UnknownRecord[], options?: UnknownRecord): Promise<UnknownRecord>;
  unregisterAgentAndWait?(agentId: string): Promise<boolean>;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as UnknownRecord;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function promptContentHash(prompt: UnknownRecord[], delivery?: string): string {
  return crypto.createHash('sha256').update(canonicalJson({
    delivery: delivery === 'prompt' || delivery === 'steer' ? delivery : 'auto',
    prompt,
  })).digest('hex');
}

interface RuntimeHostServiceOptions {
  runtime: RuntimeLike;
  state?: AcpRuntimeHostState;
}

interface HostPromptRequest extends UnknownRecord {
  agentId: string;
  bindingEpoch: string;
  clientPromptId: string;
  contentHash: string;
  prompt: UnknownRecord[];
  delivery?: string;
}

interface HostCancelRequest extends UnknownRecord {
  agentId: string;
  bindingEpoch: string;
  operationId: string;
  turnHandle: string;
}

class AcpRuntimeHostService extends EventEmitter {
  readonly runtime: RuntimeLike;
  readonly state: AcpRuntimeHostState;

  constructor(options: RuntimeHostServiceOptions) {
    super();
    this.runtime = options.runtime;
    this.state = options.state || new AcpRuntimeHostState();
    this.state.on('event', event => this.emit('event', event));
    this.runtime.on('agent-runtime', event => this.refreshBinding(String(event.agentId || '')));
    this.runtime.on('session', event => {
      const agentId = String(event.agentId || '');
      if (!agentId) return;
      this.state.patchBinding(agentId, {
        ...(Number.isFinite(Number(event.revision)) ? { revision: Number(event.revision) } : {}),
        ...(typeof event.title === 'string' ? { title: event.title } : {}),
        ...(typeof event.updatedAt === 'string' ? { updatedAt: event.updatedAt } : {}),
      });
    });
    this.runtime.on('config-overrides', event => {
      this.state.upsertConfigOverrides(event);
    });
  }

  refreshBinding(agentId: string): void {
    if (!agentId) return;
    let session;
    try {
      session = this.runtime.getSession(agentId, { includeEntries: false, includeUpdates: false });
    } catch {
      return;
    }
    const bindingEpoch = this.runtime.bindingEpoch(agentId);
    if (!bindingEpoch) return;
    const summary = { ...session };
    delete summary.entries;
    delete summary.transcriptTail;
    delete summary.updates;
    const activePrompt = this.state.activePromptOperation(agentId, bindingEpoch);
    const current = this.state.binding(agentId);
    if (activePrompt && current?.bindingEpoch === bindingEpoch) {
      summary.state = current.state;
      summary.turnHandle = current.turnHandle;
    }
    this.state.upsertBinding({
      ...summary,
      agentId,
      bindingEpoch,
      sessionId: String(session.sessionId || ''),
      state: String(summary.state || session.state || 'connecting'),
    });
  }

  registerController(identity: ControllerIdentity): Promise<ControllerIdentity> {
    return this.state.registerController(identity);
  }

  disconnectController(identity: ControllerIdentity): boolean {
    return this.state.disconnectController(identity);
  }

  recover(afterEventSeq?: number): UnknownRecord {
    return this.state.recover(afterEventSeq);
  }

  async prepareAgent(controller: ControllerIdentity, options: UnknownRecord): Promise<UnknownRecord> {
    this.state.assertController(controller);
    const result = await this.runtime.prepareAgent(options);
    const agentId = String(options.agentId || '');
    const sessionId = String(result.sessionId || options.sessionId || '');
    const configOverrides = Array.isArray(result.configOverrides)
      ? result.configOverrides
      : (Array.isArray(options.configOverrides) ? options.configOverrides : []);
    this.refreshBinding(agentId);
    try {
      const binding = this.state.binding(agentId);
      const requestOptions = this.runtime.getSessionRequestOptions?.(agentId);
      if (binding && requestOptions) {
        this.state.upsertBinding({
          ...binding,
          sessionRequestOptions: { ...requestOptions, configOverrides },
        });
      }
    } catch {
      // The runtime snapshot remains authoritative even when optional request metadata is unavailable.
    }
    this.state.upsertConfigOverrides({ agentId, sessionId, configOverrides });
    return result;
  }

  submitPrompt(controller: ControllerIdentity, request: HostPromptRequest): Promise<unknown> {
    const contentHash = promptContentHash(request.prompt, request.delivery);
    if (request.contentHash && request.contentHash !== contentHash) {
      return Promise.reject(new Error('ACP runtime host prompt content hash does not match content'));
    }
    let exactTurnSummary: string | null = null;
    let exactStopReason = '';
    const completion = this.state.submitPrompt(controller, { ...request, contentHash }, (onTurnAdmitted, onSubmitted) => (
      this.runtime.submitMessage(request.agentId, request.prompt, {
        delivery: request.delivery,
        onTurnAdmitted,
        onTurnSettled: (settlement: UnknownRecord = {}) => {
          exactStopReason = String(settlement.stopReason || '');
          try {
            exactTurnSummary = acpLastAssistantNotificationSummary(
              this.runtime.getTranscriptSession?.(request.agentId, { maxTurns: 1 }),
            );
          } catch {
            exactTurnSummary = '';
          }
        },
        onSubmitted,
      }).then(result => {
        if (exactTurnSummary === null) {
          try {
            exactTurnSummary = acpLastAssistantNotificationSummary(
              this.runtime.getTranscriptSession?.(request.agentId, { maxTurns: 1 }),
            );
          } catch {
            exactTurnSummary = '';
          }
        }
        return {
          __farmingHostPromptResult: true,
          result,
          stopReason: exactStopReason,
          turnSummary: exactTurnSummary,
        };
      })
    ));
    void completion.finally(() => {
      this.refreshBinding(request.agentId);
    }).catch(() => {});
    return completion;
  }

  cancelTurn(controller: ControllerIdentity, request: HostCancelRequest): Promise<unknown> {
    const completion = this.state.cancelTurn(controller, request, () => (
      this.runtime.cancel(request.agentId)
    ));
    void completion.finally(() => {
      this.refreshBinding(request.agentId);
    }).catch(() => {});
    return completion;
  }

  async unregisterAgentAndWait(controller: ControllerIdentity, agentId: string): Promise<boolean> {
    this.state.assertController(controller);
    const binding = this.state.binding(agentId);
    const stopped = await this.runtime.unregisterAgentAndWait?.(agentId);
    if (stopped === true && binding) {
      this.state.removeBinding(agentId, binding.bindingEpoch);
    }
    return stopped === true;
  }
}

export {
  AcpRuntimeHostService,
  promptContentHash,
  type HostCancelRequest,
  type HostPromptRequest,
  type RuntimeLike,
};
