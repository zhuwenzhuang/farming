const assert = require('assert');
const { readCodeStyleSource } = require('./style-source-reader');

const styles = readCodeStyleSource('src/styles/transcript.css');
const tokens = readCodeStyleSource('src/styles/tokens.css');

function assertTokenWiring(source, selectorPrefix, tokenPrefix, toneCount) {
  for (let tone = 0; tone < toneCount; tone += 1) {
    const token = `${tokenPrefix}-${tone}-color`;
    const selector = `${selectorPrefix}.tone-${tone} svg`;
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rule = source.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`, 'm'));
    assert(rule, `Missing collaboration Agent icon rule: ${selector}`);
    assert.match(rule[1], new RegExp(`color\\s*:\\s*var\\(${token}\\);`));
  }
}

function assertPalette(source, tokenPrefix, expectedColors) {
  for (const [tone, expectedColor] of expectedColors.entries()) {
    assert(
      source.includes(`${tokenPrefix}-${tone}-color: ${expectedColor};`),
      `Missing collaboration Agent icon token: ${tokenPrefix}-${tone}-color`,
    );
  }
  assert.strictEqual(new Set(expectedColors).size, expectedColors.length);
}

assertTokenWiring(
  styles,
  '.code-agent-transcript-collaboration-agent',
  '--code-transcript-agent-transcript-collaboration-agent-tone',
  4,
);
assertPalette(
  tokens,
  '--code-transcript-agent-transcript-collaboration-agent-tone',
  ['#397f79', '#9d6a66', '#8067a5', '#918675'],
);
assertPalette(
  tokens,
  '--code-transcript-agent-transcript-collaboration-agent-tone',
  ['#69c5bd', '#c69494', '#a371f7', '#d2b47c'],
);

console.log('test-code-collaboration-icon-colors passed');
