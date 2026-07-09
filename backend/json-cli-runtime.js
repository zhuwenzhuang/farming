const EventEmitter = require('events');
const { spawn } = require('child_process');
const { AgentJsonStreamParser } = require('./agent-json-stream');

const MAX_EVENTS = 12_000;

function codexPermissionArgs(mode) {
  if (mode === 'full') return ['--dangerously-bypass-approvals-and-sandbox'];
  if (mode === 'ask') return ['-c', 'approval_policy="untrusted"'];
  if (mode === 'approve') return ['-c', 'approval_policy="on-request"'];
  return [];
}

function commandForTurn(options) {
  const sessionId = String(options.sessionId || '').trim();
  if (options.provider === 'codex') {
    const common = ['--json', '--skip-git-repo-check', ...codexPermissionArgs(options.approvalMode)];
    if (options.model) common.push('--model', options.model);
    return sessionId
      ? { args: ['exec', 'resume', ...common, sessionId, '-'], stdin: options.message }
      : { args: ['exec', ...common, '--cd', options.cwd, '-'], stdin: options.message };
  }
  if (options.provider === 'opencode') {
    const args = ['run', '--format', 'json', '--dir', options.cwd];
    if (sessionId) args.push('--session', sessionId);
    if (options.autoApprove) args.push('--auto');
    if (options.model) args.push('--model', options.model);
    args.push(options.message);
    return { args, stdin: '' };
  }
  throw new Error(`Unsupported JSON CLI provider: ${options.provider}`);
}

class JsonCliRuntime extends EventEmitter {
  constructor(options = {}) {
    super();
    this.spawn = options.spawn || spawn;
    this.bindings = new Map();
  }

  registerAgent(options) {
    const binding = {
      ...options,
      events: Array.isArray(options.initialEvents) ? [...options.initialEvents].slice(-MAX_EVENTS) : [],
      child: null,
      operationSeq: 0,
      state: 'idle',
      error: '',
    };
    this.bindings.set(options.agentId, binding);
    return binding;
  }

  unregisterAgent(agentId) {
    const binding = this.bindings.get(agentId);
    if (binding?.child && !binding.child.killed) binding.child.kill('SIGTERM');
    this.bindings.delete(agentId);
  }

  async submitComposerMessage(agentId, message, patch = {}) {
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
        binding.child = null;
        binding.state = 'error';
        binding.error = error.message;
        this.emitRuntime(binding);
        reject(error);
      });
      child.on('close', (code, signal) => {
        parser.flush();
        binding.events.push(...parser.events);
        if (binding.events.length > MAX_EVENTS) binding.events.splice(0, binding.events.length - MAX_EVENTS);
        if (parser.sessionId) binding.sessionId = parser.sessionId;
        binding.child = null;
        binding.state = code === 0 ? 'idle' : 'error';
        binding.error = code === 0 ? '' : (stderr.trim() || `JSON CLI exited with code ${code}${signal ? ` (${signal})` : ''}`);
        this.emit('transcript', { agentId, transcript: this.getTranscript(agentId) });
        this.emitRuntime(binding);
        if (code === 0) resolve({ sessionId: binding.sessionId });
        else reject(new Error(binding.error));
      });
      if (launch.stdin) child.stdin.end(launch.stdin);
      else child.stdin.end();
    });
  }

  interruptAgent(agentId) {
    const child = this.bindings.get(agentId)?.child;
    if (!child) return false;
    child.kill('SIGINT');
    return true;
  }

  getEvents(agentId) {
    return [...(this.bindings.get(agentId)?.events || [])];
  }

  getTranscript(agentId, options = {}) {
    const binding = this.bindings.get(agentId);
    if (!binding) throw new Error('JSON CLI Agent is not registered');
    const parser = new AgentJsonStreamParser({ provider: binding.provider, operationId: 'snapshot' });
    parser.events = [...binding.events];
    return {
      available: binding.events.length > 0,
      sessionId: binding.sessionId || '',
      source: `${binding.provider}-cli-json`,
      turns: parser.transcript(options),
    };
  }

  transcriptWith(binding, activeParser) {
    const parser = new AgentJsonStreamParser({ provider: binding.provider, operationId: 'snapshot' });
    parser.events = [...binding.events, ...activeParser.events];
    return {
      available: parser.events.length > 0,
      sessionId: activeParser.sessionId || binding.sessionId || '',
      source: `${binding.provider}-cli-json`,
      turns: parser.transcript(),
    };
  }

  emitRuntime(binding) {
    this.emit('agent-runtime', {
      agentId: binding.agentId,
      state: binding.state,
      error: binding.error,
      sessionId: binding.sessionId || '',
    });
  }
}

module.exports = { JsonCliRuntime, commandForTurn };
