import type { ComposerSubmissionPhase, ComposerSubmissionStatus } from '../shared/composer-submission.js';
import { CHAT_PROMPT_MAX_ENCODED_BYTES, COMPOSER_ADMISSION_TIMEOUT_MS } from '../shared/chat-capacity.js';
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
  admissionDeadline: number;
  onPhase(phase: ComposerSubmissionPhase): void;
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
  persistCommands?(agent: AgentRecord, commands: ComposerCommandRecord[]): Promise<string>;
  persistenceRequired(): boolean;
  runtimeKind(agent: AgentRecord): ComposerRuntimeKind;
}

export interface AgentComposerAdmissionRequest {
  onPhase?: (status: ComposerSubmissionStatus) => void;
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
  contentHash: string;
  status: ComposerSubmissionStatus;
  observer?: (status: ComposerSubmissionStatus) => void;
  completion: Promise<void>;
  result: Promise<unknown>;
}

export class AgentComposerAdmissionCoordinator {
  readonly #admissions = new Map<string, Map<string, ComposerAdmissionEntry>>();
  readonly #ports: AgentComposerAdmissionPorts;
  readonly #commits = new Map<string, Promise<unknown>>();

  constructor(ports: AgentComposerAdmissionPorts) {
    this.#ports = ports;
  }

