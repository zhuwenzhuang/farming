const assert = require('assert');
const fs = require('fs');
const path = require('path');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '../..', relativePath), 'utf8');
}

function run() {
  const terminalEngineSource = read('src/lib/terminal-engine.ts');
  const xtermSource = read('src/lib/xterm.ts');
  const readmeSource = read('README.md');
  const agentsSource = read('AGENTS.md');
  const packageJson = JSON.parse(read('package.json'));

  assert(
    terminalEngineSource.includes("import { createXtermTerminalInstance } from '@/lib/xterm'") &&
      terminalEngineSource.includes("createTerminalInstance as createGhosttyTerminalInstance") &&
      terminalEngineSource.includes("if (typeof window === 'undefined') return 'xterm'") &&
      terminalEngineSource.includes("window.localStorage.getItem('farmingTerminalEngine') === 'ghostty'") &&
      terminalEngineSource.includes("    ? 'ghostty'\n    : 'xterm'") &&
      terminalEngineSource.includes('return await createXtermTerminalInstance(options)') &&
      !terminalEngineSource.includes('falling back to Ghostty'),
    'browser terminal engine should default to xterm.js and use Ghostty only as an explicit debug renderer'
  );

  assert(
    xtermSource.includes("adapted.__farmingTerminalEngine = 'xterm'") &&
      xtermSource.includes('new Terminal({') &&
      xtermSource.includes("import { ClipboardAddon } from '@xterm/addon-clipboard'") &&
      xtermSource.includes('new ClipboardAddon(undefined, createTerminalClipboardProvider())') &&
      xtermSource.includes('adapted.reattach = () =>') &&
      xtermSource.includes('terminal: decorateXtermTerminal(terminal, searchAddon)') &&
      xtermSource.includes('adapted.forceRedraw = () =>') &&
      xtermSource.includes('terminal.clearTextureAtlas()') &&
      xtermSource.includes('adapted.clearTerminalSelection = () => terminal.clearSelection()') &&
      xtermSource.includes("terminal.write('\\x1b[2J\\x1b[3J\\x1b[H')") &&
      xtermSource.includes('adapted.selectAll = () => terminal.selectAll()') &&
      xtermSource.includes('ignoreBracketedPasteMode: true') &&
      xtermSource.includes('linkHandler:') &&
      xtermSource.includes('allowNonHttpProtocols: false') &&
      xtermSource.includes('minimumContrastRatio: 4.5') &&
      xtermSource.includes("cursorStyle: 'block'") &&
      xtermSource.includes('scrollback: 5000') &&
      xtermSource.includes('new FitAddon()'),
    'xterm adapter should expose the Farming terminal compatibility surface and bypass the default xterm link confirmation'
  );

  assert(
    xtermSource.includes('function applyXtermElementAppearance') &&
      xtermSource.includes("'.xterm-screen, .xterm-viewport, .xterm-rows, .xterm-helper-textarea'") &&
      xtermSource.includes('function scheduleXtermAppearanceRefresh') &&
      xtermSource.includes("attributeFilter: ['data-appearance']") &&
      xtermSource.includes('cancelScheduledRefreshes.forEach(cancel => cancel())'),
    'xterm adapter should repaint terminal DOM backgrounds when the Farming appearance changes'
  );

  assert(
    packageJson.dependencies['@xterm/xterm'] &&
      packageJson.dependencies['@xterm/addon-fit'] &&
      packageJson.dependencies['@xterm/addon-clipboard'],
    'runtime dependencies should include xterm.js, the fit addon, and the standard xterm clipboard addon'
  );

  assert(
    readmeSource.includes('The browser terminal renderer defaults to xterm.js') &&
      agentsSource.includes('Both browser skins default to xterm.js'),
    'public docs should describe xterm.js as the default terminal renderer'
  );

  console.log('✓ Terminal renderer defaults to xterm.js');
}

run();
