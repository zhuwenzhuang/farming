#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = path.resolve(process.argv[2] || '');
if (!sourceRoot || !fs.existsSync(path.join(sourceRoot, '.git'))) {
  throw new Error('Usage: npm run sync:openclaw-browser-extension -- /path/to/openclaw-checkout');
}

const upstreamRoot = path.join(sourceRoot, 'extensions', 'browser', 'chrome-extension');
const destinationRoot = path.join(repoRoot, 'extensions', 'browser', 'chrome-extension');
const rootFiles = ['background.js', 'manifest.json', 'options.html', 'options.js', 'popup.html', 'popup.js'];
const moduleFiles = [
  'native-bootstrap.js',
  'popup-background.js',
  'relay-auth-v2-crypto.js',
  'relay-auth-v2.js',
  'relay-command-handler.js',
  'relay-connection.js',
  'relay-core.js',
  'relay-tab-groups.js',
  'tab-access-events.js',
  'tab-access.js',
  'tab-eligibility.js',
];

function transform(source) {
  return source
    .replaceAll('OpenClaw', 'Farming')
    .replaceAll('openclaw', 'farming')
    .replaceAll('OPENCLAW', 'FARMING');
}

function transformIntegration(relativePath, source) {
  if (relativePath !== 'modules/relay-core.js') return source;
  return source
    .replace('relay.pathname !== "/browser/extension"', '!relay.pathname.endsWith("/browser/extension")')
    .replace('gateway.pathname = "/";', 'gateway.pathname = relay.pathname.slice(0, -"/browser/extension".length) || "/";')
    .replace(
      'isAllowedWebSocketUrl(relay) &&\n      relay.pathname !== "/browser/extension" &&\n      relay.pathname.endsWith("/browser/extension")',
      'isAllowedWebSocketUrl(relay) && !relay.pathname.endsWith("/browser/extension")',
    )
    .replace('relay.pathname === "/browser/extension";', 'relay.pathname.endsWith("/browser/extension");');
}

function syncFile(source, destination, relativePath) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(
    destination,
    transformIntegration(relativePath, transform(fs.readFileSync(source, 'utf8'))),
  );
}

for (const file of rootFiles) syncFile(path.join(upstreamRoot, file), path.join(destinationRoot, file), file);
for (const file of moduleFiles) {
  const relativePath = path.join('modules', file);
  syncFile(path.join(upstreamRoot, relativePath), path.join(destinationRoot, relativePath), relativePath);
}

const manifestPath = path.join(destinationRoot, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
manifest.name = 'Farming Browser Connector';
manifest.description = 'Securely relay eligible signed-in Chrome tabs to Farming Browser.';
delete manifest.icons;
delete manifest.action?.default_icon;
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim();
const upstreamDirectory = path.join(destinationRoot, 'upstream');
fs.mkdirSync(upstreamDirectory, { recursive: true });
fs.copyFileSync(path.join(sourceRoot, 'LICENSE'), path.join(upstreamDirectory, 'LICENSE.openclaw'));
fs.writeFileSync(path.join(upstreamDirectory, 'upstream.json'), `${JSON.stringify({
  repository: 'https://github.com/openclaw/openclaw',
  commit,
  license: 'MIT',
  sourcePath: 'extensions/browser/chrome-extension',
  relaySourcePath: 'extensions/browser/src/browser/extension-relay',
  transform: 'Farming identity namespaces plus Farming base-path pairing support',
}, null, 2)}\n`);

console.log(`Synchronized Farming Browser Connector from OpenClaw ${commit}.`);
