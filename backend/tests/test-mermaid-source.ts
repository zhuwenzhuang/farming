const assert = require('assert');
const { createElement } = require('react');
const { decodeMermaidCharacterReferences } = require('../../src/lib/mermaid-source.ts');
const {
  markdownTextContent,
  mermaidCodeBlockSource,
} = require('../../src/lib/react-markdown-content.ts');

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

const mermaidCode = createElement('code', { className: 'language-mermaid' }, [
  'graph ',
  createElement('strong', { key: 'direction' }, 'TD'),
  '\n',
]);
assert.strictEqual(markdownTextContent(mermaidCode), 'graph TD\n');
assert.strictEqual(mermaidCodeBlockSource(mermaidCode), 'graph TD');
assert.strictEqual(mermaidCodeBlockSource(createElement('code', { className: 'language-js' }, 'const x = 1')), null);

console.log('mermaid source tests passed');
