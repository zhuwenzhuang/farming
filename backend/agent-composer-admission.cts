import type {
  AgentRecord,
  ComposerCommandRecord,
} from './agent-manager-record-types.js';

const crypto = require('crypto');

const MAX_COMPOSER_COMMANDS = 64;
const MAX_UNRESOLVED_COMPOSER_COMMANDS = 64;

type ComposerDelivery = 'auto' | 'prompt' | 'steer';
type ComposerRuntimeKind = 'terminal' | 'acp';

interface ComposerContentPart extends Record<string, unknown> {
  type: string;
  text?: string;
}

interface ComposerSubmissionResult extends Record<string, unknown> {
  kind: ComposerRuntimeKind;
}

interface ComposerDeliveryRequest {
  agent: AgentRecord;
  assertCurrentOwner(): void;
  delivery: ComposerDelivery;
  onSubmitted(result?: unknown): void;
  prompt: ComposerContentPart[];
  requestId: string;
  retryDefinitiveFailure: boolean;
  terminalAdmission?: TerminalAdmissionContext;
}

/**
 * Opaque Terminal admission context captured at request time. The
 * coordinator passes it through unchanged; ownership and semantics belong
 * to the AgentManager delivery port.
 */
interface TerminalAdmissionContext {
  admissionPhase: number;
  expectedRuntimeEpoch: string;
}

export interface ComposerDeliveryOwner {
  /**
   * Throws when this admission no longer owns delivery. The thrown error may
   * carry `composerRecordExact` (the exact Agent record is still installed) and
   * `composerZeroEffect` (the guard proves no provider-visible effect happened).
   */
  assertCurrent(): void;
}

export interface AgentComposerAdmissionPorts {
  captureDeliveryOwner(agent: AgentRecord): ComposerDeliveryOwner;
  deliver(request: ComposerDeliveryRequest): Promise<unknown>;
  persistAgent(agent: AgentRecord): string;
  persistenceRequired(): boolean;
  runtimeKind(agent: AgentRecord): ComposerRuntimeKind;
}

export interface AgentComposerAdmissionRequest {
  agent: AgentRecord;
  delivery?: ComposerDelivery;
  message: unknown;
  requestId: string;
  terminalAdmission?: TerminalAdmissionContext;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isComposerCommandRecord(value: unknown): value is ComposerCommandRecord {
  return isRecord(value)
    && typeof value.requestId === 'string'
    && /^[A-Za-z0-9._:-]{1,160}$/.test(value.requestId)
    && typeof value.contentHash === 'string'
    && typeof value.state === 'string'
    && ['intent', 'accepted', 'unknown', 'failed'].includes(value.state);
}

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  return Object.keys(record).sort().reduce((result: Record<string, unknown>, key) => {
    const child = record[key];
    if (!['function', 'symbol', 'undefined'].includes(typeof child)) {
      result[key] = stableJsonValue(child);
    }
    return result;
  }, {});
}

