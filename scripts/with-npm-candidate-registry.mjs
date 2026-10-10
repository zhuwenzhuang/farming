#!/usr/bin/env node
// A bounded, read-only test registry: serve exact local candidate images and
// proxy ordinary dependencies. No candidate is uploaded to an external service.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { readCandidate, runtimeCandidates } from './npm-candidate-registry.mjs';

const [archive, command, ...args] = process.argv.slice(2);
if (!archive || !command) throw new Error('Usage: with-npm-candidate-registry.mjs <main.tgz> <command> [...args]');
const main = readCandidate(path.resolve(archive));
const packages = [main, ...runtimeCandidates(main)];
const upstream = (process.env.FARMING_NPM_SMOKE_REGISTRY || 'https://registry.npmjs.org').replace(/\/$/, '');
const server = http.createServer(async (request, response) => {
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const tarball = packages.find(item => request.url === `/farming-code/-/${item.metadata.version}.tgz`);
    if (tarball) {
      response.setHeader('content-length', fs.statSync(tarball.archive).size);
      await pipeline(fs.createReadStream(tarball.archive), response);
    } else if (request.url === '/farming-code' || request.url?.startsWith('/farming-code/')) {
      const versions = Object.fromEntries(packages.map(item => [item.metadata.version, {
        ...item.metadata, dist: { tarball: `${origin}/farming-code/-/${item.metadata.version}.tgz`, integrity: item.integrity },
      }]));
      const version = request.url.slice('/farming-code/'.length);
      const result = request.url === '/farming-code' ? { name: 'farming-code', 'dist-tags': { latest: main.metadata.version }, versions }
        : versions[version === 'latest' ? main.metadata.version : version];
      response.writeHead(result ? 200 : 404, { 'content-type': 'application/json' });
      response.end(JSON.stringify(result || { error: 'Unknown candidate' }));
    } else {
      const result = await fetch(`${upstream}${request.url}`, { headers: { accept: request.headers.accept || 'application/json' }, signal: AbortSignal.timeout(600_000) });
      response.writeHead(result.status, { 'content-type': result.headers.get('content-type') || 'application/octet-stream' });
      if (result.body) await pipeline(Readable.fromWeb(result.body), response); else response.end();
    }
  } catch (error) {
    if (!response.headersSent) response.writeHead(502);
    if (!response.destroyed) response.end(String(error));
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const child = spawn(command, args, { stdio: 'inherit', detached: true, env: { ...process.env, FARMING_NPM_SMOKE_REGISTRY: origin } });
const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
const timer = setTimeout(kill, 15 * 60_000);
process.once('SIGTERM', kill); process.once('SIGINT', kill);
try {
  process.exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code ?? 1)); });
} finally {
  clearTimeout(timer); kill();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
