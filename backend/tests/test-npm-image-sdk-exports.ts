const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const checker = pathToFileURL(path.resolve(__dirname, '../../scripts/check-acp-sdk-exports.mjs')).href;

function checkFixture(options: { peer?: 'present' | 'broken' | 'missing-entry'; mandatoryMissing?: boolean; optionalDeclaration?: boolean; missingExport?: boolean } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-sdk-exports-'));
  try {
    const sdk = path.join(root, 'node_modules/@agentclientprotocol/sdk');
    fs.mkdirSync(sdk, { recursive: true });
    fs.writeFileSync(path.join(sdk, 'package.json'), JSON.stringify({
      name: '@agentclientprotocol/sdk', type: 'module',
      exports: { '.': { import: './main.js' }, './experimental/mcp-server': { import: './optional.js' }, './schema': './schema.json' },
      peerDependencies: { '@modelcontextprotocol/server': '^2.4.0' },
      peerDependenciesMeta: { '@modelcontextprotocol/server': { optional: options.optionalDeclaration !== false } },
    }));
    fs.writeFileSync(path.join(sdk, 'main.js'), options.mandatoryMissing ? 'import "missing-product-dependency";' : 'export const ready = true;');
    if (!options.missingExport) fs.writeFileSync(path.join(sdk, 'optional.js'), 'import "@modelcontextprotocol/server";');
    fs.writeFileSync(path.join(sdk, 'schema.json'), '{}');
    if (options.peer) {
      const peer = path.join(root, 'node_modules/@modelcontextprotocol/server');
      fs.mkdirSync(peer, { recursive: true });
      fs.writeFileSync(path.join(peer, 'package.json'), '{"type":"module","exports":"./index.js"}');
      if (options.peer !== 'missing-entry') fs.writeFileSync(path.join(peer, 'index.js'), options.peer === 'broken' ? 'import "missing-server-transitive";' : 'export const ready = true;');
    }
    return spawnSync(process.execPath, ['--input-type=module', '--eval',
      `import { checkAcpSdkExports } from ${JSON.stringify(checker)}; console.log(JSON.stringify(await checkAcpSdkExports(process.argv[1])));`, sdk],
    { encoding: 'utf8', timeout: 10_000 });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const absent = checkFixture();
assert.equal(absent.status, 0, absent.stderr);
assert.deepEqual(JSON.parse(absent.stdout), { importedExports: ['.'], unavailableOptionalExports: ['./experimental/mcp-server'] });
const present = checkFixture({ peer: 'present' });
assert.equal(present.status, 0, present.stderr);
assert.deepEqual(JSON.parse(present.stdout), { importedExports: ['.', './experimental/mcp-server'], unavailableOptionalExports: [] });
for (const [options, diagnostic] of [
  [{ mandatoryMissing: true }, 'missing-product-dependency'],
  [{ peer: 'broken' as const }, 'missing-server-transitive'],
  [{ peer: 'missing-entry' as const }, 'ERR_MODULE_NOT_FOUND'],
  [{ optionalDeclaration: false }, 'must explicitly declare its optional peer'],
  [{ missingExport: true }, 'ENOENT'],
] as const) {
  const failed = checkFixture(options);
  assert.notEqual(failed.status, 0);
  assert(failed.stderr.includes(diagnostic), failed.stderr);
}
console.log('ACP SDK image export checks passed: 7 optional-peer and required-runtime cases.');
