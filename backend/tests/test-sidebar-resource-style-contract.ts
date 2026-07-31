const assert = require('assert');
const fs = require('fs');
const path = require('path');

const projectRoot = path.join(__dirname, '..', '..');
const read = (relativePath: string) => fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');

const mainSource = read('src/main.tsx');
const sharedStyles = read('src/styles/sidebar-resources.css');
const browserSource = read('extensions/browser/frontend/BrowserSidebarPortals.tsx');
const browserStyles = read('extensions/browser/frontend/browser.css');
const computerSource = read('extensions/computer/frontend/ComputerSection.tsx');
const computerStyles = read('extensions/computer/frontend/computer.css');

assert(
  mainSource.includes("await import('./styles/sidebar-resources.css')"),
  'The Code application must load the shared sidebar Resource style contract',
);

for (const className of [
  'code-sidebar-resource-section',
  'code-sidebar-resource-header',
  'code-sidebar-resource-section-toggle',
  'code-sidebar-resource-row',
  'code-sidebar-resource-icon',
  'code-sidebar-resource-copy',
  'code-sidebar-resource-name',
  'code-sidebar-resource-detail',
  'code-sidebar-resource-actions',
  'code-sidebar-resource-empty',
]) {
  assert(sharedStyles.includes(`.${className}`), `Missing shared sidebar Resource rule: ${className}`);
  assert(browserSource.includes(className), `Browser Resource UI must compose ${className}`);
  assert(computerSource.includes(className), `Computer Resource UI must compose ${className}`);
}

for (const selector of [
  '.farming-browser-section {',
  '.farming-browser-section > header {',
  '.farming-browser-row {',
  '.farming-browser-row-actions {',
  '.farming-browser-empty {',
]) {
  assert(!browserStyles.includes(selector), `Browser CSS must not fork shared sidebar geometry: ${selector}`);
}

for (const selector of [
  '.farming-computer-section {',
  '.farming-computer-section > header {',
  '.farming-computer-row {',
  '.farming-computer-actions {',
  '.farming-computer-empty {',
]) {
  assert(!computerStyles.includes(selector), `Computer CSS must not fork shared sidebar geometry: ${selector}`);
}

assert(sharedStyles.includes('border-radius: 8px;'), 'Shared Resource rows must own their edge radius');
assert(sharedStyles.includes('transition: opacity 120ms ease;'), 'Shared Resource actions must own reveal behavior');
assert(sharedStyles.includes("[data-action-count='3']"), 'Shared Resource actions must support semantic action counts');

console.log('test-sidebar-resource-style-contract passed');
