#!/usr/bin/env node

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const TokenAuth = require('./auth');
const {
  createFarmingNetPass,
  loadOrCreateFarmingNetSigningIdentity,
  PASS_QUERY_PARAM,
} = require('./farming-net-pass');
const { loadFarmingNetRegistry } = require('./farming-net-registry');
const storageLayout = require('./storage-layout');

const DEFAULT_PORT = 6693;
const DEFAULT_BASE_PATH = '/farming-net';

function normalizeBasePath(basePath) {
  const value = String(basePath || '').trim();
  if (!value || value === '/') return '';
  const normalized = value.startsWith('/') ? value : `/${value}`;
  return normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
}

function isTruthy(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').toLowerCase());
}

function safePort(value, fallback = DEFAULT_PORT) {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : fallback;
}

function loadPackageVersion(projectRoot) {
  try {
    return String(JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')).version || 'dev');
  } catch {
    return 'dev';
  }
}

function setSecurityHeaders(res) {
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "connect-src 'self' http: https:",
    "img-src 'self' data:",
    "style-src 'self'",
    "script-src 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join('; '));
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
}

function sendBuffer(req, res, statusCode, body, contentType, cacheControl = 'no-store') {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  res.writeHead(statusCode, {
    'Cache-Control': cacheControl,
    'Content-Length': buffer.length,
    'Content-Type': contentType,
  });
  if (req.method === 'HEAD') res.end();
  else res.end(buffer);
}

function sendJson(req, res, statusCode, payload) {
  sendBuffer(req, res, statusCode, `${JSON.stringify(payload)}\n`, 'application/json; charset=utf-8');
}

function readAsset(filePath) {
  try {
    return fs.readFileSync(filePath);
  } catch {
    return null;
  }
}

function browserRegistry(registry, basePath) {
  return {
    ...registry,
    instances: registry.instances.map(instance => ({
      ...instance,
      endpoints: instance.endpoints.map((endpoint, index) => ({
        ...endpoint,
        launchUrl: instance.federated
          ? `${basePath}/open/${encodeURIComponent(instance.id)}/${index}`
          : endpoint.url,
      })),
    })),
  };
}

function createFarmingNetServer(options = {}) {
  const env = options.env || process.env;
  const projectRoot = options.projectRoot || path.resolve(__dirname, '..');
  const basePath = normalizeBasePath(options.basePath ?? env.FARMING_NET_BASE_PATH ?? DEFAULT_BASE_PATH);
  const configDir = options.configDir
    || env.FARMING_NET_CONFIG_DIR
    || path.join(env.HOME || os.homedir(), '.farming-net');
  const assetDir = options.assetDir || path.join(projectRoot, 'frontend', 'farming-net');
  const registryFile = options.registryFile || storageLayout.farmingNetInstancesFile(configDir);
  const stateFile = options.stateFile || storageLayout.farmingNetServerStateFile(configDir);
  const packageVersion = options.packageVersion || loadPackageVersion(projectRoot);
  const iconCandidates = [
    options.iconFile,
    path.join(projectRoot, 'public', 'farming-2', 'app-icon-v2-180.png'),
    path.join(projectRoot, 'dist', 'farming-2', 'app-icon-v2-180.png'),
  ].filter(Boolean);
  const iconFile = iconCandidates.find(candidate => fs.existsSync(candidate)) || '';
  fs.mkdirSync(configDir, { recursive: true });
  loadFarmingNetRegistry(registryFile);
  const signingIdentity = options.signingIdentity || loadOrCreateFarmingNetSigningIdentity({
    privateKeyFile: storageLayout.farmingNetSigningPrivateKeyFile(configDir),
    publicKeyFile: storageLayout.farmingNetSigningPublicKeyFile(configDir),
  });

  const authEnv = {
    ...env,
    FARMING_DISABLE_AUTH: env.FARMING_NET_DISABLE_AUTH || '',
    FARMING_TOKEN: env.FARMING_NET_TOKEN || '',
  };
  const tokenAuth = options.tokenAuth || new TokenAuth({
    basePath: basePath || '/',
    cookieName: 'farming_net_token',
    cookiePath: basePath || '/',
    disabled: options.authDisabled === true || isTruthy(env.FARMING_NET_DISABLE_AUTH),
    env: authEnv,
    farmingDir: configDir,
    farmingNetPassVerifier: false,
    redirectQueryToken: true,
    token: env.FARMING_NET_TOKEN || '',
  });

  const routePath = suffix => `${basePath}${suffix}` || '/';
  const staticAssets = new Map([
    [routePath('/app.css'), { file: path.join(assetDir, 'app.css'), type: 'text/css; charset=utf-8' }],
    [routePath('/app.js'), { file: path.join(assetDir, 'app.js'), type: 'text/javascript; charset=utf-8' }],
    [routePath('/icon.png'), { file: iconFile, type: 'image/png' }],
  ]);

  const server = http.createServer((req, res) => {
    setSecurityHeaders(res);
    tokenAuth.middleware()(req, res, () => {
      try {
        const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
        const pathname = url.pathname;
        if (!['GET', 'HEAD'].includes(String(req.method || 'GET').toUpperCase())) {
          sendJson(req, res, 405, { error: 'Method not allowed' });
          return;
        }

        if (pathname === routePath('/api/auth/status')) {
          sendJson(req, res, 200, { authRequired: tokenAuth.isEnabled() });
          return;
        }
        if (pathname === routePath('/api/status')) {
          sendJson(req, res, 200, {
            name: 'Farming Net',
            version: packageVersion,
            basePath: basePath || '/',
          });
          return;
        }
        if (pathname === routePath('/api/instances')) {
          sendJson(req, res, 200, browserRegistry(loadFarmingNetRegistry(registryFile), basePath));
          return;
        }
        const openPrefix = routePath('/open/');
        if (pathname.startsWith(openPrefix)) {
          const parts = pathname.slice(openPrefix.length).split('/');
          const instanceId = parts[0] || '';
          const endpointIndex = Number(parts[1]);
          const registry = loadFarmingNetRegistry(registryFile);
          const instance = registry.instances.find(item => item.id === instanceId);
          const endpoint = Number.isInteger(endpointIndex) && endpointIndex >= 0
            ? instance && instance.endpoints[endpointIndex]
            : null;
          if (!instance || !endpoint || parts.length !== 2) {
            sendJson(req, res, 404, { error: 'Farming instance endpoint not found' });
            return;
          }
          const target = new URL(endpoint.url);
          if (instance.federated) {
            target.searchParams.set(PASS_QUERY_PARAM, createFarmingNetPass(signingIdentity, {
              audience: instance.id,
              subject: 'owner',
              ttlSeconds: env.FARMING_NET_PASS_TTL_SECONDS,
            }));
          }
          res.writeHead(302, {
            'Cache-Control': 'no-store',
            Location: target.toString(),
          });
          res.end();
          return;
        }
        if (basePath && pathname === basePath) {
          res.writeHead(302, { Location: `${basePath || ''}/` });
          res.end();
          return;
        }
        if (pathname === (basePath ? `${basePath}/` : '/')) {
          const index = readAsset(path.join(assetDir, 'index.html'));
          if (!index) {
            sendJson(req, res, 500, { error: 'Farming Net frontend assets are missing' });
            return;
          }
          sendBuffer(req, res, 200, index, 'text/html; charset=utf-8');
          return;
        }

        const asset = staticAssets.get(pathname);
        if (asset && asset.file) {
          const body = readAsset(asset.file);
          if (body) {
            sendBuffer(req, res, 200, body, asset.type, 'public, max-age=3600');
            return;
          }
        }
        sendJson(req, res, 404, { error: 'Not found' });
      } catch (error) {
        console.error('Farming Net request failed:', error);
        if (!res.headersSent) sendJson(req, res, 500, { error: 'Farming Net request failed' });
        else res.end();
      }
    });
  });

  server.on('listening', () => {
    const address = server.address();
    const listeningPort = address && typeof address === 'object' ? address.port : null;
    fs.writeFileSync(stateFile, `${JSON.stringify({
      pid: process.pid,
      port: listeningPort,
      basePath: basePath || '/',
      configDir,
      registryFile,
      signingIssuer: signingIdentity.issuer,
      updatedAt: new Date().toISOString(),
    }, null, 2)}\n`, { mode: 0o600 });
  });
  server.on('close', () => {
    try {
      const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      if (state.pid === process.pid) fs.unlinkSync(stateFile);
    } catch {
      // Ignore missing or stale state files.
    }
  });

  return {
    basePath,
    configDir,
    packageVersion,
    registryFile,
    server,
    stateFile,
    signingIdentity,
    tokenAuth,
  };
}

function startFromCommandLine() {
  const service = createFarmingNetServer();
  const port = safePort(process.env.FARMING_NET_PORT || process.env.PORT, DEFAULT_PORT);
  const host = process.env.FARMING_NET_HOST || '0.0.0.0';
  service.server.listen(port, host, () => {
    const entryPath = `${service.basePath || ''}/`;
    const token = service.tokenAuth.getToken();
    const query = token ? `?token=${encodeURIComponent(token)}` : '';
    console.log(`Farming Net ${service.packageVersion}`);
    console.log(`URL: http://127.0.0.1:${port}${entryPath}${query}`);
    console.log(`Registry: ${service.registryFile}`);
  });

  const shutdown = signal => {
    console.log(`Farming Net received ${signal}; shutting down.`);
    service.server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

if (require.main === module) startFromCommandLine();

module.exports = {
  DEFAULT_BASE_PATH,
  DEFAULT_PORT,
  createFarmingNetServer,
  normalizeBasePath,
  safePort,
};
