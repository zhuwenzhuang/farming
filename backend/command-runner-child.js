const readline = require('readline');
const { execFile } = require('child_process');

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

rl.on('line', (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch (error) {
    send({ id: null, ok: false, error: { message: error.message } });
    return;
  }

  const id = request.id;
  try {
    execFile(
      request.command,
      Array.isArray(request.args) ? request.args : [],
      {
        cwd: request.cwd || process.cwd(),
        env: { ...process.env, ...(request.env || {}) },
        encoding: 'utf8',
        maxBuffer: Number(request.maxBuffer) || 2 * 1024 * 1024,
        timeout: Number(request.timeout) || 0,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          send({
            id,
            ok: false,
            error: {
              code: error.code,
              signal: error.signal,
              message: error.message,
              stdout,
              stderr,
            },
          });
          return;
        }

        send({ id, ok: true, stdout, stderr });
      }
    );
  } catch (error) {
    send({
      id,
      ok: false,
      error: {
        code: error.code,
        signal: error.signal,
        message: error.message,
        stdout: '',
        stderr: '',
      },
    });
  }
});
