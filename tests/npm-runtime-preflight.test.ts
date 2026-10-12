import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import readline from 'node:readline';
import test from 'node:test';

test('runtime preflight drains independent sockets and fails on transport errors within its deadline', { timeout: 15_000 }, async () => {
  // Exercise the actual CLI helper without entering its publication loop. HTTP
  // and HTTPS share agent:false ownership; the local fixture needs no credentials.
  const source = fs.readFileSync(path.resolve(__dirname, '../scripts/publish-npm-runtimes.mjs'), 'utf8');
  const start = source.indexOf('function readRegistryStatus(');
  const end = source.indexOf('const [packageDirectory');
  assert(start >= 0 && end > start);
  const connections: string[] = [];
  let completedBodies = 0;
  const transport = { get: (url: string, options: http.RequestOptions, respond: (response: http.IncomingMessage) => void) => {
    assert.equal(options.agent, false);
    return http.get(url, options, response => {
      connections.push(String(response.headers['x-connection']));
      response.once('end', () => { completedBodies += 1; });
      respond(response);
    });
  } };
  const readStatus = new Function('https', `${source.slice(start, end)}; return readRegistryStatus;`)(transport) as (url: string) => Promise<number>;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import http from 'node:http';
    let nextConnection = 0;
    const server = http.createServer((request, response) => {
      response.setHeader('x-connection', request.socket.connectionId);
      if (request.url === '/disconnect') { request.socket.destroy(); return; }
      if (request.url === '/stall') { response.write('{}'); return; }
      response.statusCode = request.url === '/missing' ? 404 : request.url === '/unavailable' ? 503 : 200;
      response.end('{}');
    });
    server.keepAliveTimeout = 50;
    server.keepAliveTimeoutBuffer = 0;
    server.on('connection', socket => { socket.connectionId = ++nextConnection; });
    server.listen(0, '127.0.0.1', () => console.log(server.address().port));
  `], { stdio: ['ignore', 'pipe', 'inherit'] });
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
  const lines = readline.createInterface({ input: child.stdout });
  try {
    const [port] = await once(lines, 'line', { signal: AbortSignal.timeout(5000) });
    for (const [index, suffix] of ['/present', '/missing', '/present'].entries()) {
      assert.equal(await readStatus(`http://127.0.0.1:${port}${suffix}`), suffix === '/missing' ? 404 : 200);
      assert.equal(completedBodies, index + 1, 'the body must be drained before the CLI wait starts');
      assert.equal(spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 150)']).status, 0);
    }
    assert.equal(new Set(connections).size, 3, 'no socket may cross the blocking publication boundary');
    assert.equal(await readStatus(`http://127.0.0.1:${port}/unavailable`), 503, 'preserve non-success status for the publication guard');
    await assert.rejects(readStatus(`http://127.0.0.1:${port}/disconnect`));
    await assert.rejects(readStatus(`http://127.0.0.1:${port}/stall`), { name: 'AbortError' });
  } finally {
    lines.close();
    child.kill('SIGKILL');
    await closed;
  }
});
