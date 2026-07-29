const fs = require('fs');
const http = require('http');
const https = require('https');
const storageLayout = require('../../../backend/storage-layout.cjs');

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function resolveConnection(env = process.env) {
  const configDir = storageLayout.farmingConfigDir(env);
  const state = readJson(storageLayout.serverStateFile(configDir));
  const explicit = String(env.FARMING_CONTROL_URL || env.FARMING_BROWSER_URL || '').trim();
  const basePath = String(state.basePath || '/').replace(/\/$/, '');
  const origin = explicit || `http://127.0.0.1:${Number(state.port) || 3000}${basePath}`;
  let token = String(env.FARMING_BROWSER_TOKEN || '').trim();
  if (!token && env.FARMING_DISABLE_AUTH !== '1') {
    const tokenFile = String(env.FARMING_TOKEN_FILE || storageLayout.sessionTokenFile(configDir));
    try {
      token = fs.readFileSync(tokenFile, 'utf8').trim();
    } catch {
      token = '';
    }
  }
  return { origin: origin.replace(/\/$/, ''), token };
}

function requestTimeoutMs(env = process.env) {
  const requested = Number(env.FARMING_BROWSER_REQUEST_TIMEOUT_MS);
  if (!Number.isFinite(requested)) return DEFAULT_REQUEST_TIMEOUT_MS;
  return Math.min(120_000, Math.max(1_000, Math.round(requested)));
}

function requestJson(method, pathname, body, env = process.env) {
  const connection = resolveConnection(env);
  const url = new URL(`${connection.origin}${pathname}`);
  const transport = url.protocol === 'https:' ? https : http;
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const request = transport.request(url, {
      method,
      headers: {
        Accept: 'application/json',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': String(payload.length) } : {}),
        ...(connection.token ? { Cookie: `farming_token=${encodeURIComponent(connection.token)}` } : {}),
      },
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        let value;
        try {
          value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          reject(new Error(`Farming Browser returned HTTP ${response.statusCode}`));
          return;
        }
        if ((response.statusCode || 500) >= 400) {
          reject(new Error(value.error || `Farming Browser returned HTTP ${response.statusCode}`));
          return;
        }
        resolve(value);
      });
    });
    request.setTimeout(requestTimeoutMs(env), () => {
      request.destroy(new Error(`Farming Browser request timed out after ${requestTimeoutMs(env)}ms`));
    });
    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

module.exports = {
  requestJson,
  resolveConnection,
};
