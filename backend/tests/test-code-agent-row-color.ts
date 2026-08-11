const assert = require('assert');
const { readCodeBaseStyles, readCodeStyleSource } = require('./style-source-reader');

const styles = readCodeBaseStyles();
const gitHistoryStyles = readCodeStyleSource('src/styles/git-history.css');

function ruleBody(selector, source = styles) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = Array.from(source.matchAll(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`, 'gm')));
  assert(matches.length > 0, `Missing CSS rule: ${selector}`);
  return matches.map(match => match[1]).join('\n');
}

function propertyValue(rule, property) {
  const matches = Array.from(rule.matchAll(new RegExp(`(?:^|\\n)\\s*${property}\\s*:\\s*([^;]+);`, 'gm')));
  assert(matches.length > 0, `Missing CSS property: ${property}`);
  return matches[matches.length - 1][1].trim();
}

const agentRowColor = propertyValue(ruleBody('.code-agent-row'), 'color');
const agentRowActionSurface = propertyValue(ruleBody('.code-agent-row'), '--code-agent-row-action-surface');
const activeAgentRowActionSurface = propertyValue(ruleBody('.code-agent-row.active'), '--code-agent-row-action-surface');
const selectedAgentRowActionSurface = propertyValue(ruleBody('.code-agent-row.search-selected'), '--code-agent-row-action-surface');
const hoveredAgentRowActionSurface = propertyValue(ruleBody('.code-agent-row:hover:not(.active):not(.search-selected)'), '--code-agent-row-action-surface');
const agentSectionBackground = propertyValue(ruleBody('.code-agents-section'), 'background');
const projectRowBackground = propertyValue(ruleBody('.code-project-row'), 'background');
const projectRowActionSurface = propertyValue(ruleBody('.code-project-row'), '--code-project-row-action-surface');
const projectTitleColor = propertyValue(ruleBody('.code-project-title'), 'color');
const filesHeaderRule = ruleBody('.code-open-editors-header,\n.code-files-header');
const gitHistoryHeaderRule = ruleBody('.code-git-history-header', gitHistoryStyles);
const filesHeaderBackground = propertyValue(filesHeaderRule, 'background');
const filesHeaderColor = propertyValue(filesHeaderRule, 'color');
const gitHistoryHeaderBackground = propertyValue(gitHistoryHeaderRule, 'background');
const gitHistoryHeaderColor = propertyValue(gitHistoryHeaderRule, 'color');
const openEditorActionSurface = propertyValue(ruleBody('.code-open-editor-row'), '--code-open-editor-row-action-surface');
const activeOpenEditorActionSurface = propertyValue(ruleBody('.code-open-editor-row.active'), '--code-open-editor-row-action-surface');
const openEditorColor = propertyValue(ruleBody('.code-open-editor-main'), 'color');
const stickyStackBackground = propertyValue(ruleBody('.code-file-sticky-stack'), 'background');
const stickyRowColor = propertyValue(ruleBody('.code-file-row.code-file-sticky-row'), 'color');
const fileRowColor = propertyValue(ruleBody('.code-file-row'), 'color');
const agentRowFontSize = propertyValue(ruleBody('.code-agent-row'), 'font-size');
const fileRowFontSize = propertyValue(ruleBody('.code-file-row'), 'font-size');

assert.strictEqual(agentRowColor, '#585858');
assert.strictEqual(agentRowActionSurface, 'var(--code-bg-chrome)');
assert.strictEqual(activeAgentRowActionSurface, '#e9e9e8');
assert.strictEqual(selectedAgentRowActionSurface, '#e6e6e5');
assert.strictEqual(hoveredAgentRowActionSurface, '#e8e8e7');
assert.strictEqual(agentSectionBackground, 'var(--code-bg-chrome)');
assert.strictEqual(projectRowBackground, 'var(--code-sidebar-project-row-background)');
assert.strictEqual(projectRowActionSurface, projectRowBackground);
assert.strictEqual(projectTitleColor, '#444444');
assert.strictEqual(filesHeaderBackground, 'var(--code-bg-chrome)');
assert.strictEqual(filesHeaderColor, 'var(--code-text-muted)');
assert.strictEqual(gitHistoryHeaderBackground, filesHeaderBackground);
assert.strictEqual(gitHistoryHeaderColor, filesHeaderColor);
assert.strictEqual(openEditorActionSurface, 'var(--code-bg-inset)');
assert.strictEqual(activeOpenEditorActionSurface, 'var(--code-bg-hover)');
assert.strictEqual(openEditorColor, 'var(--code-text-muted)');
assert.strictEqual(stickyStackBackground, 'var(--code-bg-inset)');
assert.strictEqual(stickyRowColor, 'var(--code-text-muted)');
assert.strictEqual(fileRowColor, 'var(--code-text-muted)');
assert.strictEqual(agentRowFontSize, '13px');
assert.strictEqual(fileRowFontSize, 'var(--code-file-entry-font-size)');

console.log('test-code-agent-row-color passed');
