const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function run() {
  const effectPath = path.join(__dirname, '../../frontend/skins/crt/effects/crt-webgl-effects.js');
  const terminalBridgePath = path.join(__dirname, '../../frontend/terminal-bridge.js');
  const serverPath = path.join(__dirname, '../server.js');
  const source = fs.readFileSync(effectPath, 'utf8');
  const terminalBridge = fs.readFileSync(terminalBridgePath, 'utf8');
  const server = fs.readFileSync(serverPath, 'utf8');
  const context = {};
  vm.runInNewContext(source, context);

  assert(context.FarmingCrtWebglEffects, 'CRT effects should expose an isolated browser engine');
  assert.strictEqual(context.FarmingCrtWebglEffects.HISTORY_SCALE, 0.5);
  assert.strictEqual(context.FarmingCrtWebglEffects.BLOOM_SCALE, 0.5);
  assert.strictEqual(context.FarmingCrtWebglEffects.EFFECT_FRAME_INTERVAL_MS, 50);
  assert.strictEqual(context.FarmingCrtWebglEffects.PHOSPHOR_FADE_MS, 1600);
  assert.strictEqual(context.FarmingCrtWebglEffects.SEQUENTIAL_INPUT_WINDOW_MS, 320);
  assert(source.includes("getContext('webgl2'"), 'CRT effects should require WebGL2');
  assert(source.includes('terminal.onRender'), 'CRT history should update from actual terminal render events');
  assert(source.includes('terminal.onRender(() => this.markSourceDirty())'), 'CRT should capture each completed xterm paint on the next safe browser frame instead of copying the canvas re-entrantly');
  assert(source.includes('u_decay - previous.a'), 'CRT feedback decay should preserve the reference mask behavior for newly disappeared pixels');
  assert(source.includes('phosphorResponse') && source.includes('burnInStrength'), 'CRT should normalize reference burn-in intensity for xterm\'s full-color canvas');
  assert(source.includes('smoothstep(0.24, 0.92') && source.includes('mix(0.006, 0.075'), 'CRT persistence should reject dim xterm surfaces and keep its initial ghost subtle');
  assert(source.includes('observeTerminalInput') && source.includes('cursorDistance > 1'), 'CRT should bridge xterm render coalescing only for sequential printable cursor movement');
  assert(source.includes('u_cursorSweep') && source.includes('cursorPhosphor'), 'CRT should fill cursor cells skipped by a coalesced sequential input paint on the GPU');
  assert(source.includes('currentMask *= 1.0 - step(0.001, cursorTrail)'), 'synthetic cursor cells should enter burn-in history instead of being marked as current pixels');
  assert(source.includes("classList.contains('xterm-link-layer')"), 'CRT capture should ignore xterm\'s transparent link hit layer');
  assert(source.includes('texSubImage2D'), 'CRT should upload the rendered terminal directly into a reused GPU texture');
  assert(source.includes('u_historyAge'), 'CRT should decay phosphor history analytically between terminal renders');
  assert(source.includes('straightColor') && source.includes('signal / alpha'), 'CRT should encode its additive signal as straight alpha without squaring its intensity');
  assert(!source.includes('gl.enable(gl.BLEND)'), 'CRT should not pre-multiply the transparent effects layer through an extra blend pass');
  assert(source.includes('jitterPixels') && source.includes('syncGate'), 'CRT should derive subtle floating and sync drift in the shader');
  assert(source.includes('u_noise') && source.includes('createNoiseData'), 'CRT effects should share one deterministic noise texture');
  assert(!/(getImageData|toDataURL|drawImage|createImageBitmap)\s*\(/.test(source), 'CRT effects must not capture terminal pixels through CPU screenshot APIs');
  assert.strictEqual((source.match(/createElement\('canvas'\)/g) || []).length, 1, 'CRT should reuse one effects canvas per opened terminal');
  assert(terminalBridge.includes('requireWebgl') && terminalBridge.includes("kind = 'xterm-webgl'"), 'CRT terminal bridge should expose strict WebGL mode');
  assert(server.includes("@xterm', 'addon-webgl'"), 'server should expose the packaged xterm WebGL addon');

  console.log('✓ CRT WebGL effects are isolated, event-driven, and avoid CPU screenshots');
}

run();
