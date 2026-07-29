import { EventEmitter } from 'events';
import {
  spawn as nodeSpawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from 'child_process';

const { AgentJsonStreamParser } = require('./agent-json-stream.cjs') as {
  AgentJsonStreamParser: new (options: AgentJsonStreamParserOptions) => AgentJsonStreamParser;
};

const MAX_EVENTS = 12_000;
const PROCESS_EXIT_TIMEOUT_MS = 1500;
const PROCESS_KILL_TIMEOUT_MS = 1000;

type JsonEvent = Record<string, unknown>;
type SpawnProcess = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio & {
    stdio: ['pipe', 'pipe', 'pipe'];
  },
) => ChildProcessWithoutNullStreams;

interface AgentJsonStreamParserOptions {
  provider: string;
  operationId: string;
  prompt?: string;
}

interface AgentJsonStreamParser {
  events: JsonEvent[];
  readonly sessionId: string;
  push(chunk: unknown): JsonEvent[];
  flush(): JsonEvent[];
  transcript(options?: unknown): unknown;
}

interface JsonTurnOptions {
  provider: string;
  cwd: string;
  message: string;
  sessionId?: unknown;
  approvalMode?: unknown;
  autoApprove?: unknown;
  model?: unknown;
}

interface JsonTurnCommand {
  args: string[];
  stdin: string;
}

interface JsonAgentRegistration {
  agentId: string;
  provider: string;
  executable: string;
  cwd: string;
  env: NodeJS.ProcessEnv | Record<string, string | undefined>;
  sessionId?: string;
  approvalMode?: string;
  autoApprove?: boolean;
  model?: string;
  initialEvents?: JsonEvent[];
}

interface JsonAgentBinding extends JsonAgentRegistration {
  events: JsonEvent[];
  ownsProcessGroup: boolean;
  child: ChildProcessWithoutNullStreams | null;
  operationSeq: number;
  state: 'idle' | 'working' | 'error';
  error: string;
}

interface JsonCliRuntimeOptions {
  spawn?: SpawnProcess;
  processExitTimeoutMs?: number;
  processKillTimeoutMs?: number;
  ownsProcessGroups?: boolean;
}

interface JsonAgentPatch {
  approvalMode?: string;
  autoApprove?: boolean;
  model?: string;
}

interface JsonRuntimeTranscript {
  available: boolean;
  sessionId: string;
  source: string;
  turns: unknown;
}

function errorCode(error: unknown): string {
  if (!error || typeof error !== 'object' || !('code' in error)) return '';
  return typeof error.code === 'string' ? error.code : '';
}

function childHasExited(child: ChildProcessWithoutNullStreams | null | undefined): boolean {
  return !child
    || (child.exitCode !== null && child.exitCode !== undefined)
    || (child.signalCode !== null && child.signalCode !== undefined);
}

function processTreeHasExited(
  child: ChildProcessWithoutNullStreams | null | undefined,
  ownsProcessGroup: boolean,
): boolean {
  if (!ownsProcessGroup || !child?.pid || process.platform === 'win32') {
    return childHasExited(child);
  }
  try {
    process.kill(-child.pid, 0);
    return false;
  } catch (error) {
    return errorCode(error) === 'ESRCH';
  }
}

async function waitForProcessTreeExit(
  child: ChildProcessWithoutNullStreams | null | undefined,
  ownsProcessGroup: boolean,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (processTreeHasExited(child, ownsProcessGroup)) return true;
    await new Promise<void>(resolve => setTimeout(resolve, 25));
  }
  return processTreeHasExited(child, ownsProcessGroup);
}

function signalProcessTree(
  child: ChildProcessWithoutNullStreams | null | undefined,
  ownsProcessGroup: boolean,
  signal: NodeJS.Signals,
): void {
  if (!child || processTreeHasExited(child, ownsProcessGroup)) return;
  if (ownsProcessGroup && child.pid && process.platform !== 'win32') {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if (errorCode(error) === 'ESRCH') return;
    }
  }
  child.kill(signal);
}

function codexPermissionArgs(mode: unknown): string[] {
  if (mode === 'full') return ['--dangerously-bypass-approvals-and-sandbox'];
  if (mode === 'ask') return ['-c', 'approval_policy="untrusted"'];
  if (mode === 'approve') return ['-c', 'approval_policy="on-request"'];
  return [];
}

