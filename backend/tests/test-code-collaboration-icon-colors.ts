const assert = require('assert');
const { readCodeStyleSource } = require('./style-source-reader');
const appearanceThemes = require('../../shared/appearance-themes.json');

const { CollaborationAgentIcon } = require('../../src/components/code/CollaborationAgentIcon');
const tokens = readCodeStyleSource('src/styles/tokens.css');
const appearances = ['light', 'dark', 'paper'];
const collaborationToneTokens = Object.keys(appearanceThemes.light.css)
  .filter(token => token.startsWith('--code-collaboration-tone-'))
  .sort();

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
// Both navigation and transcript use this shared rendered icon. Its identity
// must keep a stable, palette-backed tone across changing list positions.
const renderedTones = new Set();
for (let index = 0; index < 128; index++) {
  const props = CollaborationAgentIcon({ sessionId: `child-${index}` }).props;
  const repeated = CollaborationAgentIcon({ sessionId: `child-${index}` }).props;
  assert.strictEqual(props.style.color, repeated.style.color);
  assert(collaborationToneTokens.some(token => props.style.color === `var(${token})`));
  renderedTones.add(props.style.color);
}
assert.strictEqual(renderedTones.size, collaborationToneTokens.length);

console.log('test-code-collaboration-icon-colors passed');
