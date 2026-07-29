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
const fileRowColor = propertyValue(ruleBody('.code-file-row'), 'color');
const agentRowFontSize = propertyValue(ruleBody('.code-agent-row'), 'font-size');
const fileRowFontSize = propertyValue(ruleBody('.code-file-row'), 'font-size');

assert.strictEqual(agentRowColor, '#585e57');
assert.strictEqual(fileRowColor, '#4a5149');
assert.strictEqual(agentRowFontSize, '14px');
assert.strictEqual(fileRowFontSize, 'var(--code-file-entry-font-size)');

console.log('test-code-agent-row-color passed');
