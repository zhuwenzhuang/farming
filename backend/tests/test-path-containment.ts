const assert = require('assert');
const path = require('path');

const { isSameOrDescendantPath } = require('../path-containment.cjs') as typeof import('../path-containment.cjs');

function run(): void {
  const root = path.resolve(path.parse(process.cwd()).root, 'workspace-root');
  assert.strictEqual(isSameOrDescendantPath(root, root), true);
  assert.strictEqual(isSameOrDescendantPath(root, path.join(root, 'src', 'index.ts')), true);
  assert.strictEqual(isSameOrDescendantPath(root, path.join(root, '..foo', 'index.ts')), true, 'dot-dot-prefixed names are ordinary descendants');
  assert.strictEqual(isSameOrDescendantPath(root, path.resolve(root, '..')), false);
  assert.strictEqual(isSameOrDescendantPath(root, path.resolve(root, '..', 'workspace-root-old')), false);
  assert.strictEqual(isSameOrDescendantPath(root, path.resolve(root, '..', '..foo')), false, 'a sibling named ..foo is still outside');
  console.log('shared path containment passed');
}

run();
