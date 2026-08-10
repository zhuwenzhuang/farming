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
  mainForeign: {
    count: 1683,
    digest: '2d8e2405230fe49bb3bc65114fd90b33333c7e0e5a3879f59c3dd51da7d990c2',
  },
  darkForeign: {
    count: 453,
    digest: '824de6062b757a5a00ea3934792917ac67a483bee019df454a356597a128769e',
  },
};

const EXPECTED_DARK_MIXED_SPLITS = [
  {
    owner: [
      "body.code-mode[data-appearance='dark'] .code-file-editor-action",
      "body.code-mode[data-appearance='dark'] .code-file-editor-breadcrumb",
    ],
    foreign: [
      "body.code-mode[data-appearance='dark'] .code-sidebar-toggle",
      "body.code-mode[data-appearance='dark'] .code-sidebar-focus-toggle",
      "body.code-mode[data-appearance='dark'] .code-sidebar-search-toggle",
      "body.code-mode[data-appearance='dark'] .code-sidebar-plugins-toggle",
      "body.code-mode[data-appearance='dark'] .code-sidebar-options",
      "body.code-mode[data-appearance='dark'] .code-nav-item",
      "body.code-mode[data-appearance='dark'] .code-agent-rail-button",
      "body.code-mode[data-appearance='dark'] .code-project-agent-compact",
      "body.code-mode[data-appearance='dark'] .code-project-title",
      "body.code-mode[data-appearance='dark'] .code-project-title-action",
      "body.code-mode[data-appearance='dark'] .code-agent-row",
      "body.code-mode[data-appearance='dark'] .code-session-show-more",
      "body.code-mode[data-appearance='dark'] .code-open-editor-main",
      "body.code-mode[data-appearance='dark'] .code-file-row",
    ],
  },
  {
    owner: [
      "body.code-mode[data-appearance='dark'] .code-file-editor-action:hover:not(:disabled)",
      "body.code-mode[data-appearance='dark'] .code-file-editor-action.active",
      "body.code-mode[data-appearance='dark'] .code-file-editor-breadcrumb:hover",
      "body.code-mode[data-appearance='dark'] .code-file-editor-breadcrumb:focus-visible",
    ],
    foreign: [
      "body.code-mode[data-appearance='dark'] .code-nav-item:hover",
      "body.code-mode[data-appearance='dark'] .code-nav-item.active",
      "body.code-mode[data-appearance='dark'] .code-agent-rail-button:hover",
      "body.code-mode[data-appearance='dark'] .code-agent-rail-button:focus-visible",
      "body.code-mode[data-appearance='dark'] .code-agent-rail-button.active",
      "body.code-mode[data-appearance='dark'] .code-project-agent-compact:hover",
      "body.code-mode[data-appearance='dark'] .code-project-agent-compact:focus-visible",
      "body.code-mode[data-appearance='dark'] .code-project-agent-compact.active",
      "body.code-mode[data-appearance='dark'] .code-agent-row:hover",
      "body.code-mode[data-appearance='dark'] .code-agent-row.active",
      "body.code-mode[data-appearance='dark'] .code-agent-row.search-selected",
      "body.code-mode[data-appearance='dark'] .code-project-row:hover:not(:has(.code-project-worktree:hover)) .code-project-title",
      "body.code-mode[data-appearance='dark'] .code-project-title:hover",
      "body.code-mode[data-appearance='dark'] .code-pinned-title:hover",
      "body.code-mode[data-appearance='dark'] .code-pinned-title:focus-visible",
      "body.code-mode[data-appearance='dark'] .code-open-editor-main:hover",
      "body.code-mode[data-appearance='dark'] .code-open-editor-main:focus-visible",
      "body.code-mode[data-appearance='dark'] .code-file-row:hover",
      "body.code-mode[data-appearance='dark'] .code-file-row.focused",
      "body.code-mode[data-appearance='dark'] .code-file-row.selected",
      "body.code-mode[data-appearance='dark'] .code-file-row.active",
      "body.code-mode[data-appearance='dark'] .code-sidebar-toggle:hover",
      "body.code-mode[data-appearance='dark'] .code-sidebar-toggle:focus-visible",
      "body.code-mode[data-appearance='dark'] .code-sidebar-focus-toggle:hover",
      "body.code-mode[data-appearance='dark'] .code-sidebar-focus-toggle:focus-visible",
      "body.code-mode[data-appearance='dark'] .code-sidebar-focus-toggle.active",
      "body.code-mode[data-appearance='dark'] .code-sidebar-search-toggle:hover",
      "body.code-mode[data-appearance='dark'] .code-sidebar-search-toggle:focus-visible",
      "body.code-mode[data-appearance='dark'] .code-sidebar-search-toggle.active",
      "body.code-mode[data-appearance='dark'] .code-sidebar-history-toggle:hover",
      "body.code-mode[data-appearance='dark'] .code-sidebar-history-toggle:focus-visible",
      "body.code-mode[data-appearance='dark'] .code-sidebar-history-toggle.active",
      "body.code-mode[data-appearance='dark'] .code-sidebar-plugins-toggle:hover",
      "body.code-mode[data-appearance='dark'] .code-sidebar-plugins-toggle:focus-visible",
      "body.code-mode[data-appearance='dark'] .code-sidebar-plugins-toggle.active",
      "body.code-mode[data-appearance='dark'] .code-sidebar-options:hover",
      "body.code-mode[data-appearance='dark'] .code-sidebar-options:focus-visible",
    ],
  },
  {
    owner: ["body.code-mode[data-appearance='dark'] .code-file-editor-tabs::-webkit-scrollbar-thumb"],
    foreign: [
      "body.code-mode[data-appearance='dark'] .code-file-tree::-webkit-scrollbar-thumb",
      "body.code-mode[data-appearance='dark'] .code-terminal-grid::-webkit-scrollbar-thumb",
      "body.code-mode[data-appearance='dark'] .code-file-search-results::-webkit-scrollbar-thumb",
    ],
  },
  {
    owner: ["body.code-mode[data-appearance='dark'] .code-file-editor-tabs::-webkit-scrollbar-track"],
    foreign: [
      "body.code-mode[data-appearance='dark'] .code-file-tree::-webkit-scrollbar-track",
      "body.code-mode[data-appearance='dark'] .code-terminal-grid::-webkit-scrollbar-track",
      "body.code-mode[data-appearance='dark'] .code-file-search-results::-webkit-scrollbar-track",
    ],
  },
  {
    owner: ["body.code-mode[data-appearance='dark'] .code-file-editor-close"],
    foreign: ["body.code-mode[data-appearance='dark'] .code-open-editor-close"],
  },
  {
    owner: ["body.code-mode[data-appearance='dark'] .code-file-editor-close:hover"],
    foreign: ["body.code-mode[data-appearance='dark'] .code-open-editor-close:hover"],
  },
  {
    owner: ["body.code-mode[data-appearance='dark'].code-compact-layout .code-file-editor.markdown-reading .code-file-editor-action.source-preview"],
    foreign: [
      "body.code-mode[data-appearance='dark'].code-mobile-markdown-reading .code-mobile-topbar-button",
      "body.code-mode[data-appearance='dark'].code-compact-layout .code-mobile-topbar-button",
    ],
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
assertRecords('src/styles/main.css', 'foreign', EXPECTED.mainForeign);
assertRecords('src/styles/code-dark.css', 'foreign', EXPECTED.darkForeign);

assert.strictEqual(selectorRecords('src/styles/main.css', 'owner').length, 0, 'main.css must not retain File Editor-owned selector records');
assert.strictEqual(selectorRecords('src/styles/code-dark.css', 'owner').length, 0, 'code-dark.css must not retain File Editor-owned selector records');
assert.strictEqual(selectorRecords('src/styles/file-editor.css', 'foreign').length, 0, 'file-editor.css must contain only File Editor-owned selectors');
assert.strictEqual(selectorRecords('src/styles/file-editor-dark.css', 'foreign').length, 0, 'file-editor-dark.css must contain only File Editor-owned selectors');
assert.strictEqual(selectorRecords('src/styles/file-editor.css', 'excluded').length, 0, 'file-editor.css must not contain excluded selector namespaces');
assert.strictEqual(selectorRecords('src/styles/file-editor-dark.css', 'excluded').length, 0, 'file-editor-dark.css must not contain excluded selector namespaces');

assert.strictEqual(EXPECTED_DARK_MIXED_SPLITS.length, 7, 'dark mixed split count must stay documented');
for (const split of EXPECTED_DARK_MIXED_SPLITS) {
  assertContainsSelectorSet('src/styles/file-editor-dark.css', split.owner);
  assertContainsSelectorSet('src/styles/code-dark.css', split.foreign);
}

console.log('test-file-editor-style-ownership passed');
