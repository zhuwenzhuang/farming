const assert = require('assert');
const fs = require('fs');
const path = require('path');

const projectRoot = path.join(__dirname, '..', '..');
const styles = fs.readFileSync(path.join(projectRoot, 'src', 'styles', 'main.css'), 'utf8');

function ruleBody(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = styles.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`, 'm'));
  assert(match, `Missing CSS rule: ${selector}`);
  return match[1];
}

function propertyValue(rule, property) {
  const match = rule.match(new RegExp(`(?:^|\\n)\\s*${property}\\s*:\\s*([^;]+);`, 'm'));
  assert(match, `Missing CSS property: ${property}`);
  return match[1].trim();
}

const agentRowColor = propertyValue(ruleBody('.code-agent-row'), 'color');
const agentRowActionSurface = propertyValue(ruleBody('.code-agent-row'), '--code-agent-row-action-surface');
const activeAgentRowActionSurface = propertyValue(ruleBody('.code-agent-row.active'), '--code-agent-row-action-surface');
const selectedAgentRowActionSurface = propertyValue(ruleBody('.code-agent-row.search-selected'), '--code-agent-row-action-surface');
const hoveredAgentRowActionSurface = propertyValue(ruleBody('.code-agent-row:hover:not(.active):not(.search-selected)'), '--code-agent-row-action-surface');
const agentSectionBackground = propertyValue(ruleBody('.code-agents-section'), 'background');
const fileRowColor = propertyValue(ruleBody('.code-file-row'), 'color');
const agentRowFontSize = propertyValue(ruleBody('.code-agent-row'), 'font-size');
const fileRowFontSize = propertyValue(ruleBody('.code-file-row'), 'font-size');

assert.strictEqual(agentRowColor, '#585858');
assert.strictEqual(agentRowActionSurface, '#f7f7f6');
assert.strictEqual(activeAgentRowActionSurface, '#e9e9e8');
assert.strictEqual(selectedAgentRowActionSurface, '#e6e6e5');
assert.strictEqual(hoveredAgentRowActionSurface, '#e8e8e7');
assert.strictEqual(agentSectionBackground, '#f7f7f6');
assert.strictEqual(fileRowColor, '#4a5149');
assert.strictEqual(agentRowFontSize, '14px');
assert.strictEqual(fileRowFontSize, 'var(--code-file-entry-font-size)');

console.log('test-code-agent-row-color passed');
