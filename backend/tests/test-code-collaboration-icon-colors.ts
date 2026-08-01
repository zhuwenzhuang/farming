const assert = require('assert');
const fs = require('fs');
const path = require('path');

const projectRoot = path.join(__dirname, '..', '..');
const styles = fs.readFileSync(path.join(projectRoot, 'src', 'styles', 'main.css'), 'utf8');
const darkStyles = fs.readFileSync(path.join(projectRoot, 'src', 'styles', 'code-dark.css'), 'utf8');

function assertPalette(source, selectorPrefix, expectedColors) {
  for (const [tone, expectedColor] of expectedColors.entries()) {
    const selector = `${selectorPrefix}.tone-${tone} svg`;
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rule = source.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`, 'm'));
    assert(rule, `Missing collaboration Agent icon rule: ${selector}`);
    assert.match(rule[1], new RegExp(`color\\s*:\\s*${expectedColor};`));
  }
  assert.strictEqual(new Set(expectedColors).size, expectedColors.length);
}

assertPalette(
  styles,
  '.code-agent-transcript-collaboration-agent',
  ['#397f79', '#9d6a66', '#8067a5', '#918675'],
);
assertPalette(
  darkStyles,
  "body.code-mode[data-appearance='dark'] .code-agent-transcript-collaboration-agent",
  ['#69c5bd', '#c69494', '#a371f7', '#d2b47c'],
);

console.log('test-code-collaboration-icon-colors passed');
