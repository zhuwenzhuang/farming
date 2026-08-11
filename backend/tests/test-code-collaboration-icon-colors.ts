const assert = require('assert');
const { readCodeStyleSource } = require('./style-source-reader');
const appearanceThemes = require('../../shared/appearance-themes.json');

const styles = readCodeStyleSource('src/styles/transcript.css');
const tokens = readCodeStyleSource('src/styles/tokens.css');
const appearances = ['light', 'dark', 'paper'];
const collaborationToneTokens = Object.keys(appearanceThemes.light.css)
  .filter(token => token.startsWith('--code-collaboration-tone-'))
  .sort();

function assertTokenWiring(source, selectorPrefix, toneTokens) {
  for (const [tone, token] of toneTokens.entries()) {
    const selector = `${selectorPrefix}.tone-${tone} svg`;
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rule = source.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`, 'm'));
    assert(rule, `Missing collaboration Agent icon rule: ${selector}`);
    assert.match(rule[1], new RegExp(`color\\s*:\\s*var\\(${token}\\);`));
  }
}

function assertGeneratedPalette(source, appearance, toneTokens) {
  const selector = appearance === 'light'
    ? 'body.code-mode'
    : `body.code-mode[data-appearance='${appearance}']`;
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rule = source.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`, 'm'));
  assert(rule, `Missing generated ${appearance} appearance rule`);
  for (const token of toneTokens) {
    const expectedValue = appearanceThemes[appearance].css[token];
    assert(expectedValue, `${appearance} is missing collaboration token ${token}`);
    assert.match(
      rule[1],
      new RegExp(`${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:\\s*${expectedValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')};`),
      `Generated ${appearance} palette is missing ${token}`,
    );
  }
}

assert.strictEqual(collaborationToneTokens.length, 4, 'collaboration Agents should expose four distinct tone roles');
for (const appearance of appearances) {
  assert.deepStrictEqual(
    Object.keys(appearanceThemes[appearance].css)
      .filter(token => token.startsWith('--code-collaboration-tone-'))
      .sort(),
    collaborationToneTokens,
    `${appearance} must define the same collaboration tone roles as Light`,
  );
  assert.strictEqual(
    new Set(collaborationToneTokens.map(token => appearanceThemes[appearance].css[token])).size,
    collaborationToneTokens.length,
    `${appearance} collaboration tones should stay visually distinct`,
  );
  assertGeneratedPalette(tokens, appearance, collaborationToneTokens);
}
assertTokenWiring(
  styles,
  '.code-agent-transcript-collaboration-agent',
  collaborationToneTokens,
);

console.log('test-code-collaboration-icon-colors passed');
