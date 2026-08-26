const assert = require('assert');
const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '../..');
const backendDir = path.resolve(__dirname, '..');
const browserBackendDir = path.join(projectRoot, 'extensions', 'browser', 'backend');
const computerBackendDir = path.join(projectRoot, 'extensions', 'computer', 'backend');
const languageServerBackendDir = path.join(projectRoot, 'extensions', 'language-server', 'backend');
const sharedConfigBackendDir = path.join(projectRoot, 'extensions', 'shared-config', 'backend');
const packageJson = require('../../package.json');
const sourceOnlyDirectories = new Set(['tests', 'types', 'vendor']);

function collectRuntimeSources(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return sourceOnlyDirectories.has(entry.name) ? [] : collectRuntimeSources(entryPath);
    }
    return entry.isFile() && entry.name.endsWith('.cts') ? [entryPath] : [];
  });
}

const runtimeSources = [
  ...collectRuntimeSources(backendDir),
  ...collectRuntimeSources(browserBackendDir),
  ...collectRuntimeSources(computerBackendDir),
  ...collectRuntimeSources(languageServerBackendDir),
  ...collectRuntimeSources(sharedConfigBackendDir),
].sort();
const processEntrypoints = new Set([
  'backend/command-runner-child.cts',
  'backend/server.cts',
]);

for (const sourcePath of runtimeSources) {
  const relativeSource = path.relative(projectRoot, sourcePath).split(path.sep).join('/');
  const compiledPath = sourcePath.slice(0, -'.cts'.length) + '.cjs';
  const legacyPath = sourcePath.slice(0, -'.cts'.length) + '.js';
  assert(fs.existsSync(compiledPath), `${relativeSource} compiled runtime is missing`);
  assert(!fs.existsSync(legacyPath), `${relativeSource} legacy JavaScript still exists`);
  if (!processEntrypoints.has(relativeSource)) {
    assert.doesNotThrow(() => require(compiledPath), `${relativeSource} compiled runtime must load`);
  }
}

assert(packageJson.files.includes('backend/*.cjs'), 'npm package must include compiled backend TypeScript');
assert(packageJson.files.includes('backend/acp/*.cjs'), 'npm package must include nested compiled ACP runtime');
assert(
  packageJson.files.includes('extensions/browser/backend/*.cjs'),
  'npm package must include compiled Browser runtime',
);
assert(!packageJson.files.includes('backend/acp/'), 'npm package must not include ACP TypeScript source');
assert(!packageJson.files.includes('extensions/browser/'), 'npm package must not include Browser TypeScript source');
assert(
  packageJson.files.includes('extensions/computer/backend/*.cjs'),
  'npm package must include compiled Computer runtime',
);
assert(
  packageJson.files.includes('extensions/computer/backend/*.json'),
  'npm package must include the pinned Computer tool schema',
);
assert(!packageJson.files.includes('extensions/computer/'), 'npm package must not include Computer TypeScript source');
assert(
  packageJson.files.includes('extensions/language-server/backend/*.cjs'),
  'npm package must include compiled Language Server runtime',
);
assert(
  packageJson.files.includes('extensions/shared-config/backend/*.cjs'),
  'npm package must include compiled Shared configuration runtime',
);
assert(!packageJson.files.includes('extensions/shared-config/'), 'npm package must not include Shared configuration TypeScript source');
assert(!packageJson.files.includes('backend/*.cts'), 'npm package must not execute or ship backend TypeScript source');
assert(!packageJson.files.includes('backend/*.ts'), 'npm package must not execute or ship backend TypeScript source');

console.log('backend TypeScript runtime boundary assertions passed');
