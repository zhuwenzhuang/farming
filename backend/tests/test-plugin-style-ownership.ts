const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { readCodeStyleSource } = require('./style-source-reader');

const projectRoot = path.join(__dirname, '..', '..');
const read = (relativePath: string) => fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');

const componentSources = [
  read('src/components/code/PluginsPanel.tsx'),
  read('src/components/DesktopConnectionsPanel.tsx'),
  read('src/components/code/CodeMainArea.tsx'),
];
const mainStyles = readCodeStyleSource('src/styles/main.css');
const darkStyles = readCodeStyleSource('src/styles/code-dark.css');
const pluginStyles = readCodeStyleSource('src/styles/plugin.css');
const pluginDarkStyles = readCodeStyleSource('src/styles/plugin-dark.css');

const ownedClassNames = new Set<string>();
for (const source of componentSources) {
  for (const match of source.matchAll(/className=(?:"([^"]+)"|\{`([^`]+)`\})/g)) {
    for (const className of (match[1] || match[2] || '').match(/(?:code-(?:plugins|plugin)[a-z0-9-]*|desktop-(?:connection|connections)[a-z0-9-]*)/g) || []) {
      if (!className.endsWith('-')) ownedClassNames.add(className);
    }
  }
}
for (const className of ownedClassNames) {
  assert(
    pluginStyles.includes(`.${className}`) || pluginDarkStyles.includes(`.${className}`),
    `Plugin style owner is missing component class: ${className}`,
  );
}

for (const selector of [
  '.code-plugins-view',
  '.code-plugins-panel',
  '.code-plugin-tabs',
  '.code-plugin-card',
  '.code-plugin-agent-form',
  '.code-plugin-extension-list',
  '.code-plugin-detail-dialog',
  '.desktop-connections-panel',
  '.desktop-connections-form',
]) {
  assert(pluginStyles.includes(selector), `Missing Plugin base rule: ${selector}`);
}
for (const selector of [
  '.code-plugin-tabs',
  '.code-plugin-card',
  '.code-plugin-extension',
  '.code-plugin-detail-dialog',
  '.code-plugin-browser-settings input',
  '.code-plugin-toggle',
  '.code-plugin-error',
  '.desktop-connections-form',
  '.desktop-connection-copy',
]) {
  assert(pluginDarkStyles.includes(selector), `Missing Plugin dark rule: ${selector}`);
}

assert(pluginStyles.includes('@media (max-width: 720px)'), 'Plugin owner must retain its narrow-screen rules');
assert(!/\.code-(?:plugins(?:-|\b)|plugin-)/.test(mainStyles), 'main.css must not retain Plugin surface rules');
assert(!/\.code-(?:plugins(?:-|\b)|plugin-)/.test(darkStyles), 'code-dark.css must not retain Plugin surface rules');
assert(!mainStyles.includes('.desktop-connection'));
assert(!darkStyles.includes('.desktop-connection'));

// The navigation control belongs to the sidebar, not the Plugin content surface.
const sidebarStyles = readCodeStyleSource('src/styles/sidebar.css');
const sidebarDarkStyles = readCodeStyleSource('src/styles/sidebar-dark.css');
assert(sidebarStyles.includes('.code-sidebar-plugins-toggle'));
assert(sidebarDarkStyles.includes('.code-sidebar-plugins-toggle'));

console.log('test-plugin-style-ownership passed');
