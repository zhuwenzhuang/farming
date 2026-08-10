const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { CODE_STYLE_SOURCES } = require('../../src/styles/code-style-sources');

const projectRoot = path.join(__dirname, '..', '..');
const mainEntrySource = fs.readFileSync(path.join(projectRoot, 'src/main.tsx'), 'utf8');
const expectedSources = [
  'src/styles/tokens.css',
  'src/styles/main.css',
  'src/styles/file-editor.css',
  'src/styles/pet.css',
  'src/styles/git-history.css',
  'src/styles/composer.css',
  'src/styles/plugin.css',
  'src/styles/settings.css',
  'src/styles/share.css',
  'src/styles/sidebar-resources.css',
  'src/styles/usage.css',
  'src/styles/markdown.css',
  'src/styles/search.css',
  'src/styles/history.css',
  'src/styles/empty.css',
  'src/styles/code-dark.css',
  'src/styles/file-editor-dark.css',
  'src/styles/pet-dark.css',
  'src/styles/git-history-dark.css',
  'src/styles/composer-dark.css',
  'src/styles/plugin-dark.css',
  'src/styles/settings-dark.css',
  'src/styles/share-dark.css',
  'src/styles/usage-dark.css',
  'src/styles/markdown-dark.css',
  'src/styles/search-dark.css',
  'src/styles/history-dark.css',
  'src/styles/empty-dark.css',
];

assert.deepStrictEqual(
  CODE_STYLE_SOURCES,
  expectedSources,
  'the Code style manifest must preserve the runtime cascade order',
);
// Extracted owners stay adjacent to the monolith they came from and before the
// later feature owners. Reordering these files would create a new cross-domain
// cascade even when every individual rule is intact.
assert.strictEqual(
  CODE_STYLE_SOURCES.indexOf('src/styles/file-editor.css'),
  CODE_STYLE_SOURCES.indexOf('src/styles/main.css') + 1,
  'File Editor base styles must load immediately after main.css',
);
assert.strictEqual(
  CODE_STYLE_SOURCES.indexOf('src/styles/pet.css'),
  CODE_STYLE_SOURCES.indexOf('src/styles/file-editor.css') + 1,
  'Pet base styles must load immediately after File Editor',
);
assert.strictEqual(
  CODE_STYLE_SOURCES.indexOf('src/styles/git-history.css'),
  CODE_STYLE_SOURCES.indexOf('src/styles/pet.css') + 1,
  'Git History base styles must load immediately after Pet',
);
assert.strictEqual(
  CODE_STYLE_SOURCES.indexOf('src/styles/composer.css'),
  CODE_STYLE_SOURCES.indexOf('src/styles/git-history.css') + 1,
  'Composer base styles must load immediately after Git History',
);
assert.strictEqual(
  CODE_STYLE_SOURCES.indexOf('src/styles/file-editor-dark.css'),
  CODE_STYLE_SOURCES.indexOf('src/styles/code-dark.css') + 1,
  'File Editor dark styles must load immediately after code-dark.css',
);
assert.strictEqual(
  CODE_STYLE_SOURCES.indexOf('src/styles/pet-dark.css'),
  CODE_STYLE_SOURCES.indexOf('src/styles/file-editor-dark.css') + 1,
  'Pet dark styles must load immediately after dark File Editor',
);
assert.strictEqual(
  CODE_STYLE_SOURCES.indexOf('src/styles/git-history-dark.css'),
  CODE_STYLE_SOURCES.indexOf('src/styles/pet-dark.css') + 1,
  'Git History dark styles must load immediately after dark Pet',
);
assert.strictEqual(
  CODE_STYLE_SOURCES.indexOf('src/styles/composer-dark.css'),
  CODE_STYLE_SOURCES.indexOf('src/styles/git-history-dark.css') + 1,
  'Composer dark styles must load immediately after dark Git History',
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
