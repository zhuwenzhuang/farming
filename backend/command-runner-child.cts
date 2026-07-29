import * as readline from 'readline';
import { execFile, type ExecFileException } from 'child_process';

interface CommandRequest {
  id?: unknown;
  command?: unknown;
  args?: unknown;
  cwd?: unknown;
  env?: unknown;
  maxBuffer?: unknown;
  timeout?: unknown;
}

interface CommandError {
  code?: unknown;
  signal?: unknown;
  message: string;
}

function commandError(error: unknown): CommandError {
  if (error && typeof error === 'object') {
    return {
      code: 'code' in error ? error.code : undefined,
      signal: 'signal' in error ? error.signal : undefined,
      message: 'message' in error ? String(error.message) : String(error),
    };
  }
  return { message: String(error) };
}

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

rl.on('line', (line: string) => {
  let request: CommandRequest;
  try {
    request = JSON.parse(line) as CommandRequest;
  } catch (error: unknown) {
    send({ id: null, ok: false, error: { message: commandError(error).message } });
    return;
  }

  const id = request.id;
  try {
    execFile(
      request.command as string,
      Array.isArray(request.args) ? request.args as string[] : [],
      {
        cwd: request.cwd as string || process.cwd(),
        env: {
          ...process.env,
          ...(request.env as NodeJS.ProcessEnv | null | undefined || {}),
        },
        encoding: 'utf8',
        maxBuffer: Number(request.maxBuffer) || 2 * 1024 * 1024,
        timeout: Number(request.timeout) || 0,
        windowsHide: true,
      },
      (error: ExecFileException | null, stdout: string, stderr: string) => {
        if (error) {
          const details = commandError(error);
          send({
            id,
            ok: false,
            error: {
              code: details.code,
              signal: details.signal,
              message: details.message,
              stdout,
              stderr,
            },
          });
          return;
        }

        send({ id, ok: true, stdout, stderr });
      },
    );
  } catch (error: unknown) {
    const details = commandError(error);
    send({
      id,
      ok: false,
      error: {
        code: details.code,
        signal: details.signal,
        message: details.message,
        stdout: '',
        stderr: '',
      },
    });
  }
});

export {};
