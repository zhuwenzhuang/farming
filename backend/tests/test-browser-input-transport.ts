import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { CdpBrowserInputTransport } from '../../extensions/browser/backend/browser-input-transport.cjs';

async function run() {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const messages: Array<{ method: string; params: Record<string, unknown>; sessionId?: string }> = [];
  const expressions: string[] = [];
  const failures: string[] = [];
  let notifyFailure: () => void;
  const failed = new Promise<void>(resolve => { notifyFailure = resolve; });
  server.on('connection', socket => socket.on('message', bytes => {
    const message = JSON.parse(String(bytes));
    messages.push(message);
    if (message.method === 'Input.insertText') return; // Simulate a lost execution response.
    let result: Record<string, unknown> = {};
    switch (message.method) {
      case 'Target.attachToBrowserTarget': result = { sessionId: 'browser' }; break;
      case 'Target.getTargets':
        result = { targetInfos: [
          { targetId: 'unrelated', type: 'page', url: 'https://same.example' },
          { targetId: 'selected', type: 'page', url: 'https://same.example' },
        ] }; break;
      case 'Target.attachToTarget': result = { sessionId: message.params.targetId }; break;
      case 'Runtime.evaluate': result = { result: { value: message.sessionId === 'selected' } }; break;
    }
    socket.send(JSON.stringify({ id: message.id, result }));
  }));
  const transport = new CdpBrowserInputTransport(async args => {
    if (args[0] === 'get') return { data: { cdpUrl: `ws://127.0.0.1:${address.port}` } };
    expressions.push(Buffer.from(args[2], 'base64').toString());
    return { data: { result: true } };
  }, message => { failures.push(message); notifyFailure(); });
  try {
    const key = { type: 'keyDown', key: 'a', modifiers: 4, commands: ['selectAll'], autoRepeat: true };
    await transport.send('t1', 'Input.dispatchKeyEvent', key);
    assert.equal(messages.at(-1)?.method, 'Input.dispatchKeyEvent');
    assert.deepEqual(messages.at(-1)?.params, key);
    assert.equal(messages.at(-1)?.sessionId, 'selected');
    assert(messages.some(message => message.method === 'Target.detachFromTarget' && message.params.sessionId === 'unrelated' && message.sessionId === 'browser'));
    assert(messages.filter(message => message.method === 'Target.attachToTarget').every(message => message.sessionId === 'browser'), 'use private auxiliary sessions so detach cannot release a shared relay debugger');
    assert.equal(expressions.length, 2);
    assert.match(expressions[1], /clearTimeout.*delete globalThis/);
    await transport.send('t1', 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 2, buttons: 1 });
    assert.equal(messages.filter(message => message.method === 'Target.getTargets').length, 1, 'cache verified target identity');
    assert.equal(messages.at(-1)?.params.buttons, 1);
    await assert.rejects(transport.send('t1', 'Input.insertText', { text: 'uncertain' }), /timed out/);
    await failed;
    assert.equal(failures.length, 1);
    await assert.rejects(transport.send('t1', 'Input.insertText', { text: 'no replay' }), /closed/);
    assert.equal(messages.filter(message => message.method === 'Input.insertText').length, 1);
    let finishDiscovery: (value: unknown) => void;
    const discovery = new Promise<unknown>(resolve => { finishDiscovery = resolve; });
    const stopping = new CdpBrowserInputTransport(() => discovery, () => assert.fail('owner close is not a failure'));
    const stoppedInput = stopping.send('t1', 'Input.insertText', { text: 'after stop' });
    stopping.close();
    finishDiscovery({ data: { cdpUrl: `ws://127.0.0.1:${address.port}` } });
    await assert.rejects(stoppedInput, /closed/);
    assert.equal(messages.filter(message => message.method === 'Input.insertText').length, 1, 'stop during endpoint discovery must not reconnect or send input');

  } finally {
    transport.close();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}
run().then(() => console.log('Browser input transport tests passed')).catch(error => { console.error(error); process.exitCode = 1; });