function commandForTurn(options: JsonTurnOptions): JsonTurnCommand {
  const sessionId = String(options.sessionId || '').trim();
  if (options.provider === 'codex') {
    const common = ['--json', '--skip-git-repo-check', ...codexPermissionArgs(options.approvalMode)];
    if (options.model) common.push('--model', String(options.model));
    return sessionId
      ? { args: ['exec', 'resume', ...common, sessionId, '-'], stdin: options.message }
      : { args: ['exec', ...common, '--cd', options.cwd, '-'], stdin: options.message };
  }
  if (options.provider === 'opencode') {
    const args = ['run', '--format', 'json', '--dir', options.cwd];
    if (sessionId) args.push('--session', sessionId);
    if (options.autoApprove) args.push('--auto');
    if (options.model) args.push('--model', String(options.model));
    args.push(options.message);
    return { args, stdin: '' };
  }
  throw new Error(`Unsupported JSON CLI provider: ${options.provider}`);
}

class JsonCliRuntime extends EventEmitter {
  spawn: SpawnProcess;
  processExitTimeoutMs: number;
  processKillTimeoutMs: number;
  ownsProcessGroups: boolean;
  bindings: Map<string, JsonAgentBinding>;
  disposing: boolean;
  disposePromise: Promise<void> | null;
  disposed: boolean;

  constructor(options: JsonCliRuntimeOptions = {}) {
    super();
    this.spawn = options.spawn || (nodeSpawn as SpawnProcess);
    this.processExitTimeoutMs = options.processExitTimeoutMs ?? PROCESS_EXIT_TIMEOUT_MS;
    this.processKillTimeoutMs = options.processKillTimeoutMs ?? PROCESS_KILL_TIMEOUT_MS;
    this.ownsProcessGroups = options.ownsProcessGroups ?? process.platform !== 'win32';
    this.bindings = new Map<string, JsonAgentBinding>();
    this.disposing = false;
    this.disposePromise = null;
    this.disposed = false;
  }

  registerAgent(options: JsonAgentRegistration): JsonAgentBinding {
    if (this.disposing || this.disposed) {
      throw new Error('JSON CLI runtime is shutting down');
    }
    const binding: JsonAgentBinding = {
      ...options,
      events: Array.isArray(options.initialEvents) ? [...options.initialEvents].slice(-MAX_EVENTS) : [],
      ownsProcessGroup: this.ownsProcessGroups,
      child: null,
      operationSeq: 0,
      state: 'idle',
      error: '',
    };
    this.bindings.set(options.agentId, binding);
    return binding;
  }

  unregisterAgent(agentId: string): void {
    const binding = this.bindings.get(agentId);
    if (binding?.child) signalProcessTree(binding.child, binding.ownsProcessGroup, 'SIGTERM');
    this.bindings.delete(agentId);
  }

  async unregisterAgentAndWait(agentId: string): Promise<boolean> {
    const binding = this.bindings.get(agentId);
    if (!binding) return false;
    const child = binding.child;
    if (child && !processTreeHasExited(child, binding.ownsProcessGroup)) {
      signalProcessTree(child, binding.ownsProcessGroup, 'SIGTERM');
      if (!await waitForProcessTreeExit(child, binding.ownsProcessGroup, this.processExitTimeoutMs)) {
        signalProcessTree(child, binding.ownsProcessGroup, 'SIGKILL');
        if (!await waitForProcessTreeExit(child, binding.ownsProcessGroup, this.processKillTimeoutMs)) {
          throw new Error(`JSON Agent process tree ${child.pid || ''} did not exit`);
        }
      }
    }
    if (this.bindings.get(agentId) === binding) this.bindings.delete(agentId);
    return true;
  }

