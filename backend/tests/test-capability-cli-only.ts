const assert = require('assert');
const fs = require('fs');
const path = require('path');

const projectRoot = path.join(__dirname, '..', '..');
const removedSources = [
  'backend/agent-capability-mcp.cts',
  'backend/agent-capability-tokens.cts',
  'extensions/browser/backend/browser-mcp-server.cts',
  'extensions/computer/backend/computer-mcp-server.cts',
  'scripts/smoke-browser-mcp-process.ts',
  'scripts/smoke-computer-mcp-process.ts',
];
removedSources.forEach(relativePath => {
  assert.strictEqual(fs.existsSync(path.join(projectRoot, relativePath)), false, `${relativePath} must stay removed`);
});

const serverSource = fs.readFileSync(path.join(projectRoot, 'backend/server.cts'), 'utf8');
const managerSource = fs.readFileSync(path.join(projectRoot, 'backend/agent-manager.cts'), 'utf8');
const acpRuntimeSource = fs.readFileSync(path.join(projectRoot, 'backend/acp-runtime.cts'), 'utf8');
const browserCli = fs.readFileSync(path.join(projectRoot, 'extensions/browser/bin/farming-browser'), 'utf8');
const computerCli = fs.readFileSync(path.join(projectRoot, 'extensions/computer/bin/farming-computer'), 'utf8');
const launcher = fs.readFileSync(path.join(projectRoot, 'bin/farming'), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
const nativePackageScript = fs.readFileSync(path.join(projectRoot, 'scripts/package-cli-release.sh'), 'utf8');
const npmSmokeScript = fs.readFileSync(path.join(projectRoot, 'scripts/smoke-npm-package.sh'), 'utf8');
const scriptsTypecheck = fs.readFileSync(path.join(projectRoot, 'tsconfig.scripts.json'), 'utf8');

assert(!serverSource.includes('/api/agent-capabilities/'));
assert(!managerSource.includes('mergeBrowserMcpServer'));
assert(!managerSource.includes('mergeComputerMcpServer'));
assert(!acpRuntimeSource.includes('FARMING_BROWSER_SERVER_NAME'));
assert(!acpRuntimeSource.includes('farmingBrowserApproval'));
assert(!browserCli.includes("command === 'mcp'"));
assert(!computerCli.includes("command === 'mcp'"));
assert(
  launcher.indexOf("command === 'browser'") < launcher.indexOf("'backend', 'farming-app-cli.cjs'"),
  'Browser/Computer must dispatch before the full Farming App CLI is loaded',
);
assert.strictEqual(packageJson.dependencies['@modelcontextprotocol/sdk'], undefined);
assert(!packageJson.bundledDependencies.includes('@modelcontextprotocol/sdk'));
assert(nativePackageScript.includes('smoke-capability-cli-process.ts'));
assert(npmSmokeScript.includes('smoke-capability-cli-process.ts'));
assert(!nativePackageScript.includes('smoke-browser-mcp-process.ts'));
assert(!npmSmokeScript.includes('smoke-browser-mcp-process.ts'));
assert(!npmSmokeScript.includes('smoke-computer-mcp-process.ts'));
assert(scriptsTypecheck.includes('smoke-capability-cli-process.ts'));
assert(!scriptsTypecheck.includes('smoke-browser-mcp-process.ts'));
assert(!scriptsTypecheck.includes('smoke-computer-mcp-process.ts'));

console.log('Capability CLI-only process boundary tests passed');
