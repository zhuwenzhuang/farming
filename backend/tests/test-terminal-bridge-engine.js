const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

async function run() {
  class TerminalStub {
    constructor(options) {
      this.options = options;
    }
  }
  class FitAddonStub {}

  const window = {
    Terminal: TerminalStub,
    FitAddon: { FitAddon: FitAddonStub },
    localStorage: { getItem: () => null },
  };
  const source = fs.readFileSync(path.join(__dirname, '../../frontend/terminal-bridge.js'), 'utf8');
  vm.runInNewContext(source, { window, console, setTimeout });

  const result = await window.FarmingTerminalBridge.createInstance({ fontSize: 15 });
  assert.strictEqual(result.kind, 'xterm');
  assert(result.terminal instanceof TerminalStub);
  assert(result.fitAddon instanceof FitAddonStub);
  assert.strictEqual(result.terminal.options.fontSize, 15);
  assert.strictEqual(result.terminal.options.cols, 80);
  assert.strictEqual(result.terminal.options.rows, 30);
  assert.strictEqual(result.terminal.options.convertEol, true);

  console.log('✓ CRT terminal bridge defaults to xterm');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