  async submitComposerMessage(
    agentId: string,
    message: string,
    patch: JsonAgentPatch = {},
  ): Promise<{ sessionId?: string }> {
    if (this.disposing || this.disposed) {
      throw new Error('JSON CLI runtime is shutting down');
    }
    const binding = this.bindings.get(agentId);
    if (!binding) throw new Error('JSON CLI Agent is not registered');
    if (binding.child) throw new Error('Agent is already working');
    Object.assign(binding, patch);
    binding.operationSeq += 1;
    binding.state = 'working';
    binding.error = '';
    const parser = new AgentJsonStreamParser({
      provider: binding.provider,
      operationId: `${agentId}-${binding.operationSeq}`,
      prompt: message,
    });
    const launch = commandForTurn({ ...binding, message });
    const child = this.spawn(binding.executable, launch.args, {
      cwd: binding.cwd,
      env: binding.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: binding.ownsProcessGroup,
    });
    binding.child = child;
    this.emitRuntime(binding);

    return new Promise((resolve, reject) => {
      let stderr = '';
      child.stdout.on('data', chunk => {
        parser.push(chunk);
        this.emit('transcript', { agentId, transcript: this.transcriptWith(binding, parser) });
      });
      child.stderr.on('data', chunk => {
        stderr = `${stderr}${chunk.toString('utf8')}`.slice(-8000);
      });
      child.on('error', error => {
        if (!child.pid) binding.child = null;
        binding.state = 'error';
        binding.error = error.message;
        this.emitRuntime(binding);
        reject(error);
      });
      child.on('close', (code, signal) => {
        parser.flush();
        binding.events.push(...parser.events);
        if (binding.events.length > MAX_EVENTS) {
          binding.events.splice(0, binding.events.length - MAX_EVENTS);
        }
        if (parser.sessionId) binding.sessionId = parser.sessionId;
        const processTreeExited = processTreeHasExited(child, binding.ownsProcessGroup);
        if (processTreeExited) binding.child = null;
        binding.state = code === 0 && processTreeExited ? 'idle' : 'error';
        binding.error = code === 0 && processTreeExited
          ? ''
          : (
            !processTreeExited
              ? 'JSON CLI root exited while its process tree remained live'
              : (stderr.trim() || `JSON CLI exited with code ${code}${signal ? ` (${signal})` : ''}`)
          );
        this.emit('transcript', { agentId, transcript: this.getTranscript(agentId) });
        this.emitRuntime(binding);
        if (code === 0 && processTreeExited) resolve({ sessionId: binding.sessionId });
        else reject(new Error(binding.error));
      });
      if (launch.stdin) child.stdin.end(launch.stdin);
      else child.stdin.end();
    });
  }

  interruptAgent(agentId: string): boolean {
    const child = this.bindings.get(agentId)?.child;
    if (!child) return false;
    child.kill('SIGINT');
    return true;
  }

  getEvents(agentId: string): JsonEvent[] {
    return [...(this.bindings.get(agentId)?.events || [])];
  }

  getTranscript(agentId: string, options: unknown = {}): JsonRuntimeTranscript {
    const binding = this.bindings.get(agentId);
    if (!binding) throw new Error('JSON CLI Agent is not registered');
    const parser = new AgentJsonStreamParser({
      provider: binding.provider,
      operationId: 'snapshot',
    });
    parser.events = [...binding.events];
    return {
      available: binding.events.length > 0,
      sessionId: binding.sessionId || '',
      source: `${binding.provider}-cli-json`,
      turns: parser.transcript(options),
    };
  }

  transcriptWith(
    binding: JsonAgentBinding,
    activeParser: AgentJsonStreamParser,
  ): JsonRuntimeTranscript {
    const parser = new AgentJsonStreamParser({
      provider: binding.provider,
      operationId: 'snapshot',
    });
    parser.events = [...binding.events, ...activeParser.events];
    return {
      available: parser.events.length > 0,
      sessionId: activeParser.sessionId || binding.sessionId || '',
      source: `${binding.provider}-cli-json`,
      turns: parser.transcript(),
    };
  }

  dispose(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.disposePromise) return this.disposePromise;

    this.disposing = true;
    const disposePromise = this.performDispose();
    this.disposePromise = disposePromise;
    void disposePromise.finally(() => {
      if (this.disposePromise === disposePromise) this.disposePromise = null;
      if (!this.disposed) this.disposing = false;
    }).catch(() => {});
    return disposePromise;
  }

  resumeAfterDisposeAbort(): void {
    this.disposed = false;
    this.disposing = false;
  }

  async performDispose(): Promise<void> {
    const failures: unknown[] = [];
    for (const agentId of [...this.bindings.keys()]) {
      try {
        await this.unregisterAgentAndWait(agentId);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'One or more JSON Agent process trees did not exit');
    }
    this.disposed = true;
  }

  emitRuntime(binding: JsonAgentBinding): void {
    this.emit('agent-runtime', {
      agentId: binding.agentId,
      state: binding.state,
      error: binding.error,
      sessionId: binding.sessionId || '',
    });
  }
}

export { JsonCliRuntime, commandForTurn };
