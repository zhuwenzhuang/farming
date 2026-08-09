const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { CODE_STYLE_SOURCES } = require('../../src/styles/code-style-sources');

const projectRoot = path.join(__dirname, '..', '..');
const mainEntrySource = fs.readFileSync(path.join(projectRoot, 'src/main.tsx'), 'utf8');
const expectedSources = [
  'src/styles/tokens.css',
  'src/styles/main.css',
  'src/styles/composer.css',
  'src/styles/plugin.css',
  'src/styles/settings.css',
  'src/styles/share.css',
  'src/styles/sidebar-resources.css',
  'src/styles/code-dark.css',
  'src/styles/composer-dark.css',
  'src/styles/plugin-dark.css',
  'src/styles/settings-dark.css',
  'src/styles/share-dark.css',
];

assert.deepStrictEqual(
  CODE_STYLE_SOURCES,
  expectedSources,
  'the Code style manifest must preserve the runtime cascade order',
);
// Extracted owners stay adjacent to the monolith they came from and before the
// later feature owners. Moving either Composer file behind those owners would
// create a new cross-domain cascade even when every individual rule is intact.
assert.strictEqual(
  CODE_STYLE_SOURCES.indexOf('src/styles/composer.css'),
  CODE_STYLE_SOURCES.indexOf('src/styles/main.css') + 1,
  'Composer base styles must load immediately after main.css',
);
assert.strictEqual(
  CODE_STYLE_SOURCES.indexOf('src/styles/composer-dark.css'),
  CODE_STYLE_SOURCES.indexOf('src/styles/code-dark.css') + 1,
  'Composer dark styles must load immediately after code-dark.css',
);
assert.strictEqual(new Set(CODE_STYLE_SOURCES).size, CODE_STYLE_SOURCES.length, 'Code style sources must be unique');

let previousImport = -1;
for (const sourcePath of CODE_STYLE_SOURCES) {
  assert(fs.existsSync(path.join(projectRoot, sourcePath)), `Missing Code style source: ${sourcePath}`);
  const importPath = `./styles/${path.basename(sourcePath)}`;
  const importNeedle = `await import('${importPath}')`;
  const importIndex = mainEntrySource.indexOf(importNeedle);
  assert(importIndex > previousImport, `Missing or out-of-order Code style import: ${importPath}`);
  assert.strictEqual(mainEntrySource.indexOf(importNeedle, importIndex + 1), -1, `Duplicate Code style import: ${importPath}`);
  previousImport = importIndex;
}

const runtimeStyleImports = [...mainEntrySource.matchAll(/await import\('\.\/styles\/([^']+\.css)'\)/g)]
  .map(match => `src/styles/${match[1]}`);
assert.deepStrictEqual(runtimeStyleImports, CODE_STYLE_SOURCES, 'runtime Code style imports must exactly match the manifest');

console.log('test-code-style-sources passed');
