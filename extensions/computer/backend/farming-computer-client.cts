const fs = require('fs');
const http = require('http');
const https = require('https');
const { URL } = require('url');
const { bearerAuthorizationHeader } = require('../../../backend/auth.cjs');

function connection(env: NodeJS.ProcessEnv = process.env) {
  const controlUrl = String(env.FARMING_CONTROL_URL || '').trim();
  if (!controlUrl) throw new Error('FARMING_CONTROL_URL is not available');
  let token = '';
  if (env.FARMING_TOKEN_FILE && fs.existsSync(env.FARMING_TOKEN_FILE)) {
    token = fs.readFileSync(env.FARMING_TOKEN_FILE, 'utf8').trim();
  }
  return {
    controlUrl: controlUrl.replace(/\/+$/, ''),
    token,
  };
}

function requestJson(
  method: string,
  pathname: string,
  body: unknown,
  env: NodeJS.ProcessEnv = process.env,
): Promise<unknown> {
  const target = connection(env);
  const url = new URL(`${target.controlUrl}${pathname}`);
  const client = url.protocol === 'https:' ? https : http;
  const payload = body === undefined ? '' : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = client.request(url, {
      method,
      headers: {
        Accept: 'application/json',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...(target.token ? { Authorization: bearerAuthorizationHeader(target.token) } : {}),
        ...(env.FARMING_AGENT_ID ? { 'X-Farming-Agent-Id': env.FARMING_AGENT_ID } : {}),
      },
    }, (response: any) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let value: unknown = {};
        try {
          value = text ? JSON.parse(text) : {};
        } catch {
          value = { error: text || `HTTP ${response.statusCode}` };
        }
        if (Number(response.statusCode) < 200 || Number(response.statusCode) >= 300) {
          const record = value && typeof value === 'object' ? value as Record<string, unknown> : {};
          reject(Object.assign(new Error(String(record.error || `HTTP ${response.statusCode}`)), {
            status: response.statusCode,
            code: record.code,
            uncertain: record.uncertain === true,
          }));
          return;
        }
        resolve(value);
      });
    });
    request.setTimeout(60_000, () => request.destroy(new Error('Computer request timed out')));
    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

export {
  requestJson,
};
