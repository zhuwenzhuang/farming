const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const postcss = require('postcss');

const projectRoot = path.join(__dirname, '..', '..');

const OWNER_PREFIXES = [
  'code-file-editor',
  'code-file-monaco',
  'code-file-preview-panel',
  'code-file-diff',
  'code-file-html-preview',
  'code-file-image-preview',
  'code-file-pdf-preview',
  'code-file-metadata-preview-icon',
];

const EXCLUDED_PREFIXES = [
  'code-language-server',
  'code-markdown',
  'code-agent-transcript',
  'code-acp-progress-update',
  'code-file-type-icon',
  'code-open-editor',
];

const EXPECTED = {
  baseOwner: {
    count: 128,
    digest: '250f512ff82a98cde3233c848b6af2c580223c0984d0fdf7e8ce01367637b21b',
  },
  darkOwner: {
    count: 34,
    digest: '75816a29765d71cc7a9b332576ce899872c4d20345adf6305b04af69803c7b2b',
  },
};

// Owner-side halves of the mixed comma groups that were split during the File
// Editor extraction. The foreign halves stay in the monoliths only until their
// own domains are extracted, so this contract intentionally asserts nothing
// about them: freezing foreign monolith content taxes every later domain
// extraction and every feature style change.
const EXPECTED_DARK_MIXED_SPLITS = [
  {
    owner: [
      "body.code-mode[data-appearance='dark'] .code-file-editor-action",
      "body.code-mode[data-appearance='dark'] .code-file-editor-breadcrumb",
    ],
  },
  {
    owner: [
      "body.code-mode[data-appearance='dark'] .code-file-editor-action:hover:not(:disabled)",
      "body.code-mode[data-appearance='dark'] .code-file-editor-action.active",
      "body.code-mode[data-appearance='dark'] .code-file-editor-breadcrumb:hover",
      "body.code-mode[data-appearance='dark'] .code-file-editor-breadcrumb:focus-visible",
    ],
  },
  {
    owner: ["body.code-mode[data-appearance='dark'] .code-file-editor-tabs::-webkit-scrollbar-thumb"],
  },
  {
    owner: ["body.code-mode[data-appearance='dark'] .code-file-editor-tabs::-webkit-scrollbar-track"],
  },
  {
    owner: ["body.code-mode[data-appearance='dark'] .code-file-editor-close"],
  },
  {
    owner: ["body.code-mode[data-appearance='dark'] .code-file-editor-close:hover"],
  },
  {
    owner: ["body.code-mode[data-appearance='dark'].code-compact-layout .code-file-editor.markdown-reading .code-file-editor-action.source-preview"],
  },
];

function hasPrefix(selector, prefixes) {
  return prefixes.some(prefix => new RegExp(`\\.${prefix}[A-Za-z0-9_-]*(?=[\\s.#:[>+~),]|$)`).test(selector));
}

function isOwnedSelector(selector) {
  return hasPrefix(selector, OWNER_PREFIXES) && !hasPrefix(selector, EXCLUDED_PREFIXES);
}

const cssCache = new Map();
const rootCache = new Map();

function readCss(relativePath) {
  if (!cssCache.has(relativePath)) cssCache.set(relativePath, fs.readFileSync(path.join(projectRoot, relativePath), 'utf8'));
  return cssCache.get(relativePath);
}

function parseCss(relativePath) {
  if (!rootCache.has(relativePath)) rootCache.set(relativePath, postcss.parse(readCss(relativePath), { from: relativePath }));
  return rootCache.get(relativePath);
}

function selectorRecords(relativePath, kind) {
  const records = [];
  parseCss(relativePath).walkRules(rule => {
    const selectors = postcss.list.comma(rule.selector);
    const selected = kind === 'owner'
      ? selectors.filter(isOwnedSelector)
      : kind === 'excluded'
        ? selectors.filter(selector => hasPrefix(selector, EXCLUDED_PREFIXES))
        : selectors.filter(selector => !isOwnedSelector(selector));
    if (selected.length === 0) return;
    records.push(rule.clone({ selector: selected.join(',\n') }).toString());
  });
  return records;
}

function digest(records) {
  return crypto.createHash('sha256').update(JSON.stringify(records)).digest('hex');
}

function assertRecords(relativePath, kind, expected) {
  const records = selectorRecords(relativePath, kind);
  assert.strictEqual(records.length, expected.count, `${relativePath} ${kind} record count changed`);
  assert.strictEqual(digest(records), expected.digest, `${relativePath} ${kind} ordered digest changed`);
}

function ruleSelectorSets(relativePath) {
  const sets = [];
  parseCss(relativePath).walkRules(rule => {
    sets.push(postcss.list.comma(rule.selector));
  });
  return sets;
}

function assertContainsSelectorSet(relativePath, expectedSelectors) {
  assert(
    ruleSelectorSets(relativePath).some(selectors => JSON.stringify(selectors) === JSON.stringify(expectedSelectors)),
    `${relativePath} is missing split selector set ${JSON.stringify(expectedSelectors)}`,
  );
}

assertRecords('src/styles/file-editor.css', 'owner', EXPECTED.baseOwner);
assertRecords('src/styles/file-editor-dark.css', 'owner', EXPECTED.darkOwner);

assert.strictEqual(selectorRecords('src/styles/main.css', 'owner').length, 0, 'main.css must not retain File Editor-owned selector records');
assert.strictEqual(selectorRecords('src/styles/code-dark.css', 'owner').length, 0, 'code-dark.css must not retain File Editor-owned selector records');
assert.strictEqual(selectorRecords('src/styles/file-editor.css', 'foreign').length, 0, 'file-editor.css must contain only File Editor-owned selectors');
assert.strictEqual(selectorRecords('src/styles/file-editor-dark.css', 'foreign').length, 0, 'file-editor-dark.css must contain only File Editor-owned selectors');
assert.strictEqual(selectorRecords('src/styles/file-editor.css', 'excluded').length, 0, 'file-editor.css must not contain excluded selector namespaces');
assert.strictEqual(selectorRecords('src/styles/file-editor-dark.css', 'excluded').length, 0, 'file-editor-dark.css must not contain excluded selector namespaces');

assert.strictEqual(EXPECTED_DARK_MIXED_SPLITS.length, 7, 'dark mixed split count must stay documented');
for (const split of EXPECTED_DARK_MIXED_SPLITS) {
  assertContainsSelectorSet('src/styles/file-editor-dark.css', split.owner);
}

console.log('test-file-editor-style-ownership passed');
