const assert = require('assert');
const fs = require('fs');
const path = require('path');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '../..', relativePath), 'utf8');
}

function run() {
  const settings = read('src/components/code/AgentHomesSettingsPanel.tsx');
  const crt = read('frontend/skins/crt/app.js');
  const crtTheme = JSON.parse(read('frontend/themes/terminal/theme.json'));

  assert(settings.includes('data-testid="code-settings-skin-code"'));
  assert(settings.includes('data-testid="code-settings-skin-crt"'));
  assert(settings.includes('activeAgentId?: string | null'));
  assert(settings.includes("`${appPath('/crt/')}${activeAgentId ? `?agent=${encodeURIComponent(activeAgentId)}` : ''}`"));
  assert(settings.includes("farmingCrt: 'Farming CRT'"));
  assert(!settings.includes('interfaceSkinHint'));
  assert(crt.includes("RUNTIME_PATHS.path('/code/')"));
  assert(crt.includes('openCrtAgentDeeplinkIfReady();'));
  assert.strictEqual(crtTheme.displayName, 'Farming CRT');

  console.log('Code and CRT skin switching assertions passed');
}

run();
