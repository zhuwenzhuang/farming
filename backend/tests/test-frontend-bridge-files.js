const assert = require('assert');
const fs = require('fs');
const path = require('path');

function run() {
  const terminalBridgePath = path.join(__dirname, '../../frontend/terminal-bridge.js');
  const skinBridgePath = path.join(__dirname, '../../frontend/skin-bridge.js');
  const indexHtmlPath = path.join(__dirname, '../../frontend/index.html');

  const terminalBridge = fs.readFileSync(terminalBridgePath, 'utf8');
  const skinBridge = fs.readFileSync(skinBridgePath, 'utf8');
  const indexHtml = fs.readFileSync(indexHtmlPath, 'utf8');

  assert(
    terminalBridge.includes('FarmingTerminalBridge'),
    'terminal bridge should attach a global bridge object'
  );
  assert(terminalBridge.includes('createInstance'), 'terminal bridge should expose terminal creation');
  assert(!terminalBridge.includes("kind: 'xterm'"), 'terminal bridge should not expose xterm fallback');
  assert(
    terminalBridge.includes('Ghostty terminal is unavailable'),
    'terminal bridge should fail explicitly when ghostty is unavailable'
  );
  assert(
    skinBridge.includes('FarmingSkinBridge'),
    'skin bridge should attach a global bridge object'
  );
  assert(skinBridge.includes('getSessionSkin'), 'skin bridge should expose session skin resolution');
  assert(!indexHtml.includes('xterm.min.js'), 'index.html should not load xterm script');
  assert(!indexHtml.includes('xterm.css'), 'index.html should not load xterm stylesheet');

  console.log('✓ Frontend bridge files are present');
}

run();