function deepFreeze<Value>(value: Value): Value {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function normalizedComposerPrompt(message: unknown): ComposerContentPart[] {
  const prompt = Array.isArray(message) ? message : [{ type: 'text', text: String(message || '') }];
  const text = prompt
    .filter((content: ComposerContentPart) => content?.type === 'text')
    .map((content: ComposerContentPart) => String(content.text || ''))
    .join('')
    .trim();
  if (prompt.length === 0 || (!text && !prompt.some((content: ComposerContentPart) => content?.type !== 'text'))) {
    throw new Error('Composer message is empty');
  }
  return prompt;
}

export function composerCommandHash(prompt: unknown): string {
  return crypto.createHash('sha256')
    .update(JSON.stringify(stableJsonValue(prompt)))
    .digest('hex');
}

function immutableComposerPrompt(message: unknown): ComposerContentPart[] {
  const snapshot = stableJsonValue(normalizedComposerPrompt(message));
  if (!Array.isArray(snapshot)) throw new Error('Composer message is invalid');
  return deepFreeze(snapshot) as ComposerContentPart[];
}

export function composerAdmissionError(
  message: string,
  uncertain = false,
): Error & { uncertain?: boolean } {
  const error: Error & { uncertain?: boolean } = new Error(message);
  if (uncertain) error.uncertain = true;
  return error;
}

export function normalizedComposerCommands(commands: unknown): ComposerCommandRecord[] {
  const normalized = (Array.isArray(commands) ? commands : [])
    .filter(isComposerCommandRecord)
    .map((command: ComposerCommandRecord): ComposerCommandRecord => ({
      requestId: command.requestId,
      contentHash: command.contentHash,
      state: command.state,
      result: command.result && typeof command.result === 'object'
        ? JSON.parse(JSON.stringify(command.result))
        : null,
      error: typeof command.error === 'string' ? command.error.slice(0, 2000) : '',
      createdAt: Number(command.createdAt) || 0,
      updatedAt: Number(command.updatedAt) || 0,
    }));
  let terminalBudget = MAX_COMPOSER_COMMANDS;
  const retained: ComposerCommandRecord[] = [];
  for (let index = normalized.length - 1; index >= 0; index -= 1) {
    const command = normalized[index];
    if (command.state === 'intent' || command.state === 'unknown') {
      retained.push(command);
    } else if (terminalBudget > 0) {
      terminalBudget -= 1;
      retained.push(command);
    }
  }
  return retained.reverse();
}

interface ComposerAdmissionEntry {
  completion: Promise<void>;
  result: Promise<unknown>;
}

export class AgentComposerAdmissionCoordinator {
  readonly #admissions = new Map<string, Map<string, ComposerAdmissionEntry>>();
  readonly #ports: AgentComposerAdmissionPorts;

  constructor(ports: AgentComposerAdmissionPorts) {
    this.#ports = ports;
  }

  request({
    agent,
    delivery: requestedDelivery,
    message,
    requestId,
    terminalAdmission,
  }: AgentComposerAdmissionRequest): Promise<unknown> {
    if (!/^[A-Za-z0-9._:-]{1,160}$/.test(requestId)) {
      return Promise.reject(new Error('Composer requestId is invalid'));
    }
    const prompt = immutableComposerPrompt(message);
    const delivery = requestedDelivery === 'prompt' || requestedDelivery === 'steer'
      ? requestedDelivery
      : 'auto';
    const contentHash = composerCommandHash({ prompt, delivery });
    const commands = normalizedComposerCommands(agent.composerCommands);
    const existing = commands
      .find(command => command.requestId === requestId);
    const inFlight = this.#admissions.get(agent.id)?.get(requestId)?.result;
    if (existing?.contentHash && existing.contentHash !== contentHash) {
      return Promise.reject(new Error(`Composer request ${requestId} was already used for different content`));
    }
    if (existing?.state === 'accepted') {
      return Promise.resolve({ ...(existing.result || {}), accepted: true, deduplicated: true });
    }
    if (inFlight) return inFlight;
    if (existing?.state === 'unknown' || existing?.state === 'intent') {
      const detail = existing.error
        || `Composer request ${requestId} has an uncertain outcome and will not be replayed automatically`;
      if (existing.state === 'intent') {
        const unknown: ComposerCommandRecord = {
          ...existing,
          state: 'unknown',
          error: detail,
          updatedAt: Date.now(),
        };
        try {
          this.#commit(agent, unknown);
        } catch {
          this.#remember(agent, unknown);
        }
      }
      return Promise.reject(composerAdmissionError(detail, true));
    }
    const unresolvedRequestIds = new Set(commands
      .filter(command => command.state === 'intent' || command.state === 'unknown')
      .map(command => command.requestId));
    if (unresolvedRequestIds.size >= MAX_UNRESOLVED_COMPOSER_COMMANDS) {
      return Promise.reject(new Error(
        'Too many unresolved Composer requests; reconcile an existing request before submitting another',
      ));
    }

    const owner = this.#ports.captureDeliveryOwner(agent);
    const intent: ComposerCommandRecord = {
      requestId,
      contentHash,
      state: 'intent',
      result: null,
      error: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    try {
      this.#commit(agent, intent);
    } catch (error) {
      return Promise.reject(new Error(`Failed to persist Composer intent: ${this.#errorMessage(error)}`));
    }

    let resolveAdmission!: (value: unknown) => void;
    let rejectAdmission!: (reason?: unknown) => void;
    const admissionPromise = new Promise<unknown>((resolve, reject) => {
      resolveAdmission = resolve;
      rejectAdmission = reject;
    });
    let settleCompletion!: () => void;
    const completion = new Promise<void>(resolve => {
      settleCompletion = resolve;
    });
    const entry = { completion, result: admissionPromise };
    const agentAdmissions = this.#admissions.get(agent.id) || new Map<string, ComposerAdmissionEntry>();
    agentAdmissions.set(requestId, entry);
    this.#admissions.set(agent.id, agentAdmissions);
    let outcome: 'pending' | 'submitted' | 'failed' = 'pending';
    const onSubmitted = (result: unknown = { kind: this.#ports.runtimeKind(agent) }) => {
      if (outcome !== 'pending') return;
      try {
        owner.assertCurrent();
      } catch (error) {
        outcome = 'failed';
        rejectAdmission(composerAdmissionError(
          `Agent runtime changed before Composer admission was confirmed: ${this.#errorMessage(error)}`,
          true,
        ));
        return;
      }
      outcome = 'submitted';
      const submission: ComposerSubmissionResult = isRecord(result)
        ? { kind: this.#ports.runtimeKind(agent), ...result }
        : { kind: this.#ports.runtimeKind(agent) };
      const accepted: ComposerCommandRecord = {
        ...intent,
        state: 'accepted',
        result: submission,
        updatedAt: Date.now(),
      };
      try {
        this.#commit(agent, accepted);
        resolveAdmission({ ...submission, accepted: true });
      } catch (error) {
        const unknown: ComposerCommandRecord = {
          ...intent,
          state: 'unknown',
          error: `Provider accepted Composer request, but admission could not be saved: ${this.#errorMessage(error)}`,
          updatedAt: Date.now(),
        };
        this.#remember(agent, unknown);
        rejectAdmission(composerAdmissionError(unknown.error, true));
      }
    };

    void Promise.resolve()
      .then(() => {
        owner.assertCurrent();
        return this.#ports.deliver({
          agent,
          assertCurrentOwner: () => owner.assertCurrent(),
          delivery,
          onSubmitted,
          prompt,
          requestId,
          retryDefinitiveFailure: existing?.state === 'failed',
          terminalAdmission,
        });
      })
      .then(result => {
        if (outcome === 'pending') onSubmitted(result);
      })
      .catch(error => {
        if (outcome !== 'pending') return;
        outcome = 'failed';
        const ownerFailure = this.#ownerFailure(owner);
        const recordExact = !ownerFailure || this.#proves(ownerFailure, 'composerRecordExact');
        const zeroEffect = recordExact && this.#proves(error, 'composerZeroEffect');
        const uncertain = this.#proves(error, 'uncertain') || (Boolean(ownerFailure) && !zeroEffect);
        const failed: ComposerCommandRecord = {
          ...intent,
          state: uncertain ? 'unknown' : 'failed',
          error: this.#errorMessage(error),
          updatedAt: Date.now(),
        };
        let outcomeUncertain = uncertain;
        if (recordExact) {
          try {
            this.#commit(agent, failed);
          } catch (persistError) {
            failed.state = 'unknown';
            failed.error = `${failed.error}; failed to persist rejection: ${this.#errorMessage(persistError)}`;
            this.#remember(agent, failed);
            outcomeUncertain = true;
          }
        }
        rejectAdmission(composerAdmissionError(failed.error, outcomeUncertain));
      })
      .finally(settleCompletion);
    void completion.finally(() => {
      const currentAgentAdmissions = this.#admissions.get(agent.id);
      if (currentAgentAdmissions?.get(requestId) === entry) {
        currentAgentAdmissions.delete(requestId);
        if (currentAgentAdmissions.size === 0) this.#admissions.delete(agent.id);
      }
    }).catch(() => {});
    return admissionPromise;
  }

  async whenIdle(agentId: string): Promise<boolean> {
    let waited = false;
    while (true) {
      const entries = this.#admissions.get(agentId);
      if (!entries || entries.size === 0) return waited;
      waited = true;
      await Promise.all([...entries.values()].map(entry => entry.completion));
    }
  }

  #commit(agent: AgentRecord, command: ComposerCommandRecord) {
    const commands = normalizedComposerCommands(agent.composerCommands)
      .filter(candidate => candidate.requestId !== command.requestId);
    commands.push(command);
    const staged: AgentRecord = {
      ...agent,
      composerCommands: normalizedComposerCommands(commands),
    };
    const persistentSessionId = this.#ports.persistAgent(staged);
    if (this.#ports.persistenceRequired() && !persistentSessionId) {
      throw new Error('Agent session store did not return a persistent id');
    }
    agent.composerCommands = staged.composerCommands || [];
    if (staged.agentRecordId || staged.persistentSessionId || persistentSessionId) {
      const agentRecordId = staged.agentRecordId || staged.persistentSessionId || persistentSessionId;
      agent.agentRecordId = agentRecordId;
      agent.persistentSessionId = agentRecordId;
    }
    return command;
  }

  #remember(agent: AgentRecord, command: ComposerCommandRecord) {
    agent.composerCommands = normalizedComposerCommands([
      ...normalizedComposerCommands(agent.composerCommands)
        .filter(candidate => candidate.requestId !== command.requestId),
      command,
    ]);
  }

  #ownerFailure(owner: ComposerDeliveryOwner): unknown {
    try {
      owner.assertCurrent();
      return null;
    } catch (error) {
      return error || new Error('Composer delivery ownership changed');
    }
  }

  #proves(value: unknown, proof: 'composerRecordExact' | 'composerZeroEffect' | 'uncertain') {
    return isRecord(value) && value[proof] === true;
  }

  #errorMessage(error: unknown) {
    if (error instanceof Error) return error.message;
    if (isRecord(error) && error.message) return String(error.message);
    return String(error);
  }
}
