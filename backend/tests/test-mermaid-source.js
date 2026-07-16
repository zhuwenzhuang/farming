const assert = require('assert');
const { decodeMermaidCharacterReferences } = require('../../src/lib/mermaid-source.ts');

assert.strictEqual(
  decodeMermaidCharacterReferences('G->>R: .git/worktrees/&lt;id&gt;'),
  'G->>R: .git/worktrees/<id>',
);
assert.strictEqual(
  decodeMermaidCharacterReferences('A[&quot;one &amp; two&#33;&quot;]'),
  'A["one & two!"]',
);
assert.strictEqual(
  decodeMermaidCharacterReferences('A[&unknown; &amp;lt;]'),
  'A[&unknown; &lt;]',
  'character references should be decoded exactly once',
);

console.log('mermaid source tests passed');