  request({
    agent,
    delivery: requestedDelivery,
    message,
    requestId,
    terminalAdmission,
    onPhase,
  }: AgentComposerAdmissionRequest): Promise<unknown> {
    if (!/^[A-Za-z0-9._:-]{1,160}$/.test(requestId)) {
      return Promise.reject(new Error('Composer requestId is invalid'));
    }
    if (Buffer.byteLength(JSON.stringify(message)) > CHAT_PROMPT_MAX_ENCODED_BYTES) {
      return Promise.reject(new Error('Chat message exceeds the encoded submission limit'));
    }
    const prompt = immutableComposerPrompt(message);
    const delivery = requestedDelivery === 'prompt' || requestedDelivery === 'steer'
      ? requestedDelivery
      : 'auto';
    const contentHash = composerCommandHash({ prompt, delivery });
    const commands = normalizedComposerCommands(agent.composerCommands);
    const existing = commands
      .find(command => command.requestId === requestId);
    const active = this.#admissions.get(agent.id)?.get(requestId);
    const inFlight = active?.result;
    if (active && active.contentHash !== contentHash) return Promise.reject(new Error('Composer request was already used for different content'));
    if (existing?.contentHash && existing.contentHash !== contentHash) {
      return Promise.reject(new Error(`Composer request ${requestId} was already used for different content`));
    }
    if (existing?.state === 'accepted') {
      return Promise.resolve({ ...(existing.result || {}), accepted: true, deduplicated: true });
    }
    if (inFlight) {
      if (active) onPhase?.(active.status);
      return inFlight;
    }
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
        this.#remember(agent, unknown);
        void this.#commit(agent, unknown).catch(() => {});
      }
      return Promise.reject(composerAdmissionError(detail, true));
    }
    const unresolvedRequestIds = new Set(commands
      .filter(command => command.state === 'intent' || command.state === 'unknown')
      .map(command => command.requestId));
    for (const id of this.#admissions.get(agent.id)?.keys() || []) unresolvedRequestIds.add(id);
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
    const entry: ComposerAdmissionEntry = {
      completion, result: admissionPromise, contentHash,
      status: { phase: 'received', updatedAt: Date.now() }, observer: onPhase,
    };
    const agentAdmissions = this.#admissions.get(agent.id) || new Map<string, ComposerAdmissionEntry>();
    agentAdmissions.set(requestId, entry);
    this.#admissions.set(agent.id, agentAdmissions);
    this.phase(agent.id, requestId, 'received');
    const admissionDeadline = Date.now() + COMPOSER_ADMISSION_TIMEOUT_MS;
    const assertAdmission = () => {
      owner.assertCurrent();
      if (Date.now() >= admissionDeadline) throw Object.assign(new Error('Chat admission expired before dispatch; the message was not sent'), { composerZeroEffect: true });
    };
    let outcome: 'pending' | 'submitted' | 'failed' = 'pending';
    let intentDurable = false;
    const deadlineTimer = setTimeout(() => {
      if (outcome !== 'pending') return;
      this.phase(agent.id, requestId, 'unknown');
      rejectAdmission(composerAdmissionError('Chat admission deadline reached; reconcile this request before resubmitting', true));
    }, COMPOSER_ADMISSION_TIMEOUT_MS);
    deadlineTimer.unref?.();
    let confirmation: Promise<void> = Promise.resolve();
    const confirmSubmitted = async (result: unknown = { kind: this.#ports.runtimeKind(agent) }) => {
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
      clearTimeout(deadlineTimer);
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
        await this.#commit(agent, accepted);
        this.phase(agent.id, requestId, 'submitted');
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

    const onSubmitted = (result?: unknown) => { confirmation = confirmSubmitted(result); };
    void Promise.resolve()
      .then(async () => {
        assertAdmission();
        try { await this.#commit(agent, intent); }
        catch (error) {
          throw new Error(`Failed to persist Composer intent: ${this.#errorMessage(error)}`, { cause: error });
        }
        intentDurable = true;
        assertAdmission();
        this.phase(agent.id, requestId, 'queued');
        return this.#ports.deliver({
          agent,
          assertCurrentOwner: assertAdmission,
          admissionDeadline,
          onPhase: phase => this.phase(agent.id, requestId, phase),
          delivery,
          onSubmitted,
          prompt,
          requestId,
          retryDefinitiveFailure: existing?.state === 'failed',
          terminalAdmission,
        });
      })
      .then(async result => {
        if (outcome === 'pending') onSubmitted(result);
        await confirmation;
      })
      .catch(async error => {
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
        if (recordExact && intentDurable) {
          try {
            await this.#commit(agent, failed);
          } catch (persistError) {
            failed.state = 'unknown';
            failed.error = `${failed.error}; failed to persist rejection: ${this.#errorMessage(persistError)}`;
            this.#remember(agent, failed);
            outcomeUncertain = true;
          }
        }
        this.phase(agent.id, requestId, outcomeUncertain ? 'unknown' : 'failed', failed.error);
        if (agentAdmissions.get(requestId) === entry) agentAdmissions.delete(requestId);
        rejectAdmission(composerAdmissionError(failed.error, outcomeUncertain));
      })
      .finally(() => { clearTimeout(deadlineTimer); settleCompletion(); });
    void completion.finally(() => {
      const currentAgentAdmissions = this.#admissions.get(agent.id);
      if (currentAgentAdmissions?.get(requestId) === entry) {
        currentAgentAdmissions.delete(requestId);
        if (currentAgentAdmissions.size === 0) this.#admissions.delete(agent.id);
      }
    }).catch(() => {});
    return admissionPromise;
  }

  phase(agentId: string, requestId: string, phase: ComposerSubmissionPhase, message?: string) {
    const entry = this.#admissions.get(agentId)?.get(requestId);
    if (!entry || ['submitted', 'failed'].includes(entry.status.phase) || (entry.status.phase === 'unknown' && !['submitted', 'failed'].includes(phase))) return;
    entry.status = { phase, updatedAt: Date.now(), ...(message ? { message } : {}) };
    try { entry.observer?.(entry.status); } catch { /* Observation cannot change admission. */ }
  }

  status(agent: AgentRecord, requestId: string): ComposerSubmissionStatus {
    const active = this.#admissions.get(agent.id)?.get(requestId);
    if (active) return active.status;
    const saved = normalizedComposerCommands(agent.composerCommands).find(command => command.requestId === requestId);
    return {
      phase: saved?.state === 'accepted' ? 'submitted' : saved?.state === 'failed' ? 'failed' : 'unknown',
      updatedAt: saved?.updatedAt || Date.now(),
      ...(saved?.error ? { message: saved.error } : {}),
    };
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

  #commit(agent: AgentRecord, command: ComposerCommandRecord): Promise<ComposerCommandRecord> {
    const previous = this.#commits.get(agent.id) || Promise.resolve();
    const write = previous.catch(() => {}).then(async () => {
      const commands = normalizedComposerCommands([
        ...normalizedComposerCommands(agent.composerCommands).filter(candidate => candidate.requestId !== command.requestId),
        command,
      ]);
      const staged = { ...agent, composerCommands: commands };
      const id = this.#ports.persistCommands
        ? await this.#ports.persistCommands(agent, commands)
        : this.#ports.persistAgent(staged);
      if (this.#ports.persistenceRequired() && !id) throw new Error('Agent session store did not return a persistent id');
      agent.composerCommands = commands;
      if (staged.agentRecordId || staged.persistentSessionId || id) {
        agent.agentRecordId = staged.agentRecordId || staged.persistentSessionId || id;
        agent.persistentSessionId = agent.agentRecordId;
      }
      return command;
    });
    this.#commits.set(agent.id, write);
    void write.finally(() => {
      if (this.#commits.get(agent.id) === write) this.#commits.delete(agent.id);
    }).catch(() => {});
    return write;
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
