import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { isSafeAgyConversationId } from './agy-conversation-store.cjs';

export type AgyChildActivity = 'running' | 'idle' | 'unknown';

/** Each native print process discovers its own read-only lifecycle hooks.
 * The registry proves ownership independently before activity enters ACP. */
export async function openAgyTurnHooks(rootId: string, changed: () => Promise<unknown>) {
  const states = new Map<string, AgyChildActivity>();
  const prefix = '/' + randomUUID();
  const server = http.createServer({ requestTimeout: 2000, headersTimeout: 2000 }, async (req, res) => {
    const start = req.url === prefix + '/PreInvocation';
    if (req.method !== 'POST' || (!start && req.url !== prefix + '/Stop')) {
      res.writeHead(404).end();
      return;
    }
    try {
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of req) {
        length += chunk.length;
        if (length > 1024 * 1024) { res.writeHead(413).end(); return; }
        chunks.push(chunk);
      }
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const id = payload?.conversationId;
      if (!isSafeAgyConversationId(id) || id.trim() !== id) { res.writeHead(400).end(); return; }
      if (id !== rootId && (states.has(id) || states.size < 128)) {
        const state = start ? 'running' : payload.fullyIdle === true && !payload.error ? 'idle' : 'unknown';
        if (state !== states.get(id)) {
          states.set(id, state);
          await changed();
        }
      }
      res.writeHead(204).end();
    } catch {
      res.writeHead(400).end();
    }
  });
  server.maxConnections = 32;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'farming-agy-hooks-'));
  async function close() {
    if (server.listening) {
      const closed = new Promise<void>(resolve => server.close(() => resolve()));
      server.closeAllConnections();
      await closed;
    }
    await fs.rm(directory, { recursive: true, force: true });
  }
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Failed to open Antigravity hook receiver');
    const hooks = Object.fromEntries(['PreInvocation', 'Stop'].map(event => [event, [{
      type: 'command',
      command: `curl -q --noproxy '*' -s --max-time 2 -o /dev/null --data-binary @- 'http://127.0.0.1:${address.port}${prefix}/${event}'; printf '{}'`,
    }]]));
    await fs.mkdir(path.join(directory, '.agents'));
    await fs.writeFile(path.join(directory, '.agents', 'hooks.json'), JSON.stringify({ 'farming-child-activity': hooks }));
    return { directory, states, close };
  } catch (error) {
    await close();
    throw error;
  }
}
