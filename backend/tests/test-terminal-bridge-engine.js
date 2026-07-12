const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

async function run() {
  class TerminalStub {
    constructor(options) {
      this.options = options;
      this.addons = [];
    }
    loadAddon(addon) {
      this.addons.push(addon);
    }
  }
  class FitAddonStub {}
  class WebglAddonStub {
    constructor(preserveDrawingBuffer) {
      this.preserveDrawingBuffer = preserveDrawingBuffer;
    }
    onContextLoss(listener) {
      this.contextLossListener = listener;
    }
  }

  const window = {
    Terminal: TerminalStub,
    FitAddon: { FitAddon: FitAddonStub },
    WebglAddon: { WebglAddon: WebglAddonStub },
    document: {
      createElement: () => ({ getContext: (kind) => kind === 'webgl2' ? {} : null }),
    },
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

  const contextLoss = () => {};
  const webglResult = await window.FarmingTerminalBridge.createInstance({
    fontSize: 15,
    requireWebgl: true,
    onWebglContextLoss: contextLoss,
  });
  assert.strictEqual(webglResult.kind, 'xterm-webgl');
  assert(webglResult.webglAddon instanceof WebglAddonStub);
  assert.strictEqual(webglResult.webglAddon.preserveDrawingBuffer, undefined);
  assert.strictEqual(webglResult.webglAddon.contextLossListener, contextLoss);
  assert(webglResult.terminal.addons.includes(webglResult.webglAddon));

  console.log('✓ CRT terminal bridge defaults to xterm and supports strict WebGL mode');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
