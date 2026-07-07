const assert = require('assert');
const {
  CONTEXT_MENU_WIDTH,
  clampContextMenuPoint,
  estimateAgentContextMenuHeight,
  estimateContextMenuHeight,
  outwardContextMenuPoint,
} = require('../../src/components/code/menu-position.ts');

function agent(overrides = {}) {
  return {
    id: 'agent-1',
    command: 'codex',
    cwd: '/repo',
    status: 'running',
    isMain: false,
    pinned: false,
    ...overrides,
  };
}

function run() {
  assert.strictEqual(CONTEXT_MENU_WIDTH, 220);
  assert.strictEqual(estimateContextMenuHeight(2), 62);
  assert.strictEqual(estimateContextMenuHeight(3, 1), 99);

  assert.deepStrictEqual(
    clampContextMenuPoint(500, 500, 100, { width: 600, height: 400 }),
    { x: 372, y: 292 }
  );
  assert.deepStrictEqual(
    clampContextMenuPoint(-100, -100, 100, { width: 600, height: 400 }),
    { x: 8, y: 8 }
  );
  assert.deepStrictEqual(
    clampContextMenuPoint(500, 500, 100, { width: 600, height: 400 }, 168),
    { x: 424, y: 292 }
  );
  assert.deepStrictEqual(
    outwardContextMenuPoint({ left: 420, right: 448, top: 80 }, 100, { width: 800, height: 400 }, 160),
    { x: 456, y: 80 }
  );
  assert.deepStrictEqual(
    outwardContextMenuPoint({ left: 720, right: 748, top: 360 }, 100, { width: 800, height: 400 }, 160),
    { x: 552, y: 292 }
  );

  assert.strictEqual(estimateAgentContextMenuHeight(undefined), estimateContextMenuHeight(0, 0));
  assert.strictEqual(estimateAgentContextMenuHeight(agent()), estimateContextMenuHeight(6, 2));
  assert.strictEqual(estimateAgentContextMenuHeight(agent({ isMain: true })), estimateContextMenuHeight(6, 2));
  assert.strictEqual(estimateAgentContextMenuHeight(agent({ canForkNewWorktree: true })), estimateContextMenuHeight(7, 2));

  console.log('test-code-menu-position passed');
}

run();
