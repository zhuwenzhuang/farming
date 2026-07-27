const { spawn } = require('child_process');

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const [, , executablePath, ...args] = process.argv;
if (!executablePath) fail('Browser launch gate is missing the executable path');

let released = false;
process.stdin.setEncoding('utf8');
process.stdin.once('data', chunk => {
  if (released || !String(chunk).startsWith('GO\n')) fail('Browser launch gate received an invalid release');
  released = true;
  const child = spawn(executablePath, args, {
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  child.once('error', error => fail(error.message || error));
  child.once('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code || 0);
  });
});
process.stdin.once('end', () => {
  if (!released) fail('Browser launch gate closed before release');
});
