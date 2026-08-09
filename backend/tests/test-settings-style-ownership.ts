const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { readCodeStyleSource } = require('./style-source-reader');

const projectRoot = path.join(__dirname, '..', '..');
const read = (relativePath: string) => fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');

const settingsPanelSource = read('src/components/code/AgentHomesSettingsPanel.tsx');
const mainStyles = readCodeStyleSource('src/styles/main.css');
const darkStyles = readCodeStyleSource('src/styles/code-dark.css');
const settingsStyles = readCodeStyleSource('src/styles/settings.css');
const settingsDarkStyles = readCodeStyleSource('src/styles/settings-dark.css');
const petDarkStyles = readCodeStyleSource('src/styles/pet-dark.css');

const settingsClassNames = new Set<string>();
for (const match of settingsPanelSource.matchAll(/className=(?:"([^"]+)"|\{`([^`]+)`\})/g)) {
  for (const className of (match[1] || match[2] || '').match(/code-(?:settings|agent-home)[a-z0-9-]*/g) || []) {
    settingsClassNames.add(className);
  }
}
for (const className of settingsClassNames) {
  assert(
    settingsStyles.includes(`.${className}`) || settingsDarkStyles.includes(`.${className}`),
    `Settings style owner is missing component class: ${className}`,
  );
}

for (const selector of [
  '.code-settings-panel-overlay',
  '.code-settings-panel',
  '.code-settings-update-card',
  '.code-settings-pet-appearance-row',
  '.code-agent-home-provider',
  '.code-agent-home-form',
]) {
  assert(settingsStyles.includes(selector), `Missing Settings base rule: ${selector}`);
}
for (const selector of [
  '.code-settings-panel-overlay',
  '.code-settings-panel',
  '.code-settings-update-card',
  '.code-settings-pet-appearance-select',
  '.code-agent-home-provider',
  '.code-agent-home-form',
]) {
  assert(settingsDarkStyles.includes(selector), `Missing Settings dark rule: ${selector}`);
}

assert(settingsStyles.includes('@keyframes code-settings-mobile-enter'));
assert(settingsStyles.includes('@media (max-width: 720px)'));
assert(settingsStyles.includes('@media (max-width: 520px)'));
assert(settingsStyles.includes('@media (max-width: 980px)'));
assert(settingsDarkStyles.includes("body.code-mode[data-appearance='dark'].code-compact-layout .code-settings-panel"));
assert(!mainStyles.includes('.code-settings'));
assert(!mainStyles.includes('.code-agent-home'));
assert(!darkStyles.includes('.code-settings'));
assert(!darkStyles.includes('.code-agent-home'));

assert(petDarkStyles.includes("body.code-mode[data-appearance='dark'] .code-pet-bubble"));
assert(petDarkStyles.includes("body.code-mode[data-appearance='dark'] .code-pet-appearance-select"));
assert(!mainStyles.includes('.code-pet-bubble'));
assert(!mainStyles.includes('.code-pet-appearance-select'));
assert(!settingsStyles.includes('.code-pet-bubble'));
assert(!settingsDarkStyles.includes('.code-pet-bubble'));

console.log('test-settings-style-ownership passed');
