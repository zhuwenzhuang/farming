import { spawn } from 'node:child_process';
import { resolveTerminalExecutableAsync } from './executable-discovery.cjs';
import { readServerProcessIdentity } from './server-process-identity.cjs';
import { registerConfigProcessGroup, unregisterConfigProcessGroup } from './config-process-ownership.cjs';

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
}

export function parseClaudeModels(value: unknown) {
  if (!Array.isArray(value) || !value.length) throw new Error('Claude model discovery returned no models');
  const ids = new Set<string>();
  return value.map(raw => {
    const model = record(raw);
    if (typeof model.value !== 'string' || !model.value.trim() || ids.has(model.value)) {
      throw new Error('Claude model discovery returned invalid or duplicate models');
    }
    ids.add(model.value);
    const levels = model.supportedEffortLevels;
    if (levels !== undefined && (!Array.isArray(levels) || !levels.every(level => typeof level === 'string' && level.length > 0))) {
      throw new Error('Claude model discovery returned invalid reasoning capabilities');
    }
    return {
      value: model.value, model: model.value,
      label: typeof model.displayName === 'string' ? model.displayName : model.value,
      displayName: typeof model.displayName === 'string' ? model.displayName : model.value,
      description: typeof model.description === 'string' ? model.description : '',
      defaultEffort: '',
      reasoningLevels: (Array.isArray(levels) ? levels as string[] : []).map(level => ({ value: level, effort: level, label: level })),
      serviceTiers: [], source: 'claude',
    };
  });
}

/** Initialize the selected native runtime without submitting a prompt or saving a Session. */
export async function listClaudeModelOptions(options: {
  env: NodeJS.ProcessEnv;
  executable?: string;
  timeoutMs?: number;
}) {
  const executable = options.executable || (await resolveTerminalExecutableAsync('claude', options.env.PATH || '')).path;
  if (!executable) throw new Error('Claude executable is unavailable');
  return new Promise<{ catalog: ReturnType<typeof parseClaudeModels>; source: 'claude' }>((resolve, reject) => {
    const child = spawn(executable, ['--print', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json', '--no-session-persistence'], {
      env: options.env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32',
    });
    const identity = child.pid ? readServerProcessIdentity(child.pid) : null;
    const configDir = options.env.FARMING_CONFIG_DIR;
    let buffer = '';
    let bytes = 0;
    let result: ReturnType<typeof parseClaudeModels> | undefined;
    let failure: Error | undefined;
    let finished = false;
    const stop = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      // The detached group belongs exclusively to this read-only discovery.
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') failure = new Error('Could not stop Claude model discovery');
      }
    };
    const timer = setTimeout(() => { failure = new Error('Claude model discovery timed out'); stop(); }, options.timeoutMs ?? 15_000);
    child.on('error', error => { failure = error; stop(); });
    child.stdin.on('error', error => { if (!finished) { failure = error; stop(); } });
    child.stderr.on('data', () => {});
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (finished) return;
      bytes += Buffer.byteLength(chunk, 'utf8');
      if (bytes > 1024 * 1024) { failure = new Error('Claude model discovery exceeded its output limit'); stop(); return; }
      buffer += chunk;
      let newline: number;
      while (!finished && (newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        try {
          const message = record(JSON.parse(line));
          if (message.type !== 'control_response') continue;
          const response = record(message.response);
          if (response.request_id !== 'farming-model-catalog') continue;
          if (response.subtype !== 'success') throw new Error('Claude rejected model discovery');
          result = parseClaudeModels(record(response.response).models);
        } catch (error) { failure = error instanceof Error ? error : new Error(String(error)); }
        if (result || failure) stop();
      }
    });
    child.on('close', () => {
      clearTimeout(timer);
      finished = true;
      if (identity && configDir) unregisterConfigProcessGroup(configDir, 'provider-model-discovery', identity);
      if (failure || !result) reject(failure || new Error('Claude exited without a model catalog'));
      else resolve({ catalog: result, source: 'claude' });
    });
    if (identity && configDir) {
      try { registerConfigProcessGroup(configDir, 'provider-model-discovery', identity); }
      catch (error) { failure = error instanceof Error ? error : new Error(String(error)); stop(); return; }
    }
    child.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: 'farming-model-catalog', request: { subtype: 'initialize' } })}\n`);
  });
}
